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
