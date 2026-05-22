import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import {
  atomicWriteJson,
  atomicWriteText,
  atomicWriteJsonAsync,
  atomicWriteTextAsync,
} from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let workDir;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("atomicWriteJson", () => {
  it("writes JSON with 2-space indent and lands at final path", () => {
    const fp = path.join(workDir, "state.json");
    atomicWriteJson(fp, { a: 1, b: [2, 3] });
    const txt = fs.readFileSync(fp, "utf8");
    expect(JSON.parse(txt)).toEqual({ a: 1, b: [2, 3] });
    expect(txt).toContain("  \"a\": 1");
  });

  it("does not leave a .tmp file on success", () => {
    const fp = path.join(workDir, "ok.json");
    atomicWriteJson(fp, { ok: true });
    expect(fs.existsSync(fp + ".tmp")).toBe(false);
  });

  it("does not corrupt existing file when serialization throws", () => {
    const fp = path.join(workDir, "guard.json");
    atomicWriteJson(fp, { v: 1 });
    const circular = {};
    circular.self = circular;
    expect(() => atomicWriteJson(fp, circular)).toThrow();
    expect(JSON.parse(fs.readFileSync(fp, "utf8"))).toEqual({ v: 1 });
  });
});

describe("atomicWriteText", () => {
  it("writes utf8 text and lands at final path", () => {
    const fp = path.join(workDir, "token.txt");
    atomicWriteText(fp, "hello 🐱");
    expect(fs.readFileSync(fp, "utf8")).toBe("hello 🐱");
    expect(fs.existsSync(fp + ".tmp")).toBe(false);
  });
});

describe("atomicWriteJsonAsync", () => {
  it("writes JSON and lands at final path", async () => {
    const fp = path.join(workDir, "async.json");
    await atomicWriteJsonAsync(fp, { x: 1 });
    expect(JSON.parse(fs.readFileSync(fp, "utf8"))).toEqual({ x: 1 });
    expect(fs.existsSync(fp + ".tmp")).toBe(false);
  });

  it("rejects if rename fails (target dir missing)", async () => {
    const fp = path.join(workDir, "missing/nested.json");
    await expect(atomicWriteJsonAsync(fp, { y: 2 })).rejects.toThrow();
  });
});

describe("atomicWriteTextAsync", () => {
  it("writes utf8 text and lands at final path", async () => {
    const fp = path.join(workDir, "async.txt");
    await atomicWriteTextAsync(fp, "line\nline2");
    expect(fs.readFileSync(fp, "utf8")).toBe("line\nline2");
    expect(fs.existsSync(fp + ".tmp")).toBe(false);
  });
});

describe("regression: no raw writeFileSync without rename in source files", () => {
  it("source modules use atomic-write.js helpers (no inline tmp+rename, no naked writeFileSync to state/json files)", () => {
    const root = path.join(__dirname, "..");
    // Limit scope: top-level JS + key dirs only (avoid node_modules + front-end + tests).
    // Find candidate files first, then grep them — far faster than rgrep over whole tree.
    let candidates = "";
    try {
      candidates = execSync(
        `find "${root}" -maxdepth 3 -name "*.js" -type f \\
          -not -path "*/node_modules/*" \\
          -not -path "*/dashboard/public/*" \\
          -not -path "*/tests/*" \\
          -not -path "*/atomic-write.js"`,
        { encoding: "utf8" }
      );
    } catch {
      candidates = "";
    }

    const files = candidates.split("\n").filter(Boolean);
    const hits = [];
    for (const f of files) {
      if (f.endsWith("/atomic-write.js")) continue;
      let txt;
      try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
      const lines = txt.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bfs\.writeFileSync\b/.test(line) || /\bfs\.promises\.writeFile\b/.test(line)) {
          hits.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(
      hits,
      `Found raw writeFile* sites that should be migrated to atomic-write.js helpers:\n${hits.join("\n")}`
    ).toEqual([]);
  });
});
