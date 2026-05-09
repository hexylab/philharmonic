import { stat } from 'node:fs/promises';

import type { Config } from '../config/index.js';
import type { GitHubClient } from '../github/index.js';
import type { Logger } from '../logger/index.js';
import type { Candidate, ProjectsClient } from '../projects/index.js';
import type { runClaude } from '../runner/index.js';
import type { WorkflowSource } from '../workflow/index.js';
import type { GitRunner, WorkspaceManager } from '../workspace/index.js';

import { BootstrapError } from './errors.js';
import { parseRepositoryNameWithOwner } from './repository.js';
import {
  dispatchSelected,
  type ResolveAttempt,
  type RunOnceClock,
  type RunOnceResult,
} from './run.js';
import { isAcceptableIssue } from './select.js';
import { buildIssueSlug } from './slug.js';
import { resolveStatusOptions } from './status.js';

const RECOVERY_STATUS = 'In Progress';

export type RecoveryDeps = {
  config: Config;
  repoRoot: string;
  githubClient: GitHubClient;
  projectsClient: ProjectsClient;
  workspaceManager: WorkspaceManager;
  workflowSource: WorkflowSource;
  runnerLogsRoot: string;
  signal: AbortSignal;
  remote?: string;
  resolveAttempt?: ResolveAttempt;
  runClaude?: typeof runClaude;
  gitRunner?: GitRunner;
  logger: Logger;
  clock?: RunOnceClock;
  generateRunId?: () => string;
  /** worktree ディレクトリの存在確認を差し替えるためのフック (テスト用) */
  pathExists?: (target: string) => Promise<boolean>;
};

export type RecoverySummary = {
  inProgressCount: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

/**
 * `philharmonic serve` 起動時の Tracker-driven Recovery フェーズ。
 *
 * Project Item で Status が `In Progress` のまま残っているものを引き取り、
 * - 対応する open PR が既にあるなら skip
 * - worktree が残っていれば force reset (cleanup → 再作成)
 * - 残っていなければ新規 worktree
 * してから {@link dispatchSelected} を呼ぶ。
 *
 * spec: docs/specs/orchestration-mvp.md#tracker-driven-recovery-serve-起動時
 */
export async function recoverInProgress(deps: RecoveryDeps): Promise<RecoverySummary> {
  const { logger, signal } = deps;
  const exists = deps.pathExists ?? defaultPathExists;

  // In Progress 全件取得
  const candidates = await deps.projectsClient.fetchProjectCandidates({
    owner: deps.config.owner,
    projectNumber: deps.config.projectNumber,
    statusFieldName: deps.config.statusField,
  });
  const inProgress = candidates.filter(
    (c) => c.status === RECOVERY_STATUS && c.issueState === 'OPEN',
  );

  logger.info('recovery started', { inProgressCount: inProgress.length });

  const summary: RecoverySummary = {
    inProgressCount: inProgress.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  if (inProgress.length === 0) {
    logger.info('recovery completed', summary);
    return summary;
  }

  // Project metadata は recovery 全体で 1 回だけ取得する
  let metadataResolved: Awaited<ReturnType<typeof resolveMetadata>>;
  try {
    metadataResolved = await resolveMetadata(deps);
  } catch (error) {
    throw new BootstrapError(
      'metadata_load_failed',
      `Recovery: Project metadata の取得に失敗しました: ${describeError(error)}`,
      { cause: error },
    );
  }
  const { projectId, statusFieldId, statusOptions } = metadataResolved;

  for (const candidate of inProgress) {
    if (signal.aborted) break;

    let repository: ReturnType<typeof parseRepositoryNameWithOwner>;
    try {
      repository = parseRepositoryNameWithOwner(candidate.repositoryNameWithOwner);
    } catch (error) {
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
      summary.skipped += 1;
      continue;
    }

    // 1. open PR 判定 (head.ref prefix で照合)
    const branchPrefix = `feature/${candidate.issueNumber}-`;
    let openPrs;
    try {
      openPrs = await deps.githubClient.listOpenPullRequests({
        owner: repository.owner,
        repo: repository.name,
        headBranchPrefix: branchPrefix,
      });
    } catch (error) {
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
      summary.skipped += 1;
      continue;
    }
    if (openPrs.length > 0) {
      const pr = openPrs[0]!;
      logger.info('recovery skip (open PR exists)', {
        issueNumber: candidate.issueNumber,
        headRef: pr.headRef,
        prNumber: pr.number,
      });
      summary.skipped += 1;
      continue;
    }

    // 2. Issue 取得 (本文 / state / labels / assignees)
    let issue;
    try {
      issue = await deps.githubClient.getIssue({
        owner: repository.owner,
        repo: repository.name,
        issueNumber: candidate.issueNumber,
      });
    } catch (error) {
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
      summary.skipped += 1;
      continue;
    }

    if (issue.state !== 'open') {
      logger.info('recovery skip (issue closed)', { issueNumber: candidate.issueNumber });
      summary.skipped += 1;
      continue;
    }

    const acceptable = isAcceptableIssue({
      labels: issue.labels,
      assignees: issue.assignees,
      agentUserLogin: deps.config.agentUserLogin,
    });
    if (!acceptable.ok) {
      // 既に In Progress まで進んだ Item を skip するのは過剰なので info 留めにとどめ、recover は試みる
      logger.info(`recovery: agent acceptance check failed (${acceptable.reason})`, {
        issueNumber: candidate.issueNumber,
      });
    }

    // 3. worktree が残っていれば force reset
    const taskKey = `issue-${candidate.issueNumber}`;
    const workspacePath = deps.workspaceManager.resolveWorkspacePath(taskKey);
    let workspaceExisted = false;
    try {
      workspaceExisted = await exists(workspacePath);
    } catch (error) {
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
      summary.skipped += 1;
      continue;
    }

    if (workspaceExisted) {
      // 強制 reset: 既存 worktree とローカル branch を削除してから新規作成する。
      // branch を消さないと dispatchSelected の createWorkspace({ reuse: false }) が
      // branch_already_exists で失敗してしまう。
      // NOTE: Issue title が前回 run 以降に変更されていた場合、再計算 slug が実体と
      //       食い違い branch 削除が空振りすることがある。MVP では title 不変前提
      //       (orchestration-mvp.md の Open Question に記載)。
      const recoveryBranch = `feature/${candidate.issueNumber}-${buildIssueSlug(candidate.issueTitle)}`;
      logger.info('recovery worktree force reset', {
        issueNumber: candidate.issueNumber,
        workspacePath,
        branch: recoveryBranch,
      });
      try {
        await deps.workspaceManager.cleanupWorkspace({
          taskKey,
          branch: recoveryBranch,
          deleteBranch: true,
        });
      } catch (error) {
        logger.warn('recovery dispatch error', {
          issueNumber: candidate.issueNumber,
          error: describeError(error),
        });
        summary.skipped += 1;
        continue;
      }
    }

    // 4. dispatchSelected 経由で再実行
    try {
      const result = await dispatchSelected({
        config: deps.config,
        repoRoot: deps.repoRoot,
        candidate,
        issue,
        repository,
        projectId,
        statusFieldId,
        statusOptions,
        githubClient: deps.githubClient,
        workspaceManager: deps.workspaceManager,
        workflowSource: deps.workflowSource,
        runnerLogsRoot: deps.runnerLogsRoot,
        remote: deps.remote,
        resolveAttempt: deps.resolveAttempt,
        runClaude: deps.runClaude,
        gitRunner: deps.gitRunner,
        baseLogger: logger,
        clock: deps.clock,
        generateRunId: deps.generateRunId,
      });
      summary.processed += 1;
      logRunResult(logger, candidate, result);
      if (result.kind === 'success') summary.succeeded += 1;
      else summary.failed += 1;
    } catch (error) {
      summary.processed += 1;
      summary.failed += 1;
      logger.warn('recovery dispatch error', {
        issueNumber: candidate.issueNumber,
        error: describeError(error),
      });
    }
  }

  logger.info('recovery completed', summary);
  return summary;
}

async function resolveMetadata(deps: RecoveryDeps): Promise<{
  projectId: string;
  statusFieldId: string;
  statusOptions: ReturnType<typeof resolveStatusOptions>;
}> {
  const metadata = await deps.projectsClient.fetchProjectMetadata({
    owner: deps.config.owner,
    projectNumber: deps.config.projectNumber,
    statusFieldName: deps.config.statusField,
  });
  return {
    projectId: metadata.projectId,
    statusFieldId: metadata.statusFieldId,
    statusOptions: resolveStatusOptions(metadata),
  };
}

function logRunResult(
  logger: Logger,
  candidate: Candidate,
  result: Extract<RunOnceResult, { kind: 'success' | 'failed' }>,
): void {
  if (result.kind === 'success') {
    logger.info('recovery dispatch success', {
      issueNumber: candidate.issueNumber,
      runId: result.runId,
      prNumber: result.prNumber,
    });
    return;
  }
  logger.warn('recovery dispatch failed', {
    issueNumber: candidate.issueNumber,
    runId: result.runId,
    reason: result.reason,
  });
}

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
