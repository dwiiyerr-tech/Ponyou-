import "dotenv/config";
// Force DRY_RUN regardless of how this entrypoint is invoked.
process.env.DRY_RUN = "true";
import { runManagementCycle, runScreeningCycle, runVaultCycle, runDailyReport } from "./index.js";
import { getPlanSummary, checkSessionGate } from "./trading-plan.js";
import { getMarketIntelligence } from "./market-intelligence.js";
import { getWalletBalances } from "./tools/wallet.js";

const SEP = "═".repeat(60);
const sep = "─".repeat(60);

function header(title) {
  console.log(`\n${SEP}`);
  console.log(`  ${title}`);
  console.log(SEP);
}

function section(title) {
  console.log(`\n${sep}`);
  console.log(`  ${title}`);
  console.log(sep);
}

header("PONYOU DRY RUN — " + new Date().toISOString());

// ── Status awal ─────────────────────────────────────────────
section("1. Status Awal");
const plan = getPlanSummary();
const market = getMarketIntelligence();
const gate = checkSessionGate();

console.log(`Mode         : DRY RUN`);
console.log(`Market       : ${market.condition} — ${market.description || ""}` );
console.log(`Plan         : ${plan ? `Day ${plan.day}/${plan.days_total} | P&L: ${plan.today_pnl_pct}% | Capital: ${plan.calibrated ? `$${plan.today_start_usd}` : "(uncalibrated)"}` : "Belum diinisialisasi"}`);
console.log(`Session Gate : ${gate.paused ? `PAUSED — ${gate.reason} (${gate.resume_in_min}m lagi)` : "RUNNING"}`);

// ── Wallet ─────────────────────────────────────────────────
section("2. Wallet Balance");
try {
  const bal = await getWalletBalances();
  if (bal.error) {
    console.log(`  Wallet: ${bal.error}`);
  } else {
    console.log(`  SOL    : ${bal.sol ?? "N/A"}`);
    console.log(`  SOL USD: $${bal.sol_usd ?? "N/A"}`);
    console.log(`  Tokens : ${(bal.tokens || []).length} posisi`);
  }
} catch (e) {
  console.log(`  Wallet error: ${e.message}`);
}

// ── Management Cycle ───────────────────────────────────────
section("3. Management Cycle (DRY RUN)");
const mgmt = await runManagementCycle({ silent: true });
console.log(`  Hasil: ${mgmt}`);

// ── Screening Cycle ────────────────────────────────────────
section("4. Screening Cycle (DRY RUN)");
const screen = await runScreeningCycle({ silent: true });
console.log(`  Hasil: ${screen}`);

// ── Vault Check ────────────────────────────────────────────
section("5. Vault Check (DRY RUN)");
const vault = await runVaultCycle({ silent: true });
console.log(`  Hasil: ${vault ? JSON.stringify(vault) : "Vault tidak dikonfigurasi / belum jatuh tempo"}`);

// ── Daily Report ───────────────────────────────────────────
section("6. Daily Report (preview)");
const report = await runDailyReport({ silent: true });
console.log(`  Hasil: ${report ? "Report generated ✓" : "Report disabled atau error"}`);

// ── Summary ────────────────────────────────────────────────
header("DRY RUN SELESAI");
console.log("Semua siklus berjalan tanpa transaksi nyata.\n");
process.exit(0);
