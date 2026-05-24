import fs from "fs";
import path from "path";

// In-process mutex per absolute file path. Serializes RMW (read-mutate-write)
// sequences on shared JSON state files so concurrent async callers cannot
// interleave: load -> mutate -> atomicWriteJson. Crash-consistency is already
// handled by tmp+rename; this only closes the same-process interleave gap.
//
// External-process writers (other PIDs) are out of scope — verified that the
// production deploy uses a single Node process (ops/run-24x7.sh launches one
// `node index.js` under the systemd ponyou-agent service).
const _locks = new Map();
export async function withFileLock(filePath, fn) {
  const key = path.resolve(filePath);
  const prev = _locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  const myTurn = prev.then(() => next);
  _locks.set(key, myTurn);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (_locks.get(key) === myTurn) _locks.delete(key);
  }
}

export function atomicWriteJson(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

export function atomicWriteText(filePath, text) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, filePath);
}

export async function atomicWriteJsonAsync(filePath, data) {
  const tmp = filePath + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmp, filePath);
}

export async function atomicWriteTextAsync(filePath, text) {
  const tmp = filePath + ".tmp";
  await fs.promises.writeFile(tmp, text, "utf8");
  await fs.promises.rename(tmp, filePath);
}
