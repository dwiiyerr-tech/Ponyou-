let _rpcQuorum = null;
let _feeOracle = null;

export function setRpcQuorum(rq) { _rpcQuorum = rq; }
export function getRpcQuorum() { return _rpcQuorum; }
export function setFeeOracle(fo) { _feeOracle = fo; }
export function getFeeOracle() { return _feeOracle; }
export function shutdownSingletons() {
  try { _feeOracle?.stop(); } catch (_) {}
  try { _rpcQuorum?.shutdown(); } catch (_) {}
  _feeOracle = null;
  _rpcQuorum = null;
}
