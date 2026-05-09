import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createCleanCommand,
  shouldDeleteBranch,
  type CleanCommandDeps,
} from '../../src/cli/clean.js';
import { ConfigFileNotFoundError, type Config } from '../../src/config/index.js';
import type { IssueWorktree, WorkspaceManager } from '../../src/workspace/index.js';

type Streams = {
  stdout: { write: ReturnType<typeof vi.fn> };
  stderr: { write: ReturnType<typeof vi.fn> };
};

function createStreams(): Streams {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    owner: 'hexylab',
    projectNumber: 1,
    baseBranch: 'main',
    statusField: 'Status',
    agentUserLogin: null,
    permissionMode: 'auto',
    timeoutMs: 1_800_000,
    killGracePeriodMs: 5_000,
    workspaceRoot: '.philharmonic/worktrees',
    dispatchStatuses: ['Todo'],
    cleanRetentionDays: 7,
    logLevel: 'info',
    ...overrides,
  };
}

function fakeWorkspaceManager(): WorkspaceManager {
  return {
    resolveWorkspacePath: vi.fn(),
    createWorkspace: vi.fn(),
    cleanupWorkspace: vi.fn(async () => undefined),
  };
}

const REPO_ROOT = '/tmp/repo';
const NOW = new Date('2026-05-09T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function fakeWorktree(taskKey: string, ageDays: number, branch: string | null): IssueWorktree {
  return {
    taskKey,
    path: path.join(REPO_ROOT, '.philharmonic/worktrees', taskKey),
    branch,
    mtimeMs: NOW.getTime() - ageDays * DAY,
  };
}

async function runCmd(streams: Streams, deps: CleanCommandDeps, args: string[] = []) {
  const exit = vi.fn(() => {
    throw new Error('__exit__');
  });
  const cmd = createCleanCommand({ ...deps, ...streams, exit: exit as never });
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if ((error as Error).message !== '__exit__') throw error;
  }
  return { exit };
}

describe('shouldDeleteBranch', () => {
  it('feature/<issue-number>- 形式に一致する branch のみ削除許可する', () => {
    expect(shouldDeleteBranch('issue-5', 'feature/5-foo')).toBe(true);
    expect(shouldDeleteBranch('issue-42', 'feature/42-add-login')).toBe(true);
  });

  it('main や他のブランチが checkout されていても削除許可しない', () => {
    expect(shouldDeleteBranch('issue-5', 'main')).toBe(false);
    expect(shouldDeleteBranch('issue-5', 'develop')).toBe(false);
    expect(shouldDeleteBranch('issue-5', 'feature/6-other')).toBe(false);
    expect(shouldDeleteBranch('issue-5', 'release/1.0')).toBe(false);
  });

  it('branch が null (detached HEAD) なら削除許可しない', () => {
    expect(shouldDeleteBranch('issue-5', null)).toBe(false);
  });

  it('issue-<番号> 形式に合致しない taskKey なら削除許可しない (理論上は ListIssueWorktrees で弾かれる安全網)', () => {
    expect(shouldDeleteBranch('scratch', 'feature/5-foo')).toBe(false);
    expect(shouldDeleteBranch('issue-', 'feature/5-foo')).toBe(false);
  });
});

describe('philharmonic clean CLI コマンド', () => {
  it('--help にコマンドの説明と --dry-run / --retention-days オプションが含まれる', () => {
    const cmd = createCleanCommand();
    const helpText = cmd.helpInformation();
    expect(cmd.description()).toContain('retention');
    expect(helpText).toContain('--dry-run');
    expect(helpText).toContain('--retention-days');
    expect(helpText).toContain('--config');
  });

  it('config 読み込み失敗時は stderr に出して exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(streams, {
      cwd: () => REPO_ROOT,
      now: () => NOW,
      loadConfig: vi.fn(async () => {
        throw new ConfigFileNotFoundError('/tmp/repo/philharmonic.yaml');
      }),
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('philharmonic.yaml'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('retention 経過済みのみが cleanupWorkspace に渡される (新しい worktree は保護される)', async () => {
    const streams = createStreams();
    const expired = fakeWorktree('issue-1', 10, 'feature/1-foo');
    const fresh = fakeWorktree('issue-2', 1, 'feature/2-bar');

    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(streams, {
      cwd: () => REPO_ROOT,
      now: () => NOW,
      loadConfig: async () => fakeConfig({ cleanRetentionDays: 7 }),
      listIssueWorktrees: async () => [expired, fresh],
      createWorkspaceManager: () => manager,
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith({
      taskKey: 'issue-1',
      branch: 'feature/1-foo',
      deleteBranch: true,
    });
  });

  it('--dry-run の場合は cleanupWorkspace を一切呼ばず、stdout に削除候補を表示する', async () => {
    const streams = createStreams();
    const expired = fakeWorktree('issue-1', 10, 'feature/1-foo');

    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        now: () => NOW,
        loadConfig: async () => fakeConfig({ cleanRetentionDays: 7 }),
        listIssueWorktrees: async () => [expired],
        createWorkspaceManager: () => manager,
      },
      ['--dry-run'],
    );

    expect(cleanupSpy).not.toHaveBeenCalled();
    const written = streams.stdout.write.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('dry-run');
    expect(written).toContain('issue-1');
    expect(written).toContain('feature/1-foo');
  });

  it('--retention-days で config 値を上書きできる', async () => {
    const streams = createStreams();
    // 5 日前の worktree。config (7d) では保護されるが --retention-days=3 にすると削除対象になる
    const wt = fakeWorktree('issue-3', 5, 'feature/3-baz');

    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        now: () => NOW,
        loadConfig: async () => fakeConfig({ cleanRetentionDays: 7 }),
        listIssueWorktrees: async () => [wt],
        createWorkspaceManager: () => manager,
      },
      ['--retention-days', '3'],
    );

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith({
      taskKey: 'issue-3',
      branch: 'feature/3-baz',
      deleteBranch: true,
    });
  });

  it('削除候補が無いときは "no worktrees to clean" を stdout に出して exit 0', async () => {
    const streams = createStreams();
    const fresh = fakeWorktree('issue-1', 1, 'feature/1-foo');

    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    const { exit } = await runCmd(streams, {
      cwd: () => REPO_ROOT,
      now: () => NOW,
      loadConfig: async () => fakeConfig({ cleanRetentionDays: 7 }),
      listIssueWorktrees: async () => [fresh],
      createWorkspaceManager: () => manager,
    });

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(streams.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('no worktrees to clean'),
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('detached HEAD の worktree は deleteBranch=false で削除する', async () => {
    const streams = createStreams();
    const detached = fakeWorktree('issue-7', 30, null);

    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(streams, {
      cwd: () => REPO_ROOT,
      now: () => NOW,
      loadConfig: async () => fakeConfig({ cleanRetentionDays: 7 }),
      listIssueWorktrees: async () => [detached],
      createWorkspaceManager: () => manager,
    });

    expect(cleanupSpy).toHaveBeenCalledWith({
      taskKey: 'issue-7',
      branch: undefined,
      deleteBranch: false,
    });
  });

  it('cleanupWorkspace が一部失敗しても他は処理を続け、最後に exit 1', async () => {
    const streams = createStreams();
    const wt1 = fakeWorktree('issue-1', 10, 'feature/1-foo');
    const wt2 = fakeWorktree('issue-2', 10, 'feature/2-bar');

    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;
    cleanupSpy.mockImplementation(async (input: { taskKey: string }) => {
      if (input.taskKey === 'issue-1') throw new Error('boom');
      return undefined;
    });

    const { exit } = await runCmd(streams, {
      cwd: () => REPO_ROOT,
      now: () => NOW,
      loadConfig: async () => fakeConfig({ cleanRetentionDays: 7 }),
      listIssueWorktrees: async () => [wt1, wt2],
      createWorkspaceManager: () => manager,
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    const stderrWritten = streams.stderr.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stderrWritten).toContain('issue-1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('issue-* worktree が main を checkout していても main は削除しない (構造的 guard)', async () => {
    const streams = createStreams();
    // 想定外シナリオ: issue-5 ディレクトリが main を checkout している (運用ミスや復旧シナリオ)
    const wt: IssueWorktree = {
      taskKey: 'issue-5',
      path: path.join(REPO_ROOT, '.philharmonic/worktrees/issue-5'),
      branch: 'main',
      mtimeMs: NOW.getTime() - 30 * DAY,
    };

    const manager = fakeWorkspaceManager();
    const cleanupSpy = manager.cleanupWorkspace as ReturnType<typeof vi.fn>;

    await runCmd(streams, {
      cwd: () => REPO_ROOT,
      now: () => NOW,
      loadConfig: async () => fakeConfig({ cleanRetentionDays: 7 }),
      listIssueWorktrees: async () => [wt],
      createWorkspaceManager: () => manager,
    });

    // worktree 本体は削除されるが、deleteBranch は false で渡されるため main には触らない
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith({
      taskKey: 'issue-5',
      branch: undefined,
      deleteBranch: false,
    });
    const stderrWritten = streams.stderr.write.mock.calls.map((c) => c[0] as string).join('');
    expect(stderrWritten).toContain('skip branch delete');
    expect(stderrWritten).toContain('main');
  });

  it('--retention-days に負数を指定すると Commander が拒否する', async () => {
    const cmd = createCleanCommand({
      cwd: () => REPO_ROOT,
      now: () => NOW,
      loadConfig: async () => fakeConfig(),
      listIssueWorktrees: async () => [],
      createWorkspaceManager: () => fakeWorkspaceManager(),
      stdout: process.stdout,
      stderr: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      exit: ((code: number) => {
        throw new Error(`__exit__${code}`);
      }) as never,
    });
    cmd.exitOverride();
    await expect(cmd.parseAsync(['--retention-days', '-1'], { from: 'user' })).rejects.toThrow();
  });
});
