// Theme for Ponyou Terminal Agent

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',

  black: '\x1b[30m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  gray: '\x1b[90m', redBright: '\x1b[91m', greenBright: '\x1b[92m',
  yellowBright: '\x1b[93m', blueBright: '\x1b[94m', magentaBright: '\x1b[95m',
  cyanBright: '\x1b[96m',

  bgBlack: '\x1b[40m', bgRed: '\x1b[41m', bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m', bgBlue: '\x1b[44m', bgCyan: '\x1b[46m',
};

export const LOG_COLORS = {
  INFO: 'white', SCAN: 'cyan', SIGNAL: 'yellow', TRADE: 'magenta',
  RISK: 'red', WARN: 'yellow', ERROR: 'red',
  SYSTEM: 'green', TOOL: 'blue', DEX: 'cyan', WALLET: 'green',
};

export const BORDER_FG = 'gray';
export const ACCENT_FG = 'yellow';
export const HEADER_FG = 'gray';
