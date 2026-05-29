// Regression test for SW-3: the _running re-entrancy guard in checkAll() must
// be reset even when the cycle throws. load()/save()/the file lock run outside
// the per-token try/catch, so a single throw used to wedge _running=true
// forever — the shadow watchlist would silently stop checking for the rest of
// the process lifetime (and surface as an unhandled rejection).

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted so the mock factory can reference the spy (vi.mock is hoisted
// above imports; a plain outer const would not be initialised in time).
const { withFileLock } = vi.hoisted(() => ({ withFileLock: vi.fn() }));

vi.mock("../atomic-write.js", () => ({
  withFileLock,
  atomicWriteJson: vi.fn(),
}));

import { checkAll } from "../tools/shadow-watchlist.js";

describe("shadow-watchlist checkAll — _running guard (SW-3)", () => {
  beforeEach(() => withFileLock.mockReset());

  it("resets the guard after a throwing cycle so the next cycle still runs", async () => {
    withFileLock.mockImplementationOnce(() => { throw new Error("disk fail"); });
    withFileLock.mockResolvedValue(undefined);
    await checkAll();                 // cycle 1 throws → caught → guard must reset
    await checkAll();                 // cycle 2 must run, not blocked by a stuck guard
    expect(withFileLock).toHaveBeenCalledTimes(2);
  });

  it("resets the guard after a clean cycle so consecutive cycles each run", async () => {
    withFileLock.mockResolvedValue(undefined);
    await checkAll();
    await checkAll();
    await checkAll();
    expect(withFileLock).toHaveBeenCalledTimes(3);
  });
});
