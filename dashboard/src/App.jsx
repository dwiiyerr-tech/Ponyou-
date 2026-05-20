import { useEffect, useRef, useState } from 'react';
import LeftPanel from './components/LeftPanel.jsx';
import CenterPanel from './components/CenterPanel.jsx';
import RightPanel from './components/RightPanel.jsx';
import SetupWizard from './components/SetupWizard.jsx';

function inferAgentStatus(state, tradingPlan) {
  if (!state) return 'OFFLINE';
  const positions = Object.keys(state.positions || {});
  if (positions.length > 0) return 'TRADING';
  if (tradingPlan?.session?.pausedUntil) {
    if (new Date(tradingPlan.session.pausedUntil).getTime() > Date.now()) return 'PAUSED';
  }
  return 'IDLE';
}

const MAX_LOGS = 800;
const MAX_ACTIONS = 200;

function emptyAgentData() {
  return {
    agentStatus: 'OFFLINE',
    state: { positions: {}, recentEvents: [] },
    tradingPlan: null,
    observedTokens: { observed: [] },
    marketIntel: { currentCondition: 'UNKNOWN', snapshots: [] },
    lastReport: null,
    learningState: null,
    userConfig: {},
    strategyState: { activeId: 'scalping', available: [] },
    automationState: { enabled: false, cronStarted: false, telegramPolling: false, updatedAt: null },
    supervisorState: { desiredRunning: false, agentRunning: false, pid: null, mode: null, updatedAt: null },
    setupState: { mode: 'live', modeLabel: 'LIVE', config: {}, env: {}, readiness: { missing: [] }, strategyOptions: [], updatedAt: null },
    serverTime: null,
  };
}

export default function App() {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [screen, setScreen] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('view') === 'setup' ? 'setup' : 'dashboard';
    } catch {
      return 'dashboard';
    }
  });
  const [setupSaving, setSetupSaving] = useState(false);
  const [agentData, setAgentData] = useState(emptyAgentData);
  const [logs, setLogs] = useState([]);
  const [actions, setActions] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [lastHeartbeat, setLastHeartbeat] = useState(null);
  const [operatorNotice, setOperatorNotice] = useState(null);

  useEffect(() => {
    let reconnectTimer = null;
    let pingInterval = null;
    let alive = true;

    function getWsUrl() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws`;
    }

    function applySnapshot(d) {
      setAgentData((prev) => ({
        ...prev,
        agentStatus: inferAgentStatus(d.state || prev.state, d.tradingPlan || prev.tradingPlan),
        ...(d.state && { state: d.state }),
        ...(d.tradingPlan && { tradingPlan: d.tradingPlan }),
        ...(d.observedTokens && { observedTokens: d.observedTokens }),
        ...(d.marketIntel && { marketIntel: d.marketIntel }),
        ...(d.lastReport && { lastReport: d.lastReport }),
        ...(d.learningState && { learningState: d.learningState }),
        ...(d.userConfig && { userConfig: d.userConfig }),
        ...(d.strategyState && { strategyState: d.strategyState }),
        ...(d.automationState && { automationState: d.automationState }),
        ...(d.supervisorState && { supervisorState: d.supervisorState }),
        ...(d.setupState && { setupState: d.setupState }),
        ...(d.serverTime && { serverTime: d.serverTime }),
      }));

      if (Array.isArray(d.recentLogs)) setLogs(d.recentLogs.slice(-MAX_LOGS));
      if (Array.isArray(d.recentActions)) setActions(d.recentActions.slice(-MAX_ACTIONS));
      setLastUpdate(Date.now());
    }

    function connect() {
      if (!alive) return;

      try {
        wsRef.current = new WebSocket(getWsUrl());
      } catch {
        scheduleReconnect();
        return;
      }

      wsRef.current.onopen = () => {
        setConnected(true);
        setLastHeartbeat(Date.now());
        pingInterval = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'ping' }));
          }
        }, 20000);
      };

      wsRef.current.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'init') {
            applySnapshot(msg.data || {});
            return;
          }

          if (msg.type === 'state_update') {
            applySnapshot(msg.data || {});
            return;
          }

          if (msg.type === 'log_line') {
            setLogs((prev) => [...prev.slice(-(MAX_LOGS - 1)), msg.data]);
            setLastUpdate(Date.now());
            return;
          }

          if (msg.type === 'action') {
            setActions((prev) => [...prev.slice(-(MAX_ACTIONS - 1)), msg.data]);
            setLastUpdate(Date.now());
            return;
          }

          if (msg.type === 'action_result') {
            if (msg.data?.action === 'apply_setup_wizard') {
              setSetupSaving(false);
            }
            setOperatorNotice({
              message: msg.data?.message || 'Operator action processed.',
              ok: !!msg.data?.ok,
              live: !!msg.data?.live,
              ts: Date.now(),
            });
            return;
          }

          if (msg.type === 'pong' || msg.type === 'ping') {
            setLastHeartbeat(Date.now());
          }
        } catch {
          // Ignore malformed dashboard events.
        }
      };

      wsRef.current.onclose = () => {
        setConnected(false);
        clearInterval(pingInterval);
        scheduleReconnect();
      };

      wsRef.current.onerror = () => {
        wsRef.current?.close();
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
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!operatorNotice) return undefined;
    const timer = setTimeout(() => setOperatorNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [operatorNotice]);

  const modeLabel = agentData.userConfig?.executionMode || (agentData.userConfig?.dryRun ? 'demo' : 'live');
  const supervisorDesired = !!agentData.supervisorState?.desiredRunning;
  const supervisorRunning = !!agentData.supervisorState?.agentRunning;
  const agentPowerLabel = supervisorDesired ? (supervisorRunning ? 'ON' : 'BOOTING') : 'OFF';
  const automationLabel = agentData.automationState?.enabled
    ? (agentData.automationState?.cronStarted ? 'ON' : 'ARMED')
    : 'OFF';

  function setView(nextView) {
    setScreen(nextView);
    try {
      const url = new URL(window.location.href);
      if (nextView === 'setup') {
        url.searchParams.set('view', 'setup');
      } else {
        url.searchParams.delete('view');
      }
      const qs = url.searchParams.toString();
      window.history.replaceState({}, '', `${url.pathname}${qs ? `?${qs}` : ''}${url.hash}`);
    } catch {
      // ignore history updates in non-browser contexts
    }
  }

  function sendControl(action, extra = {}) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setOperatorNotice({
        message: 'Dashboard socket is not connected. Control action was not sent.',
        ok: false,
        live: false,
        ts: Date.now(),
      });
      return;
    }

    wsRef.current.send(JSON.stringify({
      type: 'control_action',
      action,
      ...extra,
    }));
  }

  return (
    <div className="app-shell">
      <div className="app-chrome" />
      <header className="topbar">
        <div>
          <p className="eyebrow">Ponyou Operator Surface</p>
          <h1>PONYOU Control Deck</h1>
        </div>

        <div className="topbar-meta">
          <div className={`signal-pill ${connected ? 'is-live' : 'is-offline'}`}>
            <span className="signal-dot" />
            <span>{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <div className="topbar-stat">
            <span>Mode</span>
            <strong>{String(modeLabel).toUpperCase()}</strong>
          </div>
          <div className="topbar-stat">
            <span>Strategy</span>
            <strong>{String(agentData.strategyState?.activeId || 'scalping').toUpperCase()}</strong>
          </div>
          <div className={`topbar-stat topbar-stat--status ${supervisorDesired ? (supervisorRunning ? 'is-good' : 'is-warn') : 'is-bad'}`}>
            <span>Agent Power</span>
            <strong>{agentPowerLabel}</strong>
          </div>
          <div className={`topbar-stat topbar-stat--status ${agentData.automationState?.enabled ? (agentData.automationState?.cronStarted ? 'is-good' : 'is-warn') : 'is-bad'}`}>
            <span>Automation</span>
            <strong>{automationLabel}</strong>
          </div>
          <div className="topbar-stat">
            <span>Last Sync</span>
            <strong>{lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : 'Waiting'}</strong>
          </div>
          <div className="topbar-stat">
            <span>Heartbeat</span>
            <strong>{lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString() : 'Waiting'}</strong>
          </div>
          <button type="button" className="topbar-setup-button" onClick={() => setView('setup')}>
            Setup Wizard
          </button>
        </div>
      </header>

      {operatorNotice ? (
        <div className={`operator-notice ${operatorNotice.ok ? 'ok' : 'bad'}`}>
          <strong>{operatorNotice.ok ? 'Operator action applied' : 'Operator action failed'}</strong>
          <span>{operatorNotice.message}</span>
          <em>{operatorNotice.live ? 'Live effect' : 'Persistent / restart-bound effect'}</em>
        </div>
      ) : null}

      {screen === 'setup' ? (
        <SetupWizard
          setupState={agentData.setupState}
          agentData={agentData}
          connected={connected}
          saving={setupSaving}
          onBack={() => setView('dashboard')}
          onRunDoctor={() => sendControl('refresh_state')}
          onApply={(draft) => {
            setSetupSaving(true);
            sendControl('apply_setup_wizard', { draft });
          }}
        />
      ) : (
        <main className="dashboard-grid">
          <LeftPanel
            agentData={agentData}
            connected={connected}
            lastUpdate={lastUpdate}
          />
          <CenterPanel
            logs={logs}
            actions={actions}
            connected={connected}
            agentData={agentData}
            lastUpdate={lastUpdate}
          />
          <RightPanel
            agentData={agentData}
            logs={logs}
            actions={actions}
            connected={connected}
            lastUpdate={lastUpdate}
            lastHeartbeat={lastHeartbeat}
            sendControl={sendControl}
            onOpenSetup={() => setView('setup')}
          />
        </main>
      )}
    </div>
  );
}
