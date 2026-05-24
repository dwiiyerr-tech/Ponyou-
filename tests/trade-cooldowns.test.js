import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { getTokenCooldown, isTokenOnCooldown, setTokenCooldown } from "../trade-cooldowns.js";

const FILE = path.join(process.cwd(), "trade-cooldowns.json");

afterEach(() => {
  if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
});

describe("trade cooldowns", () => {
  it("stores and resolves active token cooldowns", async () => {
    await setTokenCooldown("mintA", 1, "auto_tp");
    expect(await isTokenOnCooldown("mintA")).toBe(true);
    expect((await getTokenCooldown("mintA"))?.reason).toBe("auto_tp");
  });
});
