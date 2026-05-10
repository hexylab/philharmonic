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
import type { ConcurrentDispatchOutcome, RunOnceResult } from '../../src/orchestrator/index.js';
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
    workflowFile: '.philharmonic/WORKFLOW.md',
    agentUserLogin: null,
    permissionMode: 'auto',
    timeoutMs: 1_800_000,
    killGracePeriodMs: 5_000,
    workspaceRoot: '.philharmonic/worktrees',
    dispatchStatuses: ['Todo'],
    statusTransitions: { inProgress: 'In Progress', inReview: 'In Review', failed: 'Failed' },
    cleanRetentionDays: 7,
    logLevel: 'info',
    polling: { intervalMs: 30_000 },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 1,
      stallTimeoutMs: 300_000,
      maxRetryAttempts: 5,
      maxRetryBackoffMs: 300_000,
    },
    hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
    server: null,
    github: { tokenSource: 'auto' },
    safety: { allowBypassInServe: false },
    ...overrides,
  };
}

const fakeWorkflowSource = {
  render: vi.fn(async () => 'mocked-prompt'),
  close: vi.fn(async () => {}),
};
const fakeCreateWorkflowSource = vi.fn(async () => fakeWorkflowSource);

const fakeGitHub: GitHubClient = {
  getIssue: vi.fn(),
  listOpenPullRequests: vi.fn(),
};

const fakeProjects: ProjectsClient = {
  fetchProjectCandidates: vi.fn(),
};

const fakeWorkspace: WorkspaceManager = {
  resolveWorkspacePath: vi.fn(),
  createWorkspace: vi.fn(),
  cleanupWorkspace: vi.fn(),
  runHooks: vi.fn(async () => undefined),
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
      loadConfig: async () => fakeConfig(),
      resolveGitHubToken: async () => {
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 7_500 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 1_000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 1000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
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

  it('config.github.tokenSource を resolveGitHubToken にそのまま渡し、解決した token を setEnv で書き戻す (#68)', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const resolveSpy = vi.fn(async () => ({ token: 'gho_secret', origin: 'gh' as const }));
    const setEnvSpy = vi.fn();

    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: resolveSpy,
      setEnv: setEnvSpy,
      loadConfig: async () => fakeConfig({ github: { tokenSource: 'gh' } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
    });

    expect(resolveSpy).toHaveBeenCalledWith({ source: 'gh' });
    expect(setEnvSpy).toHaveBeenCalledWith('GITHUB_TOKEN', 'gho_secret');
  });

  it('解決した token はログ・stderr のいずれにも出力されない (#68)', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const TOKEN = 'gho_VERY_SECRET_TOKEN_VALUE_42';
    const debugSpy = vi.fn();
    const infoSpy = vi.fn();
    const warnSpy = vi.fn();
    const errorSpy = vi.fn();
    const fakeLogger = {
      level: 'info' as const,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
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
      resolveGitHubToken: async () => ({ token: TOKEN, origin: 'gh' as const }),
      loadConfig: async () => fakeConfig({ github: { tokenSource: 'auto' } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
    });

    const allOutputs: string[] = [];
    for (const spy of [streams.stdout.write, streams.stderr.write]) {
      for (const call of spy.mock.calls) {
        if (typeof call[0] === 'string') allOutputs.push(call[0]);
      }
    }
    for (const spy of [debugSpy, infoSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          allOutputs.push(typeof arg === 'string' ? arg : JSON.stringify(arg));
        }
      }
    }
    const joined = allOutputs.join('\n');
    expect(joined).not.toContain(TOKEN);
  });

  it('permission_mode=bypass + opt-in env なし → exit 1 (lock 取得前)', async () => {
    const streams = createStreams();
    const lock = createFakeLock();
    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig({ permissionMode: 'bypass' }),
      getEnv: () => undefined,
      acquireServeLock: lock.acquireSpy,
    });
    expect(streams.stderr.write).toHaveBeenCalledWith(expect.stringContaining(BYPASS_OPT_IN_ENV));
    expect(exit).toHaveBeenCalledWith(1);
    expect(lock.acquireSpy).not.toHaveBeenCalled();
  });

  it('permission_mode=bypass + safety.allow_bypass_in_serve: true なら起動する (env なし) (#68)', async () => {
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () =>
        fakeConfig({ permissionMode: 'bypass', safety: { allowBypassInServe: true } }),
      getEnv: () => undefined,
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('permission_mode=bypass で serve を起動します'),
      expect.objectContaining({ configOptIn: true }),
    );
    expect(lock.released).toBe(true);
  });

  it('permission_mode=bypass + env=1 + config=true (両方真) でも起動する (#68)', async () => {
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () =>
        fakeConfig({ permissionMode: 'bypass', safety: { allowBypassInServe: true } }),
      getEnv: (key) => (key === BYPASS_OPT_IN_ENV ? '1' : undefined),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
    });

    expect(lock.released).toBe(true);
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig({ permissionMode: 'bypass' }),
      getEnv: (key) => (key === BYPASS_OPT_IN_ENV ? '1' : undefined),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 2_000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
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

  it('serveLoop の前に recovery を実行し、同じ AbortSignal を共有する', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const order: string[] = [];

    const recoverySpy = vi.fn(async (deps: { signal: AbortSignal }) => {
      order.push('recovery');
      // signal が共有されている (= 同じ controller) ことを確認するため subscription emit で abort を伝播
      expect(deps.signal).toBeInstanceOf(AbortSignal);
      return {
        inProgressCount: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      };
    });
    const cleanupStaleSpy = vi.fn(async () => {
      order.push('staleCleanup');
      return { scanned: 0, removed: 0, failed: 0, skipped: 0 };
    });
    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      order.push('serveLoop');
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      recoverInProgress: recoverySpy as never,
      cleanupStaleWorktreesAtStartup: cleanupStaleSpy as never,
      createSignalSubscription: () => subscription,
    });

    expect(recoverySpy).toHaveBeenCalledTimes(1);
    expect(cleanupStaleSpy).toHaveBeenCalledTimes(1);
    expect(serveLoopMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['recovery', 'staleCleanup', 'serveLoop']);
    expect(lock.released).toBe(true);
  });

  it('recovery が throw しても daemon は serveLoop に進む (落とさない)', async () => {
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

    const recoverySpy = vi.fn(async () => {
      throw new Error('boom');
    });
    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      recoverInProgress: recoverySpy as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
    });

    expect(recoverySpy).toHaveBeenCalledTimes(1);
    expect(serveLoopMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'recovery aborted',
      expect.objectContaining({ error: 'boom' }),
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
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig({ polling: { intervalMs: 5_000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
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

  it('agent.maxConcurrentAgents > 1 のとき runConcurrent を呼び、各結果を slot 付きでログに出す (#24)', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const infoSpy = vi.fn();
    const warnSpy = vi.fn();
    const fakeLogger = {
      level: 'info' as const,
      debug: vi.fn(),
      info: infoSpy,
      warn: warnSpy,
      error: vi.fn(),
      child: vi.fn(),
    };
    fakeLogger.child.mockReturnValue(fakeLogger);

    const runConcurrentMock = vi.fn(
      async (): Promise<ConcurrentDispatchOutcome[]> => [
        {
          slot: 0,
          result: {
            kind: 'success',
            runId: 'rid-A',
            issueNumber: 11,
            branch: 'feature/11-x',
          },
        },
        {
          slot: 1,
          result: {
            kind: 'failed',
            runId: 'rid-B',
            issueNumber: 22,
            reason: 'runner_error',
            branch: 'feature/22-y',
          },
        },
      ],
    );

    const runOnceMock = vi.fn();
    const serveLoopMock = vi.fn(
      async (deps: { runOnce: () => Promise<RunOnceResult | undefined>; signal: AbortSignal }) => {
        const r = await deps.runOnce();
        // 並列パスでは undefined を返す (= serveLoop の result-log は抑制される)
        expect(r).toBeUndefined();
        subscription.emit('SIGTERM');
        await new Promise<void>((resolve) => {
          if (deps.signal.aborted) resolve();
          else deps.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () =>
        fakeConfig({
          agent: {
            maxConcurrentAgents: 3,
            maxTurns: 1,
            stallTimeoutMs: 300_000,
            maxRetryAttempts: 5,
            maxRetryBackoffMs: 300_000,
          },
        }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: runOnceMock as never,
      runConcurrent: runConcurrentMock as never,
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
    });

    expect(runConcurrentMock).toHaveBeenCalledTimes(1);
    const concurrentArg = runConcurrentMock.mock.calls[0]?.[0] as { maxConcurrent: number };
    expect(concurrentArg.maxConcurrent).toBe(3);
    expect(runOnceMock).not.toHaveBeenCalled();

    const successLog = infoSpy.mock.calls.find((c) => c[0] === 'dispatch success');
    expect(successLog?.[1]).toMatchObject({
      slot: 0,
      runId: 'rid-A',
      issueNumber: 11,
      branch: 'feature/11-x',
    });
    const failedLog = warnSpy.mock.calls.find((c) => c[0] === 'dispatch failed');
    expect(failedLog?.[1]).toMatchObject({
      slot: 1,
      runId: 'rid-B',
      issueNumber: 22,
      reason: 'runner_error',
    });
  });

  it('並列 dispatch で候補 0 件のときは no candidate を 1 行ログする', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const infoSpy = vi.fn();
    const fakeLogger = {
      level: 'info' as const,
      debug: vi.fn(),
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    fakeLogger.child.mockReturnValue(fakeLogger);

    const runConcurrentMock = vi.fn(async (): Promise<ConcurrentDispatchOutcome[]> => []);
    const runOnceMock = vi.fn();
    const serveLoopMock = vi.fn(
      async (deps: { runOnce: () => Promise<RunOnceResult | undefined>; signal: AbortSignal }) => {
        await deps.runOnce();
        subscription.emit('SIGTERM');
        await new Promise<void>((resolve) => {
          if (deps.signal.aborted) resolve();
          else deps.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () =>
        fakeConfig({
          agent: {
            maxConcurrentAgents: 2,
            maxTurns: 1,
            stallTimeoutMs: 300_000,
            maxRetryAttempts: 5,
            maxRetryBackoffMs: 300_000,
          },
        }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: runOnceMock as never,
      runConcurrent: runConcurrentMock as never,
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
    });

    const noCandidate = infoSpy.mock.calls.filter((c) => c[0] === 'no candidate');
    expect(noCandidate).toHaveLength(1);
  });

  it('config.server が null のときは snapshot api を起動しない (#30)', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const startSpy = vi.fn();
    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      startSnapshotApiServer: startSpy as never,
    });

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('config.server.port が指定されていれば snapshot api を起動して shutdown 時に close する (#30)', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const closeSpy = vi.fn(async () => undefined);
    const startSpy = vi.fn(async () => ({
      port: 4_000,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:4000',
      close: closeSpy,
    }));
    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig({ server: { port: 4_000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      startSnapshotApiServer: startSpy as never,
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
    const startArgs = startSpy.mock.calls[0]?.[0] as { port: number };
    expect(startArgs.port).toBe(4_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(lock.released).toBe(true);
  });

  it('snapshot api 起動失敗時は exit 1 で lock も release する (#30)', async () => {
    const streams = createStreams();
    const lock = createFakeLock();
    const startSpy = vi.fn(async () => {
      throw new Error('EADDRINUSE');
    });

    const { exit } = await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig({ server: { port: 4_000 } }),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      startSnapshotApiServer: startSpy as never,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(streams.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('snapshot api の起動に失敗しました'),
    );
    expect(lock.released).toBe(true);
  });

  it('serveLoop に acquireWakeSignal / onPollTick を注入する (#30)', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();

    const acquireSignalSpy = vi.fn(() => new AbortController().signal);
    const wakeController = {
      acquire: acquireSignalSpy,
      wake: vi.fn(() => true),
    };
    const tracker = {
      runStarted: vi.fn(),
      runFinished: vi.fn(),
      listRunning: vi.fn(() => []),
      getRunningByIssue: vi.fn(() => null),
      getTotals: vi.fn(() => ({
        runsCompleted: 0,
        runsSucceeded: 0,
        runsFailed: 0,
        totalCostUsd: 0,
      })),
      recordPollTick: vi.fn(),
      getLastPollTickAt: vi.fn(() => null),
      getStartedAt: vi.fn(() => '2026-05-09T00:00:00.000Z'),
    };

    const serveLoopMock = vi.fn(
      async (deps: {
        signal: AbortSignal;
        acquireWakeSignal?: () => AbortSignal | undefined;
        onPollTick?: () => void;
      }) => {
        deps.acquireWakeSignal?.();
        deps.onPollTick?.();
        subscription.emit('SIGTERM');
        await new Promise<void>((resolve) => {
          if (deps.signal.aborted) resolve();
          else deps.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createWakeController: () => wakeController,
      createRunTracker: () => tracker,
    });

    expect(acquireSignalSpy).toHaveBeenCalled();
    expect(tracker.recordPollTick).toHaveBeenCalled();
  });

  it('serve 起動時に retry queue を state file から復元し、release pass を実行する (ADR-0011)', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const infoSpy = vi.fn();
    const fakeLogger = {
      level: 'info' as const,
      debug: vi.fn(),
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    fakeLogger.child.mockReturnValue(fakeLogger);

    const restoredEntry = {
      kind: 'failure' as const,
      issueNumber: 42,
      repository: { owner: 'hexylab', name: 'philharmonic' },
      branch: 'feature/42-foo',
      workspacePath: '/abs/issue-42',
      attempt: 3,
      dueAt: new Date('2026-05-09T00:00:30Z'),
      scheduledAt: new Date('2026-05-09T00:00:00Z'),
      failureReason: 'runner_error' as const,
      lastRunId: 'r1',
      lastErrorSummary: null,
    };

    const loadSpy = vi.fn(async () => ({
      entries: [restoredEntry],
      outcome: { kind: 'restored' as const, count: 1 },
      invalidEntries: [],
    }));
    const releaseSpy = vi.fn(async () => ({
      inspected: 1,
      released: 0,
      retained: 1,
      skipped: 0,
    }));
    const storeSpy = { save: vi.fn(async () => {}), flush: vi.fn(async () => {}) };
    const createStoreSpy = vi.fn(() => storeSpy);

    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
      resolveRetryQueueStatePath: ({ repoRoot }) => `${repoRoot}/state.json`,
      loadRetryQueueEntries: loadSpy,
      createRetryQueueFileStore: createStoreSpy,
      releaseRestoredRetries: releaseSpy as never,
    });

    expect(loadSpy).toHaveBeenCalledWith('/tmp/repo/state.json');
    expect(createStoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/repo/state.json' }),
    );
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    const releaseArg = releaseSpy.mock.calls[0]?.[0] as { queue: { has: (n: number) => boolean } };
    expect(releaseArg.queue.has(42)).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      'retry queue restored',
      expect.objectContaining({ path: '/tmp/repo/state.json', count: 1 }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'retry queue restore release pass completed',
      expect.objectContaining({ released: 0, retained: 1 }),
    );
  });

  it('state file 不在のときは release pass を skip し empty で起動する', async () => {
    const streams = createStreams();
    const subscription = createFakeSubscription();
    const lock = createFakeLock();
    const infoSpy = vi.fn();
    const fakeLogger = {
      level: 'info' as const,
      debug: vi.fn(),
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    fakeLogger.child.mockReturnValue(fakeLogger);

    const loadSpy = vi.fn(async () => ({
      entries: [] as never[],
      outcome: { kind: 'empty' as const },
      invalidEntries: [],
    }));
    const releaseSpy = vi.fn();

    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
      resolveRetryQueueStatePath: () => '/tmp/repo/state.json',
      loadRetryQueueEntries: loadSpy,
      releaseRestoredRetries: releaseSpy as never,
    });

    expect(releaseSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      'retry queue restore empty',
      expect.objectContaining({ path: '/tmp/repo/state.json' }),
    );
  });

  it('state file の parse failure を warn ログにし empty で起動する', async () => {
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

    const loadSpy = vi.fn(async () => ({
      entries: [] as never[],
      outcome: {
        kind: 'parse_failed' as const,
        backupPath: '/tmp/repo/state.json.bak',
        error: new Error('bad json'),
      },
      invalidEntries: [],
    }));

    const serveLoopMock = vi.fn(async (deps: { signal: AbortSignal }) => {
      subscription.emit('SIGTERM');
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) resolve();
        else deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    await runCmd(streams, {
      cwd: () => '/tmp/repo',
      resolveGitHubToken: async () => ({ token: 'tok', origin: 'env' }),
      loadConfig: async () => fakeConfig(),
      createGitHubClient: () => fakeGitHub,
      createProjectsClient: () => fakeProjects,
      createWorkspaceManager: () => fakeWorkspace,
      createWorkflowSource: fakeCreateWorkflowSource,
      acquireServeLock: lock.acquireSpy,
      runOnce: vi.fn(),
      serveLoop: serveLoopMock as never,
      createSignalSubscription: () => subscription,
      createLogger: () => fakeLogger,
      resolveRetryQueueStatePath: () => '/tmp/repo/state.json',
      loadRetryQueueEntries: loadSpy,
    });

    expect(lock.released).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'retry queue restore parse failed',
      expect.objectContaining({
        path: '/tmp/repo/state.json',
        backupPath: '/tmp/repo/state.json.bak',
      }),
    );
  });
});
