import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger/index.js';
import type { RunLogStatus } from '../runlog/index.js';
import type { RunningEntry, RunningWatchdog, RunTracker } from '../server/tracker.js';

import type { FailureReason } from './errors.js';

/**
 * Active run の孤児化を検出する watchdog (#105)。
 *
 * - tracker が running と認識している entry を走査して、
 *   1. **terminal repair**: run dir に metadata.json (status: success / failed) が既にあれば
 *      `runFinished` をべき等に呼んで tracker から外す
 *   2. **orphaned**: runner pid が ESRCH (= プロセス消失) なら marker を付ける
 *   3. **stale**: stdout 無音時間が `agent.stall_timeout_ms * 2` を超えたら marker を付ける
 * - 誤検知で active runner / open PR / unsafe worktree を kill / cleanup しない
 *   (Issue #105「今回やらない」: pid 消失だけで自動 cleanup / retry はしない)
 *
 * spec: docs/specs/serve-daemon.md#active-run-watchdog-105
 */

export type WatchdogReason = 'orphaned' | 'stale';

export type WatchdogRepair = {
  runId: string;
  issueNumber: number;
  status: RunLogStatus;
  failureReason: FailureReason | null;
  totalCostUsd: number | null;
};

export type WatchdogMarker = {
  runId: string;
  issueNumber: number;
  reasons: ReadonlyArray<WatchdogReason>;
  orphanedSince: string | null;
  staleSince: string | null;
};

export type WatchdogResult = {
  repaired: ReadonlyArray<WatchdogRepair>;
  markers: ReadonlyArray<WatchdogMarker>;
};

export type RunWatchdogDeps = {
  tracker: RunTracker;
  /** runner stall_timeout 設定。0 / 不正値なら stale 判定 off */
  stallTimeoutMs: number;
  /** 現在時刻 (テスト用に DI 可) */
  now?: Date;
  /** logger (構造化ログ。省略可) */
  logger?: Logger;
  /**
   * `<runLogPath>/metadata.json` を読んで terminal metadata を返す。テストで差し替え可能。
   * 未指定なら fs.readFile + JSON.parse の default 実装を使う。
   *
   * - 返り値が null: metadata 未存在 / 不正 (= まだ terminal でない)
   * - 例外を throw する: caller が握って warn ログを出して repair を skip する
   */
  readMetadata?: (runLogPath: string) => Promise<RunMetadataSnapshot | null>;
  /**
   * runner pid が alive かどうかを判定する。`process.kill(pid, 0)` の wrapper。
   * ESRCH なら `false`、それ以外の例外 (EPERM 等) は `true` 扱い (= 自分が触れない他人 process は
   * `alive` とみなす — pid 再利用された他プロセスを誤って dead と判定しないため)。
   * テストで差し替え可能。
   */
  processAlive?: (pid: number) => boolean;
};

export type RunMetadataSnapshot = {
  status: RunLogStatus;
  failureReason: FailureReason | null;
  totalCostUsd: number | null;
};

const DEFAULT_READ_METADATA = async (runLogPath: string): Promise<RunMetadataSnapshot | null> => {
  const filePath = path.join(runLogPath, 'metadata.json');
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  return parseRunMetadata(content);
};

const DEFAULT_PROCESS_ALIVE = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') return false;
    // EPERM 等は alive (他人 process / 触れない) として扱い、orphaned 判定を出さない。
    return true;
  }
};

/**
 * watchdog 1 回分の実行。serveLoop の poll tick から piggyback で呼ばれる。
 *
 * 純度の高い手続きとしてまとめてあるが、tracker.runFinished / tracker.setWatchdog という
 * 副作用を持つ。tracker / readMetadata / processAlive は全て DI 可能。
 */
export async function runWatchdog(deps: RunWatchdogDeps): Promise<WatchdogResult> {
  const tracker = deps.tracker;
  const now = deps.now ?? new Date();
  const stallTimeoutMs = deps.stallTimeoutMs;
  const readMetadata = deps.readMetadata ?? DEFAULT_READ_METADATA;
  const processAlive = deps.processAlive ?? DEFAULT_PROCESS_ALIVE;

  const repaired: WatchdogRepair[] = [];
  const markers: WatchdogMarker[] = [];

  for (const entry of tracker.listRunning()) {
    // 1. terminal repair: metadata.json があり status が success / failed なら repair する。
    let metadata: RunMetadataSnapshot | null = null;
    try {
      metadata = await readMetadata(entry.runLogPath);
    } catch (error) {
      deps.logger?.warn('watchdog metadata read failed', {
        runId: entry.runId,
        issueNumber: entry.issueNumber,
        runLogPath: entry.runLogPath,
        error: describeError(error),
      });
      // repair は skip (次 tick で再試行)。orphaned / stale 判定はそのまま続ける。
    }

    if (metadata !== null) {
      tracker.runFinished(toRunFinished(entry, metadata));
      const repair: WatchdogRepair = {
        runId: entry.runId,
        issueNumber: entry.issueNumber,
        status: metadata.status,
        failureReason: metadata.failureReason,
        totalCostUsd: metadata.totalCostUsd,
      };
      repaired.push(repair);
      deps.logger?.info('watchdog terminal repair', {
        runId: repair.runId,
        issueNumber: repair.issueNumber,
        status: repair.status,
        failureReason: repair.failureReason,
        runLogPath: entry.runLogPath,
      });
      continue;
    }

    // 2. orphaned / stale 判定 (terminal でない entry のみ)
    const reasons: WatchdogReason[] = [];

    let orphaned = false;
    if (entry.runnerPid !== null && !processAlive(entry.runnerPid)) {
      reasons.push('orphaned');
      orphaned = true;
    }

    let stale = false;
    if (Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0) {
      const lastActivityMs = Date.parse(entry.lastActivityAt);
      if (Number.isFinite(lastActivityMs)) {
        const idleMs = Math.max(0, now.getTime() - lastActivityMs);
        if (idleMs > stallTimeoutMs * 2) {
          reasons.push('stale');
          stale = true;
        }
      }
    }

    const orphanedSince = computeSince(entry.watchdog?.orphanedSince ?? null, orphaned, now);
    const staleSince = computeSince(entry.watchdog?.staleSince ?? null, stale, now);

    if (reasons.length === 0) {
      if (entry.watchdog !== null) {
        tracker.setWatchdog(entry.runId, null);
      }
      continue;
    }

    const watchdog: RunningWatchdog = {
      reasons,
      orphanedSince,
      staleSince,
    };
    tracker.setWatchdog(entry.runId, watchdog);
    markers.push({
      runId: entry.runId,
      issueNumber: entry.issueNumber,
      reasons,
      orphanedSince,
      staleSince,
    });

    if (entry.watchdog === null || !sameReasons(entry.watchdog.reasons, reasons)) {
      // marker 状態が初出 or 切り替わった瞬間にだけ 1 度 warn を出す (毎 tick の連続出力を避ける)
      deps.logger?.warn('watchdog marker', {
        runId: entry.runId,
        issueNumber: entry.issueNumber,
        reasons,
        orphanedSince,
        staleSince,
        runnerPid: entry.runnerPid,
        lastActivityAt: entry.lastActivityAt,
      });
    }
  }

  return { repaired, markers };
}

function toRunFinished(
  entry: RunningEntry,
  metadata: RunMetadataSnapshot,
):
  | { kind: 'success'; runId: string; issueNumber: number; totalCostUsd: number | null }
  | {
      kind: 'failed';
      runId: string;
      issueNumber: number;
      reason: FailureReason;
      totalCostUsd: number | null;
    } {
  if (metadata.status === 'success') {
    return {
      kind: 'success',
      runId: entry.runId,
      issueNumber: entry.issueNumber,
      totalCostUsd: metadata.totalCostUsd,
    };
  }
  return {
    kind: 'failed',
    runId: entry.runId,
    issueNumber: entry.issueNumber,
    reason: metadata.failureReason ?? 'runner_error',
    totalCostUsd: metadata.totalCostUsd,
  };
}

function computeSince(prev: string | null, active: boolean, now: Date): string | null {
  if (!active) return null;
  if (prev !== null) return prev;
  return now.toISOString();
}

function sameReasons(a: ReadonlyArray<WatchdogReason>, b: ReadonlyArray<WatchdogReason>): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const r of b) if (!setA.has(r)) return false;
  return true;
}

function parseRunMetadata(content: string): RunMetadataSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const status = obj['status'];
  if (status !== 'success' && status !== 'failed') return null;
  const failureReason = obj['failure_reason'];
  const totalCostUsd = obj['total_cost_usd'];
  return {
    status,
    failureReason: typeof failureReason === 'string' ? (failureReason as FailureReason) : null,
    totalCostUsd:
      typeof totalCostUsd === 'number' && Number.isFinite(totalCostUsd) ? totalCostUsd : null,
  };
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
