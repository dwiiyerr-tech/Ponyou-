import { useState, useEffect, useRef, useCallback } from 'react';

const FILTERS = ['ALL', 'TRADE', 'API', 'TOOL', 'WARN', 'SYS', 'OK'];

// Map category → CSS class + tag label
function classifyLog(item) {
  const c = (item.category || '').toUpperCase();
  const msg = (item.message || '').toLowerCase();

  if (item._isAction) {
    const tool = (item.tool || '').toLowerCase();
    if (tool === 'gmgn_swap' || tool.includes('swap') || tool.includes('position')) {
      return { cls: 'log-trade', tag: 'TRADE' };
    }
    if (tool.includes('discover') || tool.includes('token') || tool.includes('smart')) {
      return { cls: 'log-api', tag: 'API' };
    }
    return { cls: item.success ? 'log-ok' : 'log-neg', tag: item.success ? 'OK' : 'ERR' };
  }

  if (c === 'ERROR')                           return { cls: 'log-neg',   tag: 'ERR' };
  if (c === 'WARN' || c === 'WARNING')         return { cls: 'log-warn',  tag: 'WARN' };
  if (c === 'SCREENER')                        return { cls: 'log-api',   tag: 'API' };
  if (c === 'MANAGER')                         return { cls: 'log-tool',  tag: 'TOOL' };
  if (c === 'DARWIN')                          return { cls: 'log-tool',  tag: 'TOOL' };
  if (c === 'MAIN' || c === 'LOOP' || c === 'SYSTEM') return { cls: 'log-sys', tag: 'SYS' };
  if (c === 'SESSION' || c === 'GATE')         return { cls: 'log-sys',   tag: 'SYS' };
  if (c.includes('TRADE') || c.includes('SWAP')) return { cls: 'log-trade', tag: 'TRADE' };
  if (c === 'DEBUG')                           return { cls: 'log-muted', tag: 'DBG' };

  // Message-based heuristics
  if (msg.includes('swap') || msg.includes('deploy') || msg.includes('pnl'))
    return { cls: 'log-trade', tag: 'TRADE' };
  if (msg.includes('gmgn') || msg.includes('api') || msg.includes('fetch'))
    return { cls: 'log-api', tag: 'API' };
  if (msg.includes('lesson') || msg.includes('darwin') || msg.includes('config'))
    return { cls: 'log-tool', tag: 'TOOL' };
  if (msg.includes('session') || msg.includes('market') || msg.includes('condition'))
    return { cls: 'log-sys', tag: 'SYS' };
  if (msg.includes('success') || msg.includes('✓') || msg.includes('profit'))
    return { cls: 'log-ok', tag: 'OK' };

  return { cls: 'log-dim', tag: 'INFO' };
}

function matchesFilter(item, filter) {
  if (filter === 'ALL') return true;
  const { tag } = classifyLog(item);
  return tag === filter;
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ''; }
}

function formatAction(item) {
  const a = item.args   || {};
  const r = item.result || {};
  const dur = item.duration_ms != null ? ` (${item.duration_ms}ms)` : '';
  switch (item.tool) {
    case 'gmgn_swap':
      return `swap ${a.amount} ${(a.token_in || '').slice(0, 8)} → ${(a.token_out || '').slice(0, 8)}${dur}`;
    case 'deploy_position':
      return `deploy ${a.pool_name || a.pool_address?.slice(0, 10)} ${a.amount_sol} SOL${dur}`;
    case 'close_position': {
      const pnl = r.pnl_usd != null ? ` | PnL ${r.pnl_usd >= 0 ? '+' : ''}$${r.pnl_usd}` : '';
      return `close ${a.position_address?.slice(0, 10)}${pnl}${dur}`;
    }
    case 'get_wallet_balance':
      return `wallet: ${r.sol ?? '?'} SOL${dur}`;
    case 'get_top_candidates':
      return `found ${r?.candidates?.length ?? 0} candidates${dur}`;
    case 'discover_tokens':
      return `discovered ${r?.tokens?.length ?? r?.length ?? 0} tokens${dur}`;
    case 'add_lesson':
      return `lesson: "${a.rule?.slice(0, 70) || ''}"`;
    case 'update_config':
      return `config: ${Object.keys(r.applied || a.changes || {}).join(', ')}${dur}`;
    default:
      return item.message || `${item.tool} ${JSON.stringify(r).slice(0, 60)}${dur}`;
  }
}

const TAG_COLORS = {
  TRADE: 'var(--trade)',
  API:   'var(--api)',
  TOOL:  'var(--tool)',
  SYS:   'var(--sys)',
  WARN:  'var(--warn)',
  OK:    'var(--ok)',
  ERR:   'var(--neg)',
  INFO:  'var(--dim)',
  DBG:   'var(--muted)',
};

function LogLine({ item }) {
  const { cls, tag } = classifyLog(item);
  const isAction = item._isAction;
  const prefix = isAction ? (item.success ? '✓' : '✗') : '›';
  const text = isAction ? formatAction(item) : item.message;
  const tagColor = TAG_COLORS[tag] || 'var(--dim)';

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '56px 44px 1fr',
      gap: 8,
      padding: '1.5px 0',
      borderBottom: '1px solid rgba(26,46,26,0.35)',
      fontSize: 12,
      lineHeight: 1.55,
    }}>
      {/* Timestamp */}
      <span style={{ color: 'var(--muted)', fontSize: 10, paddingTop: 2, userSelect: 'none' }}>
        {formatTime(item.timestamp)}
      </span>

      {/* Tag badge */}
      <span style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.05em',
        color: tagColor,
        paddingTop: 3,
        textAlign: 'right',
        userSelect: 'none',
        opacity: 0.9,
      }}>
        [{tag}]
      </span>

      {/* Message */}
      <span className={cls} style={{ wordBreak: 'break-word' }}>
        <span style={{ color: tagColor, marginRight: 4, userSelect: 'none' }}>{prefix}</span>
        {text}
      </span>
    </div>
  );
}

function StatsBar({ logs, actions }) {
  const errs    = logs.filter(l => (l.category || '').toUpperCase() === 'ERROR').length;
  const warns   = logs.filter(l => (l.category || '').toUpperCase().includes('WARN')).length;
  const okActs  = actions.filter(a => a.success).length;
  const failActs= actions.filter(a => !a.success).length;

  return (
    <div style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--muted)',
      padding: '4px 12px', borderBottom: '1px solid var(--border)',
      background: 'rgba(0,0,0,0.15)', flexShrink: 0 }}>
      <span>lines: <span style={{ color: 'var(--dim)' }}>{logs.length}</span></span>
      {warns  > 0 && <span>warns: <span style={{ color: 'var(--warn)' }}>{warns}</span></span>}
      {errs   > 0 && <span>errors: <span style={{ color: 'var(--neg)' }}>{errs}</span></span>}
      <span>
        actions: <span style={{ color: 'var(--ok)' }}>{okActs}</span>
        {failActs > 0 && <span style={{ color: 'var(--neg)' }}>/{failActs} fail</span>}
      </span>
    </div>
  );
}

const FILTER_COLORS = {
  ALL:   'var(--text)',
  TRADE: 'var(--trade)',
  API:   'var(--api)',
  TOOL:  'var(--tool)',
  WARN:  'var(--warn)',
  SYS:   'var(--sys)',
  OK:    'var(--ok)',
};

export default function CenterPanel({ logs, actions, connected }) {
  const [filter, setFilter] = useState('ALL');
  const [autoScroll, setAutoScroll] = useState(true);
  const [search, setSearch] = useState('');
  const bottomRef   = useRef(null);
  const containerRef = useRef(null);

  // Merge logs + actions into unified timeline
  const merged = (() => {
    const ls = logs.map((l, i)    => ({ ...l, _id: `l${i}-${l.timestamp}` }));
    const as = actions.map((a, i) => ({ ...a, _isAction: true, _id: `a${i}-${a.timestamp}` }));
    return [...ls, ...as].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  })();

  const filtered = merged.filter(item => {
    if (!matchesFilter(item, filter)) return false;
    if (search) {
      const q = search.toLowerCase();
      const t = (item.message || item.tool || '').toLowerCase();
      if (!t.includes(q)) return false;
    }
    return true;
  });

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filtered.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist > 100 && autoScroll) setAutoScroll(false);
    if (dist < 10  && !autoScroll) setAutoScroll(true);
  }, [autoScroll]);

  const lastAction = actions[actions.length - 1];

  return (
    <main style={{
      borderRight: '1px solid var(--border)',
      background: 'var(--bg-page)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-header)', display: 'flex', alignItems: 'center',
        gap: 12, flexShrink: 0 }}>
        <span style={{ color: 'var(--title)', fontFamily: 'var(--font-title)',
          fontSize: 20, letterSpacing: '0.1em' }}>
          LIVE LOG FEED
        </span>
        <span style={{ flex: 1 }} />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="search..."
          style={{ width: 130 }}
        />
        <button
          onClick={() => setAutoScroll(v => !v)}
          style={{
            background: autoScroll ? 'rgba(57,255,20,0.08)' : 'var(--bg-card)',
            border: `1px solid ${autoScroll ? 'var(--ok)' : 'var(--border)'}`,
            color: autoScroll ? 'var(--ok)' : 'var(--muted)',
            padding: '3px 10px', fontSize: 10, letterSpacing: '0.05em',
          }}
        >
          ↓ AUTOSCROLL
        </button>
        <button
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)',
            color: 'var(--muted)', padding: '3px 10px', fontSize: 10 }}
        >
          ↓ JUMP
        </button>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '5px 12px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0 }}>
        {FILTERS.map(f => {
          const active = filter === f;
          const col = FILTER_COLORS[f] || 'var(--dim)';
          return (
            <button key={f} onClick={() => setFilter(f)} style={{
              background: active ? `${col}12` : 'none',
              border: `1px solid ${active ? col : 'var(--border)'}`,
              color: active ? col : 'var(--muted)',
              padding: '2px 10px', fontSize: 10,
              letterSpacing: '0.06em', fontWeight: active ? 700 : 400,
            }}>
              {f}
            </button>
          );
        })}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)', alignSelf: 'center' }}>
          {filtered.length}/{merged.length}
        </span>
      </div>

      <StatsBar logs={logs} actions={actions} />

      {/* Log stream */}
      <div ref={containerRef} onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '4px 12px' }}>

        {!connected && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--muted)' }}>
            <div style={{ fontSize: 32, marginBottom: 8, color: 'var(--border-bright)' }}>◌</div>
            <div style={{ fontSize: 12, color: 'var(--dim)' }}>Connecting to agent server...</div>
            <div style={{ fontSize: 10, marginTop: 4 }}>WebSocket: ws://{window.location.host}/ws</div>
          </div>
        )}

        {connected && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--muted)' }}>
            <div style={{ fontSize: 28, marginBottom: 8, color: 'var(--border-bright)' }}>⬡</div>
            <div style={{ fontSize: 12, color: 'var(--dim)' }} className="cursor-blink">
              {filter !== 'ALL' ? `No [${filter}] entries` : 'Awaiting agent activity'}
            </div>
          </div>
        )}

        {filtered.map((item, i) => <LogLine key={item._id || i} item={item} />)}
        <div ref={bottomRef} />
      </div>

      {/* Last action footer */}
      {lastAction && (
        <div style={{ padding: '5px 12px', borderTop: '1px solid var(--border)',
          background: 'var(--bg-panel)', display: 'flex', alignItems: 'center',
          gap: 8, fontSize: 10, flexShrink: 0 }}>
          <span style={{ color: 'var(--muted)' }}>last:</span>
          <span style={{
            color: lastAction.success ? 'var(--ok)' : 'var(--neg)', fontWeight: 700
          }}>
            [{lastAction.tool}]
          </span>
          <span style={{ color: 'var(--dim)', flex: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {formatAction(lastAction)}
          </span>
          <span style={{ color: 'var(--muted)', flexShrink: 0 }}>
            {formatTime(lastAction.timestamp)}
          </span>
        </div>
      )}
    </main>
  );
}
