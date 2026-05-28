// NPL-4: compileLearnedNamePatterns must escape regex metacharacters
// extracted from rugged symbols. Otherwise a symbol like "WIF*" or
// "POPCAT." would either throw at compile time (SyntaxError) or produce
// a wildly different pattern than intended.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "name-patterns-learned.json");

function backupAndClear() {
  if (fs.existsSync(STATE_FILE)) {
    fs.copyFileSync(STATE_FILE, STATE_FILE + ".bak");
    fs.unlinkSync(STATE_FILE);
  }
}
function restoreBackup() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    if (fs.existsSync(STATE_FILE + ".bak")) {
      fs.renameSync(STATE_FILE + ".bak", STATE_FILE);
    }
  } catch {}
}

beforeEach(backupAndClear);
afterEach(restoreBackup);

describe("compileLearnedNamePatterns — NPL-4 regex escape", () => {
  it("compiles cleanly when a rugged symbol has a regex metacharacter", async () => {
    const { recordRuggedName, compileLearnedNamePatterns } = await import("../tools/name-pattern-learner.js");

    // Three rugs whose 3-char prefix contains a regex metacharacter.
    // Without escape, `new RegExp("^WI*", "i")` would mean "W followed by
    // zero or more I" — totally different intent.
    recordRuggedName("WI*RUG", "wifu rug");
    recordRuggedName("WI*PEG", "wifu peg");
    recordRuggedName("WI*TON", "wifu ton");

    const rules = compileLearnedNamePatterns();

    const prefixRule = rules.find(r => r.feature === "sym_prefix:WI*");
    expect(prefixRule, "expected a learned prefix rule for WI*").toBeDefined();
    expect(prefixRule.pattern.test("WI*FOO")).toBe(true);   // literal prefix matches
    expect(prefixRule.pattern.test("WIIFOO")).toBe(false);  // would match if unescaped
  });

  it("does not throw on bracket / paren metacharacters in symbol", async () => {
    const { recordRuggedName, compileLearnedNamePatterns } = await import("../tools/name-pattern-learner.js");
    recordRuggedName("[RU", "rug 1");
    recordRuggedName("[RU", "rug 2");
    recordRuggedName("[RU", "rug 3");
    expect(() => compileLearnedNamePatterns()).not.toThrow();
  });
});
