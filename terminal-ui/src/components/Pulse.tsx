import React, { useState } from "react";
import { Text } from "ink";
import { useInterval } from "../hooks/useInterval.js";
import { color, glyph } from "../theme.js";

/**
 * Pulse — the one ambient motion in the app. A live dot that gently breathes
 * (bright → dim, ~900ms) to signal "this feed is alive". When `on` is false
 * (paused or stale) it stops pulsing and renders a static dot, so motion always
 * means something. Per Emil: ambient, low-frequency, purposeful — not decoration.
 */
export function Pulse({
  on,
  color: c = color.good,
}: {
  on: boolean;
  color?: string;
}) {
  const [bright, setBright] = useState(true);
  useInterval(() => { if (on) setBright((b) => !b); }, 900);
  if (!on) return <Text color={color.faint}>{glyph.idle}</Text>;
  return <Text color={bright ? c : color.faint}>{glyph.live}</Text>;
}
