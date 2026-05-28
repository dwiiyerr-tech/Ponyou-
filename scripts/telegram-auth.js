#!/usr/bin/env node
/**
 * Telegram User Account Auth — jalankan SEKALI untuk generate session string.
 *
 * Cara pakai:
 *   node scripts/telegram-auth.js
 *
 * Atau via npm:
 *   npm run telegram:auth
 *
 * Setelah selesai:
 *   1. Copy SESSION STRING yang muncul di terminal
 *   2. Tambah ke .env:  TELEGRAM_SESSION=<string yang di-copy>
 *   3. Restart Ponyou
 *
 * Dapatkan API_ID & API_HASH:
 *   1. Buka https://my.telegram.org
 *   2. Login → "API Development Tools"
 *   3. Buat app baru → copy api_id dan api_hash
 *   4. Tambah ke .env:
 *      TELEGRAM_API_ID=1234567
 *      TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
 */

import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import * as readline from "readline";

const API_ID   = Number(process.env.TELEGRAM_API_ID   || 0);
const API_HASH = process.env.TELEGRAM_API_HASH         || "";

if (!API_ID || !API_HASH) {
  console.error("\n❌ TELEGRAM_API_ID dan TELEGRAM_API_HASH belum diset di .env");
  console.error("   Dapatkan di: https://my.telegram.org\n");
  process.exit(1);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  console.log("\n🔐 Telegram User Account Auth");
  console.log("─".repeat(40));
  console.log(`API_ID  : ${API_ID}`);
  console.log(`API_HASH: ${API_HASH.slice(0, 8)}...`);
  console.log("─".repeat(40));
  console.log();

  const existingSession = process.env.TELEGRAM_SESSION || "";
  const session = new StringSession(existingSession);

  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => {
      return await ask("📱 Nomor HP (format internasional, contoh +6281234567890): ");
    },
    password: async () => {
      return await ask("🔒 Password 2FA (kosongkan jika tidak ada 2FA): ");
    },
    phoneCode: async () => {
      return await ask("📨 Kode OTP yang dikirim Telegram: ");
    },
    onError: (err) => {
      console.error("Error:", err.message);
    },
  });

  const me = await client.getMe();
  const sessionStr = client.session.save();

  console.log("\n" + "─".repeat(40));
  console.log(`✅ Berhasil login sebagai: ${me.firstName} ${me.lastName || ""}`.trim());
  console.log("   Username: @" + (me.username || "-"));
  console.log("   Phone   : " + me.phone);
  console.log("─".repeat(40));
  console.log("\n📋 SESSION STRING (copy ke .env sebagai TELEGRAM_SESSION=...):");
  console.log("\n" + sessionStr + "\n");
  console.log("─".repeat(40));
  console.log("Tambahkan ke .env:");
  console.log(`TELEGRAM_SESSION=${sessionStr}`);
  console.log("─".repeat(40) + "\n");

  await client.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error("Auth failed:", e.message);
  process.exit(1);
});
