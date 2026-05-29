import bs58 from "bs58";

// Extract the first signature of a signed tx as a base58 string. Handles
// legacy Transaction ({signature} wrapper) and VersionedTransaction (raw
// Uint8Array). Returns null for unsigned / mock txs.
function extractSignature(tx) {
  try {
    const sig0 = Array.isArray(tx?.signatures) ? tx.signatures[0] : null;
    if (!sig0) return null;
    const raw = sig0.signature ?? sig0;
    if ((raw instanceof Uint8Array || Buffer.isBuffer(raw)) && raw.length > 0) {
      for (const b of raw) { if (b !== 0) return bs58.encode(raw); }
    }
  } catch {}
  return null;
}

export class MaxRetriesExceededError extends Error {
  constructor({ attempts, simulate_history }) {
    super(`max_retries_exceeded after ${attempts.length} attempt(s)`);
    this.attempts = attempts;
    this.simulate_history = simulate_history;
    this.name = "MaxRetriesExceededError";
  }
}

export async function submitWithAdaptiveRetry({
  builtTxFactory,
  wallet,
  rpcQuorum,
  feeOracle,
  simulator,
  jitoSubmit,
  jitoAwait,
  confirmSignatures = null,
  urgency = "urgent",
  maxAttempts = 5,
  attemptTimeoutMs = 3000,
  defaultCuLimit = 200_000,
  maxCuLimit = 1_400_000,
  maxTipLamports = 5_000_000,
  log = () => {},
}) {
  const attempts = [];
  const simulate_history = [];
  const submittedSigs = [];
  const startedAt = Date.now();
  let prevTip = null;
  let cuLimit = defaultCuLimit;

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    await feeOracle.refresh();
    const blockhashRes = await rpcQuorum.quorumCall("getLatestBlockhash");
    let tip = attemptNo === 1
      ? feeOracle.getTip(urgency)
      : Math.max(prevTip * 1.5, feeOracle.getTip("critical"));
    tip = Math.min(Math.floor(tip), maxTipLamports);
    const priorityFee = feeOracle.getPriorityFeeMicroLamports(95);

    const attemptStarted = Date.now();
    let simAction = null;
    let tx = null;
    let bh = blockhashRes.blockhash;
    while (true) {
      tx = builtTxFactory({ tip, priorityFee, cuLimit, blockhash: bh });
      if (typeof tx.sign === "function") tx.sign([wallet]);
      const sim = await simulator.simulatePreflight({ tx, rpcQuorum });
      simulate_history.push({ attempt_no: attemptNo, ...sim });
      simAction = sim.action;
      if (sim.action === "block") {
        throw new Error(`exec_edge_block: ${sim.reason}`);
      }
      if (sim.action === "bump_cu") {
        cuLimit = Math.min(Math.floor(cuLimit * 1.5), maxCuLimit);
        if (cuLimit >= maxCuLimit) {
          throw new Error("exec_edge_block: cu_cap_reached");
        }
        continue;
      }
      if (sim.action === "retry") {
        const fresh = await rpcQuorum.quorumCall("getLatestBlockhash");
        bh = fresh.blockhash;
        continue;
      }
      break;
    }

    const bundleId = await jitoSubmit({ tx, wallet, tip });
    const sig = extractSignature(tx);
    if (sig) submittedSigs.push(sig);
    const landing = await jitoAwait({ bundleId, timeoutMs: attemptTimeoutMs });
    let landed = !!landing.landed;
    let landedHash = landing.status?.transactions?.[0] || bundleId;
    let recovered = false;

    // Double-execution guard: a "not landed" verdict only means the bundle did
    // not confirm within attemptTimeoutMs — it may still land afterwards.
    // Before we build and submit a DIFFERENT tx on the next attempt (new
    // blockhash → new signature, which could ALSO land = double buy/sell),
    // confirm none of our prior submissions actually landed on-chain.
    if (!landed && typeof confirmSignatures === "function" && submittedSigs.length > 0) {
      const confirmedSig = await confirmSignatures(submittedSigs).catch(() => null);
      if (confirmedSig) {
        landed = true;
        landedHash = confirmedSig;
        recovered = true;
        log(`exec_edge: recovered late landing ${confirmedSig} — skipping retry to avoid double-execute`);
      }
    }

    attempts.push({
      attempt_no: attemptNo,
      tip,
      priority_fee: priorityFee,
      sim_action: simAction,
      landed,
      recovered,
      elapsed_ms: Date.now() - attemptStarted,
    });
    if (landed) {
      const total_tip_lamports = attempts.reduce((s, a) => s + a.tip, 0);
      return {
        hash: landedHash,
        attempts,
        total_tip_lamports,
        landing_time_ms: Date.now() - startedAt,
        simulate_history,
        recovered,
      };
    }
    prevTip = tip;
  }

  // Final safety net: a bundle from the last attempt may have landed after its
  // await verdict. Confirm before reporting failure, so the caller doesn't
  // re-run the whole swap on something that actually executed.
  if (typeof confirmSignatures === "function" && submittedSigs.length > 0) {
    const confirmedSig = await confirmSignatures(submittedSigs).catch(() => null);
    if (confirmedSig) {
      return {
        hash: confirmedSig,
        attempts,
        total_tip_lamports: attempts.reduce((s, a) => s + a.tip, 0),
        landing_time_ms: Date.now() - startedAt,
        simulate_history,
        recovered: true,
      };
    }
  }

  throw new MaxRetriesExceededError({ attempts, simulate_history });
}
