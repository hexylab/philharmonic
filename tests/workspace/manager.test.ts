import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitCommandError,
  HookExecutionError,
  PathTraversalError,
  createWorkspaceManager,
  type GitRunner,
  type HookConfigMap,
  type HookExecutor,
} from '../../src/workspace/index.js';

const EMPTY_HOOKS: HookConfigMap = {
  after_create: [],
  before_run: [],
  after_run: [],
  before_remove: [],
};

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

  describe('lifecycle hooks', () => {
    it('createWorkspace 新規作成時 after_create hook を発火する', async () => {
      const hookExecutor = vi.fn(async () => undefined) as HookExecutor;
      const hooks: HookConfigMap = {
        ...EMPTY_HOOKS,
        after_create: [
          { command: 'pnpm', args: ['install'], timeoutMs: 60_000, onFailure: 'fail' },
        ],
      };

      const manager = createWorkspaceManager({
        repoRoot,
        workspaceRoot,
        runGit,
        hooks,
        hookExecutor,
      });

      await manager.createWorkspace({
        taskKey: 'issue-5',
        branch: 'feature/5-foo',
        baseRef: 'origin/main',
      });

      expect(hookExecutor).toHaveBeenCalledTimes(1);
      const call = vi.mocked(hookExecutor).mock.calls[0]?.[0];
      expect(call?.event).toBe('after_create');
      expect(call?.command).toBe('pnpm');
      expect(call?.cwd).toBe(path.join(workspaceRoot, 'issue-5'));
      expect(call?.env.PHILHARMONIC_TASK_KEY).toBe('issue-5');
    });

    it('reuse 時は after_create hook を発火しない', async () => {
      const target = path.join(workspaceRoot, 'issue-5');
      await mkdir(target, { recursive: true });
      fixture.worktreeList = [
        `worktree ${target}`,
        'HEAD abc',
        'branch refs/heads/feature/5-foo',
        '',
      ].join('\n');

      const hookExecutor = vi.fn(async () => undefined) as HookExecutor;
      const hooks: HookConfigMap = {
        ...EMPTY_HOOKS,
        after_create: [
          { command: 'pnpm', args: ['install'], timeoutMs: 60_000, onFailure: 'fail' },
        ],
      };

      const manager = createWorkspaceManager({
        repoRoot,
        workspaceRoot,
        runGit,
        hooks,
        hookExecutor,
      });

      const ws = await manager.createWorkspace({
        taskKey: 'issue-5',
        branch: 'feature/5-foo',
        baseRef: 'origin/main',
      });

      expect(ws.reused).toBe(true);
      expect(hookExecutor).not.toHaveBeenCalled();
    });

    it('after_create が on_failure=fail で失敗すると HookExecutionError を伝播する', async () => {
      const hookExecutor = vi.fn(async () => {
        throw new HookExecutionError('after_create', 'pnpm', 1, 'install failed', '');
      }) as HookExecutor;
      const hooks: HookConfigMap = {
        ...EMPTY_HOOKS,
        after_create: [
          { command: 'pnpm', args: ['install'], timeoutMs: 60_000, onFailure: 'fail' },
        ],
      };

      const manager = createWorkspaceManager({
        repoRoot,
        workspaceRoot,
        runGit,
        hooks,
        hookExecutor,
      });

      await expect(
        manager.createWorkspace({
          taskKey: 'issue-5',
          branch: 'feature/5-foo',
          baseRef: 'origin/main',
        }),
      ).rejects.toBeInstanceOf(HookExecutionError);
      // worktree add は実行された (hook は worktree add 後に発火する)
      expect(fixture.worktreeAdded).toHaveLength(1);
    });

    it('cleanupWorkspace は worktree remove 直前に before_remove hook を発火する', async () => {
      const target = path.join(workspaceRoot, 'issue-5');
      fixture.worktreeList = [`worktree ${target}`, 'branch refs/heads/feature/5-foo', ''].join(
        '\n',
      );

      const callOrder: string[] = [];
      const hookExecutor = vi.fn(async () => {
        callOrder.push('hook');
      }) as HookExecutor;
      runGit.mockImplementation(async (args) => {
        const argv = [...args];
        if (argv[0] === 'worktree' && argv[1] === 'list') {
          return { stdout: fixture.worktreeList, stderr: '' };
        }
        if (argv[0] === 'worktree' && argv[1] === 'remove') {
          callOrder.push('worktree-remove');
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const hooks: HookConfigMap = {
        ...EMPTY_HOOKS,
        before_remove: [{ command: 'cleanup', args: [], timeoutMs: 5_000, onFailure: 'fail' }],
      };

      const manager = createWorkspaceManager({
        repoRoot,
        workspaceRoot,
        runGit,
        hooks,
        hookExecutor,
      });

      await manager.cleanupWorkspace({ taskKey: 'issue-5' });

      expect(callOrder).toEqual(['hook', 'worktree-remove']);
    });

    it('before_remove hook が失敗しても cleanup は続行する (孤児 worktree 防止)', async () => {
      const target = path.join(workspaceRoot, 'issue-5');
      fixture.worktreeList = [`worktree ${target}`, 'branch refs/heads/feature/5-foo', ''].join(
        '\n',
      );

      const hookExecutor = vi.fn(async () => {
        throw new HookExecutionError('before_remove', 'cleanup', 1, 'fail', '');
      }) as HookExecutor;
      const hooks: HookConfigMap = {
        ...EMPTY_HOOKS,
        before_remove: [{ command: 'cleanup', args: [], timeoutMs: 5_000, onFailure: 'fail' }],
      };

      const manager = createWorkspaceManager({
        repoRoot,
        workspaceRoot,
        runGit,
        hooks,
        hookExecutor,
      });

      await expect(manager.cleanupWorkspace({ taskKey: 'issue-5' })).resolves.toBeUndefined();
      expect(fixture.worktreeRemoved).toEqual([target]);
    });

    it('runHooks() は orchestrator から before_run / after_run を発火するための API', async () => {
      const hookExecutor = vi.fn(async () => undefined) as HookExecutor;
      const hooks: HookConfigMap = {
        ...EMPTY_HOOKS,
        before_run: [{ command: 'precheck', args: [], timeoutMs: 5_000, onFailure: 'fail' }],
      };

      const manager = createWorkspaceManager({
        repoRoot,
        workspaceRoot,
        runGit,
        hooks,
        hookExecutor,
      });

      await manager.runHooks('before_run', {
        taskKey: 'issue-5',
        branch: 'feature/5-foo',
        workspacePath: path.join(workspaceRoot, 'issue-5'),
        baseRef: 'origin/main',
        extraEnv: { PHILHARMONIC_RUN_ID: 'rid' },
      });

      const call = vi.mocked(hookExecutor).mock.calls[0]?.[0];
      expect(call?.event).toBe('before_run');
      expect(call?.env.PHILHARMONIC_RUN_ID).toBe('rid');
    });
  });
});
