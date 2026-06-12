/**
 * Trade Evidence (readiness komponen 1) — bukti harus dibaca dari store yang
 * benar-benar ditulis bot. Bug 2026-06-12: gate membaca PROJECT_ROOT/state.json
 * (berisi fixture test) sementara 13 close riil di demo/state.json (redirect
 * env PONYOU_STATE_FILE) tak pernah terhitung, dan 10 entri archive format
 * lama (keyed `position`, tanpa `position_key`) didrop oleh dedup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../agents/agent-bus.js",     () => ({ agentBus: { subscribe: vi.fn(() => vi.fn()), emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock("../agents/agent-registry.js",() => ({ setAgentStatus: vi.fn(), updateAgentHealth: vi.fn() }));
vi.mock("../logger.js",               () => ({ log: vi.fn() }));
vi.mock("../tools/cast-net-gate.js",  () => ({ evaluateCastNet: vi.fn(() => ({ allowed: false })) }));
vi.mock("../strategies.js",           () => ({ getActiveStrategy: vi.fn(() => ({ id: "scalping" })) }));
vi.mock("../tools/trash-filter.js",   () => ({ scoreTrash: vi.fn(() => ({ score: 20 })) }));
vi.mock("../conviction-memory.js",    () => ({ getExperienceScore: vi.fn(() => 0) }));
vi.mock("../tools/wallet-manager.js", () => ({ getAllWallets: vi.fn(() => [] ) }));
vi.mock("../config.js",               () => ({ config: { pro: {} } }));

const { validateStrategyReadiness } = await import("../agents/pro-orchestrator.js");

function closedPosition(i, extra = {}) {
  return {
    position_key: `Mint${i}::paper-wallet`,
    closed: true,
    closed_at: new Date(Date.UTC(2026, 4, 1 + i)).toISOString(),
    initial_value_usd: 100,
    pnl_pct: i % 2 === 0 ? 12 : -8,
    ...extra,
  };
}

// Legacy archive shape (< 2026-06-10): mint lives in `position`, no position_key.
function legacyArchiveEntry(i) {
  const { position_key, ...rest } = closedPosition(i);
  return { ...rest, position: `LegacyMint${i}` };
}

let dir, prevState, prevArchive, prevAttrib;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pro-evidence-"));
  prevState = process.env.PONYOU_STATE_FILE;
  prevArchive = process.env.PONYOU_ARCHIVE_FILE;
  prevAttrib = process.env.PONYOU_TRADE_ATTRIBUTION_FILE;
  process.env.PONYOU_STATE_FILE = path.join(dir, "state.json");
  process.env.PONYOU_ARCHIVE_FILE = path.join(dir, "closed-positions-archive.json");
  process.env.PONYOU_TRADE_ATTRIBUTION_FILE = path.join(dir, "trade-attribution.json");
});

afterEach(() => {
  process.env.PONYOU_STATE_FILE = prevState;
  process.env.PONYOU_ARCHIVE_FILE = prevArchive;
  process.env.PONYOU_TRADE_ATTRIBUTION_FILE = prevAttrib;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeState(positions) {
  fs.writeFileSync(process.env.PONYOU_STATE_FILE,
    JSON.stringify({ positions: Object.fromEntries(positions.map(p => [p.position_key, p])) }));
}
function writeArchive(entries) {
  fs.writeFileSync(process.env.PONYOU_ARCHIVE_FILE, JSON.stringify(entries));
}

function tradeEvidence() {
  return validateStrategyReadiness().components.find(c => c.name === "1. Trade Evidence");
}

describe("validateStrategyReadiness: trade evidence store paths", () => {
  it("counts closed positions from the env-redirected state file", () => {
    writeState(Array.from({ length: 13 }, (_, i) => closedPosition(i)));
    expect(tradeEvidence().detail).toContain("total closed: 13/");
  });

  it("counts legacy archive entries keyed by `position` (no position_key)", () => {
    writeArchive(Array.from({ length: 10 }, (_, i) => legacyArchiveEntry(i)));
    expect(tradeEvidence().detail).toContain("total closed: 10/");
  });

  it("dedups a trade present in both archive and state", () => {
    const dupe = closedPosition(1);
    writeState([dupe, closedPosition(2)]);
    writeArchive([dupe]);
    expect(tradeEvidence().detail).toContain("total closed: 2/");
  });

  it("counts nothing when both stores are absent (no root fallback leakage)", () => {
    expect(tradeEvidence().detail).toContain("total closed: 0/");
  });

  it("joins PnL from trade-attribution when positions carry none", () => {
    // Real closed positions never get pnl_pct — it only exists in the
    // attribution ledger and inside free-text close notes.
    const positions = Array.from({ length: 4 }, (_, i) => {
      const { pnl_pct, ...p } = closedPosition(i);
      return p;
    });
    writeState(positions);
    fs.writeFileSync(process.env.PONYOU_TRADE_ATTRIBUTION_FILE, JSON.stringify({
      trades: positions.map((p, i) => ({
        ts: p.closed_at,
        mint: p.position_key.split("::")[0],
        pnl_pct: i < 3 ? 25 : -15, // 3 wins, 1 loss
      })),
    }));
    const detail = tradeEvidence().detail;
    expect(detail).toContain("win samples: 3/");
    expect(detail).toContain("loss samples: 1/");
    expect(detail).toContain("avg PnL%: 15.0%");
  });

  it("ignores attribution entries for the same mint traded >48h away", () => {
    const { pnl_pct, ...p } = closedPosition(1);
    writeState([p]);
    fs.writeFileSync(process.env.PONYOU_TRADE_ATTRIBUTION_FILE, JSON.stringify({
      trades: [{
        ts: new Date(Date.parse(p.closed_at) + 72 * 60 * 60 * 1000).toISOString(),
        mint: p.position_key.split("::")[0],
        pnl_pct: 99,
      }],
    }));
    const detail = tradeEvidence().detail;
    expect(detail).toContain("win samples: 0/");
    expect(detail).toContain("loss samples: 0/");
  });

  it("detects rugs from close notes, not just a structured exit_reason", () => {
    writeState([
      closedPosition(1, { notes: ["Closed at 2026-06-10: price_drop: -97.3% drop from entry"] }),
      closedPosition(2, { notes: ["Closed at 2026-06-10: ROI target hit"] }),
    ]);
    expect(tradeEvidence().detail).toContain("rug rate: 50%");
  });
});
