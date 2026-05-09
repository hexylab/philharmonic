import { describe, expect, it, vi } from 'vitest';

import {
  BYPASS_OPT_IN_ENV,
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
import { ServeLockHeldError, type ServeLockHandle } from '../../src/serve/index.js';
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

type FakeLock = {
  handle: ServeLockHandle;
  released: boolean;
  acquireSpy: ReturnType<typeof vi.fn>;
};

function createFakeLock(lockPath = '/tmp/repo/.philharmonic/serve.lock'): FakeLock {
  const state = { released: false };
  const handle: ServeLockHandle = {
    lockPath,
    contents: { pid: 1234, hostname: 'host-a', startedAt: '2026-05-09T00:00:00.000Z' },
    release: vi.fn(async () => {
      state.released = true;
    }),
  };
  const acquireSpy = vi.fn(async () => handle);
  return {
    handle,
    get released() {
      return state.released;
    },
    acquireSpy,
  };
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
    const lock = createFakeLock();
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => {
        throw new GitHubTokenNotSetError();
      },
      acquireServeLock: lock.acquireSpy,
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('GITHUB_TOKEN'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(lock.acquireSpy).not.toHaveBeenCalled();
  });

  it('config 読み込み失敗時は stderr に出して exit 1', async () => {
    const streams = createStreams();
    const lock = createFakeLock();
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: vi.fn(async () => {
        throw new ConfigFileNotFoundError('/tmp/repo/philharmonic.yaml');
      }),
      acquireServeLock: lock.acquireSpy,
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining('philharmonic.yaml'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(lock.acquireSpy).not.toHaveBeenCalled();
  });

  it('config.polling.intervalMs を serveLoop に引き渡し、終了時に lock を release する', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal; intervalMs: number }) => {
      subscription.emit('SIGTERM');
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
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
    });

    expect(serveLoopMock).toHaveBeenCalledTimes(1);
    const arg = serveLoopMock.mock.calls[0]?.[0] as { intervalMs: number };
    expect(arg.intervalMs).toBe(7_500);
    expect(subscription.disposed).toBe(true);
    expect(lock.acquireSpy).toHaveBeenCalledTimes(1);
    expect(lock.released).toBe(true);
  });

  it('SIGTERM 受信で in-flight run の完了を待ってから exit する (Acceptance Criteria)', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();

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

    const { serveLoop } = await import('../../src/orchestrator/index.js');

    const cmdPromise = runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 1_000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      acquireServeLock: lock.acquireSpy,
      runOnce: runOnceMock as never,
      serveLoop,
      createSignalSubscription: () => subscription,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runOnceMock).toHaveBeenCalledTimes(1);
    expect(runOnceFinishedAt).toBeNull();

    subscription.emit('SIGTERM');
    const sigtermAt = Date.now();

    let cmdResolved = false;
    void cmdPromise.then(() => {
      cmdResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cmdResolved).toBe(false);
    expect(runOnceFinishedAt).toBeNull();

    runOnceResolve({ kind: 'no_candidate' });
    await cmdPromise;

    expect(runOnceMock).toHaveBeenCalledTimes(1);
    expect(runOnceFinishedAt).not.toBeNull();
    expect(runOnceFinishedAt!).toBeGreaterThanOrEqual(sigtermAt);
    expect(subscription.disposed).toBe(true);
    expect(lock.released).toBe(true);
  });

  it('SIGINT でも graceful shutdown する', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const runOnceMock = vi.fn(async (): Promise<RunOnceResult> => ({ kind: 'no_candidate' }));
    const { serveLoop } = await import('../../src/orchestrator/index.js');

    const cmdPromise = runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 1000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      acquireServeLock: lock.acquireSpy,
      runOnce: runOnceMock as never,
      serveLoop,
      createSignalSubscription: () => subscription,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    subscription.emit('SIGINT');

    await cmdPromise;
    expect(runOnceMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(subscription.disposed).toBe(true);
    expect(lock.released).toBe(true);
  });

  it('lock 取得失敗 (二重起動) で exit 1', async () => {
    const streams = createStreams();
    const acquire = vi.fn(async () => {
      throw new ServeLockHeldError(
        '/tmp/repo/.philharmonic/serve.lock',
        9999,
        'host-a',
        '2026-05-09T00:00:00.000Z',
      );
    });
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      acquireServeLock: acquire,
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('serve は既に起動中の可能性があります'),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('serveLoop が例外を投げても finally で lock を release する', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const serveLoopMock = vi.fn(async () => {
      throw new Error('boom');
    });

    let caught: unknown = null;
    const exit = vi.fn(() => {
      throw new Error('__exit__');
    });
    const cmd = createServeCommand({
      ...streams,
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      exit: exit as never,
    });
    try {
      await cmd.parseAsync([], { from: 'user' });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('boom');
    expect(lock.released).toBe(true);
    expect(subscription.disposed).toBe(true);
  });

  it('permission_mode=bypass + opt-in env なし → exit 1 (lock 取得前)', async () => {
    const streams = createStreams();
    const lock = createFakeLock();
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ permissionMode: 'bypass' }),
      getEnv: () => undefined,
      acquireServeLock: lock.acquireSpy,
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining(BYPASS_OPT_IN_ENV));
    expect(exit).toHaveBeenCalledWith(1);
    expect(lock.acquireSpy).not.toHaveBeenCalled();
  });

  it('permission_mode=bypass + opt-in env=1 なら起動して警告ログを出す', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const warnSpy = vi.fn();
    const fakeLogger = {
      level: 'info' as const,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      child: vi.fn(),
    };
    fakeLogger.child.mockReturnValue(fakeLogger);

    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ permissionMode: 'bypass' }),
      getEnv: (key) => (key === BYPASS_OPT_IN_ENV ? '1' : undefined),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('permission_mode=bypass で serve を起動します'),
      expect.objectContaining({ optInEnv: BYPASS_OPT_IN_ENV }),
    );
    expect(lock.released).toBe(true);
  });

  it('polling.intervalMs が 5000ms 未満なら警告ログを出す', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const warnSpy = vi.fn();
    const fakeLogger = {
      level: 'info' as const,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      child: vi.fn(),
    };
    fakeLogger.child.mockReturnValue(fakeLogger);

    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 2_000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('polling.interval_ms が低く設定されています'),
      expect.objectContaining({ intervalMs: 2_000 }),
    );
  });

  it('polling.intervalMs >= 5000ms なら警告ログを出さない', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const warnSpy = vi.fn();
    const fakeLogger = {
      level: 'info' as const,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      child: vi.fn(),
    };
    fakeLogger.child.mockReturnValue(fakeLogger);

    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      getToken: () => 'tok',
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 5_000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
    });

    const lowPollingWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('polling.interval_ms が低く'),
    );
    expect(lowPollingWarnings).toHaveLength(0);
  });
});
