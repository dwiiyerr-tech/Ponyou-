import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { Panel } from "../components/Panel.js";
import { color, glyph } from "../theme.js";
import { CHECKS, runCheck } from "../data/doctor.js";
import type { DoctorCheck } from "../types.js";

const STATUS_STYLE: Record<DoctorCheck["status"], { glyph: string; color: string }> = {
  pass: { glyph: glyph.ok, color: color.good },
  warn: { glyph: glyph.warn, color: color.warn },
  fail: { glyph: glyph.err, color: color.danger },
  checking: { glyph: glyph.dot, color: color.dim },
};

/**
 * Doctor — environment & connectivity diagnostics. Each check streams in
 * independently (checking → result) so the panel fills top-to-bottom instead
 * of blocking on the slowest probe. The spinner only shows while a check is
 * genuinely in flight — that's the one place motion earns its keep here.
 */
export function Doctor({ active }: { active: boolean }) {
  const [checks, setChecks] = useState<DoctorCheck[]>(
    CHECKS.map((c) => ({ id: c.id, label: c.label, status: "checking", detail: "" })),
  );
  const [runningId, setRunningId] = useState<number>(0);

  const runAll = useCallback(() => {
    setChecks(CHECKS.map((c) => ({ id: c.id, label: c.label, status: "checking", detail: "" })));
    setRunningId((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Run sequentially so the UI streams in one row at a time — feels alive
      // and keeps network probes from hammering all at once.
      for (const def of CHECKS) {
        const result = await runCheck(def);
        if (cancelled) return;
        setChecks((prev) => prev.map((c) => (c.id === def.id ? result : c)));
      }
    })();
    return () => { cancelled = true; };
  }, [runningId]);

  useInput((input) => {
    if (!active) return;
    if (input === "r") runAll();
  });

  const pass = checks.filter((c) => c.status === "pass").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const done = checks.every((c) => c.status !== "checking");

  return (
    <Panel
      title="Doctor"
      hint={done ? `${pass} ok ${glyph.dot} ${warn} warn ${glyph.dot} ${fail} fail` : "running…"}
      active={active}
    >
      <Box flexDirection="column">
        {checks.map((c) => {
          const s = STATUS_STYLE[c.status];
          return (
            <Box key={c.id}>
              <Box width={3}>
                {c.status === "checking" ? (
                  <Text color={color.accent}><Spinner type="dots" /></Text>
                ) : (
                  <Text color={s.color} bold>{s.glyph}</Text>
                )}
              </Box>
              <Box width={20}><Text color={color.text}>{c.label}</Text></Box>
              <Text color={c.status === "checking" ? color.faint : s.color}>
                {c.status === "checking" ? "checking…" : c.detail}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={color.faint}>
          <Text color={color.accent}>r</Text> re-run all checks
          {done && fail > 0 ? <Text color={color.danger}>  {glyph.dot} {fail} failing — fix before going live</Text> : null}
          {done && fail === 0 && warn === 0 ? <Text color={color.good}>  {glyph.ok} all systems healthy</Text> : null}
        </Text>
      </Box>
    </Panel>
  );
}
