export const SEVERITY = Object.freeze({
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
});

export function aggregateSeverity(perDetector) {
  const values = Object.values(perDetector || {});
  if (values.length === 0) return SEVERITY.NONE;
  return Math.max(SEVERITY.NONE, ...values);
}

export function shouldEmit(newSev, lastSev) {
  return newSev > lastSev;
}

export function detectDevSell({ balanceAtEntry, currentBalance, thresholds }) {
  if (!Number.isFinite(balanceAtEntry) || balanceAtEntry <= 0) return SEVERITY.NONE;
  if (!Number.isFinite(currentBalance)) return SEVERITY.NONE;
  const deltaPct = ((currentBalance - balanceAtEntry) / balanceAtEntry) * 100;
  if (deltaPct >= 0) return SEVERITY.NONE;
  if (thresholds.high !== null && deltaPct <= thresholds.high) return SEVERITY.HIGH;
  if (thresholds.medium !== null && deltaPct <= thresholds.medium) return SEVERITY.MEDIUM;
  if (thresholds.low !== null && deltaPct <= thresholds.low) return SEVERITY.LOW;
  return SEVERITY.NONE;
}

export const BURN_ADDRESSES = Object.freeze([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
]);

export const LP_PROGRAMS = Object.freeze({
  raydiumV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  raydiumClmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  meteoraDlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
});

export function detectLpMovement({ lpAtEntry, currentLp, transferTo = null, removeLiquidityBy = null, deployerWallet = null, thresholds }) {
  if (removeLiquidityBy && deployerWallet && removeLiquidityBy === deployerWallet) return SEVERITY.HIGH;
  if (transferTo && BURN_ADDRESSES.includes(transferTo)) return SEVERITY.NONE;
  if (!Number.isFinite(lpAtEntry) || lpAtEntry <= 0) return SEVERITY.NONE;
  if (!Number.isFinite(currentLp)) return SEVERITY.NONE;
  const deltaPct = ((currentLp - lpAtEntry) / lpAtEntry) * 100;
  if (deltaPct >= 0) return SEVERITY.NONE;
  if (thresholds.high !== null && deltaPct <= thresholds.high) return SEVERITY.HIGH;
  const mediumThreshold = thresholds.high === null && thresholds.medium !== null
    ? Math.max(thresholds.medium, thresholds.low * 2)
    : thresholds.medium;
  if (mediumThreshold !== null && deltaPct <= mediumThreshold) return SEVERITY.MEDIUM;
  if (thresholds.low !== null && deltaPct <= thresholds.low) return SEVERITY.LOW;
  return SEVERITY.NONE;
}

export function detectAuthorityChange({ atEntry, current }) {
  const entryMint = atEntry?.mint_authority ?? null;
  const currMint = current?.mint_authority ?? null;
  const entryFreeze = atEntry?.freeze_authority ?? null;
  const currFreeze = current?.freeze_authority ?? null;
  const becameSet = (a, b) => a === null && b !== null;
  const transferredToBurn = (a, b) => a !== null && b !== null && a !== b && BURN_ADDRESSES.includes(b);
  if (becameSet(entryMint, currMint) && !BURN_ADDRESSES.includes(currMint)) return SEVERITY.HIGH;
  if (becameSet(entryFreeze, currFreeze) && !BURN_ADDRESSES.includes(currFreeze)) return SEVERITY.HIGH;
  if (transferredToBurn(entryMint, currMint) || transferredToBurn(entryFreeze, currFreeze)) return SEVERITY.LOW;
  return SEVERITY.NONE;
}

export function detectHolderDump({ snapshotTotal, events, windowMs, nowMs, thresholds }) {
  if (!Number.isFinite(snapshotTotal) || snapshotTotal <= 0) return SEVERITY.NONE;
  const cutoff = nowMs - windowMs;
  const cumulativeSold = (events || [])
    .filter(e => e.tsMs >= cutoff && Number.isFinite(e.deltaTokens) && e.deltaTokens < 0)
    .reduce((sum, e) => sum + e.deltaTokens, 0);
  if (cumulativeSold === 0) return SEVERITY.NONE;
  const deltaPct = (cumulativeSold / snapshotTotal) * 100;
  if (thresholds.high !== null && deltaPct <= thresholds.high) return SEVERITY.HIGH;
  if (thresholds.medium !== null && deltaPct <= thresholds.medium) return SEVERITY.MEDIUM;
  if (thresholds.low !== null && deltaPct <= thresholds.low) return SEVERITY.LOW;
  return SEVERITY.NONE;
}

export function createRugMonitor({ geyserStream, config, callbacks, fetchers, log = () => {} }) {
  const positions = new Map();
  let shuttingDown = false;

  function _newState(meta) {
    return {
      meta,
      geyser_subs: [],
      polling_handle: null,
      holder_events: [],
      last_severity_emitted: { dev_sell: SEVERITY.NONE, lp: SEVERITY.NONE, authority: SEVERITY.NONE, holders: SEVERITY.NONE },
      shutdown: false,
    };
  }

  const pollingMs = (config.pollingIntervalSec || 30) * 1000;

  function _emit(state, positionKey, detectorKey, severity, signalType, evidence, source) {
    if (!shouldEmit(severity, state.last_severity_emitted[detectorKey])) return;
    state.last_severity_emitted[detectorKey] = severity;
    const meta = { severity, signal_type: signalType, source, evidence, ts: Date.now() };
    if (severity === SEVERITY.HIGH && callbacks.onHigh) callbacks.onHigh(positionKey, signalType, meta);
    else if (severity === SEVERITY.MEDIUM && callbacks.onMedium) callbacks.onMedium(positionKey, signalType, meta);
    else if (severity === SEVERITY.LOW && callbacks.onLow) callbacks.onLow(positionKey, signalType, meta);
  }

  async function _pollOnce(positionKey, state) {
    if (state.shutdown) return;
    const m = state.meta;
    try {
      const bal = await fetchers.getTokenBalance(m.deployer_wallet, m.mint);
      const sev = detectDevSell({ balanceAtEntry: m.deployer_balance_at_entry, currentBalance: bal, thresholds: config.devSellThresholds });
      _emit(state, positionKey, "dev_sell", sev, "dev_sell", { current: bal, atEntry: m.deployer_balance_at_entry }, "polling");
    } catch (e) { log("rug_monitor", `dev_sell poll failed for ${positionKey}: ${e.message}`); }
    try {
      const currentLpUsd = await fetchers.getPoolLiquidityUsd(m.lp_address);
      const sev = detectLpMovement({ lpAtEntry: m.lp_usd_at_entry, currentLp: currentLpUsd, deployerWallet: m.deployer_wallet, thresholds: config.lpMovementThresholds });
      _emit(state, positionKey, "lp", sev, "lp_movement", { current: currentLpUsd, atEntry: m.lp_usd_at_entry }, "polling");
    } catch (e) { log("rug_monitor", `lp poll failed for ${positionKey}: ${e.message}`); }
    try {
      const mintAcct = await fetchers.getMintAccount(m.mint);
      const sev = detectAuthorityChange({ atEntry: m.authorities, current: mintAcct });
      _emit(state, positionKey, "authority", sev, "authority_change", { current: mintAcct }, "polling");
    } catch (e) { log("rug_monitor", `authority poll failed for ${positionKey}: ${e.message}`); }
    try {
      const current = await fetchers.getLargestAccounts(m.mint);
      const snapshotMap = new Map((m.top_holders_snapshot || []).map(h => [h.wallet, h.balance]));
      const events = (current || []).map(h => ({ tsMs: Date.now(), deltaTokens: (h.balance || 0) - (snapshotMap.get(h.wallet) || 0) }));
      state.holder_events.push(...events);
      const cutoff = Date.now() - 5 * 60_000;
      state.holder_events = state.holder_events.filter(e => e.tsMs >= cutoff);
      const snapshotTotal = (m.top_holders_snapshot || []).reduce((s, h) => s + (h.balance || 0), 0);
      const sev = detectHolderDump({ snapshotTotal, events: state.holder_events, windowMs: 5 * 60_000, nowMs: Date.now(), thresholds: config.holderDumpThresholds });
      _emit(state, positionKey, "holders", sev, "holder_dump", { eventsCount: state.holder_events.length }, "polling");
    } catch (e) { log("rug_monitor", `holders poll failed for ${positionKey}: ${e.message}`); }
  }

  function _schedulePolling(positionKey, state) {
    if (state.shutdown) return;
    state.polling_handle = setTimeout(async () => {
      await _pollOnce(positionKey, state);
      if (!state.shutdown) _schedulePolling(positionKey, state);
    }, pollingMs);
  }

  function attachPosition(positionKey, meta) {
    if (shuttingDown) return;
    if (positions.has(positionKey)) {
      const existing = positions.get(positionKey);
      existing.meta = { ...existing.meta, ...meta };
      return;
    }
    const state = _newState(meta);
    positions.set(positionKey, state);
    _schedulePolling(positionKey, state);
  }

  function detachPosition(positionKey) {
    const state = positions.get(positionKey);
    if (!state) return;
    if (state.polling_handle) clearTimeout(state.polling_handle);
    for (const sub of state.geyser_subs) {
      try { geyserStream?.unsubscribe?.(sub); } catch (_) {}
    }
    state.shutdown = true;
    positions.delete(positionKey);
  }

  function getMonitoredPositions() {
    return Array.from(positions.keys()).map(k => ({ position_key: k, meta: positions.get(k).meta }));
  }

  function shutdown() {
    shuttingDown = true;
    for (const key of Array.from(positions.keys())) {
      detachPosition(key);
    }
  }

  return { attachPosition, detachPosition, getMonitoredPositions, shutdown };
}
