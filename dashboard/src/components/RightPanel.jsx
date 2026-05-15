import { useState } from 'react';

function fmt(n) {
  if (n == null) return '—';
  if (typeof n !== 'number') n = parseFloat(n);
  if (isNaN(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtPct(n) {
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function conditionColor(c) {
  const map = { HOT: 'var(--red)', COLD: 'var(--blue)', DEAD: 'var(--text-muted)', UNKNOWN: 'var(--text-muted)' };
  return map[(c || '').toUpperCase()] || 'var(--text-muted)';
}

function rugScoreColor(score) {
  if (score == null) return 'var(--text-muted)';
  if (score <= 20) return 'var(--green)';
  if (score <= 50) return 'var(--amber)';
  return 'var(--red)';
}

function statusColor(status) {
  const map = {
    PENDING:  'var(--cyan)',
    WATCHING: 'var(--amber)',
    DEPLOYED: 'var(--green)',
    REJECTED: 'var(--red)',
    SKIP:     'var(--text-muted)',
  };
  return map[(status || '').toUpperCase()] || 'var(--text-muted)';
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function MetricRow({ label, value, valueColor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 11 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: valueColor || 'var(--text)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function MarketIntelCard({ marketIntel }) {
  const condition = (marketIntel?.currentCondition || 'UNKNOWN').toUpperCase();
  const latest = marketIntel?.snapshots?.[marketIntel.snapshots.length - 1];
  const metrics = latest?.metrics || {};
  const confidence = latest?.confidence || 0;
  const history = (marketIntel?.snapshots || []).slice(-12);

  return (
    <div className="cyber-card">
      <div className="section-header">Market Intelligence</div>

      {/* Condition + confidence */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{
          fontSize: 18, fontWeight: 700,
          color: conditionColor(condition),
          textShadow: `0 0 12px ${conditionColor(condition)}`,
        }}>
          {condition === 'HOT' ? '🔥' : condition === 'COLD' ? '❄️' : condition === 'DEAD' ? '💀' : '?'}
          {' '}{condition}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10,
            color: 'var(--text-muted)', marginBottom: 2 }}>
            <span>confidence</span>
            <span style={{ color: conditionColor(condition) }}>{confidence}%</span>
          </div>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{
              width: `${confidence}%`,
              background: conditionColor(condition),
              boxShadow: `0 0 6px ${conditionColor(condition)}80`,
            }} />
          </div>
        </div>
      </div>

      {/* Metrics grid */}
      {metrics.avg_swaps != null && (
        <>
          <MetricRow label="avg swaps/token" value={fmtNum(metrics.avg_swaps)} valueColor="var(--text-dim)" />
          <MetricRow label="max swaps"        value={fmtNum(metrics.max_swaps)} />
          <MetricRow label="buy ratio"        value={fmtPct(metrics.buy_ratio)}
            valueColor={metrics.buy_ratio > 0.5 ? 'var(--green)' : 'var(--red)'} />
          <MetricRow label="hot ratio"        value={fmtPct(metrics.hot_ratio)}
            valueColor={metrics.hot_ratio > 0.7 ? 'var(--green)' : 'var(--amber)'} />
          {metrics.fresh_tokens_1h != null && (
            <MetricRow label="fresh tokens/1h" value={metrics.fresh_tokens_1h} />
          )}
        </>
      )}

      {/* Mini history chart */}
      {history.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
            condition history ({history.length} snapshots)
          </div>
          <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 24 }}>
            {history.map((snap, i) => {
              const c = (snap.condition || '').toUpperCase();
              const color = conditionColor(c);
              const h = c === 'HOT' ? 24 : c === 'COLD' ? 16 : 8;
              return (
                <div key={i} title={`${c} ${snap.confidence}% @ ${new Date(snap.ts).toLocaleTimeString()}`}
                  style={{ flex: 1, height: h, background: color, opacity: 0.7, borderRadius: 1,
                    transition: 'height 0.3s' }} />
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9,
            color: 'var(--text-muted)', marginTop: 2 }}>
            <span>{timeAgo(history[0]?.ts)}</span>
            <span>now</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ObservedTokensCard({ observedTokens }) {
  const [showAll, setShowAll] = useState(false);
  const tokens = observedTokens?.observed || [];
  const visible = showAll ? tokens : tokens.slice(-15);
  const recent = [...visible].reverse();

  if (tokens.length === 0) {
    return (
      <div className="cyber-card">
        <div className="section-header">Market Scan</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 11, textAlign: 'center', padding: '10px 0' }}>
          No tokens observed yet
        </div>
      </div>
    );
  }

  return (
    <div className="cyber-card">
      <div className="section-header">
        Market Scan
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 10 }}>
          {tokens.length} tokens
        </span>
      </div>

      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr 52px 52px',
        gap: 4, padding: '3px 0', borderBottom: '1px solid var(--border)',
        marginBottom: 4, fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
        <span>SYMBOL</span>
        <span>MCAP</span>
        <span style={{ textAlign: 'right' }}>RUG</span>
        <span style={{ textAlign: 'right' }}>STATUS</span>
      </div>

      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {recent.map((token, i) => (
          <div key={token.mint || i} className="token-row" style={{
            display: 'grid',
            gridTemplateColumns: '52px 1fr 52px 52px',
            gap: 4,
            padding: '3px 0',
            borderBottom: '1px solid rgba(26,26,58,0.5)',
            fontSize: 11,
          }}>
            <span style={{ color: 'var(--cyan)', fontWeight: 600, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {token.symbol || '?'}
            </span>
            <span style={{ color: 'var(--text-dim)' }}>
              {fmt(token.initial_mcap)}
            </span>
            <span style={{ textAlign: 'right', color: rugScoreColor(token.rug_score) }}>
              {token.rug_score ?? '?'}
            </span>
            <span style={{ textAlign: 'right', color: statusColor(token.status), fontSize: 9, fontWeight: 600 }}>
              {(token.status || '?').slice(0, 4)}
            </span>
          </div>
        ))}
      </div>

      {tokens.length > 15 && (
        <button onClick={() => setShowAll(v => !v)} style={{
          marginTop: 6, width: '100%', background: 'none', border: '1px solid var(--border)',
          color: 'var(--text-muted)', padding: '3px 8px', cursor: 'pointer',
          fontSize: 10, fontFamily: 'inherit', borderRadius: 2,
        }}>
          {showAll ? '▲ show less' : `▼ show all ${tokens.length}`}
        </button>
      )}

      {/* Flags summary */}
      {recent.slice(0, 3).some(t => t.flags?.length > 0) && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4,
            letterSpacing: '0.05em', textTransform: 'uppercase' }}>Recent Flags</div>
          {recent.filter(t => t.flags?.length > 0).slice(0, 3).map((token, i) => (
            <div key={i} style={{ marginBottom: 3, fontSize: 10, display: 'flex', gap: 6 }}>
              <span style={{ color: 'var(--cyan)', flexShrink: 0 }}>{token.symbol}</span>
              <span style={{ color: 'var(--amber)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {token.flags[0]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DailyResultsCard({ tradingPlan }) {
  const results = tradingPlan?.dailyResults || [];
  if (results.length === 0) return null;

  return (
    <div className="cyber-card">
      <div className="section-header">Daily Results</div>
      <div style={{ maxHeight: 160, overflowY: 'auto' }}>
        {[...results].reverse().map((r, i) => (
          <div key={i} style={{
            display: 'flex', justifyContent: 'space-between',
            padding: '3px 0', borderBottom: '1px solid rgba(26,26,58,0.5)',
            fontSize: 11,
          }}>
            <span style={{ color: 'var(--text-muted)' }}>Day {r.day} — {r.date}</span>
            <span style={{
              color: r.pnl_pct >= 0 ? 'var(--green)' : 'var(--red)',
              fontWeight: 600,
            }}>
              {r.pnl_pct >= 0 ? '+' : ''}{(r.pnl_pct || 0).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LearningCard({ learningState, lastReport }) {
  const lessons = learningState?.lessonCount ?? learningState?.lessons?.length ?? 0;
  const rugMemory = learningState?.rugMemory?.length || 0;
  const darwinEnabled = lastReport?.darwinEnabled;
  const pnl = lastReport?.summary?.pnl_pct;
  const trades = lastReport?.summary?.trades;
  const winRate = lastReport?.summary?.win_rate;

  return (
    <div className="cyber-card">
      <div className="section-header">Agent Memory & Report</div>
      <MetricRow label="Lessons learned" value={lessons} valueColor="var(--purple)" />
      <MetricRow label="Rug memory" value={rugMemory} valueColor="var(--red)" />
      {lastReport && (
        <>
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4,
              letterSpacing: '0.05em', textTransform: 'uppercase' }}>Today's Report</div>
            <MetricRow label="P&L"
              value={pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%` : '—'}
              valueColor={pnl >= 0 ? 'var(--green)' : 'var(--red)'} />
            <MetricRow label="Trades"   value={trades ?? '—'} />
            <MetricRow label="Win rate" value={winRate != null ? `${winRate.toFixed(0)}%` : '—'}
              valueColor={winRate >= 50 ? 'var(--green)' : 'var(--amber)'} />
          </div>
        </>
      )}
    </div>
  );
}

function DarwinCard({ userConfig }) {
  if (!userConfig?.darwinEnabled) return null;
  return (
    <div className="cyber-card">
      <div className="section-header">Darwin Optimizer</div>
      <MetricRow label="Status"      value="ENABLED"              valueColor="var(--green)" />
      <MetricRow label="Window"      value={`${userConfig.darwinWindowDays}d`} />
      <MetricRow label="Boost"       value={`×${userConfig.darwinBoost}`}       valueColor="var(--green)" />
      <MetricRow label="Decay"       value={`×${userConfig.darwinDecay}`}        valueColor="var(--red)" />
      <MetricRow label="Floor/Ceil"  value={`${userConfig.darwinFloor} — ${userConfig.darwinCeiling}`} />
      <MetricRow label="Min samples" value={userConfig.darwinMinSamples} />
    </div>
  );
}

export default function RightPanel({ agentData }) {
  const { marketIntel, observedTokens, tradingPlan, learningState, lastReport, userConfig } = agentData;

  return (
    <aside style={{
      background: 'var(--panel)',
      overflowY: 'auto',
      overflowX: 'hidden',
      padding: '10px 10px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <MarketIntelCard marketIntel={marketIntel} />
      <ObservedTokensCard observedTokens={observedTokens} />
      <LearningCard learningState={learningState} lastReport={lastReport} />
      <DailyResultsCard tradingPlan={tradingPlan} />
      <DarwinCard userConfig={userConfig} />
    </aside>
  );
}
