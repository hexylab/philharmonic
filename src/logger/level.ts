export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevelEnabled(threshold: LogLevel, candidate: LogLevel): boolean {
  return PRIORITY[candidate] >= PRIORITY[threshold];
}
