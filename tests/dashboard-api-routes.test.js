import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../dashboard/state-reader.js", () => ({
  readBotState: vi.fn(async () => ({
    bot_running: true, balance_sol: 2.5, pnl_today_usd: 12.4,
    positions: [], features: {}, trading_plan: {}, vault: {}, win_rate: null,
  })),
}));
vi.mock("../dashboard/command-writer.js", () => ({
  writeAutomationCommand: vi.fn(),
  writeDashboardCmd: vi.fn(),
  readDashboardResponse: vi.fn(() => null),
}));
vi.mock("../dashboard/ipc.js", () => ({
  sendBotCommand: vi.fn(async () => ({ ok: true, response: "done" })),
}));
vi.mock("../dashboard/config-writer.js", () => ({
  readConfig: vi.fn(() => ({})),
  writeConfig: vi.fn(),
  maskPrivateKey: vi.fn(k => k),
}));
vi.mock("../trading-plan-30.js", () => ({
  resetTradingPlan: vi.fn(() => ({ trades_completed: 0, target: 30 })),
}));

import express from "express";
import request from "supertest";
import { createApiRouter } from "../dashboard/routes/api.js";

let app;
beforeEach(() => {
  app = express();
  app.use(express.json());
  app.use("/api", createApiRouter());
});

describe("GET /api/status", () => {
  it("returns bot state", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.bot_running).toBe(true);
    expect(res.body.balance_sol).toBe(2.5);
  });
});

describe("POST /api/command", () => {
  it("calls writeAutomationCommand for start", async () => {
    const { writeAutomationCommand } = await import("../dashboard/command-writer.js");
    const res = await request(app).post("/api/command").send({ cmd: "start" });
    expect(res.status).toBe(200);
    expect(writeAutomationCommand).toHaveBeenCalledWith("start");
  });

  it("rejects unknown cmd", async () => {
    const res = await request(app).post("/api/command").send({ cmd: "rm -rf" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/cmd", () => {
  it("calls sendBotCommand and returns response", async () => {
    const res = await request(app).post("/api/cmd").send({ cmd: "/stoptrade" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("Strategy Lab routes (Phase 2/3/4)", () => {
  it("GET /api/portfolio surfaces staged flags + book", async () => {
    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty("enabled");
    expect(res.body).toHaveProperty("mode");
  });

  it("GET /api/skill-loop returns the loop dashboard", async () => {
    const res = await request(app).get("/api/skill-loop");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.shadowSkills)).toBe(true);
  });

  it("GET /api/skill-registry returns imported packages", async () => {
    const res = await request(app).get("/api/skill-registry");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.imported)).toBe(true);
  });

  it("POST /api/skill-loop/action requires a skillId", async () => {
    const res = await request(app).post("/api/skill-loop/action").send({ action: "promote" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("POST /api/skill-loop/action promotes a vetted shadow skill", async () => {
    const { _resetRegistryForTests, upsertStrategySkill, setStrategySkillScorecard, setStrategySkillStatus } = await import("../strategy-skills.js");
    _resetRegistryForTests();
    upsertStrategySkill({ id: "lab_skill", type: "composite", params: { filters: {} }, status: "draft", weight: 0 });
    const m = { sample: 35, win_rate: 0.5, expectancy_pct: 8, max_drawdown_pct: 25, sharpe: 0.4 };
    setStrategySkillScorecard("lab_skill", { sample: 50, metrics: { ...m, sample: 50 }, walk_forward: { in_sample: m, out_of_sample: m } });
    setStrategySkillStatus("lab_skill", "shadow");
    const res = await request(app).post("/api/skill-loop/action").send({ action: "promote", skillId: "lab_skill" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe("active");
  });
});

describe("POST /api/portfolio/weight", () => {
  it("rejects an out-of-range weight", async () => {
    const res = await request(app).post("/api/portfolio/weight").send({ skillId: "x", weight: 2 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("sets a skill's book weight", async () => {
    const { _resetRegistryForTests, upsertStrategySkill } = await import("../strategy-skills.js");
    _resetRegistryForTests();
    upsertStrategySkill({ id: "wt_skill", type: "composite", params: { filters: {} }, status: "active", weight: 0 });
    const res = await request(app).post("/api/portfolio/weight").send({ skillId: "wt_skill", weight: 0.4 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.weight).toBeCloseTo(0.4, 6);
  });
});
