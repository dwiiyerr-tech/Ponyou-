import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "./logger.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function getConnection() {
  return new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
}

function createCloseAccountInstruction(account, destination, owner) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

function decodeKey(key) {
  if (!key) return null;
  return Keypair.fromSecretKey(bs58.decode(key));
}

function getMasterWallet() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) throw new Error("WALLET_PRIVATE_KEY not set");
  return decodeKey(key);
}

function getFeePayerWallet() {
  const feePayerKey = process.env.RENT_FEE_PAYER_PRIVATE_KEY || process.env.FEE_PAYER_PRIVATE_KEY;
  return feePayerKey ? decodeKey(feePayerKey) : null;
}

export async function scanRefundableTokenAccounts({ owner = null } = {}) {
  const wallet = owner || getMasterWallet().publicKey.toString();
  const conn = getConnection();
  const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), { programId: TOKEN_PROGRAM_ID });
  const refundable = [];

  for (const item of res.value || []) {
    const parsed = item.account?.data?.parsed?.info;
    const amount = Number(parsed?.tokenAmount?.uiAmount || 0);
    if (amount === 0) {
      refundable.push({
        token_account: item.pubkey.toString(),
        mint: parsed?.mint || null,
        owner: parsed?.owner || wallet,
      });
    }
  }

  return {
    owner: wallet,
    refundable_accounts: refundable,
    refundable_count: refundable.length,
    estimated_refund_sol: Number((refundable.length * 0.00203928).toFixed(6)),
  };
}

export async function closeRefundableTokenAccounts({ owner = null, limit = 10 } = {}) {
  const master = getMasterWallet();
  const ownerAddress = owner || master.publicKey.toString();
  const scan = await scanRefundableTokenAccounts({ owner: ownerAddress });
  const targets = scan.refundable_accounts.slice(0, limit);
  if (targets.length === 0) return { success: true, closed: 0, owner: ownerAddress, estimated_refund_sol: 0 };

  if (process.env.DRY_RUN === "true") {
    return {
      success: true,
      dry_run: true,
      owner: ownerAddress,
      closed: targets.length,
      estimated_refund_sol: Number((targets.length * 0.00203928).toFixed(6)),
      accounts: targets,
    };
  }

  const conn = getConnection();
  const feePayer = getFeePayerWallet() || master;
  const ownerKeypair = master.publicKey.toString() === ownerAddress ? master : null;
  if (!ownerKeypair) {
    return { success: false, error: "Owner override must match current master wallet until delegated closing is supported" };
  }

  try {
    const tx = new Transaction();
    for (const account of targets) {
      tx.add(createCloseAccountInstruction(
        new PublicKey(account.token_account),
        feePayer.publicKey,
        ownerKeypair.publicKey,
      ));
    }
    tx.feePayer = feePayer.publicKey;
    const sig = await sendAndConfirmTransaction(conn, tx, feePayer === ownerKeypair ? [ownerKeypair] : [feePayer, ownerKeypair]);
    const estimatedRefundSol = Number((targets.length * 0.00203928).toFixed(6));
    log("rent_refund", `Closed ${targets.length} empty token accounts for ${ownerAddress.slice(0, 8)}…`);
    return {
      success: true,
      owner: ownerAddress,
      closed: targets.length,
      estimated_refund_sol: estimatedRefundSol,
      fee_payer: feePayer.publicKey.toString(),
      tx: sig,
    };
  } catch (error) {
    log("rent_refund_error", error.message);
    return { success: false, error: error.message, owner: ownerAddress, attempted: targets.length };
  }
}
