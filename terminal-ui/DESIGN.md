# Ponyou TUI — Design Spec v2

> Goal: lift the Ponyou terminal UI to the polish tier of the best modern agent
> TUIs (Charm/opencode/Crush-class craft) — confident palette, exact colours,
> real information hierarchy, motion only where it earns its keep. Surfaces in
> scope: **App shell**, **Monitor** (new live screen), **Wizard**, **Doctor**.
>
> Grounding: Emil Kowalski's design-engineering principles, adapted to a cell
> grid where the only "pixels" are characters, weight (bold/dim), and colour.

---

## 0. What separates a top-tier TUI from a working one

A TUI that merely works uses the terminal's 16 ANSI colours, one border style,
and prints rows. A TUI that *feels* designed does five things the current
Ponyou TUI does not yet do consistently:

1. **Sets exact colours** (truecolor), not the terminal's idea of "cyan". The
   brand owns its palette instead of inheriting the user's theme.
2. **Has a brand moment** — a wordmark/logo that makes the first frame memorable.
3. **Breathes** — deliberate gutters, aligned columns, a real grid, never
   wall-to-wall text.
4. **Shows state, not just data** — live pulse, sparklines, semantic colour that
   maps to meaning, and explicit loading / empty / error states everywhere.
5. **Moves only when motion has a job** — spinners while waiting, a pulsing live
   dot, a one-time staggered first paint. Never on keyboard-repeated actions.

The current TUI already nails #4 partially and #5's discipline. This spec
adds #1–#3 and tightens #4 across all four surfaces.

---

## 1. Design language

### 1.1 Colour — own the palette (truecolor with graceful fallback)

Move from named ANSI colours to **exact hex**, rendered via Ink `<Text color="#RRGGBB">`.
Ink downsamples to 256/16 colours automatically on poorer terminals, so we lose
nothing on Termux while looking intentional on a real terminal.

One accent. Everything else neutral or semantic (Emil: hierarchy via weight +
one colour, not a rainbow).

| Token | Hex | Role |
| --- | --- | --- |
| `accent` | `#22D3EE` | brand cyan — focus, active tab, brand mark, cursor |
| `accentDim` | `#0E7490` | de-emphasised accent (inactive rail, underglow) |
| `text` | `#E5E7EB` | primary text (soft white, not pure #FFF) |
| `dim` | `#9CA3AF` | secondary text, labels |
| `faint` | `#4B5563` | tertiary — hints, borders, separators |
| `bg` | `#0B0F14` | reference background (we don't paint it, we assume dark) |
| `good` | `#34D399` | profit, pass, connected |
| `warn` | `#FBBF24` | caution, live-mode, partial |
| `danger` | `#F87171` | loss, fail, risk-high |
| `info` | `#60A5FA` | tool/info events |
| `trade` | `#C084FC` | swaps / trade events (violet) |

> **Why soft white (#E5E7EB), not #FFFFFF:** pure white vibrates against a dark
> terminal and flattens hierarchy — there's nowhere brighter to go for emphasis.
> Reserving true white-bright (bold) for the *one* number that matters per panel
> is what makes the eye land in the right place.

Severity → colour map (logs) stays as-is in spirit, retargeted to the hex set.

### 1.2 Weight & emphasis

Three levels only, applied consistently:

- **Bold + `text`** — the one primary value in a panel (balance, today's P&L).
- **Regular + `dim`** — labels and secondary values.
- **Regular + `faint`** — hints, separators, units, timestamps.

Accent colour is *never* used for plain text — only for focus, the brand, active
selection, and interactive affordances. This is the single biggest readability
win: colour becomes signal.

### 1.3 Borders & dividers

- Panels: `round` border. Inactive `faint`, **focused panel** `accent`.
- New **rule** primitive: a full-width `─` divider in `faint` for in-panel
  section breaks (used heavily in Monitor & Doctor) — cheaper on the eye than
  nesting more boxes.
- Title becomes a **chip**: ` WALLET ` rendered bold, accent when the panel is
  focused, dim otherwise — same as today but the right side of the title row
  carries a live `hint` (e.g. `2s ago`, `step 2/6`, `4 ok · 1 warn`).

### 1.4 Glyph set (one voice)

Extend the existing set; keep it small and consistent.

```
live ●   idle ○   ok ✓   warn ▲   err ✕   pending ◇
cursor ▸ dot ·    arrow → sep │     bullet •
spark ▁▂▃▄▅▆▇█    bar  ▏▎▍▌▋▊▉█ (partial-cell horizontal bars)
gain ▲   loss ▼   flat ─
```

### 1.5 Spacing & grid

Keep the `{xs:1, sm:1, md:2, lg:3}` scale. Add one rule: **every screen body has
1 col of horizontal padding and 1 row between stacked panels** — already mostly
true, make it invariant. Two-column screens use a 1-col gutter. Below
`COMPACT_WIDTH` (72) everything collapses to one column (already implemented).

### 1.6 Motion budget (Emil framework applied)

| Interaction | Frequency | Decision |
| --- | --- | --- |
| Tab/screen switch | 100s/day | **No animation** (already correct) |
| Command palette open/close | 100s/day | **No animation** (already correct) |
| List/step navigation | 10s/day | **No animation**, cursor glyph just moves |
| Doctor check in flight | occasional | Spinner — motion *is* the message |
| Live dot on Monitor | ambient | Slow pulse (≈1s on/off) — the one ambient motion |
| Sparkline / pnl bar update | ambient | Value redraw on data tick (no tween) |
| Monitor first paint | first-time | Optional 40ms/row stagger, one-shot only |
| Toast in/out | occasional | Instant show, auto-dismiss (already correct) |

No tweening of numbers, no easing of layout — the cell grid can't do sub-frame
motion convincingly, and these are glanced at constantly. Motion is reserved for
"the system is working" (spinner) and "this is alive" (pulse).

---

## 2. App shell

Header + tab bar + body + status bar. Upgrades over today:

- **Brand mark**: `ponyou` rendered as a truecolor gradient (accent → accentDim)
  wordmark, with a small `◆` glyph. First frame should feel like a product.
- **Tab bar** gains a focus underglow: the active tab keeps its number+label in
  accent bold; inactive tabs are `faint`. Add `7 Monitor`.
- **Status bar** unchanged in behaviour; hints become context-aware per screen
  (already implemented) and pick up Monitor's keys.

```
┌ ◆ ponyou ·· memecoin agent ───────────────────────── ● live · demo ─┐
│  1 Dashboard   2 Monitor   3 Watchlist   4 Logs   5 PnL   6 Setup   7 Doctor │
└──────────────────────────────────────────────────────────────────────────┘
  … screen body …
  1-7 screens   ↑↓ navigate   / palette   q quit
```

(`ponyou` printed with a per-character gradient; the `··` and rules are `faint`.)

---

## 3. Monitor — NEW live screen (the headline surface)

A full-screen, leave-it-running cockpit. This is the screen that should make the
TUI feel sejajar with the best. Distinct from Dashboard (which is a calm
at-a-glance summary): Monitor is dense, live, and ranked.

**Layout (≥72 cols):** a vitals strip on top, a 2-column body, a heat strip on
the bottom.

```
┌ MONITOR ─────────────────────────────────── ● LIVE · updated 2s ago ─┐
│                                                                       │
│  BALANCE          TODAY P&L            OPEN          WIN RATE         │
│  12.480 SOL       +$184.20  ▲          3 / 5         62%             │
│  ≈ $2,134         ▁▂▃▅▇▆▇█  +9.4%      2 long 1 evm   ▇▇▇▇▇▆░░░░     │
│                                                                       │
├─ OPEN POSITIONS ──────────────────────┬─ ACTIVITY ───────────────────┤
│  SYM      ENTRY    P&L      SIZE  AGE  │  ▸ 14:02 SCAN  56 tokens swept│
│ ▸WIF     $0.0021  +24%▲ ▇▇▇ 0.5  12m  │    14:02 SIGNAL POPCAT conv 81│
│  POPCAT  $0.0009  +8%▲  ▇░░ 0.5  4m   │    14:01 TRADE  bought WIF 0.5 │
│  BRETT   $0.012   -6%▼  ░░░ 0.3  31m  │    14:00 RISK   BODEN rug 78 ✕ │
│                                        │    13:59 WALLET +0.04 SOL      │
│  realized +$96 · unreal +$88           │    13:58 DEX    Jupiter route  │
├─ CHAIN HEAT ──────────────────────────┴──────────────────────────────┤
│  SOL ▇▇▇▇▇▇ hot   BASE ▇▇▇ warm   BSC ▇░ cold   ETH ░ cold            │
└───────────────────────────────────────────────────────────────────────┘
  r refresh   f follow-position   l logs   p pause   / palette   q quit
```

Design decisions:

- **Vitals strip**: four cells, each one label (`dim`) + one bold primary value +
  one supporting micro-viz. Today P&L carries a **sparkline** of the intraday
  curve; win-rate carries a **partial-cell bar** (`▇▇▇▇▇▆░░░░`). Colour of the
  P&L number is the only place green/red appears up top — it's the number you
  look for.
- **Open positions table**: the focused row gets the `▸` cursor + accent symbol;
  each row has a 3-cell **mini P&L bar** so you read winners/losers without
  parsing percentages. Sorted by |P&L| desc (the position that needs attention
  floats up). Footer line totals realized/unreal.
- **Activity feed**: the live log stream, severity-coloured tags, newest pinned
  at top with the `▸` accent cursor, fading to `dim`. This is the "it's alive"
  region.
- **Chain heat strip**: per-chain hotness as partial-cell bars + a one-word
  label, colour-graded. Mirrors `market-chain-intel.js` output.
- **LIVE pill** in the title pulses (≈1s) only while data is fresh; if the
  feed goes stale (>10s) it drops to `○ stale` in `warn`, no pulse. The "updated
  Ns ago" counter is the honesty signal.
- **`p` pause** freezes the feed (and stops the pulse) so you can read a row
  without it scrolling — a small, loved detail.

**Compact (<72 cols):** vitals stack 2×2, body becomes single column
(positions, then a shorter activity feed), heat strip wraps to two lines.

**States:** Loading → `Connecting to agent…` spinner. Empty (no positions) →
`No open positions · scanning` with the activity feed still live. Stale → banner
`Feed stale · last update 14s ago` in `warn`. Disconnected → `File mode · live
feed unavailable` in `faint` (we're reading JSON, not WS).

---

## 4. Wizard — guided setup with a progress rail + review step

Keep the one-question-at-a-time model (low cognitive load) but add a **left
progress rail** so you always see the whole journey, inline validation, and a
final **Review** step before writing config. This is the difference between a
form and a wizard.

```
┌ SETUP WIZARD ───────────────────────────────────────── step 2 / 7 ─┐
│                                                                     │
│  ✓ GMGN API Key      │   RPC URL                                    │
│  ▸ RPC URL           │   Solana RPC endpoint (Helius / Triton /     │
│  ◇ Wallet Pubkey     │   QuickNode). Leave blank to keep current.   │
│  ◇ Max Positions     │                                              │
│  ◇ Daily Stop-Loss   │   → https://mainnet.helius-rpc.com/?api-key…│
│  ◇ Deploy Amount     │                                              │
│  ◇ Review & Apply    │   ✓ looks like a valid https RPC endpoint    │
│                      │                                              │
└─────────────────────────────────────────────────────────────────────┘
  enter next   ↑↓ jump step   esc back
```

Final step:

```
┌ REVIEW & APPLY ─────────────────────────────────────── step 7 / 7 ─┐
│                                                                     │
│  GMGN API Key      gmgn_••••••••••••3f2a      (changed)             │
│  RPC URL           https://…helius…           (changed)             │
│  Wallet Pubkey     7Xk…9dQ                     unchanged            │
│  Max Positions     3                           unchanged            │
│  Daily Stop-Loss   -10%                        unchanged            │
│  Deploy Amount     0.5 SOL                      changed             │
│                                                                     │
│  ▲ RPC / wallet changes require a bot restart to take effect.       │
│                                                                     │
│  enter  apply & save      esc  back                                 │
└─────────────────────────────────────────────────────────────────────┘
```

Design decisions:

- **Rail glyphs**: `✓` done, `▸` current (accent), `◇` pending (faint). The rail
  is the progress indicator — drop the separate dot row.
- **Inline validation** turns into a `✓ looks valid` (good) / `✕ message`
  (danger) line under the input — feedback the instant you stop typing, not on
  submit only.
- **Masked secrets** show last 4 chars (`••••3f2a`) on the review screen so you
  can confirm the right key without exposing it.
- **Diff awareness**: review marks each field `changed` / `unchanged` so you
  know exactly what the save will touch (merge-only write is already correct).
- **Success state**: existing `Setup Complete` panel, plus a one-line
  `Run npm run …` / restart hint when RPC/wallet changed.

---

## 5. Doctor — grouped, streaming diagnostics with remediation

Keep the streaming one-row-at-a-time reveal (it feels alive and rate-limits
network probes — already correct). Add **grouping**, a **summary banner**, and
**copyable fix hints** so Doctor doesn't just diagnose, it tells you what to do.

```
┌ DOCTOR ──────────────────────────────────── 6 ok · 1 warn · 1 fail ─┐
│                                                                      │
│  ENVIRONMENT                                                         │
│   ✓ Node version        v20.11.0                                     │
│   ✓ user-config.json    found · 18 keys                              │
│                                                                      │
│  API KEYS                                                            │
│   ✓ GMGN API key        set · gmgn_••••3f2a                          │
│   ▲ Birdeye key         missing · optional, discovery degrades       │
│                                                                      │
│  NETWORK                                                             │
│   ✓ Helius RPC          187ms                                        │
│   ✓ DexScreener         210ms                                        │
│   ✕ GMGN /token         HTTP 400 · token_signal endpoint dead        │
│       └ fix: this surface degrades gracefully; safe to ignore        │
│                                                                      │
│  PROCESS                                                             │
│   ⠹ Bot process         checking…                                    │
│                                                                      │
│  ✕ 1 check failing — fix before going live                           │
└──────────────────────────────────────────────────────────────────────┘
  r re-run   c copy report   / palette   q quit
```

Design decisions:

- **Groups** (Environment / API Keys / Network / Process) with a `faint` rule
  under each header. Same data, navigable in seconds.
- **Per-row remediation**: a failing/warning check can carry a `└ fix:` line in
  `dim` — turns Doctor from a verdict into a runbook.
- **Summary banner** at the bottom: green `✓ all systems healthy` or red
  `✕ N failing — fix before going live` (already present, formalised).
- **`c` copy report**: writes a plaintext summary to the dashboard-cmd channel /
  a file so you can paste it into chat — small, high-leverage.
- **Spinner** only on the in-flight row (already correct).

---

## 6. Shared components — net new / changed

| Component | Status | Change |
| --- | --- | --- |
| `theme.ts` | change | hex palette, gradient helper, extended glyph set, `bar()` partial-cell helper |
| `Header` | change | gradient wordmark + `◆` glyph |
| `TabBar` | change | add Monitor; focus styling unchanged |
| `Panel` | change | title-chip + right-aligned `hint`; `rule` support |
| `Sparkline` | **new** | renders `▁▂▃▄▅▆▇█` from a number series, clamped, coloured |
| `MeterBar` | **new** | partial-cell horizontal bar `▇▇▇░░` for win-rate / heat / pnl |
| `Rule` | **new** | full-width `─` divider in `faint` |
| `Pulse` | **new** | live dot that toggles ● visibility on a ~1s timer |
| `Vitals` | **new** | the Monitor top strip cell (label + value + microviz) |
| `StateViews` | reuse | Loading / Empty / Error / Success already exist |

All new components are pure Ink (`Box`/`Text`) — no native deps, Termux-safe.

---

## 7. Non-goals / constraints

- **No bot code changes.** Same read model: JSON files + `POST /api/cmd` with
  file fallback (already the contract).
- **No new heavy deps.** `ink`, `react`, `ink-spinner`, `ink-text-input` only.
  Gradient is a small per-char helper, not a library.
- **Termux first.** Everything must collapse cleanly below 72 cols and survive a
  16-colour terminal (truecolor downsamples, glyphs are all BMP box-drawing).
- **Legacy `terminal-app/` untouched.** This spec is `terminal-ui/` only.

---

## 8. Implementation order (proposed)

1. `theme.ts` → hex palette + gradient + `bar()`/spark helpers + glyphs.
2. New primitives: `Sparkline`, `MeterBar`, `Rule`, `Pulse`.
3. `Header` gradient wordmark; `TabBar` + `Panel` chip/hint; add `monitor` to
   `ScreenId`, `TABS`, `app.tsx` routing + palette `/monitor`.
4. **Monitor** screen (vitals + positions + activity + heat + states + pause).
5. **Wizard** rail + inline validation + Review step.
6. **Doctor** grouping + remediation + summary + copy.
7. `pnpm build`, run on a normal width and a <72 width, screenshot each surface.
8. Update `README.md` (screens table gains Monitor; keys updated).

Tests: the data layer (`data/*.ts`) stays the test surface; new pure helpers
(`bar()`, sparkline scaling, gradient) get unit tests. No bot-code tests touched.
