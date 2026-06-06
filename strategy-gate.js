import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { backtest } from "./backtest.js";
import { getCoinConviction } from "./conviction-memory.js";
import { isKilled } from "./kill-switch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ATTRIBUTION_PATH = path.join(__dirname, "trade-attribution.json");

export const STRATEGY_GATE_LAYERS = Object.freeze({
  BACKTEST: 1,
  PAPER: 2,
  LIVE: 3,
});

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeWinRate(value) {
  const winRate = finiteNumber(value, 0);
  return winRate >= 1 ? winRate / 100 : winRate;
}

function isWinTrade(trade = {}) {
  if (typeof trade.isWin === "boolean") return trade.isWin;
  if (typeof trade.win === "boolean") return trade.win;
  const pnl = finiteNumber(trade.pnl_pct ?? trade.pnlPct ?? trade.pnl ?? trade.profitPct, 0);
  return pnl > 0;
}

function computeEvidenceFromTrades(trades = {}, { profitFactor = false } = {}) {
  const list = Array.isArray(trades) ? trades : [];
  const wins = list.filter(isWinTrade);
  const losses = list.filter(trade => !isWinTrade(trade));
  const grossWin = wins.reduce((sum, trade) => {
    return sum + Math.max(0, finiteNumber(trade.pnl_pct ?? trade.pnlPct ?? trade.pnl ?? trade.profitPct, 0));
  }, 0);
  const grossLoss = losses.reduce((sum, trade) => {
    return sum + Math.abs(Math.min(0, finiteNumber(trade.pnl_pct ?? trade.pnlPct ?? trade.pnl ?? trade.profitPct, 0)));
  }, 0);

  const evidence = {
    winRate: list.length > 0 ? wins.length / list.length : 0,
    trades: list.length,
    wins: wins.length,
    losses: losses.length,
  };
  if (profitFactor) {
    evidence.profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  }
  return evidence;
}

function normalizeEvidence(raw = {}, { requireProfitFactor = false } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  if (Array.isArray(source.trades)) {
    // P0-D: when a trades array is present, always compute metrics from it.
    // Never trust caller-supplied scalar winRate/profitFactor over computed values —
    // a trades array is the only verifiable evidence source.
    const computed = computeEvidenceFromTrades(source.trades, { profitFactor: requireProfitFactor });
    // P2-3: Infinity profit factor (lossless backtest) must not pass the gate.
    // Require at least one loss before profitFactor is meaningful.
    const pf = computed.profitFactor;
    const safePf = (!Number.isFinite(pf) || pf === Infinity) ? undefined : pf;
    return {
      ...computed,
      winRate: computed.winRate,         // always computed; never caller-supplied
      trades: source.trades.length,
      profitFactor: safePf,
    };
  }

  const tradeCount = source.tradeCount ?? source.total ?? source.count ?? source.signals;
  // P2-3: non-array path — treat undefined/Infinity profitFactor as failing.
  const rawPf = source.profitFactor == null ? undefined : finiteNumber(source.profitFactor);
  const safePf = rawPf == null || !Number.isFinite(rawPf) ? undefined : rawPf;
  return {
    ...source,
    winRate: normalizeWinRate(source.winRate ?? source.win_rate ?? source.successRate ?? source.success_rate),
    trades: Math.max(0, finiteNumber(source.trades ?? tradeCount, 0)),
    profitFactor: safePf,
  };
}

function candidateEvidence(candidate = {}, key) {
  return candidate?.evidence?.[key] ?? candidate?.[key] ?? null;
}

function filterTradesForStrategy(trades = [], strategyId, candidate = {}) {
  // Build the match set from precise identifiers (IDs) only, not names
  const ids = new Set([
    strategyId,
    candidate?.id,
    candidate?.strategyId,
    candidate?.strategy_id,
  ].filter(Boolean).map(String));

  return trades.filter(trade => {
    // Prefer exact ID match on the most specific fields
    const values = [
      trade.strategyId,
      trade.strategy_id,
      trade?.signal_snapshot?.strategyId,
      trade?.signal_snapshot?.strategy_id,
      trade?.signal_snapshot?.strategy?.id,
    ].filter(Boolean).map(String);
    return values.some(value => ids.has(value));
  });
}

function defaultBacktestRunner(candidate) {
  const provided = candidateEvidence(candidate, "backtest");
  if (provided) return normalizeEvidence(provided, { requireProfitFactor: true });

  const input = candidate?.backtestInput ?? candidate?.backtestData ?? null;
  if (input?.trades) {
    const result = backtest(input);
    return {
      ...result,
      trades: result.total,
      winRate: result.winRate,
      profitFactor: result.profitFactor,
    };
  }

  return { winRate: 0, trades: 0, profitFactor: 0 };
}

function defaultPaperTradeReader(candidate) {
  const provided = candidateEvidence(candidate, "paper");
  if (provided) return normalizeEvidence(provided);
  const trades = candidate?.paperTrades ?? candidate?.paperSignals ?? [];
  return computeEvidenceFromTrades(trades, { profitFactor: true });
}

function loadAttribution(pathname) {
  if (!pathname || !fs.existsSync(pathname)) return { trades: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { trades: [] };
  } catch {
    return { trades: [] };
  }
}

function defaultLiveTradeReader(strategyId, candidate, { attributionPath, convictionReader }) {
  const provided = candidateEvidence(candidate, "live");
  if (provided) return normalizeEvidence(provided);

  const directTrades = candidate?.liveTrades;
  const trades = Array.isArray(directTrades)
    ? directTrades
    : filterTradesForStrategy(loadAttribution(attributionPath).trades, strategyId, candidate);
  const evidence = computeEvidenceFromTrades(trades, { profitFactor: true });
  const mints = [...new Set(trades.map(trade => trade.mint || trade.tokenMint || trade?.token?.mint).filter(Boolean))];
  if (mints.length > 0) {
    evidence.conviction = mints.map(mint => convictionReader(mint)).filter(Boolean);
  }
  return evidence;
}

function passResult({ backtestEvidence, paperEvidence, liveEvidence }) {
  return {
    passed: true,
    layer: null,
    failedLayer: null,
    winRate: liveEvidence.winRate,
    trades: liveEvidence.trades,
    rejectReason: null,
    scores: {
      backtest: backtestEvidence.winRate,
      paper: paperEvidence.winRate,
      live: liveEvidence.winRate,
    },
    evidence: {
      backtest: clone(backtestEvidence),
      paper: clone(paperEvidence),
      live: clone(liveEvidence),
    },
  };
}

function failResult({ layer, reason, evidence, scores }) {
  const current = evidence?.live ?? evidence?.paper ?? evidence?.backtest ?? {};
  return {
    passed: false,
    layer,
    failedLayer: layer,
    winRate: current.winRate ?? null,
    trades: current.trades ?? 0,
    rejectReason: reason,
    scores,
    evidence: clone(evidence),
  };
}

export class StrategyGate {
  #cfg;
  #backtestRunner;
  #paperTradeReader;
  #liveTradeReader;
  #attributionPath;
  #convictionReader;

  constructor({
    minWinRate = 0.80,
    minBacktestTrades = 200,
    minPaperTrades = 75,
    minLiveTrades = 60,
    minLiveProfitFactor = 1.15,
    provisionalMinConviction = 0.80,
    provisionalMinFundamentalScore = 70,
    backtestRunner = defaultBacktestRunner,
    paperTradeReader = defaultPaperTradeReader,
    liveTradeReader = null,
    attributionPath = DEFAULT_ATTRIBUTION_PATH,
    convictionReader = getCoinConviction,
  } = {}) {
    this.#cfg = {
      minWinRate: normalizeWinRate(minWinRate),
      minBacktestTrades,
      minPaperTrades,
      minLiveTrades,
      minLiveProfitFactor,
      provisionalMinConviction,
      provisionalMinFundamentalScore,
    };
    this.#backtestRunner = backtestRunner;
    this.#paperTradeReader = paperTradeReader;
    this.#liveTradeReader = liveTradeReader;
    this.#attributionPath = attributionPath;
    this.#convictionReader = convictionReader;
  }

  async evaluate(strategyOrId, maybeCandidate = {}) {
    const candidate = typeof strategyOrId === "object" && strategyOrId !== null
      ? strategyOrId
      : { ...maybeCandidate, id: strategyOrId };
    const strategyId = candidate.id ?? candidate.strategyId ?? candidate.strategy_id;

    // P1-1: kill-switch check — this is the last gate before a BUY fires.
    if (isKilled()) {
      return failResult({ layer: "KILL_SWITCH", reason: "Kill-switch is active — trading halted." });
    }

    // P0-B: only accept provisional path when source comes from a trusted
    // internal producer (evolution engine or fundamental producer).
    // Candidate-supplied `_provisional:true` is attacker-controllable and
    // was bypassing all evidence gates — reject it as a trust signal.
    const TRUSTED_PROVISIONAL_SOURCES = new Set(["evolution", "fundamental"]);
    const isFundamentalCandidate = TRUSTED_PROVISIONAL_SOURCES.has(candidate.source);

    if (isFundamentalCandidate) {
      return this.#evaluateProvisional(candidate, strategyId);
    }

    return this.#evaluateStandard(candidate, strategyId);
  }

  async #evaluateProvisional(candidate, strategyId) {
    const fundamentalScores = candidate.fundamental_scores || candidate.evidence?.fundamental || {};
    const conviction = finiteNumber(
      fundamentalScores.conviction
      ?? fundamentalScores.coin_conviction
      ?? (candidate.fundamentalScores?.conviction || 0),
      0
    );
    const aggregate = finiteNumber(
      fundamentalScores.aggregate
      ?? fundamentalScores.fundamental_score
      ?? (candidate.fundamentalScores?.score || 0),
      0
    );

    if (conviction < this.#cfg.provisionalMinConviction) {
      return failResult({
        layer: "PROVISIONAL",
        reason: `provisional conviction ${conviction.toFixed(2)} < ${this.#cfg.provisionalMinConviction}`,
        evidence: { fundamental: { conviction, aggregate } },
        scores: { provisional: conviction },
      });
    }
    if (aggregate < this.#cfg.provisionalMinFundamentalScore) {
      return failResult({
        layer: "PROVISIONAL",
        reason: `provisional fundamental score ${aggregate} < ${this.#cfg.provisionalMinFundamentalScore}`,
        evidence: { fundamental: { conviction, aggregate } },
        scores: { provisional: aggregate },
      });
    }

    return {
      passed: true,
      layer: "PROVISIONAL",
      failedLayer: null,
      winRate: null,
      trades: 0,
      rejectReason: null,
      provisional: true,
      scores: { provisional: aggregate, conviction },
      evidence: { fundamental: { conviction, aggregate } },
    };
  }

  async #evaluateStandard(candidate, strategyId) {
    let backtestEvidence;
    try {
      backtestEvidence = normalizeEvidence(
        await this.#backtestRunner(candidate, { strategyId }),
        { requireProfitFactor: true }
      );
    } catch (e) {
      return failResult({
        layer: STRATEGY_GATE_LAYERS.BACKTEST,
        reason: `backtest runner threw: ${e?.message || e}`,
        evidence: {},
        scores: {},
      });
    }
    const backtestFailure = this.#backtestFailure(backtestEvidence);
    if (backtestFailure) {
      return failResult({
        layer: STRATEGY_GATE_LAYERS.BACKTEST,
        reason: backtestFailure,
        evidence: { backtest: backtestEvidence },
        scores: { backtest: backtestEvidence.winRate },
      });
    }

    let paperEvidence;
    try {
      paperEvidence = normalizeEvidence(await this.#paperTradeReader(candidate, { strategyId }));
    } catch (e) {
      return failResult({
        layer: STRATEGY_GATE_LAYERS.PAPER,
        reason: `paper reader threw: ${e?.message || e}`,
        evidence: { backtest: backtestEvidence },
        scores: { backtest: backtestEvidence.winRate },
      });
    }
    const paperFailure = this.#paperFailure(paperEvidence);
    if (paperFailure) {
      return failResult({
        layer: STRATEGY_GATE_LAYERS.PAPER,
        reason: paperFailure,
        evidence: { backtest: backtestEvidence, paper: paperEvidence },
        scores: { backtest: backtestEvidence.winRate, paper: paperEvidence.winRate },
      });
    }

    const liveEvidence = normalizeEvidence(
      this.#liveTradeReader
        ? await this.#liveTradeReader(candidate, { strategyId })
        : await defaultLiveTradeReader(strategyId, candidate, {
            attributionPath: this.#attributionPath,
            convictionReader: this.#convictionReader,
          }),
      { requireProfitFactor: true }
    );
    const liveFailure = this.#liveFailure(liveEvidence);
    if (liveFailure) {
      return failResult({
        layer: STRATEGY_GATE_LAYERS.LIVE,
        reason: liveFailure,
        evidence: { backtest: backtestEvidence, paper: paperEvidence, live: liveEvidence },
        scores: {
          backtest: backtestEvidence.winRate,
          paper: paperEvidence.winRate,
          live: liveEvidence.winRate,
        },
      });
    }

    return passResult({ backtestEvidence, paperEvidence, liveEvidence });
  }

  #backtestFailure(evidence) {
    if (evidence.trades < this.#cfg.minBacktestTrades) {
      return `backtest trades ${evidence.trades} < ${this.#cfg.minBacktestTrades}`;
    }
    if (evidence.winRate < this.#cfg.minWinRate) {
      return `backtest win rate ${evidence.winRate} < ${this.#cfg.minWinRate}`;
    }
    // P2-3: Infinity (lossless backtest) and undefined both fail the check —
    // require a finite, computed profit factor over at least one loss.
    if (!Number.isFinite(evidence.profitFactor) || !(evidence.profitFactor > 1.0)) {
      return `backtest profit factor ${evidence.profitFactor ?? "missing"} must be finite and > 1`;
    }
    return null;
  }

  #paperFailure(evidence) {
    if (evidence.trades < this.#cfg.minPaperTrades) {
      return `paper trades ${evidence.trades} < ${this.#cfg.minPaperTrades}`;
    }
    if (evidence.winRate < this.#cfg.minWinRate) {
      return `paper win rate ${evidence.winRate} < ${this.#cfg.minWinRate}`;
    }
    return null;
  }

  #liveFailure(evidence) {
    if (evidence.trades < this.#cfg.minLiveTrades) {
      return `live trades ${evidence.trades} < ${this.#cfg.minLiveTrades}`;
    }
    if (evidence.winRate < this.#cfg.minWinRate) {
      return `live win rate ${evidence.winRate} < ${this.#cfg.minWinRate}`;
    }
    // Profit factor check: even if win rate is high, live trades must show
    // meaningful profit per loss. Prevents strategies that win tiny amounts
    // but lose big from passing the gate.
    const pf = evidence.profitFactor;
    if (pf == null || Number.isNaN(pf) || pf < this.#cfg.minLiveProfitFactor) {
      return `live profit factor ${pf != null ? pf.toFixed(2) : "missing"} < ${this.#cfg.minLiveProfitFactor}`;
    }
    return null;
  }
}
