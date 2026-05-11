import type { RetryQueueStateJson, SchedulerStateJson, StateSnapshot } from '../server/index.js';

/**
 * Snapshot を表示用文字列へ変換する pure helper。
 * Ink を import せずに unit test できるよう分離してある。
 *
 * spec: docs/specs/dashboard.md
 */

/** TUI で `Ready (n) #a, #b, ...` 行に並べる issue 番号の上限 */
export const READY_ISSUES_DISPLAY_LIMIT = 10;

export function formatUptimeMs(uptimeMs: number): string {
  if (!Number.isFinite(uptimeMs) || uptimeMs <= 0) return '0s';
  const totalSec = Math.floor(uptimeMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const totalHour = Math.floor(totalMin / 60);
  const hour = totalHour % 24;
  const day = Math.floor(totalHour / 24);

  const parts: string[] = [];
  if (day > 0) parts.push(`${day}d`);
  if (hour > 0 || day > 0) parts.push(`${pad2(hour)}h`);
  if (min > 0 || hour > 0 || day > 0) parts.push(`${pad2(min)}m`);
  parts.push(`${pad2(sec)}s`);
  return parts.join('');
}

export function formatTotalCost(usd: number): string {
  if (!Number.isFinite(usd)) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

export function formatRunningRow(entry: StateSnapshot['running'][number]): {
  issue: string;
  branch: string;
  slot: string;
  startedAt: string;
  lastActivityAt: string;
  retryAttempt: string;
  /** active run watchdog (#105) marker。"-" は marker 無し */
  watchdog: string;
} {
  return {
    issue: `#${entry.issue_number}`,
    branch: entry.branch,
    slot: entry.slot === null ? '-' : String(entry.slot),
    startedAt: entry.started_at,
    lastActivityAt: entry.last_activity_at,
    retryAttempt:
      entry.retry_attempt === null
        ? '-'
        : `${entry.retry_attempt.kind}#${entry.retry_attempt.attempt}`,
    watchdog: formatWatchdogShort(entry.watchdog),
  };
}

function formatWatchdogShort(
  watchdog: StateSnapshot['running'][number]['watchdog'] | undefined,
): string {
  // 古い serve は watchdog field を持たない (undefined) ため null と同じく "-" を返す
  if (watchdog === null || watchdog === undefined || watchdog.reasons.length === 0) return '-';
  return watchdog.reasons.join(',');
}

/**
 * 経過時間 (ms) を `Xs` / `1m05s` / `1h00m` 等の短い単位で表示する。
 *
 * dashboard の "Xs ago" / "in Xs" 表示で再利用する pure helper。`uptime` と異なり 0 桁
 * 詰めはしないが、min 以上では `mm:ss` の組み合わせを使う (運用上 last activity 表示を
 * コンパクトに収めたいため)。
 */
export function formatDurationMsShort(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return '0s';
  const ms = Math.max(0, Math.floor(durationMs));
  if (ms < 1_000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m${pad2(sec)}s`;
  const min = totalMin % 60;
  const hour = Math.floor(totalMin / 60);
  return `${hour}h${pad2(min)}m`;
}

export type StallStatus =
  | { kind: 'disabled' }
  | { kind: 'live'; remainingMs: number; sinceMs: number }
  | { kind: 'stalled'; overdueMs: number; sinceMs: number };

/**
 * `last_activity_at` と `agent.stall_timeout_ms` から、stall までの残時間 / 既に
 * stall 判定を超えた時間を算出する。stall 判定無効 (timeout 0 / 不正値) なら disabled。
 *
 * `now < lastActivity` (時計逆走) は sinceMs=0 として扱う。
 */
export function describeStallStatus(input: {
  lastActivityAt: string;
  stallTimeoutMs: number;
  now: Date;
}): StallStatus {
  const { stallTimeoutMs, now } = input;
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) return { kind: 'disabled' };
  const lastMs = Date.parse(input.lastActivityAt);
  if (!Number.isFinite(lastMs)) return { kind: 'disabled' };
  const sinceMs = Math.max(0, now.getTime() - lastMs);
  if (sinceMs >= stallTimeoutMs) {
    return { kind: 'stalled', overdueMs: sinceMs - stallTimeoutMs, sinceMs };
  }
  return { kind: 'live', remainingMs: stallTimeoutMs - sinceMs, sinceMs };
}

/**
 * `--once` モードで stdout に書く human-readable text。
 * 空行 1 つで section を区切る。
 */
export function formatSnapshotForOnce(input: {
  host: string;
  port: number;
  snapshot: StateSnapshot;
  /** stall 残時間の算出基準。`--once` 実行時の現在時刻 */
  now?: Date;
}): string {
  const { host, port, snapshot } = input;
  const now = input.now ?? new Date();
  const stallTimeoutMs = snapshot.agent?.stall_timeout_ms ?? 0;
  const lines: string[] = [];

  lines.push(`host=${host} port=${port}`);
  lines.push(`started_at=${snapshot.started_at} uptime=${formatUptimeMs(snapshot.uptime_ms)}`);
  lines.push(
    `polling.interval_ms=${snapshot.polling.interval_ms} polling.last_tick_at=${formatNullable(
      snapshot.polling.last_tick_at,
    )}`,
  );
  lines.push(`agent.stall_timeout_ms=${stallTimeoutMs}`);

  lines.push('');
  if (snapshot.running.length === 0) {
    lines.push('running: (none)');
  } else {
    lines.push('running:');
    for (const entry of snapshot.running) {
      const row = formatRunningRow(entry);
      const stall = describeStallStatus({
        lastActivityAt: entry.last_activity_at,
        stallTimeoutMs,
        now,
      });
      lines.push(
        `  ${row.issue} branch=${row.branch} started_at=${row.startedAt} slot=${row.slot} retry=${row.retryAttempt} last_activity_at=${row.lastActivityAt} stall=${formatStallForOnce(stall)} watchdog=${row.watchdog}`,
      );
    }
  }

  lines.push('');
  lines.push('totals:');
  lines.push(
    `  runs_completed=${snapshot.totals.runs_completed} runs_succeeded=${snapshot.totals.runs_succeeded} runs_failed=${snapshot.totals.runs_failed} total_cost_usd=${snapshot.totals.total_cost_usd}`,
  );

  lines.push('');
  appendSchedulerLines(lines, snapshot.scheduler);

  lines.push('');
  appendRetryQueueLines(lines, snapshot.retry_queue, now);

  return `${lines.join('\n')}\n`;
}

function formatStallForOnce(stall: StallStatus): string {
  if (stall.kind === 'disabled') return 'disabled';
  if (stall.kind === 'stalled') return `STALLED+${formatDurationMsShort(stall.overdueMs)}`;
  return `in ${formatDurationMsShort(stall.remainingMs)}`;
}

function appendRetryQueueLines(
  lines: string[],
  retryQueue: RetryQueueStateJson | null | undefined,
  now: Date,
): void {
  if (retryQueue === undefined) {
    lines.push('retry_queue: (not provided by daemon)');
    return;
  }
  if (retryQueue === null) {
    lines.push('retry_queue: (disabled)');
    return;
  }
  if (retryQueue.entries.length === 0) {
    lines.push(
      `retry_queue (0): max_attempts=${retryQueue.max_attempts} max_backoff_ms=${retryQueue.max_backoff_ms}`,
    );
    return;
  }
  lines.push(
    `retry_queue (${retryQueue.size}): max_attempts=${retryQueue.max_attempts} max_backoff_ms=${retryQueue.max_backoff_ms}`,
  );
  for (const entry of retryQueue.entries) {
    const due = formatRetryDueIn(entry.due_at, now);
    const reason = entry.failure_reason === null ? 'reason=-' : `reason=${entry.failure_reason}`;
    lines.push(
      `  #${entry.issue_number} kind=${entry.kind} attempt=${entry.attempt} ${reason} due_at=${entry.due_at} (${due}) branch=${entry.branch} workspace_path=${entry.workspace_path} last_run_id=${entry.last_run_id}`,
    );
  }
}

function formatRetryDueIn(dueAtIso: string, now: Date): string {
  const dueMs = Date.parse(dueAtIso);
  if (!Number.isFinite(dueMs)) return 'unknown';
  const diffMs = dueMs - now.getTime();
  if (diffMs <= 0) return `overdue ${formatDurationMsShort(-diffMs)}`;
  return `in ${formatDurationMsShort(diffMs)}`;
}

function appendSchedulerLines(
  lines: string[],
  scheduler: SchedulerStateJson | null | undefined,
): void {
  if (scheduler === undefined) {
    lines.push('scheduler: (not provided by daemon)');
    return;
  }
  if (scheduler === null) {
    lines.push('scheduler: (not evaluated yet)');
    return;
  }

  lines.push(`scheduler: last_evaluated_at=${scheduler.last_evaluated_at}`);
  if (scheduler.ready.length === 0) {
    lines.push('  ready (0)');
  } else {
    lines.push(
      `  ready (${scheduler.ready.length}): ${scheduler.ready.map((r) => `#${r.issue_number}`).join(', ')}`,
    );
  }

  if (scheduler.blocked.length === 0) {
    lines.push('  blocked (0)');
  } else {
    lines.push(`  blocked (${scheduler.blocked.length}):`);
    for (const b of scheduler.blocked) {
      const by = b.blocked_by.map((n) => `#${n}`).join(', ');
      lines.push(`    #${b.issue_number} blocked_by=${by}`);
    }
  }

  if (scheduler.cycles.length === 0) {
    lines.push('  cycles (0)');
  } else {
    lines.push(`  cycles (${scheduler.cycles.length}):`);
    for (const c of scheduler.cycles) {
      const items = c.issue_numbers.map((n) => `#${n}`).join(', ');
      lines.push(`    [${items}]`);
    }
  }

  if (scheduler.invalid_dependencies.length === 0) {
    lines.push('  invalid (0)');
  } else {
    lines.push(`  invalid (${scheduler.invalid_dependencies.length}):`);
    for (const d of scheduler.invalid_dependencies) {
      lines.push(`    #${d.issue_number}`);
      for (const e of d.entries) {
        const tail = e.message !== undefined ? ` message=${e.message}` : '';
        lines.push(`      raw=${e.raw} reason=${e.reason}${tail}`);
      }
    }
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatNullable(value: string | null): string {
  return value === null ? '(never)' : value;
}
