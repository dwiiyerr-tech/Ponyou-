/**
 * doctor.ts — environment & connectivity health checks.
 *
 * Each check is async and independent so the Doctor screen can render them
 * streaming in (checking → pass/warn/fail) rather than blocking on the slowest.
 */
import { existsSync } from "node:fs";
import { rootPath, readJson } from "./paths.js";
import { botRunning } from "./readState.js";
import type { DoctorCheck } from "../types.js";

type CheckFn = () => Promise<Omit<DoctorCheck, "id" | "label">>;

interface CheckDef { id: string; label: string; run: CheckFn; }

const config = () => readJson<Record<string, any>>(rootPath("user-config.json"), {});

export const CHECKS: CheckDef[] = [
  {
    id: "node",
    label: "Node version",
    run: async () => {
      const major = Number(process.versions.node.split(".")[0]);
      if (major >= 18) return { status: "pass", detail: `v${process.versions.node}` };
      return { status: "fail", detail: `v${process.versions.node} — need >= 18` };
    },
  },
  {
    id: "config",
    label: "user-config.json",
    run: async () => {
      const p = rootPath("user-config.json");
      if (!existsSync(p)) return { status: "fail", detail: "missing — run the wizard" };
      const c = config();
      return Object.keys(c).length > 0
        ? { status: "pass", detail: `${Object.keys(c).length} keys` }
        : { status: "warn", detail: "empty config" };
    },
  },
  {
    id: "gmgn",
    label: "GMGN API key",
    run: async () => {
      const k = String(config().gmgnApiKey || process.env.GMGN_API_KEY || "");
      if (!k) return { status: "warn", detail: "not set — GMGN features disabled" };
      return k.length >= 8
        ? { status: "pass", detail: `set (${k.slice(0, 6)}…)` }
        : { status: "warn", detail: "key looks too short" };
    },
  },
  {
    id: "wallet",
    label: "Wallet public key",
    run: async () => {
      const w = String(config().walletAddress || "");
      if (!w) return { status: "warn", detail: "not set" };
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)
        ? { status: "pass", detail: `${w.slice(0, 4)}…${w.slice(-4)}` }
        : { status: "fail", detail: "invalid base58 address" };
    },
  },
  {
    id: "rpc",
    label: "RPC health",
    run: async () => {
      const url = String(config().rpcUrl || process.env.RPC_URL || "");
      if (!url) return { status: "warn", detail: "no rpcUrl configured" };
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) return { status: "fail", detail: `HTTP ${res.status}` };
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return j.result === "ok"
          ? { status: "pass", detail: "getHealth → ok" }
          : { status: "warn", detail: "reachable, health unclear" };
      } catch (e) {
        return { status: "fail", detail: `unreachable (${shortErr(e)})` };
      }
    },
  },
  {
    id: "network",
    label: "Network (Solana)",
    run: async () => {
      try {
        const res = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
          signal: AbortSignal.timeout(4000),
        });
        return res.ok ? { status: "pass", detail: "mainnet reachable" }
                      : { status: "warn", detail: `HTTP ${res.status}` };
      } catch (e) {
        return { status: "fail", detail: `offline? (${shortErr(e)})` };
      }
    },
  },
  {
    id: "bot",
    label: "Bot process",
    run: async () => {
      return botRunning()
        ? { status: "pass", detail: "state.json fresh (< 2 min)" }
        : { status: "warn", detail: "stale/stopped — start the bot" };
    },
  },
];

/** Run one check by id. */
export async function runCheck(def: CheckDef): Promise<DoctorCheck> {
  try {
    const res = await def.run();
    return { id: def.id, label: def.label, ...res };
  } catch (e) {
    return { id: def.id, label: def.label, status: "fail", detail: shortErr(e) };
  }
}

function shortErr(e: unknown): string {
  const m = (e as Error)?.message || String(e);
  return m.split("\n")[0].slice(0, 40);
}
