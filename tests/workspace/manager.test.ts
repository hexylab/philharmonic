import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitCommandError,
  PathTraversalError,
  createWorkspaceManager,
  type GitRunner,
} from '../../src/workspace/index.js';

type RunGitMock = ReturnType<typeof vi.fn<Parameters<GitRunner>, ReturnType<GitRunner>>>;

type GitFixture = {
  worktreeList: string;
  branchExists: Set<string>;
  worktreeAdded: string[];
  worktreeRemoved: string[];
  branchDeleted: string[];
};

function createRunGit(fixture: GitFixture): RunGitMock {
  const runGit = vi.fn<Parameters<GitRunner>, ReturnType<GitRunner>>(async (args) => {
    const argv = [...args];
    if (argv[0] === 'worktree' && argv[1] === 'list' && argv[2] === '--porcelain') {
      return { stdout: fixture.worktreeList, stderr: '' };
    }
    if (argv[0] === 'worktree' && argv[1] === 'add') {
      const target = argv[2] ?? '';
      const branch = argv[4] ?? '';
      fixture.worktreeAdded.push(`${branch}|${target}`);
      return { stdout: '', stderr: '' };
    }
    if (argv[0] === 'worktree' && argv[1] === 'remove') {
      const target = argv[3] ?? '';
      fixture.worktreeRemoved.push(target);
      return { stdout: '', stderr: '' };
    }
    if (argv[0] === 'show-ref') {
      const ref = argv[3] ?? '';
      const branch = ref.replace(/^refs\/heads\//, '');
      if (fixture.branchExists.has(branch)) {
        return { stdout: '', stderr: '' };
      }
      throw new GitCommandError(args, 1, '', '', '/repo');
    }
    if (argv[0] === 'branch' && argv[1] === '-D') {
      const branch = argv[2] ?? '';
      fixture.branchDeleted.push(branch);
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected git invocation: git ${argv.join(' ')}`);
  });
  return runGit;
}

describe('createWorkspaceManager', () => {
  let repoRoot: string;
  let workspaceRoot: string;
  let fixture: GitFixture;
  let runGit: RunGitMock;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'philharmonic-repo-'));
    workspaceRoot = path.join(repoRoot, '.philharmonic', 'worktrees');
    fixture = {
      worktreeList: '',
      branchExists: new Set<string>(),
      worktreeAdded: [],
      worktreeRemoved: [],
      branchDeleted: [],
    };
    runGit = createRunGit(fixture);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('新規 workspace を作成する場合 git worktree add を呼び reused=false を返す', async () => {
    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    const ws = await manager.createWorkspace({
      taskKey: 'issue-5',
      branch: 'feature/5-foo',
      baseRef: 'origin/main',
    });

    expect(ws.reused).toBe(false);
    expect(ws.taskKey).toBe('issue-5');
    expect(ws.branch).toBe('feature/5-foo');
    expect(ws.path).toBe(path.join(workspaceRoot, 'issue-5'));
    expect(fixture.worktreeAdded).toHaveLength(1);
    expect(fixture.worktreeAdded[0]).toBe(`feature/5-foo|${ws.path}`);
  });

  it('既存 worktree が path / branch 共に一致するなら再利用する', async () => {
    const target = path.join(workspaceRoot, 'issue-5');
    await mkdir(target, { recursive: true });
    fixture.worktreeList = [
      `worktree ${target}`,
      'HEAD abc',
      'branch refs/heads/feature/5-foo',
      '',
    ].join('\n');

    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    const ws = await manager.createWorkspace({
      taskKey: 'issue-5',
      branch: 'feature/5-foo',
      baseRef: 'origin/main',
    });

    expect(ws.reused).toBe(true);
    expect(fixture.worktreeAdded).toHaveLength(0);
  });

  it('既存 worktree が path 一致 / branch 不一致なら WorkspaceConflictError', async () => {
    const target = path.join(workspaceRoot, 'issue-5');
    await mkdir(target, { recursive: true });
    fixture.worktreeList = [
      `worktree ${target}`,
      'HEAD abc',
      'branch refs/heads/feature/5-other',
      '',
    ].join('\n');

    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    await expect(
      manager.createWorkspace({
        taskKey: 'issue-5',
        branch: 'feature/5-foo',
        baseRef: 'origin/main',
      }),
    ).rejects.toMatchObject({ name: 'WorkspaceConflictError', reason: 'branch_mismatch' });
  });

  it('reuse=false で既存 worktree がある場合は WorkspaceConflictError', async () => {
    const target = path.join(workspaceRoot, 'issue-5');
    await mkdir(target, { recursive: true });
    fixture.worktreeList = [
      `worktree ${target}`,
      'HEAD abc',
      'branch refs/heads/feature/5-foo',
      '',
    ].join('\n');

    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    await expect(
      manager.createWorkspace({
        taskKey: 'issue-5',
        branch: 'feature/5-foo',
        baseRef: 'origin/main',
        reuse: false,
      }),
    ).rejects.toMatchObject({ name: 'WorkspaceConflictError', reason: 'worktree_path_in_use' });
  });

  it('reuse=false で同名ローカルブランチがある場合は WorkspaceConflictError', async () => {
    fixture.branchExists.add('feature/5-foo');

    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    await expect(
      manager.createWorkspace({
        taskKey: 'issue-5',
        branch: 'feature/5-foo',
        baseRef: 'origin/main',
        reuse: false,
      }),
    ).rejects.toMatchObject({ name: 'WorkspaceConflictError', reason: 'branch_already_exists' });
  });

  it('既存 worktree のパスが存在しない場合 worktree_path_missing で衝突として扱う', async () => {
    const ghostPath = path.join(workspaceRoot, 'issue-5');
    fixture.worktreeList = [
      `worktree ${ghostPath}`,
      'HEAD abc',
      'branch refs/heads/feature/5-foo',
      '',
    ].join('\n');

    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    await expect(
      manager.createWorkspace({
        taskKey: 'issue-5',
        branch: 'feature/5-foo',
        baseRef: 'origin/main',
      }),
    ).rejects.toMatchObject({ name: 'WorkspaceConflictError', reason: 'worktree_path_missing' });
  });

  it('git worktree add が失敗した場合 GitCommandError を伝播する', async () => {
    runGit.mockImplementation(async (args) => {
      const argv = [...args];
      if (argv[0] === 'worktree' && argv[1] === 'list') {
        return { stdout: '', stderr: '' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'add') {
        throw new GitCommandError(args, 128, 'fatal: invalid reference', '', repoRoot);
      }
      throw new Error(`unexpected: git ${argv.join(' ')}`);
    });

    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    await expect(
      manager.createWorkspace({
        taskKey: 'issue-5',
        branch: 'feature/5-foo',
        baseRef: 'origin/missing',
      }),
    ).rejects.toBeInstanceOf(GitCommandError);
  });

  it('path traversal は拒否される', async () => {
    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    await expect(
      manager.createWorkspace({
        taskKey: '../escape',
        branch: 'feature/5-foo',
        baseRef: 'origin/main',
      }),
    ).rejects.toBeInstanceOf(PathTraversalError);
  });

  it('cleanupWorkspace は登録済みの worktree を remove する', async () => {
    const target = path.join(workspaceRoot, 'issue-5');
    fixture.worktreeList = [`worktree ${target}`, 'branch refs/heads/feature/5-foo', ''].join('\n');

    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    await manager.cleanupWorkspace({ taskKey: 'issue-5' });

    expect(fixture.worktreeRemoved).toEqual([target]);
    expect(fixture.branchDeleted).toEqual([]);
  });

  it('cleanupWorkspace は未登録の worktree に対して no-op で完了する (冪等)', async () => {
    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    await expect(manager.cleanupWorkspace({ taskKey: 'issue-5' })).resolves.toBeUndefined();
    expect(fixture.worktreeRemoved).toEqual([]);
  });

  it('cleanupWorkspace は deleteBranch=true で git branch -D も実行する', async () => {
    const target = path.join(workspaceRoot, 'issue-5');
    fixture.worktreeList = [`worktree ${target}`, 'branch refs/heads/feature/5-foo', ''].join('\n');
    fixture.branchExists.add('feature/5-foo');

    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });

    await manager.cleanupWorkspace({
      taskKey: 'issue-5',
      branch: 'feature/5-foo',
      deleteBranch: true,
    });

    expect(fixture.worktreeRemoved).toEqual([target]);
    expect(fixture.branchDeleted).toEqual(['feature/5-foo']);
  });

  it('resolveWorkspacePath は ファイルシステムを触らずに絶対パスを返す', () => {
    const manager = createWorkspaceManager({ repoRoot, workspaceRoot, runGit });
    expect(manager.resolveWorkspacePath('issue-5')).toBe(path.join(workspaceRoot, 'issue-5'));
    expect(runGit).not.toHaveBeenCalled();
  });
});
