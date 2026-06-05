/**
 * Unit tests for the pure render helpers in theme.ts.
 * Run with: pnpm test  (uses Node's built-in test runner via tsx — no extra deps).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sparkline, bar, gradientColors, glyph } from "./theme.js";

test("sparkline: empty series renders nothing", () => {
  assert.equal(sparkline([]), "");
});

test("sparkline: single value renders one baseline glyph", () => {
  assert.equal(sparkline([5]), glyph.spark[0]);
});

test("sparkline: flat series renders all baseline (no fabricated slope)", () => {
  assert.equal(sparkline([3, 3, 3, 3]), glyph.spark[0].repeat(4));
});

test("sparkline: maps min→lowest and max→highest glyph", () => {
  const s = sparkline([0, 10]);
  assert.equal(s[0], glyph.spark[0]);
  assert.equal(s[s.length - 1], glyph.spark[glyph.spark.length - 1]);
});

test("sparkline: honours width by taking the last N samples", () => {
  assert.equal(sparkline([1, 2, 3, 4, 5], 2).length, 2);
});

test("bar: 0 and full are pure empty / pure fill of given width", () => {
  assert.equal(bar(0, 100, 5), glyph.barEmpty.repeat(5));
  assert.equal(bar(100, 100, 5), "█".repeat(5));
});

test("bar: half fill is roughly half the cells", () => {
  const b = bar(50, 100, 8);
  const filled = b.split("").filter((c) => c !== glyph.barEmpty).length;
  assert.ok(filled >= 3 && filled <= 5, `expected ~4 filled, got ${filled} (${b})`);
});

test("bar: clamps out-of-range values", () => {
  assert.equal(bar(999, 100, 4), "█".repeat(4));
  assert.equal(bar(-5, 100, 4), glyph.barEmpty.repeat(4));
});

test("bar: zero/negative max is safe (no NaN, renders empty)", () => {
  assert.equal(bar(5, 0, 3), glyph.barEmpty.repeat(3));
});

test("gradientColors: returns n hex colours", () => {
  const cols = gradientColors(6);
  assert.equal(cols.length, 6);
  for (const c of cols) assert.match(c, /^#[0-9a-f]{6}$/i);
});

test("gradientColors: n=1 returns the first stop", () => {
  assert.deepEqual(gradientColors(1, ["#112233", "#445566"]), ["#112233"]);
});

test("gradientColors: endpoints match the stops", () => {
  const cols = gradientColors(5, ["#000000", "#ffffff"]);
  assert.equal(cols[0].toLowerCase(), "#000000");
  assert.equal(cols[cols.length - 1].toLowerCase(), "#ffffff");
});
