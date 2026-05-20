function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sortedAsc.length - 1));
  return sortedAsc[Math.min(sortedAsc.length - 1, idx)];
}

export function createFeeOracle({ rpcQuorum, config, log = () => {} }) {
  const cfg = config.feeOracle || config.executionEdge?.feeOracle || config;
  let cache = null;
  let timer = null;
  let started = false;

  async function refresh() {
    try {
      const result = await rpcQuorum.quorumCall("getRecentPrioritizationFees");
      const fees = (result || []).map(f => f.prioritizationFee).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
      cache = { samples: fees, sampled_at: Date.now() };
    } catch (e) {
      log("fee_oracle", `sample failed: ${e.message}`);
    }
  }

  function _getSamples() {
    if (!cache) return [];
    return cache.samples;
  }

  function getPriorityFeeMicroLamports(p = 75) {
    const s = _getSamples();
    const v = percentile(s, p);
    return Math.min(v, cfg.maxPriorityFeeMicroLamports);
  }

  function getTip(urgency = "normal") {
    const base = cfg.baseTipLamports;
    const mult = { normal: 1, urgent: 2, critical: 4 }[urgency] || 1;
    const p75 = getPriorityFeeMicroLamports(75);
    const congestion = Math.max(1, Math.min(50, p75 / 50_000));
    const tip = Math.floor(base * mult * congestion);
    return Math.min(tip, cfg.maxTipLamports);
  }

  function getMempoolSnapshot() {
    const s = _getSamples();
    return {
      fee_p50: percentile(s, 50),
      fee_p75: percentile(s, 75),
      fee_p95: percentile(s, 95),
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
