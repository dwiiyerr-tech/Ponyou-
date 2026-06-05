/** Shared types for the Ponyou TUI. */

export type ScreenId =
  | "dashboard"
  | "monitor"
  | "watchlist"
  | "logs"
  | "pnl"
  | "wizard"
  | "doctor";

export interface Position {
  sym: string;
  side: "BUY" | "SELL";
  entry: number;
  pnlPct: number;
  size: number;
  risk: "LOW" | "MED" | "HIGH";
  age: string;
}

export interface WatchToken {
  symbol: string;
  mint: string;
  liquidity: number;
  volume: number;
  ageMin: number;
  riskScore: number; // 0-100
  score: number;     // conviction 0-100
}

export interface LogLine {
  ts: number;
  tag: string;
  text: string;
}

export interface ChainHeat {
  chain: string;       // sol | base | bsc | eth
  score: number;       // 0-100
  condition: string;   // EXTREME | HOT | NORMAL | COLD | DEAD
}

export interface AgentState {
  agentName: string;
  mode: string;          // demo | live
  paper: boolean;
  strategy: string;
  network: string;
  riskLevel: string;     // LOW | MEDIUM | HIGH
  balanceSol: number;
  solPrice: number;
  walletStatus: string;  // connected | disabled
  rpcStatus: string;     // WS | FILE
  connected: boolean;    // live WS vs file fallback

  openPositions: number;
  maxPositions: number;
  openPositionsList: Position[];
  winRate: number;       // 0-1
  dailyPnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalSwaps: number;

  watchlist: WatchToken[];
  chains: ChainHeat[];
  walletUsd: number;       // wallet total USD (gauge) — preferred over balanceSol×price
  stateMtimeMs: number;    // last time the bot wrote state.json (0 if unknown)
  automation: { active: boolean; qualified: boolean; progressPct: number };
  uptimeSec: number;
  version: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "checking";
  detail: string;
  group?: string;   // Environment | API Keys | Network | Process
  fix?: string;     // remediation hint shown under failing/warning rows
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

export interface RiskLimits {
  maxPositions: number;
  dailyStopLossPct: number;
  deployAmountSol: number;
}
