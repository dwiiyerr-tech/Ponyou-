const DATAPI_BASE = "https://datapi.jup.ag/v1";

/**
 * Get the narrative/story behind a token from Jupiter ChainInsight.
 * Useful for understanding if a token has a real community/theme vs nothing.
 */
export async function getTokenNarrative({ mint }) {
  const res = await fetch(`${DATAPI_BASE}/chaininsight/narrative/${mint}`);
  if (!res.ok) throw new Error(`Narrative API error: ${res.status}`);
  const data = await res.json();
  return {
    mint,
    narrative: data.narrative || null,
    status: data.status,
  };
}

/**
 * Search for token data by name, symbol, or mint address.
 * Returns condensed token info.
 */
export async function getTokenInfo({ query }) {
  const url = `${DATAPI_BASE}/assets/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token search API error: ${res.status}`);
  const data = await res.json();
  const tokens = Array.isArray(data) ? data : [data];
  if (!tokens.length) return { found: false, query };

  const results = tokens.slice(0, 5).map((t) => ({
    mint: t.id,
    name: t.name,
    symbol: t.symbol,
    mcap: t.mcap,
    price: t.usdPrice,
    liquidity: t.liquidity,
    holders: t.holderCount,
    organic_score: t.organicScore,
    organic_label: t.organicScoreLabel,
    launchpad: t.launchpad,
    graduated: !!t.graduatedPool,
    global_fees_sol: t.fees != null ? parseFloat(t.fees.toFixed(2)) : null,
    audit: t.audit ? {
      mint_disabled: t.audit.mintAuthorityDisabled,
      freeze_disabled: t.audit.freezeAuthorityDisabled,
      top_holders_pct: t.audit.topHoldersPercentage?.toFixed(2),
      bot_holders_pct: t.audit.botHoldersPercentage?.toFixed(2),
    } : null,
  }));

  return { found: true, query, results };
}

/**
 * Get holder distribution for a token mint.
 * Fetches top 100 holders.
 */
export async function getTokenHolders({ mint, limit = 20 }) {
  const [holdersRes, tokenRes] = await Promise.all([
    fetch(`${DATAPI_BASE}/holders/${mint}?limit=100`),
    fetch(`${DATAPI_BASE}/assets/search?query=${mint}`),
  ]);
  if (!holdersRes.ok) throw new Error(`Holders API error: ${holdersRes.status}`);
  const data = await holdersRes.json();
  const tokenData = tokenRes.ok ? await tokenRes.json() : null;
  const tokenInfo = Array.isArray(tokenData) ? tokenData[0] : tokenData;
  const totalSupply = tokenInfo?.totalSupply || tokenInfo?.circSupply || null;

  const holders = Array.isArray(data) ? data : (data.holders || data.data || []);

  const mapped = holders.slice(0, Math.min(limit, 100)).map((h) => {
    const tags = (h.tags || []).map((t) => t.name || t.id || t);
    const isPool = tags.some((t) => /pool|amm|liquidity|raydium|orca|meteora/i.test(t));
    const pct = totalSupply ? (Number(h.amount) / totalSupply) * 100 : (h.percentage ?? h.pct ?? null);
    return {
      address: h.address || h.wallet,
      amount: h.amount,
      pct: pct != null ? parseFloat(pct.toFixed(4)) : null,
      sol_balance: h.solBalanceDisplay ?? h.solBalance,
      tags: tags.length ? tags : undefined,
      is_pool: isPool || undefined,
    };
  });

  return {
    mint,
    total_fetched: holders.length,
    showing: mapped.length,
    holders: mapped,
  };
}

