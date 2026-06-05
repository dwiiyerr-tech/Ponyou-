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
  { key: "walletAddress", label: "Wallet Pubkey", help: "Your Solana wallet address (read-only — never the private key).", placeholder: "base58 address", validate: validate.walletAddress },
  { key: "maxPositions", label: "Max Positions", help: "How many tokens can be open at once. 1-10.", placeholder: "3", validate: validate.maxPositions },
  { key: "dailyStopLossPct", label: "Daily Stop-Loss", help: "Halt trading for the day at this loss. Negative, e.g. -10.", placeholder: "-10", validate: validate.dailyStopLossPct },
  { key: "deployAmountSol", label: "Deploy Amount", help: "Base size per entry in SOL.", placeholder: "0.5", validate: validate.deployAmountSol },
];

const REVIEW = STEPS.length; // virtual final step
const TOTAL = STEPS.length + 1;

/**
 * Wizard — one question at a time (low cognitive load) with a left progress
 * rail so you always see the whole journey, inline validation as you type, and
 * a Review & Apply step that diffs every field before the merge-only write.
 * The rail IS the progress indicator — no separate noisy bar.
 */
export function Wizard({ active, onDone, onExit }: { active: boolean; onDone: (saved: string[]) => void; onExit: () => void }) {
  const initial = useMemo(() => readWizardConfig(), []);
  const initialStr = useMemo<Record<string, string>>(() => ({
    gmgnApiKey: initial.gmgnApiKey,
    rpcUrl: initial.rpcUrl,
    walletAddress: initial.walletAddress,
    maxPositions: String(initial.maxPositions),
    dailyStopLossPct: String(initial.dailyStopLossPct),
    deployAmountSol: String(initial.deployAmountSol),
  }), [initial]);

  const [values, setValues] = useState<Record<string, string>>(() => ({ ...initialStr }));
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(() => initialStr[STEPS[0].key]);
  const [error, setError] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<string[] | null>(null);

  const onReview = step === REVIEW;
  const current = onReview ? null : STEPS[step];

  function gotoStep(ns: number) {
    setStep(ns);
    setError(null);
    if (ns < REVIEW) setDraft(values[STEPS[ns].key]);
  }

  function commitAndNext() {
    if (!current) return;
    const err = current.validate(draft);
    if (err) { setError(err); return; }
    setValues((v) => ({ ...v, [current.key]: draft }));
    gotoStep(step + 1);
  }

  function applyAndSave() {
    const patch: Partial<WizardConfig> = {
      gmgnApiKey: values.gmgnApiKey,
      rpcUrl: values.rpcUrl,
      walletAddress: values.walletAddress,
      maxPositions: Number(values.maxPositions),
      dailyStopLossPct: Number(values.dailyStopLossPct),
      deployAmountSol: Number(values.deployAmountSol),
    };
    const saved = saveWizardConfig(patch);
    setSavedKeys(saved);
    onDone(saved);
  }

  useInput((_i, key) => {
    if (!active || savedKeys) return;
    if (key.escape) { onExit(); return; }
    if (key.upArrow && step > 0) gotoStep(step - 1);
    else if (key.downArrow && step < REVIEW) gotoStep(step + 1);
    // On the review step there's no TextInput to own Enter, so we handle it here.
    if (onReview && key.return) applyAndSave();
  });

  if (savedKeys) {
    const needsRestart = savedKeys.some((k) => k === "rpcUrl" || k === "walletAddress");
    return (
      <Panel title="Setup Complete" active={active}>
        <Success message={savedKeys.length ? `Saved ${savedKeys.length} setting${savedKeys.length > 1 ? "s" : ""} to user-config.json` : "No changes"} />
        {needsRestart && (
          <Box marginTop={1}><Text color={color.warn}>{glyph.warn} Restart the bot to apply RPC / wallet changes.</Text></Box>
        )}
      </Panel>
    );
  }

  const railW = active ? 22 : 22;

  return (
    <Panel title="Setup Wizard" hint={`step ${step + 1} / ${TOTAL}`} active={active}>
      <Box>
        {/* Left progress rail */}
        <Box flexDirection="column" width={railW} marginRight={2}>
          {STEPS.map((s, i) => <RailRow key={s.key} label={s.label} state={i < step ? "done" : i === step ? "current" : "pending"} />)}
          <RailRow label="Review & Apply" state={onReview ? "current" : "pending"} />
        </Box>

        {/* Right content */}
        <Box flexDirection="column" flexGrow={1}>
          {onReview ? (
            <ReviewPane values={values} initialStr={initialStr} />
          ) : (
            <Box flexDirection="column">
              <Text bold color={color.text}>{current!.label}</Text>
              <Box marginBottom={1}><Text color={color.faint}>{current!.help}</Text></Box>
              <Box>
                <Text color={color.accent}>{glyph.arrowR} </Text>
                <TextInput
                  value={draft}
                  onChange={(v) => { setDraft(v); setError(null); }}
                  onSubmit={commitAndNext}
                  placeholder={current!.placeholder}
                  mask={current!.mask ? "•" : undefined}
                />
              </Box>
              <Box marginTop={1}><ValidationLine value={draft} validate={current!.validate} error={error} /></Box>
            </Box>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={color.faint}>
          {onReview
            ? <Text><Text color={color.good}>enter</Text> apply & save  {glyph.dot}  <Text color={color.accent}>↑↓</Text> jump  {glyph.dot}  <Text color={color.accent}>esc</Text> back</Text>
            : <Text><Text color={color.accent}>enter</Text> next  {glyph.dot}  <Text color={color.accent}>↑↓</Text> jump step  {glyph.dot}  <Text color={color.accent}>esc</Text> back</Text>}
        </Text>
      </Box>
    </Panel>
  );
}

function RailRow({ label, state }: { label: string; state: "done" | "current" | "pending" }) {
  const g = state === "done" ? glyph.ok : state === "current" ? glyph.cursor : glyph.pending;
  const c = state === "done" ? color.good : state === "current" ? color.accent : color.faint;
  return (
    <Box>
      <Text color={c}>{g} </Text>
      <Text color={state === "current" ? color.accent : state === "done" ? color.dim : color.faint} bold={state === "current"}>{label}</Text>
    </Box>
  );
}

/** Inline validation feedback as you type — instant, not deferred to submit. */
function ValidationLine({ value, validate, error }: { value: string; validate: (v: string) => string | null; error: string | null }) {
  if (error) return <Text color={color.danger}>{glyph.err} {error}</Text>;
  const liveErr = validate(value);
  if (liveErr) return <Text color={color.danger}>{glyph.err} {liveErr}</Text>;
  if (!value.trim()) return <Text color={color.faint}>{glyph.dot} optional — leave blank to keep current</Text>;
  return <Text color={color.good}>{glyph.ok} looks valid</Text>;
}

function maskValue(key: string, raw: string, isMask?: boolean): string {
  if (!raw) return "—";
  if (isMask) return `••••${raw.slice(-4)}`;
  if (key === "walletAddress" && raw.length > 12) return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
  if (key === "dailyStopLossPct") return `${raw}%`;
  if (key === "deployAmountSol") return `${raw} SOL`;
  return raw;
}

function ReviewPane({ values, initialStr }: { values: Record<string, string>; initialStr: Record<string, string> }) {
  return (
    <Box flexDirection="column">
      <Text bold color={color.text}>Review & Apply</Text>
      <Box marginBottom={1}><Text color={color.faint}>Confirm before writing to user-config.json (merge-only).</Text></Box>
      {STEPS.map((s) => {
        const raw = values[s.key];
        const changed = String(raw) !== String(initialStr[s.key]);
        return (
          <Box key={s.key}>
            <Box width={18}><Text color={color.dim}>{s.label}</Text></Box>
            <Box width={20}><Text color={raw ? color.text : color.faint}>{maskValue(s.key, raw, s.mask)}</Text></Box>
            <Text color={changed ? color.accent : color.faint}>{changed ? `${glyph.dot} changed` : "unchanged"}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
