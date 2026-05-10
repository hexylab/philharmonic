import type { Config } from '../config/index.js';
import type { GitHubClient } from '../github/index.js';
import type { Logger } from '../logger/index.js';
import type { ProjectsClient } from '../projects/index.js';
import type { RunTracker } from '../server/index.js';
import {
  executeStaleCleanup,
  listIssueWorktrees,
  planStaleWorktreeCleanup,
  type GitRunner,
  type IssueWorktree,
  type ListIssueWorktreesInput,
  type WorkspaceManager,
} from '../workspace/index.js';

import { parseRepositoryNameWithOwner } from './repository.js';

export type CleanupStaleWorktreesAtStartupDeps = {
  config: Config;
  repoRoot: string;
  githubClient: GitHubClient;
  projectsClient: ProjectsClient;
  workspaceManager: WorkspaceManager;
  /** worktree 一覧用の git runner。テスト差し替え用 */
  gitRunner: GitRunner;
  /** 起動直後は空だが、tracker を共有し続けるための seam (将来 poll 内で呼ぶ場合に備える) */
  runTracker?: RunTracker;
  /** テスト差し替え用 seam。default は fs.stat ベースの本物 */
  listIssueWorktrees?: (input: ListIssueWorktreesInput) => Promise<IssueWorktree[]>;
  logger: Logger;
};

export type CleanupStaleWorktreesSummary = {
  scanned: number;
  removed: number;
  failed: number;
  skipped: number;
};

/**
 * `philharmonic serve` 起動直後 (recovery 完了後 / serveLoop 開始前) に呼ぶ stale worktree cleanup。
 *
 * - recovery は In Progress を引き取って worktree を force reset するため、cleanup は recovery の後で実施する
 * - daemon は serve.lock を取得済み + runTracker は空なので、安全条件 (active_run) は実質常に通る
 * - GitHub API / GraphQL 呼び出しに失敗しても daemon 起動は止めない (warn ログのみ)
 *
 * spec: docs/specs/orchestration-mvp.md#stale-worktree-cleanup
 */
export async function cleanupStaleWorktreesAtStartup(
  deps: CleanupStaleWorktreesAtStartupDeps,
): Promise<CleanupStaleWorktreesSummary> {
  const summary: CleanupStaleWorktreesSummary = {
    scanned: 0,
    removed: 0,
    failed: 0,
    skipped: 0,
  };

  const list = deps.listIssueWorktrees ?? listIssueWorktrees;

  try {
    const worktrees = await list({
      runGit: deps.gitRunner,
      repoRoot: deps.repoRoot,
      workspaceRoot: deps.config.workspaceRoot,
    });
    summary.scanned = worktrees.length;
    if (worktrees.length === 0) {
      deps.logger.info('stale cleanup: no issue worktrees');
      return summary;
    }

    const candidates = await deps.projectsClient.fetchProjectCandidates({
      owner: deps.config.owner,
      projectNumber: deps.config.projectNumber,
      statusFieldName: deps.config.statusField,
    });

    const plan = await planStaleWorktreeCleanup({
      worktrees,
      candidates,
      terminalStatuses: deps.config.terminalStatuses,
      githubClient: deps.githubClient,
      parseRepository: parseRepositoryNameWithOwner,
      isRunning: (issueNumber) =>
        deps.runTracker !== undefined && deps.runTracker.getRunningByIssue(issueNumber) !== null,
      logger: deps.logger,
    });

    const result = await executeStaleCleanup({
      plan,
      workspaceManager: deps.workspaceManager,
      logger: deps.logger,
    });
    summary.removed = result.removed;
    summary.failed = result.failed;
    summary.skipped = result.skipped;

    deps.logger.info('stale cleanup completed', {
      scanned: summary.scanned,
      removed: summary.removed,
      failed: summary.failed,
      skipped: summary.skipped,
    });
  } catch (error) {
    deps.logger.warn('stale cleanup aborted', { error: describeError(error) });
  }

  return summary;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
