// dashboard/public/app.js

// ─── Auth helper ──────────────────────────────────────
function authFetch(url, opts = {}) {
  const token = localStorage.getItem("dashToken") || "";
  return fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), "Authorization": `Bearer ${token}` },
  });
}

// ─── Tab switching ────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "commands") loadPending();
    if (btn.dataset.tab === "strategylab") {
      loadPortfolioBook();
      loadSkillLoop();
      loadSkillRegistry();
    }
    if (btn.dataset.tab === "settings") {
      loadQuickConfig();
      loadTrashWallets();
      loadSmartWallets();
      loadPriorityWallets();
      loadCopyTradeConfig();
      loadPositionLimits();
      loadStrategyOverrides();
      loadFeeTracker();
      loadWalletSignals();
      loadDevWallets();
      loadTokenBlacklist();
      loadHunterConfig();
    }
  });
});

// ─── WebSocket ────────────────────────────────────────
const ws = new WebSocket(`ws://${location.host}`);

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.type === "state") applyState(msg.data);
  if (msg.type === "log") appendLog(msg.data);
  if (msg.type === "alert") showToast(msg.data.message);
};

ws.onclose = () => {
  document.getElementById("statusText").textContent = "Disconnected";
  document.getElementById("statusDot").classList.remove("running");
};

// ─── State application ───────────────────────────────
function applyState(s) {
  const dot = document.getElementById("statusDot");
  dot.classList.toggle("running", s.bot_running);
  document.getElementById("statusText").textContent = s.bot_running ? "RUNNING" : "STOPPED";
  document.getElementById("balance").textContent = `${(s.balance_sol||0).toFixed(4)} SOL`;
  const pnlEl = document.getElementById("pnlToday");
  const pnl = s.pnl_today_usd || 0;
  pnlEl.textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} session`;
  pnlEl.className = `pnl ${pnl >= 0 ? "positive" : "negative"}`;

  const tbody = document.getElementById("positionsBody");
  if (!s.positions?.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--muted)">No open positions</td></tr>`;
  } else {
    tbody.innerHTML = s.positions.map(p => `
      <tr>
        <td>${p.symbol}</td>
        <td class="${p.pnl_pct >= 0 ? "pnl-pos" : "pnl-neg"}">${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(1)}%</td>
        <td>${p.hold_minutes}m</td>
        <td>${p.entry_sol} SOL</td>
        <td>—</td>
      </tr>`).join("");
  }

  const f = s.features || {};
  setToggle("vault", f.vault_enabled);
  setToggle("tradingPlan", f.trading_plan_enabled);
  setToggle("dailyGuard", f.daily_guard_enabled);
  setToggle("confirm", f.confirm_mode);
  setToggle("trashFilter", f.trash_filter_enabled);
  setToggle("devBlacklist", f.dev_blacklist_enabled);
  setToggle("stagedEntry", f.staged_entry_enabled);
  setToggle("dayPhaseScreener", f.day_phase_enabled);
  setToggle("strategyEvolution", f.strategy_evolution_enabled);

  const tp = s.trading_plan || {};
  const planWrap = document.getElementById("planProgress");
  if (tp.enabled) {
    planWrap.hidden = false;
    document.getElementById("planProgressText").textContent = `${tp.trades_completed}/${tp.target}`;
    document.getElementById("planProgressBar").style.width =
      `${tp.target > 0 ? (tp.trades_completed / tp.target * 100) : 0}%`;
  } else {
    planWrap.hidden = true;
  }
}

function setToggle(id, val) {
  const el = document.getElementById(`toggle-${id}`);
  if (el) el.checked = Boolean(val);
}

// ─── Log panel ───────────────────────────────────────
let autoScroll = true;
const logList = document.getElementById("logList");

function appendLog({ ts, level, message }) {
  const div = document.createElement("div");
  div.className = "log-line";
  div.innerHTML = `<span class="ts">${ts?.slice(11,19) || ""}</span> <span class="level-${level}">[${level}]</span> ${escHtml(message)}`;
  logList.appendChild(div);
  if (logList.children.length > 200) logList.removeChild(logList.firstChild);
  if (autoScroll) logList.scrollTop = logList.scrollHeight;
}

function clearLog() { logList.innerHTML = ""; }

// ─── API helpers ─────────────────────────────────────
async function post(url, body) {
  const res = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendCmd(cmd, args = []) {
  const parts = cmd.trim().split(/\s+/);
  const c = parts[0];
  const a = [...parts.slice(1), ...args];
  const data = await post("/api/cmd", { cmd: c, args: a });
  showToast(data.response || (data.ok ? "Done" : data.error || "Error"), data.ok !== false);
  return data;
}

async function toggleFeature(feature, enabled) {
  await post("/api/toggle", { feature, enabled });
}

async function setStrategy() {
  const val = document.getElementById("stratSelect")?.value;
  if (val) await sendCmd(`/strategy ${val}`);
}

async function setStrategy2() {
  const val = document.getElementById("stratSelect2")?.value;
  if (val) await sendCmd(`/strategy ${val}`);
}

async function resetPlan() {
  const data = await post("/api/resetplan", {});
  showToast(`Plan reset. 0/${data.status?.target || 30} trades`, true);
}

async function killToken() {
  const mint = document.getElementById("killMint")?.value?.trim();
  if (!mint) return showToast("Enter a mint address", false);
  await sendCmd("/kill", [mint]);
}

async function unkillToken() {
  const mint = document.getElementById("killMint")?.value?.trim();
  if (!mint) return showToast("Enter a mint address", false);
  await sendCmd("/unkill", [mint]);
}

// ─── Pending intents ──────────────────────────────────
async function loadPending() {
  const data = await sendCmd("/pending");
  const el = document.getElementById("pendingList");
  if (el) el.textContent = data.response || "No pending intents";
}

// ─── Settings quick config ────────────────────────────
async function loadQuickConfig() {
  const cfg = await authFetch("/api/config").then(r => r.json());
  const qc = document.getElementById("quickConfig");
  if (!qc) return;
  qc.innerHTML = `
    <div class="field-row"><label>Deploy Amount (SOL)</label><input type="number" id="qc-deploy" value="${cfg.deployAmountSol || 0.5}"></div>
    <div class="field-row"><label>Max Positions</label><input type="number" id="qc-maxpos" value="${cfg.maxPositions || 3}"></div>
    <div class="field-row"><label>Stop Loss %</label><input type="number" id="qc-sl" value="${cfg.stopLossPct || ""}"></div>
    <div class="field-row"><label>Take Profit %</label><input type="number" id="qc-tp" value="${cfg.takeProfitPct || ""}"></div>
    <div class="field-row"><label>Daily Target %</label><input type="number" id="qc-dt" value="${cfg.dailyTargetPct || 25}"></div>
  `;
}

async function saveQuickConfig() {
  const body = {
    deployAmountSol: Number(document.getElementById("qc-deploy")?.value),
    maxPositions: Number(document.getElementById("qc-maxpos")?.value),
    stopLossPct: Number(document.getElementById("qc-sl")?.value) || null,
    takeProfitPct: Number(document.getElementById("qc-tp")?.value) || null,
    dailyTargetPct: Number(document.getElementById("qc-dt")?.value),
  };
  const res = await post("/wizard/save", body);
  showToast(res.ok ? "✅ Saved" : res.error, res.ok);
}

// ─── Trash Wallet management ─────────────────────────
async function loadTrashWallets() {
  const cfg = await authFetch("/api/config").then(r => r.json());
  const list = cfg.trashWallets || [];
  const el = document.getElementById("trashWalletsList");
  if (!el) return;
  if (list.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px">No trash wallets configured.</div>`;
    return;
  }
  el.innerHTML = list.map((w, i) => {
    const addr = typeof w === "string" ? w : (w?.address || "");
    const label = (w && w.label) || "";
    const display = label ? `${label} — ${addr}` : addr;
    const shortAddr = addr.length > 12 ? `${addr.slice(0,6)}…${addr.slice(-4)}` : addr;
    return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);padding:.4rem .6rem;border-radius:4px;margin-bottom:.3rem;font-family:monospace;font-size:12px">
      <span title="${addr}">${label ? `<strong>${escHtml(label)}</strong> — ` : ""}${shortAddr}</span>
      <button class="btn" onclick="removeTrashWallet(${i})" style="font-size:11px;padding:.15rem .5rem">− Remove</button>
    </div>`;
  }).join("");
}

async function addTrashWallet() {
  const addrInput = document.getElementById("newTrashWallet");
  const labelInput = document.getElementById("newTrashWalletLabel");
  const addr = addrInput?.value?.trim();
  if (!addr) return showToast("Enter a wallet address", false);
  const cfg = await authFetch("/api/config").then(r => r.json());
  const list = (cfg.trashWallets || []).map(w => typeof w === "string" ? { address: w } : w);
  const label = labelInput?.value?.trim() || "";
  list.push(label ? { address: addr, label } : { address: addr });
  const res = await post("/api/trash-wallets", { action: "set", wallets: list });
  if (res.ok) {
    if (addrInput) addrInput.value = "";
    if (labelInput) labelInput.value = "";
    loadTrashWallets();
    showToast("Trash wallet added", true);
  } else {
    showToast(res.error || "Failed to add", false);
  }
}

async function removeTrashWallet(idx) {
  const cfg = await authFetch("/api/config").then(r => r.json());
  const list = (cfg.trashWallets || []).map(w => typeof w === "string" ? { address: w } : w);
  list.splice(idx, 1);
  const res = await post("/api/trash-wallets", { action: "set", wallets: list });
  if (res.ok) { loadTrashWallets(); showToast("Trash wallet removed", true); }
  else showToast(res.error || "Failed to remove", false);
}

// ─── Smart Wallets management ─────────────────────────
async function loadSmartWallets() {
  const data = await authFetch("/api/smart-wallets").then(r => r.json());
  const wallets = data.wallets || [];
  const el = document.getElementById("smartWalletsList");
  if (!el) return;
  if (wallets.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px">No smart wallets tracked.</div>`;
    return;
  }
  el.innerHTML = wallets.map(w => {
    const addr = w.address || "";
    const label = w.label || "";
    const score = w.selection?.score || 0;
    const mode = w.follow_mode || "shadow";
    const shortAddr = addr.length > 12 ? `${addr.slice(0,6)}…${addr.slice(-4)}` : addr;
    return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);padding:.4rem .6rem;border-radius:4px;margin-bottom:.3rem;font-size:12px">
      <span title="${addr}" style="font-family:monospace">${label ? `<strong>${escHtml(label)}</strong> — ` : ""}${shortAddr} <span style="color:var(--muted)">score:${score} ${mode}</span></span>
      <button class="btn" onclick="removeSmartWalletUI('${addr}')" style="font-size:11px;padding:.15rem .5rem">− Remove</button>
    </div>`;
  }).join("");
}

async function addSmartWalletUI() {
  const addrEl = document.getElementById("newSmartWallet");
  const labelEl = document.getElementById("newSmartWalletLabel");
  const addr = addrEl?.value?.trim();
  if (!addr) return showToast("Enter a wallet address", false);
  const label = labelEl?.value?.trim() || "";
  const res = await post("/api/smart-wallets", { action: "add", address: addr, label });
  if (res.saved || res.ok) {
    if (addrEl) addrEl.value = "";
    if (labelEl) labelEl.value = "";
    loadSmartWallets();
    showToast("Smart wallet added", true);
  } else {
    showToast(res.error || "Failed to add", false);
  }
}

async function removeSmartWalletUI(address) {
  const res = await post("/api/smart-wallets", { action: "remove", address });
  if (res.removed || res.ok) { loadSmartWallets(); showToast("Smart wallet removed", true); }
  else showToast(res.error || "Failed to remove", false);
}

// ─── Dev / Rug Wallets management ─────────────────────
async function loadDevWallets() {
  const data = await authFetch("/api/dev-wallets").then(r => r.json());
  const devs = data.devs || [];
  const el = document.getElementById("devWalletsList");
  if (!el) return;
  if (devs.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px">No dev wallets blocked.</div>`;
    return;
  }
  el.innerHTML = devs.map(d => {
    const addr = d.address || "";
    const reason = d.reason || "";
    const added = d.added_at ? ` — added ${d.added_at.slice(0,10)}` : "";
    const shortAddr = addr.length > 12 ? `${addr.slice(0,6)}…${addr.slice(-4)}` : addr;
    return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);padding:.4rem .6rem;border-radius:4px;margin-bottom:.3rem;font-size:12px">
      <span title="${addr}" style="font-family:monospace">${shortAddr} ${reason ? `<span style="color:var(--warn)">— ${escHtml(reason)}</span>` : ""}<span style="color:var(--muted)">${added}</span></span>
      <button class="btn" onclick="removeDevWalletUI('${addr}')" style="font-size:11px;padding:.15rem .5rem">− Remove</button>
    </div>`;
  }).join("");
}

async function addDevWalletUI() {
  const addrEl = document.getElementById("newDevWallet");
  const reasonEl = document.getElementById("newDevWalletReason");
  const addr = addrEl?.value?.trim();
  if (!addr) return showToast("Enter a wallet address", false);
  const reason = reasonEl?.value?.trim() || "";
  const res = await post("/api/dev-wallets", { action: "add", address: addr, reason });
  if (res.saved || res.ok) {
    if (addrEl) addrEl.value = "";
    if (reasonEl) reasonEl.value = "";
    loadDevWallets();
    showToast("Dev wallet blocked", true);
  } else {
    showToast(res.error || "Failed to add", false);
  }
}

async function removeDevWalletUI(address) {
  const res = await post("/api/dev-wallets", { action: "remove", address });
  if (res.removed || res.ok) { loadDevWallets(); showToast("Dev wallet unblocked", true); }
  else showToast(res.error || "Failed to remove", false);
}

// ─── Token Blacklist management ───────────────────────
async function loadTokenBlacklist() {
  const data = await authFetch("/api/token-blacklist").then(r => r.json());
  const tokens = data.tokens || [];
  const el = document.getElementById("tokenBlacklistList");
  if (!el) return;
  if (tokens.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px">No tokens blacklisted.</div>`;
    return;
  }
  el.innerHTML = tokens.map(t => {
    const mint = t.mint || "";
    const reason = t.reason || "";
    const added = t.added_at ? ` — ${t.added_at.slice(0,10)}` : "";
    const shortMint = mint.length > 12 ? `${mint.slice(0,6)}…${mint.slice(-4)}` : mint;
    return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);padding:.4rem .6rem;border-radius:4px;margin-bottom:.3rem;font-size:12px">
      <span title="${mint}" style="font-family:monospace">${shortMint} ${reason ? `<span style="color:var(--warn)">— ${escHtml(reason)}</span>` : ""}<span style="color:var(--muted)">${added}</span></span>
      <button class="btn" onclick="removeTokenBlacklistUI('${mint}')" style="font-size:11px;padding:.15rem .5rem">− Remove</button>
    </div>`;
  }).join("");
}

async function addTokenBlacklistUI() {
  const mintEl = document.getElementById("newTokenBlacklist");
  const reasonEl = document.getElementById("newTokenBlacklistReason");
  const mint = mintEl?.value?.trim();
  if (!mint) return showToast("Enter a token mint address", false);
  const reason = reasonEl?.value?.trim() || "";
  const res = await post("/api/token-blacklist", { action: "add", mint, reason });
  if (res.saved || res.ok) {
    if (mintEl) mintEl.value = "";
    if (reasonEl) reasonEl.value = "";
    loadTokenBlacklist();
    showToast("Token blacklisted", true);
  } else {
    showToast(res.error || "Failed to add", false);
  }
}

async function removeTokenBlacklistUI(mint) {
  const res = await post("/api/token-blacklist", { action: "remove", mint });
  if (res.removed || res.ok) { loadTokenBlacklist(); showToast("Token removed from blacklist", true); }
  else showToast(res.error || "Failed to remove", false);
}

// ─── Hunter Agent Config ──────────────────────────────
const DEFAULT_HUNTER = {
  enabled: true,
  sources: ["search", "pumpfun", "gainers", "newest", "geckoterminal", "smart_money", "jupiter"],
  minLiquidity: 500,
  minSwaps: 5,
  minMcap: 5000,
  maxAgeHours: 168,
  minAgeMinutes: 5,
  customQueries: [],
};
const HUNTER_SOURCE_LABELS = {
  search: "DexScreener Multi-Query Search",
  pumpfun: "pump.fun Ecosystem",
  gainers: "Top Gainers (Momentum)",
  newest: "Newest Launches",
  geckoterminal: "GeckoTerminal Trending",
  smart_money: "Smart Money Inflow",
  jupiter: "Jupiter Active Pairs",
};

async function loadHunterConfig() {
  const data = await authFetch("/api/hunter-config").then(r => r.json());
  const h = data.hunter || DEFAULT_HUNTER;
  const el = document.getElementById("hunterConfigForm");
  if (!el) return;
  const sources = ["search", "pumpfun", "gainers", "newest", "geckoterminal", "smart_money", "jupiter"];
  const sourceChecks = sources.map(s => {
    const checked = (h.sources || DEFAULT_HUNTER.sources).includes(s);
    return `<label style="display:flex;align-items:center;gap:.4rem;font-size:13px;padding:.2rem 0">
      <input type="checkbox" data-hunter-source="${s}" ${checked ? "checked" : ""}> ${HUNTER_SOURCE_LABELS[s] || s}
    </label>`;
  }).join("");
  const queries = (h.customQueries || []).join(", ");
  el.innerHTML = `
    <div class="field-row"><label>Enable Hunter Agent</label>
      <label class="toggle"><input type="checkbox" id="hunterEnabled" ${h.enabled !== false ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div class="field-row" style="margin-top:.75rem"><label>Hunting Sources</label>
      <div style="background:var(--bg);padding:.5rem;border-radius:6px;margin-top:.25rem">${sourceChecks}</div>
    </div>
    <div class="field-row" style="margin-top:.75rem"><label>Min Liquidity ($)</label>
      <input type="number" id="hunterMinLiq" value="${h.minLiquidity || 500}" style="width:100%">
    </div>
    <div class="field-row"><label>Min Swaps</label>
      <input type="number" id="hunterMinSwaps" value="${h.minSwaps || 5}" style="width:100%">
    </div>
    <div class="field-row"><label>Min Market Cap ($)</label>
      <input type="number" id="hunterMinMcap" value="${h.minMcap || 5000}" style="width:100%">
    </div>
    <div class="field-row"><label>Max Token Age (hours)</label>
      <input type="number" id="hunterMaxAgeH" value="${h.maxAgeHours || 168}" style="width:100%">
    </div>
    <div class="field-row"><label>Min Token Age (minutes)</label>
      <input type="number" id="hunterMinAgeM" value="${h.minAgeMinutes || 5}" style="width:100%">
    </div>
    <div class="field-row"><label>Custom Search Queries (comma-separated, max 30)</label>
      <input type="text" id="hunterCustomQueries" value="${escHtml(queries)}" placeholder="e.g. ai, meme, gaming, defi" style="width:100%">
      <div class="field-hint">Kata kunci tambahan untuk dicari hunter di DexScreener</div>
    </div>`;
}

async function saveHunterConfig() {
  const enabled = document.getElementById("hunterEnabled")?.checked !== false;
  const sources = [];
  document.querySelectorAll("[data-hunter-source]").forEach(cb => {
    if (cb.checked) sources.push(cb.dataset.hunterSource);
  });
  const hunter = {
    enabled,
    sources,
    minLiquidity: Number(document.getElementById("hunterMinLiq")?.value) || 500,
    minSwaps: Number(document.getElementById("hunterMinSwaps")?.value) || 5,
    minMcap: Number(document.getElementById("hunterMinMcap")?.value) || 5000,
    maxAgeHours: Number(document.getElementById("hunterMaxAgeH")?.value) || 168,
    minAgeMinutes: Number(document.getElementById("hunterMinAgeM")?.value) || 5,
    customQueries: String(document.getElementById("hunterCustomQueries")?.value || "")
      .split(",").map(s => s.trim()).filter(Boolean).slice(0, 30),
  };
  const res = await post("/api/hunter-config", { hunter });
  showToast(res.ok ? "✅ Hunter config saved" : res.error, res.ok);
}

// ─── Strategy Overrides (per-strategy SL/TP) ─────────
async function loadStrategyOverrides() {
  const data = await authFetch("/api/strategy-overrides").then(r => r.json());
  const strategies = data.strategies || [];
  const el = document.getElementById("strategySLTPPanel");
  if (!el) return;

  let html = `<div style="overflow-x:auto">
    <div style="display:grid;grid-template-columns:90px 70px 130px 120px 100px;gap:.3rem;font-size:11px;color:var(--muted);padding:.2rem .5rem;white-space:nowrap">
      <span>Strategy</span><span>Stop Loss</span><span>Trailing (trigger/drop)</span><span>Partial TP (at/sell)</span><span>Source</span>
    </div>`;

  strategies.forEach(s => {
    const ts = s.trailing_stop || {};
    const pt = s.partial_tp || {};

    html += `
    <div style="display:grid;grid-template-columns:90px 70px 130px 120px 100px;gap:.3rem;align-items:center;background:var(--bg);padding:.3rem .5rem;border-radius:4px;margin-bottom:.2rem;font-size:12px">
      <span style="font-weight:600;white-space:nowrap">${STRATEGY_LABELS[s.id] || s.id}</span>
      <input type="number" data-sl-id="${s.id}" data-sl-key="stoploss" value="${s.stoploss || -0.15}" step="0.01" min="-1" max="0"
        style="width:65px;font-size:11px;text-align:center">
      <span style="display:flex;gap:.2rem;align-items:center;white-space:nowrap">
        <input type="checkbox" data-sl-id="${s.id}" data-sl-key="trailing_enabled" ${ts.enabled ? "checked" : ""} style="width:14px;height:14px">
        <input type="number" data-sl-id="${s.id}" data-sl-key="trailing_offset" value="${ts.positive_offset || 0.20}" step="0.01" min="0" max="5" style="width:45px;font-size:11px;text-align:center" ${!ts.enabled ? "disabled" : ""}>
        /
        <input type="number" data-sl-id="${s.id}" data-sl-key="trailing_distance" value="${ts.positive_distance || 0.05}" step="0.01" min="0" max="1" style="width:45px;font-size:11px;text-align:center" ${!ts.enabled ? "disabled" : ""}>
      </span>
      <span style="display:flex;gap:.2rem;align-items:center;white-space:nowrap">
        <input type="checkbox" data-sl-id="${s.id}" data-sl-key="partial_tp_enabled" ${pt.enabled ? "checked" : ""} style="width:14px;height:14px">
        <input type="number" data-sl-id="${s.id}" data-sl-key="partial_tp_at" value="${pt.at_pct || 100}" step="5" min="0" max="1000" style="width:45px;font-size:11px;text-align:center" ${!pt.enabled ? "disabled" : ""}>
        /
        <input type="number" data-sl-id="${s.id}" data-sl-key="partial_tp_sell" value="${pt.sell_pct || 50}" step="5" min="0" max="100" style="width:45px;font-size:11px;text-align:center" ${!pt.enabled ? "disabled" : ""}>
      </span>
      <span style="font-size:10px;color:${s._source === 'preset' ? 'var(--muted)' : 'var(--ok)'}">${s._source}</span>
    </div>`;
  });

  // ROI table per strategy (collapsed)
  html += `<details style="margin-top:.5rem"><summary style="font-size:12px;cursor:pointer;color:var(--muted)">ROI Table (Take Profit ladder)</summary><div style="font-size:11px;margin-top:.3rem">`;
  strategies.forEach(s => {
    const roi = s.minimal_roi || {};
    const roiStr = Object.entries(roi).map(([min, pct]) => `T+${min}m: ${(pct*100).toFixed(0)}%`).join(" → ");
    html += `<div style="padding:.2rem 0"><strong>${STRATEGY_LABELS[s.id] || s.id}:</strong> ${roiStr || "none"}</div>`;
  });
  html += `<div style="color:var(--muted);margin-top:.3rem">ROI table = take profit ladder. "T+0m: 60%" = jika PnL ≥ 60% dalam 0 menit, close. "T+60m: 0%" = setelah 60 menit, close di breakeven.</div>`;
  html += `</div></details>`;

  html += `</div>`;
  el.innerHTML = html;
}

function collectStrategyOverrides() {
  const overrides = {};
  document.querySelectorAll("[data-sl-id]").forEach(el => {
    const id = el.dataset.slId;
    const key = el.dataset.slKey;
    let value;
    if (el.type === "checkbox") value = el.checked;
    else value = parseFloat(el.value);
    if (!overrides[id]) overrides[id] = {};
    overrides[id][key] = value;
  });
  return overrides;
}

async function saveStrategyOverrides() {
  const overrides = collectStrategyOverrides();
  const res = await post("/api/strategy-overrides", { action: "set_bulk", overrides });
  showToast(res.ok ? "✅ Strategy SL/TP saved" : res.error, res.ok);
  if (res.ok) loadStrategyOverrides();
}

async function resetStrategyOverrides() {
  const res = await post("/api/strategy-overrides", { action: "reset" });
  showToast(res.ok ? "✅ Reset to defaults" : res.error, res.ok);
  if (res.ok) loadStrategyOverrides();
}

// ─── Fee Tracker ──────────────────────────────────────
async function loadFeeTracker() {
  const data = await authFetch("/api/fee-tracker").then(r => r.json());
  const el = document.getElementById("feeTrackerPanel");
  if (!el) return;

  let html = `<div style="font-size:12px">`;

  // DEX Fee Registry
  html += `<div style="margin-bottom:.5rem"><strong>DEX Swap Fees</strong></div>`;
  html += `<div style="display:grid;grid-template-columns:1fr auto;gap:.2rem;font-size:11px;margin-bottom:.5rem">`;
  const uniqueDexes = {};
  (data.dexRegistry || []).forEach(d => {
    if (!uniqueDexes[d.fee_pct]) { uniqueDexes[d.fee_pct] = []; }
    uniqueDexes[d.fee_pct].push(d.name);
  });
  Object.entries(uniqueDexes).forEach(([fee, names]) => {
    html += `<span>${names.slice(0,3).join(", ")}${names.length > 3 ? ` +${names.length-3}` : ""}</span><span style="font-family:monospace;color:var(--warn)">${fee}</span>`;
  });
  html += `</div>`;

  // Platform Fees
  html += `<div style="margin-bottom:.5rem"><strong>Platform Fees (per trade)</strong></div>`;
  (data.platformFees || []).forEach(p => {
    html += `<div style="display:flex;justify-content:space-between;font-size:11px;margin:.1rem 0"><span>${p.name}</span><span style="font-family:monospace;color:#ef4444">${p.fee_pct} (buy+sell)</span></div>`;
  });

  // Rent & RPC costs
  const rent = data.rent || {};
  const rpc = data.rpc || {};
  html += `<div style="margin-top:.5rem;display:grid;grid-template-columns:1fr 1fr;gap:.5rem;font-size:11px">
    <div style="background:var(--bg);padding:.4rem;border-radius:4px">
      <div style="color:var(--muted)">Token Account Rent</div>
      <div>Created: <strong>${rent.accountsCreated || 0}</strong></div>
      <div>Closed: <strong>${rent.accountsClosed || 0}</strong></div>
      <div>Net cost: <strong>${(rent.netRentCostSol || 0).toFixed(6)} SOL</strong></div>
    </div>
    <div style="background:var(--bg);padding:.4rem;border-radius:4px">
      <div style="color:var(--muted)">RPC Costs (est.)</div>
      <div>Sim calls: <strong>${rpc.simCalls || 0}</strong></div>
      <div>Total RPC: <strong>${rpc.rpcCalls || 0}</strong></div>
      <div>Est. cost: <strong>${(rpc.estimatedTotalRpcCostSol || 0).toFixed(6)} SOL</strong></div>
    </div>
  </div>`;

  // Performance summary
  const perf = data.performance;
  if (perf) {
    html += `<div style="margin-top:.5rem;background:var(--bg);padding:.4rem;border-radius:4px;font-size:11px">
      <span style="color:var(--muted)">Performance: </span>
      <strong>${perf.totalTrades || 0} trades</strong> |
      WR: <strong style="color:${(perf.winRate||0) >= 50 ? 'var(--ok)' : '#ef4444'}">${(perf.winRate||0).toFixed(1)}%</strong> |
      Total PnL: <strong style="color:${(perf.totalPnlSol||0) >= 0 ? 'var(--ok)' : '#ef4444'}">${(perf.totalPnlSol||0).toFixed(4)} SOL</strong>
    </div>`;
  }

  // Fee drag explanation
  html += `<div style="margin-top:.5rem;font-size:10px;color:var(--muted);line-height:1.4">
    <strong>True PnL = Gross PnL - Σ(all fees)</strong><br>
    Fee breakdown per trade: DEX swap fee + platform fee + slippage + MEV loss + priority fee + Jito tip + tx fee + rent + RPC cost.<br>
    pump.fun tokens: 1% platform fee on BOTH entry AND exit = 2% round-trip before DEX fees.
  </div>`;

  html += `</div>`;
  el.innerHTML = html;
}

// ─── Position Limits (per-strategy, manual/kelly) ──────
const STRATEGY_LABELS = {
  scalp: "Scalping",
  sniper: "Sniper",
  dip_buy: "Dip Buy",
  conservative: "Conservative",
  aggressive: "Aggressive",
  recovery: "Recovery",
  day_phase_swing: "Day Phase Swing",
};

async function loadPositionLimits() {
  const data = await authFetch("/api/position-limits").then(r => r.json());
  const cfg = data.config || {};
  const currentLimit = data.currentLimit || 3;
  const activeStrategy = data.activeStrategy || "scalp";
  const kelly = data.kellyInfo;
  const perStrategy = data.perStrategyLimits || [];
  const el = document.getElementById("positionLimitsPanel");
  if (!el) return;

  const isKelly = cfg.mode === "kelly";
  let html = `
    <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.75rem;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--muted)">Mode:</span>
      <select id="plMode" onchange="onPositionLimitModeChange()" style="font-size:13px">
        <option value="manual" ${!isKelly ? "selected" : ""}>Manual — set angka per strategi</option>
        <option value="kelly" ${isKelly ? "selected" : ""}>Kelly Formula — auto dari win rate</option>
      </select>
      <span style="font-size:12px;color:var(--muted)">Active: <strong>${STRATEGY_LABELS[activeStrategy] || activeStrategy}</strong> → limit <strong>${currentLimit}</strong></span>
    </div>`;

  if (isKelly && kelly) {
    html += `
    <div style="background:var(--bg);padding:.5rem;border-radius:6px;margin-bottom:.5rem;font-size:12px">
      <strong>Kelly:</strong>
      WR: <span style="color:var(--ok)">${kelly.winRate || 0}%</span> |
      W/L: <span style="color:var(--ok)">+${kelly.avgWinPct || 0}%</span>/<span style="color:#ef4444">-${kelly.avgLossPct || 0}%</span> |
      R: <strong>${kelly.R || 0}</strong> |
      K%: <strong>${kelly.kellyPct || 0}%</strong> |
      Raw: <strong>${kelly.positions || 1}</strong> pos
      <div style="color:var(--muted);margin-top:.2rem">${kelly.reason || ""} (${kelly.dataPoints || 0} trades)</div>
    </div>
    <div class="field-row"><label>Kelly Fraction (0.1-1.0)</label>
      <input type="number" id="plKellyFraction" value="${cfg.kellyFraction || 0.5}" min="0.1" max="1" step="0.05" style="width:80px;font-size:12px" onchange="recalcKellyPositions()">
      <div class="field-hint">0.5 = half-Kelly (default). Fraction lebih kecil = lebih konservatif.</div>
    </div>`;
  }

  // Table header
  html += `<div style="margin-top:.75rem;display:grid;grid-template-columns:1fr 70px 85px 70px;gap:.3rem;font-size:11px;color:var(--muted);padding:0 .5rem">
    <span>Strategy</span><span>Max Pos</span><span>Min SOL</span><span>Max/Coin</span>
  </div>`;

  perStrategy.forEach(s => {
    const isActive = s.id === activeStrategy;
    const effLimit = isKelly && s.effectiveKellyLimit ? s.effectiveKellyLimit : s.maxPositions;
    html += `
    <div style="display:grid;grid-template-columns:1fr 70px 85px 70px;gap:.3rem;align-items:center;background:${isActive ? 'var(--bg)' : 'transparent'};padding:.3rem .5rem;border-radius:4px;${isActive ? 'border-left:3px solid var(--ok,#4ade80)' : ''}">
      <span style="font-size:12px;${isActive ? 'font-weight:600' : ''}">${STRATEGY_LABELS[s.id] || s.id}</span>
      <input type="number" data-pl-strategy="${s.id}" data-pl-field="maxPositions" value="${s.maxPositions}" min="1" max="20" step="1"
        style="width:60px;font-size:12px;text-align:center" ${isKelly ? "readonly" : ""}>
      <input type="number" data-pl-strategy="${s.id}" data-pl-field="minSol" value="${s.minSolToActivate}" min="0" max="100" step="0.1"
        style="width:75px;font-size:12px;text-align:center">
      <input type="number" data-pl-strategy="${s.id}" data-pl-field="maxPerCoin" value="${s.maxPerCoin}" min="1" max="10" step="1"
        style="width:60px;font-size:12px;text-align:center">
    </div>`;
  });

  html += `<div class="field-hint" style="margin-top:.5rem">Max Pos = max open positions. Min SOL = minimum SOL balance to open. Max/Coin = max entries per same token (1 = no double-dip).</div>`;
  el.innerHTML = html;
}

function onPositionLimitModeChange() {
  const mode = document.getElementById("plMode")?.value || "manual";
  const isKelly = mode === "kelly";
  document.querySelectorAll("[data-pl-strategy]").forEach(input => {
    input.readOnly = isKelly;
  });
  const kellySection = document.getElementById("plKellyFraction");
  if (isKelly && !kellySection) {
    loadPositionLimits(); // re-render to show kelly info
  }
}

async function recalcKellyPositions() {
  const kellyFraction = parseFloat(document.getElementById("plKellyFraction")?.value) || 0.5;
  const res = await post("/api/position-limits", { action: "kelly_calc", kellyFraction });
  if (res.ok && res.kelly) {
    const k = res.kelly;
    // Update per-strategy inputs with Kelly-calculated values
    const multipliers = {
      scalp: 1.2, sniper: 0.6, dip_buy: 1.0, conservative: 1.5,
      aggressive: 0.5, recovery: 0.3, day_phase_swing: 0.8,
    };
    document.querySelectorAll("[data-pl-strategy]").forEach(input => {
      const strategyId = input.dataset.plStrategy;
      const mult = multipliers[strategyId] || 1.0;
      const val = Math.max(1, Math.round(k.positions * mult));
      input.value = val;
    });
  }
}

async function savePositionLimits() {
  const mode = document.getElementById("plMode")?.value || "manual";
  const kellyFraction = parseFloat(document.getElementById("plKellyFraction")?.value) || 0.5;
  const perStrategy = {};
  // Collect all 3 fields per strategy
  const strategyIds = new Set();
  document.querySelectorAll("[data-pl-strategy]").forEach(input => {
    strategyIds.add(input.dataset.plStrategy);
  });
  strategyIds.forEach(id => {
    const maxPos = parseInt(document.querySelector(`[data-pl-strategy="${id}"][data-pl-field="maxPositions"]`)?.value) || 3;
    const minSol = parseFloat(document.querySelector(`[data-pl-strategy="${id}"][data-pl-field="minSol"]`)?.value) ?? 0.5;
    const maxPerCoin = parseInt(document.querySelector(`[data-pl-strategy="${id}"][data-pl-field="maxPerCoin"]`)?.value) || 1;
    perStrategy[id] = {
      maxPositions: Math.max(1, Math.min(20, maxPos)),
      minSolToActivate: Math.max(0, Number.isFinite(minSol) ? minSol : 0.5),
      maxPerCoin: Math.max(1, Math.min(10, maxPerCoin)),
    };
  });
  const positionLimits = { mode, kellyFraction, perStrategy };
  const res = await post("/api/position-limits", { action: "config", positionLimits });
  showToast(res.ok ? "✅ Position limits saved" : res.error, res.ok);
}

// ─── Wallet Signals (Smart Money → Screening, Rug Dev → Block) ──
async function loadWalletSignals() {
  const data = await authFetch("/api/wallet-signals").then(r => r.json());
  const smSignals = data.smartMoneySignals || [];
  const rugAlerts = data.rugAlerts || [];
  const stats = data.stats || {};
  const el = document.getElementById("walletSignalsPanel");
  if (!el) return;

  let html = `<div style="font-size:12px;color:var(--muted);margin-bottom:.75rem">
    Smart money injected: <strong>${stats.smSignalsInjected || 0}</strong> |
    Rug devs blocked: <strong style="color:var(--warn)">${stats.rugDevsBlocked || 0}</strong> |
    Last injection: <strong>${(stats.lastInjection || "never").slice(0,19)}</strong>
  </div>`;

  // Smart Money Signals
  html += `<div style="margin-bottom:.75rem"><strong style="font-size:13px">Smart Money Wallets (Active Signals)</strong></div>`;
  if (smSignals.length === 0) {
    html += `<div style="color:var(--muted);font-size:12px;margin-bottom:.75rem">No active smart money wallets. Tambah wallet dengan win rate >= 60% untuk melihat sinyal di sini.</div>`;
  } else {
    html += smSignals.map(s => {
      const wrColor = s.winRate >= 0.85 ? "var(--ok,#4ade80)" : s.winRate >= 0.70 ? "var(--warn,#fbbf24)" : "var(--muted)";
      const badge = s.signalStrength === "STRONG" ? "🟢" : s.signalStrength === "MODERATE" ? "🟡" : "⚪";
      return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);padding:.3rem .5rem;border-radius:4px;margin-bottom:.2rem;font-size:12px">
        <span style="font-family:monospace">${badge} ${escHtml(s.walletLabel || s.wallet.slice(0,8))}…</span>
        <span style="color:${wrColor};font-weight:600">WR: ${(s.winRate*100).toFixed(0)}%</span>
        <span style="color:var(--muted)">${s.followMode} | ${s.signalStrength}</span>
      </div>`;
    }).join("");
  }

  // Rug Dev Alerts
  html += `<div style="margin-top:1rem;margin-bottom:.5rem"><strong style="font-size:13px">Rug Dev Alerts (Auto-Block)</strong></div>`;
  if (rugAlerts.length === 0) {
    html += `<div style="color:var(--muted);font-size:12px">No recent rug dev alerts. Bot akan auto-block token dari known rug dev secara otomatis.</div>`;
  } else {
    html += rugAlerts.map(a => {
      return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);padding:.3rem .5rem;border-radius:4px;margin-bottom:.2rem;font-size:11px;border-left:3px solid var(--warn,#fbbf24)">
        <span style="font-family:monospace">🚫 ${escHtml(a.tokenSymbol || "?")} (${(a.tokenMint||"").slice(0,8)}…)</span>
        <span style="color:var(--warn)">${a.severity}</span>
        <span>dev: ${(a.creatorWallet||"").slice(0,8)}…</span>
        <span style="color:var(--muted)">${(a.detectedAt||"").slice(0,19)}</span>
      </div>`;
    }).join("");
  }

  el.innerHTML = html;
}

// ─── Priority Wallets ────────────────────────────────
async function loadPriorityWallets() {
  const minWr = parseFloat(document.getElementById("priorityMinWr")?.value) || 0.70;
  const data = await authFetch(`/api/priority-wallets?min_win_rate=${minWr}`).then(r => r.json());
  const wallets = data.wallets || [];
  const el = document.getElementById("priorityWalletsList");
  if (!el) return;
  if (wallets.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px">No wallets with win rate >= ${(minWr*100).toFixed(0)}%. Tambah smart wallet dengan performa tinggi untuk melihat di sini.</div>`;
    return;
  }
  el.innerHTML = wallets.map(w => {
    const addr = w.address || "";
    const label = w.label || "";
    const wr = (w.winRate * 100).toFixed(0);
    const shortAddr = addr.length > 12 ? `${addr.slice(0,6)}…${addr.slice(-4)}` : addr;
    const wrColor = w.winRate >= 0.85 ? "var(--ok, #4ade80)" : w.winRate >= 0.70 ? "var(--warn, #fbbf24)" : "var(--muted)";
    return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);padding:.4rem .6rem;border-radius:4px;margin-bottom:.3rem;font-size:12px">
      <span title="${addr}" style="font-family:monospace">${label ? `<strong>${escHtml(label)}</strong> — ` : ""}${shortAddr}</span>
      <span style="font-weight:600;color:${wrColor}">WR: ${wr}% | ${w.totalTrades} trades | ${w.realizedPnlSol.toFixed(2)} SOL</span>
    </div>`;
  }).join("");
}

// ─── Copy Trade Config & Signals ──────────────────────
async function loadCopyTradeConfig() {
  const data = await authFetch("/api/copy-trade").then(r => r.json());
  const cfg = data.config || {};
  const stats = data.stats || {};
  const form = document.getElementById("copyTradeForm");
  if (!form) return;

  const modes = [
    ["signal_only", "Signal Only — hanya notifikasi, tidak auto-trade"],
    ["confirm_copy", "Confirm Copy — perlu konfirmasi /yes sebelum copy"],
    ["auto_copy", "Auto Copy — otomatis mirror buy dari priority wallet"],
  ];
  const modeOpts = modes.map(([v, label]) =>
    `<option value="${v}" ${cfg.mode === v ? "selected" : ""}>${label}</option>`
  ).join("");

  form.innerHTML = `
    <div class="field-row"><label>Enable Copy Trade</label>
      <label class="toggle"><input type="checkbox" id="copyTradeEnabled" ${cfg.enabled ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div class="field-row" style="margin-top:.5rem"><label>Copy Trade Mode</label>
      <select id="copyTradeMode" style="width:100%">${modeOpts}</select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-top:.5rem">
      <div class="field-row"><label>Max Copy SOL</label>
        <input type="number" id="copyTradeMaxSol" value="${cfg.maxCopySol || 0.1}" step="0.01" min="0.01" style="width:100%">
      </div>
      <div class="field-row"><label>Min Wallet Win Rate</label>
        <input type="number" id="copyTradeMinWr" value="${cfg.minWalletWinRate || 0.70}" step="0.05" min="0" max="1" style="width:100%">
      </div>
      <div class="field-row"><label>Max Slippage %</label>
        <input type="number" id="copyTradeMaxSlip" value="${cfg.maxSlippagePct || 15}" step="1" min="0" style="width:100%">
      </div>
      <div class="field-row"><label>Cooldown (min)</label>
        <input type="number" id="copyTradeCooldown" value="${cfg.cooldownMinutes || 10}" step="1" min="0" style="width:100%">
      </div>
      <div class="field-row"><label>Max Copy/Day</label>
        <input type="number" id="copyTradeMaxDay" value="${cfg.maxCopyPerDay || 5}" step="1" min="0" style="width:100%">
      </div>
    </div>
    <div class="field-row" style="margin-top:.5rem"><label>Require Multi-Wallet Confirm</label>
      <label class="toggle"><input type="checkbox" id="copyTradeMultiWallet" ${cfg.requireMultiWallet ? "checked" : ""}><span class="slider"></span></label>
      <div class="field-hint">Min 2 priority wallet beli token yang sama sebelum trigger sinyal</div>
    </div>`;

  // Render stats & recent signals
  const sigEl = document.getElementById("copyTradeSignals");
  if (!sigEl) return;
  const recent = data.signals || [];
  sigEl.innerHTML = `
    <div style="font-size:13px;color:var(--muted);margin-bottom:.5rem">
      Copy hari ini: <strong>${stats.copyCountToday || 0}/${stats.maxPerDay || 5}</strong> |
      Priority wallets: <strong>${stats.priorityWalletCount || 0}</strong> |
      Mode: <strong>${cfg.mode || "signal_only"}</strong>
    </div>
    ${recent.length === 0 ? `<div style="color:var(--muted);font-size:12px">No recent copy-trade signals.</div>` :
    recent.map((s, i) => {
      const actionBadge = s.action === "auto_copy" ? "🟢 auto" : s.action === "awaiting_confirm" ? "🟡 waiting" : s.action === "confirmed" ? "✅ confirmed" : s.action === "rejected" ? "❌ rejected" : "🔵 signal";
      return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);padding:.3rem .5rem;border-radius:4px;margin-bottom:.2rem;font-size:11px">
        <span style="font-family:monospace">
          <strong>${escHtml(s.tokenSymbol || "?")}</strong> ← ${escHtml(s.walletLabel || s.wallet.slice(0,8))} (WR:${(s.walletWinRate*100).toFixed(0)}%)
        </span>
        <span>${actionBadge} ${s.timestamp?.slice(11,19) || ""}
          ${s.action === "awaiting_confirm" ? `<button class="btn" onclick="confirmCopySignal(${i})" style="font-size:10px;padding:.1rem .3rem;margin-left:.3rem">✓</button><button class="btn" onclick="rejectCopySignal(${i})" style="font-size:10px;padding:.1rem .3rem">✗</button>` : ""}
        </span>
      </div>`;
    }).join("")}
  `;
}

async function saveCopyTradeConfig() {
  const copyTrade = {
    enabled: document.getElementById("copyTradeEnabled")?.checked !== false,
    mode: document.getElementById("copyTradeMode")?.value || "signal_only",
    maxCopySol: Number(document.getElementById("copyTradeMaxSol")?.value) || 0.1,
    minWalletWinRate: Number(document.getElementById("copyTradeMinWr")?.value) || 0.70,
    maxSlippagePct: Number(document.getElementById("copyTradeMaxSlip")?.value) || 15,
    cooldownMinutes: Number(document.getElementById("copyTradeCooldown")?.value) || 10,
    maxCopyPerDay: Number(document.getElementById("copyTradeMaxDay")?.value) || 5,
    requireMultiWallet: document.getElementById("copyTradeMultiWallet")?.checked || false,
  };
  const res = await post("/api/copy-trade", { action: "config", copyTrade });
  if (res.ok) { loadCopyTradeConfig(); showToast("✅ Copy trade config saved", true); }
  else showToast(res.error || "Failed to save", false);
}

async function confirmCopySignal(idx) {
  const res = await post("/api/copy-trade", { action: "confirm", signalIndex: idx });
  if (res.ok) { loadCopyTradeConfig(); showToast("Copy trade confirmed!", true); }
  else showToast(res.error || "Failed", false);
}

async function rejectCopySignal(idx) {
  const res = await post("/api/copy-trade", { action: "reject", signalIndex: idx });
  if (res.ok) { loadCopyTradeConfig(); showToast("Copy trade rejected", true); }
  else showToast(res.error || "Failed", false);
}

// ─── Strategy Lab (Phase 2/3/4) ──────────────────────
async function loadPortfolioBook() {
  const el = document.getElementById("portfolioBookPanel");
  try {
    const d = await authFetch("/api/portfolio").then(r => r.json());
    document.getElementById("portfolioMode").textContent = d.enabled ? `· ${d.mode.toUpperCase()}` : "· OFF";
    const book = d.book || [];
    if (!d.enabled) { el.innerHTML = `<div style="color:var(--muted);font-size:13px">Portfolio manager disabled (set <code>portfolioEnabled: true</code>).</div>`; return; }
    if (book.length === 0) { el.innerHTML = `<div style="color:var(--muted);font-size:13px">No skills in the book yet.</div>`; return; }
    const attr = d.attribution || {};
    el.innerHTML = book.map(s => {
      const a = attr[s.id] || {};
      const stat = a.trades ? `${a.trades}tr WR ${(a.winRate * 100 || 0).toFixed(0)}% exp ${(a.expectancyPct || 0).toFixed(1)}%` : "no trades";
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;font-size:13px;padding:.4rem 0;border-bottom:1px solid var(--border)">
        <span style="flex:1"><code>${escHtml(s.id)}</code> <span style="color:var(--muted)">[${s.status}] · norm ${(s.normWeight || 0).toFixed(2)} · ${stat}</span></span>
        <input type="number" id="w-${escHtml(s.id)}" value="${(s.weight ?? 0)}" min="0" max="1" step="0.05" style="width:64px;font-size:12px">
        <button class="btn" onclick="setSkillWeight('${escHtml(s.id)}')">Set</button>
      </div>`;
    }).join("");
  } catch (e) { el.innerHTML = `<div style="color:var(--muted)">Failed to load.</div>`; }
}

async function setSkillWeight(id) {
  const input = document.getElementById(`w-${id}`);
  const weight = Number(input?.value);
  const res = await post("/api/portfolio/weight", { skillId: id, weight });
  if (res.ok) { loadPortfolioBook(); showToast(`✅ ${id} weight = ${res.weight}`, true); }
  else showToast(res.error || "Failed to set weight", false);
}

async function loadSkillLoop() {
  const el = document.getElementById("skillLoopPanel");
  try {
    const d = await authFetch("/api/skill-loop").then(r => r.json());
    document.getElementById("skillLoopMode").textContent = d.enabled ? "· ON" : "· OFF";
    const skills = d.shadowSkills || [];
    if (skills.length === 0) { el.innerHTML = `<div style="color:var(--muted);font-size:13px">No loop-authored shadow skills yet.</div>`; return; }
    el.innerHTML = skills.map(s => {
      const paper = s.paper || {};
      const ready = (paper.trades || 0) >= (d.minShadowSample || 30);
      return `<div style="padding:.5rem 0;border-bottom:1px solid var(--border)">
        <div style="font-size:13px"><code>${escHtml(s.id)}</code> 🤖 ${ready ? "✅<i>ready</i>" : `<span style="color:var(--muted)">${paper.trades || 0}/${d.minShadowSample} paper</span>`}</div>
        <div style="font-size:12px;color:var(--muted)">parent: ${(s.parent_skills || []).join(", ") || "—"} · scorecard n=${s.scorecard_sample || 0}</div>
        <div style="display:flex;gap:.5rem;margin-top:.35rem">
          <button class="btn primary" onclick="promoteSkill('${escHtml(s.id)}')" ${ready ? "" : "disabled"}>Promote</button>
          <button class="btn" onclick="rejectSkill('${escHtml(s.id)}')">Reject</button>
        </div>
      </div>`;
    }).join("");
  } catch (e) { el.innerHTML = `<div style="color:var(--muted)">Failed to load.</div>`; }
}

async function promoteSkill(id) {
  const res = await post("/api/skill-loop/action", { action: "promote", skillId: id });
  if (res.ok) { loadSkillLoop(); loadPortfolioBook(); showToast(`✅ Promoted ${id} → active @ ${res.weight}`, true); }
  else showToast(res.error || "Promote failed", false);
}

async function rejectSkill(id) {
  const res = await post("/api/skill-loop/action", { action: "reject", skillId: id });
  if (res.ok) { loadSkillLoop(); showToast(`🗑️ Retired ${id}`, true); }
  else showToast(res.error || "Reject failed", false);
}

async function loadSkillRegistry() {
  const el = document.getElementById("skillRegistryPanel");
  try {
    const d = await authFetch("/api/skill-registry").then(r => r.json());
    const imported = d.imported || [];
    if (imported.length === 0) { el.innerHTML = `<div style="color:var(--muted);font-size:13px">No imported skill packages.</div>`; return; }
    el.innerHTML = imported.map(s => {
      const q = s.vetting?.quarantined;
      const caps = (s.vetting?.executionCapabilities || []).join(", ");
      return `<div style="font-size:13px;padding:.35rem 0;border-bottom:1px solid var(--border)">
        <code>${escHtml(s.id)}</code> <span style="color:var(--muted)">[${s.status}]</span>
        ${q ? `<span style="color:var(--negative)">⛔ QUARANTINED${caps ? ` (${escHtml(caps)})` : ""}</span>` : `<span style="color:var(--positive)">✓ vetted</span>`}
      </div>`;
    }).join("");
  } catch (e) { el.innerHTML = `<div style="color:var(--muted)">Failed to load.</div>`; }
}

// ─── Toast ───────────────────────────────────────────
function showToast(msg, ok = true) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${ok ? "ok" : "error"}`;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.className = "toast", 3500);
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Token initialization ────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Store token from URL param on first load (?token=xxx)
  const urlToken = new URLSearchParams(window.location.search).get("token");
  if (urlToken) { localStorage.setItem("dashToken", urlToken); history.replaceState({}, "", window.location.pathname); }
});

// Load initial status
authFetch("/api/status").then(r => r.json()).then(applyState).catch(() => {});
