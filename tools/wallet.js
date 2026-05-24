import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

let _solPriceCache = { price: 0, ts: 0 };
const PRICE_TTL_MS = 30_000;

async function getSolPrice() {
  const now = Date.now();
  if (now - _solPriceCache.ts < PRICE_TTL_MS) return _solPriceCache.price;
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDC", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    _solPriceCache = { price: Number(data.price), ts: now };
    return _solPriceCache.price;
  } catch {
    return _solPriceCache.price; // stale is better than zero
  }
}

let _wallet = null;

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

function getRpcConnection() {
  return new Connection(
    process.env.HELIUS_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed"
  );
}

async function getWalletBalancesRpc(walletAddress) {
  const pk = new PublicKey(walletAddress);
  const conn = getRpcConnection();
  const solLamports = await conn.getBalance(pk);
  const sol = solLamports / 1e9;
  const sol_price = await getSolPrice();
  const sol_usd = Math.round(sol * sol_price * 100) / 100;
  return {
    wallet: walletAddress,
    sol: Math.round(sol * 1e6) / 1e6,
    sol_price,
    sol_usd,
    usdc: 0,
    tokens: [],
    total_usd: sol_usd,
  };
}

async function getWalletBalancesHelius(walletAddress) {
  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }
  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const balances = data.balances || [];
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");
    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));
    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

export async function getWalletBalances(walletAddress = null) {
  if (!walletAddress) {
    try {
      walletAddress = getWallet().publicKey.toString();
    } catch {
      return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
    }
  }

  if (process.env.HELIUS_WALLET_BALANCES === "true") {
    return getWalletBalancesHelius(walletAddress);
  }

  try {
    return await getWalletBalancesRpc(walletAddress);
  } catch (error) {
    log("wallet_error", `RPC balance failed for ${walletAddress.slice(0, 8)}: ${error.message}`);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

export function normalizeMint(mint) {
  if (!mint) return mint;
  if (mint === "SOL" || mint === "native" || mint === "wSOL" || mint === "WSOL") {
    return SOL_MINT;
  }
  return mint;
}
