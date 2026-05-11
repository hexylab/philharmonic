import { describe, expect, it } from 'vitest';

import {
  describeStallStatus,
  formatDurationMsShort,
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
  it('issue は # prefix、slot null は -, retry なしは -, watchdog なしは -', () => {
    expect(
      formatRunningRow({
        run_id: 'run-1',
        issue_number: 42,
        branch: 'feature/42-foo',
        started_at: '2026-05-09T00:00:00.000Z',
        slot: null,
        last_activity_at: '2026-05-09T00:00:00.000Z',
        retry_attempt: null,
        workspace_path: '/tmp/ws/issue-42',
        run_log_path: '/tmp/runs/run-1',
        runner_pid: null,
        watchdog: null,
      }),
    ).toEqual({
      issue: '#42',
      branch: 'feature/42-foo',
      slot: '-',
      startedAt: '2026-05-09T00:00:00.000Z',
      lastActivityAt: '2026-05-09T00:00:00.000Z',
      retryAttempt: '-',
      watchdog: '-',
      operatorAction: '-',
    });
  });

  it('operator_action_required が true なら operatorAction = reasons (#109)', () => {
    const row = formatRunningRow({
      run_id: 'run-op',
      issue_number: 11,
      branch: 'feature/11-y',
      started_at: '2026-05-09T00:00:00.000Z',
      slot: null,
      last_activity_at: '2026-05-09T00:00:00.000Z',
      retry_attempt: null,
      workspace_path: '/tmp/ws/issue-11',
      run_log_path: '/tmp/runs/run-op',
      runner_pid: 12345,
      watchdog: {
        reasons: ['orphaned', 'stale'],
        orphaned_since: '2026-05-09T00:01:00.000Z',
        stale_since: '2026-05-09T00:01:00.000Z',
        operator_action_required: true,
        operator_action_reasons: ['open_pr'],
      },
    });
    expect(row.operatorAction).toBe('open_pr');
  });

  it('slot 数値はそのまま、retry attempt は kind#attempt', () => {
    const row = formatRunningRow({
      run_id: 'run-2',
      issue_number: 99,
      branch: 'feature/99-bar',
      started_at: '2026-05-09T00:00:01.000Z',
      slot: 0,
      last_activity_at: '2026-05-09T00:00:30.000Z',
      retry_attempt: { kind: 'failure', attempt: 2 },
      workspace_path: '/tmp/ws/issue-99',
      run_log_path: '/tmp/runs/run-2',
      runner_pid: 12345,
      watchdog: null,
    });
    expect(row.slot).toBe('0');
    expect(row.lastActivityAt).toBe('2026-05-09T00:00:30.000Z');
    expect(row.retryAttempt).toBe('failure#2');
    expect(row.watchdog).toBe('-');
  });

  it('watchdog reasons があれば カンマ区切りで返す (#105)', () => {
    const row = formatRunningRow({
      run_id: 'run-3',
      issue_number: 7,
      branch: 'feature/7-x',
      started_at: '2026-05-09T00:00:00.000Z',
      slot: null,
      last_activity_at: '2026-05-09T00:00:00.000Z',
      retry_attempt: null,
      workspace_path: '/tmp/ws/issue-7',
      run_log_path: '/tmp/runs/run-3',
      runner_pid: 12345,
      watchdog: {
        reasons: ['orphaned', 'stale'],
        orphaned_since: '2026-05-09T00:01:00.000Z',
        stale_since: '2026-05-09T00:01:00.000Z',
        operator_action_required: false,
        operator_action_reasons: [],
      },
    });
    expect(row.watchdog).toBe('orphaned,stale');
  });
});

describe('formatDurationMsShort', () => {
  it('1 秒未満は ms', () => {
    expect(formatDurationMsShort(0)).toBe('0ms');
    expect(formatDurationMsShort(999)).toBe('999ms');
  });

  it('60 秒未満は s', () => {
    expect(formatDurationMsShort(1_000)).toBe('1s');
    expect(formatDurationMsShort(59_000)).toBe('59s');
  });

  it('60 分未満は m + 秒 0 詰め', () => {
    expect(formatDurationMsShort(60_000)).toBe('1m00s');
    expect(formatDurationMsShort(125_000)).toBe('2m05s');
  });

  it('1 時間以上は h + 分 0 詰め', () => {
    expect(formatDurationMsShort(3_600_000)).toBe('1h00m');
    expect(formatDurationMsShort(3_725_000)).toBe('1h02m');
  });

  it('NaN / 負数は 0ms', () => {
    expect(formatDurationMsShort(Number.NaN)).toBe('0s');
    expect(formatDurationMsShort(-1)).toBe('0ms');
  });
});

describe('describeStallStatus', () => {
  it('stallTimeoutMs <= 0 / NaN は disabled', () => {
    expect(
      describeStallStatus({
        lastActivityAt: '2026-05-09T00:00:00.000Z',
        stallTimeoutMs: 0,
        now: new Date('2026-05-09T00:00:30.000Z'),
      }),
    ).toEqual({ kind: 'disabled' });
    expect(
      describeStallStatus({
        lastActivityAt: '2026-05-09T00:00:00.000Z',
        stallTimeoutMs: Number.NaN,
        now: new Date(),
      }),
    ).toEqual({ kind: 'disabled' });
  });

  it('lastActivity から timeout 未満なら live で残時間を返す', () => {
    expect(
      describeStallStatus({
        lastActivityAt: '2026-05-09T00:00:00.000Z',
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:20.000Z'),
      }),
    ).toEqual({ kind: 'live', remainingMs: 40_000, sinceMs: 20_000 });
  });

  it('lastActivity から timeout 以上なら stalled で超過時間を返す', () => {
    expect(
      describeStallStatus({
        lastActivityAt: '2026-05-09T00:00:00.000Z',
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:01:30.000Z'),
      }),
    ).toEqual({ kind: 'stalled', overdueMs: 30_000, sinceMs: 90_000 });
  });

  it('now < lastActivityAt (時計逆走) は sinceMs=0 として live を返す', () => {
    expect(
      describeStallStatus({
        lastActivityAt: '2026-05-09T00:01:00.000Z',
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:30.000Z'),
      }),
    ).toEqual({ kind: 'live', remainingMs: 60_000, sinceMs: 0 });
  });
});

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    started_at: '2026-05-09T00:00:00.000Z',
    uptime_ms: 60_000,
    polling: { interval_ms: 30_000, last_tick_at: null },
    agent: { stall_timeout_ms: 0 },
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

  it('running が居る場合は #issue と branch / slot / retry / last_activity / stall を出す', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      now: new Date('2026-05-09T00:01:00.000Z'),
      snapshot: snapshot({
        agent: { stall_timeout_ms: 60_000 },
        running: [
          {
            run_id: 'run-1',
            issue_number: 42,
            branch: 'feature/42-foo',
            started_at: '2026-05-09T00:00:10.000Z',
            slot: 0,
            last_activity_at: '2026-05-09T00:00:30.000Z',
            retry_attempt: { kind: 'failure', attempt: 1 },
            workspace_path: '/tmp/ws/issue-42',
            run_log_path: '/tmp/runs/run-1',
            runner_pid: 12345,
            watchdog: null,
          },
        ],
        polling: { interval_ms: 30_000, last_tick_at: '2026-05-09T00:00:30.000Z' },
      }),
    });
    expect(text).toContain('polling.last_tick_at=2026-05-09T00:00:30.000Z');
    expect(text).toContain('agent.stall_timeout_ms=60000');
    expect(text).toContain(
      '  #42 branch=feature/42-foo started_at=2026-05-09T00:00:10.000Z slot=0 retry=failure#1 last_activity_at=2026-05-09T00:00:30.000Z stall=in 30s watchdog=-',
    );
  });

  it('running の watchdog reasons があれば "watchdog=orphaned,stale" のように出す (#105)', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      now: new Date('2026-05-09T00:01:00.000Z'),
      snapshot: snapshot({
        agent: { stall_timeout_ms: 60_000 },
        running: [
          {
            run_id: 'run-1',
            issue_number: 42,
            branch: 'feature/42-foo',
            started_at: '2026-05-09T00:00:10.000Z',
            slot: null,
            last_activity_at: '2026-05-09T00:00:10.000Z',
            retry_attempt: null,
            workspace_path: '/tmp/ws/issue-42',
            run_log_path: '/tmp/runs/run-1',
            runner_pid: 12345,
            watchdog: {
              reasons: ['orphaned', 'stale'],
              orphaned_since: '2026-05-09T00:00:50.000Z',
              stale_since: '2026-05-09T00:00:50.000Z',
              operator_action_required: false,
              operator_action_reasons: [],
            },
          },
        ],
      }),
    });
    expect(text).toContain('watchdog=orphaned,stale');
  });

  it('retry_queue が undefined のときは "(not provided by daemon)"', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      snapshot: snapshot(),
    });
    expect(text).toContain('retry_queue: (not provided by daemon)');
  });

  it('retry_queue が null のときは "(disabled)"', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      snapshot: snapshot({ retry_queue: null }),
    });
    expect(text).toContain('retry_queue: (disabled)');
  });

  it('retry_queue が空 entries のときは件数 0 + 設定値だけ出す', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      snapshot: snapshot({
        retry_queue: { size: 0, max_attempts: 5, max_backoff_ms: 300_000, entries: [] },
      }),
    });
    expect(text).toContain('retry_queue (0): max_attempts=5 max_backoff_ms=300000');
  });

  it('retry_queue に entry があれば kind / attempt / due / branch / workspace_path を出す', () => {
    const text = formatSnapshotForOnce({
      host: '127.0.0.1',
      port: 4000,
      now: new Date('2026-05-09T00:00:30.000Z'),
      snapshot: snapshot({
        retry_queue: {
          size: 2,
          max_attempts: 5,
          max_backoff_ms: 300_000,
          entries: [
            {
              kind: 'failure',
              issue_number: 42,
              attempt: 2,
              due_at: '2026-05-09T00:01:00.000Z',
              scheduled_at: '2026-05-09T00:00:30.000Z',
              failure_reason: 'runner_error',
              last_run_id: 'run-x',
              last_error_summary: 'boom',
              branch: 'feature/42-foo',
              workspace_path: '/tmp/issue-42',
            },
            {
              kind: 'continuation',
              issue_number: 43,
              attempt: 1,
              due_at: '2026-05-09T00:00:00.000Z',
              scheduled_at: '2026-05-09T00:00:00.000Z',
              failure_reason: null,
              last_run_id: 'run-y',
              last_error_summary: null,
              branch: 'feature/43-bar',
              workspace_path: '/tmp/issue-43',
            },
          ],
        },
      }),
    });
    expect(text).toContain('retry_queue (2): max_attempts=5 max_backoff_ms=300000');
    expect(text).toContain(
      '  #42 kind=failure attempt=2 reason=runner_error due_at=2026-05-09T00:01:00.000Z (in 30s) branch=feature/42-foo workspace_path=/tmp/issue-42 last_run_id=run-x',
    );
    expect(text).toContain(
      '  #43 kind=continuation attempt=1 reason=- due_at=2026-05-09T00:00:00.000Z (overdue 30s) branch=feature/43-bar workspace_path=/tmp/issue-43 last_run_id=run-y',
    );
  });
});
