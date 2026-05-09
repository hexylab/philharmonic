import { describe, expect, it, vi } from 'vitest';

import {
  createServeCommand,
  type ServeCommandDeps,
  type ServeSignalListener,
  type ServeSignalSubscription,
} from '../../src/cli/serve.js';
import type { Config } from '../../src/config/index.js';
import { ConfigFileNotFoundError } from '../../src/config/index.js';
import { GitHubTokenNotSetError, type GitHubClient } from '../../src/github/index.js';
import type { RunOnceResult } from '../../src/orchestrator/index.js';
import type { ProjectsClient } from '../../src/projects/index.js';
import type { WorkspaceManager } from '../../src/workspace/index.js';

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
    polling: { intervalMs: 30_000 },
    ...overrides,
  };
}

const fakeGitHub: GitHubClient = {
  getIssue: vi.fn(),
  commentIssue: vi.fn(),
  createPullRequest: vi.fn(),
  updateProjectV2ItemStatus: vi.fn(),
};

const fakeProjects: ProjectsClient = {
  fetchProjectCandidates: vi.fn(),
  fetchProjectMetadata: vi.fn(),
};

const fakeWorkspace: WorkspaceManager = {
  resolveWorkspacePath: vi.fn(),
  createWorkspace: vi.fn(),
  cleanupWorkspace: vi.fn(),
};

type FakeSubscription = ServeSignalSubscription & {
  emit: (signal: 'SIGTERM' | 'SIGINT') => void;
  disposed: boolean;
};

function createFakeSubscription(): FakeSubscription {
  const listeners: Array<{ signal: 'SIGTERM' | 'SIGINT'; listener: ServeSignalListener }> = [];
  const sub = {
    on: (signal: 'SIGTERM' | 'SIGINT', listener: ServeSignalListener) => {
      listeners.push({ signal, listener });
    },
    dispose: () => {
      sub.disposed = true;
      listeners.length = 0;
    },
    emit: (signal: 'SIGTERM' | 'SIGINT') => {
      for (const l of listeners) {
        if (l.signal === signal) l.listener(signal);
      }
    },
    disposed: false,
  };
  return sub;
}

async function runCmd(streams: Streams, deps: ServeCommandDeps, args: string[] = []) {
  const exit = vi.fn(() => {
    throw new Error('__exit__');
  });
  const cmd = createServeCommand({ ...deps, ...streams, exit: exit as never });
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if ((error as Error).message !== '__exit__') throw error;
  }
  return { exit };
}

describe('philharmonic serve CLI コマンド', () => {
  it('--help にコマンドの説明が含まれる', () => {
    const cmd = createServeCommand();
    expect(cmd.description()).toContain('ポーリング');
  });

  it('GITHUB_TOKEN 未設定時は exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => {
        throw new GitHubTokenNotSetError();
      },
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('GITHUB_TOKEN'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('config 読み込み失敗時は stderr に出して exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: vi.fn(async () => {
        throw new ConfigFileNotFoundError('/tmp/repo/philharmonic.yaml');
      }),
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('philharmonic.yaml'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('config.polling.intervalMs を serveLoop に引き渡す', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal; intervalMs: number }) => {
      // 即時 signal を立てて exit させる
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    // signal が抑止される前に subscription 経由で SIGTERM を投げる
    const onCalled = vi.fn(() => subscription.emit('SIGTERM'));
    serveLoopMock.mockImplementation(async (deps) => {
      onCalled();
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 7_500 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
    });

    expect(serveLoopMock).toHaveBeenCalledTimes(1);
    const arg = serveLoopMock.mock.calls[0]?.[0] as { intervalMs: number };
    expect(arg.intervalMs).toBe(7_500);
    expect(subscription.disposed).toBe(true);
  });

  it('SIGTERM 受信で in-flight run の完了を待ってから exit する (Acceptance Criteria)', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();

    let runOnceResolve!: (v: RunOnceResult) => void;
    const runOncePromise = new Promise<RunOnceResult>((res) => {
      runOnceResolve = res;
    });
    let runOnceFinishedAt: number | null = null;
    const runOnceMock = vi.fn(async () => {
      const r = await runOncePromise;
      runOnceFinishedAt = Date.now();
      return r;
    });

    // 実 serveLoop を使って end-to-end 検証する
    const { serveLoop } = await import('../../src/orchestrator/index.js');

    const cmdPromise = runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 50 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      runOnce: runOnceMock as never,
      serveLoop,
      createSignalSubscription: () => subscription,
    });

    // 少し待って runOnce が走り出すのを確認
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runOnceMock).toHaveBeenCalledTimes(1);
    expect(runOnceFinishedAt).toBeNull();

    // SIGTERM を投げる
    subscription.emit('SIGTERM');
    const sigtermAt = Date.now();

    // SIGTERM を投げただけでは終わらないことを確認
    let cmdResolved = false;
    void cmdPromise.then(() => {
      cmdResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cmdResolved).toBe(false);
    expect(runOnceFinishedAt).toBeNull();

    // run を完了させる
    runOnceResolve({ kind: 'no_candidate' });
    await cmdPromise;

    expect(runOnceMock).toHaveBeenCalledTimes(1);
    expect(runOnceFinishedAt).not.toBeNull();
    expect(runOnceFinishedAt!).toBeGreaterThanOrEqual(sigtermAt);
    expect(subscription.disposed).toBe(true);
  });

  it('SIGINT でも graceful shutdown する', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const runOnceMock = vi.fn(async (): Promise<RunOnceResult> => ({ kind: 'no_candidate' }));
    const { serveLoop } = await import('../../src/orchestrator/index.js');

    const cmdPromise = runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 1000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      runOnce: runOnceMock as never,
      serveLoop,
      createSignalSubscription: () => subscription,
    });

    // runOnce が走るまで待つ
    await new Promise((resolve) => setTimeout(resolve, 20));
    subscription.emit('SIGINT');

    await cmdPromise;
    expect(runOnceMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(subscription.disposed).toBe(true);
  });
});
