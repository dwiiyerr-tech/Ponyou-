// Tests for the unified execution layer: sharedSwapGuards, normalizeSwapResult,
// executeTrade. These are the P0-level safety invariants that every swap path
// must satisfy — LLM-driven, fast-buy, and deterministic exits alike.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────
// noopModule must be hoisted because vi.mock() calls are hoisted above imports.
const { noopModule } = vi.hoisted(() => {
  const noopModule = () => ({
    default: () => {},
    ...Object.fromEntries(
      ["discoverTokens","getTokenSecurityDetails","getSmartMoneyRank","getSmartMoneyInflow",
       "getTrendingNarratives","getTokenKlines","scanRefundableTokenAccounts",
       "closeRefundableTokenAccounts","addLesson","clearAllLessons","clearPerformance",
       "removeLessonsByKeyword","getPerformanceHistory","pinLesson","unpinLesson",
       "listLessons","recordRug","scoreRugRisk","getRugMemorySummary","getPlanSummary",
       "initTradingPlan","pauseSession","advanceDay","checkSessionGate","isInProfitMode",
       "getDynamicPositionLimit","getConsecutiveLosses","getLearningModeStatus",
       "getLearningStatusSummary","getLearningHistory","activateLearningMode",
       "getVaultStatus","isVaultDue","computeVaultAmount","generateDailyReport",
       "formatReportTelegram","getReportStatus","getPoolMemory","addPoolNote",
       "addToBlacklist","removeFromBlacklist","listBlacklist","blockDev","unblockDev",
       "listBlockedDevs","addSmartWallet","removeSmartWallet","listSmartWallets",
       "discoverSmartWallets","listDiscoveredWallets","analyzeDexVisibilityRisk",
       "analyzeThreeCandleConfirmation","analyzeCabalPlay","processWalletPing",
       "analyzeDayPhase","learnPatterns","listPatterns","clearSignalCache",
       "harvestMarketRugs","classifyNarrative","getNarrativeHeat","recordNarrativeOutcome",
       "resolveTicker","listTickers","registerTicker","getTokenInfo","getTokenHolders",
       "getTokenNarrative","getRecentDecisions","getSolanaGasFee",
      ].map(k => [k, () => {}])
    ),
  });
  return { noopModule };
});

const h = vi.hoisted(() => ({
  isKilled:          vi.fn(() => false),
  getWalletBalances: vi.fn(() => ({ sol: 10, tokens: [] })),
  isMultiWalletEnabled: vi.fn(() => false),
  getActiveWallet:   vi.fn(() => null),
  buildAdaptiveTradeWalletPlan: vi.fn(() => ({ selected_wallets: [], split: false })),
  rankWalletExecutionCandidates: vi.fn(() => []),
  getWalletByAddress: vi.fn(() => null),
  listTrackedPositions: vi.fn(() => []),
  swapToken:         vi.fn(() => ({ success: true, hash: "abc123", amount_out: 1e9, execution_provider: "jupiter" })),
  executeGmgnSwap:   vi.fn(() => ({ success: true, dry_run: false, chain: "base", hash: "0xabc", amount_out: 0.01, execution_provider: "gmgn" })),
  getMarketIntelligence: vi.fn(() => ({ condition: "NORMAL" })),
  log:               vi.fn(),
  logAction:         vi.fn(),
  recordCounter:     vi.fn(),
  telegramEnabled:   vi.fn(() => false),
  notifySwap:        vi.fn(),
  sendHTML:          vi.fn(),
  getTrackedPosition: vi.fn(() => null),
  createPendingIntent: vi.fn(),
  getStrategy:       vi.fn(() => null),
  execSync:          vi.fn(),
  spawn:             vi.fn(),
  recordExecutionQuality: vi.fn(),
  markWalletError:   vi.fn(),
}));

vi.mock("../kill-switch.js",          () => ({ isKilled: h.isKilled, readKillState: vi.fn(() => ({})) }));
vi.mock("../tools/wallet.js",         () => ({ getWalletBalances: h.getWalletBalances }));
vi.mock("../tools/wallet-manager.js", () => ({
  getActiveWallet:              h.getActiveWallet,
  markWalletError:              h.markWalletError,
  buildAdaptiveTradeWalletPlan: h.buildAdaptiveTradeWalletPlan,
  getWalletByAddress:           h.getWalletByAddress,
  isMultiWalletEnabled:         h.isMultiWalletEnabled,
  rankWalletExecutionCandidates: h.rankWalletExecutionCandidates,
  getWalletCapitalSol:          vi.fn(() => 5),
  getAllWallets:                 vi.fn(() => []),
}));
vi.mock("../tools/jupiter.js",        () => ({ swapToken: h.swapToken, preSwapGuard: vi.fn(async () => ({ allowed: true })) }));
vi.mock("../tools/gmgnSwap.js",       () => ({ executeGmgnSwap: h.executeGmgnSwap }));
vi.mock("../state.js",                () => ({
  getTrackedPosition:   h.getTrackedPosition,
  listTrackedPositions: h.listTrackedPositions,
  setPositionInstruction: vi.fn(),
  flushState:           vi.fn(),
}));
vi.mock("../market-intelligence.js",  () => ({ getMarketIntelligence: h.getMarketIntelligence, getMarketTrend: vi.fn(() => "neutral") }));
vi.mock("../logger.js",               () => ({ log: h.log, logAction: h.logAction }));
vi.mock("../metrics.js",              () => ({ recordCounter: h.recordCounter, recordLatency: vi.fn(), startTimer: vi.fn(() => 0), elapsedMs: vi.fn(() => 0) }));
vi.mock("../telegram.js",             () => ({ isEnabled: h.telegramEnabled, notifySwap: h.notifySwap, notifyDeploy: vi.fn(), notifyClose: vi.fn(), sendHTML: h.sendHTML }));
vi.mock("../intents.js",              () => ({ createPendingIntent: h.createPendingIntent }));
vi.mock("../strategies.js",           () => ({ getStrategy: h.getStrategy }));
vi.mock("../execution-quality-memory.js", () => ({ rankWalletExecutionCandidates: h.rankWalletExecutionCandidates, recordExecutionQuality: h.recordExecutionQuality }));

// Stub every other executor dependency that touches disk
vi.mock("../tools/dexscreener.js",                   noopModule);
vi.mock("../lessons.js",                              noopModule);
vi.mock("../trading-plan.js",                         noopModule);
vi.mock("../learning-mode.js",                        noopModule);
vi.mock("../vault.js",                                noopModule);
vi.mock("../daily-report.js",                         noopModule);
vi.mock("../pool-memory.js",                          noopModule);
vi.mock("../token-blacklist.js",                      noopModule);
vi.mock("../dev-blocklist.js",                        noopModule);
vi.mock("../smart-wallets.js",                        noopModule);
vi.mock("../tools/wallet-discovery.js",               noopModule);
vi.mock("../tools/dex-visibility-risk-analyzer.js",   noopModule);
vi.mock("../tools/three-candle-confirmation-strategy.js", noopModule);
vi.mock("../tools/cabal-play-analyzer.js",            noopModule);
vi.mock("../tools/wallet-ping-agent.js",              noopModule);
vi.mock("../tools/day-phase-analyzer.js",             noopModule);
vi.mock("../tools/rug-patterns.js",                   noopModule);
vi.mock("../tools/rug-signals.js",                    noopModule);
vi.mock("../tools/rug-harvester.js",                  noopModule);
vi.mock("../tools/narratives.js",                     noopModule);
vi.mock("../tools/ticker-registry.js",                noopModule);
vi.mock("../tools/token.js",                          noopModule);
vi.mock("../decision-log.js",                         noopModule);
vi.mock("../tools/solana-rpc.js",                     noopModule);
vi.mock("../rent-refund.js",                          noopModule);
vi.mock("child_process", () => ({ execSync: h.execSync, spawn: h.spawn }));

const { executeTrade } = await import("../tools/executor.js");

// ─── normalizeSwapResult (tested via executeTrade) ───────────────────────────

describe("normalizeSwapResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.isKilled.mockReturnValue(false);
    h.getWalletBalances.mockResolvedValue({ sol: 10, tokens: [] });
    process.env.DRY_RUN = "true"; // avoid real balance checks
  });

  it("always sets chain from args when raw lacks it", async () => {
    h.swapToken.mockResolvedValue({ success: true, hash: "x", amount_out: 1e9 });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.1 });
    expect(r.chain).toBe("sol");
  });

  it("prefers chain from raw result over args default", async () => {
    h.swapToken.mockResolvedValue({ success: true, hash: "x", amount_out: 1e9, chain: "sol" });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.1, chain: "sol" });
    expect(r.chain).toBe("sol");
  });

  it("indeterminate is always boolean false by default", async () => {
    h.swapToken.mockResolvedValue({ success: true, hash: "x" });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.1 });
    expect(typeof r.indeterminate).toBe("boolean");
    expect(r.indeterminate).toBe(false);
  });

  it("indeterminate is true when raw sets it", async () => {
    h.swapToken.mockResolvedValue({ success: false, indeterminate: true, hash_candidate: "y" });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.1 });
    expect(r.indeterminate).toBe(true);
  });

  it("dry_run is always boolean", async () => {
    h.swapToken.mockResolvedValue({ dry_run: true, would_swap: { token_in: "SOL" } });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.1 });
    expect(typeof r.dry_run).toBe("boolean");
    expect(r.dry_run).toBe(true);
  });

  it("normalizes hash from tx_hash when hash absent", async () => {
    h.swapToken.mockResolvedValue({ success: true, tx_hash: "txhash123", amount_out: 1e9 });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.1 });
    expect(r.hash).toBe("txhash123");
  });

  it("preserves would_swap from dry-run result", async () => {
    h.swapToken.mockResolvedValue({
      dry_run: true,
      would_swap: { token_in: "SOL", token_out: "MINT2", amount: 0.5 },
    });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT2", amount: 0.5 });
    expect(r.would_swap?.token_out).toBe("MINT2");
  });

  it("sets execution_provider to gmgn for EVM chain", async () => {
    h.executeGmgnSwap.mockResolvedValue({ success: true, chain: "base", hash: "0xabc" });
    const r = await executeTrade({ token_in: "ETH", token_out: "0xTOKEN", amount: 0.01, chain: "base" });
    expect(r.execution_provider).toBe("gmgn");
  });
});

// ─── sharedSwapGuards (tested via executeTrade) ──────────────────────────────

describe("sharedSwapGuards — kill-switch", () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.DRY_RUN = "true"; });

  it("blocks swap when kill-switch is active", async () => {
    h.isKilled.mockReturnValue(true);
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.1 });
    expect(r.success).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.error).toMatch(/kill.switch/i);
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("allows swap when kill-switch is inactive", async () => {
    h.isKilled.mockReturnValue(false);
    h.swapToken.mockResolvedValue({ success: true, hash: "ok" });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.1 });
    expect(r.success).toBe(true);
  });

  it("_bypass_kill_switch skips kill-switch check (for protective exits)", async () => {
    h.isKilled.mockReturnValue(true);
    h.swapToken.mockResolvedValue({ success: true, hash: "exit" });
    const r = await executeTrade({
      token_in: "MINT1", token_out: "SOL", amount: 1000,
      _bypass_kill_switch: true,
    });
    expect(r.blocked).toBeUndefined();
    expect(h.swapToken).toHaveBeenCalled();
  });
});

describe("sharedSwapGuards — amount validation", () => {
  beforeEach(() => { vi.clearAllMocks(); h.isKilled.mockReturnValue(false); process.env.DRY_RUN = "true"; });

  it.each([
    ["NaN",      NaN],
    ["zero",     0],
    ["negative", -1],
    ["Infinity", Infinity],
    ["string",   "abc"],
  ])("rejects %s amount", async (_, amount) => {
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount });
    expect(r.success).toBe(false);
    expect(r.blocked).toBe(true);
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("accepts valid positive finite amount", async () => {
    h.swapToken.mockResolvedValue({ success: true, hash: "ok" });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.5 });
    expect(r.success).toBe(true);
  });
});

describe("sharedSwapGuards — maxDeployAmount (SOL)", () => {
  beforeEach(() => { vi.clearAllMocks(); h.isKilled.mockReturnValue(false); process.env.DRY_RUN = "true"; });

  it("blocks SOL buy exceeding maxDeployAmount", async () => {
    // Default maxDeployAmount = 35 SOL
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 100 });
    expect(r.success).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.error).toMatch(/maxDeployAmount/i);
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("allows SOL buy within maxDeployAmount", async () => {
    h.swapToken.mockResolvedValue({ success: true, hash: "ok" });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 10 });
    expect(r.success).toBe(true);
  });

  it("EVM swap bypasses SOL maxDeployAmount guard", async () => {
    h.executeGmgnSwap.mockResolvedValue({ success: true, chain: "base", hash: "0x1" });
    const r = await executeTrade({ token_in: "ETH", token_out: "0xTOK", amount: 999, chain: "base" });
    expect(r.blocked).toBeUndefined();
    expect(h.executeGmgnSwap).toHaveBeenCalled();
  });
});

describe("executeTrade — blocked result shape", () => {
  it("returns consistent blocked result when guard fails", async () => {
    h.isKilled.mockReturnValue(true);
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT1", amount: 0.1 });
    expect(r).toMatchObject({
      success: false,
      blocked: true,
      chain: "sol",
      dry_run: false,
      indeterminate: false,
    });
    expect(typeof r.error).toBe("string");
  });
});

describe("exp #7 (C): atomic position-limit backstop in sharedSwapGuards", () => {
  const openPos = (mint) => ({ position: mint, closed: false });

  beforeEach(() => {
    vi.clearAllMocks();
    h.isKilled.mockReturnValue(false);
    process.env.DRY_RUN = "true";
    h.getStrategy.mockReturnValue({ protections: { max_open_trades: 3 } });
    h.getTrackedPosition.mockReturnValue(null);
    h.swapToken.mockResolvedValue({ success: true, hash: "ok" });
  });

  it("blocks a NEW entry when the book is at the limit", async () => {
    h.listTrackedPositions.mockReturnValue([openPos("A"), openPos("B"), openPos("C")]);
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT_NEW", amount: 0.1 });
    expect(r.blocked).toBe(true);
    expect(r.error).toMatch(/Position limit reached \(3\/3\)/);
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("blocks when the book is already OVER the limit", async () => {
    h.listTrackedPositions.mockReturnValue([openPos("A"), openPos("B"), openPos("C"), openPos("D"), openPos("E")]);
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT_NEW", amount: 0.1 });
    expect(r.blocked).toBe(true);
    expect(r.error).toMatch(/5\/3/);
  });

  it("allows a new entry while below the limit", async () => {
    h.listTrackedPositions.mockReturnValue([openPos("A"), openPos("B")]);
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT_NEW", amount: 0.1 });
    expect(r.blocked).toBeUndefined();
    expect(h.swapToken).toHaveBeenCalled();
  });

  it("allows adding to an EXISTING open position (staged DCA) even at the limit", async () => {
    h.listTrackedPositions.mockReturnValue([openPos("A"), openPos("B"), openPos("C")]);
    h.getTrackedPosition.mockReturnValue({ position: "MINT_A", closed: false });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT_A", amount: 0.1 });
    expect(r.blocked).toBeUndefined();
    expect(h.swapToken).toHaveBeenCalled();
  });

  it("treats a CLOSED tracked position as a new slot (re-entry counts)", async () => {
    h.listTrackedPositions.mockReturnValue([openPos("A"), openPos("B"), openPos("C")]);
    h.getTrackedPosition.mockReturnValue({ position: "MINT_X", closed: true });
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT_X", amount: 0.1 });
    expect(r.blocked).toBe(true);
  });

  it("never blocks SELLS regardless of book size", async () => {
    h.listTrackedPositions.mockReturnValue([openPos("A"), openPos("B"), openPos("C"), openPos("D")]);
    const r = await executeTrade({ token_in: "MINT_A", token_out: "SOL", amount: 0.1 });
    expect(r.blocked).toBeUndefined();
    expect(h.swapToken).toHaveBeenCalled();
  });

  it("falls back to config.risk.maxPositions when strategy has no protections", async () => {
    h.getStrategy.mockReturnValue(null);
    const { config } = await import("../config.js");
    const limit = Number(config.risk?.maxPositions ?? 3);
    h.listTrackedPositions.mockReturnValue(Array.from({ length: limit }, (_, i) => openPos(`P${i}`)));
    const r = await executeTrade({ token_in: "SOL", token_out: "MINT_NEW", amount: 0.1 });
    expect(r.blocked).toBe(true);
  });
});
