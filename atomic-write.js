import fs from "fs";
import path from "path";

// Clean up orphaned .tmp files from crashed writes on startup.
// Only removes files older than 60s to avoid touching in-progress writes
// from a concurrently-starting process.
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

(function cleanupOrphanedTmp() {
  const dirs = [path.resolve(".")];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir);
      const now = Date.now();
      for (const f of files) {
        if (!f.includes(".tmp.")) continue;
        const fp = path.join(dir, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs <= 60_000) continue;
          // P2-1: skip if the PID encoded in the tmp name is still alive —
          // that process is mid-write and we must not unlink its tmp file.
          const pidMatch = f.match(/\.tmp\.(\d+)\./);
          if (pidMatch) {
            const writerPid = parseInt(pidMatch[1], 10);
            if (writerPid !== process.pid && isPidAlive(writerPid)) continue;
          }
          fs.unlinkSync(fp);
        } catch {}
      }
    } catch {}
  }
})();

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

let _tmpCounter = 0;
function uniqueTmp(filePath) {
  _tmpCounter = (_tmpCounter + 1) % 1000000;
  return filePath + ".tmp." + process.pid + "." + Date.now() + "." + _tmpCounter;
}

function fsyncPath(p) {
  try {
    const fd = fs.openSync(p, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {} // best-effort — metadata durability is not critical
}

export function atomicWriteJson(filePath, data) {
  const tmp = uniqueTmp(filePath);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fsyncPath(tmp); // flush file data to disk before rename
    fs.renameSync(tmp, filePath);
    fsyncPath(path.dirname(filePath)); // flush directory metadata
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    throw e;
  }
}

export function atomicWriteText(filePath, text) {
  const tmp = uniqueTmp(filePath);
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fsyncPath(tmp);
    fs.renameSync(tmp, filePath);
    fsyncPath(path.dirname(filePath));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    throw e;
  }
}

export async function atomicWriteJsonAsync(filePath, data) {
  const tmp = uniqueTmp(filePath);
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
    const fh = await fs.promises.open(tmp, "r");
    await fh.sync();
    await fh.close();
    await fs.promises.rename(tmp, filePath);
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch (_) { /* best effort */ }
    throw e;
  }
}

export async function atomicWriteTextAsync(filePath, text) {
  const tmp = uniqueTmp(filePath);
  try {
    await fs.promises.writeFile(tmp, text, "utf8");
    const fh = await fs.promises.open(tmp, "r");
    await fh.sync();
    await fh.close();
    await fs.promises.rename(tmp, filePath);
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch (_) { /* best effort */ }
    throw e;
  }
}
