import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { InvalidTaskKeyError, PathTraversalError } from '../../src/workspace/index.js';
import { resolveWorkspacePath, resolveWorkspaceRoot } from '../../src/workspace/paths.js';

const WORKSPACE_ROOT = '/tmp/philharmonic-test/workspaces';

describe('resolveWorkspaceRoot', () => {
  it('絶対パスはそのまま返す', () => {
    expect(resolveWorkspaceRoot('/repo', '/abs/workspace')).toBe('/abs/workspace');
  });

  it('相対パスは repoRoot 基準で解決する', () => {
    expect(resolveWorkspaceRoot('/repo', '.philharmonic/worktrees')).toBe(
      '/repo/.philharmonic/worktrees',
    );
  });

  it('repoRoot が相対パスの場合は InvalidTaskKeyError を投げる', () => {
    expect(() => resolveWorkspaceRoot('relative', '.philharmonic/worktrees')).toThrow(
      InvalidTaskKeyError,
    );
  });
});

describe('resolveWorkspacePath - path traversal 防止', () => {
  it('単純な taskKey は workspace root 配下に解決する', () => {
    const resolved = resolveWorkspacePath(WORKSPACE_ROOT, 'issue-5');
    expect(resolved).toBe(path.join(WORKSPACE_ROOT, 'issue-5'));
  });

  it('".." を含む taskKey は PathTraversalError', () => {
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, '..')).toThrow(PathTraversalError);
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, '../foo')).toThrow(PathTraversalError);
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, 'foo/../../bar')).toThrow(PathTraversalError);
  });

  it('絶対パスの taskKey は InvalidTaskKeyError', () => {
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, '/etc/passwd')).toThrow(InvalidTaskKeyError);
  });

  it('結果が workspace root と一致する taskKey は PathTraversalError', () => {
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, '.')).toThrow(PathTraversalError);
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, 'foo/..')).toThrow(PathTraversalError);
  });

  it('空文字 / whitespace は InvalidTaskKeyError', () => {
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, '')).toThrow(InvalidTaskKeyError);
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, '   ')).toThrow(InvalidTaskKeyError);
  });

  it('NUL 文字を含む taskKey は InvalidTaskKeyError', () => {
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, 'foo\0bar')).toThrow(InvalidTaskKeyError);
  });

  it('バックスラッシュを含む taskKey は InvalidTaskKeyError', () => {
    expect(() => resolveWorkspacePath(WORKSPACE_ROOT, 'foo\\bar')).toThrow(InvalidTaskKeyError);
  });

  it('ネストされたディレクトリ taskKey は配下なら許可される', () => {
    const resolved = resolveWorkspacePath(WORKSPACE_ROOT, 'sub/issue-5');
    expect(resolved).toBe(path.join(WORKSPACE_ROOT, 'sub', 'issue-5'));
  });
});
