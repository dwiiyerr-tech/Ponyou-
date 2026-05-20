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
    const landing = await jitoAwait({ bundleId, timeoutMs: attemptTimeoutMs });
    const landed = !!landing.landed;
    attempts.push({
      attempt_no: attemptNo,
      tip,
      priority_fee: priorityFee,
      sim_action: simAction,
      landed,
      elapsed_ms: Date.now() - attemptStarted,
    });
    if (landed) {
      const hash = landing.status?.transactions?.[0] || bundleId;
      const total_tip_lamports = attempts.reduce((s, a) => s + a.tip, 0);
      return {
        hash,
        attempts,
        total_tip_lamports,
        landing_time_ms: Date.now() - startedAt,
        simulate_history,
      };
    }
    prevTip = tip;
  }

  throw new MaxRetriesExceededError({ attempts, simulate_history });
}
