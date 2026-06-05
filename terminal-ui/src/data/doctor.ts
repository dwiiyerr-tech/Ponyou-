/**
 * doctor.ts — environment & connectivity health checks.
 *
 * Each check is async and independent so the Doctor screen can render them
 * streaming in (checking → pass/warn/fail) rather than blocking on the slowest.
 */
import { existsSync } from "node:fs";
import { rootPath, readJson } from "./paths.js";
import { botRunning } from "./readState.js";
import { readErrorGroups } from "./readLogs.js";
import type { DoctorCheck } from "../types.js";

type CheckFn = () => Promise<Omit<DoctorCheck, "id" | "label" | "group">>;

interface CheckDef { id: string; label: string; group: string; run: CheckFn; }

const config = () => readJson<Record<string, any>>(rootPath("user-config.json"), {});

export const CHECKS: CheckDef[] = [
  {
    id: "node",
    label: "Node version",
    group: "Environment",
    run: async () => {
      const major = Number(process.versions.node.split(".")[0]);
      if (major >= 18) return { status: "pass", detail: `v${process.versions.node}` };
      return { status: "fail", detail: `v${process.versions.node} — need >= 18`, fix: "install Node 18+ (nvm install 20)" };
    },
  },
  {
    id: "config",
    label: "user-config.json",
    group: "Environment",
    run: async () => {
      const p = rootPath("user-config.json");
      if (!existsSync(p)) return { status: "fail", detail: "missing", fix: "run the Setup wizard (key 6) to create it" };
      const c = config();
      return Object.keys(c).length > 0
        ? { status: "pass", detail: `found · ${Object.keys(c).length} keys` }
        : { status: "warn", detail: "empty config", fix: "run the Setup wizard to populate it" };
    },
  },
  {
    id: "gmgn",
    label: "GMGN API key",
    group: "API Keys",
    run: async () => {
      const k = String(config().gmgnApiKey || process.env.GMGN_API_KEY || "");
      if (!k) return { status: "warn", detail: "not set — GMGN features disabled", fix: "add it in Setup (powers discovery, rug audit, multi-chain)" };
      if (k.length < 8) return { status: "warn", detail: "key looks too short", fix: "re-check the key from gmgn.ai → API" };
      // G3: probe the API to catch invalid keys before the first live call fails.
      try {
        const res = await fetch(
          `https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=swaps&direction=desc&filters%5B%5D=renounced&limit=1`,
          { headers: { "X-APIKEY": k }, signal: AbortSignal.timeout(4000) }
        );
        if (res.status === 401 || res.status === 403) {
          return { status: "fail", detail: `auth rejected (HTTP ${res.status})`, fix: "rotate the key at gmgn.ai → API settings" };
        }
        return res.ok
          ? { status: "pass", detail: `set · ${k.slice(0, 6)}… · auth ok` }
          : { status: "warn", detail: `set · HTTP ${res.status} (might be rate-limited)` };
      } catch {
        return { status: "warn", detail: `set · ${k.slice(0, 6)}… · ping failed (network?)` };
      }
    },
  },
  {
    id: "wallet",
    label: "Wallet pubkey",
    group: "API Keys",
    run: async () => {
      const w = String(config().walletAddress || "");
      if (!w) return { status: "warn", detail: "not set", fix: "add your read-only wallet address in Setup" };
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)
        ? { status: "pass", detail: `${w.slice(0, 4)}…${w.slice(-4)}` }
        : { status: "fail", detail: "invalid base58 address", fix: "paste the public key (not the private key)" };
    },
  },
  {
    id: "rpc",
    label: "RPC health",
    group: "Network",
    run: async () => {
      const url = String(config().rpcUrl || process.env.RPC_URL || "");
      if (!url) return { status: "warn", detail: "no rpcUrl configured", fix: "set an RPC endpoint in Setup (Helius/Triton/QuickNode)" };
      try {
        const t0 = Date.now();
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
          signal: AbortSignal.timeout(4000),
        });
        const ms = Date.now() - t0;
        if (!res.ok) return { status: "fail", detail: `HTTP ${res.status}`, fix: "check the RPC URL / API key in Setup" };
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return j.result === "ok"
          ? { status: "pass", detail: `${ms}ms · getHealth ok` }
          : { status: "warn", detail: `${ms}ms · health unclear` };
      } catch (e) {
        return { status: "fail", detail: `unreachable (${shortErr(e)})`, fix: "verify the endpoint is online and the key is valid" };
      }
    },
  },
  {
    id: "network",
    label: "Solana mainnet",
    group: "Network",
    run: async () => {
      try {
        const t0 = Date.now();
        const res = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
          signal: AbortSignal.timeout(4000),
        });
        const ms = Date.now() - t0;
        return res.ok ? { status: "pass", detail: `${ms}ms · reachable` }
                      : { status: "warn", detail: `HTTP ${res.status}` };
      } catch (e) {
        return { status: "fail", detail: `offline? (${shortErr(e)})`, fix: "check your internet connection" };
      }
    },
  },
  {
    id: "bot",
    label: "Bot process",
    group: "Process",
    run: async () => {
      return botRunning()
        ? { status: "pass", detail: "state.json fresh (< 2 min)" }
        : { status: "warn", detail: "stale / stopped", fix: "start the bot — it must run for live data" };
    },
  },

  // ── Cycles — read metrics.json for error rates and last run times ──────────
  {
    id: "cycle_screening",
    label: "Screening cycle",
    group: "Cycles",
    run: async () => {
      const m = readJson<Record<string, any>>(rootPath("metrics.json"), {});
      // R3: probe multiple plausible counter names — key names may evolve.
      const c = m.counters || {};
      const errors = Number(c.screening_error ?? c.cron_error ?? c.screeningError ?? 0);
      const latencyMs = Number(m.latencies?.screening_cycle?.last ?? m.latencies?.screeningCycle?.last ?? 0);
      if (errors > 5) return { status: "fail", detail: `${errors} errors recorded`, fix: "check error log — 'd' for LLM diagnosis" };
      if (errors > 0) return { status: "warn", detail: `${errors} error(s), last latency ${latencyMs}ms` };
      return { status: "pass", detail: latencyMs > 0 ? `last ${latencyMs}ms, 0 errors` : "no data yet" };
    },
  },
  {
    id: "cycle_management",
    label: "Management cycle",
    group: "Cycles",
    run: async () => {
      const m = readJson<Record<string, any>>(rootPath("metrics.json"), {});
      const c = m.counters || {};
      const errors = Number(c.management_error ?? c.managementError ?? 0);
      const latencyMs = Number(m.latencies?.management_cycle?.last ?? m.latencies?.managementCycle?.last ?? 0);
      if (errors > 5) return { status: "fail", detail: `${errors} errors recorded`, fix: "check error log — 'd' for LLM diagnosis" };
      if (errors > 0) return { status: "warn", detail: `${errors} error(s), last latency ${latencyMs}ms` };
      return { status: "pass", detail: latencyMs > 0 ? `last ${latencyMs}ms, 0 errors` : "no data yet" };
    },
  },
  {
    id: "cycle_execution",
    label: "Swap execution",
    group: "Cycles",
    run: async () => {
      const m = readJson<Record<string, any>>(rootPath("metrics.json"), {});
      const attempted = Number(m.counters?.fast_buy_attempted || 0);
      const failed    = Number(m.counters?.fast_buy_failed || 0);
      const gmgnErr   = Number(m.counters?.gmgn_swap_error || 0);
      const total = failed + gmgnErr;
      if (total > 3) return { status: "fail", detail: `${total} swap error(s)`, fix: "check Jupiter/GMGN connectivity and wallet balance" };
      if (total > 0) return { status: "warn", detail: `${failed} fast-buy fail, ${gmgnErr} gmgn err (${attempted} attempted)` };
      return { status: "pass", detail: attempted > 0 ? `${attempted} attempted, 0 failures` : "no swaps yet" };
    },
  },

  // ── Runtime Errors — read error-log.jsonl ─────────────────────────────────
  {
    id: "errors_uncaught",
    label: "Uncaught exceptions",
    group: "Runtime Errors",
    run: async () => {
      const groups = readErrorGroups(500);
      const fatal = groups.filter(g => g.category === "UNCAUGHT_EXCEPTION" || g.category === "UNHANDLED_REJECTION");
      if (fatal.length === 0) return { status: "pass", detail: "none" };
      const worst = fatal.sort((a, b) => b.count - a.count)[0];
      return {
        status: "fail",
        detail: `${worst.category} ×${worst.count} — ${worst.msgs[0]?.slice(0, 60) || ""}`,
        fix: "press 'd' for LLM diagnosis to find root cause",
      };
    },
  },
  {
    id: "errors_top",
    label: "Top recurring error",
    group: "Runtime Errors",
    run: async () => {
      const groups = readErrorGroups(500).filter(g =>
        g.category !== "UNCAUGHT_EXCEPTION" && g.category !== "UNHANDLED_REJECTION"
      );
      if (groups.length === 0) return { status: "pass", detail: "no errors in log" };
      const top = groups[0];
      const ageMin = Math.round((Date.now() - new Date(top.last).getTime()) / 60000);
      const status = top.count >= 10 ? "fail" : top.count >= 3 ? "warn" : "pass";
      return {
        status,
        detail: `[${top.category}] ×${top.count} · last ${ageMin}m ago · ${top.msgs[0]?.slice(0, 50) || ""}`,
        fix: status !== "pass" ? "press 'd' for LLM diagnosis" : undefined,
      };
    },
  },
  {
    id: "errors_all",
    label: "Error categories",
    group: "Runtime Errors",
    run: async () => {
      const groups = readErrorGroups(500);
      if (groups.length === 0) return { status: "pass", detail: "clean — no errors" };
      const total = groups.reduce((s, g) => s + g.count, 0);
      const cats  = groups.map(g => `${g.category}×${g.count}`).slice(0, 4).join(", ");
      return {
        status: total >= 20 ? "fail" : total >= 5 ? "warn" : "pass",
        detail: `${total} total across ${groups.length} categor${groups.length === 1 ? "y" : "ies"}: ${cats}`,
        fix: total >= 5 ? "press 'd' for LLM diagnosis" : undefined,
      };
    },
  },
];

/** Run one check by id. */
export async function runCheck(def: CheckDef): Promise<DoctorCheck> {
  try {
    const res = await def.run();
    return { id: def.id, label: def.label, group: def.group, ...res };
  } catch (e) {
    return { id: def.id, label: def.label, group: def.group, status: "fail", detail: shortErr(e) };
  }
}

function shortErr(e: unknown): string {
  const m = (e as Error)?.message || String(e);
  return m.split("\n")[0].slice(0, 40);
}
