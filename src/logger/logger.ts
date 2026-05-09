import { isLogLevelEnabled, type LogLevel } from './level.js';

export type LogFields = Record<string, unknown>;

export type Logger = {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
};

export type CreateLoggerOptions = {
  level?: LogLevel;
  destination?: NodeJS.WritableStream;
  bindings?: LogFields;
  clock?: () => Date;
};

const RESERVED_KEYS = new Set(['ts', 'level', 'msg']);

const DEFAULT_LEVEL: LogLevel = 'info';

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? DEFAULT_LEVEL;
  const destination = options.destination ?? process.stderr;
  const bindings: LogFields = options.bindings ?? {};
  const clock = options.clock ?? (() => new Date());

  const emit = (eventLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (!isLogLevelEnabled(level, eventLevel)) return;
    const merged = mergeFields(bindings, fields);
    const line = serialize(eventLevel, message, merged, clock);
    destination.write(line + '\n');
  };

  const logger: Logger = {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (childBindings) =>
      createLogger({
        level,
        destination,
        bindings: { ...bindings, ...childBindings },
        clock,
      }),
  };

  return logger;
}

function mergeFields(bindings: LogFields, fields: LogFields | undefined): LogFields {
  if (fields === undefined || Object.keys(fields).length === 0) return bindings;
  return { ...bindings, ...fields };
}

function serialize(level: LogLevel, message: string, fields: LogFields, clock: () => Date): string {
  const payload: Record<string, unknown> = {
    ts: clock().toISOString(),
    level,
    msg: message,
  };
  for (const [key, value] of Object.entries(fields)) {
    const snake = camelToSnake(key);
    if (RESERVED_KEYS.has(snake)) continue;
    payload[snake] = value;
  }
  return JSON.stringify(payload);
}

function camelToSnake(key: string): string {
  if (!/[A-Z]/.test(key)) return key;
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
