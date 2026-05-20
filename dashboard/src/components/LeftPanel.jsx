function fmtUsd(n, decimals = 2) {
  if (n == null) return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (Math.abs(num) >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(decimals)}`;
}

function fmtPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return `${num >= 0 ? '+' : ''}${num.toFixed(1)}%`;
}

function pnlTone(value) {
  if (value > 0) return 'good';
  if (value < 0) return 'bad';
  return 'neutral';
}

function statusTone(status) {
  if (status === 'TRADING') return 'good';
  if (status === 'PAUSED') return 'warn';
  if (status === 'OFFLINE') return 'bad';
  return 'neutral';
}

function Stat({ label, value, tone = 'neutral' }) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      <strong className={`tone-${tone}`}>{value}</strong>
    </div>
  );
}

function Card({ title, children, aside }) {
  return (
    <section className="deck-card">
      <div className="card-head">
        <div>
          <p className="card-kicker">Operator</p>
          <h3>{title}</h3>
        </div>
        {aside ? <div className="card-aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

function FeatureChip({ label, enabled }) {
  return <span className={`feature-chip ${enabled ? 'enabled' : 'disabled'}`}>{label}</span>;
}

function PositionCard({ address, pos }) {
  const pnlUsd = Number(pos.pnl_usd ?? pos.unrealized_pnl_usd ?? 0);
  const pnlPct = Number(pos.pnl_pct ?? pos.unrealized_pnl_pct ?? 0);

  return (
    <div className="position-card">
      <div className="position-topline">
        <strong>{pos.symbol || pos.name || `${address.slice(0, 6)}…`}</strong>
        <span className={`tone-${pnlTone(pnlUsd)}`}>{fmtUsd(pnlUsd)}</span>
      </div>
      <div className="position-meta">
        <span>{address.slice(0, 8)}…{address.slice(-4)}</span>
        <span className={`tone-${pnlTone(pnlPct)}`}>{fmtPct(pnlPct)}</span>
      </div>
    </div>
  );
}

function Progress({ label, value, tone = 'good' }) {
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="progress-block">
      <div className="progress-meta">
        <span>{label}</span>
        <strong>{Math.round(width)}%</strong>
      </div>
      <div className="progress-rail">
        <div className={`progress-fill ${tone}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

export default function LeftPanel({ agentData, connected, lastUpdate }) {
  const { agentStatus, state, tradingPlan, marketIntel, userConfig } = agentData;
  const positions = Object.entries(state?.positions || {});
  const session = tradingPlan?.session || {};
  const currentDay = tradingPlan?.currentDay || 1;
  const totalDays = tradingPlan?.schedule?.length || userConfig?.planDays || 30;
  const currentCapital = Number(session.currentCapitalUsd ?? userConfig?.pilotCapitalUsd ?? 0);
  const startCapital = Number(session.startCapitalUsd ?? userConfig?.pilotCapitalUsd ?? 0);
  const targetCapital = Number(tradingPlan?.today_target_usd ?? tradingPlan?.schedule?.[currentDay - 1]?.target_usd ?? 0);
  const marketCondition = String(marketIntel?.currentCondition || 'unknown').toUpperCase();
  const latestIntel = marketIntel?.snapshots?.[marketIntel.snapshots.length - 1];
  const confidence = Number(latestIntel?.confidence || 0);
  const dayProgress = targetCapital > startCapital
    ? ((currentCapital - startCapital) / (targetCapital - startCapital)) * 100
    : 0;
  const planProgress = totalDays > 0 ? (currentDay / totalDays) * 100 : 0;

  const features = [
    ['Confirm Mode', !!userConfig?.confirmMode],
    ['Multi-Wallet', !!userConfig?.multiWalletEnabled],
    ['Darwin', !!userConfig?.darwinEnabled],
    ['Indicators', !!userConfig?.chartIndicators?.enabled],
    ['Vault', !!userConfig?.vaultWallet],
    ['Daily Report', !!userConfig?.dailyReportEnabled],
    ['Telegram', !!userConfig?.telegramChatId],
    ['HiveMind', !!userConfig?.hiveMindApiKey],
    ['Fast Track', !!userConfig?.fastTrackEnabled],
    ['Jito', !!userConfig?.jitoEnabled],
    ['Auto Spread', !!userConfig?.multiWalletAutoSpreadEnabled],
    ['LP Relay', !!userConfig?.lpAgentRelayEnabled],
  ];

  const wallets = Array.isArray(userConfig?.wallets) ? userConfig.wallets : [];

  return (
    <aside className="left-column">
      <Card
        title="Runtime Envelope"
        aside={<span className={`status-chip ${statusTone(agentStatus)}`}>{agentStatus}</span>}
      >
        <div className="metrics-grid two-up compact">
          <div className="metric-box">
            <span>Connection</span>
            <strong className={connected ? 'tone-good' : 'tone-bad'}>{connected ? 'WS LINKED' : 'WS DOWN'}</strong>
          </div>
          <div className="metric-box">
            <span>Market</span>
            <strong>{marketCondition}</strong>
          </div>
          <div className="metric-box">
            <span>Strategy</span>
            <strong>{agentData.strategyState?.activeId || userConfig?.strategy || 'default'}</strong>
          </div>
          <div className="metric-box">
            <span>Model</span>
            <strong>{String(userConfig?.llmModel || '—').split('/').pop()}</strong>
          </div>
        </div>
        <div className="stack-gap">
          <Progress label="Market confidence" value={confidence} tone="info" />
          <Progress label="Plan timeline" value={planProgress} tone="warm" />
          <Progress label="Today's target" value={dayProgress} tone={dayProgress >= 100 ? 'good' : dayProgress >= 55 ? 'warm' : 'bad'} />
        </div>
      </Card>

      <Card title="Capital & Session">
        <div className="stats-list">
          <Stat label="Current capital" value={fmtUsd(currentCapital)} tone="good" />
          <Stat label="Start capital" value={fmtUsd(startCapital)} />
          <Stat label="Target capital" value={fmtUsd(targetCapital)} tone="warm" />
          <Stat label="P&L today" value={fmtUsd(session.profitUsd || 0)} tone={pnlTone(session.profitUsd || 0)} />
          <Stat label="P&L %" value={fmtPct(session.profitPct || 0)} tone={pnlTone(session.profitPct || 0)} />
          <Stat label="Trades" value={session.tradesCount || 0} />
          <Stat label="Win / Loss" value={`${session.winCount || 0} / ${session.lossCount || 0}`} tone={(session.winCount || 0) >= (session.lossCount || 0) ? 'good' : 'bad'} />
          <Stat label="Last update" value={lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : 'Waiting'} />
        </div>
      </Card>

      <Card title="Feature Surface">
        <div className="feature-grid">
          {features.map(([label, enabled]) => (
            <FeatureChip key={label} label={label} enabled={enabled} />
          ))}
        </div>
      </Card>

      <Card title="Risk Envelope">
        <div className="stats-list">
          <Stat label="Max positions" value={userConfig?.maxPositions ?? '—'} />
          <Stat label="Max deploy" value={fmtUsd(userConfig?.maxDeployAmount)} />
          <Stat label="Deploy SOL" value={userConfig?.deployAmountSol != null ? `${userConfig.deployAmountSol} SOL` : '—'} />
          <Stat label="Stop loss" value={userConfig?.stopLossPct != null ? `${userConfig.stopLossPct}%` : '—'} tone="bad" />
          <Stat label="Take profit" value={userConfig?.takeProfitPct != null ? `${userConfig.takeProfitPct}%` : '—'} tone="good" />
          <Stat label="Trailing" value={userConfig?.trailingTakeProfit ? 'ON' : 'OFF'} tone={userConfig?.trailingTakeProfit ? 'good' : 'neutral'} />
          <Stat label="Gas reserve" value={userConfig?.gasReserve != null ? `${userConfig.gasReserve} SOL` : '—'} />
          <Stat label="Min SOL to open" value={userConfig?.minSolToOpen != null ? `${userConfig.minSolToOpen} SOL` : '—'} />
        </div>
      </Card>

      <Card title="Wallet Topology" aside={<span className="mini-label">{userConfig?.multiWalletEnabled ? 'MULTI' : 'SINGLE'}</span>}>
        <div className="stats-list">
          <Stat label="Wallet mode" value={userConfig?.multiWalletEnabled ? 'Enabled' : 'Disabled'} tone={userConfig?.multiWalletEnabled ? 'good' : 'neutral'} />
          <Stat label="Auto spread" value={userConfig?.multiWalletAutoSpreadEnabled ? 'Enabled' : 'Disabled'} tone={userConfig?.multiWalletAutoSpreadEnabled ? 'good' : 'neutral'} />
          <Stat label="Max errors" value={userConfig?.multiWalletMaxErrors ?? '—'} />
          <Stat label="Cooldown" value={userConfig?.multiWalletCooldownMin != null ? `${userConfig.multiWalletCooldownMin} min` : '—'} />
        </div>
        {wallets.length > 0 ? (
          <div className="wallet-list">
            {wallets.map((wallet, index) => (
              <div key={`${wallet.label || 'wallet'}-${index}`} className="wallet-row">
                <div>
                  <strong>{wallet.label || `wallet-${index + 1}`}</strong>
                  <span>{wallet.key ? `${String(wallet.key).slice(0, 6)}…${String(wallet.key).slice(-4)}` : 'no key'}</span>
                </div>
                <strong>{wallet.capital_pct ?? 0}%</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted-copy">No explicit multi-wallet allocations stored in config.</p>
        )}
      </Card>

      <Card title="Open Positions" aside={<span className="mini-label">{positions.length}</span>}>
        {positions.length > 0 ? (
          <div className="position-list">
            {positions.slice(0, 8).map(([address, pos]) => (
              <PositionCard key={address} address={address} pos={pos} />
            ))}
          </div>
        ) : (
          <p className="muted-copy">No active positions. The agent is either idle, paused, or still screening candidates.</p>
        )}
      </Card>
    </aside>
  );
}
