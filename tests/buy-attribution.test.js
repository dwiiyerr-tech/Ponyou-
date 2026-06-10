/**
 * Buy attribution: trackPosition is the single emit site for
 * management:llm_buy — every entry path lands there, so the learning agent
 * can't miss a buy (previously only the management-LLM loop emitted and
 * rule-based / screening-LLM / confirm-mode buys exited as source="unknown").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { agentBus } from "../agents/agent-bus.js";
import { trackPosition, recordClose } from "../state.js";

const STATE_FILE = process.env.PONYOU_STATE_FILE;

function cleanState() { try { fs.unlinkSync(STATE_FILE); } catch { /* fresh */ } }

let events;
let unsubscribe;

beforeEach(() => {
  cleanState();
  events = [];
  const handler = (p) => events.push(p);
  agentBus.on("management:llm_buy", handler);
  unsubscribe = () => agentBus.off("management:llm_buy", handler);
});

afterEach(() => unsubscribe());

describe("trackPosition buy emission", () => {
  it("emits management:llm_buy with attribution for a new position", async () => {
    await trackPosition({
      position: "AttribMint111",
      pool: "jupiter",
      pool_name: "ATT",
      amount_sol: 0.1,
      initial_value_usd: 10,
      active_signals: [],
      signal_snapshot: { mint: "AttribMint111", symbol: "ATT", _hunt_source: "pumpfun", _social_source: "reddit" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].mint).toBe("AttribMint111");
    expect(events[0]._hunt_source).toBe("pumpfun");
    expect(events[0]._social_source).toBe("reddit");
  });

  it("does NOT emit for a DCA re-track of an existing open position", async () => {
    const base = {
      position: "DcaMint111", pool: "jupiter", pool_name: "DCA",
      amount_sol: 0.1, initial_value_usd: 10,
      signal_snapshot: { mint: "DcaMint111", symbol: "DCA", _hunt_source: "jupiter" },
    };
    await trackPosition(base);
    await trackPosition({ ...base, amount_sol: 0.2 }); // staged-entry top-up
    expect(events).toHaveLength(1);
  });

  it("re-emits when re-opening a previously closed position (new trade)", async () => {
    const base = {
      position: "ReopenMint11", pool: "jupiter", pool_name: "REO",
      amount_sol: 0.1, initial_value_usd: 10,
      signal_snapshot: { mint: "ReopenMint11", symbol: "REO", _hunt_source: "gecko" },
    };
    await trackPosition(base);
    recordClose("ReopenMint11", "takeProfit");
    await trackPosition(base);
    expect(events).toHaveLength(2);
  });

  it("falls back to manual/unknown attribution when the snapshot lacks a source", async () => {
    await trackPosition({
      position: "ManualMint11", pool: "jupiter", pool_name: "MAN",
      amount_sol: 0.1, initial_value_usd: 10,
      signal_snapshot: { mint: "ManualMint11", symbol: "MAN", workflow: { verdict: "manual" } },
    });
    await trackPosition({
      position: "UnknownMint1", pool: "jupiter", pool_name: "UNK",
      amount_sol: 0.1, initial_value_usd: 10,
      signal_snapshot: { mint: "UnknownMint1", symbol: "UNK" },
    });
    expect(events[0]._hunt_source).toBe("manual");
    expect(events[1]._hunt_source).toBe("unknown");
  });
});
