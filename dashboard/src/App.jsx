import { useState, useEffect, useMemo, startTransition } from "react";

/* ════════════════════════════════════════════════════════════════
   PONYOU // MISSION CONTROL
   Full-internals monitor. Every number on this screen is read from
   bot state files or live log lines — nothing is simulated. A
   subsystem that has produced nothing shows an honest empty state.
   ════════════════════════════════════════════════════════════════ */

/* ─── Global CSS ───────────────────────────────────────────────── */
const GCSS = `
  @import url('https://fonts.googleapis.com/css2?family=VT323&family=IBM+Plex+Mono:wght@400;500&display=swap');
  @keyframes orbGlow  { 0%,100%{filter:drop-shadow(0 0 6px rgba(232,141,106,.5))} 50%{filter:drop-shadow(0 0 14px rgba(232,141,106,.8))} }
  @keyframes blink    { 0%,100%{opacity:1} 50%{opacity:.18} }
  @keyframes fadeIn   { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:none} }
  * { box-sizing:border-box; margin:0; padding:0; }
  ::-webkit-scrollbar { width:4px; height:4px; }
  ::-webkit-scrollbar-thumb { background:#20202A; border-radius:2px; }
  ::-webkit-scrollbar-track { background:transparent; }
`;

/* ─── Palette: Galaxy Dark ─────────────────────────────────────── */
const C = {
  bg:      "#050508",
  panel:   "#0A0A10",
  card:    "#101016",
  border:  "#20202A",

  orange:  "#E88D6A",
  orangeL: "#F0B9A5",
  purple:  "#9B7EC8",
  purpleL: "#B8A3D8",
  amber:   "#D4A35B",
  green:   "#6BA879",
  red:     "#E54D5A",

  ink:     "#F0F0F5",
  ink2:    "#D0D0D8",
  dim:     "#808090",
  dim2:    "#606070",
};
const PX = "'VT323', monospace";
const MN = "'IBM Plex Mono','Courier New', monospace";

/* ─── Atoms ────────────────────────────────────────────────────── */
const Lbl = ({ children, col = C.dim2, sz = 9 }) => (
  <span style={{ color: col, fontSize: sz, fontFamily: MN, letterSpacing: 0.4 }}>{children}</span>
);
const Bdg = ({ children, col = C.orange, filled }) => (
  <span style={{
    border: `1px solid ${col}`, color: filled ? C.panel : col,
    background: filled ? col : col + "12",
    fontSize: 9, fontFamily: MN, padding: "1px 7px",
    display: "inline-block", letterSpacing: 1, whiteSpace: "nowrap",
  }}>{children}</span>
);
const Dot = ({ ok, blink }) => (
  <span style={{
    color: ok ? C.green : C.red, fontSize: 10,
    animation: blink ? "blink 1.2s ease-in-out infinite" : "none",
  }}>●</span>
);
const Panel = ({ title, right, children, style }) => (
  <section style={{
    background: C.panel, border: `1px solid ${C.border}`,
    display: "flex", flexDirection: "column", minHeight: 0, ...style,
  }}>
    <header style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "7px 12px", borderBottom: `1px solid ${C.border}`, flexShrink: 0,
    }}>
      <span style={{ color: C.ink2, fontSize: 11, fontFamily: MN, letterSpacing: 1.5 }}>{title}</span>
      <span>{right}</span>
    </header>
    <div style={{ padding: 12, overflowY: "auto", flex: 1, minHeight: 0 }}>{children}</div>
  </section>
);
const Empty = ({ children }) => (
  <div style={{ color: C.dim2, fontSize: 10, fontFamily: MN, padding: "10px 0", lineHeight: 1.6 }}>
    {children}
  </div>
);
const KPI = ({ label, value, col = C.ink, suffix }) => (
  <div style={{ minWidth: 86 }}>
    <Lbl>{label}</Lbl>
    <div style={{ fontFamily: PX, fontSize: 26, color: col, lineHeight: 1.05 }}>
      {value}{suffix && <span style={{ fontSize: 14, color: C.dim }}> {suffix}</span>}
    </div>
  </div>
);

const Orb = ({ size = 44 }) => (
  <div style={{ width: size, height: size, flexShrink: 0, animation: "orbGlow 2.6s ease-in-out infinite" }}>
    <svg width={size} height={size} viewBox="0 0 58 58">
      <defs>
        <radialGradient id="og1" cx="38%" cy="32%" r="65%">
          <stop offset="0%" stopColor="#F2B088" /><stop offset="50%" stopColor={C.orange} /><stop offset="100%" stopColor={C.purple} />
        </radialGradient>
        <radialGradient id="og2" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#2A2A35" /><stop offset="100%" stopColor="#101016" />
        </radialGradient>
      </defs>
      <circle cx="29" cy="29" r="27.5" fill="none" stroke={C.orange} strokeWidth=".6" opacity=".4" />
      <circle cx="29" cy="29" r="25" fill="url(#og1)" opacity=".92" />
      <circle cx="29" cy="29" r="17" fill="url(#og2)" />
      <path d="M 29 12 A 17 17 0 0 1 46 29" stroke="white" strokeWidth="2.8" fill="none" strokeLinecap="round" opacity=".9" />
      <path d="M 29 46 A 17 17 0 0 1 12 29" stroke="white" strokeWidth="2.8" fill="none" strokeLinecap="round" opacity=".9" />
      <circle cx="29" cy="29" r="2.8" fill="#F2B088" opacity=".95" />
    </svg>
  </div>
);

/* ─── Helpers ──────────────────────────────────────────────────── */
const fmtAge = (ms) => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "?";
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  if (m < 60 * 48) return `${(m / 60).toFixed(1)}h`;
  return `${Math.round(m / 1440)}d`;
};
const fmtClock = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toTimeString().slice(0, 8) : "—";
};
const usd = (v, digits = 2) =>
  Number.isFinite(Number(v)) ? `$${Number(v).toFixed(digits)}` : "—";

const LiveClock = () => {
  const [v, setV] = useState(() => new Date().toTimeString().slice(0, 8));
  useEffect(() => {
    const t = setInterval(() => setV(new Date().toTimeString().slice(0, 8)), 1000);
    return () => clearInterval(t);
  }, []);
  return <span style={{ fontFamily: PX, fontSize: 22, color: C.ink2 }}>{v}</span>;
};

/* ─── Header ───────────────────────────────────────────────────── */
function Header({ s, internals }) {
  const running = Boolean(s?.bot_running);
  const paper = Boolean(s?.features?.paper_trading);
  const gauges = internals?.metrics?.gauges || {};
  const started = Date.parse(internals?.metrics?.session_started_at || "");
  const pnl = Number(s?.pnl_today_usd) || 0;
  const openCount = s?.positions?.length ?? 0;

  return (
    <header style={{
      display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center",
      background: C.panel, border: `1px solid ${C.border}`, padding: "10px 16px",
    }}>
      <Orb />
      <div style={{ marginRight: 8 }}>
        <div style={{ fontFamily: PX, fontSize: 30, color: C.orange, lineHeight: 1 }}>PONYOU</div>
        <Lbl col={C.dim}>MISSION CONTROL</Lbl>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Bdg col={running ? C.green : C.red} filled>
          <Dot ok={running} blink={running} /> {running ? "RUNNING" : "STOPPED"}
        </Bdg>
        <Bdg col={paper ? C.amber : C.red}>{paper ? "PAPER / DEMO" : "LIVE FUNDS"}</Bdg>
        {Number.isFinite(started) && <Bdg col={C.purple}>UP {fmtAge(Date.now() - started)}</Bdg>}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "center" }}>
        <KPI label="WALLET" value={usd(gauges.wallet_total_usd)} col={C.orange} />
        <KPI label="SESSION PNL" value={`${pnl >= 0 ? "+" : ""}${usd(pnl)}`} col={pnl >= 0 ? C.green : C.red} />
        <KPI label="SOL BAL" value={Number(s?.balance_sol ?? 0).toFixed(3)} col={C.ink} />
        <KPI label="SOL PRICE" value={usd(s?.sol_price, 0)} col={C.purpleL} />
        <KPI label="OPEN POS" value={openCount} col={openCount > 0 ? C.amber : C.dim} />
        <LiveClock />
      </div>
    </header>
  );
}

/* ─── Liveness (watchdog) ──────────────────────────────────────── */
function LivenessPanel({ watchdog }) {
  const checks = watchdog?.checks || [];
  const alive = checks.filter(c => c.ok).length;
  const age = watchdog?.ts ? Date.now() - Date.parse(watchdog.ts) : null;
  const stale = age != null && age > 40 * 60_000; // 2 cycles + slack

  return (
    <Panel
      title="LIVENESS · WATCHDOG"
      right={checks.length
        ? <Bdg col={alive === checks.length ? C.green : C.red}>
            {alive}/{checks.length} ALIVE · {fmtAge(age)} ago
          </Bdg>
        : <Bdg col={C.dim2}>NO DATA</Bdg>}
    >
      {!checks.length && (
        <Empty>
          Watchdog has not persisted a cycle yet. It writes watchdog-state.json
          every 15 minutes — if this persists, the bot is running pre-watchdog
          code or the watchdog cron is dead.
        </Empty>
      )}
      {stale && (
        <div style={{ color: C.red, fontSize: 10, fontFamily: MN, marginBottom: 8 }}>
          ⚠ last cycle {fmtAge(age)} ago (expected ≤15m) — watchdog itself may be dead
        </div>
      )}
      {checks.map(c => (
        <div key={c.id} style={{
          display: "flex", gap: 8, alignItems: "baseline",
          padding: "4px 0", borderBottom: `1px dashed ${C.border}`,
        }}>
          <Dot ok={c.ok} />
          <span style={{
            color: c.ok ? C.ink2 : C.red, fontSize: 10, fontFamily: MN,
            minWidth: 130, fontWeight: c.critical ? 600 : 400,
          }}>
            {c.id}{c.critical ? " *" : ""}
          </span>
          <span style={{ color: C.dim, fontSize: 9, fontFamily: MN, flex: 1 }}>{c.detail}</span>
        </div>
      ))}
      {checks.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Lbl>* critical check — proof of output, not proof of process</Lbl>
        </div>
      )}
    </Panel>
  );
}

/* ─── Positions ────────────────────────────────────────────────── */
function PositionsPanel({ positions }) {
  const rows = positions || [];
  return (
    <Panel title="OPEN POSITIONS" right={<Bdg col={rows.length ? C.amber : C.dim2}>{rows.length}</Bdg>}>
      {!rows.length && <Empty>Book empty — no open positions.</Empty>}
      {rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: MN, fontSize: 10 }}>
          <thead>
            <tr style={{ color: C.dim2, textAlign: "left" }}>
              <th style={{ padding: "2px 4px" }}>TOKEN</th>
              <th style={{ padding: "2px 4px" }}>PNL</th>
              <th style={{ padding: "2px 4px" }}>PEAK</th>
              <th style={{ padding: "2px 4px" }}>HOLD</th>
              <th style={{ padding: "2px 4px" }}>ENTRY</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <tr key={p.mint} style={{ borderTop: `1px dashed ${C.border}` }}>
                <td style={{ padding: "4px", color: C.ink }}>{p.symbol}</td>
                <td style={{ padding: "4px", color: p.pnl_pct >= 0 ? C.green : C.red }}>
                  {p.pnl_pct >= 0 ? "+" : ""}{Number(p.pnl_pct).toFixed(1)}%
                </td>
                <td style={{ padding: "4px", color: C.dim }}>
                  {p.peak_pnl_pct != null ? `${Number(p.peak_pnl_pct).toFixed(1)}%` : "—"}
                </td>
                <td style={{ padding: "4px", color: C.dim }}>{p.hold_minutes}m</td>
                <td style={{ padding: "4px", color: C.dim }}>
                  {p.entry_sol != null ? `${p.entry_sol} SOL` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/* ─── Trade timeline ───────────────────────────────────────────── */
function TimelinePanel({ events }) {
  const rows = events || [];
  return (
    <Panel title="TRADE TIMELINE" right={<Lbl col={C.dim}>last {rows.length} events</Lbl>}>
      {!rows.length && <Empty>No deploy/close events recorded yet.</Empty>}
      {rows.map((e, i) => {
        const isDeploy = e.action === "deploy";
        const neg = /(-\d|stale|price_drop|stop|kill)/i.test(e.reason || "");
        const col = isDeploy ? C.amber : neg ? C.red : C.green;
        return (
          <div key={i} style={{ display: "flex", gap: 8, padding: "3px 0", fontFamily: MN, fontSize: 10, alignItems: "baseline" }}>
            <span style={{ color: C.dim2, flexShrink: 0 }}>{fmtClock(e.ts)}</span>
            <span style={{ color: col, flexShrink: 0, width: 46 }}>{isDeploy ? "▲ BUY" : "▼ EXIT"}</span>
            <span style={{ color: C.ink2, flexShrink: 0, minWidth: 64 }}>{e.symbol}</span>
            <span style={{ color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {e.reason || ""}
            </span>
          </div>
        );
      })}
    </Panel>
  );
}

/* ─── Darwin learned weights ───────────────────────────────────── */
function DarwinPanel({ darwin }) {
  const weights = darwin?.weights && typeof darwin.weights === "object" ? darwin.weights
    : (darwin && typeof darwin === "object" && !Array.isArray(darwin) ? darwin : null);
  const entries = weights
    ? Object.entries(weights).filter(([, v]) => Number.isFinite(Number(v?.weight ?? v)))
        .map(([k, v]) => [k, Number(v?.weight ?? v)])
        .sort((a, b) => b[1] - a[1])
    : [];
  const max = entries.length ? Math.max(...entries.map(e => e[1]), 1) : 1;

  return (
    <Panel title="DARWIN · LEARNED SIGNAL WEIGHTS"
      right={<Bdg col={entries.length ? C.purple : C.dim2}>{entries.length ? `${entries.length} SIGNALS` : "UNTRAINED"}</Bdg>}>
      {!entries.length && (
        <Empty>
          No learned weights yet — darwin-weights.json appears after the first
          trade close or shadow outcome feeds the loop (experiment #8). Static
          baseline weights are in effect.
        </Empty>
      )}
      {entries.map(([name, w]) => (
        <div key={name} style={{ padding: "3px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MN, fontSize: 10 }}>
            <span style={{ color: C.ink2 }}>{name}</span>
            <span style={{ color: w >= 1 ? C.green : C.red }}>{w.toFixed(2)}</span>
          </div>
          <div style={{ height: 4, background: C.card, marginTop: 2 }}>
            <div style={{
              height: "100%", width: `${Math.min(100, (w / max) * 100)}%`,
              background: w >= 1 ? C.green : C.red, opacity: 0.7,
            }} />
          </div>
        </div>
      ))}
    </Panel>
  );
}

/* ─── Shadow watchlist ─────────────────────────────────────────── */
const SHADOW_COL = { watching: C.amber, survived: C.green, mooned: C.purple, rugged: C.red };
function ShadowPanel({ shadow }) {
  const rows = shadow?.recent || [];
  const by = shadow?.by_status || {};
  return (
    <Panel title="SHADOW WATCHLIST"
      right={<span style={{ display: "flex", gap: 4 }}>
        {Object.entries(by).map(([k, n]) => (
          <Bdg key={k} col={SHADOW_COL[k] || C.dim}>{k.toUpperCase()} {n}</Bdg>
        ))}
        {!Object.keys(by).length && <Bdg col={C.dim2}>EMPTY</Bdg>}
      </span>}>
      {!rows.length && (
        <Empty>
          Watchlist empty — tokens the screener rejects (or passes on) get
          shadow-tracked here to learn from rugs avoided and winners missed.
        </Empty>
      )}
      {rows.map((t, i) => (
        <div key={i} style={{
          display: "flex", gap: 8, padding: "4px 0", alignItems: "baseline",
          borderBottom: `1px dashed ${C.border}`, fontFamily: MN, fontSize: 10,
        }}>
          <span style={{ color: SHADOW_COL[t.status] || C.dim, width: 64, flexShrink: 0 }}>
            {(t.status || "?").toUpperCase()}
          </span>
          <span style={{ color: C.ink2, minWidth: 70 }}>{t.symbol}</span>
          <span style={{ color: C.dim }}>sig {t.signal_score ?? "—"}</span>
          <span style={{ color: C.dim }}>rug {t.rug_score ?? "—"}</span>
          {t.peak_x != null && <span style={{ color: t.peak_x >= 1.5 ? C.purple : C.dim }}>peak {t.peak_x}×</span>}
          <span style={{ color: C.dim2, marginLeft: "auto" }}>{t.hunt_source || ""}</span>
        </div>
      ))}
    </Panel>
  );
}

/* ─── GMGN health + experiment #1 ──────────────────────────────── */
function GmgnPanel({ gmgn, exp }) {
  const en = Boolean(gmgn?.enabled);
  const circuit = Boolean(gmgn?.circuit_open);
  const lastOk = gmgn?.last_ok_at ? Date.now() - Date.parse(gmgn.last_ok_at) : null;
  const c = gmgn?.counters || {};
  return (
    <Panel title="GMGN LAYER"
      right={<Bdg col={!en ? C.dim2 : circuit ? C.red : C.green}>
        {!en ? "DISABLED" : circuit ? "CIRCUIT OPEN" : "LIVE"}
      </Bdg>}>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 8 }}>
        <KPI label="OK CALLS" value={c.ok ?? 0} col={C.green} />
        <KPI label="RATE-LIMITED" value={c.rate_limit ?? 0} col={c.rate_limit ? C.amber : C.dim} />
        <KPI label="CIRCUIT SKIPS" value={c.circuit_skip ?? 0} col={c.circuit_skip ? C.red : C.dim} />
        <KPI label="LAST OK" value={lastOk != null ? fmtAge(lastOk) : "—"} col={C.ink2} />
      </div>
      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
        <Lbl col={C.purpleL} sz={10}>EXPERIMENT #1 · GMGN ROW-RISK (this session)</Lbl>
        <div style={{ display: "flex", gap: 18, marginTop: 4 }}>
          <KPI label="EVALUATED" value={exp?.evaluated ?? 0} col={exp?.evaluated ? C.ink : C.dim} />
          <KPI label="CONTRIBUTED" value={exp?.contributed ?? 0} col={exp?.contributed ? C.purple : C.dim} />
          <KPI label="BLOCK-BAND" value={exp?.blocked ?? 0} col={exp?.blocked ? C.red : C.dim} />
        </div>
        {!exp?.evaluated && (
          <Lbl col={C.dim2}>0 evaluated = no GMGN-tagged prey has reached deep-screen rug scoring since last restart.</Lbl>
        )}
      </div>
    </Panel>
  );
}

/* ─── Portfolio + skill loop ───────────────────────────────────── */
function PortfolioPanel({ portfolio, skillLoop }) {
  const attr = portfolio?.attribution || {};
  const skills = Object.entries(attr).sort((a, b) => (b[1]?.trades || 0) - (a[1]?.trades || 0));
  return (
    <Panel title="STRATEGY ENSEMBLE"
      right={<span style={{ display: "flex", gap: 4 }}>
        <Bdg col={portfolio?.enabled ? C.green : C.dim2}>
          PORTFOLIO {portfolio?.enabled ? (portfolio.mode || "on").toUpperCase() : "OFF"}
        </Bdg>
        <Bdg col={skillLoop?.enabled ? C.green : C.dim2}>
          LOOP {skillLoop?.enabled ? "ON" : "OFF"}
        </Bdg>
      </span>}>
      {!skills.length && <Empty>No per-skill attribution yet — shadow votes accumulate as paper trades close.</Empty>}
      {skills.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: MN, fontSize: 10 }}>
          <thead>
            <tr style={{ color: C.dim2, textAlign: "left" }}>
              <th style={{ padding: "2px 4px" }}>SKILL</th>
              <th style={{ padding: "2px 4px" }}>TRADES</th>
              <th style={{ padding: "2px 4px" }}>WIN%</th>
              <th style={{ padding: "2px 4px" }}>EXPECT%</th>
            </tr>
          </thead>
          <tbody>
            {skills.map(([id, s]) => (
              <tr key={id} style={{ borderTop: `1px dashed ${C.border}` }}>
                <td style={{ padding: "4px", color: C.ink2 }}>{id}</td>
                <td style={{ padding: "4px", color: C.dim }}>{s.trades ?? 0}</td>
                <td style={{ padding: "4px", color: (s.winRate || 0) >= 0.5 ? C.green : C.red }}>
                  {Math.round((s.winRate || 0) * 100)}%
                </td>
                <td style={{ padding: "4px", color: (s.expectancyPct || 0) >= 0 ? C.green : C.red }}>
                  {s.expectancyPct ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {skillLoop?.enabled && (
        <div style={{ marginTop: 8 }}>
          <Lbl col={C.dim}>
            codifier shadow skills: {skillLoop.shadowSkills?.length || 0} (gates: pattern≥{skillLoop.minPatternSample}, shadow≥{skillLoop.minShadowSample})
          </Lbl>
        </div>
      )}
    </Panel>
  );
}

/* ─── Feature flags ────────────────────────────────────────────── */
function FeaturesPanel({ features }) {
  const entries = Object.entries(features || {});
  return (
    <Panel title="FEATURE FLAGS" right={<Lbl col={C.dim}>{entries.filter(([, v]) => v).length}/{entries.length} on</Lbl>}>
      {!entries.length && <Empty>No flags reported.</Empty>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {entries.map(([k, v]) => (
          <Bdg key={k} col={v ? C.green : C.dim2}>{k.replace(/_enabled$/, "").replace(/_/g, " ").toUpperCase()}</Bdg>
        ))}
      </div>
    </Panel>
  );
}

/* ─── Second brain + comms ─────────────────────────────────────── */
function BrainCommsPanel({ s }) {
  const sb = s?.second_brain || {};
  const tg = s?.telegram || {};
  const lastUpd = sb.last_updated ? Date.now() - Date.parse(sb.last_updated) : null;
  return (
    <Panel title="SECOND BRAIN · COMMS"
      right={<Bdg col={sb.available ? C.purple : C.dim2}>{sb.available ? "VAULT LINKED" : "NO VAULT"}</Bdg>}>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 8 }}>
        <KPI label="NOTES" value={sb.file_count ?? 0} col={C.purpleL} />
        <KPI label="WORDS" value={(sb.total_words ?? 0).toLocaleString()} col={C.ink2} />
        <KPI label="LAST WRITE" value={lastUpd != null ? fmtAge(lastUpd) : "—"} col={C.dim} />
        <KPI label="WIN RATE" value={s?.win_rate != null ? `${Math.round(s.win_rate * 100)}%` : "—"} col={C.amber} />
      </div>
      <div style={{ display: "flex", gap: 14, borderTop: `1px solid ${C.border}`, paddingTop: 8, fontFamily: MN, fontSize: 10 }}>
        <span><Dot ok={tg.enabled} /> <span style={{ color: C.dim }}>tg user-client</span></span>
        <span><Dot ok={tg.connected} /> <span style={{ color: C.dim }}>connected</span></span>
        <span><Dot ok={tg.bot_polling} /> <span style={{ color: C.dim }}>bot polling</span></span>
      </div>
    </Panel>
  );
}

/* ─── Live log stream ──────────────────────────────────────────── */
const LOG_GROUPS = {
  MARKET:    { col: C.amber,   match: ["ONCHAIN", "ONCHAIN_LISTENER", "HUNTER", "MARKET", "SOCIAL_HUNTER", "SOCIAL_GATE_SUMMARY", "CAST_NET", "SMART_MONEY", "GMGN"] },
  SCREENING: { col: C.purpleL, match: ["TRASH_FILTER", "TRASH_LAYER", "SCREENING", "LEARNING", "RUG", "RUG_MONITOR", "ORACLE", "EXPERIMENT_GMGN_ROW", "SHADOW"] },
  TRADING:   { col: C.orange,  match: ["CRON", "PORTFOLIO", "MANAGER", "RISK", "STRATEGY", "EXECUTION", "TRADE", "SWAP", "LIQUIDITY", "EXIT", "DEPLOY"] },
  WATCHDOG:  { col: C.green,   match: ["WATCHDOG", "WATCHDOG_ERROR"] },
};
function groupOf(rawType) {
  for (const [g, def] of Object.entries(LOG_GROUPS)) {
    if (def.match.includes(rawType)) return g;
  }
  return "SYS";
}
function LogStream({ logs, filter, setFilter }) {
  const shown = filter === "ALL" ? logs : logs.filter(l => l.group === filter);
  return (
    <Panel
      title="LIVE LOG STREAM"
      style={{ height: 280 }}
      right={
        <span style={{ display: "flex", gap: 4 }}>
          {["ALL", ...Object.keys(LOG_GROUPS), "SYS"].map(g => (
            <button key={g} onClick={() => setFilter(g)} style={{
              background: filter === g ? (LOG_GROUPS[g]?.col || C.ink2) : "transparent",
              color: filter === g ? C.panel : (LOG_GROUPS[g]?.col || C.dim),
              border: `1px solid ${LOG_GROUPS[g]?.col || C.dim2}`,
              fontFamily: MN, fontSize: 9, padding: "1px 7px", cursor: "pointer", letterSpacing: 1,
            }}>{g}</button>
          ))}
        </span>
      }>
      {!shown.length && (
        <Empty>
          Waiting for log lines from logs/agent-*.log… If this stays empty while
          the bot is RUNNING, the dashboard log tail is broken — there is no
          simulated fallback on this screen by design.
        </Empty>
      )}
      {shown.map(l => (
        <div key={l.id} style={{
          display: "flex", gap: 8, fontFamily: MN, fontSize: 10,
          padding: "2px 0", animation: "fadeIn .2s ease-out", alignItems: "baseline",
        }}>
          <span style={{ color: C.dim2, flexShrink: 0 }}>{l.time}</span>
          <span style={{ color: LOG_GROUPS[l.group]?.col || C.dim, flexShrink: 0, width: 130, overflow: "hidden", textOverflow: "ellipsis" }}>
            [{l.rawType}]
          </span>
          <span style={{ color: C.ink2, wordBreak: "break-word" }}>{l.text}</span>
        </div>
      ))}
    </Panel>
  );
}

/* ─── App ──────────────────────────────────────────────────────── */
export default function App() {
  const [botState, setBotState] = useState(null);
  const [internals, setInternals] = useState(null);
  const [gmgn, setGmgn] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [skillLoop, setSkillLoop] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logFilter, setLogFilter] = useState("ALL");
  const [wsUp, setWsUp] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < 900);

  useEffect(() => {
    const check = () => setMobile(window.innerWidth < 900);
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // WebSocket: state broadcast (2s) + real log tail. No simulated entries.
  useEffect(() => {
    let ws, timer, closed = false;
    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      ws.onopen = () => setWsUp(true);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "state") startTransition(() => setBotState(msg.data));
          else if (msg.type === "log") {
            const text = String(msg.data);
            const m = text.match(/^\[(.*?)\]\s*\[(.*?)\]\s*(.*)/s);
            const rawType = m ? m[2].toUpperCase() : "SYS";
            const entry = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              time: m && Number.isFinite(Date.parse(m[1])) ? fmtClock(m[1]) : new Date().toTimeString().slice(0, 8),
              rawType,
              group: groupOf(rawType),
              text: m ? m[3] : text,
            };
            startTransition(() => setLogs(p => [entry, ...p].slice(0, 300)));
          }
        } catch { /* malformed frame — drop */ }
      };
      ws.onclose = () => { setWsUp(false); if (!closed) timer = setTimeout(connect, 3000); };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); try { ws?.close(); } catch {} };
  }, []);

  // Slow-changing internals: poll every 10s.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      const get = (url) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
      const [int_, gm, pf, sl] = await Promise.all([
        get("/api/internals"), get("/api/gmgn-health"), get("/api/portfolio"), get("/api/skill-loop"),
      ]);
      if (stop) return;
      startTransition(() => {
        if (int_) setInternals(int_);
        if (gm) setGmgn(gm);
        if (pf) setPortfolio(pf);
        if (sl) setSkillLoop(sl);
      });
    };
    poll();
    const iv = setInterval(poll, 10_000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  const cols = mobile ? "1fr" : "1.1fr 1fr 1fr";

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 12, color: C.ink }}>
      <style>{GCSS}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 1700, margin: "0 auto" }}>
        <Header s={botState} internals={internals} />
        {!wsUp && (
          <div style={{
            background: C.red + "22", border: `1px solid ${C.red}`, padding: "6px 12px",
            fontFamily: MN, fontSize: 10, color: C.red,
          }}>
            ⚠ WebSocket disconnected — values frozen at last received state. Reconnecting…
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: cols, gap: 12, alignItems: "start" }}>
          {/* col 1 — health */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <LivenessPanel watchdog={internals?.watchdog} />
            <GmgnPanel gmgn={gmgn} exp={internals?.experiment_gmgn_row} />
            <FeaturesPanel features={botState?.features} />
          </div>
          {/* col 2 — trading */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <PositionsPanel positions={botState?.positions} />
            <TimelinePanel events={botState?.recent_events} />
            <PortfolioPanel portfolio={portfolio} skillLoop={skillLoop} />
          </div>
          {/* col 3 — learning */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <DarwinPanel darwin={internals?.darwin} />
            <ShadowPanel shadow={internals?.shadow} />
            <BrainCommsPanel s={botState} />
          </div>
        </div>
        <LogStream logs={logs} filter={logFilter} setFilter={setLogFilter} />
        <footer style={{ textAlign: "center", padding: "4px 0 10px" }}>
          <Lbl col={C.dim2}>
            PONYOU MISSION CONTROL — every value above is read from bot state; empty panels mean the subsystem has produced nothing yet.
          </Lbl>
        </footer>
      </div>
    </div>
  );
}
