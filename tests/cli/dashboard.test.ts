import { describe, expect, it, vi } from 'vitest';

import { createDashboardCommand, type DashboardCommandDeps } from '../../src/cli/dashboard.js';
import { DashboardConnectionError, type DashboardClient } from '../../src/dashboard/client.js';
import type { Config } from '../../src/config/index.js';
import type { StateSnapshot } from '../../src/server/index.js';

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
    agent: { maxConcurrentAgents: 1, maxTurns: 1, stallTimeoutMs: 300_000 },
    hooks: { afterCreate: [], beforeRun: [], afterRun: [], beforeRemove: [] },
    server: null,
    github: { tokenSource: 'auto' },
    safety: { allowBypassInServe: false },
    ...overrides,
  };
}

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    started_at: '2026-05-09T00:00:00.000Z',
    uptime_ms: 60_000,
    polling: { interval_ms: 30_000, last_tick_at: null },
    running: [],
    totals: { runs_completed: 0, runs_succeeded: 0, runs_failed: 0, total_cost_usd: 0 },
    ...overrides,
  };
}

function fakeClient(impl: Partial<DashboardClient> = {}): DashboardClient {
  return {
    host: '127.0.0.1',
    port: 4000,
    baseUrl: 'http://127.0.0.1:4000',
    fetchState: impl.fetchState ?? vi.fn(async () => snapshot()),
    postRefresh: impl.postRefresh ?? vi.fn(async () => ({ woken: true })),
  };
}

async function runCmd(streams: Streams, deps: DashboardCommandDeps, args: string[]) {
  const exit = vi.fn(() => {
    throw new Error('__exit__');
  });
  const cmd = createDashboardCommand({ ...deps, ...streams, exit: exit as never });
  let thrown: unknown = null;
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if ((error as Error).message !== '__exit__') {
      thrown = error;
    }
  }
  if (thrown !== null) throw thrown;
  return { exit };
}

describe('philharmonic dashboard CLI', () => {
  it('--help にコマンドの説明と --port / --interval / --once / --config が含まれる', () => {
    const cmd = createDashboardCommand();
    const helpText = cmd.helpInformation();
    expect(cmd.description()).toContain('dashboard');
    expect(helpText).toContain('--port');
    expect(helpText).toContain('--interval');
    expect(helpText).toContain('--once');
    expect(helpText).toContain('--config');
  });

  it('--port も config の server.port も無いと exit 1 (案内メッセージを stderr に書く)', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(
      streams,
      {
        cwd: () => '/tmp/repo',
        loadConfig: vi.fn(async () => fakeConfig({ server: null })),
      },
      ['--once'],
    );
    expect(exit).toHaveBeenCalledWith(1);
    const stderr = streams.stderr.write.mock.calls.map((c) => c[0]).join('');
    expect(stderr).toContain('server.port');
    expect(stderr).toContain('--port');
  });

  it('config の server.port を default として使い、--port で上書きできる', async () => {
    const streams = createStreams();
    const fetchState = vi.fn(async () => snapshot());
    const createClient = vi.fn(({ port }: { port: number }) =>
      fakeClient({ fetchState, port } as Partial<DashboardClient>),
    );
    await runCmd(
      streams,
      {
        cwd: () => '/tmp/repo',
        loadConfig: vi.fn(async () => fakeConfig({ server: { port: 5000 } })),
        createClient,
      },
      ['--once', '--port', '4001'],
    );
    expect(createClient).toHaveBeenCalledWith({ port: 4001 });
  });

  it('--once で snapshot を fetch し、人間可読 text を stdout に書いて exit 0', async () => {
    const streams = createStreams();
    const fetchState = vi.fn(async () =>
      snapshot({
        polling: { interval_ms: 30_000, last_tick_at: '2026-05-09T00:00:30.000Z' },
        running: [
          {
            run_id: 'run-1',
            issue_number: 42,
            branch: 'feature/42-foo',
            started_at: '2026-05-09T00:00:10.000Z',
            slot: 0,
          },
        ],
        totals: { runs_completed: 12, runs_succeeded: 10, runs_failed: 2, total_cost_usd: 4.32 },
      }),
    );
    const { exit } = await runCmd(
      streams,
      {
        cwd: () => '/tmp/repo',
        loadConfig: vi.fn(async () => fakeConfig({ server: { port: 4000 } })),
        createClient: () => fakeClient({ fetchState }),
      },
      ['--once'],
    );
    expect(exit).not.toHaveBeenCalled();
    const out = streams.stdout.write.mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('host=127.0.0.1 port=4000');
    expect(out).toContain('  #42 branch=feature/42-foo');
    expect(out).toContain('runs_completed=12');
    expect(streams.stderr.write).not.toHaveBeenCalled();
  });

  it('--once で接続失敗時は stderr に書いて exit 1', async () => {
    const streams = createStreams();
    const fetchState = vi.fn(async () => {
      throw new DashboardConnectionError('connection refused (daemon が未起動)', new Error('boom'));
    });
    const { exit } = await runCmd(
      streams,
      {
        cwd: () => '/tmp/repo',
        loadConfig: vi.fn(async () => fakeConfig({ server: { port: 4000 } })),
        createClient: () => fakeClient({ fetchState }),
      },
      ['--once'],
    );
    expect(exit).toHaveBeenCalledWith(1);
    const err = streams.stderr.write.mock.calls.map((c) => c[0]).join('');
    expect(err).toContain('dashboard:');
    expect(err).toContain('connection refused');
    expect(streams.stdout.write).not.toHaveBeenCalled();
  });

  it('--interval が 500 未満なら commander が parse error で exit する (案内に --interval を含む)', async () => {
    const streams = createStreams();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code}`);
    }) as never);
    const writeErrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      streams.stderr.write(chunk);
      return true;
    }) as never);
    try {
      await runCmd(
        streams,
        {
          cwd: () => '/tmp/repo',
          loadConfig: vi.fn(async () => fakeConfig({ server: { port: 4000 } })),
        },
        ['--once', '--interval', '100'],
      ).catch((error: Error) => {
        if (!error.message.startsWith('__exit__')) throw error;
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
      const stderr = streams.stderr.write.mock.calls.map((c) => c[0]).join('');
      expect(stderr).toContain('--interval');
    } finally {
      exitSpy.mockRestore();
      writeErrSpy.mockRestore();
    }
  });

  it('config 読み込み失敗時は stderr に書いて exit 1', async () => {
    const streams = createStreams();
    const { exit } = await runCmd(
      streams,
      {
        cwd: () => '/tmp/repo',
        loadConfig: vi.fn(async () => {
          const { ConfigFileNotFoundError } = await import('../../src/config/index.js');
          throw new ConfigFileNotFoundError('/tmp/repo/.philharmonic/philharmonic.yaml');
        }),
      },
      ['--once'],
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
