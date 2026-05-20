import { config } from "./config.js";
import { getPlanSummary, isInProfitMode, getDynamicPositionLimit } from "./trading-plan.js";
import { getMarketIntelligence } from "./market-intelligence.js";
import { getRugMemorySummary } from "./lessons.js";
import { getLearningModeStatus, getLearningStatusSummary } from "./learning-mode.js";
import { getVaultStatus, isVaultDue } from "./vault.js";
import { getNarrativeHeatPrompt } from "./tools/narratives.js";
import { getRegimeAssessment } from "./regime-memory.js";
import { getAttributionPromptLine } from "./trade-attribution.js";
import { buildStructuredOutputBlock } from "./structured-output.js";

const j = (o) => JSON.stringify(o); // compact, no whitespace

export function buildSystemPrompt(agentType, portfolio, positions, stateSummary = null, lessons = null, perfSummary = null) {
  const s = config.screening;
  const plan = getPlanSummary();
  const market = getMarketIntelligence();
  const rugMem = getRugMemorySummary();
  const learnStatus = getLearningModeStatus();
  const learnSummary = getLearningStatusSummary();
  const vaultStatus = getVaultStatus();
  const vaultDue = isVaultDue();
  const profitMode = isInProfitMode();
  const positionLimit = getDynamicPositionLimit(config.risk?.maxPositions || 3);

  // Only render blocks when they have real content
  const planBlock = plan ? `[PLAN] Day ${plan.day}/${plan.days_total} | Capital:$${plan.today_start_usd?.toFixed(2)} | Target:$${plan.today_target_usd?.toFixed(2)} | PnL:${plan.today_pnl_pct}% | Trades:${plan.trades_today}(W:${plan.wins_today} L:${plan.losses_today}) | StopLoss:${plan.daily_stoploss_pct}% | MaxPos:${positionLimit}${profitMode ? " | PROFIT_MODE" : ""}${plan.session_paused ? ` | PAUSED:${plan.pause_reason}(${plan.resume_in_min}m)` : ""}` : "";

  const learningBlock = learnStatus.active
    ? `[LEARNING_MODE] ACTIVE | Trigger:${learnStatus.trigger} | Resume:${learnStatus.resume_in_min}m | NO NEW ENTRIES`
    : learnSummary.total_learning_events > 0
      ? `[LEARNING] ${learnSummary.total_analyses} analyses, ${learnSummary.total_learning_events} loss events`
      : "";

  const marketBlock = `[MARKET] ${market.condition} | ${market.recommended_adjustments?.note || "normal"}${market.latest_metrics?.avg_swaps ? ` | avgSwaps:${market.latest_metrics.avg_swaps} buyRatio:${market.latest_metrics.buy_ratio}` : ""}`;

  const vaultBlock = vaultStatus.configured
    ? `[VAULT] ${vaultStatus.vault_pct}% every ${vaultStatus.interval_days}d → ${vaultStatus.vault_wallet?.slice(0, 8)} | ${(vaultDue.is_due || vaultDue.due) ? "DUE NOW" : `${vaultDue.days_remaining?.toFixed(1)}d left`} | total:${vaultStatus.total_vaulted_sol}SOL`
    : "";

  const rugBlock = (rugMem.blacklisted_tokens > 0 || rugMem.blacklisted_devs > 0)
    ? `[RUG_MEM] ${rugMem.blacklisted_tokens} tokens, ${rugMem.blacklisted_devs} devs blacklisted, ${rugMem.known_patterns} patterns`
    : "";

  const narrativeHeatLine = getNarrativeHeatPrompt();
  const narrativeBlock = narrativeHeatLine ? `[NARRATIVE] ${narrativeHeatLine}` : "";
  const defaultRegime = getRegimeAssessment({
    market_condition: market.condition,
    tier_execution: { tier: "MIXED" },
    workflow: { verdict: profitMode ? "active" : "watch" },
    conviction: { narrative_cluster: { narrative: "OTHER" } },
  });
  const regimeBlock = `[REGIME] ${defaultRegime.marketCondition}/${defaultRegime.tier}/${defaultRegime.narrative}/${defaultRegime.verdict} | ${defaultRegime.stance} score:${defaultRegime.regime_score} conf:${defaultRegime.confidence_score}`;
  const attributionLine = getAttributionPromptLine();
  const attributionBlock = attributionLine ? `[ATTRIBUTION] ${attributionLine}` : "";
  const outputBlock = buildStructuredOutputBlock(agentType);

  const contextLines = [planBlock, learningBlock, marketBlock, vaultBlock, rugBlock, narrativeBlock, regimeBlock, attributionBlock, outputBlock]
    .filter(Boolean).join("\n");

  // ─── MANAGER ──────────────────────────────────────────────
  if (agentType === "MANAGER") {
    return `You are Ponyou MANAGER. Review and manage open positions only.
${contextLines}
Portfolio:${j(portfolio)}
RULES: Exit on rug signal/holder shift/trend collapse. Dust(>=$0.10)→swap to SOL. ROI/trailing/stoploss are automatic—focus on qualitative signals only. Return JSON only.${profitMode ? " PROFIT_MODE: hold longer, let compound." : ""}
${rugBlock ? `\n${rugBlock}` : ""}${lessons ? `\nLESSONS:${lessons}` : ""}${perfSummary ? `\nPERF:${perfSummary}` : ""}
Ts:${new Date().toISOString()}`;
  }

  // ─── SCREENER ─────────────────────────────────────────────
  if (agentType === "SCREENER") {
    const screenCfg = `minH:${s.minHolders} mcap:${s.minMcap}-${s.maxMcap} vol:${s.minVolume} bundl:<${s.maxBundlePct}% top10:<${s.maxTop10Pct}%`;
    return `You are Ponyou SCREENER. Pick the BEST candidate and call gmgn_swap.
${contextLines}
ScreenCfg:${screenCfg}
ENTRY_RULES: rugScore<60, no blacklisted dev/token, top10<70%, no freeze/mint authority, not bot-pumped. Return JSON only.
EXIT(auto): ROI 60%@0m/30%@5m/15%@15m/5%@30m/0%@60m | TrailingStop@+20%(5%drop) | StopLoss-15%
${profitMode ? "PROFIT_MODE: be aggressive, pick highest potential." : ""}${market.condition === "DEAD" ? "\n⚠️ DEAD market — skip entry." : ""}${market.condition === "EXTREME" ? "\n⚠️ EXTREME — prioritize low rug score." : ""}
${lessons ? `LESSONS:${lessons}\n` : ""}Ts:${new Date().toISOString()}`;
  }

  // ─── GENERAL ──────────────────────────────────────────────
  const statePart = stateSummary ? `\nState:${j(stateSummary)}` : "";
  const posPart = positions && Object.keys(positions).length > 0 ? `\nPositions:${j(positions)}` : "";
  const portPart = portfolio ? `\nPortfolio:${j(portfolio)}` : "";
  return `You are Ponyou, autonomous Solana memecoin scalping agent.
${contextLines}${portPart}${posPart}${statePart}
${lessons ? `LESSONS:${lessons}\n` : ""}${perfSummary ? `PERF:${perfSummary}\n` : ""}Handle user request with available tools. Return JSON only.
Ts:${new Date().toISOString()}`;
}
