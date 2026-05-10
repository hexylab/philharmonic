import { stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config } from '../config/index.js';
import type { GitHubClient, Issue } from '../github/index.js';
import type { Logger } from '../logger/index.js';
import type { Candidate, ProjectsClient } from '../projects/index.js';
import {
  createRunLog,
  generateRunId,
  writeMetadata,
  writeSummary,
  type RunLog,
  type RunLogStatus,
} from '../runlog/index.js';
import { runClaude, type RunResult } from '../runner/index.js';
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

import { type FailureReason } from './errors.js';
import { fetchBaseBranch } from './git.js';
import { dispatchPool } from './pool.js';
import { parseRepositoryNameWithOwner, type Repository } from './repository.js';
import {
  checkDispatchGuard,
  DEFAULT_DISPATCH_STATUSES,
  isAcceptableIssue,
  selectFirstByStatus,
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
};

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
  };

  // 1. Candidate Selection (orchestration-mvp.md「Candidate Selection Rule」)
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
  });
  if (selected === null) {
    baseLogger.info('no candidate', { dispatchStatuses });
    return { kind: 'no_candidate' };
  }

  return await dispatchSelected({
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
  });
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
  };

  const candidates = await deps.projectsClient.fetchProjectCandidates({
    owner: deps.config.owner,
    projectNumber: deps.config.projectNumber,
    statusFieldName: deps.config.statusField,
  });
  const selected = await selectAcceptableCandidates({
    candidates,
    dispatchStatuses,
    githubClient: deps.githubClient,
    agentUserLogin: deps.config.agentUserLogin,
    logger: baseLogger,
    guard,
    limit: maxConcurrent,
  });
  if (selected.length === 0) {
    baseLogger.info('no candidate', { dispatchStatuses });
    return [];
  }

  baseLogger.info('concurrent tick', {
    maxConcurrent,
    dispatched: selected.length,
  });

  return await dispatchPool({
    tasks: selected,
    maxConcurrent,
    worker: async (task, slot): Promise<ConcurrentDispatchOutcome> => {
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
        });
        return { slot, result };
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
          },
        };
      }
    },
  });
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
  tracker.runStarted({
    runId,
    issueNumber: candidate.issueNumber,
    branch,
    startedAt,
    slot: deps.slot ?? null,
  });
  const taskKey = `issue-${candidate.issueNumber}`;
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
  };
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

async function selectAcceptableCandidates(
  input: SelectInput & { limit: number },
): Promise<SelectResult[]> {
  const acceptable: SelectResult[] = [];
  let remaining: readonly Candidate[] = input.candidates;
  while (remaining.length > 0 && acceptable.length < input.limit) {
    const candidate = selectFirstByStatus({
      candidates: remaining,
      dispatchStatuses: input.dispatchStatuses,
    });
    if (candidate === null) break;
    const repository = parseRepositoryNameWithOwner(candidate.repositoryNameWithOwner);
    const issue = await input.githubClient.getIssue({
      owner: repository.owner,
      repo: repository.name,
      issueNumber: candidate.issueNumber,
    });
    if (issue.state === 'open') {
      const result = isAcceptableIssue({
        labels: issue.labels,
        assignees: issue.assignees,
        agentUserLogin: input.agentUserLogin,
      });
      if (result.ok) {
        const guardResult = await checkDispatchGuard(input.guard, candidate.issueNumber);
        if (guardResult.ok) {
          acceptable.push({ candidate, issue, repository });
        } else {
          logSkipReason(input.logger, candidate.issueNumber, guardResult.reason);
        }
      } else {
        input.logger.info(`skip candidate (${result.reason})`, {
          issueNumber: candidate.issueNumber,
        });
      }
    } else {
      input.logger.info('skip candidate (issue closed)', {
        issueNumber: candidate.issueNumber,
      });
    }
    remaining = remaining.filter((c) => c.itemId !== candidate.itemId);
  }
  return acceptable;
}

function logSkipReason(logger: Logger, issueNumber: number, reason: DispatchGuardSkipReason): void {
  if (reason === 'workspace_exists') {
    logger.info('skip candidate (workspace already exists)', { issueNumber });
    return;
  }
  logger.info('skip candidate (already in flight)', { issueNumber });
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
