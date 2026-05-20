export function classifySimulationError({ err, logs = [] }) {
  if (err === null || err === undefined) return { ok: true, action: "proceed", reason: "clean" };
  const errStr = typeof err === "string" ? err : JSON.stringify(err);
  const logsStr = (logs || []).join("\n");

  if (/InsufficientFunds/i.test(errStr)) return { ok: false, action: "block", reason: "insufficient_balance" };
  if (/Custom.*6001|ExceededSlippage/i.test(errStr)) return { ok: false, action: "block", reason: "slippage_exceeded" };
  if (/AccountNotFound/i.test(errStr)) return { ok: false, action: "block", reason: "honeypot_account_missing" };
  if (/InvalidAccountData/i.test(errStr) && /Token(keg)?/.test(logsStr)) return { ok: false, action: "block", reason: "honeypot_invalid_account" };
  if (/ComputeBudgetExceeded|MaxComputeUnitsExceeded/i.test(errStr)) return { ok: false, action: "bump_cu", reason: "needs_more_cu" };
  if (/BlockhashNotFound|BlockhashExpired/i.test(errStr)) return { ok: false, action: "retry", reason: "stale_blockhash" };
  if (errStr === "__timeout__") return { ok: false, action: "retry", reason: "sim_timeout" };
  return { ok: false, action: "block", reason: "unknown_sim_error" };
}

export async function simulatePreflight({ tx, rpcQuorum, options = {} }) {
  try {
    const raw = await rpcQuorum.quorumCall("simulateTransaction", tx, { replaceRecentBlockhash: options.replaceRecentBlockhash ?? true, sigVerify: false });
    const value = raw?.value || raw || {};
    const classification = classifySimulationError({ err: value.err, logs: value.logs || [] });
    return { ...classification, raw: value };
  } catch (e) {
    const classification = classifySimulationError({ err: "__timeout__" });
    return { ...classification, raw: { error: e.message } };
  }
}
