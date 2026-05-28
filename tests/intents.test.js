import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

// intents.js reads/writes pending-intents.json in __dirname. Snapshot+restore
// since these tests touch a real file.

const INTENTS_FILE = path.join(process.cwd(), "pending-intents.json");
let _backup = null;

beforeEach(() => {
  _backup = fs.existsSync(INTENTS_FILE) ? fs.readFileSync(INTENTS_FILE, "utf8") : null;
  if (fs.existsSync(INTENTS_FILE)) fs.unlinkSync(INTENTS_FILE);
});

afterEach(() => {
  if (_backup != null) fs.writeFileSync(INTENTS_FILE, _backup);
  else if (fs.existsSync(INTENTS_FILE)) fs.unlinkSync(INTENTS_FILE);
});

describe("createPendingIntent", () => {
  it("creates an intent with auto-incrementing id", async () => {
    const { createPendingIntent } = await import("../intents.js");
    const a = await createPendingIntent({ type: "buy", args: { token: "X" } });
    const b = await createPendingIntent({ type: "buy", args: { token: "Y" } });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.status).toBe("pending");
    expect(a.expires_at).toBeTruthy();
  });

  it("respects custom ttl_min", async () => {
    const { createPendingIntent } = await import("../intents.js");
    const intent = await createPendingIntent({ type: "buy", args: {}, ttl_min: 30 });
    const created = new Date(intent.created_at).getTime();
    const expires = new Date(intent.expires_at).getTime();
    const ttlMs = expires - created;
    expect(ttlMs).toBeGreaterThanOrEqual(29 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(31 * 60_000);
  });
});

describe("listPendingIntents", () => {
  it("returns only pending intents, marking expired ones", async () => {
    const { createPendingIntent, listPendingIntents } = await import("../intents.js");
    const fresh = await createPendingIntent({ type: "buy", args: {}, ttl_min: 60 });
    // Forge an expired one directly
    const all = JSON.parse(fs.readFileSync(INTENTS_FILE, "utf8"));
    all.push({
      id: 999,
      type: "buy",
      args: {},
      meta: {},
      status: "pending",
      created_at: new Date(Date.now() - 3600_000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    fs.writeFileSync(INTENTS_FILE, JSON.stringify(all, null, 2));

    const pending = listPendingIntents();
    expect(pending.find((i) => i.id === fresh.id)).toBeDefined();
    expect(pending.find((i) => i.id === 999)).toBeUndefined(); // expired

    // The expired intent should now be persisted with status="expired"
    const refreshed = JSON.parse(fs.readFileSync(INTENTS_FILE, "utf8"));
    expect(refreshed.find((i) => i.id === 999).status).toBe("expired");
  });
});

describe("getIntent", () => {
  it("returns null for missing id", async () => {
    const { getIntent } = await import("../intents.js");
    expect(getIntent(999)).toBeNull();
  });

  it("lazy-expires pending-but-past-TTL intents", async () => {
    const { createPendingIntent, getIntent } = await import("../intents.js");
    const intent = await createPendingIntent({ type: "buy", args: {}, ttl_min: 60 });
    // Mutate to past TTL
    const all = JSON.parse(fs.readFileSync(INTENTS_FILE, "utf8"));
    all[0].expires_at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(INTENTS_FILE, JSON.stringify(all, null, 2));

    const got = getIntent(intent.id);
    expect(got.status).toBe("expired");
  });
});

describe("consumeIntent", () => {
  it("transitions pending → executed", async () => {
    const { createPendingIntent, consumeIntent, getIntent } = await import("../intents.js");
    const intent = await createPendingIntent({ type: "buy", args: {} });
    const result = await consumeIntent(intent.id, "executed", { result: "tx-hash" });
    expect(result.status).toBe("executed");
    expect(result.result).toBe("tx-hash");
    expect(getIntent(intent.id).status).toBe("executed");
  });

  it("returns null if already consumed (idempotency)", async () => {
    const { createPendingIntent, consumeIntent } = await import("../intents.js");
    const intent = await createPendingIntent({ type: "buy", args: {} });
    await consumeIntent(intent.id, "executed");
    expect(await consumeIntent(intent.id, "executed")).toBeNull();
  });

  it("returns null for unknown id", async () => {
    const { consumeIntent } = await import("../intents.js");
    expect(await consumeIntent(9999, "executed")).toBeNull();
  });
});

describe("gcIntents", () => {
  it("removes intents older than cutoff", async () => {
    const { createPendingIntent, gcIntents } = await import("../intents.js");
    await createPendingIntent({ type: "buy", args: {} }); // fresh

    // Inject an old one
    const all = JSON.parse(fs.readFileSync(INTENTS_FILE, "utf8"));
    all.push({
      id: 88,
      type: "buy",
      args: {},
      meta: {},
      status: "executed",
      created_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
    });
    fs.writeFileSync(INTENTS_FILE, JSON.stringify(all, null, 2));

    const removed = gcIntents(24); // keep last 24h
    expect(removed).toBe(1);

    const remaining = JSON.parse(fs.readFileSync(INTENTS_FILE, "utf8"));
    expect(remaining.find((i) => i.id === 88)).toBeUndefined();
  });
});
