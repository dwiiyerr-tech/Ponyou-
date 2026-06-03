import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { Panel } from "../components/Panel.js";
import { Success } from "../components/StateViews.js";
import { color, glyph } from "../theme.js";
import { readWizardConfig, saveWizardConfig, validate, type WizardConfig } from "../data/config.js";

interface Step {
  key: keyof WizardConfig;
  label: string;
  help: string;
  placeholder: string;
  mask?: boolean;
  validate: (v: string) => string | null;
}

const STEPS: Step[] = [
  { key: "gmgnApiKey", label: "GMGN API Key", help: "From gmgn.ai → API. Powers discovery, rug audit, multi-chain.", placeholder: "gmgn_…", mask: true, validate: validate.gmgnApiKey },
  { key: "rpcUrl", label: "RPC URL", help: "Solana RPC endpoint (Helius/Triton/QuickNode). Leave blank to keep current.", placeholder: "https://…", validate: validate.rpcUrl },
  { key: "walletAddress", label: "Wallet Public Key", help: "Your Solana wallet address (read-only — never the private key).", placeholder: "base58 address", validate: validate.walletAddress },
  { key: "maxPositions", label: "Max Positions", help: "How many tokens can be open at once. 1-10.", placeholder: "3", validate: validate.maxPositions },
  { key: "dailyStopLossPct", label: "Daily Stop-Loss %", help: "Halt trading for the day at this loss. Negative, e.g. -10.", placeholder: "-10", validate: validate.dailyStopLossPct },
  { key: "deployAmountSol", label: "Deploy Amount (SOL)", help: "Base size per entry in SOL.", placeholder: "0.5", validate: validate.deployAmountSol },
];

/**
 * Wizard — a focused one-question-at-a-time stepper. Single input on screen
 * keeps cognitive load low (Emil: no clutter). Inline validation gives instant
 * feedback; a progress dot row shows where you are without a noisy progress bar.
 */
export function Wizard({ active, onDone, onExit }: { active: boolean; onDone: (saved: string[]) => void; onExit: () => void }) {
  const initial = useMemo(() => readWizardConfig(), []);
  const [values, setValues] = useState<Record<string, string>>(() => ({
    gmgnApiKey: initial.gmgnApiKey,
    rpcUrl: initial.rpcUrl,
    walletAddress: initial.walletAddress,
    maxPositions: String(initial.maxPositions),
    dailyStopLossPct: String(initial.dailyStopLossPct),
    deployAmountSol: String(initial.deployAmountSol),
  }));
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(values[STEPS[0].key]);
  const [error, setError] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<string[] | null>(null);

  const current = STEPS[step];

  function commitAndNext() {
    const err = current.validate(draft);
    if (err) { setError(err); return; }
    const nextValues = { ...values, [current.key]: draft };
    setValues(nextValues);
    setError(null);
    if (step < STEPS.length - 1) {
      const ns = step + 1;
      setStep(ns);
      setDraft(nextValues[STEPS[ns].key]);
    } else {
      // Final — persist merge-only.
      const patch: Partial<WizardConfig> = {
        gmgnApiKey: nextValues.gmgnApiKey,
        rpcUrl: nextValues.rpcUrl,
        walletAddress: nextValues.walletAddress,
        maxPositions: Number(nextValues.maxPositions),
        dailyStopLossPct: Number(nextValues.dailyStopLossPct),
        deployAmountSol: Number(nextValues.deployAmountSol),
      };
      const saved = saveWizardConfig(patch);
      setSavedKeys(saved);
      onDone(saved);
    }
  }

  useInput((_i, key) => {
    if (!active) return;
    if (key.escape) { onExit(); return; }     // escape hatch back to dashboard
    if (savedKeys) return;
    if (key.upArrow && step > 0) { const ps = step - 1; setStep(ps); setDraft(values[STEPS[ps].key]); setError(null); }
    if (key.downArrow && step < STEPS.length - 1) { const ns = step + 1; setStep(ns); setDraft(values[STEPS[ns].key]); setError(null); }
  });

  if (savedKeys) {
    return (
      <Panel title="Setup Complete" active={active}>
        <Success message={savedKeys.length ? `Saved ${savedKeys.length} setting${savedKeys.length > 1 ? "s" : ""} to user-config.json` : "No changes"} />
        <Box marginTop={1}><Text color={color.faint}>{glyph.dot} Restart the bot to apply RPC / wallet changes.</Text></Box>
      </Panel>
    );
  }

  return (
    <Panel title="Setup Wizard" hint={`step ${step + 1}/${STEPS.length}`} active={active}>
      {/* Progress dots */}
      <Box marginBottom={1}>
        {STEPS.map((_, i) => (
          <Text key={i} color={i === step ? color.accent : i < step ? color.good : color.faint}>
            {i < step ? glyph.ok : i === step ? glyph.live : glyph.idle}{" "}
          </Text>
        ))}
      </Box>

      <Text bold color={color.text}>{current.label}</Text>
      <Box marginBottom={1}><Text color={color.faint}>{current.help}</Text></Box>

      <Box>
        <Text color={color.accent}>{glyph.arrowR} </Text>
        <TextInput
          value={draft}
          onChange={(v) => { setDraft(v); setError(null); }}
          onSubmit={commitAndNext}
          placeholder={current.placeholder}
          mask={current.mask ? "•" : undefined}
        />
      </Box>

      {error && (
        <Box marginTop={1}><Text color={color.danger}>{glyph.err} {error}</Text></Box>
      )}

      <Box marginTop={1}>
        <Text color={color.faint}>
          <Text color={color.accent}>enter</Text> next {glyph.dot} <Text color={color.accent}>↑↓</Text> jump step
          {step === STEPS.length - 1 ? <Text color={color.good}>  {glyph.dot} enter saves</Text> : null}
        </Text>
      </Box>
    </Panel>
  );
}
