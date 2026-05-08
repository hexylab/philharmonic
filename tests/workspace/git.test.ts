import { describe, expect, it } from 'vitest';

import { parseWorktreeList } from '../../src/workspace/git.js';

describe('parseWorktreeList', () => {
  it('空文字列は空配列を返す', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('複数 worktree を branch / detached / bare を含めて parse する', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/.philharmonic/worktrees/issue-5',
      'HEAD def456',
      'branch refs/heads/feature/5-foo',
      '',
      'worktree /repo/.philharmonic/worktrees/detached',
      'HEAD ghi789',
      'detached',
      '',
    ].join('\n');

    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/repo', branch: 'main', bare: false, detached: false },
      {
        path: '/repo/.philharmonic/worktrees/issue-5',
        branch: 'feature/5-foo',
        bare: false,
        detached: false,
      },
      {
        path: '/repo/.philharmonic/worktrees/detached',
        branch: null,
        bare: false,
        detached: true,
      },
    ]);
  });

  it('末尾改行が無くても parse する', () => {
    const porcelain = ['worktree /repo', 'branch refs/heads/main'].join('\n');
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/repo', branch: 'main', bare: false, detached: false },
    ]);
  });
});
