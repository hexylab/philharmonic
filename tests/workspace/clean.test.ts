import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  GitCommandError,
  type GitRunner,
  type IssueWorktree,
  listIssueWorktrees,
  selectExpiredWorktrees,
} from '../../src/workspace/index.js';

describe('selectExpiredWorktrees', () => {
  const now = new Date('2026-05-09T00:00:00.000Z');

  function fakeWorktree(taskKey: string, mtime: Date): IssueWorktree {
    return {
      taskKey,
      path: `/repo/.philharmonic/worktrees/${taskKey}`,
      branch: `feature/${taskKey}-foo`,
      mtimeMs: mtime.getTime(),
    };
  }

  it('retentionDays を超過した worktree のみが選ばれる', () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    const worktrees: IssueWorktree[] = [
      fakeWorktree('issue-1', new Date(now.getTime() - week - 1000)), // 古い
      fakeWorktree('issue-2', new Date(now.getTime() - week + 1000)), // 新しい (境界内)
      fakeWorktree('issue-3', new Date(now.getTime() - 2 * week)), // 非常に古い
      fakeWorktree('issue-4', new Date(now.getTime())), // たった今
    ];
    const result = selectExpiredWorktrees(worktrees, { now, retentionDays: 7 });
    expect(result.map((w) => w.taskKey)).toEqual(['issue-1', 'issue-3']);
  });

  it('境界 (mtime === threshold) は削除対象に含む', () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    const worktrees: IssueWorktree[] = [
      fakeWorktree('issue-1', new Date(now.getTime() - week)), // ちょうど 7 日前
    ];
    const result = selectExpiredWorktrees(worktrees, { now, retentionDays: 7 });
    expect(result).toHaveLength(1);
  });

  it('retentionDays=0 の場合はすべての worktree が削除対象', () => {
    const worktrees: IssueWorktree[] = [
      fakeWorktree('issue-1', new Date(now.getTime() - 1)),
      fakeWorktree('issue-2', new Date(now.getTime())),
    ];
    const result = selectExpiredWorktrees(worktrees, { now, retentionDays: 0 });
    expect(result.map((w) => w.taskKey)).toEqual(['issue-1', 'issue-2']);
  });

  it('worktrees が空配列なら空配列を返す', () => {
    expect(selectExpiredWorktrees([], { now, retentionDays: 7 })).toEqual([]);
  });
});

describe('listIssueWorktrees', () => {
  const repoRoot = '/repo';
  const workspaceRoot = '.philharmonic/worktrees';
  const workspaceRootAbs = path.resolve(repoRoot, workspaceRoot);

  function makePorcelain(entries: ReadonlyArray<{ path: string; branch?: string | null }>): string {
    const lines: string[] = [];
    for (const entry of entries) {
      lines.push(`worktree ${entry.path}`);
      lines.push('HEAD abc');
      if (entry.branch !== undefined && entry.branch !== null) {
        lines.push(`branch refs/heads/${entry.branch}`);
      } else {
        lines.push('detached');
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  it('issue-* で workspaceRoot 配下のものだけを返し、main worktree や他のディレクトリは無視する', async () => {
    const issue1Path = path.join(workspaceRootAbs, 'issue-1');
    const issue2Path = path.join(workspaceRootAbs, 'issue-42');
    const otherPath = path.join(workspaceRootAbs, 'scratch'); // issue-* ではない
    const outsidePath = '/elsewhere/feature-x'; // workspace root 外
    const porcelain = makePorcelain([
      { path: repoRoot, branch: 'main' }, // 主リポジトリ自体
      { path: issue1Path, branch: 'feature/1-foo' },
      { path: issue2Path, branch: 'feature/42-bar' },
      { path: otherPath, branch: 'feature/scratch' },
      { path: outsidePath, branch: 'feature/x' },
    ]);

    const runGit = vi.fn<Parameters<GitRunner>, ReturnType<GitRunner>>(async () => ({
      stdout: porcelain,
      stderr: '',
    }));

    const statFn = vi.fn(async (target: string) => ({ mtimeMs: target.length * 1000 }));

    const result = await listIssueWorktrees({
      runGit,
      repoRoot,
      workspaceRoot,
      statFn,
    });

    expect(result.map((w) => w.taskKey)).toEqual(['issue-1', 'issue-42']);
    expect(result.map((w) => w.branch)).toEqual(['feature/1-foo', 'feature/42-bar']);
    expect(result.map((w) => w.path)).toEqual([issue1Path, issue2Path]);
    expect(statFn).toHaveBeenCalledTimes(2);
  });

  it('detached HEAD の issue-* worktree も branch=null で列挙される', async () => {
    const issuePath = path.join(workspaceRootAbs, 'issue-9');
    const porcelain = makePorcelain([{ path: issuePath, branch: null }]);

    const runGit = vi.fn<Parameters<GitRunner>, ReturnType<GitRunner>>(async () => ({
      stdout: porcelain,
      stderr: '',
    }));
    const statFn = vi.fn(async () => ({ mtimeMs: 12345 }));

    const result = await listIssueWorktrees({ runGit, repoRoot, workspaceRoot, statFn });
    expect(result).toHaveLength(1);
    expect(result[0]?.branch).toBeNull();
    expect(result[0]?.mtimeMs).toBe(12345);
  });

  it('stat に失敗した worktree (path が存在しない) は無視する', async () => {
    const okPath = path.join(workspaceRootAbs, 'issue-1');
    const ghostPath = path.join(workspaceRootAbs, 'issue-2');
    const porcelain = makePorcelain([
      { path: okPath, branch: 'feature/1-ok' },
      { path: ghostPath, branch: 'feature/2-ghost' },
    ]);

    const runGit = vi.fn<Parameters<GitRunner>, ReturnType<GitRunner>>(async () => ({
      stdout: porcelain,
      stderr: '',
    }));

    const statFn = vi.fn(async (target: string) => {
      if (target === ghostPath) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return { mtimeMs: 1000 };
    });

    const result = await listIssueWorktrees({ runGit, repoRoot, workspaceRoot, statFn });
    expect(result.map((w) => w.taskKey)).toEqual(['issue-1']);
  });

  it('git worktree list が失敗したら GitCommandError を伝播する', async () => {
    const runGit = vi.fn<Parameters<GitRunner>, ReturnType<GitRunner>>(async () => {
      throw new GitCommandError(['worktree', 'list'], 128, '', '', repoRoot);
    });
    await expect(
      listIssueWorktrees({ runGit, repoRoot, workspaceRoot, statFn: async () => ({ mtimeMs: 0 }) }),
    ).rejects.toBeInstanceOf(GitCommandError);
  });
});
