import { useState, useEffect, useCallback } from 'react';
import LeftPanel from './components/LeftPanel.jsx';
import CenterPanel from './components/CenterPanel.jsx';
import RightPanel from './components/RightPanel.jsx';

function inferAgentStatus(state, tradingPlan) {
  if (!state) return 'OFFLINE';
  const positions = Object.keys(state.positions || {});
  if (positions.length > 0) return 'TRADING';
  if (tradingPlan?.session?.pausedUntil) {
    if (new Date(tradingPlan.session.pausedUntil) > new Date()) return 'PAUSED';
  }
  return 'IDLE';
}

const MAX_LOGS = 600;
const MAX_ACTIONS = 150;

export default function App() {
  const [connected, setConnected] = useState(false);
  const [agentData, setAgentData] = useState({
    agentStatus: 'OFFLINE',
    state: { positions: {}, recentEvents: [] },
    tradingPlan: null,
    observedTokens: { observed: [] },
    marketIntel: { currentCondition: 'UNKNOWN', snapshots: [] },
    lastReport: null,
    learningState: null,
    userConfig: {},
  });
  const [logs, setLogs] = useState([]);
  const [actions, setActions] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);

  const handleMessage = useCallback((msg) => {
    if (msg.type === 'init') {
      const d = msg.data;
      setAgentData({
        agentStatus: inferAgentStatus(d.state, d.tradingPlan),
        state: d.state || { positions: {}, recentEvents: [] },
        tradingPlan: d.tradingPlan || null,
        observedTokens: d.observedTokens || { observed: [] },
        marketIntel: d.marketIntel || { currentCondition: 'UNKNOWN', snapshots: [] },
        lastReport: d.lastReport || null,
        learningState: d.learningState || null,
        userConfig: d.userConfig || {},
      });
      setLogs((d.recentLogs || []).slice(-MAX_LOGS));
      setActions((d.recentActions || []).slice(-MAX_ACTIONS));
      setLastUpdate(Date.now());
    }

    if (msg.type === 'state_update') {
      const d = msg.data;
      setAgentData(prev => ({
        ...prev,
        agentStatus: inferAgentStatus(d.state || prev.state, d.tradingPlan || prev.tradingPlan),
        ...(d.state         && { state: d.state }),
        ...(d.tradingPlan   && { tradingPlan: d.tradingPlan }),
        ...(d.observedTokens && { observedTokens: d.observedTokens }),
        ...(d.marketIntel   && { marketIntel: d.marketIntel }),
        ...(d.lastReport    && { lastReport: d.lastReport }),
        ...(d.learningState && { learningState: d.learningState }),
        ...(d.userConfig    && { userConfig: d.userConfig }),
      }));
      setLastUpdate(Date.now());
    }

    if (msg.type === 'log_line') {
      setLogs(prev => [...prev.slice(-(MAX_LOGS - 1)), msg.data]);
    }

    if (msg.type === 'action') {
      setActions(prev => [...prev.slice(-(MAX_ACTIONS - 1)), msg.data]);
      setLastUpdate(Date.now());
    }
  }, []);

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let pingInterval = null;
    let alive = true;

    function getWsUrl() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws`;
    }

    function connect() {
      if (!alive) return;
      try {
        ws = new WebSocket(getWsUrl());
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        setConnected(true);
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 20000);
      };

      ws.onmessage = (e) => {
        try {
          handleMessage(JSON.parse(e.data));
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        clearInterval(pingInterval);
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    function scheduleReconnect() {
      if (!alive) return;
      reconnectTimer = setTimeout(connect, 3000);
    }

    connect();

    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      clearInterval(pingInterval);
      ws?.close();
    };
  }, [handleMessage]);

  return (
    <div className="grid-bg" style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="scanline-overlay" />

      {/* Top header bar */}
      <header style={{
        background: 'var(--bg-header)',
        borderBottom: '1px solid var(--border)',
        padding: '5px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{
            fontFamily: 'var(--font-title)',
            color: 'var(--title)',
            fontSize: 28,
            letterSpacing: '0.1em',
            lineHeight: 1,
          }} className="glow-title">
            PONYOU
          </span>
          <span style={{ color: 'var(--dim)', fontSize: 11, letterSpacing: '0.12em' }}>
            AGENT DASHBOARD
          </span>
          <span style={{ color: 'var(--muted)', fontSize: 10 }}>v1.0</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {lastUpdate && (
            <span style={{ color: 'var(--muted)', fontSize: 10 }}>
              sync {new Date(lastUpdate).toLocaleTimeString()}
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              className="pulse-dot"
              style={{ background: connected ? 'var(--ok)' : 'var(--neg)' }}
            />
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.1em',
              color: connected ? 'var(--ok)' : 'var(--neg)',
            }}>
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <span style={{ color: 'var(--muted)', fontSize: 10, fontFamily: 'var(--font-body)' }}>
            {new Date().toLocaleTimeString()}
          </span>
        </div>
      </header>

      {/* Main 3-panel layout */}
      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '280px 1fr 300px',
        gap: 0,
        overflow: 'hidden',
        minHeight: 0,
      }}>
        <LeftPanel agentData={agentData} connected={connected} />
        <CenterPanel logs={logs} actions={actions} connected={connected} agentData={agentData} />
        <RightPanel agentData={agentData} />
      </div>
    </div>
  );
}
