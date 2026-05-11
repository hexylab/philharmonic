import type { FailureReason } from '../orchestrator/errors.js';
import type { ActivityEvent, ActivityKind } from '../runner/stream.js';

/**
 * `philharmonic serve` の in-memory run tracker。
 *
 * - `runStarted` で in-flight に積み、`runFinished` で外す & totals を更新する
 * - daemon プロセス起動以降の累計のみを保持する (再起動で消える)
 * - HTTP API (#30) 専用。ログや永続化には関与しない
 *
 * spec: docs/specs/snapshot-api.md
 */

export type RunningRetryAttempt = {
  kind: 'failure' | 'continuation';
  attempt: number;
};

/**
 * watchdog (#105) が `running entry` に付ける marker。
 *
 * - `orphaned`: runner pid が消失している (process.kill(pid, 0) が ESRCH)。pid 未記録なら判定しない
 * - `stale`: runner stdout 無音時間が `agent.stall_timeout_ms * 2` を超えている。
 *   runner 自身の stall 検出 (= stallTimeoutMs 経過で SIGTERM) を超えても tracker から消えていない異常を捕まえる
 *
 * watchdog 本体 (`runWatchdog`) は marker 表示と terminal repair のみで、kill / cleanup / retry
 * dispatch は行わない。orphaned + stale が同時に立つ場合に限り、後段の `recoverOrphaned` (#109)
 * が安全条件を確認したうえで retry queue / Failed safety-net へ接続する。自動 recovery しない
 * ケースでは `operatorActionRequired: true` を立てて理由 (`operatorActionReasons`) を残す。
 */
export type RunningWatchdog = {
  reasons: ReadonlyArray<'orphaned' | 'stale'>;
  /** 初めて orphaned 判定に切り替わった時刻 (ISO 8601)。reasons に `orphaned` が含まれない間は null */
  orphanedSince: string | null;
  /** 初めて stale 判定に切り替わった時刻 (ISO 8601)。reasons に `stale` が含まれない間は null */
  staleSince: string | null;
  /**
   * 安全条件を満たさず自動 recovery を諦め、運用者の手動 intervention 待ちであることを示す flag (#109)。
   * `false` のときは「まだ評価中」または「次 tick で recover される予定」のいずれか。
   */
  operatorActionRequired: boolean;
  /**
   * `operatorActionRequired` が立った具体的な理由 (複合可)。dashboard / Snapshot API に表示する。
   *
   * - `orphaned_only`: pid だけ消失。activity 停止が確認できていないため tool/advisor wait の誤判定リスク
   * - `stale_only`: stallTimeoutMs * 2 超えで活動停止だが pid は生存。Claude の長期 wait の可能性
   * - `open_pr`: agent が PR を立てた後で死亡した稀ケース。worktree wipe を避ける
   * - `retry_disabled`: retry queue 未注入 / `agent.max_retry_attempts == 0` のため出口無し
   * - `unsafe_workspace_path`: workspace path が workspaceRoot 配下でない
   * - `recover_error`: orphan-recovery 中に想定外の throw が出た
   */
  operatorActionReasons: ReadonlyArray<OperatorActionReason>;
};

/**
 * Running agent の現在 activity (#98)。
 *
 * - runner stdout の stream event 種別を機械的に分類した値のみを保持する (raw payload や prompt は保持しない)
 * - `kind` は `runner/stream.ts` の `ActivityKind` (`starting` / `assistant` / `tool_use` / `result`)
 * - `toolName` は `tool_use` のときだけ非 null。それ以外の kind では常に null
 * - `updatedAt` は activity を最後に更新した時刻 (ISO 8601)。dashboard 側で `now - updatedAt` から
 *   "waiting / no recent activity" を派生表示する
 *
 * `lastActivityAt` (stall detection 用 chunk-level timestamp) とは分けて持つ。chunk が来ても
 * 分類対象外 event (system / user / parse_error) なら activity は更新しない。
 */
export type RunningActivity = {
  kind: ActivityKind;
  toolName: string | null;
  updatedAt: string;
};

export type OperatorActionReason =
  | 'orphaned_only'
  | 'stale_only'
  | 'open_pr'
  | 'retry_disabled'
  | 'unsafe_workspace_path'
  | 'recover_error';

export type RunningEntry = {
  runId: string;
  issueNumber: number;
  branch: string;
  startedAt: string;
  slot: number | null;
  /**
   * stdout から最後に chunk を受け取った時刻 (ISO 8601)。runner が一度も output を
   * 出していなければ `startedAt` と同じ値を保持する (#87)。stalled 判定残時間の参照点。
   */
  lastActivityAt: string;
  /** 直前 attempt が retry 起源 (failure / continuation) のとき非 null。fresh dispatch は null */
  retryAttempt: RunningRetryAttempt | null;
  /**
   * watchdog (#105) 用に、dispatchSelected が見込みで計算した worktree path。
   * `<workspaceRoot>/issue-<issueNumber>` (workspaceManager.resolveWorkspacePath で算出)。
   */
  workspacePath: string;
  /** watchdog (#105) 用に runlog dir (`<runnerLogsRoot>/<runId>`) */
  runLogPath: string;
  /**
   * runner subprocess の pid (process group leader)。runClaude が spawn した直後に
   * `recordRunnerProcess` で登録される。spawn 失敗 / pid 未到達のときは null。
   * watchdog の orphaned 判定は pid !== null のときのみ走る (#105)。
   */
  runnerPid: number | null;
  /** watchdog (#105) の最新判定結果。1 度も判定が走っていなければ null */
  watchdog: RunningWatchdog | null;
  /**
   * 直近に観測された runner activity (#98)。`runStarted` で `starting` を初期値として
   * 入れるため常に非 null。
   */
  activity: RunningActivity;
};

export type Totals = {
  runsCompleted: number;
  runsSucceeded: number;
  runsFailed: number;
  totalCostUsd: number;
};

export type RunStartedInput = {
  runId: string;
  issueNumber: number;
  branch: string;
  startedAt: Date;
  slot?: number | null;
  retryAttempt?: RunningRetryAttempt | null;
  /** watchdog (#105) で run 状態を再構築するための worktree path */
  workspacePath: string;
  /** watchdog (#105) で terminal metadata.json を読みに行くための runlog dir */
  runLogPath: string;
};

export type RunFinishedSuccess = {
  kind: 'success';
  runId: string;
  issueNumber: number;
  totalCostUsd: number | null;
};

export type RunFinishedFailed = {
  kind: 'failed';
  runId: string;
  issueNumber: number;
  reason: FailureReason;
  totalCostUsd: number | null;
};

export type RunFinishedInput = RunFinishedSuccess | RunFinishedFailed;

export type RunTracker = {
  runStarted(input: RunStartedInput): void;
  runFinished(input: RunFinishedInput): void;
  /**
   * runner stdout に新しい chunk が届いた時刻を記録する。runner subprocess の onActivity
   * callback から駆動する (#87)。runId が in-flight でなければ no-op。
   */
  recordActivity(runId: string, at: Date): void;
  /**
   * runner stdout の stream event を classify した activity を記録する (#98)。runner subprocess の
   * onActivityEvent callback から駆動する。activity に影響しない event (system / user 等) は
   * 呼ばないため、`recordActivity` (chunk-level) と切り分けて持つ。
   *
   * runId が in-flight でなければ no-op (べき等)。
   */
  recordActivityEvent(runId: string, event: ActivityEvent, at: Date): void;
  /**
   * runner subprocess が spawn された直後に pid を記録する (#105)。runId が in-flight で
   * なければ no-op。同じ runId に対して複数回呼ばれた場合は最後の値で上書きする (multi-turn
   * runner で 2 ターン目に新 pid に切り替わるケースを許容するため)。
   */
  recordRunnerProcess(runId: string, pid: number): void;
  /**
   * watchdog (#105) が判定結果を tracker に書き戻す。`reasons` が空配列なら marker を
   * 全消ししたい意図として扱い、`watchdog` を null に戻す。runId が in-flight でなければ no-op。
   *
   * `orphanedSince` / `staleSince` は呼び出し側が「初出時刻」を保持して渡す。tracker 側は
   * 値を保存するだけで、reasons との整合は呼び出し側の責任。
   */
  setWatchdog(runId: string, watchdog: RunningWatchdog | null): void;
  listRunning(): RunningEntry[];
  getRunningByIssue(issueNumber: number): RunningEntry | null;
  getTotals(): Totals;
  recordPollTick(at: Date): void;
  getLastPollTickAt(): string | null;
  getStartedAt(): string;
};

export type CreateRunTrackerOptions = {
  startedAt?: Date;
};

export function createRunTracker(options: CreateRunTrackerOptions = {}): RunTracker {
  const startedAt = (options.startedAt ?? new Date()).toISOString();
  const running = new Map<string, RunningEntry>();
  const totals: Totals = {
    runsCompleted: 0,
    runsSucceeded: 0,
    runsFailed: 0,
    totalCostUsd: 0,
  };
  let lastPollTickAt: string | null = null;

  return {
    runStarted(input) {
      const startedAtIso = input.startedAt.toISOString();
      running.set(input.runId, {
        runId: input.runId,
        issueNumber: input.issueNumber,
        branch: input.branch,
        startedAt: startedAtIso,
        slot: input.slot ?? null,
        lastActivityAt: startedAtIso,
        retryAttempt: input.retryAttempt ?? null,
        workspacePath: input.workspacePath,
        runLogPath: input.runLogPath,
        runnerPid: null,
        watchdog: null,
        activity: { kind: 'starting', toolName: null, updatedAt: startedAtIso },
      });
    },
    recordActivity(runId, at) {
      const entry = running.get(runId);
      if (entry === undefined) return;
      running.set(runId, { ...entry, lastActivityAt: at.toISOString() });
    },
    recordActivityEvent(runId, event, at) {
      const entry = running.get(runId);
      if (entry === undefined) return;
      running.set(runId, {
        ...entry,
        activity: { kind: event.kind, toolName: event.toolName, updatedAt: at.toISOString() },
      });
    },
    recordRunnerProcess(runId, pid) {
      const entry = running.get(runId);
      if (entry === undefined) return;
      running.set(runId, { ...entry, runnerPid: pid });
    },
    setWatchdog(runId, watchdog) {
      const entry = running.get(runId);
      if (entry === undefined) return;
      const next = watchdog === null || watchdog.reasons.length === 0 ? null : watchdog;
      running.set(runId, { ...entry, watchdog: next });
    },
    runFinished(input) {
      if (!running.has(input.runId)) {
        // 防御的: 既に runFinished 済み (markFailed 経路 + finally の二重発火等) は no-op
        return;
      }
      running.delete(input.runId);
      totals.runsCompleted += 1;
      if (input.kind === 'success') totals.runsSucceeded += 1;
      else totals.runsFailed += 1;
      if (typeof input.totalCostUsd === 'number' && Number.isFinite(input.totalCostUsd)) {
        totals.totalCostUsd += input.totalCostUsd;
      }
    },
    listRunning() {
      return Array.from(running.values()).sort((a, b) => a.issueNumber - b.issueNumber);
    },
    getRunningByIssue(issueNumber) {
      for (const entry of running.values()) {
        if (entry.issueNumber === issueNumber) return entry;
      }
      return null;
    },
    getTotals() {
      return { ...totals };
    },
    recordPollTick(at) {
      lastPollTickAt = at.toISOString();
    },
    getLastPollTickAt() {
      return lastPollTickAt;
    },
    getStartedAt() {
      return startedAt;
    },
  };
}

export const noopRunTracker: RunTracker = {
  runStarted: () => {},
  runFinished: () => {},
  recordActivity: () => {},
  recordActivityEvent: () => {},
  recordRunnerProcess: () => {},
  setWatchdog: () => {},
  listRunning: () => [],
  getRunningByIssue: () => null,
  getTotals: () => ({
    runsCompleted: 0,
    runsSucceeded: 0,
    runsFailed: 0,
    totalCostUsd: 0,
  }),
  recordPollTick: () => {},
  getLastPollTickAt: () => null,
  getStartedAt: () => new Date(0).toISOString(),
};
