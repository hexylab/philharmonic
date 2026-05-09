import type { GitRunner } from '../workspace/index.js';

export async function fetchBaseBranch(
  runGit: GitRunner,
  repoRoot: string,
  remote: string,
  baseBranch: string,
): Promise<void> {
  await runGit(['fetch', remote, baseBranch], { cwd: repoRoot });
}

export async function pushBranch(
  runGit: GitRunner,
  worktreePath: string,
  branch: string,
  remote: string,
): Promise<void> {
  await runGit(['push', '-u', remote, branch], { cwd: worktreePath });
}

export async function countCommitsAhead(
  runGit: GitRunner,
  worktreePath: string,
  baseRef: string,
): Promise<number> {
  const { stdout } = await runGit(['rev-list', '--count', `${baseRef}..HEAD`], {
    cwd: worktreePath,
  });
  const trimmed = stdout.trim();
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}
