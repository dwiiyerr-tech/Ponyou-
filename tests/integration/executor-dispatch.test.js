// Integration tests for tools/executor.js — covers executeTool dispatch, safety
// gates, adaptiveSwap routing (single/split/partial-fill), confirm-mode parking,
// TOCTOU post-balance guard, tool timeout, and error paths.
//
// All chain calls (Jupiter, RPC, Telegram) are mocked — no real SOL is touched.
// Existing suites already cover:
//   • executor-bounds.test.js   — checkManagedGuard matrix, CONFIG_BOUNDS basics
//   • executor-partial-fill.test.js — selectFilledExecutions shapes
//   • managed-guard.test.js     — full managed-guard age/rug_force_exit matrix
// This file adds the INTEGRATION layer: executeTool dispatching all the above.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hoisted mock fns ──────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  swapToken:                   vi.fn(),
  getWalletBalances:           vi.fn(),
  getActiveWallet:             vi.fn(),
  markWalletError:             vi.fn(),
  buildAdaptiveTradeWalletPlan: vi.fn(),
  getWalletByAddress:          vi.fn(),
  isMultiWalletEnabled:        vi.fn(),
  rankWalletExecutionCandidates: vi.fn(),
  recordExecutionQuality:      vi.fn(),
  getTrackedPosition:          vi.fn(),
  listTrackedPositions:        vi.fn(),
  notifySwap:                  vi.fn(),
  sendHTML:                    vi.fn(),
  telegramEnabled:             vi.fn(),
  getMarketIntelligence:       vi.fn(),
  createPendingIntent:         vi.fn(),
  log:                         vi.fn(),
  logAction:                   vi.fn(),
  recordCounter:               vi.fn(),
  demoStrictGates:             vi.fn(),
  getStrategy:                 vi.fn(),
  execSync:                    vi.fn(),
  spawn:                       vi.fn(),
  executeGmgnSwap:             vi.fn(),
}));

// ── module mocks (hoisted above imports by Vitest) ────────────────────────────
vi.mock("../../tools/jupiter.js",       () => ({ swapToken: h.swapToken }));
vi.mock("../../tools/gmgnSwap.js",      () => ({ executeGmgnSwap: h.executeGmgnSwap }));
vi.mock("../../tools/wallet.js",        () => ({ getWalletBalances: h.getWalletBalances }));
vi.mock("../../tools/wallet-manager.js", () => ({
  getActiveWallet:              h.getActiveWallet,
  markWalletError:              h.markWalletError,
  buildAdaptiveTradeWalletPlan: h.buildAdaptiveTradeWalletPlan,
  getWalletByAddress:           h.getWalletByAddress,
  isMultiWalletEnabled:         h.isMultiWalletEnabled,
}));
vi.mock("../../execution-quality-memory.js", () => ({
  rankWalletExecutionCandidates: h.rankWalletExecutionCandidates,
  recordExecutionQuality:        h.recordExecutionQuality,
}));
vi.mock("../../state.js", () => ({
  getTrackedPosition:    h.getTrackedPosition,
  listTrackedPositions:  h.listTrackedPositions,
  setPositionInstruction: vi.fn(() => true),
  flushState:            vi.fn(),
}));
vi.mock("../../telegram.js", () => ({
  notifySwap:   h.notifySwap,
  sendHTML:     h.sendHTML,
  isEnabled:    h.telegramEnabled,
  notifyDeploy: vi.fn(),
  notifyClose:  vi.fn(),
}));
vi.mock("../../market-intelligence.js", () => ({
  getMarketIntelligence: h.getMarketIntelligence,
  getMarketTrend:        vi.fn(() => ({})),
}));
vi.mock("../../intents.js",  () => ({ createPendingIntent: h.createPendingIntent }));
vi.mock("../../logger.js",   () => ({ log: h.log, logAction: h.logAction }));
vi.mock("../../metrics.js",  () => ({ recordCounter: h.recordCounter }));
vi.mock("../../runtime-mode.js", () => ({
  demoStrictGates:         h.demoStrictGates,
  normalizeBooleanFlag:    (v) => v === true,
  PAPER_REDIRECT_STORES:   {},
}));
vi.mock("../../strategies.js", () => ({ getStrategy: h.getStrategy }));
vi.mock("../../config.js", () => ({
  config: {
    management: { gasReserve: 0.2 },
    trading:    { confirmMode: false, confirmTtlMin: 10 },
    gmgn:       {},
  },
}));
vi.mock("child_process", () => ({
  execSync: h.execSync,
  spawn:    h.spawn,
}));

// Stub heavy/network modules executor imports at top-level
vi.mock("../../tools/dexscreener.js", () => ({
  discoverTokens:          vi.fn(),
  getTokenSecurityDetails: vi.fn(),
  getSmartMoneyRank:       vi.fn(),
  getSmartMoneyInflow:     vi.fn(),
  getTrendingNarratives:   vi.fn(),
  getTokenKlines:          vi.fn(),
}));
vi.mock("../../tools/solana-rpc.js",    () => ({ getSolanaGasFee: vi.fn() }));
vi.mock("../../tools/token.js", () => ({
  getTokenInfo:      vi.fn(),
  getTokenHolders:   vi.fn(),
  getTokenNarrative: vi.fn(),
}));
vi.mock("../../tools/wallet-discovery.js", () => ({
  discoverSmartWallets:   vi.fn(),
  listDiscoveredWallets:  vi.fn(),
}));
vi.mock("../../tools/rug-harvester.js",  () => ({ harvestMarketRugs: vi.fn() }));
vi.mock("../../tools/rug-signals.js",    () => ({ clearSignalCache: vi.fn() }));
vi.mock("../../tools/narratives.js", () => ({
  classifyNarrative:        vi.fn(() => []),
  getNarrativeHeat:         vi.fn(() => ({})),
  recordNarrativeOutcome:   vi.fn(),
}));
vi.mock("../../tools/ticker-registry.js", () => ({
  resolveTicker:   vi.fn(),
  listTickers:     vi.fn(() => []),
  registerTicker:  vi.fn(),
}));
vi.mock("../../rent-refund.js", () => ({
  scanRefundableTokenAccounts:  vi.fn(),
  closeRefundableTokenAccounts: vi.fn(),
}));

// ── load executor after all mocks are in place ────────────────────────────────
const { executeTool, clampConfigValue, selectFilledExecutions } =
  await import("../../tools/executor.js");
const { config } = await import("../../config.js");

// ── shared fixtures ───────────────────────────────────────────────────────────
const MINT   = "TokenMintAddress111111111111111111111111";
const WALLET = { address: "WalletAddr11111111111111111111111111111", keypair: { k: 1 } };

function commonDefaults() {
  vi.clearAllMocks();
  h.recordExecutionQuality.mockResolvedValue(undefined);
  h.notifySwap.mockReturnValue(Promise.resolve());
  h.sendHTML.mockReturnValue(Promise.resolve());
  h.getMarketIntelligence.mockReturnValue({ condition: "neutral" });
  h.getStrategy.mockReturnValue({ id: "scalping" });
  h.demoStrictGates.mockReturnValue(false);
  h.listTrackedPositions.mockReturnValue([]);
  h.getTrackedPosition.mockReturnValue(null);
  h.getActiveWallet.mockReturnValue(WALLET);
  h.getWalletByAddress.mockReturnValue({ keypair: {} });
  h.telegramEnabled.mockReturnValue(false);
  config.trading.confirmMode = false;
  delete process.env.DRY_RUN;
  delete process.env.ALLOW_SELF_UPDATE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Group A — dispatch
// ─────────────────────────────────────────────────────────────────────────────
describe("executeTool — dispatch", () => {
  beforeEach(commonDefaults);
  afterEach(() => vi.useRealTimers());

  it("returns error object for unknown tool", async () => {
    const r = await executeTool("does_not_exist", {});
    expect(r).toEqual({ error: "Unknown tool: does_not_exist" });
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("routes a known non-swap tool to its implementation", async () => {
    h.getWalletBalances.mockResolvedValue({ sol: 1.5, tokens: [] });
    const r = await executeTool("get_wallet_balance", {});
    expect(r).toEqual({ sol: 1.5, tokens: [] });
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("strips trailing <...> suffix from tool name before dispatch", async () => {
    process.env.DRY_RUN = "true";
    h.isMultiWalletEnabled.mockReturnValue(false);
    h.swapToken.mockResolvedValue({ success: true, amount_out: 500 });
    const r = await executeTool("swap_token<|tool_call|>", {
      token_in: "SOL", token_out: MINT, amount: 0.1,
    });
    expect(h.swapToken).toHaveBeenCalledOnce();
    expect(r.success).toBe(true);
  });

  it("non-swap non-protected tool does NOT trigger balance safety check", async () => {
    await executeTool("get_market_intelligence", {});
    expect(h.getWalletBalances).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group B — runSafetyChecks (via executeTool, live mode)
// ─────────────────────────────────────────────────────────────────────────────
describe("runSafetyChecks via executeTool", () => {
  beforeEach(() => {
    commonDefaults();
    // live mode so the balance gate fires
    delete process.env.DRY_RUN;
  });
  afterEach(() => vi.useRealTimers());

  it("blocks BUY with insufficient SOL", async () => {
    // 0.05 SOL — need 0.1 amount + 0.2 gasReserve = 0.3
    h.getWalletBalances.mockResolvedValue({ sol: 0.05, tokens: [] });
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r).toMatchObject({ blocked: true, reason: expect.stringMatching(/Insufficient SOL/) });
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("blocks SELL when token not found in wallet", async () => {
    h.getWalletBalances.mockResolvedValue({ sol: 5, tokens: [] });
    const r = await executeTool("swap_token", { token_in: MINT, token_out: "SOL", amount: 100 });
    expect(r).toMatchObject({ blocked: true, reason: expect.stringMatching(/Token not held/) });
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("managed guard blocks sell of position younger than 5 min", async () => {
    h.getWalletBalances.mockResolvedValue({ sol: 5, tokens: [{ mint: MINT, balance: 100 }] });
    h.getTrackedPosition.mockReturnValue({
      deployed_at: new Date(Date.now() - 60_000).toISOString(), // 1 min old
    });
    const r = await executeTool("swap_token", { token_in: MINT, token_out: "SOL", amount: 100 });
    expect(r).toMatchObject({ blocked: true, reason: expect.stringMatching(/[Mm]anaged/) });
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("all safety checks pass → swap executes", async () => {
    h.getWalletBalances.mockResolvedValue({ sol: 5, tokens: [] });
    h.isMultiWalletEnabled.mockReturnValue(false);
    h.swapToken.mockResolvedValue({ success: true, amount_out: 500 });
    h.getTrackedPosition.mockReturnValue(null);
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r.success).toBe(true);
    expect(h.swapToken).toHaveBeenCalledOnce();
  });

  it("demoStrictGates=true forces balance gate even in DRY_RUN=true", async () => {
    process.env.DRY_RUN = "true";
    h.demoStrictGates.mockReturnValue(true);
    h.getWalletBalances.mockResolvedValue({ sol: 0.05, tokens: [] });
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r).toMatchObject({ blocked: true });
  });

  it("self_update is blocked when ALLOW_SELF_UPDATE is unset", async () => {
    const r = await executeTool("self_update", {});
    expect(r).toMatchObject({ blocked: true, reason: expect.stringMatching(/self_update is disabled/) });
  });

  it("self_update blocked without commit_hash even when ALLOW_SELF_UPDATE=true", async () => {
    process.env.ALLOW_SELF_UPDATE = "true";
    const r = await executeTool("self_update", {});
    expect(r).toMatchObject({ blocked: true, reason: expect.stringMatching(/commit_hash/) });
  });

  it("self_update proceeds when ALLOW_SELF_UPDATE=true and commit_hash provided", async () => {
    process.env.ALLOW_SELF_UPDATE = "true";
    h.execSync.mockReturnValue("Already up to date.");
    const r = await executeTool("self_update", { commit_hash: "abc1234" });
    expect(r.blocked).toBeUndefined();
    expect(r.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group C — adaptiveSwap routing
// ─────────────────────────────────────────────────────────────────────────────
describe("adaptiveSwap routing via executeTool", () => {
  beforeEach(() => {
    commonDefaults();
    process.env.DRY_RUN = "true"; // skip balance gate + preBalance for routing tests
  });
  afterEach(() => vi.useRealTimers());

  it("multi-wallet disabled → single Jupiter call, no plan built", async () => {
    h.isMultiWalletEnabled.mockReturnValue(false);
    h.swapToken.mockResolvedValue({ success: true });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(h.swapToken).toHaveBeenCalledOnce();
    expect(h.buildAdaptiveTradeWalletPlan).not.toHaveBeenCalled();
  });

  it("Phase 3: non-sol chain routes to GMGN swap, never Jupiter", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.executeGmgnSwap.mockResolvedValue({ success: true, dry_run: true, chain: "base", execution_provider: "gmgn" });
    const r = await executeTool("swap_token", { token_in: "ETH", token_out: "0xToken", amount: 0.01, chain: "base" });
    expect(h.executeGmgnSwap).toHaveBeenCalledOnce();
    expect(h.swapToken).not.toHaveBeenCalled();          // Jupiter untouched
    expect(h.buildAdaptiveTradeWalletPlan).not.toHaveBeenCalled();
    expect(r).toMatchObject({ execution_provider: "gmgn", chain: "base" });
  });

  it("chain=sol (and absent chain) stays on Jupiter — Solana path unchanged", async () => {
    h.isMultiWalletEnabled.mockReturnValue(false);
    h.swapToken.mockResolvedValue({ success: true });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1, chain: "sol" });
    expect(h.swapToken).toHaveBeenCalledOnce();
    expect(h.executeGmgnSwap).not.toHaveBeenCalled();
  });

  it("wallet_address present → bypasses multi-wallet routing", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.swapToken.mockResolvedValue({ success: true });
    await executeTool("swap_token", {
      token_in: "SOL", token_out: MINT, amount: 0.1, wallet_address: "WX",
    });
    expect(h.buildAdaptiveTradeWalletPlan).not.toHaveBeenCalled();
    expect(h.swapToken).toHaveBeenCalledOnce();
  });

  it("amount <= 0 → bypasses multi-wallet routing", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.swapToken.mockResolvedValue({ success: true });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0 });
    expect(h.buildAdaptiveTradeWalletPlan).not.toHaveBeenCalled();
  });

  it("multi-wallet buy, single wallet → routes to chosen wallet with keypair", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.buildAdaptiveTradeWalletPlan.mockReturnValue({
      selected_wallets: ["AddrA"], split: false, delays_ms: [],
    });
    h.rankWalletExecutionCandidates.mockReturnValue([{ address: "AddrA", amount_sol: 0.1 }]);
    h.getWalletByAddress.mockReturnValue({ keypair: { k: 99 } });
    h.swapToken.mockResolvedValue({ success: true });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(h.buildAdaptiveTradeWalletPlan).toHaveBeenCalledWith(MINT, 0.1, "entry");
    expect(h.swapToken).toHaveBeenCalledWith(
      expect.objectContaining({ wallet_address: "AddrA", wallet: { k: 99 } }),
    );
  });

  it("uses mode=dca when an open position already exists", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.listTrackedPositions.mockReturnValue([{ mint: MINT }]);
    h.buildAdaptiveTradeWalletPlan.mockReturnValue({
      selected_wallets: ["AddrA"], split: false, delays_ms: [],
    });
    h.rankWalletExecutionCandidates.mockReturnValue([{ address: "AddrA", amount_sol: 0.1 }]);
    h.swapToken.mockResolvedValue({ success: true });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(h.buildAdaptiveTradeWalletPlan).toHaveBeenCalledWith(MINT, 0.1, "dca");
    expect(h.rankWalletExecutionCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "dca" }),
    );
  });

  it("no eligible wallet returned → error without calling swapToken", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.buildAdaptiveTradeWalletPlan.mockReturnValue({ selected_wallets: [], split: false, delays_ms: [] });
    h.rankWalletExecutionCandidates.mockReturnValue([]);
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/No eligible wallet/) });
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("split buy → executes both legs in order, returns split_execution=true", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.buildAdaptiveTradeWalletPlan.mockReturnValue({
      selected_wallets: ["A", "B"], split: true, delays_ms: [0],
    });
    h.rankWalletExecutionCandidates.mockReturnValue([
      { address: "A", amount_sol: 0.05 },
      { address: "B", amount_sol: 0.05 },
    ]);
    h.swapToken.mockResolvedValue({ success: true });
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(h.swapToken).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ success: true, split_execution: true, token_in: "SOL", token_out: MINT });
    expect(r.executions).toHaveLength(2);
    expect(r.wallet_address).toBe("A");
    // verify leg wallet_addresses
    const calls = h.swapToken.mock.calls;
    expect(calls[0][0].wallet_address).toBe("A");
    expect(calls[1][0].wallet_address).toBe("B");
  });

  it("split: 2nd leg fails → partial_success=true, logs warn, records counter", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.buildAdaptiveTradeWalletPlan.mockReturnValue({
      selected_wallets: ["A", "B"], split: true, delays_ms: [0],
    });
    h.rankWalletExecutionCandidates.mockReturnValue([
      { address: "A", amount_sol: 0.05 },
      { address: "B", amount_sol: 0.05 },
    ]);
    h.swapToken
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "slippage exceeded" });
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r).toMatchObject({ success: false, partial_success: true });
    expect(r.executions).toHaveLength(2);
    expect(h.log).toHaveBeenCalledWith("executor_warn", expect.stringMatching(/partial fill/));
    expect(h.recordCounter).toHaveBeenCalledWith("executor_split_partial_fill");
  });

  it("split: 1st leg fails → no partial_success, no split_partial_fill counter", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.buildAdaptiveTradeWalletPlan.mockReturnValue({
      selected_wallets: ["A", "B"], split: true, delays_ms: [0],
    });
    h.rankWalletExecutionCandidates.mockReturnValue([
      { address: "A", amount_sol: 0.05 },
      { address: "B", amount_sol: 0.05 },
    ]);
    h.swapToken.mockResolvedValueOnce({ success: false, error: "first leg failed" });
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r.success).toBe(false);
    expect(r.partial_success).toBeFalsy();
    expect(h.recordCounter).not.toHaveBeenCalledWith("executor_split_partial_fill");
  });

  it("sell path: routes to wallet holding the position", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.buildAdaptiveTradeWalletPlan.mockReturnValue({ selected_wallets: ["SellerWallet"] });
    h.rankWalletExecutionCandidates.mockReturnValue([{ address: "SellerWallet", amount_sol: 100 }]);
    h.swapToken.mockResolvedValue({ success: true });
    await executeTool("swap_token", { token_in: MINT, token_out: "SOL", amount: 100 });
    expect(h.buildAdaptiveTradeWalletPlan).toHaveBeenCalledWith(MINT, 100, "sell");
    expect(h.swapToken).toHaveBeenCalledWith(
      expect.objectContaining({ wallet_address: "SellerWallet" }),
    );
  });

  it("sell path: no ranked wallet → error without swapToken", async () => {
    h.isMultiWalletEnabled.mockReturnValue(true);
    h.buildAdaptiveTradeWalletPlan.mockReturnValue({ selected_wallets: ["A"] });
    h.rankWalletExecutionCandidates.mockReturnValue([]);
    const r = await executeTool("swap_token", { token_in: MINT, token_out: "SOL", amount: 100 });
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/No wallet with open position/) });
    expect(h.swapToken).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group D — confirm-mode parking
// ─────────────────────────────────────────────────────────────────────────────
describe("maybeParkAsConfirmIntent (confirm mode)", () => {
  beforeEach(() => {
    commonDefaults();
    h.isMultiWalletEnabled.mockReturnValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it("confirmMode=false → proceeds with swap, intent not created", async () => {
    config.trading.confirmMode = false;
    process.env.DRY_RUN = "true";
    h.swapToken.mockResolvedValue({ success: true });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(h.createPendingIntent).not.toHaveBeenCalled();
    expect(h.swapToken).toHaveBeenCalledOnce();
  });

  it("confirmMode=true + DRY_RUN + no strict gates → proceeds (bypass for demo)", async () => {
    config.trading.confirmMode = true;
    process.env.DRY_RUN = "true";
    h.demoStrictGates.mockReturnValue(false);
    h.swapToken.mockResolvedValue({ success: true });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(h.createPendingIntent).not.toHaveBeenCalled();
    expect(h.swapToken).toHaveBeenCalledOnce();
  });

  it("confirmMode=true + live → parks BUY as intent, swapToken NOT called", async () => {
    config.trading.confirmMode = true;
    delete process.env.DRY_RUN;
    h.getWalletBalances.mockResolvedValue({ sol: 5, tokens: [] });
    h.createPendingIntent.mockResolvedValue({
      id: "intent-1", expires_at: "2026-06-02T10:00:00Z",
    });
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r).toMatchObject({ pending: true, intent_id: "intent-1" });
    expect(r.message).toMatch(/awaiting Telegram/);
    expect(h.swapToken).not.toHaveBeenCalled();
    expect(h.createPendingIntent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "buy" }),
    );
  });

  it("confirmMode=true + DRY_RUN + strict gates → parks", async () => {
    config.trading.confirmMode = true;
    process.env.DRY_RUN = "true";
    h.demoStrictGates.mockReturnValue(true);
    h.getWalletBalances.mockResolvedValue({ sol: 5, tokens: [] });
    h.createPendingIntent.mockResolvedValue({
      id: "intent-2", expires_at: "2026-06-02T10:00:00Z",
    });
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r).toMatchObject({ pending: true });
    expect(h.swapToken).not.toHaveBeenCalled();
  });

  it("confirmMode=true but token_in is NOT SOL → proceeds (only BUYs are parked)", async () => {
    config.trading.confirmMode = true;
    process.env.DRY_RUN = "true";
    h.swapToken.mockResolvedValue({ success: true });
    // sell: token_in is a non-SOL mint
    await executeTool("swap_token", { token_in: MINT, token_out: "SOL", amount: 100 });
    expect(h.createPendingIntent).not.toHaveBeenCalled();
    expect(h.swapToken).toHaveBeenCalledOnce();
  });

  it("telegram notify fired when enabled and intent is parked", async () => {
    config.trading.confirmMode = true;
    delete process.env.DRY_RUN;
    h.getWalletBalances.mockResolvedValue({ sol: 5, tokens: [] });
    h.createPendingIntent.mockResolvedValue({
      id: "intent-3", expires_at: "2026-06-02T10:00:00Z",
    });
    h.telegramEnabled.mockReturnValue(true);
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    await new Promise(r => setTimeout(r, 10)); // sendHTML is fire-and-forget
    expect(h.sendHTML).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group E — TOCTOU post-swap balance guard
// ─────────────────────────────────────────────────────────────────────────────
describe("TOCTOU post-swap balance guard", () => {
  beforeEach(() => {
    commonDefaults();
    h.isMultiWalletEnabled.mockReturnValue(false);
    delete process.env.DRY_RUN; // live mode: preBalance captured
  });
  afterEach(() => vi.useRealTimers());

  it("post-swap SOL below gasReserve → logs warning and records counter", async () => {
    // call order: safety check, preBalance, post-check
    h.getWalletBalances
      .mockResolvedValueOnce({ sol: 5, tokens: [] })  // safety
      .mockResolvedValueOnce({ sol: 5, tokens: [] })  // preBalance
      .mockResolvedValueOnce({ sol: 0.0, tokens: [] }); // post: below 0.2
    h.swapToken.mockResolvedValue({ success: true, amount_out: 1000 });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    await new Promise(r => setTimeout(r, 20)); // post-check is fire-and-forget
    expect(h.log).toHaveBeenCalledWith(
      "executor_warn",
      expect.stringMatching(/below gas reserve/),
    );
    expect(h.recordCounter).toHaveBeenCalledWith("executor_post_balance_low");
  });

  it("post-swap SOL healthy → no warning, no low-balance counter", async () => {
    h.getWalletBalances
      .mockResolvedValueOnce({ sol: 5, tokens: [] })
      .mockResolvedValueOnce({ sol: 5, tokens: [] })
      .mockResolvedValueOnce({ sol: 4, tokens: [] }); // above 0.2
    h.swapToken.mockResolvedValue({ success: true, amount_out: 1000 });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    await new Promise(r => setTimeout(r, 20));
    expect(h.recordCounter).not.toHaveBeenCalledWith("executor_post_balance_low");
  });

  it("DRY_RUN=true → preBalance not captured → no post-swap warning even if balance is low", async () => {
    process.env.DRY_RUN = "true";
    h.getWalletBalances.mockResolvedValue({ sol: 0.0, tokens: [] });
    h.swapToken.mockResolvedValue({ success: true, amount_out: 1000 });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    await new Promise(r => setTimeout(r, 20));
    expect(h.recordCounter).not.toHaveBeenCalledWith("executor_post_balance_low");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group F — tool timeout
// ─────────────────────────────────────────────────────────────────────────────
describe("tool timeout (90s)", () => {
  beforeEach(commonDefaults);
  afterEach(() => vi.useRealTimers());

  it("non-swap tool that never resolves → timeout error after 90s", async () => {
    vi.useFakeTimers();
    h.getWalletBalances.mockReturnValue(new Promise(() => {})); // hangs forever
    const p = executeTool("get_wallet_balance", {});
    await vi.advanceTimersByTimeAsync(90_000);
    const r = await p;
    expect(r).toMatchObject({
      error: expect.stringMatching(/timed out after 90s/),
      tool: "get_wallet_balance",
    });
    expect(h.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, result: null }),
    );
  });

  it("hung swap tool → timeout + marks wallet error + records quality failure", async () => {
    vi.useFakeTimers();
    process.env.DRY_RUN = "true";
    h.isMultiWalletEnabled.mockReturnValue(false);
    h.swapToken.mockReturnValue(new Promise(() => {})); // hangs forever
    const p = executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    await vi.advanceTimersByTimeAsync(90_000);
    const r = await p;
    expect(r).toMatchObject({ error: expect.stringMatching(/timed out after 90s/) });
    expect(h.markWalletError).toHaveBeenCalledWith(WALLET.address);
    expect(h.recordExecutionQuality).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group G — error paths
// ─────────────────────────────────────────────────────────────────────────────
describe("executeTool error paths", () => {
  beforeEach(() => {
    commonDefaults();
    h.isMultiWalletEnabled.mockReturnValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it("non-swap tool throws → {error, tool}, does not mark wallet error", async () => {
    h.getWalletBalances.mockRejectedValue(new Error("rpc down"));
    const r = await executeTool("get_wallet_balance", {});
    expect(r).toEqual({ error: "rpc down", tool: "get_wallet_balance" });
    expect(h.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ result: null, error: "rpc down", success: false }),
    );
    expect(h.markWalletError).not.toHaveBeenCalled();
  });

  it("swap tool throws → marks wallet error + records execution quality failure", async () => {
    process.env.DRY_RUN = "true";
    h.swapToken.mockRejectedValue(new Error("rpc fail"));
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r).toEqual({ error: "rpc fail", tool: "swap_token" });
    expect(h.markWalletError).toHaveBeenCalledWith(WALLET.address);
    expect(h.recordExecutionQuality).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, mode: "buy" }),
    );
  });

  it("swap tool returns {error} (not thrown) → marks wallet error, notifySwap NOT fired", async () => {
    process.env.DRY_RUN = "true";
    h.swapToken.mockResolvedValue({ error: "no route found" });
    const r = await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    expect(r.error).toBe("no route found");
    expect(h.markWalletError).toHaveBeenCalledWith(WALLET.address);
    expect(h.recordExecutionQuality).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(h.notifySwap).not.toHaveBeenCalled();
  });

  it("successful swap fires notifySwap with correct payload + records quality success", async () => {
    process.env.DRY_RUN = "true";
    h.swapToken.mockResolvedValue({ success: true, amount_out: 1000, hash: "txhash123" });
    await executeTool("swap_token", { token_in: "SOL", token_out: MINT, amount: 0.1 });
    await new Promise(r => setTimeout(r, 10)); // notifySwap is fire-and-forget
    expect(h.notifySwap).toHaveBeenCalledWith(
      expect.objectContaining({
        inputSymbol: "SOL",
        amountIn: 0.1,
        amountOut: 1000,
        tx: "txhash123",
      }),
    );
    expect(h.markWalletError).not.toHaveBeenCalled();
    expect(h.recordExecutionQuality).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, mode: "buy" }),
    );
  });

  it("sell swap records mode=sell in execution quality", async () => {
    process.env.DRY_RUN = "true";
    h.swapToken.mockResolvedValue({ success: true, amount_out: 0.5 });
    await executeTool("swap_token", { token_in: MINT, token_out: "SOL", amount: 100 });
    expect(h.recordExecutionQuality).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, mode: "sell" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group H — clampConfigValue edge cases (extends executor-bounds.test.js)
// ─────────────────────────────────────────────────────────────────────────────
describe("clampConfigValue — edge cases", () => {
  it("NaN passes through without clamping (not finite)", () => {
    const r = clampConfigValue("gasReserve", NaN);
    expect(r.clamped).toBe(false);
    expect(Number.isNaN(r.value)).toBe(true);
  });

  it("Infinity passes through without clamping", () => {
    const r = clampConfigValue("maxPositions", Infinity);
    expect(r).toMatchObject({ clamped: false });
  });

  it("null value passes through unchanged", () => {
    const r = clampConfigValue("gasReserve", null);
    expect(r).toMatchObject({ clamped: false, value: null });
  });

  it("value above max: clamped=true with original and reason", () => {
    // positionSizePct max = 1.0
    const r = clampConfigValue("positionSizePct", 5);
    expect(r).toMatchObject({
      clamped: true,
      value: 1.0,
      original: 5,
      reason: expect.stringMatching(/clamped to max/),
    });
  });

  it("value below min: clamped=true with original and reason", () => {
    // gasReserve min = 0.001
    const r = clampConfigValue("gasReserve", 0.0001);
    expect(r).toMatchObject({
      clamped: true,
      value: 0.001,
      original: 0.0001,
      reason: expect.stringMatching(/clamped to min/),
    });
  });

  it("unknown key passes value through unchanged", () => {
    const r = clampConfigValue("unknownConfigKey", 999);
    expect(r).toMatchObject({ clamped: false, value: 999 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group I — selectFilledExecutions edge case (complements executor-partial-fill.test.js)
// ─────────────────────────────────────────────────────────────────────────────
describe("selectFilledExecutions — empty executions edge case", () => {
  it("executions[] present but empty falls through to single-success branch", () => {
    const fb = { mint: MINT, amount: 0.1 };
    // empty array (length 0) does NOT satisfy the `length > 0` guard
    // → falls through to the `result.success` branch → [fallback]
    const r = selectFilledExecutions({ success: true, executions: [] }, fb);
    expect(r).toEqual([fb]);
  });
});
