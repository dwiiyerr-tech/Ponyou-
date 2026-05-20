function fmtUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (Math.abs(num) >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function classifyLog(item) {
  const category = String(item.category || '').toUpperCase();
  const message = String(item.message || '').toLowerCase();
  const tool = String(item.tool || '').toLowerCase();

  if (item._isAction) {
    if (item.success === false) return { tag: 'ERR', tone: 'bad' };
    if (tool.includes('swap') || tool.includes('position')) return { tag: 'TRADE', tone: 'warm' };
    return { tag: 'OK', tone: 'good' };
  }

  if (category === 'ERROR' || category.endsWith('_ERROR') || message.includes(' error')) return { tag: 'ERR', tone: 'bad' };
  if (category === 'WARN' || category === 'WARNING' || category.endsWith('_WARN')) return { tag: 'WARN', tone: 'warn' };
  return { tag: 'INFO', tone: 'neutral' };
}

function buildDoctor(agentData, logs, actions, connected, lastUpdate, lastHeartbeat) {
  const cfg = agentData.userConfig || {};
  const positions = Object.keys(agentData.state?.positions || {});
  const recentLogs = logs.slice(-120);
  const recentActions = actions.slice(-40);
  const recentErrors = recentLogs.filter((item) => classifyLog(item).tag === 'ERR');
  const recentWarnings = recentLogs.filter((item) => classifyLog(item).tag === 'WARN');
  const failedActions = recentActions.filter((item) => item.success === false);
  const wallets = Array.isArray(cfg.wallets) ? cfg.wallets : [];

  const checks = [
    {
      label: 'WebSocket connection',
      ok: connected,
      severity: 'critical',
      note: connected ? 'dashboard stream healthy' : 'dashboard disconnected from runtime',
    },
    {
      label: 'Fresh runtime updates',
      ok: !!lastUpdate && Date.now() - lastUpdate < 90_000,
      severity: 'high',
      note: lastUpdate ? `${Math.round((Date.now() - lastUpdate) / 1000)}s since last update` : 'no update received yet',
    },
    {
      label: 'Heartbeat freshness',
      ok: !!lastHeartbeat && Date.now() - lastHeartbeat < 45_000,
      severity: 'medium',
      note: lastHeartbeat ? `${Math.round((Date.now() - lastHeartbeat) / 1000)}s since heartbeat` : 'no heartbeat received yet',
    },
    {
      label: 'Recent log errors',
      ok: recentErrors.length === 0,
      severity: 'high',
      note: recentErrors.length === 0 ? 'no recent error lines' : `${recentErrors.length} error lines in recent logs`,
    },
    {
      label: 'Failed actions',
      ok: failedActions.length === 0,
      severity: 'high',
      note: failedActions.length === 0 ? 'execution actions look clean' : `${failedActions.length} failed actions in recent activity`,
    },
    {
      label: 'Risk saturation',
      ok: !cfg.maxPositions || positions.length < cfg.maxPositions,
      severity: 'medium',
      note: cfg.maxPositions ? `${positions.length}/${cfg.maxPositions} positions used` : `${positions.length} positions open`,
    },
    {
      label: 'Multi-wallet shape',
      ok: !cfg.multiWalletEnabled || wallets.length >= 2,
      severity: 'medium',
      note: cfg.multiWalletEnabled ? `${wallets.length} wallet config entries` : 'single-wallet mode',
    },
    {
      label: 'Confirm-mode safety',
      ok: cfg.executionMode === 'demo' || cfg.confirmMode !== false,
      severity: 'critical',
      note: cfg.executionMode === 'demo' ? 'demo mode lowers live risk' : (cfg.confirmMode ? 'manual approval enabled' : 'live buys may execute immediately'),
    },
    {
      label: 'Telegram approval surface',
      ok: !cfg.confirmMode || !!cfg.telegramChatId,
      severity: 'medium',
      note: cfg.confirmMode ? (cfg.telegramChatId ? 'chat id configured' : 'confirm mode on but telegram chat missing') : 'telegram optional',
    },
  ];

  const penalty = { critical: 18, high: 12, medium: 7 };
  const score = Math.max(0, Math.round(100 - checks.reduce((sum, item) => sum + (item.ok ? 0 : penalty[item.severity]), 0)));
  const failing = checks.filter((item) => !item.ok);
  const status = score >= 85 ? 'healthy' : score >= 65 ? 'watch' : 'critical';
  const recommendations = failing.map((item) => `${item.label}: ${item.note}`);

  return {
    score,
    status,
    checks,
    failing,
    recommendations,
    recentErrors: [...recentErrors, ...recentWarnings].slice(-8).reverse(),
  };
}

function Card({ title, children, aside }) {
  return (
    <section className="deck-card">
      <div className="card-head">
        <div>
          <p className="card-kicker">Doctor</p>
          <h3>{title}</h3>
        </div>
        {aside ? <div className="card-aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

function CheckRow({ item }) {
  return (
    <div className="check-row">
      <div>
        <strong>{item.label}</strong>
        <p>{item.note}</p>
      </div>
      <span className={`status-chip ${item.ok ? 'good' : item.severity === 'critical' ? 'bad' : 'warn'}`}>
        {item.ok ? 'PASS' : 'FAIL'}
      </span>
    </div>
  );
}

function ControlButton({ label, sublabel, onClick, variant = 'default' }) {
  return (
    <button className={`control-button ${variant}`} onClick={onClick}>
      <strong>{label}</strong>
      <span>{sublabel}</span>
    </button>
  );
}

export default function RightPanel({ agentData, logs, actions, connected, lastUpdate, lastHeartbeat, sendControl, onOpenSetup }) {
  const doctor = buildDoctor(agentData, logs, actions, connected, lastUpdate, lastHeartbeat);
  const report = agentData.lastReport || {};
  const summary = report.summary || {};
  const learning = agentData.learningState || {};
  const marketSnapshots = agentData.marketIntel?.snapshots || [];
  const latestSnapshot = marketSnapshots[marketSnapshots.length - 1];
  const cfg = agentData.userConfig || {};
  const strategyState = agentData.strategyState || { activeId: 'scalping', available: [] };
  const automationState = agentData.automationState || { enabled: false, cronStarted: false, telegramPolling: false };
  const supervisorState = agentData.supervisorState || { desiredRunning: false, agentRunning: false, pid: null, mode: null };
  const paused = Boolean(agentData.tradingPlan?.session?.pausedUntil && new Date(agentData.tradingPlan.session.pausedUntil).getTime() > Date.now());

  return (
    <aside className="right-column">
      <Card title="Doctor / Error Triage" aside={<span className={`status-chip ${doctor.status}`}>{doctor.status.toUpperCase()}</span>}>
        <div className="doctor-score-wrap">
          <div className="doctor-score-ring">
            <div className="doctor-score-core">
              <span>score</span>
              <strong>{doctor.score}</strong>
            </div>
          </div>
          <div className="doctor-score-copy">
            <p>Runtime health based on socket freshness, error lines, failed actions, safety config, and wallet topology.</p>
            <ul className="compact-list">
              <li>{doctor.failing.length === 0 ? 'No active blockers detected.' : `${doctor.failing.length} active issue(s) need operator attention.`}</li>
              <li>{doctor.recentErrors.length > 0 ? `${doctor.recentErrors.length} recent warn/error signals are visible.` : 'Recent log stream is clean.'}</li>
            </ul>
          </div>
        </div>
      </Card>

      <Card title="Operator Controls" aside={<span className="mini-label">live + persistent</span>}>
        <div className="control-grid">
          <ControlButton
            label="Setup Wizard"
            sublabel="Open Hermes-style onboarding"
            variant="accent"
            onClick={onOpenSetup}
          />
          <ControlButton
            label="Refresh snapshot"
            sublabel="Re-read state, logs, config"
            onClick={() => sendControl('refresh_state')}
          />
          <ControlButton
            label={paused ? 'Resume now' : 'Pause 60m'}
            sublabel={paused ? 'Clear current session pause gate' : 'Live session gate via trading plan'}
            variant="warn"
            onClick={() => sendControl(paused ? 'resume_session' : 'pause_session', paused ? {} : { durationMin: 60 })}
          />
          <ControlButton
            label={`Agent ${supervisorState.desiredRunning ? 'OFF' : 'ON'}`}
            sublabel={supervisorState.desiredRunning ? 'Request full process shutdown' : 'Request supervisor to boot agent'}
            variant={supervisorState.desiredRunning ? 'warn' : 'default'}
            onClick={() => sendControl('set_agent_power', { enabled: !supervisorState.desiredRunning })}
          />
          <ControlButton
            label={`Automation ${automationState.enabled ? 'OFF' : 'ON'}`}
            sublabel={automationState.enabled ? 'Stop 24/7 automation loop' : 'Start 24/7 automation loop'}
            variant={automationState.enabled ? 'warn' : 'default'}
            onClick={() => sendControl('set_automation', { enabled: !automationState.enabled })}
          />
          <ControlButton
            label={`Confirm ${cfg.confirmMode ? 'OFF' : 'ON'}`}
            sublabel="Persist confirmMode for next restart"
            onClick={() => sendControl('set_confirm_mode', { enabled: !cfg.confirmMode })}
          />
          <ControlButton
            label={`Multi-wallet ${cfg.multiWalletEnabled ? 'OFF' : 'ON'}`}
            sublabel="Persist topology mode in config"
            onClick={() => sendControl('set_multi_wallet', { enabled: !cfg.multiWalletEnabled })}
          />
          <ControlButton
            label={`Daily report ${cfg.dailyReportEnabled ? 'OFF' : 'ON'}`}
            sublabel="Persist scheduler preference"
            onClick={() => sendControl('set_daily_report', { enabled: !cfg.dailyReportEnabled })}
          />
        </div>
        <p className="muted-copy">Agent power ON/OFF talks to the 24/7 supervisor. Automation ON/OFF controls the cron loop inside the running agent. Pause and resume act on the session gate only.</p>
      </Card>

      <Card title="Strategy Control" aside={<span className="mini-label">hot apply</span>}>
        <div className="strategy-grid">
          {(strategyState.available || []).map((strategy) => (
            <button
              key={strategy.id}
              className={`strategy-chip ${strategy.active ? 'active' : ''}`}
              onClick={() => sendControl('set_strategy', { strategyId: strategy.id })}
            >
              <strong>{strategy.id}</strong>
              <span>{strategy.name}</span>
            </button>
          ))}
        </div>
        <p className="muted-copy">Active strategy: <code>{strategyState.activeId || 'scalping'}</code>. Ponyou reads active strategy from disk hot, so this should apply without restart.</p>
      </Card>

      <Card title="Supervisor State" aside={<span className="mini-label">24x7</span>}>
        <div className="stats-list">
          <div className="stat-row"><span>Desired power</span><strong className={supervisorState.desiredRunning ? 'tone-good' : 'tone-bad'}>{supervisorState.desiredRunning ? 'ON' : 'OFF'}</strong></div>
          <div className="stat-row"><span>Agent running</span><strong className={supervisorState.agentRunning ? 'tone-good' : 'tone-bad'}>{supervisorState.agentRunning ? 'YES' : 'NO'}</strong></div>
          <div className="stat-row"><span>Mode</span><strong>{supervisorState.mode || '—'}</strong></div>
          <div className="stat-row"><span>PID</span><strong>{supervisorState.pid ?? '—'}</strong></div>
        </div>
      </Card>

      <Card title="Doctor Checks">
        <div className="check-list">
          {doctor.checks.map((item) => (
            <CheckRow key={item.label} item={item} />
          ))}
        </div>
      </Card>

      <Card title="Operator Recommendations">
        {doctor.recommendations.length > 0 ? (
          <ul className="compact-list">
            {doctor.recommendations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="muted-copy">No corrective action suggested right now.</p>
        )}
      </Card>

      <Card title="Recent Error Surface" aside={<span className="mini-label">{doctor.recentErrors.length}</span>}>
        {doctor.recentErrors.length > 0 ? (
          <div className="issue-list">
            {doctor.recentErrors.map((item, index) => {
              const type = classifyLog(item);
              return (
                <div className={`issue-row tone-${type.tone}`} key={`${item.timestamp || 'issue'}-${index}`}>
                  <div className="issue-topline">
                    <strong>{item.category || item.tool || type.tag}</strong>
                    <span>{item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '—'}</span>
                  </div>
                  <p>{item.message || item.summary || 'No message'}</p>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted-copy">No recent warnings or errors in the visible log window.</p>
        )}
      </Card>

      <Card title="Performance & Memory">
        <div className="stats-list">
          <div className="stat-row"><span>Report trades</span><strong>{summary.trades ?? '—'}</strong></div>
          <div className="stat-row"><span>Report P&L</span><strong className={Number(summary.pnl_pct || 0) >= 0 ? 'tone-good' : 'tone-bad'}>{summary.pnl_pct != null ? `${Number(summary.pnl_pct).toFixed(2)}%` : '—'}</strong></div>
          <div className="stat-row"><span>Win rate</span><strong>{summary.win_rate != null ? `${summary.win_rate}%` : '—'}</strong></div>
          <div className="stat-row"><span>Lessons</span><strong>{learning.lessonCount ?? learning.lessons?.length ?? '—'}</strong></div>
          <div className="stat-row"><span>Rug memory</span><strong>{learning.rugMemory?.length ?? '—'}</strong></div>
          <div className="stat-row"><span>Last report capital</span><strong>{fmtUsd(summary.capital_usd)}</strong></div>
        </div>
      </Card>

      <Card title="Market Intelligence">
        <div className="stats-list">
          <div className="stat-row"><span>Condition</span><strong>{String(agentData.marketIntel?.currentCondition || 'unknown').toUpperCase()}</strong></div>
          <div className="stat-row"><span>Confidence</span><strong>{latestSnapshot?.confidence != null ? `${latestSnapshot.confidence}%` : '—'}</strong></div>
          <div className="stat-row"><span>Snapshots</span><strong>{marketSnapshots.length}</strong></div>
          <div className="stat-row"><span>Buy ratio</span><strong>{latestSnapshot?.metrics?.buy_ratio != null ? `${(latestSnapshot.metrics.buy_ratio * 100).toFixed(1)}%` : '—'}</strong></div>
          <div className="stat-row"><span>Fresh tokens</span><strong>{latestSnapshot?.metrics?.fresh_tokens_1h ?? '—'}</strong></div>
        </div>
      </Card>
    </aside>
  );
}
