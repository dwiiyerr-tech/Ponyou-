/**
 * Entry FOMO Guard — block / warn on entries that look like late-to-the-move setups
 *
 * Common FOMO traps (where bot would be the bagholder):
 *   - 1h price already +50%+ → people who entered 1h ago are exiting on you
 *   - 4h price +200%+ → blow-off top territory
 *   - Volume spike without proportional liquidity growth → fake volume
 *     (wash trades from dev or insider before dump)
 *   - Buy/sell tx-ratio >3 → late retail FOMO is filling the book
 *
 * Returns:
 *   verdict: 'safe' | 'caution' | 'fomo' | 'extreme'
 *   block:   boolean (true for 'fomo'/'extreme' by default)
 *
 * Honest behavior:
 *   - "Safe" doesn't mean it'll go up — it means we're not chasing.
 *   - "FOMO" doesn't always mean it'll dump — sometimes it keeps running.
 *     But the EV-positive play is to wait for the pullback or skip.
 *   - User can override by lowering thresholds in config.
 */

const DEFAULT_THRESHOLDS = {
  price1h_caution:      0.30, // +30% in 1h → caution
  price1h_fomo:         0.50, // +50% in 1h → fomo
  price1h_extreme:      1.00, // +100% in 1h → extreme
  price4h_fomo:         2.00, // +200% in 4h → fomo
  price4h_extreme:      5.00, // +500% in 4h → extreme
  volume_spike_ratio:   5.0,  // volume24h > 5× volume(7d avg) → spike
  volume_per_liq_ratio: 3.0,  // volume24h > 3× liquidity → fake/wash trade signature
  buy_sell_ratio_warn:  2.0,
  buy_sell_ratio_fomo:  3.0,
};

function pctChange(token, field, sub = null) {
  // Accept multiple field shapes — DexScreener uses `priceChange.h1`,
  // Helius/Birdeye may use price_change_1h, etc.
  const candidates = [];
  if (sub) {
    candidates.push(token?.priceChange?.[sub]);
    candidates.push(token?.price_change?.[sub]);
  }
  candidates.push(token?.[field]);
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) {
      // DexScreener reports % as decimal-like (e.g. 50 means 50%). Normalize:
      return Math.abs(n) > 5 ? n / 100 : n;
    }
  }
  return 0;
}

/**
 * Evaluate FOMO setup for a candidate token.
 *
 * @param {Object} token  — enriched candidate
 * @param {Object} opts   — { thresholds?, blockOnFomo? }
 * @returns {{
 *   verdict: 'safe'|'caution'|'fomo'|'extreme',
 *   block:   boolean,
 *   score:   number,   // 0..1 fomo intensity
 *   signals: string[],
 *   metrics: Object,
 * }}
 */
export function evaluateFomoSetup(token, opts = {}) {
  const T = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const blockOnFomo = opts.blockOnFomo !== false;

  const price1h = pctChange(token, "price_change_1h", "h1");
  const price4h = pctChange(token, "price_change_4h", "h4");
  const price24h = pctChange(token, "price_change_24h", "h24");
  const volume24h = Number(token?.volume_24h_usd ?? token?.volume?.h24 ?? token?.volume_24h ?? 0);
  const volume7d = Number(token?.volume_7d_avg_usd ?? token?.volume_7d_avg ?? 0);
  const liquidity = Number(token?.liquidity_usd ?? token?.liquidity ?? 0);
  const buys24h = Number(token?.buys_24h ?? token?.txns?.h24?.buys ?? 0);
  const sells24h = Number(token?.sells_24h ?? token?.txns?.h24?.sells ?? 0);

  const signals = [];
  let score = 0;

  // ── 1h price momentum ──
  // Single-signal "fomo" threshold should be enough on its own — pumping
  // 50% in an hour is a clear late-entry trap regardless of other metrics.
  if (price1h >= T.price1h_extreme) {
    score += 0.7;
    signals.push(`1h price +${(price1h * 100).toFixed(0)}% — extreme blow-off`);
  } else if (price1h >= T.price1h_fomo) {
    score += 0.5;
    signals.push(`1h price +${(price1h * 100).toFixed(0)}% — late entry`);
  } else if (price1h >= T.price1h_caution) {
    score += 0.2;
    signals.push(`1h price +${(price1h * 100).toFixed(0)}% — momentum`);
  }

  // ── 4h price momentum ──
  if (price4h >= T.price4h_extreme) {
    score += 0.4;
    signals.push(`4h price +${(price4h * 100).toFixed(0)}% — extreme run`);
  } else if (price4h >= T.price4h_fomo) {
    score += 0.25;
    signals.push(`4h price +${(price4h * 100).toFixed(0)}% — extended`);
  }

  // ── Volume spike vs 7d avg ──
  if (volume7d > 0 && volume24h > volume7d * T.volume_spike_ratio) {
    score += 0.15;
    const ratio = volume24h / volume7d;
    signals.push(`volume spike ${ratio.toFixed(1)}× vs 7d avg`);
  }

  // ── Fake/wash volume — high turnover without liquidity proportionate ──
  if (liquidity > 0 && volume24h > liquidity * T.volume_per_liq_ratio) {
    score += 0.20;
    const ratio = volume24h / liquidity;
    signals.push(`volume ${ratio.toFixed(1)}× liquidity — possible wash`);
  }

  // ── Buy/sell ratio swing ──
  if (sells24h > 0) {
    const ratio = buys24h / sells24h;
    if (ratio >= T.buy_sell_ratio_fomo) {
      score += 0.20;
      signals.push(`buy/sell ratio ${ratio.toFixed(1)} — late retail FOMO`);
    } else if (ratio >= T.buy_sell_ratio_warn) {
      score += 0.10;
      signals.push(`buy/sell ratio ${ratio.toFixed(1)} — elevated`);
    }
  }

  score = Math.min(1, score);

  let verdict = "safe";
  if (score >= 0.7) verdict = "extreme";
  else if (score >= 0.45) verdict = "fomo";
  else if (score >= 0.2) verdict = "caution";

  const block = blockOnFomo && (verdict === "fomo" || verdict === "extreme");

  return {
    verdict,
    block,
    score: Number(score.toFixed(3)),
    signals,
    metrics: {
      price_change_1h: price1h,
      price_change_4h: price4h,
      price_change_24h: price24h,
      volume_24h_usd: volume24h,
      liquidity_usd: liquidity,
      buys_24h: buys24h,
      sells_24h: sells24h,
    },
  };
}
