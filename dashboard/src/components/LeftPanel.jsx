import { useState } from 'react';

const TOOLS = [
  { name: 'discover_tokens',        icon: '◈', group: 'scan' },
  { name: 'get_token_security',     icon: '◉', group: 'scan' },
  { name: 'get_smart_money_inflow', icon: '◎', group: 'scan' },
  { name: 'get_trending_narratives',icon: '◇', group: 'scan' },
  { name: 'gmgn_swap',              icon: '⚡', group: 'trade' },
  { name: 'get_wallet_balance',     icon: '◈', group: 'wallet' },
  { name: 'get_token_info',         icon: '◉', group: 'info' },
  { name: 'add_lesson',             icon: '◈', group: 'memory' },
  { name: 'list_lessons',           icon: '◇', group: 'memory' },
  { name: 'add_to_blacklist',       icon: '✕', group: 'safety' },
  { name: 'update_config',          icon: '◎', group: 'system' },
  { name: 'get_recent_decisions',   icon: '◇', group: 'memory' },
];

const GROUP_COLORS = {
  scan:   'var(--sys)',
  trade:  'var(--trade)',
  wallet: 'var(--warn)',
  info:   'var(--cyan)',
  memory: 'var(--tool)',
  safety: 'var(--neg)',
  system: 'var(--dim)',
};

function fmtUsd(n, decimals = 2) {
  if (n == null) return '—';
  if (typeof n !== 'number') n = parseFloat(n);
  if (isNaN(n)) return '—';
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(decimals)}`;
}

function pnlColor(v) {
  if (v > 0) return 'var(--pos)';
  if (v < 0) return 'var(--neg)';
  return 'var(--dim)';
}

function StatusBadge({ status }) {
  const map = {
    TRADING: { cls: 'badge-trading', label: '● TRADING' },
    IDLE:    { cls: 'badge-idle',    label: '○ IDLE' },
    PAUSED:  { cls: 'badge-paused', label: '⏸ PAUSED' },
    OFFLINE: { cls: 'badge-offline', label: '✕ OFFLINE' },
  };
  const { cls, label } = map[status] || map.OFFLINE;
  return <span className={`badge ${cls}`}>{label}</span>;
}

function MarketBadge({ condition }) {
  const map = {
    HOT:     { cls: 'badge-hot',    label: '▲ HOT' },
    COLD:    { cls: 'badge-cold',   label: '▽ COLD' },
    DEAD:    { cls: 'badge-dead',   label: '□ DEAD' },
    UNKNOWN: { cls: 'badge-offline',label: '? UNKN' },
  };
  const { cls, label } = map[(condition || '').toUpperCase()] || map.UNKNOWN;
  return <span className={`badge ${cls}`}>{label}</span>;
}

function StatRow({ label, value, valueColor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
      <span style={{ color: 'var(--muted)', fontSize: 11 }}>{label}</span>
      <span style={{ color: valueColor || 'var(--text)', fontSize: 12, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function PositionCard({ address, pos }) {
  const pnl = pos.pnl_usd ?? pos.unrealized_pnl_usd ?? 0;
  const pnlPct = pos.pnl_pct ?? pos.unrealized_pnl_pct ?? 0;
  return (
    <div className="cyber-card slide-in" style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ color: 'var(--cyan)', fontWeight: 600, fontSize: 12 }}>
          {pos.symbol || pos.name || address.slice(0, 8) + '…'}
        </span>
        <span style={{ color: pnlColor(pnl), fontSize: 11, fontWeight: 600 }}>
          {pnl >= 0 ? '+' : ''}{pnl.toFixed(3)} USD
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: 'var(--muted)', fontSize: 10 }}>{address.slice(0, 14)}…</span>
        <span style={{ color: pnlColor(pnlPct), fontSize: 10, fontWeight: 600 }}>
          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%
        </span>
      </div>
      {pos.amount_sol && (
        <div style={{ color: 'var(--dim)', fontSize: 10, marginTop: 2 }}>
          {parseFloat(pos.amount_sol).toFixed(4)} SOL
        </div>
      )}
    </div>
  );
}

export default function LeftPanel({ agentData, connected }) {
  const [showAllTools, setShowAllTools] = useState(false);
  const { agentStatus, state, tradingPlan, marketIntel, userConfig } = agentData;

  const session       = tradingPlan?.session;
  const currentDay    = tradingPlan?.currentDay || 1;
  const planDays      = tradingPlan?.schedule?.length || 30;
  const todaySchedule = tradingPlan?.schedule?.[currentDay - 1];

  const positions     = Object.entries(state?.positions || {});
  const marketCondition = (marketIntel?.currentCondition || 'UNKNOWN').toUpperCase();
  const latestIntel   = marketIntel?.snapshots?.[marketIntel.snapshots.length - 1];
  const confidence    = latestIntel?.confidence || 0;

  const startCap   = session?.startCapitalUsd  || userConfig?.pilotCapitalUsd || 10;
  const currentCap = session?.currentCapitalUsd || 0;
  const targetCap  = todaySchedule?.target_usd || startCap * 1.25;
  const dayProgress  = Math.min(100, Math.max(0,
    ((currentCap - startCap) / (targetCap - startCap)) * 100));
  const planProgress = Math.round((currentDay / planDays) * 100);
  // Log-scale progress toward $8077
  const capLogProgress = Math.min(100,
    ((Math.log10(Math.max(10, currentCap || 10)) - 1) / (Math.log10(8077) - 1)) * 100);

  const visibleTools = showAllTools ? TOOLS : TOOLS.slice(0, 6);

  return (
    <aside style={{
      borderRight: '1px solid var(--border)',
      background: 'var(--bg-panel)',
      overflowY: 'auto',
      overflowX: 'hidden',
      padding: '10px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>

      {/* Agent Status */}
      <div className="cyber-card">
        <div className="section-header">Agent Status</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <StatusBadge status={agentStatus} />
          <MarketBadge condition={marketCondition} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--muted)' }}>
          <span>confidence</span>
          <div style={{ flex: 1 }}>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${confidence}%` }} />
            </div>
          </div>
          <span style={{ color: 'var(--cyan)', fontWeight: 600 }}>{confidence}%</span>
        </div>
      </div>

      {/* Session Stats */}
      <div className="cyber-card">
        <div className="section-header">Session</div>
        <StatRow label="Capital"
          value={fmtUsd(session?.currentCapitalUsd ?? currentCap)}
          valueColor="var(--cyan)" />
        <StatRow label="P&L Today"
          value={`${(session?.profitUsd || 0) >= 0 ? '+' : ''}${fmtUsd(session?.profitUsd || 0)}`}
          valueColor={pnlColor(session?.profitUsd || 0)} />
        <StatRow label="P&L %"
          value={`${(session?.profitPct || 0) >= 0 ? '+' : ''}${(session?.profitPct || 0).toFixed(1)}%`}
          valueColor={pnlColor(session?.profitPct || 0)} />
        <StatRow label="Trades"     value={session?.tradesCount || 0} />
        <StatRow label="Win / Loss"
          value={`${session?.winCount || 0} / ${session?.lossCount || 0}`}
          valueColor={
            (session?.winCount || 0) > (session?.lossCount || 0) ? 'var(--pos)'
            : (session?.lossCount || 0) > 0 ? 'var(--neg)'
            : 'var(--dim)'
          } />

        {session?.pausedUntil && new Date(session.pausedUntil) > new Date() && (
          <div style={{ marginTop: 6, padding: '4px 8px',
            background: 'rgba(255,170,0,0.07)', border: '1px solid rgba(255,170,0,0.2)',
            borderRadius: 2, fontSize: 10, color: 'var(--warn)' }}>
            ⏸ Paused until {new Date(session.pausedUntil).toLocaleTimeString()}
            {session.pauseReason && (
              <div style={{ color: 'var(--dim)', marginTop: 2 }}>{session.pauseReason}</div>
            )}
          </div>
        )}
      </div>

      {/* Compound Plan */}
      <div className="cyber-card">
        <div className="section-header">30-Day Compound Plan</div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 11 }}>
          <span style={{ color: 'var(--dim)' }}>
            Day <span style={{ color: 'var(--title)', fontWeight: 700 }}>{currentDay}</span>
            <span style={{ color: 'var(--muted)' }}> / {planDays}</span>
          </span>
          <span style={{ color: 'var(--muted)', fontSize: 10 }}>+25%/day</span>
        </div>

        {/* Plan timeline progress */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between',
            fontSize: 10, color: 'var(--muted)', marginBottom: 3 }}>
            <span>timeline</span>
            <span style={{ color: 'var(--dim)' }}>{planProgress}%</span>
          </div>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${planProgress}%`,
              background: 'linear-gradient(90deg, var(--tool), var(--cyan))' }} />
          </div>
        </div>

        {/* Today's target */}
        {todaySchedule && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
              fontSize: 10, color: 'var(--muted)', marginBottom: 3 }}>
              <span>today's target</span>
              <span style={{ color: 'var(--warn)' }}>
                {fmtUsd(todaySchedule.start_usd)} → {fmtUsd(todaySchedule.target_usd)}
              </span>
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${dayProgress}%`,
                background: dayProgress >= 100 ? 'var(--ok)' :
                  dayProgress > 50 ? 'linear-gradient(90deg, var(--warn), var(--ok))' :
                  'linear-gradient(90deg, var(--neg), var(--warn))' }} />
            </div>
          </div>
        )}

        {/* Capital milestones ($10 → $8K) */}
        <div style={{ marginBottom: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between',
            fontSize: 9, color: 'var(--muted)', marginBottom: 3 }}>
            <span style={{ color: 'var(--dim)' }}>$10</span>
            <span>$100</span>
            <span>$1K</span>
            <span style={{ color: 'var(--title)' }}>$8K</span>
          </div>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${capLogProgress}%`,
              background: 'linear-gradient(90deg, var(--api), var(--title))' }} />
          </div>
        </div>
      </div>

      {/* Open Positions */}
      <div className="cyber-card">
        <div className="section-header">
          Open Positions
          {positions.length > 0 && (
            <span style={{ marginLeft: 'auto', color: 'var(--ok)', fontSize: 10, fontWeight: 600 }}>
              {positions.length} active
            </span>
          )}
        </div>
        {positions.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'center', padding: '8px 0' }}>
            no open positions
          </div>
        ) : (
          positions.map(([addr, pos]) => (
            <PositionCard key={addr} address={addr} pos={pos} />
          ))
        )}
      </div>

      {/* Config Snapshot */}
      <div className="cyber-card">
        <div className="section-header">Config</div>
        <StatRow label="Strategy"   value={userConfig?.strategy || '—'}      valueColor="var(--cyan)" />
        <StatRow label="Model"      value={(userConfig?.llmModel || '—').split('/').pop()} />
        <StatRow label="Dry Run"    value={userConfig?.dryRun ? 'YES' : 'NO'}
          valueColor={userConfig?.dryRun ? 'var(--warn)' : 'var(--ok)'} />
        <StatRow label="Max Pos"    value={userConfig?.maxPositions || '—'} />
        <StatRow label="Stop Loss"  value={userConfig?.stopLossPct != null ? `${userConfig.stopLossPct}%` : '—'}
          valueColor="var(--neg)" />
        <StatRow label="Take Profit" value={userConfig?.takeProfitPct != null ? `${userConfig.takeProfitPct}%` : '—'}
          valueColor="var(--pos)" />
        <StatRow label="Trailing TP" value={userConfig?.trailingTakeProfit ? 'ON' : 'OFF'}
          valueColor={userConfig?.trailingTakeProfit ? 'var(--ok)' : 'var(--dim)'} />
      </div>

      {/* Available Tools */}
      <div className="cyber-card">
        <div className="section-header">
          Agent Tools
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 10 }}>{TOOLS.length}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {visibleTools.map(tool => (
            <div key={tool.name} className="tool-pill" title={tool.name}
              style={{ borderColor: `${GROUP_COLORS[tool.group]}28`, color: GROUP_COLORS[tool.group] }}>
              {tool.icon} {tool.name}
            </div>
          ))}
        </div>
        <button
          onClick={() => setShowAllTools(v => !v)}
          style={{ marginTop: 8, width: '100%', background: 'none', border: '1px solid var(--border)',
            color: 'var(--muted)', padding: '3px 8px', fontSize: 10,
            letterSpacing: '0.05em' }}
        >
          {showAllTools ? '▲ collapse' : `▼ all ${TOOLS.length} tools`}
        </button>
      </div>
    </aside>
  );
}
