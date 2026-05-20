import { useEffect, useMemo, useRef, useState } from 'react';

const FILTERS = ['ALL', 'ERR', 'WARN', 'TRADE', 'API', 'SYS', 'OK'];

function classifyLog(item) {
  const category = String(item.category || '').toUpperCase();
  const message = String(item.message || '').toLowerCase();
  const tool = String(item.tool || '').toLowerCase();

  if (item._isAction) {
    if (item.success === false) return { tag: 'ERR', tone: 'bad' };
    if (tool.includes('swap') || tool.includes('position')) return { tag: 'TRADE', tone: 'warm' };
    if (tool.includes('discover') || tool.includes('token') || tool.includes('wallet')) return { tag: 'API', tone: 'info' };
    return { tag: 'OK', tone: 'good' };
  }

  if (category === 'ERROR' || category.endsWith('_ERROR') || message.includes(' error')) return { tag: 'ERR', tone: 'bad' };
  if (category === 'WARN' || category === 'WARNING' || category.endsWith('_WARN')) return { tag: 'WARN', tone: 'warn' };
  if (category.includes('TRADE') || category.includes('SWAP') || category === 'STRATEGY') return { tag: 'TRADE', tone: 'warm' };
  if (category === 'SCREENING' || category === 'DISCOVERY' || category === 'SCREENER') return { tag: 'API', tone: 'info' };
  if (category === 'STARTUP' || category === 'SYSTEM' || category === 'AGENT' || category === 'LLM' || category === 'REPORT' || category === 'PLAN' || category === 'MAIN') return { tag: 'SYS', tone: 'neutral' };
  return { tag: 'OK', tone: 'good' };
}

function matchesFilter(item, filter) {
  if (filter === 'ALL') return true;
  return classifyLog(item).tag === filter;
}

function fmtUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (Math.abs(num) >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - new Date(ts).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return 'now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function OverviewCard({ title, value, meta, tone = 'neutral' }) {
  return (
    <div className="overview-card">
      <p>{title}</p>
      <h3 className={`tone-${tone}`}>{value}</h3>
      <span>{meta}</span>
    </div>
  );
}

function TokenTable({ tokens }) {
  if (tokens.length === 0) {
    return <p className="muted-copy">No observed tokens yet.</p>;
  }

  return (
    <div className="table-shell">
      <div className="table-head four-col">
        <span>Token</span>
        <span>Mcap</span>
        <span>Rug</span>
        <span>Status</span>
      </div>
      {tokens.map((token, index) => (
        <div className="table-row four-col" key={token.mint || `${token.symbol}-${index}`}>
          <strong>{token.symbol || '—'}</strong>
          <span>{fmtUsd(token.initial_mcap)}</span>
          <span className={Number(token.rug_score) > 50 ? 'tone-bad' : Number(token.rug_score) > 20 ? 'tone-warn' : 'tone-good'}>
            {token.rug_score ?? '—'}
          </span>
          <span>{token.status || 'UNKNOWN'}</span>
        </div>
      ))}
    </div>
  );
}

export default function CenterPanel({ logs, actions, connected, agentData, lastUpdate }) {
  const [view, setView] = useState('overview');
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const feedRef = useRef(null);
  const feedBottomRef = useRef(null);

  const merged = useMemo(() => {
    const mappedLogs = logs.map((item, index) => ({ ...item, _id: `log-${index}-${item.timestamp}` }));
    const mappedActions = actions.map((item, index) => ({ ...item, _isAction: true, _id: `action-${index}-${item.timestamp}` }));
    return [...mappedLogs, ...mappedActions].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  }, [logs, actions]);

  const filteredFeed = useMemo(() => {
    return merged.filter((item) => {
      if (!matchesFilter(item, filter)) return false;
      if (!search) return true;
      const haystack = `${item.category || ''} ${item.message || ''} ${item.tool || ''}`.toLowerCase();
      return haystack.includes(search.toLowerCase());
    });
  }, [merged, filter, search]);

  useEffect(() => {
    if (autoScroll) {
      feedBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredFeed.length, autoScroll]);

  const positions = Object.values(agentData.state?.positions || {});
  const observed = [...(agentData.observedTokens?.observed || [])].reverse().slice(0, 12);
  const recentEvents = [...(agentData.state?.recentEvents || [])].reverse().slice(0, 5);
  const session = agentData.tradingPlan?.session || {};
  const latestReport = agentData.lastReport?.summary || {};
  const latestIntel = agentData.marketIntel?.snapshots?.[agentData.marketIntel?.snapshots?.length - 1];
  const okActions = actions.filter((item) => item.success !== false).length;
  const failedActions = actions.filter((item) => item.success === false).length;
  const errorCount = logs.filter((item) => classifyLog(item).tag === 'ERR').length;
  const warnCount = logs.filter((item) => classifyLog(item).tag === 'WARN').length;

  return (
    <section className="center-column">
      <div className="hero-panel">
        <div>
          <p className="eyebrow">Realtime Ops Grid</p>
          <h2>Ponyou cockpit with market, execution, memory, and safety surfaces</h2>
        </div>
        <div className="hero-actions">
          <button className={`toolbar-button ${view === 'overview' ? 'active' : ''}`} onClick={() => setView('overview')}>Overview</button>
          <button className={`toolbar-button ${view === 'timeline' ? 'active' : ''}`} onClick={() => setView('timeline')}>Timeline</button>
          <button className={`toolbar-button ${view === 'scan' ? 'active' : ''}`} onClick={() => setView('scan')}>Scan</button>
        </div>
      </div>

      <div className="overview-grid">
        <OverviewCard title="Open positions" value={positions.length} meta="Live position inventory" tone={positions.length > 0 ? 'good' : 'neutral'} />
        <OverviewCard title="Observed tokens" value={agentData.observedTokens?.observed?.length || 0} meta="Discovery stream size" tone="info" />
        <OverviewCard title="Actions" value={`${okActions}/${actions.length || 0}`} meta={`${failedActions} failed`} tone={failedActions > 0 ? 'warn' : 'good'} />
        <OverviewCard title="Latest market" value={String(agentData.marketIntel?.currentCondition || 'unknown').toUpperCase()} meta={`${latestIntel?.confidence || 0}% confidence`} tone="warm" />
      </div>

      {view === 'overview' ? (
        <div className="content-stack">
          <section className="deck-card">
            <div className="card-head">
              <div>
                <p className="card-kicker">Mission</p>
                <h3>Execution summary</h3>
              </div>
              <div className="card-aside">Updated {lastUpdate ? timeAgo(lastUpdate) : 'never'}</div>
            </div>
            <div className="metrics-grid three-up">
              <div className="metric-box">
                <span>Capital</span>
                <strong>{fmtUsd(session.currentCapitalUsd)}</strong>
              </div>
              <div className="metric-box">
                <span>Report P&L</span>
                <strong className={Number(latestReport.pnl_pct || 0) >= 0 ? 'tone-good' : 'tone-bad'}>
                  {Number.isFinite(Number(latestReport.pnl_pct)) ? `${Number(latestReport.pnl_pct).toFixed(2)}%` : '—'}
                </strong>
              </div>
              <div className="metric-box">
                <span>Win rate</span>
                <strong>{latestReport.win_rate != null ? `${latestReport.win_rate}%` : '—'}</strong>
              </div>
              <div className="metric-box">
                <span>Logs</span>
                <strong>{logs.length}</strong>
              </div>
              <div className="metric-box">
                <span>Warnings</span>
                <strong className="tone-warn">{warnCount}</strong>
              </div>
              <div className="metric-box">
                <span>Errors</span>
                <strong className="tone-bad">{errorCount}</strong>
              </div>
            </div>
          </section>

          <section className="dual-panel-grid">
            <div className="deck-card">
              <div className="card-head">
                <div>
                  <p className="card-kicker">Scan</p>
                  <h3>Observed market candidates</h3>
                </div>
                <div className="card-aside">{observed.length} shown</div>
              </div>
              <TokenTable tokens={observed} />
            </div>

            <div className="deck-card">
              <div className="card-head">
                <div>
                  <p className="card-kicker">Memory</p>
                  <h3>Recent events</h3>
                </div>
                <div className="card-aside">State journal</div>
              </div>
              {recentEvents.length > 0 ? (
                <div className="event-list">
                  {recentEvents.map((event, index) => (
                    <div className="event-row" key={`${event.ts || 'event'}-${index}`}>
                      <div>
                        <strong>{event.type || event.name || 'event'}</strong>
                        <p>{event.message || event.summary || JSON.stringify(event).slice(0, 120)}</p>
                      </div>
                      <span>{timeAgo(event.ts || event.timestamp)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted-copy">No recent events have been persisted into state yet.</p>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {view === 'timeline' ? (
        <div className="content-stack timeline-shell">
          <section className="toolbar-row">
            <div className="filter-group">
              {FILTERS.map((item) => (
                <button
                  key={item}
                  className={`filter-pill ${filter === item ? 'active' : ''}`}
                  onClick={() => setFilter(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="toolbar-side">
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="search logs, tools, categories"
              />
              <button className={`toolbar-button ${autoScroll ? 'active' : ''}`} onClick={() => setAutoScroll((value) => !value)}>
                Auto-scroll
              </button>
            </div>
          </section>

          <section
            className="feed-panel"
            ref={feedRef}
            onScroll={() => {
              if (!feedRef.current) return;
              const distance = feedRef.current.scrollHeight - feedRef.current.scrollTop - feedRef.current.clientHeight;
              if (distance > 140 && autoScroll) setAutoScroll(false);
              if (distance < 24 && !autoScroll) setAutoScroll(true);
            }}
          >
            {filteredFeed.map((item) => {
              const kind = classifyLog(item);
              const ts = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '—';
              const title = item._isAction ? (item.tool || 'action') : (item.category || 'log');
              const body = item._isAction
                ? `${item.success === false ? 'failed' : 'ok'}${item.summary ? ` — ${item.summary}` : ''}`
                : (item.message || item.raw || '');

              return (
                <div className={`feed-row tone-${kind.tone}`} key={item._id}>
                  <div className="feed-meta">
                    <span>{ts}</span>
                    <span className="feed-tag">{kind.tag}</span>
                    <strong>{title}</strong>
                  </div>
                  <p>{body}</p>
                </div>
              );
            })}
            <div ref={feedBottomRef} />
          </section>
        </div>
      ) : null}

      {view === 'scan' ? (
        <div className="content-stack">
          <section className="deck-card">
            <div className="card-head">
              <div>
                <p className="card-kicker">Intelligence</p>
                <h3>Observed token board</h3>
              </div>
              <div className="card-aside">Connected: {connected ? 'yes' : 'no'}</div>
            </div>
            <TokenTable tokens={[...(agentData.observedTokens?.observed || [])].reverse().slice(0, 24)} />
          </section>
        </div>
      ) : null}
    </section>
  );
}
