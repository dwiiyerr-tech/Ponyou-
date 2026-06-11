import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Mock the heavyweight collaborators so createDashboardServer can be
// instantiated in isolation — we are testing the auth gate, not the routes.
vi.mock("../dashboard/state-reader.js", () => ({
  readBotState: vi.fn(async () => ({ bot_running: true })),
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

import request from "supertest";
import { createDashboardServer } from "../dashboard/server.js";
import { getToken } from "../dashboard/auth.js";

let dash, app, token;

beforeAll(() => {
  dash = createDashboardServer({ port: 0 });
  app = dash.app;
  token = getToken();
});

afterAll(async () => {
  await dash.shutdown();
});

describe("dashboard auth gate", () => {
  it("rejects /api requests without a token (401)", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects /wizard requests without a token (401)", async () => {
    const res = await request(app).post("/wizard/config").send({});
    expect(res.status).toBe(401);
  });

  it("redirects unauthenticated / to /login", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  it("serves /api with a valid Bearer token", async () => {
    const res = await request(app)
      .get("/api/status")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.bot_running).toBe(true);
  });

  it("serves /api with a valid dashtoken cookie", async () => {
    const res = await request(app)
      .get("/api/status")
      .set("Cookie", `dashtoken=${token}`);
    expect(res.status).toBe(200);
  });
});

describe("login flow", () => {
  it("GET /login renders the form without auth", async () => {
    const res = await request(app).get("/login");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Ponyou Mission Control");
  });

  it("GET /login?token=<valid> sets the session cookie and redirects to /", async () => {
    const res = await request(app).get(`/login?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
    const cookie = (res.headers["set-cookie"] || []).join(";");
    expect(cookie).toContain("dashtoken=");
    expect(cookie).toContain("HttpOnly");
  });

  it("POST /login with a valid token sets the session cookie", async () => {
    const res = await request(app).post("/login").type("form").send({ token });
    expect(res.status).toBe(302);
    expect((res.headers["set-cookie"] || []).join(";")).toContain("dashtoken=");
  });

  it("POST /login with a wrong token returns 401 and no cookie", async () => {
    const res = await request(app).post("/login").type("form").send({ token: "nope" });
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("POST /logout clears the cookie", async () => {
    const res = await request(app).post("/logout");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect((res.headers["set-cookie"] || []).join(";")).toContain("dashtoken=;");
  });
});
