export async function captureEntryMetadata(mint, fetchers) {
  const errors = [];
  let mintInfo = null;
  let poolInfo = null;
  let topHolders = [];

  try { mintInfo = await fetchers.getMintInfo(mint); }
  catch (e) { errors.push("mint_info_failed"); }

  try { poolInfo = await fetchers.getPoolInfo(mint); }
  catch (e) { errors.push("pool_info_failed"); }

  try { topHolders = await fetchers.getTopHolders(mint); }
  catch (e) { errors.push("top_holders_failed"); }

  return {
    mint,
    deployer_wallet: mintInfo?.creator ?? null,
    lp_address: poolInfo?.pool_address ?? null,
    lp_usd_at_entry: poolInfo?.lp_usd ?? null,
    top_holders_snapshot: Array.isArray(topHolders) ? topHolders : [],
    authorities: {
      mint_authority: mintInfo?.mint_authority ?? null,
      freeze_authority: mintInfo?.freeze_authority ?? null,
    },
    partial: errors.length > 0,
    errors,
    entry_ts: Date.now(),
  };
}
