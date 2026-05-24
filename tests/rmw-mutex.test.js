import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { withFileLock, atomicWriteJsonAsync } from "../atomic-write.js";

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-mutex-"));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function rmwIncrement(file) {
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(file, "utf8")).n; } catch {}
  // yield to event loop so unprotected interleave is observable
  await new Promise((r) => setImmediate(r));
  await atomicWriteJsonAsync(file, { n: n + 1 });
}

describe("withFileLock", () => {
  it("serializes 10 concurrent RMW writers — no lost updates", async () => {
    const file = path.join(tmpDir, "counter.json");
    fs.writeFileSync(file, JSON.stringify({ n: 0 }));
    await Promise.all(
      Array.from({ length: 10 }, () => withFileLock(file, () => rmwIncrement(file)))
    );
    const final = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(final.n).toBe(10);
  });

  it("WITHOUT lock, concurrent writers are observably broken (sanity check)", async () => {
    // Either: lost updates (interleaved reads see same n) OR rename ENOENT
    // (two writers race on the same .tmp path). Both prove the race exists;
    // the with-lock test above proves the mutex fixes it.
    const file = path.join(tmpDir, "counter-nolock.json");
    fs.writeFileSync(file, JSON.stringify({ n: 0 }));
    let errored = false;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => rmwIncrement(file))
    );
    for (const r of results) if (r.status === "rejected") errored = true;
    let lostUpdates = false;
    try {
      const final = JSON.parse(fs.readFileSync(file, "utf8"));
      if (final.n < 10) lostUpdates = true;
    } catch { errored = true; }
    expect(errored || lostUpdates).toBe(true);
  });

it("propagates errors and still releases the lock", async () => {
    const file = path.join(tmpDir, "errfile.json");
    await expect(
      withFileLock(file, async () => { throw new Error("boom"); })
    ).rejects.toThrow("boom");
    // next call must not deadlock
    const got = await withFileLock(file, async () => 42);
    expect(got).toBe(42);
  });

  it("resolves with the inner function's return value", async () => {
    const file = path.join(tmpDir, "rv.json");
    const v = await withFileLock(file, async () => ({ ok: true }));
    expect(v).toEqual({ ok: true });
  });

  it("normalizes filePath so relative/absolute lock the same key", async () => {
    const file = path.join(tmpDir, "k.json");
    fs.writeFileSync(file, JSON.stringify({ n: 0 }));
    const rel = path.relative(process.cwd(), file);
    await Promise.all([
      withFileLock(file, () => rmwIncrement(file)),
      withFileLock(rel, () => rmwIncrement(file)),
    ]);
    const final = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(final.n).toBe(2);
  });

  it("locks are per-path — different files run in parallel", async () => {
    const fa = path.join(tmpDir, "a.json");
    const fb = path.join(tmpDir, "b.json");
    fs.writeFileSync(fa, JSON.stringify({ n: 0 }));
    fs.writeFileSync(fb, JSON.stringify({ n: 0 }));
    let aRunning = false, bRunning = false, overlap = false;
    await Promise.all([
      withFileLock(fa, async () => {
        aRunning = true;
        await new Promise((r) => setTimeout(r, 20));
        if (bRunning) overlap = true;
        aRunning = false;
      }),
      withFileLock(fb, async () => {
        bRunning = true;
        await new Promise((r) => setTimeout(r, 20));
        if (aRunning) overlap = true;
        bRunning = false;
      }),
    ]);
    expect(overlap).toBe(true);
  });
});
