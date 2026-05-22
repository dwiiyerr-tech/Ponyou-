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
    if (btn.dataset.tab === "settings") loadQuickConfig();
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
  pnlEl.textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} today`;
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
  if (val) await sendCmd(`/stratset ${val}`);
}

async function setStrategy2() {
  const val = document.getElementById("stratSelect2")?.value;
  if (val) await sendCmd(`/stratset ${val}`);
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
