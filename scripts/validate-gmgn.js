#!/usr/bin/env node
/**
 * validate-gmgn — read-only validation harness for the GMGN adapter's UNVERIFIED
 * unit assumptions before GMGN_API_KEY is trusted in live.
 *
 * Why this exists: tools/gmgn.js `normalizeWallet` passes win_rate and realized
 * PnL straight through Number() WITHOUT normalizing units. If GMGN returns
 * win_rate as a 0–100 percentage (while downstream wallet scoring assumes a
 * 0–1 fraction), or PnL in USD (while assumed SOL), smart-money ranking is
 * silently wrong. This script hits the real API read-only, dumps raw fields,
 * and judges the units so the assumption is verified — not guessed.
 *
 * It NEVER writes state, never trades, never touches live stores. Pure GET +
 * one read-only POST (token_top_holders) when --mint is supplied.
 *
 * Usage:
 *   GMGN_API_KEY=your_key node scripts/validate-gmgn.js
 *   GMGN_API_KEY=your_key node scripts/validate-gmgn.js --mint <token_mint>
 *
 * Exit 0 = ran and printed a verdict; exit 1 = key missing or API unreachable.
 */

import crypto from "crypto";
import { getSmartMoneyWallets, getWalletStats, normalizeTopHolder, isGmgnEnabled } from "../tools/gmgn.js";

const BASE = "https://openapi.gmgn.ai";
const CHAIN = "sol";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

// Mirror tools/gmgn.js auth exactly (X-APIKEY header + timestamp + client_id).
async function rawFetch(method, path, query = {}, body = null) {
  const params = new URLSearchParams({
    chain: CHAIN,
    ...query,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: crypto.randomUUID(),
  });
  const url = `${BASE}${path}?${params}`;
  const opts = {
    method,
    headers: { "X-APIKEY": process.env.GMGN_API_KEY, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const json = await res.json();
  return json?.data ?? json;
}

function asArray(raw) {
  if (Array.isArray(raw)) return raw;
  for (const k of ["list", "rank", "tokens", "wallets", "holders"]) {
    if (Array.isArray(raw?.[k])) return raw[k];
  }
  // wallet_stats returns a single bare object — wrap it so the harness can read it.
  if (raw && typeof raw === "object") return [raw];
  return [];
}

// ── Unit judges ───────────────────────────────────────────────────────────────

function judgeWinRate(values) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n) && n !== 0);
  if (!nums.length) return { verdict: "NO DATA", detail: "no non-zero win_rate values" };
  const max = Math.max(...nums);
  if (max <= 1.0001) {
    return { verdict: "FRACTION (0–1)", detail: `max=${max.toFixed(4)} ≤ 1 → adapter passthrough is correct IF downstream expects 0–1` };
  }
  return {
    verdict: "PERCENT (0–100)",
    detail: `max=${max.toFixed(2)} > 1 → MISMATCH if downstream assumes 0–1. normalizeWallet must divide by 100.`,
  };
}

function judgePnl(values, label) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return { verdict: "NO DATA", detail: `no ${label} values` };
  const sorted = [...nums].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = Math.max(...nums.map(Math.abs));
  // Heuristic only — human confirms. Top smart-money PnL in SOL is typically
  // 10s–1000s; the same in USD is 1000s–millions. A huge magnitude strongly
  // suggests USD (unscaled), which downstream-SOL assumptions would misread.
  const likely = max > 50_000 ? "likely USD (large magnitude)"
    : max < 5_000 ? "plausibly SOL"
    : "AMBIGUOUS — confirm against the wallet on gmgn.ai";
  return { verdict: likely, detail: `${label}: median=${median}, |max|=${max}` };
}

function dumpRow(row, title) {
  console.log(`\n── ${title}: raw fields of first row ──`);
  for (const [k, v] of Object.entries(row)) {
    const val = typeof v === "object" ? JSON.stringify(v) : v;
    console.log(`   ${k.padEnd(22)} = ${String(val).slice(0, 60)}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!isGmgnEnabled()) {
    console.error("✗ GMGN_API_KEY not set (or too short / 'dummy-gmgn-key').");
    console.error("  Run:  GMGN_API_KEY=your_key node scripts/validate-gmgn.js");
    process.exit(1);
  }
  console.log("GMGN adapter validation — READ ONLY. No state is written.\n");

  // 1. smartmoney is an ACTIVITY FEED (rows = trades w/ `maker`), not a wallet
  //    list. Confirm the adapter aggregates it into distinct wallets.
  let smRaw;
  try {
    smRaw = asArray(await rawFetch("GET", "/v1/user/smartmoney", { limit: 20 }));
  } catch (e) {
    console.error(`✗ /v1/user/smartmoney failed: ${e.message}`);
    process.exit(1);
  }
  console.log(`/v1/user/smartmoney → ${smRaw.length} feed rows`);
  let firstMaker = null;
  if (smRaw.length) {
    dumpRow(smRaw[0], "smartmoney (feed row)");
    firstMaker = smRaw[0].maker || smRaw[0].wallet_address || null;

    const wallets = (await getSmartMoneyWallets(20)) || [];
    console.log(`\n  adapter getSmartMoneyWallets() → ${wallets.length} distinct wallets`);
    if (wallets[0]) {
      const w = wallets[0];
      console.log(`    sample: addr=${w.address.slice(0, 8)}… activity=${w.activityCount} tags=${JSON.stringify(w.tags)} winRate=${w.winRate}`);
      if (!w.address) console.log("    ⚠ address empty → feed maker field mismatch in aggregateFeedWallets");
      if (w.winRate !== null) console.log("    ⚠ winRate should be null from a feed (enrich via wallet_stats)");
    } else {
      console.log("    ⚠ 0 wallets aggregated — feed maker field may have changed");
    }
  }

  // 2. wallet_stats is where win_rate + PnL actually live. This is the real
  //    unit-verification path (win_rate must be 0–1; PnL is USD).
  if (firstMaker) {
    let wsRaw;
    try {
      wsRaw = asArray(await rawFetch("GET", "/v1/user/wallet_stats", { wallet_address: [firstMaker], period: "30d" }));
    } catch (e) {
      console.error(`✗ /v1/user/wallet_stats failed: ${e.message}`);
      wsRaw = [];
    }
    if (wsRaw[0]) {
      dumpRow(wsRaw[0], "wallet_stats");
      const winVals = wsRaw.map((r) => r.pnl_stat?.winrate ?? r.win_rate ?? r.winrate).filter((v) => v != null);
      const pnlVals = wsRaw.map((r) => r.realized_profit ?? r.total_profit).filter((v) => v != null);
      const win = judgeWinRate(winVals);
      console.log(`\n  win_rate (pnl_stat.winrate) → ${win.verdict}`);
      console.log(`              ${win.detail}`);
      const pnl = judgePnl(pnlVals, "realized_profit");
      console.log(`  realized_profit            → ${pnl.verdict} (expect USD; native_balance is the SOL field)`);
      console.log(`              ${pnl.detail}`);

      const norm = (await getWalletStats(firstMaker, "30d")) || [];
      const n = norm[0];
      if (n) {
        console.log(`\n  adapter getWalletStats() → winRate=${n.winRate} realizedPnlUsd=${n.realizedPnlUsd} trades=${n.tradeCount} solBal=${n.nativeBalanceSol}`);
        if (n.winRate === 0 && winVals.length) console.log("    ⚠ winRate parsed 0 but raw had values → check pnl_stat.winrate path");
        if (!n.tradeCount && (wsRaw[0].buy || wsRaw[0].sell)) console.log("    ⚠ tradeCount 0 but buy/sell present → check buy+sell");
      }
    }
  }

  // 3. Optional: top-holder tags for a specific mint (rug-signal path).
  const mint = arg("--mint");
  if (mint) {
    try {
      const raw = asArray(await rawFetch("GET", "/v1/market/token_top_holders", { address: mint, limit: 10 }));
      console.log(`\n/v1/market/token_top_holders(${mint.slice(0, 8)}…) → ${raw.length} rows`);
      if (raw[0]) {
        dumpRow(raw[0], "top_holders");
        const t = normalizeTopHolder(raw[0]);
        console.log(`\n  normalizeTopHolder sample: pct=${t.pct} tags=${JSON.stringify(t.tags)}`);
        if (!t.address) console.log("  ⚠ address empty → field-name mismatch in normalizeTopHolder");
        const anyTag = Object.values(t.tags).some(Boolean);
        if (!anyTag) console.log("  ⚠ all tags false on row 0 — confirm GMGN tag strings (tags/maker_token_tags/wallet_tag_v2)");
        if (t.pct === 0) console.log("  ⚠ pct 0 on row 0 — confirm amount_percentage field is present");
      }
    } catch (e) {
      console.error(`✗ token_top_holders failed: ${e.message}`);
    }
  } else {
    console.log("\n(skip top-holder check — pass --mint <token_mint> to validate rug-tag fields)");
  }

  console.log("\n── VERDICT ──");
  console.log("Expect: smartmoney/kol = activity feeds → adapter aggregates to wallets (winRate null).");
  console.log("Expect: wallet_stats.pnl_stat.winrate is 0–1; realized_profit is USD; trades=buy+sell.");
  console.log("Expect: top_holders pct from amount_percentage (0–1 → 0–100); tags from string fields.");
  console.log("Wallet-score consumers: wallet-discovery.js, wallet-copy-trade.js, rug-signals.js.");
}

main().catch((e) => {
  console.error("✗ validation crashed:", e.message);
  process.exit(1);
});
