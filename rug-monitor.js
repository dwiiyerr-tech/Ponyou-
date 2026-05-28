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
  // RM-1: previously this read `Math.max(medium, low * 2)`. When thresholds.low
  // was null, `null * 2 === NaN` → Math.max returned NaN → the MEDIUM branch
  // could never fire. Guard the multiplication so a null `low` falls back to
  // the plain medium threshold.
  const fallbackFromLow = thresholds.low !== null ? thresholds.low * 2 : null;
  const mediumThreshold = thresholds.high === null && thresholds.medium !== null
    ? (fallbackFromLow !== null ? Math.max(thresholds.medium, fallbackFromLow) : thresholds.medium)
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
      // RM-7: cache the previous poll's holder balance map so dump deltas
      // are computed *between successive polls* instead of comparing the
      // current balance to the original snapshot every cycle. The bug
      // before: the same "current - snapshot" delta got pushed on every
      // poll, then summed by detectHolderDump — inflating the apparent
      // dump linearly with poll count (10 polls in a 5-min window of
      // 30s polling = 10x false amplification).
      prev_holder_balances: new Map((meta.top_holders_snapshot || []).map(h => [h.wallet, h.balance])),
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
      // RM-7 fix: compute delta against the *previous* poll, not against
      // the initial entry snapshot. Only deltas for wallets that were on
      // the previous poll (i.e., real movement between polls) count.
      const now = Date.now();
      const events = (current || []).map(h => {
        const prev = state.prev_holder_balances.get(h.wallet);
        if (prev === undefined) return null; // brand-new top holder this cycle — no delta to record
        return { tsMs: now, deltaTokens: (h.balance || 0) - prev };
      }).filter(Boolean);
      state.holder_events.push(...events);
      // Refresh the per-poll balance cache so the *next* poll computes its
      // delta against this poll's snapshot.
      state.prev_holder_balances = new Map((current || []).map(h => [h.wallet, h.balance || 0]));
      const cutoff = now - 5 * 60_000;
      state.holder_events = state.holder_events.filter(e => e.tsMs >= cutoff);
      const snapshotTotal = (m.top_holders_snapshot || []).reduce((s, h) => s + (h.balance || 0), 0);
      const sev = detectHolderDump({ snapshotTotal, events: state.holder_events, windowMs: 5 * 60_000, nowMs: now, thresholds: config.holderDumpThresholds });
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
      const oldMeta = existing.meta;
      existing.meta = { ...existing.meta, ...meta };
      // RM-3: if any of the watched account fields changed, tear down the
      // old Geyser subscriptions and re-subscribe with the new accounts.
      // Without this, e.g. a dev wallet handoff would leave the monitor
      // watching the old deployer_token_account forever.
      const watchedKeys = ["deployer_token_account", "lp_address", "mint"];
      const anyChanged = watchedKeys.some(k => meta[k] !== undefined && meta[k] !== oldMeta[k]);
      if (anyChanged && geyserStream?.unsubscribe) {
        for (const sub of existing.geyser_subs) {
          try { geyserStream.unsubscribe(sub); } catch (_) {}
        }
        existing.geyser_subs = [];
        _subscribeGeyser(positionKey, existing);
      }
      return;
    }
    const state = _newState(meta);
    positions.set(positionKey, state);
    _schedulePolling(positionKey, state);
    _subscribeGeyser(positionKey, state);
  }

  // Extracted so attachPosition can also use it when meta-driven account
  // fields change on a re-attach (RM-3).
  function _subscribeGeyser(positionKey, state) {
    if (!geyserStream?.subscribe) return;
    const meta = state.meta;
    if (meta.deployer_token_account) {
      const sub = geyserStream.subscribe(
        { kind: "account", account: meta.deployer_token_account },
        (evt) => {
          const sev = detectDevSell({
            balanceAtEntry: state.meta.deployer_balance_at_entry,
            currentBalance: evt?.tokenBalance,
            thresholds: config.devSellThresholds,
          });
          _emit(state, positionKey, "dev_sell", sev, "dev_sell", { current: evt?.tokenBalance }, "geyser");
        }
      );
      state.geyser_subs.push(sub);
    }
    if (meta.lp_address) {
      const sub = geyserStream.subscribe(
        { kind: "account", account: meta.lp_address },
        (evt) => {
          const sev = detectLpMovement({
            lpAtEntry: state.meta.lp_usd_at_entry,
            currentLp: evt?.lpUsd ?? evt?.currentLp,
            transferTo: evt?.transferTo,
            removeLiquidityBy: evt?.removeLiquidityBy,
            deployerWallet: state.meta.deployer_wallet,
            thresholds: config.lpMovementThresholds,
          });
          _emit(state, positionKey, "lp", sev, "lp_movement", { evt }, "geyser");
        }
      );
      state.geyser_subs.push(sub);
    }
    if (meta.mint) {
      const sub = geyserStream.subscribe(
        { kind: "account", account: meta.mint },
        (evt) => {
          const sev = detectAuthorityChange({ atEntry: state.meta.authorities, current: evt });
          _emit(state, positionKey, "authority", sev, "authority_change", { current: evt }, "geyser");
        }
      );
      state.geyser_subs.push(sub);
    }
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
