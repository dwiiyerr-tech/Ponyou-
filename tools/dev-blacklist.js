/**
 * Market-Cap-Aware Developer Blacklist.
 *
 * Not all rug devs are equal. A dev who rugged a $5K micro cap is different
 * from one who rugged a $5M mid cap. This module adds tiered blacklisting:
 *
 *   CRITICAL: micro cap rug — permanent block, all future tokens
 *   HIGH:     mid cap rug — block for 30 days, then auto-review
 *   MEDIUM:   high cap rug — flag only (not blocked), 14 day expiry
 *   LOW:      suspicious activity, no block, 7 day expiry
 *
 * Persisted to rug-memory.json alongside existing patterns.
 */

import fs from "fs";
import path from "path";
import { atomicWriteJson } from "../atomic-write.js";
import { log } from "../logger.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const RUG_MEMORY_FILE = path.join(__dirname, "../rug-memory.json");

// ─── Tier thresholds based on MCap ────────────────────────────

const TIER_THRESHOLDS = {
  CRITICAL: { max_mcap: 100_000, block_days: Infinity, reason: "Micro cap rug — permanent dev block" },
  HIGH:     { max_mcap: 1_000_000, block_days: 30, reason: "Low cap rug — 30 day dev block" },
  MEDIUM:   { max_mcap: 10_000_000, block_days: 14, reason: "Mid cap rug — 14 day flag, no block" },
  LOW:      { max_mcap: Infinity, block_days: 7, reason: "High cap incident — 7 day flag, no block" },
};

function classifyTier(mcap) {
  const mcapVal = Number(mcap || 0);
  if (mcapVal <= TIER_THRESHOLDS.CRITICAL.max_mcap) return "CRITICAL";
  if (mcapVal <= TIER_THRESHOLDS.HIGH.max_mcap) return "HIGH";
  if (mcapVal <= TIER_THRESHOLDS.MEDIUM.max_mcap) return "MEDIUM";
  return "LOW";
}

// ─── File I/O ─────────────────────────────────────────────────

function loadRugMemory() {
  if (!fs.existsSync(RUG_MEMORY_FILE)) return { patterns: [], dev_blacklist: [] };
  try { return JSON.parse(fs.readFileSync(RUG_MEMORY_FILE, "utf8")); }
  catch { return { patterns: [], dev_blacklist: [] }; }
}

function saveRugMemory(data) {
  atomicWriteJson(RUG_MEMORY_FILE, data);
}

// ─── Core API ─────────────────────────────────────────────────

/**
 * Blacklist a developer with tiered severity based on the token's market cap.
 *
 * @param {string} creator — dev wallet address
 * @param {string} mint — token mint that was rugged
 * @param {string} symbol — token symbol
 * @param {number} mcap — market cap at time of rug
 * @param {string} reason — what happened
 */
export function blacklistDev({ creator, mint, symbol, mcap = 0, reason = "" }) {
  if (!creator) return null;

  const mem = loadRugMemory();
  if (!mem.dev_blacklist) mem.dev_blacklist = [];

  const tier = classifyTier(mcap);
  const config = TIER_THRESHOLDS[tier];
  const now = new Date().toISOString();
  const expiresAt = config.block_days === Infinity
    ? null
    : new Date(Date.now() + config.block_days * 24 * 3600 * 1000).toISOString();

  // Check if already blacklisted — upgrade tier if new rug is worse
  const existing = mem.dev_blacklist.find(d => d.creator === creator);
  if (existing) {
    const existingTierIdx = Object.keys(TIER_THRESHOLDS).indexOf(existing.tier);
    const newTierIdx = Object.keys(TIER_THRESHOLDS).indexOf(tier);
    if (newTierIdx <= existingTierIdx) {
      // New rug is same or worse tier → upgrade and extend
      const previousTier = existing.tier; // save BEFORE mutating
      existing.tier = tier;
      existing.block_days = config.block_days;
      existing.expires_at = expiresAt;
      existing.rug_count = (existing.rug_count || 1) + 1;
      existing.reason = `${reason} (upgraded from ${previousTier}, ${existing.rug_count} rugs)`;
      existing.rugs.push({ mint, symbol, mcap, reason, tier, ts: now });
      if (existing.rugs.length > 10) existing.rugs = existing.rugs.slice(-10);
      log("dev_blacklist", `Dev ${creator.slice(0, 10)} UPGRADED ${previousTier} → ${tier} (${existing.rug_count} rugs, mcap: $${mcap})`);
    }
    saveRugMemory(mem);
    return { creator, tier, action: tier === "CRITICAL" || tier === "HIGH" ? "block" : "flag", existing: true };
  }

  // New blacklist entry
  const entry = {
    creator,
    tier,
    block_days: config.block_days,
    added_at: now,
    expires_at: expiresAt,
    reason: reason || config.reason,
    rug_count: 1,
    rugs: [{ mint, symbol, mcap, reason, tier, ts: now }],
  };

  mem.dev_blacklist.push(entry);
  // Cap at 200 entries
  if (mem.dev_blacklist.length > 200) mem.dev_blacklist = mem.dev_blacklist.slice(-200);

  saveRugMemory(mem);
  log("dev_blacklist", `Dev ${creator.slice(0, 10)} blacklisted → ${tier} (mcap: $${mcap})`);
  return { creator, tier, action: tier === "CRITICAL" || tier === "HIGH" ? "block" : "flag", existing: false };
}

/**
 * Check if a developer is blacklisted and what action to take.
 *
 * @returns {{ blocked: boolean, flagged: boolean, tier: string, entry: object|null }}
 */
export function checkDevBlacklist(creator) {
  if (!creator) return { blocked: false, flagged: false, tier: null, entry: null };

  const mem = loadRugMemory();
  const devs = mem.dev_blacklist || [];
  const entry = devs.find(d => d.creator === creator);
  if (!entry) return { blocked: false, flagged: false, tier: null, entry: null };

  // Check expiry
  if (entry.expires_at && new Date(entry.expires_at).getTime() < Date.now()) {
    // Expired — downgrade to LOW (flag only, no block)
    return { blocked: false, flagged: true, tier: "LOW", entry: { ...entry, expired: true } };
  }

  const blocked = entry.tier === "CRITICAL" || entry.tier === "HIGH";
  const flagged = entry.tier === "MEDIUM" || entry.tier === "LOW";
  return { blocked, flagged, tier: entry.tier, entry };
}

/**
 * Get the full dev blacklist for dashboard/Telegram display.
 */
export function getDevBlacklist() {
  const mem = loadRugMemory();
  const devs = mem.dev_blacklist || [];
  const now = Date.now();

  return {
    total: devs.length,
    critical: devs.filter(d => d.tier === "CRITICAL" && (!d.expires_at || new Date(d.expires_at) > now)).length,
    high: devs.filter(d => d.tier === "HIGH" && (!d.expires_at || new Date(d.expires_at) > now)).length,
    medium: devs.filter(d => d.tier === "MEDIUM" && (!d.expires_at || new Date(d.expires_at) > now)).length,
    low: devs.filter(d => d.tier === "LOW").length,
    expired: devs.filter(d => d.expires_at && new Date(d.expires_at) <= now).length,
    entries: devs.slice(-20).reverse(), // recent first
  };
}
