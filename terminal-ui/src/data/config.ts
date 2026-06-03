/**
 * config.ts — read / merge-write user-config.json for the setup wizard.
 *
 * Writes are merge-only (never clobber unrelated keys) and atomic-ish
 * (write temp + rename) so a crash mid-write can't corrupt the live config.
 */
import { writeFileSync, renameSync, existsSync, readFileSync } from "node:fs";
import { rootPath } from "./paths.js";
import type { RiskLimits } from "../types.js";

export interface WizardConfig {
  gmgnApiKey: string;
  rpcUrl: string;
  walletAddress: string;
  maxPositions: number;
  dailyStopLossPct: number;
  deployAmountSol: number;
}

export function readWizardConfig(): WizardConfig {
  const raw = safeRead();
  return {
    gmgnApiKey: String(raw.gmgnApiKey || ""),
    rpcUrl: String(raw.rpcUrl || ""),
    walletAddress: String(raw.walletAddress || ""),
    maxPositions: Number(raw.maxPositions ?? 3),
    dailyStopLossPct: Number(raw.dailyStopLossPct ?? -10),
    deployAmountSol: Number(raw.deployAmountSol ?? 0.5),
  };
}

export function readRiskLimits(): RiskLimits {
  const raw = safeRead();
  return {
    maxPositions: Number(raw.maxPositions ?? 3),
    dailyStopLossPct: Number(raw.dailyStopLossPct ?? -10),
    deployAmountSol: Number(raw.deployAmountSol ?? 0.5),
  };
}

/** Merge-write the wizard fields into user-config.json. Returns saved keys. */
export function saveWizardConfig(patch: Partial<WizardConfig>): string[] {
  const current = safeRead();
  const next = { ...current };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v))) continue;
    next[k] = v;
    changed.push(k);
  }
  atomicWrite(next);
  return changed;
}

// ── internals ──
function safeRead(): Record<string, unknown> {
  try {
    const p = rootPath("user-config.json");
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function atomicWrite(obj: Record<string, unknown>): void {
  const p = rootPath("user-config.json");
  const tmp = `${p}.tui.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, p);
}

/** Basic validators for wizard inputs. */
export const validate = {
  rpcUrl(v: string): string | null {
    if (!v) return null; // optional
    return /^https?:\/\/.+/.test(v.trim()) ? null : "must start with http:// or https://";
  },
  walletAddress(v: string): string | null {
    if (!v) return null;
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.trim()) ? null : "not a valid Solana base58 address";
  },
  gmgnApiKey(v: string): string | null {
    if (!v) return null;
    return v.trim().length >= 8 ? null : "key looks too short";
  },
  maxPositions(v: string): string | null {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? null : "1-10";
  },
  dailyStopLossPct(v: string): string | null {
    const n = Number(v);
    return Number.isFinite(n) && n < 0 && n >= -100 ? null : "negative, e.g. -10";
  },
  deployAmountSol(v: string): string | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 100 ? null : "0 < x <= 100";
  },
};
