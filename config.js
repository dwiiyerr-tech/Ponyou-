import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { applyExecutionMode } from "./runtime-mode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

let u = {};
if (fs.existsSync(USER_CONFIG_PATH)) {
  try {
    u = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch (err) {
    console.error(`⚠️  Invalid user-config.json: ${err.message}`);
    u = {};
  }
}

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.shyftApiKey) process.env.SHYFT_API_KEY    ||= u.shyftApiKey;
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
applyExecutionMode({ userConfig: u });

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const number = finiteNumber(value, fallback);
  return Math.min(max, Math.max(min, number));
}

export function buildVaultConfig(u = {}, env = process.env) {
  const vault = u.vault || {};
  const sweep = vault.sweep || {};
  const walletAddress = nonEmptyString(
    sweep.vaultWallet,
    vault.vaultWallet,
    vault.walletAddress,
    u.vaultWallet,
    env.VAULT_WALLET,
  );
  const sweepPct = boundedNumber(
    sweep.sweepPct ?? sweep.pct ?? vault.sweepPct ?? vault.pct ?? u.vaultSweepPct ?? u.sweepPct ?? u.vaultPct,
    35,
    0,
    100,
  );
  const sweepIntervalDays = Math.max(1, finiteNumber(
    sweep.sweepIntervalDays ?? sweep.intervalDays ?? vault.sweepIntervalDays ?? vault.intervalDays ?? u.vaultSweepIntervalDays ?? u.sweepIntervalDays ?? u.vaultIntervalDays,
    7,
  ));
  const minSweepSol = Math.max(0, finiteNumber(
    sweep.minSweepSol ?? vault.minSweepSol ?? u.vaultMinSweepSol ?? u.minSweepSol,
    0.001,
  ));
  const enabled = Boolean(sweep.enabled ?? vault.enabled ?? u.vaultSweepEnabled ?? u.vaultEnabled ?? true);

  return {
    enabled,
    walletAddress,
    pct: sweepPct,
    intervalDays: sweepIntervalDays,
    minSweepSol,
    sweep: {
      enabled,
      sweepPct,
      sweepIntervalDays,
      minSweepSol,
      vaultWallet: walletAddress,
    },
  };
}

export function buildRugMonitorConfig(u = {}) {
  const rm = u.rugMonitor || {};
  const t = (block, defaults) => ({
    low:    block?.low    ?? defaults.low,
    medium: block?.medium ?? defaults.medium,
    high:   block?.high   ?? defaults.high,
  });
  return {
    enabled: rm.enabled ?? true,
    pollingIntervalSec: Number.isFinite(rm.pollingIntervalSec) ? rm.pollingIntervalSec : 30,
    rateLimitLowSec:    Number.isFinite(rm.rateLimitLowSec)    ? rm.rateLimitLowSec    : 60,
    devSellThresholds:    t(rm.devSellThresholds,    { low: -5,  medium: -20, high: -50 }),
    lpMovementThresholds: t(rm.lpMovementThresholds, { low: -20, medium: -50, high: null }),
    holderDumpThresholds: t(rm.holderDumpThresholds, { low: -10, medium: -25, high: -50 }),
    actions: {
      low:    rm.actions?.low    ?? { type: "tighten_trail", params: { trailingDeltaPct: -2 } },
      medium: rm.actions?.medium ?? { type: "sell_partial",  params: { fraction: 0.5 } },
      high:   rm.actions?.high   ?? { type: "sell_all" },
    },
  };
}

export function buildExecutionEdgeConfig(u = {}) {
  const ee = u.executionEdge || {};
  return {
    enabled: ee.enabled ?? true,
    rpcEndpoints: Array.isArray(ee.rpcEndpoints) && ee.rpcEndpoints.length > 0
      ? ee.rpcEndpoints
      : [
          { url: "https://api.mainnet-beta.solana.com", label: "solana-public" },
          { url: "https://solana-api.projectserum.com", label: "serum" },
        ],
    feeOracle: {
      sampleIntervalMs: Number.isFinite(ee.feeOracle?.sampleIntervalMs) ? ee.feeOracle.sampleIntervalMs : 10000,
      cacheStaleMs: Number.isFinite(ee.feeOracle?.cacheStaleMs) ? ee.feeOracle.cacheStaleMs : 15000,
      maxTipLamports: Number.isFinite(ee.feeOracle?.maxTipLamports) ? ee.feeOracle.maxTipLamports : 5_000_000,
      maxPriorityFeeMicroLamports: Number.isFinite(ee.feeOracle?.maxPriorityFeeMicroLamports) ? ee.feeOracle.maxPriorityFeeMicroLamports : 10_000_000,
      baseTipLamports: Number.isFinite(ee.feeOracle?.baseTipLamports) ? ee.feeOracle.baseTipLamports : 100_000,
    },
    executor: {
      maxAttempts: Number.isFinite(ee.executor?.maxAttempts) ? ee.executor.maxAttempts : 5,
      attemptTimeoutMs: Number.isFinite(ee.executor?.attemptTimeoutMs) ? ee.executor.attemptTimeoutMs : 3000,
      defaultCuLimit: Number.isFinite(ee.executor?.defaultCuLimit) ? ee.executor.defaultCuLimit : 200_000,
      maxCuLimit: Number.isFinite(ee.executor?.maxCuLimit) ? ee.executor.maxCuLimit : 1_400_000,
      rpcCallTimeoutMs: Number.isFinite(ee.executor?.rpcCallTimeoutMs) ? ee.executor.rpcCallTimeoutMs : 2000,
    },
  };
}

export const config = {
  // ─── Compound Trading Plan (Pilot) ────────
  pilot: {
    enabled:                 u.pilotEnabled              ?? true,
    initialCapitalUsd:       u.pilotCapitalUsd           ?? 10,
    dailyTargetPct:          u.dailyTargetPct            ?? 25,
    dailyStopLossPct:        u.dailyStopLossPct          ?? -10,
    sessionPauseDurationMin: u.sessionPauseDurationMin   ?? 60,
    learningModeDurationMin: u.learningModeDurationMin   ?? 60,
    planDays:                u.planDays                  ?? 30,
    autoAdaptToMarket:       u.autoAdaptToMarket         ?? true,
    // Circuit breaker: setelah N loss berturut, trigger learning mode (anti-tilt).
    // 0 = disabled.
    maxConsecutiveLosses:    u.maxConsecutiveLosses      ?? 3,
  },

  // ─── Market Cap Tiers ──────────────────────
  tiers: {
    NEW_PAIR:  { max_mcap: 100000,    label: "Pure Chaos",   strategy: "Ultra-Fast Scalp" },
    MICRO_CAP: { max_mcap: 5000000,   label: "Community",    strategy: "Stuctured Scalp" },
    MID_CAP:   { max_mcap: 50000000,  label: "Serious",      strategy: "Precision Entry" },
    HIGH_CAP:  { max_mcap: 200000000, label: "Hype Peak",    strategy: "Fomo Warning / Exit" },
    CEX_LEVEL: { max_mcap: Infinity,  label: "Institution", strategy: "Institutional" },
  },

  // ─── Vault / Tabungan ──────────────────────
  vault: buildVaultConfig(u),

  // ─── Daily Report ──────────────────────────
  report: {
    enabled:    u.dailyReportEnabled ?? true,
    hourUtc:    u.dailyReportHourUtc ?? 0,   // jam UTC untuk trigger (0 = midnight UTC)
    minuteUtc:  u.dailyReportMinuteUtc ?? 5,
  },

  automation: {
    enabled: u.automationEnabled ?? true,
  },

  // ─── Daily Trade Guard ──────────────────────
  // Optional Telegram decision gate. When enabled, closed trade outcomes are
  // counted per UTC day; hitting either win/loss limit blocks new entries until
  // /continue or /stoptrade is received.
  dailyTradeGuard: {
    enabled: u.dailyTradeGuard?.enabled ?? u.dailyTradeGuardEnabled ?? false,
    maxWinsPerDay: u.dailyTradeGuard?.maxWinsPerDay ?? u.dailyTradeGuardMaxWins ?? 3,
    maxLossesPerDay: u.dailyTradeGuard?.maxLossesPerDay ?? u.dailyTradeGuardMaxLosses ?? 3,
    learningModeDurationMin: u.dailyTradeGuard?.learningModeDurationMin ?? u.learningModeDurationMin ?? 60,
  },

  // ─── Trading Plan ─────────────────────────
  tradingPlan: {
    enabled:           u.tradingPlan?.enabled           ?? u.tradingPlanEnabled           ?? false,
    targetTrades:      u.tradingPlan?.targetTrades       ?? u.tradingPlanTarget            ?? 30,
    resetOnNewSession: u.tradingPlan?.resetOnNewSession  ?? u.tradingPlanResetOnNewSession ?? false,
  },

  // ─── Exit Slippage ───────────────────────
  exitSlippage: {
    steps:       u.exitSlippage?.steps       ?? [1, 5, 10, 20],
    maxAttempts: u.exitSlippage?.maxAttempts ?? 4,
  },

  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 2,
    maxDeployAmount: u.maxDeployAmount ?? 35,
  },

  kelly: {
    enabled:         u.kellyEnabled ?? true,
    fraction:        u.kellyFraction ?? 0.5,
    minFraction:     u.kellyMinFraction ?? 0.1,
    maxFraction:     u.kellyMaxFraction ?? 0.8,
    minSampleTrades: u.kellyMinSampleTrades ?? 15,
  },

  capitalSizing: {
    microThreshold:          u.capitalSizingMicroThreshold  ?? 50,
    fullThreshold:           u.capitalSizingFullThreshold   ?? 200,
    microFlat: {
      HOT:  u.capitalSizingMicroHot      ?? 0.15,
      WARM: u.capitalSizingMicroWarm     ?? 0.08,
    },
    growthCap:               u.capitalSizingGrowthCap        ?? 0.20,
    growthFallbackFraction:  u.capitalSizingGrowthFallback   ?? 0.10,
  },

  decisionWorkflow: {
    enabled: u.decisionWorkflowEnabled ?? true,
    probeSizeFraction: u.probeSizeFraction ?? 0.25,
    minConvictionScore: u.minConvictionScore ?? 45,
    minConvictionConfidence: u.minConvictionConfidence ?? 25,
    activeConvictionScore: u.activeConvictionScore ?? 65,
    activeConvictionConfidence: u.activeConvictionConfidence ?? 50,
  },

  regimeMemory: {
    enabled: u.regimeMemoryEnabled ?? true,
    tailwindMultiplierCap: u.regimeTailwindMultiplierCap ?? 1.15,
    headwindMultiplierFloor: u.regimeHeadwindMultiplierFloor ?? 0.4,
  },

  // ─── Trading Mode ────────────────────────
  // confirmMode: when true, every BUY (SOL → token) is parked as a
  // pending intent and requires Telegram /yes <id> approval.
  // Set via user-config.json { "confirmMode": true } or env CONFIRM_MODE=true.
  trading: {
    confirmMode:      u.confirmMode      ?? (process.env.CONFIRM_MODE === "true"),
    confirmTtlMin:    u.confirmTtlMin    ?? 5,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    timeframe:         nonEmptyString(u.timeframe) ?? "5m",
    category:          nonEmptyString(u.category)  ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals:    u.useDiscordSignals    ?? false,
    discordSignalMode:    u.discordSignalMode    ?? "merge",  // merge | only
    useTelegramCalls:     u.useTelegramCalls     ?? false,    // parse incoming TG messages as calls
    useSocialHunter:      u.useSocialHunter      ?? true,     // Reddit + CoinGecko + Dex + Nitter scan
    socialHunterInterval: u.socialHunterInterval ?? 30,       // minutes between scans
    socialBuzzWeight:     u.socialBuzzWeight     ?? 0.08,     // weight in signal-aggregator (0–0.20)
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
  },


  // --- Pipeline Test Mode (DEMO only) ---
  // Forces tokens through the full pipeline for testing. Safe: sell simulator is final gate.
  pipelineTestMode:     u.pipelineTestMode       ?? false,
  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    // Hybrid override: null = pakai strategy.js default; angka = override eksplisit.
    // Lihat strategy.getEffectiveStopLoss / getEffectiveImmediateTakeProfit.
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? null,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? null,
    autoTakeProfitPct:     u.autoTakeProfitPct     ?? 50,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.25,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 5,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 6,    // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    antiGreedCooldownHours: u.antiGreedCooldownHours ?? u.repeatDeployCooldownHours ?? 12,
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:        u.maxTokens        ?? 4096,
    maxSteps:         u.maxSteps         ?? 10,
    managerMaxSteps:  u.managerMaxSteps  ?? 5,
    screenerMaxSteps: u.screenerMaxSteps ?? 4,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "minimax/minimax-m2.5",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "minimax/minimax-m2.5",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "minimax/minimax-m2.5",
    // Per-role timeouts. MANAGER needs fast decisions; SCREENER can afford
    // more time for deep analysis; GENERAL handles interactive chat.
    // Set any to 0 to fall back to timeoutMs.
    timeoutMs:          finiteNumber(u.llmTimeoutMs,          120_000),
    managerTimeoutMs:   finiteNumber(u.llmManagerTimeoutMs,    60_000),
    screenerTimeoutMs:  finiteNumber(u.llmScreenerTimeoutMs,   90_000),
    generalTimeoutMs:   finiteNumber(u.llmGeneralTimeoutMs,   120_000),
    // Prompt caching — adds cache_control to stable system-prompt blocks when
    // using a Claude model (via OpenRouter or direct). Reduces token cost by
    // 60-90% per subsequent agentLoop call on the same role. Safe to leave
    // enabled; non-Claude providers simply ignore the extra field.
    promptCaching:      u.llmPromptCaching !== false,
  },

  // ─── Jito BlockEngine (priority lane) ─────────────────────────
  // When enabled, swap path can route through Jito for priority inclusion
  // and basic sandwich resistance. Scaffold only — opt in per call site.
  // See tools/jito.js for setup notes.
  jito: {
    enabled:     u.jitoEnabled     ?? false,
    region:      u.jitoRegion      ?? "fra",     // fra | ny | ams | tyo
    tipLamports: u.jitoTipLamports ?? 100_000,   // 0.0001 SOL default
    authToken:   process.env.JITO_AUTH_TOKEN ?? null, // optional paid tier
  },

  // ─── Fast-Track Entry (skip LLM for unambiguous BUYs) ─────────
  // When enabled, screening cycle deploys candidates that pass strict
  // deterministic gates immediately, cutting entry latency from ~5-30s
  // (LLM) to ~500ms (network only). Remaining candidates still go through
  // the LLM. See fast-buy.js for the gate logic.
  fastTrack: {
    enabled:           u.fastTrackEnabled        ?? false,
    maxRugScore:       u.fastTrackMaxRugScore    ?? 10,
    minMcap:           u.fastTrackMinMcap        ?? 150_000,
    maxMcap:           u.fastTrackMaxMcap        ?? 5_000_000,
    minVolumeUsd:      u.fastTrackMinVolume      ?? 50_000,
    minSmartInflowUsd: u.fastTrackMinSmartInflow ?? 0,    // 0 = check disabled
    maxAgeMinutes:     u.fastTrackMaxAgeMinutes  ?? null, // null = no max
    maxFlags:          u.fastTrackMaxFlags       ?? 0,
    maxNewPerCycle:    u.fastTrackMaxNewPerCycle ?? 1,
  },

  // ─── Multi-Wallet (Capital Splitting + Hot/Cold Rotation) ────
  multiWallet: {
    enabled:            u.multiWalletEnabled      ?? false,
    rotationMaxErrors:  u.multiWalletMaxErrors     ?? 3,
    rotationCooldownMs: (u.multiWalletCooldownMin  ?? 10) * 60_000,
    autoSpreadEnabled:  u.multiWalletAutoSpreadEnabled ?? true,
    autoSpreadMinTotalSol: u.multiWalletAutoSpreadMinTotalSol ?? 3,
    minWalletDeploySol: u.multiWalletMinWalletDeploySol ?? 0.25,
    maxWalletsPerBatch: u.multiWalletMaxWalletsPerBatch ?? 2,
    // Array of { key: "bs58...", label: "Wallet A", capital_pct: 60 }
    // capital_pct harus total 100. Jika kosong → single-wallet fallback.
    wallets: Array.isArray(u.wallets) ? u.wallets : [],
  },

  // ─── Cast-Net (Tebar Jala) — High-conviction multi-wallet entry ─
  // Fires only when ALL 7 fundamental green-flags pass: community, dev,
  // smart-money, top-holders, narrative, ticker, conviction. Strict AND
  // gate — any single red blocks the cast-net. Default OFF.
  castNet: {
    enabled:           u.castNetEnabled            ?? false,
    // Hard upper bound on wallets used per fire (clamped in code even if
    // config sets higher). 10 is the chosen ceiling — wider footprint hits
    // funding-ancestor heuristics faster than it helps anti-detection.
    maxWallets:        Math.min(10, Math.max(2, Number(u.castNetMaxWallets ?? 10))),
    // % of bankroll deployed per cast-net fire. 30% leaves headroom for
    // normal trades + risk-of-bust if the gate ever produces a false-positive.
    maxBankrollPct:    Math.min(50, Math.max(5, Number(u.castNetMaxBankrollPct ?? 30))),
    // Conviction floor — only fire if conviction-memory says past pattern
    // similar enough to warrant high-confidence entry.
    minConviction:     Math.min(0.99, Math.max(0.5, Number(u.castNetMinConviction ?? 0.85))),
    // Cooldown after each fire so a bad cluster of green-flag signals
    // can't drain bankroll in one session.
    cooldownMin:       Math.max(30, Number(u.castNetCooldownMin ?? 240)),
    // Timing jitter range — random delay per wallet to break same-block
    // fingerprint. Min/max in seconds.
    timingJitterMinSec: Math.max(0, Number(u.castNetTimingJitterMinSec ?? 2)),
    timingJitterMaxSec: Math.max(2, Number(u.castNetTimingJitterMaxSec ?? 15)),
    // Amount jitter — ±N% random per wallet so amounts don't look templated.
    amountJitterPct:   Math.min(50, Math.max(0, Number(u.castNetAmountJitterPct ?? 20))),
    // Strategies allowed to trigger cast-net. Excludes scalping/degen by
    // design — those signal types are too noisy for high-conviction entries.
    allowedStrategies: Array.isArray(u.castNetAllowedStrategies)
      ? u.castNetAllowedStrategies
      : ["smart_money", "day_phase_trading"],
    // Minimum semantic-memory sample size before cast-net is allowed at all.
    // Prevents firing on undertrained conviction signals.
    minMemorySamples:  Math.max(0, Number(u.castNetMinMemorySamples ?? 50)),

    // C1: auto-disable after N consecutive losing fires. Set to 0 to disable
    // this safety. Default 2 — two losses in a row is a strong signal the
    // gate is producing false positives in current regime.
    autoDisableConsecutiveLosses: Math.max(0, Number(u.castNetAutoDisableConsecutiveLosses ?? 2)),

    // C2: soft-check thresholds (in addition to the 7 hard categories).
    // Each is hard-blocking too — strict AND continues. These are tunable
    // because liquidity/mcap norms shift per cycle.
    minLiquidityUsd:    Math.max(0, Number(u.castNetMinLiquidityUsd ?? 50_000)),
    mcapWindowMinUsd:   Math.max(0, Number(u.castNetMcapWindowMinUsd ?? 1_000_000)),
    mcapWindowMaxUsd:   Math.max(0, Number(u.castNetMcapWindowMaxUsd ?? 10_000_000)),
    // Ratio of 24h volume to liquidity. Default 1.0 — if 24h volume is less
    // than liquidity, the pool isn't churning organically and is more likely
    // to be wash-traded or stale.
    minVolumeToLiquidity: Math.max(0, Number(u.castNetMinVolumeToLiquidity ?? 1.0)),
    // Top-1 holder concentration ceiling. Default 5% — single holder above
    // this is a concentrated-risk red flag even if top10 looks healthy.
    maxTop1HolderPct:   Math.max(0, Number(u.castNetMaxTop1HolderPct ?? 5)),

    // C4: how close to threshold counts as "edge". A category passing within
    // edgeMargin of its floor triggers a Telegram warning so the operator
    // knows the fire was a marginal call. Tunable per-category implicitly
    // via the floors themselves; this is the global tolerance.
    edgeMarginPct:      Math.max(0, Math.min(0.5, Number(u.castNetEdgeMarginPct ?? 0.05))),
  },

  // ─── LLM Provider Configuration ─────────────────
  llmProvider: u.llmProvider ?? process.env.LLM_PROVIDER ?? "openrouter",
  llmModel: u.llmModel ?? process.env.LLM_MODEL ?? "openrouter/auto",
  llmBaseUrl: u.llmBaseUrl ?? process.env.LLM_BASE_URL ?? null,
  // User-defined provider entries. Each is OpenAI-compatible: {id, name, baseUrl,
  // apiKeyEnv | apiKey, defaultModel, headers?, features?}. When llmProvider
  // matches a custom id, llm-provider.js resolves from here before built-ins.
  customProviders: Array.isArray(u.customProviders) ? u.customProviders : [],

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },
  // ─── Strategy Evolution ────────────────
  strategy: {
    evolution: {
      enabled:                    u.strategyEvolutionEnabled    ?? true,
      minWinRateGate:             u.strategyMinWinRate          ?? 0.80,
      minBacktestTrades:          u.strategyMinBacktestTrades   ?? 100,
      minPaperTrades:             u.strategyMinPaperTrades      ?? 30,
      minLiveTrades:              u.strategyMinLiveTrades       ?? 20,
      paperTradeTimeoutDays:      u.strategyPaperTimeoutDays    ?? 7,
      proposalTimeoutHours:       u.strategyProposalTimeout     ?? 24,
      autoApproveConvictionMin:   u.strategyAutoApprove         ?? 0.95,
      degradationThreshold:       u.strategyDegradation         ?? 0.75,
      maxCandidateQueue:          u.strategyMaxQueue            ?? 5,
      kellyMode3: {
        requiresApproval:         true,
        minLiveTrades:            u.kellyMode3MinTrades         ?? 50,
        minWinRate:               u.kellyMode3MinWinRate        ?? 1.00,
        minConviction:            u.kellyMode3MinConviction     ?? 0.99,
        minSemanticMemoryEntries: u.kellyMode3MinMemory         ?? 200,
      },
    },
    // Fundamental-signal producer: bridges memory layer → composer → bus.
    // Opt-in (default off). Two flags so even when evolution is on, producer
    // stays silent until explicitly enabled. dryRun=true logs candidates
    // instead of enqueueing them.
    fundamentalProducer: {
      enabled:                u.fundamentalProducerEnabled  ?? true,
      dryRun:                 u.fundamentalProducerDryRun   ?? true,  // safe: logs only, no enqueue
      intervalMin:            u.fundamentalProducerInterval ?? 30,    // cron-style scan window
      minDataAgeDays:         u.fundamentalMinDataAgeDays   ?? 30,    // maturity gate: agent must have ≥N days of data
      minConviction:          u.fundamentalMinConviction    ?? 68,    // coin/narrative score 0-100
      minConfidence:          u.fundamentalMinConfidence    ?? 40,    // observation maturity
      minSmartWalletStability:u.fundamentalMinSwStability   ?? 55,    // 0-100
      minHolderQualityScore:  u.fundamentalMinHolderQuality ?? 40,    // inverse hidden-control
      minRegimeScore:         u.fundamentalMinRegimeScore   ?? 50,    // 0-100
      maxPerHour:             u.fundamentalMaxPerHour       ?? 3,     // throttle
      dedupWindowMin:         u.fundamentalDedupWindowMin   ?? 30,    // skip identical fingerprint
      llmCooldownHours:       u.fundamentalLlmCooldownHrs   ?? 24,    // composer.generate() rate cap
      llmFallbackMinActive:   u.fundamentalLlmMinActive     ?? 2,     // generate() only if registry <N
    },
    // Runtime selector — once evolved strategies exist in the registry,
    // this lets the agent PICK from them at trade time instead of always
    // using the static PRESET. mode="shadow" only logs the diff; flip to
    // "live" to actually apply. minLiveScoreForOverride is the WR floor
    // (default 0.85 = 85%) BEFORE evolved rules can take over a regime.
    runtimeSelector: {
      enabled:                  u.strategySelectorEnabled       ?? true,
      mode:                     u.strategySelectorMode          ?? "live", // evolved strategies applied to trading
      minLiveScoreForOverride:  u.strategySelectorMinLiveScore  ?? 0.85,
      minLiveTradesForOverride: u.strategySelectorMinLiveTrades ?? 20,
      cacheTtlMs:               u.strategySelectorCacheTtlMs    ?? 60_000,
    },
  },

  // ─── Common Token Mints ────────────────
tokens: {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
},

jupiter: {

    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: nonEmptyString(indicatorUserConfig.entryPreset) ?? "supertrend_break",
    exitPreset:  nonEmptyString(indicatorUserConfig.exitPreset)  ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
    volatilityAdjustmentEnabled: indicatorUserConfig.volatilityAdjustmentEnabled ?? true,
  },

  rugMonitor: buildRugMonitorConfig(u),
  executionEdge: buildExecutionEdgeConfig(u),

  // ─── Holder Analysis (ABC Improvements) ─────────────────────
  // A) Dump Monitor: track top holder balance changes in real-time
  // B) Entry Price Analysis: detect underwater holders = sell pressure
  // C) Rug Pattern Detector: identify coordinated multi-wallet rugs
  //
  // ABC improvements enabled by default, starting with low beta rollout %
  // to monitor false positives before expanding (5% → 25% → 100%).
  // Override via user-config.json: { holderAnalysis: { dumpMonitor: { enabled: false } } }
  holderAnalysis: {
    // A) Holder Dump Monitor — detect large holder exits (>20% in 1h)
    dumpMonitor: {
      enabled: u.holderAnalysis?.dumpMonitor?.enabled ??
               u.holderDumpMonitorEnabled ?? true,
      betaRolloutPct: Math.max(0, Math.min(100,
        Number(u.holderAnalysis?.dumpMonitor?.betaRolloutPct ??
               u.holderDumpMonitorBetaPct ?? 5)
      )),
      riskThreshold: u.holderAnalysis?.dumpMonitor?.riskThreshold ?? "HIGH",
    },

    // B) Entry Price Analysis — detect underwater holders (>80% at loss = high sell pressure)
    entryPriceAnalysis: {
      enabled: u.holderAnalysis?.entryPriceAnalysis?.enabled ??
               u.holderEntryPriceEnabled ?? true,
      betaRolloutPct: Math.max(0, Math.min(100,
        Number(u.holderAnalysis?.entryPriceAnalysis?.betaRolloutPct ??
               u.holderEntryPriceBetaPct ?? 10)
      )),
      underwaterThreshold: Math.max(0, Math.min(100,
        Number(u.holderAnalysis?.entryPriceAnalysis?.underwaterThreshold ?? 80)
      )),
      // Price-history fallback (no tx data) is a low-confidence ESTIMATE. It
      // never solo-triggers an exit; it's admitted as a corroborating signal
      // above this (stricter) underwater threshold, and when it agrees with an
      // independent high-trust signal it adds `corroborationBonus` to the
      // combined confidence so corroborated risk can cross the exit gate.
      fallbackUnderwaterThreshold: Math.max(0, Math.min(100,
        Number(u.holderAnalysis?.entryPriceAnalysis?.fallbackUnderwaterThreshold ?? 85)
      )),
      corroborationBonus: Math.max(0, Math.min(50,
        Number(u.holderAnalysis?.entryPriceAnalysis?.corroborationBonus ?? 15)
      )),
    },

    // C) Rug Pattern Detector — identify coordinated rug patterns (flash dump, ladder, etc)
    rugPatternDetector: {
      enabled: u.holderAnalysis?.rugPatternDetector?.enabled ??
               u.holderRugPatternDetectorEnabled ?? true,
      betaRolloutPct: Math.max(0, Math.min(100,
        Number(u.holderAnalysis?.rugPatternDetector?.betaRolloutPct ??
               u.holderRugPatternBetaPct ?? 3)
      )),
      confidenceThreshold: Math.max(0, Math.min(100,
        Number(u.holderAnalysis?.rugPatternDetector?.confidenceThreshold ?? 70)
      )),
    },
  },
};

// Warn loud jika override SL/TP terlihat berbahaya (mis. -50 yang dulu unused).
(() => {
  const sl = config.management.stopLossPct;
  const tp = config.management.takeProfitPct;
  if (sl != null && sl < -30) {
    console.warn(`⚠️  config: stopLossPct override = ${sl}% (sangat permisif). Set ke null di user-config.json untuk pakai strategy default (-15%).`);
  }
  if (tp != null && tp > 0 && tp < 5) {
    console.warn(`⚠️  config: takeProfitPct override = ${tp}% (sangat konservatif untuk scalping memecoin). Set ke null untuk pakai ROI table adaptif.`);
  }
})();

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Pilot mode:
 *   Jika config.pilot.enabled dan solPriceUsd disediakan, deploy dibatasi oleh
 *   pilotCapitalUsd / maxPositions agar bot tidak melampaui modal pilot.
 *
 * @param {number} walletSol - Saldo SOL aktual
 * @param {object} [opts]
 * @param {number} [opts.solPriceUsd] - Harga SOL untuk pilot capping
 */
export function computeDeployAmount(walletSol, opts = {}) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct != null ? config.management.positionSizePct : 0.35;
  let   floor    = config.management.deployAmountSol;
  let   ceil     = config.risk.maxDeployAmount;

  // Pilot cap: deploy per trade tidak boleh > pilotCapitalUsd / maxPositions
  if (config.pilot.enabled && opts.solPriceUsd && opts.solPriceUsd > 0) {
    const slots = Math.max(1, config.risk.maxPositions ?? 3);
    const perTradeUsd = config.pilot.initialCapitalUsd / slots;
    const pilotCapSol = perTradeUsd / opts.solPriceUsd;
    ceil  = Math.min(ceil, pilotCapSol);
    floor = Math.min(floor, pilotCapSol); // floor tidak boleh melampaui cap
  }

  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  // Lebih banyak presisi: deploy pilot bisa kecil (mis. 0.017 SOL)
  return parseFloat(result.toFixed(4));
}

/**
 * Compute volatility-adjusted position size.
 * Reduces position size for high-volatility tokens to manage risk.
 *
 * Formula: size = base × (1 - 0.5 × volatility_percentile / 100)
 *
 * Examples:
 *   Volatility 0% (stable): factor=1.0, size=0.5 SOL (full)
 *   Volatility 50% (medium): factor=0.75, size=0.375 SOL
 *   Volatility 100% (extreme): factor=0.5, size=0.25 SOL (half)
 */
export function computeVolatilityAdjustedSize(baseSize, volatilityPercentile = 0) {
  // If volatility adjustment is disabled, always return base — regardless of
  // whatever percentile the caller happens to pass in.
  if (!config.indicators?.volatilityAdjustmentEnabled) return baseSize;

  // Guard: jika percentile invalid (mis. dari klines rusak), pakai 50 (medium).
  if (!Number.isFinite(volatilityPercentile)) volatilityPercentile = 50;

  // Volatility factor: high vol = smaller position
  const volFactor = 1 - (0.5 * Math.max(0, Math.min(100, volatilityPercentile)) / 100);

  const adjustedSize = baseSize * volFactor;
  const floor = config.management.deployAmountSol || 0.1;
  const ceil = config.risk.maxDeployAmount || 50;

  return parseFloat(Math.max(floor, Math.min(ceil, adjustedSize)).toFixed(4));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
  } catch (e) { console.warn("[config] reloadScreeningThresholds failed:", e.message); }
}
