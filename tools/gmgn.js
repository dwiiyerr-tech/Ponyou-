import { Connection, PublicKey, VersionedTransaction, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

const GMGN_BASE = "https://gmgn.ai";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Rotate User-Agents to avoid fingerprinting
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

let _uaIndex = 0;
function nextUA() {
  const ua = USER_AGENTS[_uaIndex % USER_AGENTS.length];
  _uaIndex++;
  return ua;
}

function browserHeaders(extra = {}) {
  return {
    "User-Agent": nextUA(),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://gmgn.ai/",
    "Origin": "https://gmgn.ai",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    ...extra,
  };
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1200 * attempt));
    }
    try {
      const res = await fetch(url, {
        ...options,
        headers: browserHeaders(options.headers || {}),
      });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      if (res.status === 403 || res.status === 503) {
        lastError = new Error(`GMGN blocked (${res.status}) on attempt ${attempt + 1}`);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError || new Error("fetchWithRetry exhausted");
}

function getWallet() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
}

function getRouteKey() {
  return process.env.GMGN_ROUTE_KEY || "";
}

/**
 * Get the current Solana gas fee (priority fee) from Helius or RPC.
 */
export async function getSolanaGasFee() {
  try {
    const connection = new Connection(process.env.RPC_URL, "confirmed");
    const fees = await connection.getRecentPrioritizationFees();
    if (!fees.length) return { avg: 0, median: 0, level: "low" };

    const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;

    let level = "low";
    if (median > 500000) level = "extreme";
    else if (median > 100000) level = "high";
    else if (median > 10000) level = "medium";

    return { avg, median, level, unit: "micro-lamports" };
  } catch (error) {
    log("gas_error", error.message);
    return { error: error.message, avg: 0, median: 0, level: "unknown" };
  }
}

/**
 * Discover trending/new tokens from GMGN with fallback strategy.
 * Filters: renounced, verified, not_honeypot, frozen_auth_disabled.
 */
export async function discoverTokens({
  timeframe = "1m",
  orderby = "swaps",
  limit = 20
} = {}) {
  // Try multiple endpoints in order
  const endpoints = [
    `${GMGN_BASE}/defi/quotation/v1/rank/sol/swaps/${timeframe}?orderby=${orderby}&direction=desc&filters[]=renounced&filters[]=verified&filters[]=not_honeypot&filters[]=frozen_auth_disabled`,
    `${GMGN_BASE}/defi/quotation/v1/rank/sol/swaps/${timeframe}?orderby=${orderby}&direction=desc`,
    `${GMGN_BASE}/api/v1/rank/sol/swaps/${timeframe}?orderby=${orderby}&direction=desc`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetchWithRetry(url, {}, 3);
      if (!res.ok) {
        log("discovery_warn", `GMGN endpoint ${url.slice(0, 60)} returned ${res.status}`);
        continue;
      }
      const data = await res.json();
      const rank = data.data?.rank || data.rank || [];
      if (!rank.length) continue;

      const tokens = rank.slice(0, limit).map(t => ({
        mint: t.address,
        symbol: t.symbol,
        name: t.name,
        price: t.price,
        mcap: t.market_cap,
        liquidity: t.liquidity,
        volume: t.volume,
        swaps: t.swaps,
        hot_level: t.hot_level,
        logo: t.logo,
        created_at: t.open_time,
        initial_mcap: t.base_market_cap,
        burn_ratio: t.burn_ratio,
        renounced: t.renounced,
        is_honeypot: t.is_honeypot,
        launchpad: t.launchpad,
        creator: t.creator,
        buys: t.buys,
        sells: t.sells,
        buy_vol: t.buy_vol,
        sell_vol: t.sell_vol,
        price_change_5m: t.price_change_5m,
        price_change_1h: t.price_change_1h,
      }));

      return { tokens, endpoint_used: url.slice(0, 60) };
    } catch (err) {
      log("discovery_error", `Endpoint failed: ${err.message}`);
    }
  }

  log("discovery_error", "All GMGN endpoints failed");
  return { error: "All discovery endpoints failed", tokens: [] };
}

/**
 * Get Smart Money ranking from GMGN.
 * timeframe: 1h, 24h, 7d
 */
export async function getSmartMoneyRank({ timeframe = "24h" } = {}) {
  try {
    const url = `${GMGN_BASE}/defi/quotation/v1/rank/sol/smart_money/${timeframe}`;
    const res = await fetchWithRetry(url, {}, 2);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rank = data.data?.rank || [];
    return {
      timeframe,
      wallets: rank.map(w => ({
        address: w.address,
        alias: w.twitter_username || w.name,
        pnl_7d: w.pnl_7d,
        pnl_30d: w.pnl_30d,
        win_rate: w.win_rate,
        buy_30d: w.buy_30d,
        sell_30d: w.sell_30d,
        tags: w.tags || [],
      })),
    };
  } catch (error) {
    log("smart_money_error", error.message);
    return { error: error.message };
  }
}

/**
 * Get tokens with most smart money inflow.
 */
export async function getSmartMoneyInflow({ timeframe = "1h" } = {}) {
  try {
    const url = `${GMGN_BASE}/defi/quotation/v1/rank/sol/swaps/${timeframe}?orderby=smart_money_inflow&direction=desc`;
    const res = await fetchWithRetry(url, {}, 2);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rank = data.data?.rank || [];
    return {
      timeframe,
      tokens: rank.map(t => ({
        mint: t.address,
        symbol: t.symbol,
        mcap: t.market_cap,
        smart_money_inflow: t.smart_money_inflow,
        smart_money_buy_vol: t.smart_money_buy_vol,
        smart_money_sell_vol: t.smart_money_sell_vol,
      })),
    };
  } catch (error) {
    log("smart_money_inflow_error", error.message);
    return { error: error.message };
  }
}

/**
 * Get the current trending narratives/hype from GMGN.
 */
export async function getTrendingNarratives() {
  try {
    // Narratives are often represented by tags/categories in GMGN
    const url = `${GMGN_BASE}/defi/quotation/v1/rank/sol/tags`;
    const res = await fetchWithRetry(url, {}, 2);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      narratives: data.data?.tags || [],
    };
  } catch (error) {
    log("narrative_error", error.message);
    return { error: error.message };
  }
}

/**
 * Get token security and holder info from GMGN.
 * Enhanced with rug signal fields.
 */
export async function getTokenSecurityDetails({ mint }) {
  try {
    const [securityRes, holdersRes] = await Promise.allSettled([
      fetchWithRetry(`${GMGN_BASE}/defi/quotation/v1/tokens/security/sol/${mint}`, {}, 2),
      fetchWithRetry(`${GMGN_BASE}/defi/quotation/v1/tokens/top_holders/sol/${mint}`, {}, 2),
    ]);

    const securityData = securityRes.status === "fulfilled" && securityRes.value.ok
      ? await securityRes.value.json()
      : null;

    const holdersData = holdersRes.status === "fulfilled" && holdersRes.value.ok
      ? await holdersRes.value.json()
      : null;

    const sec = securityData?.data || {};
    const holders = (holdersData?.data || []).map(h => ({
      address: h.address,
      pct: h.amount_percentage,
      is_contract: h.is_contract,
      is_tag: h.is_tag,
      tag: h.tag,
      sol_balance: h.sol_balance,
      funded_at: h.funded_at,
      funded_from: h.funded_from,
      token_amount: h.token_amount,
    }));

    // Compute aggregate rug signals
    const top10Pct = holders.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);
    const freshHolders = holders.filter(h => {
      if (!h.funded_at) return false;
      return (Date.now() / 1000 - h.funded_at) / 3600 < 24;
    });
    const dustHolders = holders.filter(h => !h.is_contract && (h.sol_balance || 0) < 0.2);

    return {
      mint,
      security: sec,
      holders,
      rug_signals: {
        top10_concentration_pct: parseFloat(top10Pct.toFixed(2)),
        fresh_funded_holders: freshHolders.length,
        dust_holders: dustHolders.length,
        is_renounced: sec.renounced ?? null,
        is_honeypot: sec.is_honeypot ?? null,
        freeze_authority: sec.freeze_authority ?? null,
        mint_authority: sec.mint_authority ?? null,
        creator_pct: sec.creator_percentage ?? null,
      },
    };
  } catch (error) {
    log("security_error", error.message);
    return { mint, error: error.message, security: {}, holders: [], rug_signals: {} };
  }
}

/**
 * Get OHLCV (candle) data from GMGN.
 * resolution: 1m, 5m, 15m, 30m, 1h, 4h, 1d
 */
export async function getTokenKlines({ mint, resolution = "1m", limit = 100 }) {
  try {
    // GMGN resolution mapping
    const resMap = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };
    const resValue = resMap[resolution] || 60;
    
    // Multiple endpoint attempts
    const urls = [
      `${GMGN_BASE}/defi/quotation/v1/tokens/kline/sol/${mint}?resolution=${resolution}&limit=${limit}`,
      `${GMGN_BASE}/api/v1/token_kline/sol/${mint}?resolution=${resolution}&limit=${limit}`,
    ];

    for (const url of urls) {
      try {
        const res = await fetchWithRetry(url, {}, 2);
        if (!res.ok) continue;
        const data = await res.json();
        const list = data.data?.list || data.list || [];
        if (!list.length) continue;

        return {
          mint,
          resolution,
          candles: list.map(c => ({
            time: c.time || c.t,
            open: parseFloat(c.open || c.o),
            high: parseFloat(c.high || c.h),
            low: parseFloat(c.low || c.l),
            close: parseFloat(c.close || c.c),
            volume: parseFloat(c.volume || c.v),
          })).sort((a, b) => a.time - b.time),
        };
      } catch (e) {
        log("kline_warn", `Kline endpoint ${url} failed: ${e.message}`);
      }
    }
    throw new Error("All kline endpoints failed");
  } catch (error) {
    log("kline_error", error.message);
    return { mint, error: error.message, candles: [] };
  }
}

/**
 * Get extended token info (price, volume, holders count) from GMGN.
 */
export async function getTokenMarketInfo({ mint }) {
  try {
    const url = `${GMGN_BASE}/defi/quotation/v1/tokens/sol/${mint}`;
    const res = await fetchWithRetry(url, {}, 2);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const t = data.data || {};
    return {
      mint,
      price: t.price,
      mcap: t.market_cap,
      volume_24h: t.volume,
      liquidity: t.liquidity,
      holders: t.holder,
      swaps_24h: t.swaps,
      fdv: t.fdv,
      price_change_5m: t.price_change_5m,
      price_change_1h: t.price_change_1h,
      price_change_24h: t.price_change_24h,
      launchpad: t.launchpad,
    };
  } catch (error) {
    log("token_info_error", error.message);
    return { mint, error: error.message };
  }
}

/**
 * Swap tokens via GMGN Swap API.
 * Enhanced: validates route before signing, better error messages.
 */
export async function swapToken({
  token_in,
  token_out,
  amount,
  slippage = 0.5,
}) {
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { token_in, token_out, amount, slippage },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    const wallet = getWallet();
    const routeKey = getRouteKey();
    if (!routeKey) throw new Error("GMGN_ROUTE_KEY (x-route-key) not set in .env");

    const connection = new Connection(process.env.RPC_URL, "confirmed");
    let decimals = 9;
    const isSolIn = token_in === "SOL" || token_in === SOL_MINT;

    if (!isSolIn) {
      try {
        const mintInfo = await connection.getParsedAccountInfo(new PublicKey(token_in));
        decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
      } catch { decimals = 9; }
    }

    const tokenInAddr = isSolIn ? SOL_MINT : token_in;
    const tokenOutAddr = (token_out === "SOL" || token_out === SOL_MINT) ? SOL_MINT : token_out;
    const inAmount = Math.floor(amount * Math.pow(10, decimals)).toString();

    const search = new URLSearchParams({
      token_in_address: tokenInAddr,
      token_out_address: tokenOutAddr,
      in_amount: inAmount,
      from_address: wallet.publicKey.toString(),
      slippage: slippage.toString(),
    });

    const routeUrl = `${GMGN_BASE}/defi/router/v1/sol/tx/get_swap_route?${search.toString()}`;
    const routeRes = await fetchWithRetry(routeUrl, {
      headers: { "x-route-key": routeKey },
    }, 2);

    if (!routeRes.ok) {
      const body = await routeRes.text();
      throw new Error(`GMGN Route error: ${routeRes.status} ${body}`);
    }

    const routeData = await routeRes.json();
    if (routeData.code !== 0) throw new Error(`GMGN Route failed: ${routeData.msg}`);

    const { raw_tx } = routeData.data;
    if (!raw_tx?.swap_transaction) throw new Error("No swap_transaction in route response");

    const tx = VersionedTransaction.deserialize(Buffer.from(raw_tx.swap_transaction, "base64"));
    tx.sign([wallet]);

    const txproxyUrl = `${GMGN_BASE}/txproxy/v1/send_transaction`;
    const sendRes = await fetchWithRetry(txproxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-route-key": routeKey,
      },
      body: JSON.stringify({
        signed_tx: Buffer.from(tx.serialize()).toString("base64"),
      }),
    }, 2);

    if (!sendRes.ok) {
      const body = await sendRes.text();
      throw new Error(`GMGN Send error: ${sendRes.status} ${body}`);
    }

    const sendData = await sendRes.json();
    if (sendData.code !== 0) throw new Error(`GMGN Send failed: ${sendData.msg}`);

    const hash = sendData.data?.hash || sendData.data?.tx;
    log("swap", `Transaction sent: ${hash}`);

    return {
      success: true,
      hash,
      token_in: tokenInAddr,
      token_out: tokenOutAddr,
      amount,
      slippage,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
