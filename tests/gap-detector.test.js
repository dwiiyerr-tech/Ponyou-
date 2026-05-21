import { describe, it, expect } from "vitest";
import { detectGaps } from "../gap-detector.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import os from "os";

function makeTmpQueue(content) {
  const dir = join(os.tmpdir(), `gap-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "PR_QUEUE.md");
  writeFileSync(path, content, "utf8");
  return { dir, path };
}

const NOW = new Date("2026-05-22T00:00:00Z").getTime(); // 1 day after 2026-05-21

const QUEUE_WITH_STUCK = `
## PR-001: Test PR
Status: in_progress
Priority: high
Safety: safe
Goal: test
Tasks:
- [x] done task
- [ ] unchecked task
Added: 2026-05-21
`;

const QUEUE_ALL_DONE = `
## PR-001: Done PR
Status: done
Priority: high
Safety: safe
Goal: test
Tasks:
- [x] done task
Added: 2026-05-21
`;

const QUEUE_PENDING_BUT_FRESH = `
## PR-001: Fresh PR
Status: pending
Priority: high
Safety: safe
Goal: test
Tasks:
- [ ] unchecked task
Added: 2026-05-22
`;

describe("gap-detector", () => {
  it("detects in_progress PR with unchecked tasks past threshold", () => {
    const { path, dir } = makeTmpQueue(QUEUE_WITH_STUCK);
    try {
      const gaps = detectGaps({ prQueuePath: path, testsDir: "/nonexistent", stuckDaysThreshold: 0.5, nowMs: NOW });
      const stuck = gaps.filter(g => g.type === "stuck_pr");
      expect(stuck.length).toBe(1);
      expect(stuck[0].prId).toBe("PR-001");
      expect(stuck[0].uncheckedTasks).toBe(1);
      expect(stuck[0].tasks).toEqual(["unchecked task"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not flag done PRs", () => {
    const { path, dir } = makeTmpQueue(QUEUE_ALL_DONE);
    try {
      const gaps = detectGaps({ prQueuePath: path, testsDir: "/nonexistent", stuckDaysThreshold: 0.5, nowMs: NOW });
      expect(gaps.filter(g => g.type === "stuck_pr")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not flag PRs added within threshold", () => {
    const { path, dir } = makeTmpQueue(QUEUE_PENDING_BUT_FRESH);
    try {
      const gaps = detectGaps({ prQueuePath: path, testsDir: "/nonexistent", stuckDaysThreshold: 1, nowMs: NOW });
      expect(gaps.filter(g => g.type === "stuck_pr")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array on missing queue file", () => {
    const gaps = detectGaps({ prQueuePath: "/nonexistent/PR_QUEUE.md", testsDir: "/nonexistent", nowMs: NOW });
    expect(gaps).toEqual([]);
  });
});
