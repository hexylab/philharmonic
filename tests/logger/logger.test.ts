import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createLogger,
  isLogLevelEnabled,
  LOG_LEVELS,
  type LogLevel,
} from '../../src/logger/index.js';

class CaptureStream extends Writable {
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  lines(): unknown[] {
    return this.chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }
}

const FIXED_NOW = new Date('2026-05-09T12:34:56.789Z');

function makeLogger(overrides: Parameters<typeof createLogger>[0] = {}) {
  const dest = new CaptureStream();
  const logger = createLogger({
    level: 'debug',
    destination: dest,
    clock: () => FIXED_NOW,
    ...overrides,
  });
  return { logger, dest };
}

describe('isLogLevelEnabled', () => {
  it('debug 設定では全レベルを有効化する', () => {
    for (const candidate of LOG_LEVELS) {
      expect(isLogLevelEnabled('debug', candidate)).toBe(true);
    }
  });

  it('info 設定では debug を無効化する', () => {
    expect(isLogLevelEnabled('info', 'debug')).toBe(false);
    expect(isLogLevelEnabled('info', 'info')).toBe(true);
    expect(isLogLevelEnabled('info', 'warn')).toBe(true);
    expect(isLogLevelEnabled('info', 'error')).toBe(true);
  });

  it('error 設定では error のみ有効化する', () => {
    expect(isLogLevelEnabled('error', 'debug')).toBe(false);
    expect(isLogLevelEnabled('error', 'info')).toBe(false);
    expect(isLogLevelEnabled('error', 'warn')).toBe(false);
    expect(isLogLevelEnabled('error', 'error')).toBe(true);
  });
});

describe('createLogger', () => {
  it('JSON line 形式で 1 イベント 1 行を出力する', () => {
    const { logger, dest } = makeLogger();
    logger.info('hello');
    const lines = dest.lines();
    expect(lines).toEqual([
      {
        ts: FIXED_NOW.toISOString(),
        level: 'info',
        msg: 'hello',
      },
    ]);
  });

  it('呼び出し時の fields をトップレベルに展開する', () => {
    const { logger, dest } = makeLogger();
    logger.info('candidate selected', { runId: 'abc', issueNumber: 42 });
    expect(dest.lines()).toEqual([
      {
        ts: FIXED_NOW.toISOString(),
        level: 'info',
        msg: 'candidate selected',
        run_id: 'abc',
        issue_number: 42,
      },
    ]);
  });

  it('camelCase キーを top-level だけ snake_case に変換する', () => {
    const { logger, dest } = makeLogger();
    logger.info('event', {
      runId: 'abc',
      issueNumber: 42,
      sessionId: 'session-uuid',
      nested: { camelCase: 'inner' },
    });
    const [entry] = dest.lines();
    expect(entry).toMatchObject({
      run_id: 'abc',
      issue_number: 42,
      session_id: 'session-uuid',
      nested: { camelCase: 'inner' },
    });
  });

  it('level が threshold より低いイベントは出力しない', () => {
    const { logger, dest } = makeLogger({ level: 'info' });
    logger.debug('not logged');
    logger.info('logged');
    expect(dest.lines()).toHaveLength(1);
    expect((dest.lines()[0] as { msg: string }).msg).toBe('logged');
  });

  it('bindings は全イベントに付与される', () => {
    const dest = new CaptureStream();
    const logger = createLogger({
      level: 'debug',
      destination: dest,
      clock: () => FIXED_NOW,
      bindings: { runId: 'r1' },
    });
    logger.info('a');
    logger.warn('b');
    expect(dest.lines()).toEqual([
      {
        ts: FIXED_NOW.toISOString(),
        level: 'info',
        msg: 'a',
        run_id: 'r1',
      },
      {
        ts: FIXED_NOW.toISOString(),
        level: 'warn',
        msg: 'b',
        run_id: 'r1',
      },
    ]);
  });

  it('child logger は親 bindings に追加 bindings を重ねる', () => {
    const { logger, dest } = makeLogger({ bindings: { runId: 'r1' } });
    const child = logger.child({ issueNumber: 42 });
    child.info('candidate selected');
    expect(dest.lines()).toEqual([
      {
        ts: FIXED_NOW.toISOString(),
        level: 'info',
        msg: 'candidate selected',
        run_id: 'r1',
        issue_number: 42,
      },
    ]);
  });

  it('child logger の bindings は親 logger に影響しない', () => {
    const { logger, dest } = makeLogger({ bindings: { runId: 'r1' } });
    const child = logger.child({ issueNumber: 42 });
    child.info('child event');
    logger.info('parent event');
    expect(dest.lines()).toEqual([
      {
        ts: FIXED_NOW.toISOString(),
        level: 'info',
        msg: 'child event',
        run_id: 'r1',
        issue_number: 42,
      },
      {
        ts: FIXED_NOW.toISOString(),
        level: 'info',
        msg: 'parent event',
        run_id: 'r1',
      },
    ]);
  });

  it('呼び出し時 fields は bindings を上書きする', () => {
    const { logger, dest } = makeLogger({ bindings: { runId: 'r1' } });
    logger.info('event', { runId: 'override' });
    expect(dest.lines()).toEqual([
      {
        ts: FIXED_NOW.toISOString(),
        level: 'info',
        msg: 'event',
        run_id: 'override',
      },
    ]);
  });

  it('予約語 (ts, level, msg) は呼び出し側の fields でも上書きされない', () => {
    const { logger, dest } = makeLogger({ bindings: { ts: 'spoof', level: 'spoof' } });
    logger.info('real msg', { ts: 'override', level: 'override', msg: 'override' });
    expect(dest.lines()).toEqual([
      {
        ts: FIXED_NOW.toISOString(),
        level: 'info',
        msg: 'real msg',
      },
    ]);
  });

  it('clock injection で ts が制御できる', () => {
    const dest = new CaptureStream();
    let count = 0;
    const logger = createLogger({
      level: 'debug',
      destination: dest,
      clock: () => new Date(`2026-01-01T00:00:0${count++}.000Z`),
    });
    logger.info('a');
    logger.info('b');
    const lines = dest.lines() as Array<{ ts: string }>;
    expect(lines.map((l) => l.ts)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ]);
  });

  it('既定では process.stderr に出力する', () => {
    const logger = createLogger({ level: 'info' });
    expect(logger.level).toBe('info');
  });

  it('全レベルメソッドが対応する level を出力する', () => {
    const { logger, dest } = makeLogger({ level: 'debug' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    const lines = dest.lines() as Array<{ level: LogLevel; msg: string }>;
    expect(lines.map((l) => l.level)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(lines.map((l) => l.msg)).toEqual(['d', 'i', 'w', 'e']);
  });
});
