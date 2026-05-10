import type { StateSnapshot } from '../server/index.js';

/**
 * Snapshot を表示用文字列へ変換する pure helper。
 * Ink を import せずに unit test できるよう分離してある。
 *
 * spec: docs/specs/dashboard.md
 */

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
} {
  return {
    issue: `#${entry.issue_number}`,
    branch: entry.branch,
    slot: entry.slot === null ? '-' : String(entry.slot),
    startedAt: entry.started_at,
  };
}

/**
 * `--once` モードで stdout に書く human-readable text。
 * 空行 1 つで section を区切る。
 */
export function formatSnapshotForOnce(input: {
  host: string;
  port: number;
  snapshot: StateSnapshot;
}): string {
  const { host, port, snapshot } = input;
  const lines: string[] = [];

  lines.push(`host=${host} port=${port}`);
  lines.push(`started_at=${snapshot.started_at} uptime=${formatUptimeMs(snapshot.uptime_ms)}`);
  lines.push(
    `polling.interval_ms=${snapshot.polling.interval_ms} polling.last_tick_at=${formatNullable(
      snapshot.polling.last_tick_at,
    )}`,
  );

  lines.push('');
  if (snapshot.running.length === 0) {
    lines.push('running: (none)');
  } else {
    lines.push('running:');
    for (const entry of snapshot.running) {
      const row = formatRunningRow(entry);
      lines.push(
        `  ${row.issue} branch=${row.branch} started_at=${row.startedAt} slot=${row.slot}`,
      );
    }
  }

  lines.push('');
  lines.push('totals:');
  lines.push(
    `  runs_completed=${snapshot.totals.runs_completed} runs_succeeded=${snapshot.totals.runs_succeeded} runs_failed=${snapshot.totals.runs_failed} total_cost_usd=${snapshot.totals.total_cost_usd}`,
  );

  return `${lines.join('\n')}\n`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatNullable(value: string | null): string {
  return value === null ? '(never)' : value;
}
