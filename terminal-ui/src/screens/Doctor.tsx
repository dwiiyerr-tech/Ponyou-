import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { writeFileSync } from "node:fs";
import { Panel } from "../components/Panel.js";
import { Rule } from "../components/Rule.js";
import { color, glyph } from "../theme.js";
import { CHECKS, runCheck } from "../data/doctor.js";
import { rootPath } from "../data/paths.js";
import type { DoctorCheck } from "../types.js";
import type { TermSize } from "../hooks/useTerminalSize.js";

const STATUS_STYLE: Record<DoctorCheck["status"], { glyph: string; color: string }> = {
  pass: { glyph: glyph.ok, color: color.good },
  warn: { glyph: glyph.warn, color: color.warn },
  fail: { glyph: glyph.err, color: color.danger },
  checking: { glyph: glyph.dot, color: color.dim },
};

// Group display order, taken from the first appearance in CHECKS.
const GROUP_ORDER = Array.from(new Set(CHECKS.map((c) => c.group)));

/**
 * Doctor — grouped, streaming diagnostics. Each check streams in independently
 * (checking → result) so the panel fills top-to-bottom instead of blocking on
 * the slowest probe; the spinner is the one place motion earns its keep. Failing
 * and warning rows carry a `└ fix:` line so Doctor is a runbook, not just a
 * verdict. `c` writes a plaintext report you can paste into chat.
 */
export function Doctor({ active, size }: { active: boolean; size: TermSize }) {
  const [checks, setChecks] = useState<DoctorCheck[]>(
    CHECKS.map((c) => ({ id: c.id, label: c.label, group: c.group, status: "checking", detail: "" })),
  );
  const [runningId, setRunningId] = useState<number>(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  const runAll = useCallback(() => {
    setCopied(null);
    setChecks(CHECKS.map((c) => ({ id: c.id, label: c.label, group: c.group, status: "checking", detail: "" })));
    setRunningId((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Sequential so the UI streams in one row at a time and probes don't all
      // hammer the network at once.
      for (const def of CHECKS) {
        const result = await runCheck(def);
        if (cancelled) return;
        setChecks((prev) => prev.map((c) => (c.id === def.id ? result : c)));
      }
    })();
    return () => { cancelled = true; };
  }, [runningId]);

  const pass = checks.filter((c) => c.status === "pass").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const done = checks.every((c) => c.status !== "checking");

  const copyReport = useCallback(() => {
    const lines = [
      `Ponyou Doctor — ${new Date().toISOString()}`,
      `${pass} ok · ${warn} warn · ${fail} fail`,
      "",
      ...GROUP_ORDER.map((g) => {
        const rows = checks.filter((c) => c.group === g)
          .map((c) => `  [${c.status.toUpperCase()}] ${c.label}: ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ""}`);
        return [`${g}:`, ...rows].join("\n");
      }),
    ].join("\n");
    try {
      const p = rootPath("doctor-report.txt");
      writeFileSync(p, lines + "\n");
      setCopied("doctor-report.txt");
    } catch (e) {
      setCopied(`write failed: ${(e as Error).message}`);
    }
  }, [checks, pass, warn, fail]);

  const runDiagnosis = useCallback(async () => {
    if (diagnosing) return;
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      const res = await fetch("http://127.0.0.1:3000/api/doctor/diagnose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) { setDiagnosis("API error — pastikan bot sedang jalan"); return; }
      const data = (await res.json()) as { diagnosis?: string };
      setDiagnosis(data.diagnosis || "Tidak ada diagnosis tersedia.");
    } catch {
      setDiagnosis("Gagal terhubung ke bot — pastikan bot berjalan dan port 3000 aktif.");
    } finally {
      setDiagnosing(false);
    }
  }, [diagnosing]);

  useInput((input) => {
    if (!active) return;
    if (input === "r") { runAll(); setDiagnosis(null); }
    if (input === "c" && done) copyReport();
    if (input === "d" && done && !diagnosing) runDiagnosis();
  });

  const innerW = Math.max(24, size.width - 6);

  return (
    <Panel
      title="Doctor"
      hint={done ? `${pass} ok ${glyph.dot} ${warn} warn ${glyph.dot} ${fail} fail` : "running…"}
      active={active}
    >
      <Box flexDirection="column">
        {GROUP_ORDER.map((group, gi) => {
          const rows = checks.filter((c) => c.group === group);
          if (rows.length === 0) return null;
          return (
            <Box key={group} flexDirection="column" marginTop={gi === 0 ? 0 : 1}>
              <Rule width={innerW} label={group.toUpperCase()} />
              {rows.map((c) => <CheckRow key={c.id} check={c} />)}
            </Box>
          );
        })}
      </Box>

      {/* LLM Diagnosis panel — only shown after 'd' is pressed */}
      {(diagnosing || diagnosis) && (
        <Box marginTop={1} flexDirection="column">
          <Rule width={innerW} label="LLM DIAGNOSIS" />
          {diagnosing && (
            <Box><Text color={color.accent}><Spinner type="dots" /></Text><Text color={color.faint}> Meminta General Agent…</Text></Box>
          )}
          {diagnosis && (
            <Box flexDirection="column">
              {diagnosis.split("\n").map((line, i) => (
                <Text key={i} wrap="wrap" color={color.text}>{line}</Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={color.faint}>
          <Text color={color.accent}>r</Text> re-run  {glyph.dot}  <Text color={done ? color.accent : color.faint}>c</Text> report  {glyph.dot}  <Text color={done && !diagnosing ? color.accent : color.faint}>d</Text> LLM diagnose
        </Text>
        {copied && <Text color={color.good}>{glyph.ok} report written to {copied}</Text>}
        {done && fail > 0 && <Text color={color.danger}>{glyph.err} {fail} failing — fix before going live</Text>}
        {done && fail === 0 && warn === 0 && <Text color={color.good}>{glyph.ok} all systems healthy</Text>}
        {done && fail === 0 && warn > 0 && <Text color={color.warn}>{glyph.warn} {warn} warning{warn > 1 ? "s" : ""} — optional, safe to run</Text>}
      </Box>
    </Panel>
  );
}

function CheckRow({ check }: { check: DoctorCheck }) {
  const s = STATUS_STYLE[check.status];
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={3}>
          {check.status === "checking"
            ? <Text color={color.accent}><Spinner type="dots" /></Text>
            : <Text color={s.color} bold>{s.glyph}</Text>}
        </Box>
        <Box width={18}><Text color={color.text}>{check.label}</Text></Box>
        <Text color={check.status === "checking" ? color.faint : s.color}>
          {check.status === "checking" ? "checking…" : check.detail}
        </Text>
      </Box>
      {check.fix && (check.status === "fail" || check.status === "warn") && (
        <Box>
          <Text color={color.faint}>   {glyph.corner} fix: {check.fix}</Text>
        </Box>
      )}
    </Box>
  );
}
