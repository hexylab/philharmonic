import { defaultGitRunner, type GitRunner } from '../workspace/index.js';

/**
 * `git fetch origin <baseBranch>` を Orchestrator から実行する。
 *
 * `WorkspaceManager.createWorkspace` 自体は `git worktree add` だけを行うため、
 * `origin/<baseBranch>` を起点にした worktree を fresh な状態にするには
 * 直前にこの関数で fetch を済ませておく必要がある。
 *
 * spec: docs/specs/orchestration-mvp.md「3. Workspace Provisioning」
 */
export async function fetchBaseBranch(
  runGit: GitRunner,
  repoRoot: string,
  remote: string,
  baseBranch: string,
): Promise<void> {
  await runGit(['fetch', remote, baseBranch], { cwd: repoRoot });
}

export { defaultGitRunner };
