import { stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '../config/index.js';
import {
  evaluateDependencyDag,
  type EvaluatedCandidate,
  type FetchDependencyIssue,
} from '../dependency/index.js';
import type { GitHubClient, Issue } from '../github/index.js';
import type { Logger } from '../logger/index.js';
import type { Candidate, ProjectsClient } from '../projects/index.js';
import type { GhRunner } from '../projects/status-update.js';
import {
  createRunLog,
  generateRunId,
  writeMetadata,
  writeSummary,
  type RunLog,
  type RunLogStatus,
} from '../runlog/index.js';
import { runClaude, type RunResult } from '../runner/index.js';
import { noopDependencyTracker, type DependencyTracker } from '../server/dependency-tracker.js';
import { noopRunTracker, type RunTracker } from '../server/tracker.js';
import type { WorkflowSource } from '../workflow/index.js';
import {
  defaultGitRunner,
  HookExecutionError,
  HookTimeoutError,
  type GitRunner,
  type HookContext,
  type WorkspaceManager,
} from '../workspace/index.js';

import { createDependencyIssueFetcher, logDependencyEvaluation } from './dependency-filter.js';
import { type FailureReason } from './errors.js';
import {
  notifyFailureExhausted as defaultNotifyFailureExhausted,
  type ExhaustionNotifyInput,
  type ExhaustionNotifyResult,
} from './exhaustion-notify.js';
import {
  resolveFailureSummaryPath,
  writeFailureSummary,
  type FailureSummaryInput,
} from './failure-summary.js';
import { fetchBaseBranch } from './git.js';
import { dispatchPool } from './pool.js';
import { parseRepositoryNameWithOwner, type Repository } from './repository.js';
import { type RetryEntry, type RetryKind, type RetryQueue } from './retry-queue.js';
import {
  checkDispatchGuard,
  DEFAULT_DISPATCH_STATUSES,
  isAcceptableIssue,
  type DispatchGuard,
  type DispatchGuardSkipReason,
} from './select.js';
import { buildIssueSlug } from './slug.js';

export type RunOnceClock = () => Date;

const DEFAULT_REMOTE = 'origin';

export type RunOnceDeps = {
  config: Config;
  repoRoot: string;
  githubClient: GitHubClient;
  projectsClient: ProjectsClient;
  workspaceManager: WorkspaceManager;
  workflowSource: WorkflowSource;
  runnerLogsRoot: string;
  dispatchStatuses?: readonly string[];
  runClaude?: typeof runClaude;
  /** workspace 作成前に `git fetch <remote> <baseBranch>` を実行する git runner */
  gitRunner?: GitRunner;
  /** fetch 先 remote 名 (default: `origin`) */
  remote?: string;
  logger?: Logger;
  clock?: RunOnceClock;
  generateRunId?: () => string;
  /** snapshot HTTP API (#30) 用の in-memory tracker。未指定なら no-op */
  runTracker?: RunTracker;
  /**
   * 二重 dispatch ガードに使う path 存在判定 (テストで差し替え可能)。未指定なら fs.stat。
   */
  pathExists?: (target: string) => Promise<boolean>;
  /**
   * dependency filter (ADR-0007) で candidate body 外の依存先 Issue を取得する fetcher。
   *
   * 未指定なら GitHubClient を使った default 実装を `selectAcceptableCandidates` 内で組み立てる
   * (cross-repo 依存は parser-invalid で弾かれる前提のため、最初の acceptable candidate の repo を流用)。
   */
  fetchDependencyIssue?: FetchDependencyIssue;
  /**
   * Snapshot HTTP API (#80) 用の DAG-aware scheduler tracker。
   * `evaluateDependencyDag` の結果を per-tick で 1 度だけ差し替える。未指定なら no-op。
   */
  dependencyTracker?: DependencyTracker;
  /**
   * 失敗 / stalled run を指数バックオフで自動再 dispatch する in-memory queue (#84 / ADR-0008)。
   * 未指定なら retry 機能 off。`maxRetryAttempts == 0` でも実質 off になる
   */
  retryQueue?: RetryQueue;
  /** retry 上限 (1 つの Issue が retry queue に積み直される最大回数)。default 0 (= 機能 off) */
  maxRetryAttempts?: number;
  /** retry backoff の clamp 上限 (ms)。default 300_000 */
  maxRetryBackoffMs?: number;
  /**
   * `kind=failure` の retry が exhausted した瞬間に GitHub Projects Status を `Failed` に倒し、
   * Issue にコメントを残す safety-net (ADR-0010 / #103)。
   *
   * - `serve` では `defaultGhRunner` を渡して `gh project item-edit` / `gh issue comment` を実行する
   * - `philharmonic run` (1 ターン CLI) や retry queue 未注入のテストでは省略すると no-op
   */
  runGh?: GhRunner;
  /**
   * テストで差し替え可能な exhaustion notify 関数。`runGh` と同時に省略すると no-op。
   *
   * `runGh` のみ渡せば本モジュール内 default の `notifyFailureExhausted` を使う。
   */
  notifyFailureExhausted?: NotifyFailureExhaustedFn;
};

export type NotifyFailureExhaustedFn = (
  input: ExhaustionNotifyInput,
) => Promise<ExhaustionNotifyResult>;

export type RunOnceResult =
  | { kind: 'no_candidate' }
  | {
      kind: 'success';
      runId: string;
      issueNumber: number;
      branch: string;
    }
  | {
      kind: 'failed';
      runId: string;
      issueNumber: number;
      reason: FailureReason;
      branch: string | null;
      /**
       * 失敗時のエラー詳細 (先頭 500 文字)。retry queue / snapshot の `last_error_summary` で使う。
       * 構造化ログには `markFailed` が `detail` field として既に出している。
       */
      errorSummary: string | null;
    };

const noopLogger: Logger = {
  level: 'info',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

const DEFAULT_PATH_EXISTS = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

export async function runOnce(deps: RunOnceDeps): Promise<RunOnceResult> {
  const baseLogger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? (() => new Date());
  const dispatchStatuses =
    deps.dispatchStatuses ?? deps.config.dispatchStatuses ?? DEFAULT_DISPATCH_STATUSES;
  const tracker = deps.runTracker ?? noopRunTracker;
  const pathExists = deps.pathExists ?? DEFAULT_PATH_EXISTS;

  const guard: DispatchGuard = {
    workspaceExists: async (issueNumber) =>
      pathExists(deps.workspaceManager.resolveWorkspacePath(`issue-${issueNumber}`)),
    isRunning: (issueNumber) => tracker.getRunningByIssue(issueNumber) !== null,
    inRetryQueue: (issueNumber) => deps.retryQueue?.has(issueNumber) ?? false,
  };

  // 1. Retry queue drain (#84 / ADR-0008): due な entry を 1 件だけ取り出して dispatch する。
  const retryTasks = await drainRetryQueue({
    retryQueue: deps.retryQueue,
    limit: 1,
    githubClient: deps.githubClient,
    projectsClient: deps.projectsClient,
    workspaceManager: deps.workspaceManager,
    config: deps.config,
    dispatchStatuses,
    runTracker: tracker,
    logger: baseLogger,
    clock,
  });

  // single-task success continuation 用に candidates を 1 度だけ取得する resolver。
  // memoize しないと runOnce 内では 1 回しか呼ばれないため単純な closure で十分。
  const resolveContinuationCandidates = makeContinuationCandidatesResolver({
    projectsClient: deps.projectsClient,
    config: deps.config,
    logger: baseLogger,
  });

  const notifyFailureExhaustedFn = resolveNotifyFailureExhausted(deps, baseLogger);

  if (retryTasks.length > 0) {
    const task = retryTasks[0]!;
    const result = await dispatchSelected({
      config: deps.config,
      repoRoot: deps.repoRoot,
      candidate: task.candidate,
      issue: task.issue,
      repository: task.repository,
      workspaceManager: deps.workspaceManager,
      workflowSource: deps.workflowSource,
      runnerLogsRoot: deps.runnerLogsRoot,
      runClaude: deps.runClaude,
      gitRunner: deps.gitRunner,
      remote: deps.remote,
      baseLogger,
      clock,
      generateRunId: deps.generateRunId,
      runTracker: tracker,
      retryAttempt: dispatchTaskToRetryAttempt(task),
    });
    await processDispatchResultForRetry({
      task,
      result,
      retryQueue: deps.retryQueue,
      maxRetryAttempts: deps.maxRetryAttempts ?? 0,
      maxRetryBackoffMs: deps.maxRetryBackoffMs ?? 0,
      runnerLogsRoot: deps.runnerLogsRoot,
      config: deps.config,
      dispatchStatuses,
      logger: baseLogger,
      clock,
      resolveWorkspacePath: (t) =>
        deps.workspaceManager.resolveWorkspacePath(`issue-${t.candidate.issueNumber}`),
      resolveContinuationCandidates,
      notifyFailureExhausted: notifyFailureExhaustedFn,
    });
    return result;
  }

  // 2. Candidate Selection (orchestration-mvp.md「Candidate Selection Rule」)
  const candidates = await deps.projectsClient.fetchProjectCandidates({
    owner: deps.config.owner,
    projectNumber: deps.config.projectNumber,
    statusFieldName: deps.config.statusField,
  });
  const selected = await selectAcceptableCandidate({
    candidates,
    dispatchStatuses,
    githubClient: deps.githubClient,
    agentUserLogin: deps.config.agentUserLogin,
    logger: baseLogger,
    guard,
    fetchDependencyIssue: deps.fetchDependencyIssue,
    dependencyTracker: deps.dependencyTracker,
    clock,
  });
  if (selected === null) {
    baseLogger.info('no candidate', { dispatchStatuses });
    return { kind: 'no_candidate' };
  }

  const result = await dispatchSelected({
    config: deps.config,
    repoRoot: deps.repoRoot,
    candidate: selected.candidate,
    issue: selected.issue,
    repository: selected.repository,
    workspaceManager: deps.workspaceManager,
    workflowSource: deps.workflowSource,
    runnerLogsRoot: deps.runnerLogsRoot,
    runClaude: deps.runClaude,
    gitRunner: deps.gitRunner,
    remote: deps.remote,
    baseLogger,
    clock,
    generateRunId: deps.generateRunId,
    runTracker: tracker,
    retryAttempt: null,
  });
  await processDispatchResultForRetry({
    task: {
      candidate: selected.candidate,
      issue: selected.issue,
      repository: selected.repository,
      retryAttempt: 0,
      retryFrom: null,
    },
    result,
    retryQueue: deps.retryQueue,
    maxRetryAttempts: deps.maxRetryAttempts ?? 0,
    maxRetryBackoffMs: deps.maxRetryBackoffMs ?? 0,
    runnerLogsRoot: deps.runnerLogsRoot,
    config: deps.config,
    dispatchStatuses,
    logger: baseLogger,
    clock,
    resolveWorkspacePath: (t) =>
      deps.workspaceManager.resolveWorkspacePath(`issue-${t.candidate.issueNumber}`),
    resolveContinuationCandidates,
    notifyFailureExhausted: notifyFailureExhaustedFn,
  });
  return result;
}

export type RunConcurrentDeps = RunOnceDeps & {
  maxConcurrent: number;
};

export type ConcurrentDispatchOutcome = {
  slot: number;
  result: Extract<RunOnceResult, { kind: 'success' | 'failed' }>;
};

/**
 * 1 tick で `maxConcurrent` 件まで並列 dispatch する。
 *
 * spec: docs/specs/serve-daemon.md#並列-dispatch-24
 */
export async function runConcurrent(deps: RunConcurrentDeps): Promise<ConcurrentDispatchOutcome[]> {
  const baseLogger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? (() => new Date());
  const dispatchStatuses =
    deps.dispatchStatuses ?? deps.config.dispatchStatuses ?? DEFAULT_DISPATCH_STATUSES;
  const tracker = deps.runTracker ?? noopRunTracker;
  const pathExists = deps.pathExists ?? DEFAULT_PATH_EXISTS;
  const { maxConcurrent } = deps;

  if (maxConcurrent < 1) {
    throw new Error(`runConcurrent: maxConcurrent must be >= 1 (got ${maxConcurrent})`);
  }

  const guard: DispatchGuard = {
    workspaceExists: async (issueNumber) =>
      pathExists(deps.workspaceManager.resolveWorkspacePath(`issue-${issueNumber}`)),
    isRunning: (issueNumber) => tracker.getRunningByIssue(issueNumber) !== null,
    inRetryQueue: (issueNumber) => deps.retryQueue?.has(issueNumber) ?? false,
  };

  // 1. Retry queue drain (#84 / ADR-0008): due な entry を最大 maxConcurrent 件まで先に消費する。
  const retryTasks = await drainRetryQueue({
    retryQueue: deps.retryQueue,
    limit: maxConcurrent,
    githubClient: deps.githubClient,
    projectsClient: deps.projectsClient,
    workspaceManager: deps.workspaceManager,
    config: deps.config,
    dispatchStatuses,
    runTracker: tracker,
    logger: baseLogger,
    clock,
  });

  // 2. 通常 candidate selection (retry で埋まり切らなかった残り slot 分のみ)
  const freshSlots = Math.max(0, maxConcurrent - retryTasks.length);
  let freshTasks: SelectResult[] = [];
  if (freshSlots > 0) {
    const candidates = await deps.projectsClient.fetchProjectCandidates({
      owner: deps.config.owner,
      projectNumber: deps.config.projectNumber,
      statusFieldName: deps.config.statusField,
    });
    freshTasks = await selectAcceptableCandidates({
      candidates,
      dispatchStatuses,
      githubClient: deps.githubClient,
      agentUserLogin: deps.config.agentUserLogin,
      logger: baseLogger,
      guard,
      limit: freshSlots,
      fetchDependencyIssue: deps.fetchDependencyIssue,
      dependencyTracker: deps.dependencyTracker,
      clock,
    });
  }

  const tasks: DispatchTask[] = [
    ...retryTasks,
    ...freshTasks.map<DispatchTask>((s) => ({
      candidate: s.candidate,
      issue: s.issue,
      repository: s.repository,
      retryAttempt: 0,
      retryFrom: null,
    })),
  ];

  if (tasks.length === 0) {
    baseLogger.info('no candidate', { dispatchStatuses });
    return [];
  }

  baseLogger.info('concurrent tick', {
    maxConcurrent,
    dispatched: tasks.length,
    retries: retryTasks.length,
  });

  type ConcurrentInternalOutcome = ConcurrentDispatchOutcome & { task: DispatchTask };

  const outcomes = await dispatchPool({
    tasks,
    maxConcurrent,
    worker: async (task, slot): Promise<ConcurrentInternalOutcome> => {
      try {
        const result = await dispatchSelected({
          config: deps.config,
          repoRoot: deps.repoRoot,
          candidate: task.candidate,
          issue: task.issue,
          repository: task.repository,
          workspaceManager: deps.workspaceManager,
          workflowSource: deps.workflowSource,
          runnerLogsRoot: deps.runnerLogsRoot,
          runClaude: deps.runClaude,
          gitRunner: deps.gitRunner,
          remote: deps.remote,
          baseLogger,
          clock,
          generateRunId: deps.generateRunId,
          runTracker: tracker,
          slot,
          retryAttempt: dispatchTaskToRetryAttempt(task),
        });
        return { slot, result, task };
      } catch (error) {
        baseLogger.warn('dispatch error', {
          slot,
          issueNumber: task.candidate.issueNumber,
          error: describeError(error),
        });
        return {
          slot,
          result: {
            kind: 'failed',
            runId: 'unknown',
            issueNumber: task.candidate.issueNumber,
            reason: 'runner_error',
            branch: null,
            errorSummary: truncateErrorSummary(describeError(error)),
          },
          task,
        };
      }
    },
  });

  // 同 tick 内の複数 success 全件で fetchProjectCandidates を 1 回に共有する
  // (continuation の Status 再確認が outcome 件数だけ呼び出されるのを防ぐ)。
  const resolveContinuationCandidates = makeContinuationCandidatesResolver({
    projectsClient: deps.projectsClient,
    config: deps.config,
    logger: baseLogger,
  });

  const notifyFailureExhaustedFn = resolveNotifyFailureExhausted(deps, baseLogger);

  for (const { task, result } of outcomes) {
    await processDispatchResultForRetry({
      task,
      result,
      retryQueue: deps.retryQueue,
      maxRetryAttempts: deps.maxRetryAttempts ?? 0,
      maxRetryBackoffMs: deps.maxRetryBackoffMs ?? 0,
      runnerLogsRoot: deps.runnerLogsRoot,
      config: deps.config,
      dispatchStatuses,
      logger: baseLogger,
      clock,
      resolveWorkspacePath: (t) =>
        deps.workspaceManager.resolveWorkspacePath(`issue-${t.candidate.issueNumber}`),
      resolveContinuationCandidates,
      notifyFailureExhausted: notifyFailureExhaustedFn,
    });
  }

  return outcomes.map(({ slot, result }) => ({ slot, result }));
}

export type DispatchSelectedDeps = {
  config: Config;
  repoRoot: string;
  candidate: Candidate;
  issue: Issue;
  repository: Repository;
  workspaceManager: WorkspaceManager;
  workflowSource: WorkflowSource;
  runnerLogsRoot: string;
  runClaude?: typeof runClaude;
  /** workspace 作成前に `git fetch <remote> <baseBranch>` を実行する git runner */
  gitRunner?: GitRunner;
  /** fetch 先 remote 名 (default: `origin`) */
  remote?: string;
  baseLogger?: Logger;
  clock?: RunOnceClock;
  generateRunId?: () => string;
  /** snapshot HTTP API (#30) 用の in-memory tracker。未指定なら no-op */
  runTracker?: RunTracker;
  /** 並列 dispatch 時の slot index。snapshot にそのまま載せる */
  slot?: number;
  /**
   * 直前 attempt が retry 起源 (failure / continuation) なら kind/attempt を渡す。
   * snapshot の `running[].retry_attempt` に表示される (#87)。fresh dispatch では null。
   */
  retryAttempt?: { kind: RetryKind; attempt: number } | null;
};

/**
 * Project Item が選択された後の dispatch 本体 (worktree → prompt → runner → cleanup)。
 *
 * ADR-0005 で Status 遷移 / PR 作成 / Issue コメント / Acceptance Criteria 抽出は agent 側に
 * 移ったため、本関数は **GitHub に書き込みを行わない**。runner exit 0 で worktree を cleanup
 * するだけ。失敗時も orchestrator は worktree を保持して exit 1 する (debug 用)。
 */
export async function dispatchSelected(
  deps: DispatchSelectedDeps,
): Promise<Extract<RunOnceResult, { kind: 'success' | 'failed' }>> {
  const baseLogger = deps.baseLogger ?? noopLogger;
  const clock = deps.clock ?? (() => new Date());
  const runner = deps.runClaude ?? runClaude;
  const idGen = deps.generateRunId ?? generateRunId;
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const remote = deps.remote ?? DEFAULT_REMOTE;

  const { candidate, issue, repository } = deps;
  const runId = idGen();
  const startedAt = clock();
  const runLog = await createRunLog({ runId, runsRoot: deps.runnerLogsRoot });
  const logger = baseLogger.child({ runId, issueNumber: candidate.issueNumber });
  const tracker = deps.runTracker ?? noopRunTracker;

  logger.info('candidate selected', {
    repository: candidate.repositoryNameWithOwner,
  });

  const branch = `feature/${candidate.issueNumber}-${buildIssueSlug(candidate.issueTitle)}`;
  const taskKey = `issue-${candidate.issueNumber}`;
  // workspaceManager.createWorkspace の前に「期待される」 worktree path を求める。watchdog
  // (#105) が orphaned / stale 判定で workspace path を参照するため runStarted に乗せる。
  // workspace_provisioning が失敗しても markFailed で runFinished されるので副作用は無い。
  const expectedWorkspacePath = deps.workspaceManager.resolveWorkspacePath(taskKey);
  tracker.runStarted({
    runId,
    issueNumber: candidate.issueNumber,
    branch,
    startedAt,
    slot: deps.slot ?? null,
    retryAttempt: deps.retryAttempt ?? null,
    workspacePath: expectedWorkspacePath,
    runLogPath: runLog.dir,
  });
  const baseRef = `${remote}/${deps.config.baseBranch}`;
  const failureContext: FailureContext = {
    runId,
    runLog,
    candidate,
    issue,
    repository,
    branch,
    startedAt,
    logger,
    clock,
    runTracker: tracker,
  };

  let resolved = false;
  const finalize = (
    result: Extract<RunOnceResult, { kind: 'success' | 'failed' }>,
  ): Extract<RunOnceResult, { kind: 'success' | 'failed' }> => {
    resolved = true;
    return result;
  };

  try {
    // Workspace Provisioning (orchestration-mvp.md「3. Workspace Provisioning」)
    // git fetch を先に実行してから worktree を作成する。WorkspaceManager は worktree add のみで
    // remote 取得は行わないため、orchestrator 側で必ず fetch しておく必要がある (#62)。
    let workspacePath: string;
    try {
      await fetchBaseBranch(gitRunner, deps.repoRoot, remote, deps.config.baseBranch);
      const workspace = await deps.workspaceManager.createWorkspace({
        taskKey,
        branch,
        baseRef,
        reuse: false,
      });
      workspacePath = workspace.path;
    } catch (error) {
      return finalize(await markFailed(failureContext, 'workspace_provisioning', error));
    }

    // Prompt Construction
    let prompt: string;
    try {
      prompt = await deps.workflowSource.render({
        repository,
        baseBranch: deps.config.baseBranch,
        issueNumber: candidate.issueNumber,
        issueTitle: candidate.issueTitle,
        issueUrl: candidate.issueUrl,
        issueBody: issue.body ?? '',
        workspacePath,
        runId,
        project: {
          owner: deps.config.owner,
          number: deps.config.projectNumber,
          statusField: deps.config.statusField,
        },
        statusTransitions: deps.config.statusTransitions,
      });
    } catch (error) {
      return finalize(await markFailed(failureContext, 'runner_error', error));
    }
    await writeFile(path.join(runLog.dir, 'prompt.md'), prompt, 'utf8');

    // Runner Execution
    const hookContext: HookContext = {
      taskKey,
      branch,
      workspacePath,
      baseRef,
      extraEnv: {
        PHILHARMONIC_ISSUE_NUMBER: String(candidate.issueNumber),
        PHILHARMONIC_RUN_ID: runId,
      },
    };

    try {
      await deps.workspaceManager.runHooks('before_run', hookContext);
    } catch (error) {
      if (isHookError(error)) {
        return finalize(await markFailed(failureContext, 'hook_failed', error));
      }
      throw error;
    }

    if (deps.config.permissionMode === 'bypass') {
      logger.warn(
        'permission_mode=bypass で Claude Code を起動します。--dangerously-skip-permissions の副作用は worktree 外 (ホスト全体) にも及び得るため、git worktree + 非特権ユーザによる隔離を必ず確認してください',
      );
    }
    // permission_mode=auto は agent 委譲型では実用上機能しないが (ADR-0005)、警告は CLI bootstrap
    // で 1 回だけ出す方針 (dispatch ごとの再警告はノイズになるため)。
    let run: RunResult;
    try {
      run = await runner({
        prompt,
        workspacePath,
        sessionId: runId,
        permissionMode: deps.config.permissionMode,
        timeoutMs: deps.config.timeoutMs,
        killGracePeriodMs: deps.config.killGracePeriodMs,
        maxTurns: deps.config.agent.maxTurns,
        stallTimeoutMs: deps.config.agent.stallTimeoutMs,
        logDir: runLog.dir,
        logger,
        onActivity: (at) => tracker.recordActivity(runId, at),
        onSpawn: (pid) => tracker.recordRunnerProcess(runId, pid),
        onActivityEvent: (event, at) => tracker.recordActivityEvent(runId, event, at),
      });
    } catch (error) {
      await runAfterRunHooksSafely(deps.workspaceManager, hookContext, 'failed', logger);
      return finalize(await markFailed(failureContext, 'runner_error', error));
    }

    try {
      await deps.workspaceManager.runHooks('after_run', {
        ...hookContext,
        extraEnv: {
          ...hookContext.extraEnv,
          PHILHARMONIC_RUN_STATUS: run.status,
        },
      });
    } catch (error) {
      if (isHookError(error)) {
        return finalize(await markFailed(failureContext, 'hook_failed', error, run));
      }
      throw error;
    }

    // Result Triage (orchestration-mvp.md「6. Result Triage」)
    if (run.status === 'timeout') {
      return finalize(await markFailed(failureContext, 'timeout', null, run));
    }
    if (run.status === 'stalled') {
      return finalize(await markFailed(failureContext, 'stalled', null, run));
    }
    if (run.status === 'failed') {
      return finalize(await markFailed(failureContext, 'runner_error', null, run));
    }

    // Cleanup (success): runner exit 0 のみ worktree を削除する (ADR-0005)
    try {
      await deps.workspaceManager.cleanupWorkspace({ taskKey, branch, deleteBranch: true });
    } catch (error) {
      logger.warn('worktree のクリーンアップに失敗しました', {
        error: describeError(error),
      });
    }

    await persistRun(failureContext, {
      status: 'success',
      failureReason: null,
      branch,
      durationMs: run.durationMs,
      totalCostUsd: run.totalCostUsd,
      finalText: run.finalText,
      finishedAt: clock(),
    });

    logger.info('run completed successfully', {
      branch,
    });

    tracker.runFinished({
      kind: 'success',
      runId,
      issueNumber: candidate.issueNumber,
      totalCostUsd: run.totalCostUsd,
    });

    return finalize({
      kind: 'success',
      runId,
      issueNumber: candidate.issueNumber,
      branch,
    });
  } finally {
    // 想定外の throw で resolved にならなかった場合の防御的な finalize。
    // 通常パス (success / markFailed) は finalize を経由して runFinished 済みなので noop になる。
    if (!resolved) {
      tracker.runFinished({
        kind: 'failed',
        runId,
        issueNumber: candidate.issueNumber,
        reason: 'runner_error',
        totalCostUsd: null,
      });
    }
  }
}

type FailureContext = {
  runId: string;
  runLog: RunLog;
  candidate: Candidate;
  issue: Issue;
  repository: { owner: string; name: string };
  branch: string;
  startedAt: Date;
  logger: Logger;
  clock: RunOnceClock;
  runTracker: RunTracker;
};

async function markFailed(
  ctx: FailureContext,
  reason: FailureReason,
  error: unknown,
  run?: RunResult,
): Promise<Extract<RunOnceResult, { kind: 'failed' }>> {
  const finishedAt = ctx.clock();
  const durationMs = run?.durationMs ?? finishedAt.getTime() - ctx.startedAt.getTime();
  const totalCostUsd = run?.totalCostUsd ?? null;
  const detail = error !== undefined && error !== null ? describeError(error) : null;
  const stderrTail = run?.rawStderrTail ?? null;
  const errorSummary = truncateErrorSummary(detail ?? (stderrTail !== '' ? stderrTail : null));

  ctx.logger.error('run failed', {
    reason,
    detail,
  });

  await persistRun(ctx, {
    status: 'failed',
    failureReason: reason,
    branch: ctx.branch,
    durationMs,
    totalCostUsd,
    finalText: run?.finalText ?? null,
    finishedAt,
  });

  ctx.runTracker.runFinished({
    kind: 'failed',
    runId: ctx.runId,
    issueNumber: ctx.candidate.issueNumber,
    reason,
    totalCostUsd,
  });

  return {
    kind: 'failed',
    runId: ctx.runId,
    issueNumber: ctx.candidate.issueNumber,
    reason,
    branch: ctx.branch,
    errorSummary,
  };
}

const ERROR_SUMMARY_MAX_LEN = 500;

function truncateErrorSummary(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= ERROR_SUMMARY_MAX_LEN) return value;
  return value.slice(0, ERROR_SUMMARY_MAX_LEN);
}

type PersistInput = {
  status: RunLogStatus;
  failureReason: FailureReason | null;
  branch: string | null;
  durationMs: number;
  totalCostUsd: number | null;
  finalText: string | null;
  finishedAt: Date;
};

async function persistRun(ctx: FailureContext, input: PersistInput): Promise<void> {
  await writeMetadata(ctx.runLog, {
    runId: ctx.runId,
    issueNumber: ctx.candidate.issueNumber,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    status: input.status,
    failureReason: input.failureReason,
    totalCostUsd: input.totalCostUsd,
    branch: input.branch,
  });
  await writeSummary(ctx.runLog, {
    runId: ctx.runId,
    issueNumber: ctx.candidate.issueNumber,
    status: input.status,
    finalText: input.finalText,
    failureReason: input.failureReason,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.durationMs,
    totalCostUsd: input.totalCostUsd,
  });
}

type SelectInput = {
  candidates: readonly Candidate[];
  dispatchStatuses: readonly string[];
  githubClient: GitHubClient;
  agentUserLogin: string | null;
  logger: Logger;
  guard: DispatchGuard;
  /** ADR-0007: dependency filter で candidate body 外の依存先 Issue を取得する fetcher */
  fetchDependencyIssue?: FetchDependencyIssue;
  /** Issue #80: 直近 evaluation を保持する scheduler tracker (Snapshot API 用) */
  dependencyTracker?: DependencyTracker;
  /** evaluation 時刻のソース。`recordEvaluation` の `at` に使う */
  clock?: RunOnceClock;
};

type SelectResult = {
  candidate: Candidate;
  issue: Issue;
  repository: { owner: string; name: string };
};

async function selectAcceptableCandidate(input: SelectInput): Promise<SelectResult | null> {
  const results = await selectAcceptableCandidates({ ...input, limit: 1 });
  return results[0] ?? null;
}

/**
 * status / assignee / `agent:skip` / worktree / in-flight の既存 filter を全件適用したのち、
 * ADR-0007 の dependency filter を最終段に挿入し、`ready` candidate のみ board 順で `limit` 件返す。
 *
 * dependency filter の都合で、limit に達するかに関わらず candidates 全件を 1 周走査する点が
 * 旧実装からの差分。これは ADR-0007 §4 の擬似コードに従う。tick あたりの GitHub API 呼び出しは
 * 旧実装比で「acceptable な候補数」分まで増えるが、`getIssue` で取った body はそのまま依存解決に
 * 流用するため、追加 fetch は Project items 外の依存先のみに限定される (ADR-0007 §6)。
 */
async function selectAcceptableCandidates(
  input: SelectInput & { limit: number },
): Promise<SelectResult[]> {
  const acceptable = await collectAcceptableCandidates(input);
  const tracker = input.dependencyTracker ?? noopDependencyTracker;
  const evaluatedAt = (input.clock ?? (() => new Date()))();

  if (acceptable.length === 0) {
    tracker.recordEvaluation({ evaluations: [], at: evaluatedAt });
    return [];
  }

  const fetchIssue =
    input.fetchDependencyIssue ??
    createDependencyIssueFetcher({
      githubClient: input.githubClient,
      defaultRepository: acceptable[0]!.repository,
    });

  const evaluations: EvaluatedCandidate[] = await evaluateDependencyDag({
    candidates: acceptable.map((s) => ({ candidate: s.candidate, body: s.issue.body })),
    fetchIssue,
  });

  tracker.recordEvaluation({ evaluations, at: evaluatedAt });

  const readyIssueNumbers = new Set<number>();
  for (const evaluation of evaluations) {
    logDependencyEvaluation(input.logger, evaluation);
    if (evaluation.state === 'ready') {
      readyIssueNumbers.add(evaluation.candidate.issueNumber);
    }
  }

  const ready = acceptable.filter((s) => readyIssueNumbers.has(s.candidate.issueNumber));
  return ready.slice(0, input.limit);
}

/**
 * status / assignee / `agent:skip` / worktree / in-flight を pass した acceptable candidate を
 * board 順で全件返す (limit を適用する前段階)。Issue body は `getIssue` の戻りを保持し、
 * 後段の dependency filter で再利用する。
 */
async function collectAcceptableCandidates(input: SelectInput): Promise<SelectResult[]> {
  const acceptable: SelectResult[] = [];
  for (const candidate of input.candidates) {
    if (candidate.issueState !== 'OPEN') continue;
    if (candidate.status === null) continue;
    if (!input.dispatchStatuses.includes(candidate.status)) continue;

    const repository = parseRepositoryNameWithOwner(candidate.repositoryNameWithOwner);
    const issue = await input.githubClient.getIssue({
      owner: repository.owner,
      repo: repository.name,
      issueNumber: candidate.issueNumber,
    });

    if (issue.state !== 'open') {
      input.logger.info('skip candidate (issue closed)', {
        issueNumber: candidate.issueNumber,
      });
      continue;
    }
    const result = isAcceptableIssue({
      labels: issue.labels,
      assignees: issue.assignees,
      agentUserLogin: input.agentUserLogin,
    });
    if (!result.ok) {
      input.logger.info(`skip candidate (${result.reason})`, {
        issueNumber: candidate.issueNumber,
      });
      continue;
    }
    const guardResult = await checkDispatchGuard(input.guard, candidate.issueNumber);
    if (!guardResult.ok) {
      logSkipReason(input.logger, candidate.issueNumber, guardResult.reason);
      continue;
    }
    acceptable.push({ candidate, issue, repository });
  }
  return acceptable;
}

function logSkipReason(logger: Logger, issueNumber: number, reason: DispatchGuardSkipReason): void {
  switch (reason) {
    case 'workspace_exists':
      logger.info('skip candidate (workspace already exists)', { issueNumber });
      return;
    case 'tracker_in_flight':
      logger.info('skip candidate (already in flight)', { issueNumber });
      return;
    case 'retry_queued':
      logger.info('skip candidate (retry queued)', { issueNumber });
      return;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isHookError(error: unknown): error is HookExecutionError | HookTimeoutError {
  return error instanceof HookExecutionError || error instanceof HookTimeoutError;
}

async function runAfterRunHooksSafely(
  workspaceManager: WorkspaceManager,
  context: HookContext,
  runStatus: string,
  logger: Logger,
): Promise<void> {
  try {
    await workspaceManager.runHooks('after_run', {
      ...context,
      extraEnv: {
        ...context.extraEnv,
        PHILHARMONIC_RUN_STATUS: runStatus,
      },
    });
  } catch (error) {
    logger.warn('after_run hook failed (already failing path)', {
      error: describeError(error),
    });
  }
}

// ─── Retry queue 連携 (#84 / ADR-0008, #85 / ADR-0009) ───

/** 1 tick で dispatch する単位。retry 起源かどうかを `retryAttempt` / `retryFrom` で表す */
export type DispatchTask = {
  candidate: Candidate;
  issue: Issue;
  repository: Repository;
  /** 0: fresh candidate (初回 dispatch)。1+: retry queue 起源 (= 直前の attempt 番号) */
  retryAttempt: number;
  retryFrom: RetryEntry | null;
};

const RETRY_RESCHEDULE_DELAY_MS = 10_000;

/**
 * `DispatchTask` から `runStarted.retryAttempt` 用の値を組み立てる。
 *
 * fresh dispatch (retryFrom === null) は null を返す。retry 起源は `retryFrom.kind` と
 * 「次に走る attempt 番号 = task.retryAttempt」を渡す (snapshot/UI で人間に分かりやすい単位)。
 */
function dispatchTaskToRetryAttempt(
  task: DispatchTask,
): { kind: RetryKind; attempt: number } | null {
  if (task.retryFrom === null) return null;
  return { kind: task.retryFrom.kind, attempt: task.retryAttempt };
}

/**
 * `dispatchSelected` の `failureReason` のうち、failure retry queue の対象とするものを判定する。
 *
 * 現状は全 `FailureReason` を retry 対象とする (ADR-0008 §1)。failureReason 別の細粒度な on/off
 * は spec の Open Question として保留。
 */
export function isRetryEligibleReason(reason: FailureReason): boolean {
  switch (reason) {
    case 'workspace_provisioning':
    case 'runner_error':
    case 'timeout':
    case 'stalled':
    case 'hook_failed':
      return true;
  }
}

/**
 * 直前の dispatch (fresh / retry queue 起源) が active な状態かを Project Status で再判定する。
 *
 * spec: docs/specs/retry-queue.md §continuation retry
 */
export type ContinuationDecision =
  | { kind: 'schedule'; status: string }
  | { kind: 'release'; reason: 'closed' | 'terminal_status' | 'inactive_status' | 'fetch_error' };

export function evaluateContinuationDecision(input: {
  candidate: Candidate | undefined;
  config: Config;
  dispatchStatuses: readonly string[];
}): ContinuationDecision {
  const { candidate, config, dispatchStatuses } = input;
  if (candidate === undefined) return { kind: 'release', reason: 'inactive_status' };
  if (candidate.issueState !== 'OPEN') return { kind: 'release', reason: 'closed' };

  const allowed = new Set<string>([...dispatchStatuses, config.statusTransitions.inProgress]);
  if (candidate.status === null || !allowed.has(candidate.status)) {
    const isTerminal =
      candidate.status === config.statusTransitions.inReview ||
      candidate.status === config.statusTransitions.failed;
    return { kind: 'release', reason: isTerminal ? 'terminal_status' : 'inactive_status' };
  }
  return { kind: 'schedule', status: candidate.status };
}

/**
 * `runOnce` / `runConcurrent` の DI から exhaustion notify 関数を組み立てる。
 *
 * - `notifyFailureExhausted` を直接渡されたらそれを使う (テスト用)
 * - そうでなくて `runGh` だけ渡されたら module の default を `runGh` / `projectsClient` で bind
 * - どちらも未指定なら undefined を返す = 配線無し (= `philharmonic run` 互換)
 */
function resolveNotifyFailureExhausted(
  deps: Pick<RunOnceDeps, 'runGh' | 'notifyFailureExhausted' | 'projectsClient'>,
  logger: Logger,
): NotifyFailureExhaustedFn | undefined {
  if (deps.notifyFailureExhausted !== undefined) return deps.notifyFailureExhausted;
  if (deps.runGh === undefined) return undefined;
  const runGh = deps.runGh;
  const projectsClient = deps.projectsClient;
  return (input) =>
    defaultNotifyFailureExhausted(input, {
      runGh,
      projectsClient,
      logger,
    });
}

type ContinuationCandidatesResolver = () => Promise<readonly Candidate[] | null>;

/**
 * success 後の continuation 判定で使う `fetchProjectCandidates` を memoize する factory。
 *
 * 同 tick 内の複数 success で 1 回に共有することで GitHub API call 回数を抑える。fetch が失敗したら
 * `null` を resolve するので呼び出し側は `release reason=fetch_error` 扱いにする。
 */
function makeContinuationCandidatesResolver(deps: {
  projectsClient: ProjectsClient;
  config: Config;
  logger: Logger;
}): ContinuationCandidatesResolver {
  let cached: readonly Candidate[] | null | undefined; // undefined = not fetched yet
  return async () => {
    if (cached !== undefined) return cached;
    try {
      cached = await deps.projectsClient.fetchProjectCandidates({
        owner: deps.config.owner,
        projectNumber: deps.config.projectNumber,
        statusFieldName: deps.config.statusField,
      });
      return cached;
    } catch (error) {
      deps.logger.warn('continuation fetch error', { error: describeError(error) });
      cached = null;
      return cached;
    }
  };
}

type DrainRetryQueueDeps = {
  retryQueue?: RetryQueue;
  limit: number;
  githubClient: GitHubClient;
  projectsClient: ProjectsClient;
  workspaceManager: WorkspaceManager;
  config: Config;
  dispatchStatuses: readonly string[];
  runTracker: RunTracker;
  logger: Logger;
  clock: () => Date;
};

/**
 * retry queue から dueAt <= now の entry を取り出して dispatch 可能な task に変換する。
 *
 * - 各 entry について Issue / Project Status を再取得して active 判定 (spec retry-queue.md §Status 再取得)
 * - active なら `cleanupWorkspace` で worktree を force reset (ADR-0008 §5)
 * - inactive / closed / fetch failure は queue から除外して `retry skipped` ログ
 * - in-flight tracker に居るときは entry を 10s 後に再 schedule して当 tick からは除外
 */
async function drainRetryQueue(deps: DrainRetryQueueDeps): Promise<DispatchTask[]> {
  if (deps.retryQueue === undefined) return [];
  const drained = deps.retryQueue.drainDue(deps.clock());
  if (drained.length === 0) return [];

  const tasks: DispatchTask[] = [];
  let candidatesCache: readonly Candidate[] | null = null;

  for (const entry of drained) {
    if (tasks.length >= deps.limit) {
      // 上限超過分はそのまま queue に戻して次 tick へ送る (kind / attempt は据え置き)。
      rescheduleEntry(deps.retryQueue, entry, 0, deps.clock());
      continue;
    }

    if (deps.runTracker.getRunningByIssue(entry.issueNumber) !== null) {
      // drainDue で既に queue から外れているため、attempt は据え置きで 10s 後に積み直す。
      rescheduleEntry(deps.retryQueue, entry, RETRY_RESCHEDULE_DELAY_MS, deps.clock());
      deps.logger.info('retry skipped', {
        kind: entry.kind,
        issueNumber: entry.issueNumber,
        attempt: entry.attempt,
        reason: 'tracker_in_flight',
      });
      continue;
    }

    deps.logger.info('retry due', {
      kind: entry.kind,
      issueNumber: entry.issueNumber,
      attempt: entry.attempt,
      lastRunId: entry.lastRunId,
    });

    let issue: Issue;
    try {
      issue = await deps.githubClient.getIssue({
        owner: entry.repository.owner,
        repo: entry.repository.name,
        issueNumber: entry.issueNumber,
      });
    } catch (error) {
      deps.logger.info('retry skipped', {
        kind: entry.kind,
        issueNumber: entry.issueNumber,
        attempt: entry.attempt,
        reason: 'fetch_error',
        error: describeError(error),
      });
      continue;
    }

    if (issue.state !== 'open') {
      deps.logger.info('retry skipped', {
        kind: entry.kind,
        issueNumber: entry.issueNumber,
        attempt: entry.attempt,
        reason: 'closed',
      });
      continue;
    }

    if (candidatesCache === null) {
      try {
        candidatesCache = await deps.projectsClient.fetchProjectCandidates({
          owner: deps.config.owner,
          projectNumber: deps.config.projectNumber,
          statusFieldName: deps.config.statusField,
        });
      } catch (error) {
        deps.logger.warn('retry drain error', { error: describeError(error) });
        // 取得失敗時は当 tick の retry をすべて諦める。残りの drained entry も queue に戻す
        for (const remaining of drained.slice(drained.indexOf(entry))) {
          rescheduleEntry(deps.retryQueue, remaining, RETRY_RESCHEDULE_DELAY_MS, deps.clock());
        }
        return tasks;
      }
    }

    const candidate = candidatesCache.find((c) => c.issueNumber === entry.issueNumber);
    if (candidate === undefined) {
      deps.logger.info('retry skipped', {
        kind: entry.kind,
        issueNumber: entry.issueNumber,
        attempt: entry.attempt,
        reason: 'inactive_status',
      });
      continue;
    }

    const allowedStatuses = new Set<string>([
      ...deps.dispatchStatuses,
      deps.config.statusTransitions.inProgress,
    ]);
    if (candidate.status === null || !allowedStatuses.has(candidate.status)) {
      const isTerminal =
        candidate.status === deps.config.statusTransitions.inReview ||
        candidate.status === deps.config.statusTransitions.failed;
      deps.logger.info('retry skipped', {
        kind: entry.kind,
        issueNumber: entry.issueNumber,
        attempt: entry.attempt,
        reason: isTerminal ? 'terminal_status' : 'inactive_status',
        status: candidate.status,
      });
      continue;
    }

    try {
      await deps.workspaceManager.cleanupWorkspace({
        taskKey: `issue-${entry.issueNumber}`,
        branch: entry.branch,
        deleteBranch: true,
      });
    } catch (error) {
      deps.logger.warn('retry workspace cleanup failed', {
        kind: entry.kind,
        issueNumber: entry.issueNumber,
        attempt: entry.attempt,
        error: describeError(error),
      });
      // cleanup 失敗でも dispatchSelected が衝突 fail で `workspace_provisioning` として
      // 落ちるだけなので task に積んで続行する
    }

    const repository = parseRepositoryNameWithOwner(candidate.repositoryNameWithOwner);
    tasks.push({
      candidate,
      issue,
      repository,
      retryAttempt: entry.attempt,
      retryFrom: entry,
    });
  }

  return tasks;
}

/**
 * `drainRetryQueue` 内で entry を queue に戻すための helper。
 *
 * - failure: `computeRetryDelayMs(attempt, delayMs)` で clamp された delay
 * - continuation: schedule 内部で固定 delay (CONTINUATION_RETRY_DELAY_MS) が使われるため
 *   `delayMs` 引数は無視される。tracker_in_flight / overflow / fetch error いずれの場合も
 *   continuation entry は次回 ~10s 後に積み直る挙動になる
 */
function rescheduleEntry(
  retryQueue: RetryQueue,
  entry: RetryEntry,
  delayMs: number,
  now: Date,
): void {
  retryQueue.schedule({
    kind: entry.kind,
    issueNumber: entry.issueNumber,
    repository: entry.repository,
    branch: entry.branch,
    workspacePath: entry.workspacePath,
    attempt: entry.attempt,
    failureReason: entry.failureReason,
    lastRunId: entry.lastRunId,
    lastErrorSummary: entry.lastErrorSummary,
    now,
    maxBackoffMs: delayMs,
  });
}

type ProcessDispatchResultDeps = {
  task: DispatchTask;
  result: Extract<RunOnceResult, { kind: 'success' | 'failed' }>;
  retryQueue?: RetryQueue;
  maxRetryAttempts: number;
  maxRetryBackoffMs: number;
  /** failure exhaustion 時に `<runnerLogsRoot>/<runId>/failure-summary.md` を書き出すために使う */
  runnerLogsRoot: string;
  config: Config;
  dispatchStatuses: readonly string[];
  logger: Logger;
  clock: () => Date;
  /** fresh candidate の retry を schedule する際に workspacePath を解決する関数 */
  resolveWorkspacePath: (task: DispatchTask) => string;
  /** continuation 判定用の最新 Project candidates を memoize 経由で返す resolver */
  resolveContinuationCandidates: ContinuationCandidatesResolver;
  /**
   * `kind=failure` の exhaustion で Project Status を `Failed` に倒し Issue にコメントする
   * safety-net (ADR-0010 / #103)。未指定なら no-op (= `philharmonic run` 互換)
   */
  notifyFailureExhausted?: NotifyFailureExhaustedFn;
};

/**
 * 1 件の dispatch 結果に対して retry queue を更新する。
 *
 * - success: Project Status を再取得し、active なら continuation を schedule、それ以外は release
 * - failed (retry-eligible) で next attempt が上限内: failure を schedule
 * - failed (retry-eligible) で next attempt が上限超: drop + `retry exhausted` warn
 * - failed (retry 対象外) / queue 未注入 / max_retry_attempts == 0: 何もしない
 */
async function processDispatchResultForRetry(deps: ProcessDispatchResultDeps): Promise<void> {
  if (deps.result.kind === 'success') {
    await processDispatchSuccessForContinuation(deps);
    return;
  }
  await processDispatchFailureForRetry(deps);
}

async function processDispatchFailureForRetry(deps: ProcessDispatchResultDeps): Promise<void> {
  const { task, result, retryQueue, maxRetryAttempts, maxRetryBackoffMs, logger, clock } = deps;
  if (retryQueue === undefined) return;
  if (result.kind !== 'failed') return;

  if (!isRetryEligibleReason(result.reason)) return;
  if (maxRetryAttempts <= 0) return;

  const branch = result.branch ?? task.retryFrom?.branch ?? '(unknown)';
  const workspacePath = task.retryFrom?.workspacePath ?? deps.resolveWorkspacePath(task);

  const nextAttempt = nextAttemptForKind(task, 'failure');
  if (nextAttempt > maxRetryAttempts) {
    await handleFailureExhaustion({
      retryQueue,
      issueNumber: task.candidate.issueNumber,
      repository: { owner: task.repository.owner, name: task.repository.name },
      itemId: task.candidate.itemId,
      branch,
      workspacePath,
      attempt: task.retryAttempt,
      maxAttempts: maxRetryAttempts,
      failureReason: result.reason,
      runId: result.runId,
      errorSummary: result.errorSummary,
      runnerLogsRoot: deps.runnerLogsRoot,
      config: deps.config,
      notifyFailureExhausted: deps.notifyFailureExhausted,
      logger,
      clock,
    });
    return;
  }

  const now = clock();
  const entry = retryQueue.schedule({
    kind: 'failure',
    issueNumber: task.candidate.issueNumber,
    repository: { owner: task.repository.owner, name: task.repository.name },
    branch,
    workspacePath,
    attempt: nextAttempt,
    failureReason: result.reason,
    lastRunId: result.runId,
    lastErrorSummary: result.errorSummary,
    now,
    maxBackoffMs: maxRetryBackoffMs,
  });
  logger.info('retry scheduled', {
    kind: entry.kind,
    issueNumber: entry.issueNumber,
    attempt: entry.attempt,
    delayMs: entry.dueAt.getTime() - now.getTime(),
    dueAt: entry.dueAt.toISOString(),
    failureReason: entry.failureReason,
    lastRunId: entry.lastRunId,
  });
}

async function processDispatchSuccessForContinuation(
  deps: ProcessDispatchResultDeps,
): Promise<void> {
  const {
    task,
    result,
    retryQueue,
    maxRetryAttempts,
    config,
    dispatchStatuses,
    logger,
    clock,
    resolveContinuationCandidates,
  } = deps;
  if (result.kind !== 'success') return;
  if (retryQueue === undefined) return;

  // retry 機能 off (= max_retry_attempts == 0) のときは継続せず queue を空にして終わる
  // (retry 中の entry が success に至ったケースを含めて queue から落とす)。
  if (maxRetryAttempts <= 0) {
    retryQueue.remove(task.candidate.issueNumber);
    return;
  }

  const candidates = await resolveContinuationCandidates();
  if (candidates === null) {
    retryQueue.remove(task.candidate.issueNumber);
    logger.info('continuation released', {
      issueNumber: task.candidate.issueNumber,
      reason: 'fetch_error',
      lastRunId: result.runId,
    });
    return;
  }

  const candidate = candidates.find((c) => c.issueNumber === task.candidate.issueNumber);
  const decision = evaluateContinuationDecision({
    candidate,
    config,
    dispatchStatuses,
  });

  if (decision.kind === 'release') {
    retryQueue.remove(task.candidate.issueNumber);
    logger.info('continuation released', {
      issueNumber: task.candidate.issueNumber,
      reason: decision.reason,
      status: candidate?.status ?? null,
      lastRunId: result.runId,
    });
    return;
  }

  // continuation を schedule (attempt は kind 別カウンタ)
  const nextAttempt = nextAttemptForKind(task, 'continuation');
  if (nextAttempt > maxRetryAttempts) {
    retryQueue.remove(task.candidate.issueNumber);
    logger.warn('retry exhausted', {
      kind: 'continuation',
      issueNumber: task.candidate.issueNumber,
      attempt: task.retryAttempt,
      failureReason: null,
      lastRunId: result.runId,
    });
    return;
  }

  const branch = result.branch ?? task.retryFrom?.branch ?? '(unknown)';
  const workspacePath = task.retryFrom?.workspacePath ?? deps.resolveWorkspacePath(task);
  const now = clock();
  const entry = retryQueue.schedule({
    kind: 'continuation',
    issueNumber: task.candidate.issueNumber,
    repository: { owner: task.repository.owner, name: task.repository.name },
    branch,
    workspacePath,
    attempt: nextAttempt,
    failureReason: null,
    lastRunId: result.runId,
    lastErrorSummary: null,
    now,
    maxBackoffMs: 0, // continuation は固定 delay
  });
  logger.info('retry scheduled', {
    kind: entry.kind,
    issueNumber: entry.issueNumber,
    attempt: entry.attempt,
    delayMs: entry.dueAt.getTime() - now.getTime(),
    dueAt: entry.dueAt.toISOString(),
    failureReason: entry.failureReason,
    lastRunId: entry.lastRunId,
    activeStatus: decision.status,
  });
}

/**
 * 次の attempt 番号を計算する。
 *
 * 直前の dispatch (= `task`) の kind と新しい kind が一致すれば counter +1。
 * 違えばリセット (1 から)。fresh candidate (`retryFrom === null`) は常に 1。
 */
function nextAttemptForKind(task: DispatchTask, newKind: RetryKind): number {
  if (task.retryFrom === null) return 1;
  if (task.retryFrom.kind === newKind) return task.retryAttempt + 1;
  return 1;
}

export type HandleFailureExhaustionInput = {
  retryQueue: RetryQueue;
  issueNumber: number;
  repository: Repository;
  /** Project Item ID。recovery 経路で取れないと exhaustion notify は skip される */
  itemId: string;
  branch: string;
  workspacePath: string;
  /** 直前 attempt 番号 (1-indexed)。failure-summary / コメントに表示される */
  attempt: number;
  maxAttempts: number;
  failureReason: FailureReason;
  runId: string;
  errorSummary: string | null;
  runnerLogsRoot: string;
  config: Config;
  notifyFailureExhausted?: NotifyFailureExhaustedFn;
  logger: Logger;
  clock: () => Date;
  /** 構造化ログに `via=recovery` 等を載せたいときに渡す (省略時は記録しない) */
  via?: string;
};

/**
 * `kind=failure` の retry 上限到達を処理する共通ハンドラ。
 *
 * 1. retry queue から entry を落とす
 * 2. `<runnerLogsRoot>/<runId>/failure-summary.md` を書き出す (失敗時 null)
 * 3. `retry exhausted` warn ログ (spec 通り branch / workspacePath / summary/stream/stderr/failureSummary path を含む)
 * 4. `notifyFailureExhausted` が DI で渡されていれば Status `Failed` 遷移 + Issue コメントを投稿 (ADR-0010)
 *
 * fresh dispatch / recovery / 永続化 restore 後の retry のいずれの経路でも同じ safety-net が走る。
 */
export async function handleFailureExhaustion(input: HandleFailureExhaustionInput): Promise<void> {
  const { retryQueue, issueNumber, attempt, runId, branch, workspacePath, failureReason } = input;
  retryQueue.remove(issueNumber);
  const exhaustedAt = input.clock();
  const failureSummaryPath = await emitFailureSummaryArtifact(
    {
      runnerLogsRoot: input.runnerLogsRoot,
      runId,
      issueNumber,
      attempt,
      maxAttempts: input.maxAttempts,
      failureReason,
      branch,
      workspacePath,
      errorSummary: input.errorSummary,
      exhaustedAt,
    },
    input.logger,
  );
  input.logger.warn('retry exhausted', {
    kind: 'failure',
    issueNumber,
    attempt,
    failureReason,
    lastRunId: runId,
    branch,
    workspacePath,
    failureSummaryPath,
    summaryPath: `.philharmonic/runs/${runId}/summary.md`,
    streamPath: `.philharmonic/runs/${runId}/stream.jsonl`,
    stderrPath: `.philharmonic/runs/${runId}/stderr.log`,
    ...(input.via !== undefined ? { via: input.via } : {}),
  });
  if (input.notifyFailureExhausted !== undefined) {
    try {
      await input.notifyFailureExhausted({
        owner: input.config.owner,
        projectNumber: input.config.projectNumber,
        statusFieldName: input.config.statusField,
        failedStatus: input.config.statusTransitions.failed,
        issueNumber,
        repository: input.repository,
        itemId: input.itemId,
        attempt,
        maxAttempts: input.maxAttempts,
        failureReason,
        runId,
        branch,
        workspacePath,
        errorSummary: input.errorSummary,
        failureSummaryPath,
        runnerLogsRoot: input.runnerLogsRoot,
        exhaustedAt,
      });
    } catch (error) {
      input.logger.warn('exhaustion notify threw', {
        issueNumber,
        runId,
        error: describeError(error),
      });
    }
  }
}

/**
 * `kind=failure` の retry 上限到達時に運用者向け failure-summary.md を書き出す。
 *
 * 書き込み失敗 (disk full / 権限不足) で orchestrator 本体が落ちないように catch し、
 * 失敗時は warn ログを残して `failureSummaryPath = null` を返す (Issue #86 完了条件)。
 */
async function emitFailureSummaryArtifact(
  input: FailureSummaryInput,
  logger: Logger,
): Promise<string | null> {
  try {
    const { path: filePath } = await writeFailureSummary(input);
    return filePath;
  } catch (error) {
    logger.warn('failure summary write failed', {
      issueNumber: input.issueNumber,
      runId: input.runId,
      attempt: input.attempt,
      path: resolveFailureSummaryPath(input.runnerLogsRoot, input.runId),
      error: describeError(error),
    });
    return null;
  }
}

export {
  drainRetryQueue as drainRetryQueueForTest,
  processDispatchResultForRetry as processDispatchResultForRetryForTest,
};
