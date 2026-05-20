import { useEffect, useMemo, useState } from 'react';

function buildDraft(setupState) {
  const cfg = setupState?.config || {};
  const env = setupState?.env || {};

  return {
    mode: cfg.executionMode || env.executionMode || setupState?.mode || 'live',
    strategyId: cfg.strategy || setupState?.activeStrategyId || 'scalping',
    confirmMode: !!cfg.confirmMode,
    automationEnabled: cfg.automationEnabled !== false,
    dailyReportEnabled: cfg.dailyReportEnabled !== false,
    multiWalletEnabled: !!cfg.multiWalletEnabled,
    walletKey: '',
    rpcUrl: env.rpcUrl || 'https://pump.helius-rpc.com',
    pilotCapitalUsd: cfg.pilotCapitalUsd ?? 10,
    maxPositions: cfg.maxPositions ?? 3,
    stopLossPct: cfg.stopLossPct ?? -15,
    dailyTargetPct: cfg.dailyTargetPct ?? 25,
    llmProvider: env.llmProvider || 'openrouter',
    llmModel: env.llmModel || 'minimax/minimax-m2.7',
    llmBaseUrl: env.llmBaseUrl || '',
    llmApiKey: '',
    openrouterApiKey: '',
    telegramBotToken: '',
    telegramChatId: env.telegramChatId || '',
    telegramAllowedUserIds: env.telegramAllowedUserIds || '',
    vaultWallet: cfg.vaultWallet || '',
    heliusApiKey: '',
    gmgnRouteKey: '',
  };
}

function WizardField({ label, helper, children, wide = false }) {
  return (
    <label className={`wizard-field ${wide ? 'wide' : ''}`}>
      <span>{label}</span>
      {children}
      {helper ? <small>{helper}</small> : null}
    </label>
  );
}

function ToggleGroup({ value, onChange, options }) {
  return (
    <div className="wizard-toggle-group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`wizard-toggle ${value === option.value ? 'active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          <strong>{option.label}</strong>
          <span>{option.description}</span>
        </button>
      ))}
    </div>
  );
}

function StepBadge({ index, active, done, title, status, onClick }) {
  return (
    <button type="button" className={`wizard-step ${active ? 'active' : ''} ${done ? 'done' : ''}`} onClick={onClick}>
      <span>{index + 1}</span>
      <div>
        <strong>{title}</strong>
        <small>{done ? 'Configured' : active ? 'Current step' : 'Pending'}</small>
      </div>
      <em className={`wizard-step-pill ${status}`}>{status === 'ready' ? 'READY' : status === 'warn' ? 'CHECK' : 'BLOCKED'}</em>
    </button>
  );
}

function CheckItem({ ok, label, detail }) {
  return (
    <div className={`wizard-check ${ok ? 'ok' : 'warn'}`}>
      <strong>{ok ? 'PASS' : 'NEEDS ATTENTION'}</strong>
      <div>
        <span>{label}</span>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function statusLabel(status) {
  if (status === 'ready') return 'Ready';
  if (status === 'blocked') return 'Blocked';
  return 'Needs review';
}

export default function SetupWizard({ setupState, onBack, onApply, onRunDoctor, saving }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [didAutoFocus, setDidAutoFocus] = useState(false);
  const [draft, setDraft] = useState(() => buildDraft(setupState));

  const steps = useMemo(() => ([
    { key: 'foundation', title: 'Foundation', note: 'Mode, strategy, and core behavior' },
    { key: 'wallet', title: 'Wallet & Risk', note: 'Funds, RPC, and deployment shape' },
    { key: 'llm', title: 'Intelligence', note: 'Model routing and API keys' },
    { key: 'alerts', title: 'Alerts', note: 'Telegram and vault routing' },
    { key: 'review', title: 'Review', note: 'Final launch check' },
  ]), []);

  const env = setupState?.env || {};
  const readiness = setupState?.readiness || { missing: [], walletCount: 0, walletAllocation: 0, readyForLaunch: false };
  const missingLabels = {
    wallet: 'Wallet private key',
    rpc: 'RPC URL',
    llm: 'LLM provider',
    telegram: 'Telegram chat ID',
  };

  const stepHealth = useMemo(() => {
    const walletConfigured = !!(draft.walletKey || env.walletKeyConfigured);
    const rpcConfigured = !!draft.rpcUrl;
    const llmConfigured = draft.llmProvider === 'openrouter'
      ? !!(env.openrouterApiKeyConfigured || draft.openrouterApiKey)
      : !!(draft.llmBaseUrl || env.llmApiKeyConfigured || draft.llmApiKey);
    const telegramConfigured = !!(draft.telegramBotToken || env.telegramBotTokenConfigured) && !!(draft.telegramChatId || env.telegramChatId);
    const alertsNeedAttention = draft.mode !== 'demo' && !telegramConfigured;

    return [
      {
        key: 'foundation',
        status: draft.strategyId ? 'ready' : 'warn',
        summary: draft.strategyId ? `Strategy ${draft.strategyId} selected.` : 'Choose a strategy before launch.',
      },
      {
        key: 'wallet',
        status: walletConfigured && rpcConfigured ? 'ready' : 'warn',
        summary: walletConfigured && rpcConfigured ? 'Wallet and RPC are present.' : 'Wallet or RPC still missing.',
      },
      {
        key: 'llm',
        status: llmConfigured ? 'ready' : 'warn',
        summary: llmConfigured ? `Provider ${draft.llmProvider} is wired.` : 'Model provider or key still missing.',
      },
      {
        key: 'alerts',
        status: alertsNeedAttention ? 'warn' : 'ready',
        summary: draft.mode === 'demo'
          ? 'Demo mode can run without Telegram.'
          : 'Telegram approval surface is present.',
      },
      {
        key: 'review',
        status: readiness.readyForLaunch ? 'ready' : 'blocked',
        summary: readiness.readyForLaunch ? 'Launch gate is green.' : `${readiness.missing.length} required field(s) still need attention.`,
      },
    ];
  }, [
    draft.strategyId,
    draft.walletKey,
    draft.rpcUrl,
    draft.llmProvider,
    draft.llmBaseUrl,
    draft.openrouterApiKey,
    draft.llmApiKey,
    draft.telegramBotToken,
    draft.telegramChatId,
    draft.mode,
    env.walletKeyConfigured,
    env.openrouterApiKeyConfigured,
    env.llmApiKeyConfigured,
    env.telegramBotTokenConfigured,
    env.telegramChatId,
    readiness.missing.length,
    readiness.readyForLaunch,
  ]);

  useEffect(() => {
    if (didAutoFocus) return;
    const firstOpen = stepHealth.findIndex((step) => step.status !== 'ready');
    if (firstOpen >= 0) setStepIndex(firstOpen);
    setDidAutoFocus(true);
  }, [didAutoFocus, stepHealth]);

  const launchReadiness = useMemo(() => {
    const blockers = [];
    const warnings = [];
    const recommendations = [];
    const nextStepIndex = stepHealth.findIndex((step) => step.status !== 'ready');

    readiness.missing.forEach((key) => {
      const label = missingLabels[key] || key;
      blockers.push(label);
    });

    if (!draft.automationEnabled) warnings.push('Automation is OFF, so 24/7 looping will stay paused.');
    if (draft.mode === 'live' && !draft.confirmMode) warnings.push('Live mode is not guarded by confirm mode.');
    if (draft.multiWalletEnabled && readiness.walletCount < 2) warnings.push('Multi-wallet is enabled but only one wallet entry is present.');

    if (nextStepIndex >= 0) recommendations.push(`Open ${steps[nextStepIndex].title} next.`);
    if (!readiness.readyForLaunch) recommendations.push('Use Run doctor after each fix to refresh the launch gate.');

    return {
      blockers,
      warnings,
      recommendations,
      nextStepIndex,
      nextStepLabel: nextStepIndex >= 0 ? steps[nextStepIndex].title : 'Launch sync',
      score: Math.max(0, 100 - (blockers.length * 22) - (warnings.length * 8)),
    };
  }, [
    draft.automationEnabled,
    draft.confirmMode,
    draft.mode,
    draft.multiWalletEnabled,
    missingLabels,
    readiness.missing,
    readiness.readyForLaunch,
    readiness.walletCount,
    stepHealth,
    steps,
  ]);

  const checks = [
    { ok: !!(draft.walletKey || env.walletKeyConfigured), label: 'Wallet', detail: 'Wallet private key is available for the agent.' },
    { ok: !!draft.rpcUrl, label: 'RPC', detail: 'Solana RPC endpoint is set.' },
    { ok: !!draft.llmProvider, label: 'LLM', detail: 'Model provider is selected.' },
    { ok: draft.mode === 'demo' || !!(draft.telegramChatId || env.telegramChatId), label: 'Telegram', detail: draft.mode === 'demo' ? 'Demo mode can launch without Telegram.' : 'Telegram approval surface is configured.' },
  ];

  function setField(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const canGoPrev = stepIndex > 0;
  const canGoNext = stepIndex < steps.length - 1;

  function handleNext() {
    setStepIndex((prev) => Math.min(prev + 1, steps.length - 1));
  }

  function handlePrev() {
    setStepIndex((prev) => Math.max(prev - 1, 0));
  }

  function handleApply() {
    onApply?.(draft);
  }

  function handleDoctor() {
    onRunDoctor?.();
  }

  return (
    <section className="setup-shell">
      <div className="setup-hero">
        <div>
          <p className="eyebrow">Hermes-style onboarding</p>
          <h2>Setup Wizard</h2>
          <p>Finish the critical runtime fields first. Wallet, RPC, strategy, and notifications stay visible as one guided flow.</p>
        </div>
        <div className="setup-hero-actions">
          <button type="button" className="ghost-button" onClick={handleDoctor}>Run doctor</button>
          <button type="button" className="ghost-button" onClick={onBack}>Back to dashboard</button>
          <button type="button" className="primary-button" onClick={handleApply} disabled={saving}>
            {saving ? 'Applying...' : 'Apply & Sync'}
          </button>
        </div>
      </div>

      <div className="setup-layout">
        <aside className="setup-stepper">
          <div className="setup-stepper-head">
            <span>Progress</span>
            <strong>{stepIndex + 1}/{steps.length}</strong>
          </div>
          {steps.map((step, index) => (
            <StepBadge
              key={step.key}
              index={index}
              title={step.title}
              active={index === stepIndex}
              done={index < stepIndex}
              status={stepHealth[index]?.status || 'warn'}
              onClick={() => setStepIndex(index)}
            />
          ))}
          <div className="setup-progress">
            <div className="setup-progress-bar" style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }} />
          </div>
        </aside>

        <main className="setup-main">
          <div className="setup-panel">
            <div className="card-head setup-card-head">
              <div>
                <p className="card-kicker">Step {stepIndex + 1}</p>
                <h3>{steps[stepIndex].title}</h3>
              </div>
              <div className="card-aside">{steps[stepIndex].note}</div>
            </div>
            <div className="setup-status-banner">
              <div>
                <span>Step status</span>
                <strong>{statusLabel(stepHealth[stepIndex]?.status)}</strong>
              </div>
              <p>{stepHealth[stepIndex]?.summary}</p>
            </div>

            {stepIndex === 0 ? (
              <div className="wizard-form-grid">
                <WizardField label="Execution mode" helper="Live executes real transactions. Demo keeps the same flow without live risk.">
                  <ToggleGroup
                    value={draft.mode}
                    onChange={(value) => setField('mode', value)}
                    options={[
                      { value: 'live', label: 'Live', description: 'Production trading' },
                      { value: 'demo', label: 'Demo', description: 'Dry-run / safe mode' },
                    ]}
                  />
                </WizardField>

                <WizardField label="Active strategy" helper="Choose the preset that fits your operating style.">
                  <select value={draft.strategyId} onChange={(e) => setField('strategyId', e.target.value)}>
                    {(setupState?.strategyOptions || []).map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.id} - {opt.name}</option>
                    ))}
                  </select>
                </WizardField>

                <WizardField label="Confirm mode" helper="When on, buys wait for Telegram approval.">
                  <button type="button" className={`switch-pill ${draft.confirmMode ? 'on' : 'off'}`} onClick={() => setField('confirmMode', !draft.confirmMode)}>
                    <span>{draft.confirmMode ? 'ON' : 'OFF'}</span>
                    <small>{draft.confirmMode ? 'Manual approval enabled' : 'Immediate execution allowed'}</small>
                  </button>
                </WizardField>

                <WizardField label="Automation" helper="Controls the 24/7 automation loop inside the running agent.">
                  <button type="button" className={`switch-pill ${draft.automationEnabled ? 'on' : 'off'}`} onClick={() => setField('automationEnabled', !draft.automationEnabled)}>
                    <span>{draft.automationEnabled ? 'ON' : 'OFF'}</span>
                    <small>{draft.automationEnabled ? 'Automation runs continuously' : 'Automation is paused'}</small>
                  </button>
                </WizardField>

                <WizardField label="Daily report" helper="Send a daily summary over Telegram.">
                  <button type="button" className={`switch-pill ${draft.dailyReportEnabled ? 'on' : 'off'}`} onClick={() => setField('dailyReportEnabled', !draft.dailyReportEnabled)}>
                    <span>{draft.dailyReportEnabled ? 'ON' : 'OFF'}</span>
                    <small>{draft.dailyReportEnabled ? 'Reports stay enabled' : 'Reports are suppressed'}</small>
                  </button>
                </WizardField>

                <WizardField label="Multi-wallet" helper="Enable now; detailed wallet topology can still be refined in advanced setup.">
                  <button type="button" className={`switch-pill ${draft.multiWalletEnabled ? 'on' : 'off'}`} onClick={() => setField('multiWalletEnabled', !draft.multiWalletEnabled)}>
                    <span>{draft.multiWalletEnabled ? 'ON' : 'OFF'}</span>
                    <small>{draft.multiWalletEnabled ? 'Multi-wallet active' : 'Single-wallet mode'}</small>
                  </button>
                </WizardField>
              </div>
            ) : null}

            {stepIndex === 1 ? (
              <div className="wizard-form-grid">
                <WizardField label="Wallet private key" helper="Saved to .env. Leave blank to keep the current key.">
                  <input type="password" value={draft.walletKey} placeholder={env.walletKeyConfigured ? 'Current key already saved' : 'Paste wallet private key'} onChange={(e) => setField('walletKey', e.target.value)} />
                </WizardField>

                <WizardField label="RPC URL" helper="Main Solana RPC endpoint. Keep a fallback provider handy.">
                  <input type="text" value={draft.rpcUrl} onChange={(e) => setField('rpcUrl', e.target.value)} />
                </WizardField>

                <WizardField label="Trading capital (USD)" helper="Initial pilot capital used by the plan layer.">
                  <input type="number" min="1" step="1" value={draft.pilotCapitalUsd} onChange={(e) => setField('pilotCapitalUsd', Number(e.target.value))} />
                </WizardField>

                <WizardField label="Max positions" helper="Hard ceiling on concurrent open positions.">
                  <input type="number" min="1" step="1" value={draft.maxPositions} onChange={(e) => setField('maxPositions', Number(e.target.value))} />
                </WizardField>

                <WizardField label="Stop loss (%)" helper="Negative percent. Applies to the plan layer after restart or sync.">
                  <input type="number" step="0.1" value={draft.stopLossPct} onChange={(e) => setField('stopLossPct', Number(e.target.value))} />
                </WizardField>

                <WizardField label="Daily target (%)" helper="Used by the plan and dashboard copy.">
                  <input type="number" step="0.1" value={draft.dailyTargetPct} onChange={(e) => setField('dailyTargetPct', Number(e.target.value))} />
                </WizardField>
              </div>
            ) : null}

            {stepIndex === 2 ? (
              <div className="wizard-form-grid">
                <WizardField label="LLM provider" helper="OpenRouter or local LM Studio.">
                  <select value={draft.llmProvider} onChange={(e) => setField('llmProvider', e.target.value)}>
                    <option value="openrouter">openrouter</option>
                    <option value="lmstudio">lmstudio</option>
                  </select>
                </WizardField>

                <WizardField label="Model" helper="Model name used by the agent runtime.">
                  <input type="text" value={draft.llmModel} onChange={(e) => setField('llmModel', e.target.value)} />
                </WizardField>

                {draft.llmProvider === 'lmstudio' ? (
                  <WizardField label="LM Studio base URL" helper="Usually http://localhost:1234/v1">
                    <input type="text" value={draft.llmBaseUrl} onChange={(e) => setField('llmBaseUrl', e.target.value)} />
                  </WizardField>
                ) : (
                  <WizardField label="OpenRouter API key" helper="Leave blank to keep the current key.">
                    <input type="password" value={draft.openrouterApiKey} placeholder={env.openrouterApiKeyConfigured ? 'Current key already saved' : 'Paste OpenRouter API key'} onChange={(e) => setField('openrouterApiKey', e.target.value)} />
                  </WizardField>
                )}

                {draft.llmProvider === 'lmstudio' ? (
                  <WizardField label="LM Studio API key" helper="Usually lm-studio or any local placeholder.">
                    <input type="password" value={draft.llmApiKey} placeholder={env.llmApiKeyConfigured ? 'Current key already saved' : 'Paste local API key'} onChange={(e) => setField('llmApiKey', e.target.value)} />
                  </WizardField>
                ) : null}
              </div>
            ) : null}

            {stepIndex === 3 ? (
              <div className="wizard-form-grid">
                <WizardField label="Telegram bot token" helper="Required for approvals and status delivery.">
                  <input type="password" value={draft.telegramBotToken} placeholder={env.telegramBotTokenConfigured ? 'Current token already saved' : 'Paste Telegram bot token'} onChange={(e) => setField('telegramBotToken', e.target.value)} />
                </WizardField>

                <WizardField label="Telegram chat ID" helper="Used for approvals and alerts.">
                  <input type="text" value={draft.telegramChatId} onChange={(e) => setField('telegramChatId', e.target.value)} />
                </WizardField>

                <WizardField label="Allowed user IDs" helper="Comma-separated Telegram user ids for bot access control.">
                  <input type="text" value={draft.telegramAllowedUserIds} onChange={(e) => setField('telegramAllowedUserIds', e.target.value)} />
                </WizardField>

                <WizardField label="Vault wallet" helper="Optional savings wallet for vault transfers.">
                  <input type="text" value={draft.vaultWallet} onChange={(e) => setField('vaultWallet', e.target.value)} />
                </WizardField>
              </div>
            ) : null}

            {stepIndex === 4 ? (
              <div className="wizard-review">
                <div className="review-grid">
                  <div className="review-card">
                    <span>Mode</span>
                    <strong>{draft.mode.toUpperCase()}</strong>
                  </div>
                  <div className="review-card">
                    <span>Strategy</span>
                    <strong>{draft.strategyId}</strong>
                  </div>
                  <div className="review-card">
                    <span>Wallet</span>
                    <strong>{draft.walletKey || env.walletKeyConfigured ? 'Configured' : 'Missing'}</strong>
                  </div>
                  <div className="review-card">
                    <span>Telegram</span>
                    <strong>{draft.telegramChatId || env.telegramChatId ? 'Configured' : 'Missing'}</strong>
                  </div>
                </div>

                <div className="review-notes">
                  <p>Changes are split into two classes:</p>
                  <ul>
                    <li>Live-hot settings like strategy and automation are synced immediately.</li>
                    <li>Secret or transport changes like wallet key and RPC still require a restart.</li>
                  </ul>
                </div>
              </div>
            ) : null}

            <div className="wizard-nav">
              <button type="button" className="ghost-button" onClick={handlePrev} disabled={!canGoPrev}>Back</button>
              <div className="wizard-nav-spacer" />
              {canGoNext ? (
                <button type="button" className="primary-button" onClick={handleNext}>Next</button>
              ) : null}
              {stepIndex === steps.length - 1 ? (
                <button type="button" className="primary-button primary-accent" onClick={handleApply} disabled={saving}>
                  {saving ? 'Applying...' : 'Apply & Sync'}
                </button>
              ) : null}
            </div>
          </div>
        </main>

        <aside className="setup-summary">
          <section className="setup-summary-card">
            <p className="card-kicker">Launch readiness</p>
            <h3>{readiness.readyForLaunch ? 'Ready to launch' : 'Needs attention'}</h3>
            <div className="summary-meter">
              <div className={`summary-meter-fill ${readiness.readyForLaunch ? 'good' : 'warn'}`} style={{ width: `${Math.max(18, launchReadiness.score)}%` }} />
            </div>
            <div className="summary-action-row">
              <button type="button" className="ghost-button" onClick={handleDoctor}>Re-run doctor</button>
              {launchReadiness.nextStepIndex >= 0 ? (
                <button type="button" className="ghost-button" onClick={() => setStepIndex(launchReadiness.nextStepIndex)}>
                  Fix next blocker
                </button>
              ) : null}
              <button type="button" className="primary-button primary-accent" onClick={handleApply} disabled={saving}>
                {saving ? 'Applying...' : 'Launch sync'}
              </button>
            </div>
            <p className="muted-copy">{readiness.missing.length === 0 ? 'All required setup fields are present.' : `${readiness.missing.length} required field(s) still need attention.`}</p>
            <ul className="summary-list">
              {readiness.missing.length > 0 ? readiness.missing.map((key) => (
                <li key={key}>{missingLabels[key] || key}</li>
              )) : <li>All required fields are present.</li>}
            </ul>
          </section>

          <section className="setup-summary-card">
            <p className="card-kicker">Launch map</p>
            <p className="muted-copy">Focus stays on the first incomplete step so the operator can close blockers in order.</p>
            <div className="launch-matrix">
              <div className="launch-signal signal-blocker">
                <span>Blockers</span>
                {launchReadiness.blockers.length > 0 ? (
                  <ul>
                    {launchReadiness.blockers.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                ) : (
                  <strong>None</strong>
                )}
              </div>
              <div className="launch-signal signal-warning">
                <span>Warnings</span>
                {launchReadiness.warnings.length > 0 ? (
                  <ul>
                    {launchReadiness.warnings.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                ) : (
                  <strong>None</strong>
                )}
              </div>
              <div className="launch-signal signal-recommendation">
                <span>Next actions</span>
                {launchReadiness.recommendations.length > 0 ? (
                  <ul>
                    {launchReadiness.recommendations.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                ) : (
                  <strong>Ready to apply.</strong>
                )}
              </div>
            </div>
          </section>

          <section className="setup-summary-card">
            <p className="card-kicker">Current config</p>
            <div className="summary-stack">
              <div className="summary-line"><span>Execution</span><strong>{String(draft.mode).toUpperCase()}</strong></div>
              <div className="summary-line"><span>Strategy</span><strong>{draft.strategyId}</strong></div>
              <div className="summary-line"><span>Wallet key</span><strong>{env.walletKeyPreview || 'Missing'}</strong></div>
              <div className="summary-line"><span>RPC</span><strong>{draft.rpcUrl}</strong></div>
              <div className="summary-line"><span>Multi-wallet</span><strong>{draft.multiWalletEnabled ? 'ON' : 'OFF'}</strong></div>
              <div className="summary-line"><span>Confirm mode</span><strong>{draft.confirmMode ? 'ON' : 'OFF'}</strong></div>
              <div className="summary-line"><span>Automation</span><strong>{draft.automationEnabled ? 'ON' : 'OFF'}</strong></div>
            </div>
          </section>

          <section className="setup-summary-card">
            <p className="card-kicker">Checklist</p>
            <div className="checklist-stack">
              {checks.map((item) => (
                <CheckItem key={item.label} {...item} />
              ))}
            </div>
          </section>

          <section className="setup-summary-card">
            <p className="card-kicker">Wallet topology</p>
            <div className="summary-stack">
              <div className="summary-line"><span>Wallet entries</span><strong>{readiness.walletCount}</strong></div>
              <div className="summary-line"><span>Capital split</span><strong>{Number.isFinite(readiness.walletAllocation) ? `${readiness.walletAllocation}%` : '—'}</strong></div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
