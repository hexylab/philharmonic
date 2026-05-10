import { describe, expect, it } from 'vitest';

import {
  formatRunningRow,
  formatSnapshotForOnce,
  formatTotalCost,
  formatUptimeMs,
} from '../../src/dashboard/format.js';
import type { StateSnapshot } from '../../src/server/index.js';

describe('formatUptimeMs', () => {
  it('0 / 負数は 0s', () => {
    expect(formatUptimeMs(0)).toBe('0s');
    expect(formatUptimeMs(-1)).toBe('0s');
    expect(formatUptimeMs(Number.NaN)).toBe('0s');
  });

  it('59 秒未満は秒のみ', () => {
    expect(formatUptimeMs(5_000)).toBe('05s');
    expect(formatUptimeMs(59_000)).toBe('59s');
  });

  it('1 分以上は分秒', () => {
    expect(formatUptimeMs(60_000)).toBe('01m00s');
    expect(formatUptimeMs(125_000)).toBe('02m05s');
  });

  it('1 時間以上は時分秒', () => {
    expect(formatUptimeMs(3_600_000)).toBe('01h00m00s');
    expect(formatUptimeMs(3_725_000)).toBe('01h02m05s');
  });

  it('1 日以上は日時分秒', () => {
    expect(formatUptimeMs(86_400_000)).toBe('1d00h00m00s');
    expect(formatUptimeMs(90_125_000)).toBe('1d01h02m05s');
  });
});

describe('formatTotalCost', () => {
  it('小数 2 桁の USD 表記', () => {
    expect(formatTotalCost(0)).toBe('$0.00');
    expect(formatTotalCost(4.32)).toBe('$4.32');
    expect(formatTotalCost(4.325)).toBe('$4.33');
  });

  it('NaN / Infinity は $0.00', () => {
    expect(formatTotalCost(Number.NaN)).toBe('$0.00');
    expect(formatTotalCost(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });
});

describe('formatRunningRow', () => {
  it('issue は # prefix、slot null は -', () => {
    expect(
      formatRunningRow({
        run_id: 'run-1',
        issue_number: 42,
        branch: 'feature/42-foo',
        started_at: '2026-05-09T00:00:00.000Z',
        slot: null,
      }),
    ).toEqual({
      issue: '#42',
      branch: 'feature/42-foo',
      slot: '-',
      startedAt: '2026-05-09T00:00:00.000Z',
    });
  });

  it('slot 数値はそのまま', () => {
    const row = formatRunningRow({
      run_id: 'run-2',
      issue_number: 99,
      branch: 'feature/99-bar',
      started_at: '2026-05-09T00:00:01.000Z',
      slot: 0,
    });
    expect(row.slot).toBe('0');
  });
});

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    started_at: '2026-05-09T00:00:00.000Z',
    uptime_ms: 60_000,
    polling: { interval_ms: 30_000, last_tick_at: null },
    running: [],
    totals: { runs_completed: 0, runs_succeeded: 0, runs_failed: 0, total_cost_usd: 0 },
    ...overrides,
  };
}

describe('formatSnapshotForOnce', () => {
  it('host / port / 主要フィールドを 1 ブロックずつ書く', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      snapshot: snapshot(),
    });
    expect(text).toContain('host=127.0.0.1 port=4000');
    expect(text).toContain('started_at=2026-05-09T00:00:00.000Z uptime=01m00s');
    expect(text).toContain('polling.interval_ms=30000 polling.last_tick_at=(never)');
    expect(text).toContain('running: (none)');
    expect(text).toContain('runs_completed=0 runs_succeeded=0 runs_failed=0 total_cost_usd=0');
    expect(text).toContain('scheduler: (not provided by daemon)');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('scheduler が null なら "not evaluated yet"', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      snapshot: snapshot({ scheduler: null }),
    });
    expect(text).toContain('scheduler: (not evaluated yet)');
  });

  it('scheduler が空 evaluation のときは各 section を (0) で出す', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      snapshot: snapshot({
        scheduler: {
          last_evaluated_at: '2026-05-09T00:00:30.000Z',
          ready: [],
          blocked: [],
          cycles: [],
          invalid_dependencies: [],
        },
      }),
    });
    expect(text).toContain('scheduler: last_evaluated_at=2026-05-09T00:00:30.000Z');
    expect(text).toContain('  ready (0)');
    expect(text).toContain('  blocked (0)');
    expect(text).toContain('  cycles (0)');
    expect(text).toContain('  invalid (0)');
  });

  it('scheduler に ready / blocked / cycle / invalid が居ればそれぞれ列挙する', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      snapshot: snapshot({
        scheduler: {
          last_evaluated_at: '2026-05-09T00:00:30.000Z',
          ready: [
            { issue_number: 104, title: 'a' },
            { issue_number: 105, title: 'b' },
          ],
          blocked: [{ issue_number: 102, title: 'b', blocked_by: [101, 200] }],
          cycles: [{ issue_numbers: [201, 202] }],
          invalid_dependencies: [
            {
              issue_number: 103,
              title: 'c',
              entries: [
                { raw: 'owner/repo#1', issue_number: null, reason: 'parse_invalid' },
                { raw: '#999', issue_number: 999, reason: 'fetch_error', message: 'boom' },
              ],
            },
          ],
        },
      }),
    });
    expect(text).toContain('  ready (2): #104, #105');
    expect(text).toContain('  blocked (1):');
    expect(text).toContain('    #102 blocked_by=#101, #200');
    expect(text).toContain('  cycles (1):');
    expect(text).toContain('    [#201, #202]');
    expect(text).toContain('  invalid (1):');
    expect(text).toContain('    #103');
    expect(text).toContain('      raw=owner/repo#1 reason=parse_invalid');
    expect(text).toContain('      raw=#999 reason=fetch_error message=boom');
  });

  it('running が居る場合は #issue と branch / slot を出す', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      snapshot: snapshot({
        running: [
          {
            run_id: 'run-1',
            issue_number: 42,
            branch: 'feature/42-foo',
            started_at: '2026-05-09T00:00:10.000Z',
            slot: 0,
          },
        ],
        polling: { interval_ms: 30_000, last_tick_at: '2026-05-09T00:00:30.000Z' },
      }),
    });
    expect(text).toContain('polling.last_tick_at=2026-05-09T00:00:30.000Z');
    expect(text).toContain(
      '  #42 branch=feature/42-foo started_at=2026-05-09T00:00:10.000Z slot=0',
    );
  });
});
