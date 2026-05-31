import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import { createWizardRouter } from "../dashboard/routes/wizard.js";

let app, tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-wizard-"));
  process.env.PONYOU_GMGN_ENV_DIR = path.join(tmp, "gmgn");
  app = express();
  app.use(express.json());
  app.use("/wizard", createWizardRouter());
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  // don't delete PONYOU_GMGN_ENV_DIR — beforeEach re-sets it; deleting would
  // wipe the global tmp redirect (vitest.config.js) for the rest of the worker.
});

describe("POST /wizard/gmgn-keygen", () => {
  it("generates an Ed25519 keypair, returns only the PUBLIC key, stores the private key", async () => {
    const res = await request(app).post("/wizard/gmgn-keygen").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.publicKey).toMatch(/-----BEGIN PUBLIC KEY-----/);
    expect(res.body.privateKey).toBeUndefined(); // never leaked to the client
    // private key landed in the redirected gmgn env, 0600
    const envFile = path.join(tmp, "gmgn", ".env");
    expect(fs.existsSync(envFile)).toBe(true);
    expect((fs.statSync(envFile).mode & 0o777).toString(8)).toBe("600");
    expect(fs.readFileSync(envFile, "utf8")).toMatch(/GMGN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----/);
  });

  it("refuses to overwrite an existing private key (409) unless overwrite:true", async () => {
    await request(app).post("/wizard/gmgn-keygen").send({});
    const blocked = await request(app).post("/wizard/gmgn-keygen").send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.existed).toBe(true);

    const forced = await request(app).post("/wizard/gmgn-keygen").send({ overwrite: true });
    expect(forced.status).toBe(200);
    expect(forced.body.regenerated).toBe(true);
  });

  it("GET /wizard/gmgn-key-status reflects stored state", async () => {
    const before = await request(app).get("/wizard/gmgn-key-status");
    expect(before.body.hasPrivateKey).toBe(false);
    await request(app).post("/wizard/gmgn-keygen").send({});
    const after = await request(app).get("/wizard/gmgn-key-status");
    expect(after.body.hasPrivateKey).toBe(true);
  });
});
