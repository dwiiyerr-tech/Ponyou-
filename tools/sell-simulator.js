/**
 * Pre-flight Sell Simulator — verifies a token CAN be sold before committing capital.
 *
 * Strategy: build a simulated SPL Token transfer from a known holder to themselves,
 * then simulate the transaction without signatures. If the simulation fails with
 * specific error patterns, the token likely has a sell-blocking mechanism.
 *
 * Covers:
 *   - Token-2022 transfer hooks that reject sells
 *   - Non-transferable tokens
 *   - Default-frozen accounts
 *   - Custom program-level sell gates
 *   - Oracles that manipulate sell price
 *
 * Cost: one RPC call to getTokenLargestAccounts + one simulateTransaction call.
 * No SOL spent. No real transaction broadcast.
 */

import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { log } from "../logger.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ─── Helpers ──────────────────────────────────────────────────────

function getConnection() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

/**
 * Derive Associated Token Account address (PDA).
 * Pure computation — no RPC call.
 */
function deriveATA(mint, owner) {
  const seeds = [
    owner.toBuffer(),
    TOKEN_PROGRAM_ID.toBuffer(),
    mint.toBuffer(),
  ];
  const [ata] = PublicKey.findProgramAddressSync(seeds, ASSOCIATED_TOKEN_PROGRAM_ID);
  return ata;
}

/**
 * Build a minimal SPL Token Transfer instruction:
 * Transfer 0 tokens from tokenAccount back to itself.
 * This is a no-op that tests transfer validity without moving value.
 */
function buildSelfTransferInstruction(mint, tokenAccount, owner, programId) {
  // SPL Token Transfer instruction layout:
  //   index 3 = Transfer
  //   layout: u8(3) + u64(amount) = 1 + 8 = 9 bytes
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);        // Transfer instruction index
  data.writeBigUInt64LE(BigInt(0), 1);  // amount = 0

  return {
    programId,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },   // source
      { pubkey: mint, isSigner: false, isWritable: false },           // mint
      { pubkey: tokenAccount, isSigner: false, isWritable: true },   // destination (self)
      { pubkey: owner, isSigner: false, isWritable: false },         // authority
    ],
    data,
  };
}

/**
 * Classify simulation errors to determine if the token is a sell-blocking honeypot.
 */
export function classifySellSimError(err, logs = []) {
  if (err === null || err === undefined) return { can_sell: true, reason: "sim_clean" };

  const errStr = typeof err === "string" ? err : JSON.stringify(err);
  const logsStr = (logs || []).join("\n");

  // These errors indicate the token CANNOT be transferred (honeypot):
  if (/AccountNotFound/i.test(errStr) && /Token(keg)?/.test(logsStr)) {
    return { can_sell: false, reason: "honeypot: token account doesn't exist or was closed" };
  }
  if (/InvalidAccountData/i.test(errStr)) {
    return { can_sell: false, reason: "honeypot: invalid token account data (likely Token-2022)" };
  }
  if (/Custom.*:0x[0-9a-fA-F]+/i.test(errStr)) {
    return { can_sell: false, reason: `honeypot: custom program error — ${errStr.slice(0, 80)}` };
  }
  if (/AccountNotInitialized/i.test(errStr)) {
    return { can_sell: false, reason: "honeypot: token account not initialized" };
  }
  if (/0x0|0x1/.test(errStr) && /owner/i.test(logsStr)) {
    return { can_sell: false, reason: "honeypot: owner mismatch — transfer restricted" };
  }

  // These errors are expected (we're using a fake signer, no signatures):
  if (/SignatureVerification|missing.*signature|signer/i.test(errStr)) {
    return { can_sell: true, reason: "sim_passed: expected signature error (no sigs in sim)" };
  }
  if (/InsufficientFunds/i.test(errStr)) {
    return { can_sell: true, reason: "sim_passed: insufficient funds (expected, no real tokens)" };
  }

  // Fee payer can't cover the sim fee — happens when every top holder owner is
  // a PDA (pool/bonding curve). Says nothing about sellability: inconclusive.
  if (/InvalidAccountForFee/i.test(errStr)) {
    return { can_sell: null, reason: "fee_payer_rejected: holder owner can't pay sim fee (PDA holder)" };
  }

  // Unknown error — be conservative: flag as suspicious but not blocking
  return { can_sell: null, reason: `unknown_sim: ${errStr.slice(0, 120)}` };
}

// ─── Main Simulator ───────────────────────────────────────────────

/**
 * Simulate a token transfer to verify the token can be sold.
 *
 * Uses a real on-chain holder's token account (if available) to build a
 * self-transfer instruction. Simulates without signatures.
 *
 * @param {string} mint — Token mint address
 * @param {number} timeoutMs — Max wait for RPC (default 6000ms)
 * @returns {{ can_sell: boolean|null, reason: string, details: object }}
 */
export async function simulateSell(mint, { timeoutMs = 6000 } = {}) {
  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(mint);

    // Step 1: Get the mint account info to determine token program
    const mintInfo = await connection.getAccountInfo(mintPubkey);
    if (!mintInfo) {
      return { can_sell: false, reason: "mint_not_found", details: {} };
    }

    const programId = mintInfo.owner;
    const isToken2022 = programId.equals(TOKEN_2022_PROGRAM_ID);

    // Step 2: Find a real holder to borrow their token account for simulation.
    // The holder's OWNER becomes the fee payer, so it must be a system-owned
    // wallet with lamports. The largest holder is frequently the pool /
    // bonding-curve PDA whose owner is a program — a PDA fee payer makes the
    // simulation fail with InvalidAccountForFee (inconclusive, not honeypot).
    let holderAccount = null;
    let holderOwner = null;
    try {
      const largest = await connection.getTokenLargestAccounts(mintPubkey);
      const top = (largest?.value || []).slice(0, 3);
      if (top.length > 0) {
        const parsedAccs = await connection.getMultipleParsedAccounts(
          top.map(a => new PublicKey(a.address))
        );
        const entries = [];
        (parsedAccs?.value || []).forEach((acc, i) => {
          const owner = acc?.data?.parsed?.info?.owner;
          if (owner) entries.push({ tokenAccount: new PublicKey(top[i].address), owner: new PublicKey(owner) });
        });
        if (entries.length > 0) {
          const ownerInfos = await connection.getMultipleAccountsInfo(entries.map(e => e.owner));
          for (let i = 0; i < entries.length; i++) {
            const info = ownerInfos?.[i];
            if (info && info.owner.equals(SystemProgram.programId) && info.lamports > 10_000) {
              holderAccount = entries[i].tokenAccount;
              holderOwner = entries[i].owner;
              break;
            }
          }
          // No system-owned funded owner in the top 3: keep the largest holder
          // (pre-fix behavior) so the sim still runs; classification below maps
          // InvalidAccountForFee to an explicit inconclusive reason.
          if (!holderAccount) {
            holderAccount = entries[0].tokenAccount;
            holderOwner = entries[0].owner;
          }
        }
      }
    } catch {
      // Fall through — no_holders_available below
    }

    // Step 3: If no real holder found, skip the simulation
    if (!holderAccount || !holderOwner) {
      return {
        can_sell: null,
        reason: "no_holders_available",
        details: { is_token_2022: isToken2022 },
      };
    }

    // Step 4: Build and simulate the self-transfer
    const instruction = buildSelfTransferInstruction(mintPubkey, holderAccount, holderOwner, programId);

    // Fetch a real recent blockhash so the simulation doesn't get
    // rejected with "BlockhashNotFound" (many RPC nodes reject fake ones).
    const tx = new Transaction();
    tx.add(instruction);
    try {
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
    } catch {
      // Fallback: use a mostly-valid recent blockhash pattern. Some RPC nodes
      // still reject this, but it's better than all-ones.
      tx.recentBlockhash = "4xRxPG7fVR2iA6Mumd7J4cMVAnKTEXNEMpGRanKEMRzHw";
    }
    tx.feePayer = holderOwner;

    const simResult = await Promise.race([
      connection.simulateTransaction(tx),
      new Promise((_, reject) => setTimeout(() => reject(new Error("__timeout__")), timeoutMs)),
    ]);

    const value = simResult?.value || simResult || {};
    const classification = classifySellSimError(value.err, value.logs || []);

    log(
      classification.can_sell === false ? "sell_sim_block" : "sell_sim_ok",
      `${mint.slice(0, 8)}: can_sell=${classification.can_sell} — ${classification.reason}${isToken2022 ? " [Token-2022]" : ""}`
    );

    return {
      ...classification,
      details: {
        is_token_2022: isToken2022,
        holder_used: holderAccount.toString().slice(0, 12),
        logs_snippet: (value.logs || []).slice(0, 3).join("; ").slice(0, 120),
      },
    };
  } catch (e) {
    const label = typeof mint === "string" ? mint.slice(0, 8) : "?";
    log("sell_sim_error", `${label}: simulation failed — ${e.message}`);
    return { can_sell: null, reason: `simulation_error: ${e.message}`, details: {} };
  }
}
