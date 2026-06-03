#!/usr/bin/env node
/**
 * setup-secondbrain.mjs — interactive wizard to connect the Ponyou Second Brain
 * (Obsidian vault) to a private GitHub repo, with optional Obsidian Git or paid
 * Obsidian Sync on the operator's devices.
 *
 * Run: node scripts/setup-secondbrain.mjs
 *      npm run secondbrain:setup
 *
 * Non-interactive (CI / scripted):
 *      node scripts/setup-secondbrain.mjs --method obsidian-git --remote https://github.com/me/brain.git --yes
 *
 * The bot always pushes the vault to GitHub (source of truth). The chosen
 * method only changes how YOU read it on your devices.
 */

import * as readline from "readline";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  getVaultDir,
  validateRemoteUrl,
  buildVaultGitignore,
  detectSyncState,
  saveSyncConfig,
  buildSetupPlan,
  SYNC_METHODS,
} from "../secondbrain-sync.js";

// ─── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}
const FLAG_YES = args.includes("--yes") || args.includes("-y");
const ARG_METHOD = arg("method");
const ARG_REMOTE = arg("remote");

const VAULT = getVaultDir();

// ─── IO helpers ──────────────────────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}
const C = {
  b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
  c: s => `\x1b[36m${s}\x1b[0m`,
};
function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: opts.loud ? "inherit" : ["pipe", "pipe", "pipe"], ...opts });
}
function tryRun(cmd) { try { return run(cmd).trim(); } catch { return null; } }

// ─── Wizard ────────────────────────────────────────────────────────────────
async function main() {
  console.log(C.b("\n🧠 Ponyou Second Brain — Setup Wizard\n"));
  console.log(C.dim(`Vault: ${VAULT}\n`));

  // 0. Vault must exist
  if (!fs.existsSync(VAULT)) {
    console.log(C.r(`❌ Vault tidak ditemukan di ${VAULT}.`));
    console.log(C.dim("   Jalankan bot sekali (vault intelligence ON) agar template dibuat, lalu ulangi."));
    process.exit(1);
  }

  const state = detectSyncState(VAULT, tryRun);
  console.log(C.b("Status saat ini:"));
  console.log(`  git repo : ${state.isGitRepo ? C.g("ya") : C.y("belum")}`);
  console.log(`  remote   : ${state.hasRemote ? C.g(state.remoteUrl) : C.y("belum ada")}`);
  console.log(`  metode   : ${state.method ? C.c(state.method) : C.dim("belum dipilih")}\n`);

  // 1. Choose read method
  let method = ARG_METHOD;
  if (!method) {
    console.log(C.b("Bagaimana kamu mau MEMBACA vault di perangkatmu?"));
    console.log(`  ${C.c("1")}) Obsidian Git plugin  ${C.dim("(gratis — auto-pull dari GitHub)")}`);
    console.log(`  ${C.c("2")}) Obsidian Sync        ${C.dim("(berbayar — sinkron antar device kamu)")}`);
    console.log(`  ${C.c("3")}) Git saja             ${C.dim("(clone/web, tanpa app Obsidian)")}`);
    const choice = (await ask(C.b("\nPilih [1/2/3] (default 1): "))) || "1";
    method = { "1": "obsidian-git", "2": "obsidian-sync", "3": "git-only" }[choice] || "obsidian-git";
  }
  if (!SYNC_METHODS.includes(method)) {
    console.log(C.r(`Metode "${method}" tidak dikenal. Pakai: ${SYNC_METHODS.join(", ")}`));
    process.exit(1);
  }
  console.log(C.g(`\n✓ Metode: ${method}\n`));

  // 2. GitHub remote
  let remoteUrl = ARG_REMOTE || state.remoteUrl || null;
  if (!remoteUrl) {
    const ghReady = !!tryRun("gh auth status");
    if (ghReady) {
      console.log(C.b("GitHub CLI terdeteksi & login. Buat repo private otomatis?"));
      const create = FLAG_YES ? "y" : (await ask("  Buat repo private baru via gh? [y/N]: ")).toLowerCase();
      if (create === "y") {
        const defaultName = "ponyou-brain";
        const name = (FLAG_YES ? "" : await ask(`  Nama repo (default ${defaultName}): `)) || defaultName;
        console.log(C.dim(`  Membuat private repo "${name}"...`));
        const created = tryRun(`gh repo create ${name} --private --source="${VAULT}" --remote=origin 2>&1`)
          || tryRun(`gh repo create ${name} --private 2>&1`);
        if (created) {
          const user = tryRun("gh api user --jq .login");
          remoteUrl = `https://github.com/${user}/${name}.git`;
          console.log(C.g(`  ✓ Repo dibuat: ${remoteUrl}`));
        } else {
          console.log(C.y("  ⚠ gh repo create gagal — masukkan URL manual."));
        }
      }
    } else {
      console.log(C.dim("GitHub CLI belum login (jalankan `gh auth login` untuk auto-create)."));
    }
    if (!remoteUrl) {
      remoteUrl = await ask(C.b("\nURL repo private GitHub (kosongkan untuk skip push): "));
      remoteUrl = remoteUrl || null;
    }
  }

  if (remoteUrl) {
    const v = validateRemoteUrl(remoteUrl);
    if (!v.valid) {
      console.log(C.r(`❌ URL tidak valid: ${v.reason}`));
      process.exit(1);
    }
    console.log(C.g(`✓ Remote: ${v.owner}/${v.repo} (${v.protocol})\n`));
  }

  // 3. Build + confirm plan
  const plan = buildSetupPlan({ method, remoteUrl, state });
  console.log(C.b("Rencana setup (sisi git / bot):"));
  plan.gitSteps.forEach(s => console.log(`  • ${s}`));
  if (plan.warnings.length) {
    console.log(C.y("\nCatatan:"));
    plan.warnings.forEach(w => console.log(C.y(`  ⚠ ${w}`)));
  }
  if (!FLAG_YES) {
    const ok = (await ask(C.b("\nLanjutkan? [Y/n]: "))).toLowerCase();
    if (ok === "n") { console.log("Dibatalkan."); process.exit(0); }
  }

  // 4. Execute git side
  console.log(C.b("\nMenjalankan...\n"));
  if (!state.isGitRepo) { run(`git -C "${VAULT}" init -b main`); console.log(C.g("  ✓ git init")); }
  fs.writeFileSync(path.join(VAULT, ".gitignore"), buildVaultGitignore());
  console.log(C.g("  ✓ .gitignore ditulis"));

  if (remoteUrl) {
    if (state.hasRemote) run(`git -C "${VAULT}" remote set-url origin "${remoteUrl}"`);
    else run(`git -C "${VAULT}" remote add origin "${remoteUrl}"`);
    console.log(C.g(`  ✓ remote origin → ${remoteUrl}`));
  }

  run(`git -C "${VAULT}" add -A`);
  const dirty = tryRun(`git -C "${VAULT}" status --porcelain`);
  if (dirty) {
    run(`git -C "${VAULT}" commit -m "chore: second brain sync setup" --no-verify`);
    console.log(C.g("  ✓ commit awal"));
  } else {
    console.log(C.dim("  • tidak ada perubahan untuk di-commit"));
  }

  if (remoteUrl) {
    const pushed = tryRun(`git -C "${VAULT}" push -u origin main 2>&1`);
    if (pushed !== null) console.log(C.g("  ✓ push ke origin/main"));
    else {
      console.log(C.y("  ⚠ push gagal — kemungkinan butuh auth."));
      console.log(C.dim("    https: gunakan Personal Access Token sebagai password."));
      console.log(C.dim("    ssh  : pastikan SSH key terdaftar di GitHub, lalu: git -C " + VAULT + " push -u origin main"));
    }
  }

  // 5. Persist config
  const saved = saveSyncConfig({ method, remoteUrl, autoPush: !!remoteUrl }, VAULT);
  console.log(C.g(`  ✓ config disimpan → .secondbrain-sync.json`));

  // 6. Device-side instructions
  console.log(C.b("\n📱 Setup di perangkat kamu:\n"));
  plan.deviceInstructions.forEach((s, i) => console.log(`  ${C.c(String(i + 1))}. ${s}`));

  console.log(C.b("\n✅ Selesai.\n"));
  console.log(C.dim("Bot akan auto-commit+push vault tiap refresh (refresh-brain.js gitSync)."));
  console.log(C.dim(`Cek status: node -e "import('./secondbrain-sync.js').then(m=>console.log(m.buildSyncStatus()))"`));
  console.log(C.dim(JSON.stringify(saved)) + "\n");
}

main().catch(e => { console.error(C.r(`\n❌ ${e.message}\n`)); process.exit(1); });
