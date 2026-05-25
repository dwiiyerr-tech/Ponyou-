function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sortedAsc.length - 1));
  return sortedAsc[Math.min(sortedAsc.length - 1, idx)];
}

export async function getHeliusPriorityFee(rpcUrl, serializedTxBase58) {
  if (!rpcUrl) return null;
  try {
    const params = serializedTxBase58
      ? [{ transaction: serializedTxBase58, options: { priorityLevel: "High" } }]
      : [{ options: { priorityLevel: "High" } }];
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getPriorityFeeEstimate", params }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const fee = data?.result?.priorityFeeEstimate;
    return Number.isFinite(fee) ? fee : null;
  } catch {
    return null;
  }
}

export function createFeeOracle({ rpcQuorum, config, heliusRpcUrl, log = () => {} }) {
  const cfg = config.feeOracle || config.executionEdge?.feeOracle || config;
  let cache = null;
  let timer = null;
  let started = false;

  async function refresh() {
    try {
      const [result, heliusFee] = await Promise.all([
        rpcQuorum.quorumCall("getRecentPrioritizationFees"),
        getHeliusPriorityFee(heliusRpcUrl),
      ]);
      const fees = (result || []).map(f => f.prioritizationFee).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
      if (fees.length > 0 || heliusFee != null) {
        cache = { samples: fees, heliusFee: heliusFee ?? null, sampled_at: Date.now() };
      }
    } catch (e) {
      log("fee_oracle", `sample failed: ${e.message} — using ${cache ? "stale cache" : "defaults"}`);
    }
  }

  const FALLBACK_PRIORITY_FEE = 50_000; // 0.00005 SOL — sane default when oracle is cold

  function _getSamples() {
    if (!cache) return [FALLBACK_PRIORITY_FEE];
    return cache.samples.length > 0 ? cache.samples : [FALLBACK_PRIORITY_FEE];
  }

  function getPriorityFeeMicroLamports(p = 75) {
    if (cache?.heliusFee != null) return Math.min(cache.heliusFee, cfg.maxPriorityFeeMicroLamports);
    const s = _getSamples();
    const v = percentile(s, p);
    return Math.min(v || FALLBACK_PRIORITY_FEE, cfg.maxPriorityFeeMicroLamports);
  }

  function getTip(urgency = "normal") {
    const base = cfg.baseTipLamports || 100_000;
    const mult = { normal: 1, urgent: 2, critical: 4 }[urgency] || 1;
    const p75 = getPriorityFeeMicroLamports(75) || FALLBACK_PRIORITY_FEE;
    const congestion = Math.max(1, Math.min(50, p75 / 50_000));
    const tip = Math.floor(base * mult * congestion);
    return Math.min(tip, cfg.maxTipLamports || 5_000_000);
  }

  function getMempoolSnapshot() {
    const s = _getSamples();
    return {
      fee_p50: percentile(s, 50),
      fee_p75: percentile(s, 75),
      fee_p95: percentile(s, 95),
      helius_fee: cache?.heliusFee ?? null,
      sampled_at: cache?.sampled_at || 0,
      tip_recommendation: { normal: getTip("normal"), urgent: getTip("urgent"), critical: getTip("critical") },
    };
  }

  function start() {
    if (started) return;
    started = true;
    refresh();
    timer = setInterval(refresh, cfg.sampleIntervalMs);
  }

  function stop() {
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { getPriorityFeeMicroLamports, getTip, getMempoolSnapshot, refresh, start, stop };
}
