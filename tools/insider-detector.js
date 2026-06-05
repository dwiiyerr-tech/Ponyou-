/**
 * Insider Detector — read top-holder signatures and flag insider patterns
 *
 * Operates ONLY on data already enriched by screening — does not make new
 * RPC calls (those happen earlier in the screener). The detector applies
 * pattern recognition to the existing holder/holder-snapshot data:
 *
 *   1. SIMULTANEITY — N+ holders' first-buy timestamps cluster within
 *      a tight window (e.g. 5 blocks). Insider pre-fund signature.
 *   2. EQUAL-SIZE — top holders have buy sizes within X% of each other.
 *      Templated/automated buys = sock-puppet signature.
 *   3. FUNDING ANCESTOR — top holders funded from same parent within
 *      same 24h window (if funding source provided in snapshot).
 *   4. SNIPE-BLOCK — multiple top holders entered at block 1-3 from
 *      pool creation. Sniper-bot signature.
 *
 * Returns insider_score in [0, 1]:
 *   0.0–0.3  CLEAN — no insider patterns
 *   0.3–0.6  WARN  — one suspicious pattern (treat as caution)
 *   0.6–0.8  STRONG WARN — two patterns aligned
 *   0.8–1.0  BLOCK — three or more, clear insider/sock-puppet ring
 *
 * Honest limits:
 *   - We can only flag what existing data reveals. Without funding-source
 *     metadata, ancestor analysis returns 0 (not a false negative — just
 *     unknown). Operator should still consider that on a separate channel.
 *   - Sophisticated insiders use random delays + jittered amounts + clean
 *     funding to evade these heuristics. This catches lazy ones, not all.
 */

const DEFAULT_THRESHOLDS = {
  // SIMULTANEITY — N+ holders' first-buy ts within window
  simultaneityMaxBlocks: 5,
  simultaneityMinHolders: 3,
  // EQUAL-SIZE — N+ holders within X% of median
  equalSizeMaxDeviationPct: 0.10,
  equalSizeMinHolders: 3,
  // SNIPE BLOCK — N+ holders entered at block 1-3
  snipeMaxBlock: 3,
  snipeMinHolders: 2,
  // FUNDING — N+ holders funded from same parent
  fundingMinHolders: 2,
};

function pct(n) { return Number.isFinite(n) ? n : 0; }

/**
 * Build a normalized list of top holders from various possible shapes
 * the screener uses. Each entry: { address, first_buy_block, first_buy_ts,
 * amount_pct, funded_by }.
 */
function normalizeHolders(token) {
  const raw = Array.isArray(token?.top_holders)         ? token.top_holders
            : Array.isArray(token?.top_holders_snapshot)? token.top_holders_snapshot
            : Array.isArray(token?.holders)             ? token.holders
            : [];
  return raw
    .filter((h) => h && (h.address || h.wallet))
    .slice(0, 20) // top 20 max — anything beyond is noise
    .map((h) => ({
      address:        String(h.address || h.wallet),
      first_buy_block: Number(h.first_buy_block ?? h.entry_block ?? h.block ?? 0),
      first_buy_ts:    h.first_buy_ts || h.entry_ts || h.ts || null,
      amount_pct:      pct(Number(h.amount_pct ?? h.balance_pct ?? h.share ?? h.pct ?? 0)),
      funded_by:       h.funded_by || h.funding_source || h.parent_wallet || null,
    }));
}

// ─── Pattern 1: Simultaneity ───────────────────────────────────────────

function detectSimultaneity(holders, thresholds) {
  const withBlock = holders.filter((h) => h.first_buy_block > 0);
  if (withBlock.length < thresholds.simultaneityMinHolders) {
    return { triggered: false, score: 0, evidence: null };
  }
  const sorted = withBlock.slice().sort((a, b) => a.first_buy_block - b.first_buy_block);
  // Sliding window: find clusters within simultaneityMaxBlocks
  let bestCluster = [];
  for (let i = 0; i < sorted.length; i++) {
    const cluster = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].first_buy_block - sorted[i].first_buy_block <= thresholds.simultaneityMaxBlocks) {
        cluster.push(sorted[j]);
      } else break;
    }
    if (cluster.length > bestCluster.length) bestCluster = cluster;
  }
  const triggered = bestCluster.length >= thresholds.simultaneityMinHolders;
  if (!triggered) return { triggered: false, score: 0, evidence: null };
  // Score scales with how many holders cluster (cap at 0.4 contribution)
  const ratio = bestCluster.length / Math.max(1, holders.length);
  return {
    triggered: true,
    score: Math.min(0.4, 0.2 + ratio * 0.4),
    evidence: {
      cluster_size: bestCluster.length,
      block_range: [bestCluster[0].first_buy_block, bestCluster[bestCluster.length - 1].first_buy_block],
      addresses: bestCluster.map((h) => h.address.slice(0, 8)),
    },
  };
}

// ─── Pattern 2: Equal-size ─────────────────────────────────────────────

function detectEqualSize(holders, thresholds) {
  const withSize = holders.filter((h) => h.amount_pct > 0).slice(0, 10);
  if (withSize.length < thresholds.equalSizeMinHolders) {
    return { triggered: false, score: 0, evidence: null };
  }
  // Compute median amount
  const sortedAmts = withSize.map((h) => h.amount_pct).sort((a, b) => a - b);
  const median = sortedAmts[Math.floor(sortedAmts.length / 2)];
  if (median <= 0) return { triggered: false, score: 0, evidence: null };
  // Count how many fall within deviation of median
  const within = withSize.filter((h) => {
    const dev = Math.abs(h.amount_pct - median) / median;
    return dev <= thresholds.equalSizeMaxDeviationPct;
  });
  const triggered = within.length >= thresholds.equalSizeMinHolders;
  if (!triggered) return { triggered: false, score: 0, evidence: null };
  const ratio = within.length / withSize.length;
  return {
    triggered: true,
    score: Math.min(0.3, 0.15 + ratio * 0.3),
    evidence: {
      matched_holders: within.length,
      median_pct: Number(median.toFixed(2)),
      deviation_threshold_pct: thresholds.equalSizeMaxDeviationPct * 100,
    },
  };
}

// ─── Pattern 3: Funding ancestor ───────────────────────────────────────

function detectFundingAncestor(holders, thresholds) {
  const withFunding = holders.filter((h) => h.funded_by);
  if (withFunding.length === 0) return { triggered: false, score: 0, evidence: null };
  // Group by funding parent
  const groups = new Map();
  for (const h of withFunding) {
    const key = h.funded_by;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  let worstGroup = null;
  let worstCount = 0;
  for (const [parent, group] of groups.entries()) {
    if (group.length > worstCount) {
      worstCount = group.length;
      worstGroup = { parent, holders: group };
    }
  }
  if (worstCount < thresholds.fundingMinHolders) {
    return { triggered: false, score: 0, evidence: null };
  }
  const ratio = worstCount / Math.max(1, holders.length);
  return {
    triggered: true,
    score: Math.min(0.5, 0.25 + ratio * 0.5),
    evidence: {
      shared_parent: worstGroup.parent.slice(0, 8),
      shared_count: worstCount,
      addresses: worstGroup.holders.map((h) => h.address.slice(0, 8)),
    },
  };
}

// ─── Pattern 4: Snipe block ────────────────────────────────────────────

function detectSnipe(holders, thresholds, poolCreatedBlock = null) {
  // T3-9: use pool_created_block as the absolute snipe window baseline when
  // available. The dataset min-block heuristic fails for 100%-sniped launches:
  // if ALL holders bought at block 1000, minBlock = 1000 and all are within
  // snipeMaxBlock = 0 of each other — correctly flagged. But if the deployer
  // spread buys across 10 blocks (1000-1010) and snipeMaxBlock=5, blocks
  // 1006-1010 escape detection relative to minBlock=1000. With a known pool
  // creation block (e.g. 999), ALL buys within 999+snipeMaxBlock are caught.
  const withBlock = holders.filter((h) => h.first_buy_block > 0);
  if (withBlock.length === 0) return { triggered: false, score: 0, evidence: null };
  const baseline = (poolCreatedBlock > 0) ? poolCreatedBlock
    : Math.min(...withBlock.map((h) => h.first_buy_block));
  const snipers = withBlock.filter((h) => h.first_buy_block - baseline <= thresholds.snipeMaxBlock && h.first_buy_block >= baseline);
  if (snipers.length < thresholds.snipeMinHolders) {
    return { triggered: false, score: 0, evidence: null };
  }
  // Snipe heuristic: at least N holders within first few blocks of the
  // earliest buy. Could be organic launch OR sniper-bot pile-in. Score
  // moderate since it overlaps with simultaneity above.
  return {
    triggered: true,
    score: Math.min(0.25, 0.1 + (snipers.length / 10) * 0.25),
    evidence: {
      sniper_count: snipers.length,
      window_blocks: thresholds.snipeMaxBlock,
      addresses: snipers.map((h) => h.address.slice(0, 8)),
    },
  };
}

// ─── Main entry ────────────────────────────────────────────────────────

/**
 * Analyze a token's top-holder data for insider patterns.
 *
 * @param {Object} token — enriched token candidate
 * @param {Object} opts  — { thresholds? }
 * @returns {{
 *   insider_score: number,         // 0..1
 *   level: 'clean'|'warn'|'strong'|'block',
 *   patterns: { simultaneity, equal_size, funding, snipe },
 *   flagged_wallets: string[],
 *   reasons: string[],
 * }}
 */
export function detectInsiderPatterns(token, opts = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const holders = normalizeHolders(token);

  if (holders.length === 0) {
    return {
      insider_score: 0,
      level: "clean",
      patterns: { simultaneity: null, equal_size: null, funding: null, snipe: null },
      flagged_wallets: [],
      reasons: ["no holder data — cannot evaluate"],
    };
  }

  const sim = detectSimultaneity(holders, thresholds);
  const eq  = detectEqualSize(holders, thresholds);
  const fnd = detectFundingAncestor(holders, thresholds);
  const snp = detectSnipe(holders, thresholds, token.pool_created_block || null);

  const insider_score = Math.min(1, sim.score + eq.score + fnd.score + snp.score);

  // Aggregate flagged wallets across patterns
  const flagged = new Set();
  [sim, eq, fnd, snp].forEach((p) => {
    if (p.evidence?.addresses) p.evidence.addresses.forEach((a) => flagged.add(a));
  });

  let level = "clean";
  if (insider_score >= 0.8) level = "block";
  else if (insider_score >= 0.6) level = "strong";
  else if (insider_score >= 0.3) level = "warn";

  const reasons = [];
  if (sim.triggered) reasons.push(`simultaneity: ${sim.evidence.cluster_size} holders within ${thresholds.simultaneityMaxBlocks}-block window`);
  if (eq.triggered) reasons.push(`equal-size: ${eq.evidence.matched_holders} holders near median ${eq.evidence.median_pct}%`);
  if (fnd.triggered) reasons.push(`shared funding ancestor: ${fnd.evidence.shared_count} holders from ${fnd.evidence.shared_parent}…`);
  if (snp.triggered) reasons.push(`snipe-block: ${snp.evidence.sniper_count} holders in first ${thresholds.snipeMaxBlock} blocks`);

  return {
    insider_score: Number(insider_score.toFixed(3)),
    level,
    patterns: { simultaneity: sim, equal_size: eq, funding: fnd, snipe: snp },
    flagged_wallets: Array.from(flagged),
    reasons,
  };
}
