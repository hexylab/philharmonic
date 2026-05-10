import path from 'node:path';

import { Command } from 'commander';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  DEFAULT_WORKFLOW_FILE,
  loadConfig,
  LOW_POLLING_INTERVAL_WARN_THRESHOLD_MS,
  type Config,
} from '../config/index.js';
import {
  GitHubTokenNotSetError,
  createGitHubClient,
  getGitHubTokenFromEnv,
  type GitHubClient,
} from '../github/index.js';
import { createLogger, type Logger } from '../logger/index.js';
import {
  recoverInProgress,
  runConcurrent,
  runOnce,
  serveLoop,
  type ConcurrentDispatchOutcome,
  type RunOnceResult,
} from '../orchestrator/index.js';
import { createProjectsClient, type ProjectsClient } from '../projects/index.js';
import {
  acquireServeLock,
  ServeLockHeldError,
  ServeLockHeldOnDifferentHostError,
  type AcquireServeLockOptions,
  type ServeLockHandle,
} from '../serve/index.js';
import {
  buildIssueSnapshot,
  buildStateSnapshot,
  createRunTracker,
  createWakeController,
  startSnapshotApiServer,
  type RunTracker,
  type SnapshotApiServer,
  type SnapshotApiServerOptions,
  type WakeController,
} from '../server/index.js';
import {
  createWorkflowSource,
  type CreateWorkflowSourceOptions,
  type WorkflowSource,
} from '../workflow/index.js';
import {
  createWorkspaceManager,
  type HookConfigMap,
  type WorkspaceManager,
} from '../workspace/index.js';

import { configHooksToHookConfigMap } from './hooks.js';

export type ServeSignal = 'SIGTERM' | 'SIGINT';

export type ServeSignalListener = (signal: ServeSignal) => void;

export type ServeSignalSubscription = {
  on: (signal: ServeSignal, listener: ServeSignalListener) => void;
  dispose: () => void;
};

export type CreateServeSignalSubscription = () => ServeSignalSubscription;

/**
 * `permission_mode: bypass` を `serve` で使う場合に opt-in を要求する env 名。
 * `--dangerously-skip-permissions` が長時間稼働で連続発火するため、明示同意を必須にする。
 */
export const BYPASS_OPT_IN_ENV = 'PHILHARMONIC_ALLOW_BYPASS_IN_SERVE';

export type ServeCommandDeps = {
  cwd?: () => string;
  loadConfig?: (configPath?: string, options?: { cwd?: string }) => Promise<Config>;
  getToken?: () => string;
  getEnv?: (key: string) => string | undefined;
  createGitHubClient?: (token: string) => GitHubClient;
  createProjectsClient?: (token: string) => ProjectsClient;
  createWorkspaceManager?: (input: {
    repoRoot: string;
    workspaceRoot: string;
    hooks?: HookConfigMap;
    logger?: ReturnType<typeof createLogger>;
  }) => WorkspaceManager;
  createWorkflowSource?: (options: CreateWorkflowSourceOptions) => Promise<WorkflowSource>;
  acquireServeLock?: (options: AcquireServeLockOptions) => Promise<ServeLockHandle>;
  runOnce?: typeof runOnce;
  runConcurrent?: typeof runConcurrent;
  serveLoop?: typeof serveLoop;
  recoverInProgress?: typeof recoverInProgress;
  createSignalSubscription?: CreateServeSignalSubscription;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  createLogger?: typeof createLogger;
  exit?: (code: number) => never;
  startSnapshotApiServer?: (options: SnapshotApiServerOptions) => Promise<SnapshotApiServer>;
  createRunTracker?: (options?: { startedAt?: Date }) => RunTracker;
  createWakeController?: () => WakeController;
};

const DEFAULT_DEPS: Required<ServeCommandDeps> = {
  cwd: () => process.cwd(),
  loadConfig: (configPath, options) => loadConfig(configPath, options),
  getToken: () => getGitHubTokenFromEnv(),
  getEnv: (key) => process.env[key],
  createGitHubClient: (token) => createGitHubClient({ token }),
  createProjectsClient: (token) => createProjectsClient({ token }),
  createWorkspaceManager: (input) => createWorkspaceManager(input),
  createWorkflowSource: (options) => createWorkflowSource(options),
  acquireServeLock,
  runOnce,
  runConcurrent,
  serveLoop,
  recoverInProgress,
  createSignalSubscription: createProcessSignalSubscription,
  stdout: process.stdout,
  stderr: process.stderr,
  createLogger,
  exit: (code) => process.exit(code) as never,
  startSnapshotApiServer,
  createRunTracker: (options) => createRunTracker(options),
  createWakeController,
};

export function createServeCommand(deps: ServeCommandDeps = {}): Command {
  const resolved: Required<ServeCommandDeps> = { ...DEFAULT_DEPS, ...deps };

  const cmd = new Command('serve');
  cmd
    .description(
      'Project board を一定間隔でポーリングして候補があれば run を 1 件処理する常駐デーモン (SIGTERM/SIGINT で graceful shutdown)',
    )
    .option('-c, --config <path>', '設定ファイルのパス (省略時は cwd の philharmonic.yaml)')
    .action(async (options: { config?: string }) => {
      await runServeCommand(options, resolved);
    });
  return cmd;
}

async function runServeCommand(
  options: { config?: string },
  deps: Required<ServeCommandDeps>,
): Promise<void> {
  const cwd = deps.cwd();

  let token: string;
  try {
    token = deps.getToken();
  } catch (error) {
    if (error instanceof GitHubTokenNotSetError) {
      deps.stderr.write(`${error.message}\n`);
      deps.exit(1);
      return;
    }
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }

  let config: Config;
  try {
    config = await deps.loadConfig(options.config, { cwd });
  } catch (error) {
    if (
      error instanceof ConfigFileNotFoundError ||
      error instanceof ConfigParseError ||
      error instanceof ConfigValidationError
    ) {
      deps.stderr.write(`${error.message}\n`);
      deps.exit(1);
      return;
    }
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }

  if (config.permissionMode === 'bypass') {
    if (deps.getEnv(BYPASS_OPT_IN_ENV) !== '1') {
      deps.stderr.write(
        `serve で permission_mode: bypass を使うには ${BYPASS_OPT_IN_ENV}=1 を明示設定してください。` +
          `\n--dangerously-skip-permissions は worktree 外 (ホスト全体) にも副作用が及び得るため、` +
          `daemon で連続発火させる前に隔離 (専用ユーザ / 一時ホスト等) を確認してください。\n`,
      );
      deps.exit(1);
      return;
    }
  }

  const repoRoot = cwd;

  let lock: ServeLockHandle;
  try {
    lock = await deps.acquireServeLock({ repoRoot });
  } catch (error) {
    if (error instanceof ServeLockHeldError || error instanceof ServeLockHeldOnDifferentHostError) {
      deps.stderr.write(`${error.message}\n`);
      deps.exit(1);
      return;
    }
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }

  const githubClient = deps.createGitHubClient(token);
  const projectsClient = deps.createProjectsClient(token);
  const runnerLogsRoot = path.resolve(repoRoot, '.philharmonic/runs');

  const logger: Logger = deps.createLogger({
    level: config.logLevel,
    destination: deps.stderr,
  });

  const workspaceManager = deps.createWorkspaceManager({
    repoRoot,
    workspaceRoot: config.workspaceRoot,
    hooks: configHooksToHookConfigMap(config.hooks),
    logger,
  });

  if (config.permissionMode === 'bypass') {
    logger.warn(
      'permission_mode=bypass で serve を起動します。--dangerously-skip-permissions が tick ごとに発火するため、隔離環境であることを必ず確認してください',
      { optInEnv: BYPASS_OPT_IN_ENV },
    );
  } else {
    // ADR-0005: agent 委譲型では bypass が実用上必須。auto では agent が gh / git push を呼べず
    // Status 遷移 / PR 作成が失敗する。起動は許容するが、最初に 1 回だけ警告する。
    logger.warn(
      'permission_mode=auto では agent が Bash tool (gh / git push) を呼べず、Status 遷移 / PR 作成が失敗します (ADR-0005)。philharmonic.yaml の permission_mode を bypass に変更してください',
    );
  }

  if (config.polling.intervalMs < LOW_POLLING_INTERVAL_WARN_THRESHOLD_MS) {
    logger.warn(
      'polling.interval_ms が低く設定されています。GitHub API の rate limit に注意してください',
      {
        intervalMs: config.polling.intervalMs,
        recommendedMinMs: LOW_POLLING_INTERVAL_WARN_THRESHOLD_MS,
      },
    );
  }

  const controller = new AbortController();
  const subscription = deps.createSignalSubscription();
  let shutdownRequested = false;
  const onSignal: ServeSignalListener = (signal) => {
    if (shutdownRequested) {
      logger.warn('shutdown signal ignored (already shutting down)', { signal });
      return;
    }
    shutdownRequested = true;
    logger.info('shutdown signal', { signal });
    controller.abort();
  };
  subscription.on('SIGTERM', onSignal);
  subscription.on('SIGINT', onSignal);

  const runTracker = deps.createRunTracker({ startedAt: new Date() });
  const wakeController = deps.createWakeController();
  let apiServer: SnapshotApiServer | null = null;
  if (config.server != null) {
    try {
      apiServer = await deps.startSnapshotApiServer({
        port: config.server.port,
        logger,
        handlers: {
          getState: () =>
            buildStateSnapshot({
              tracker: runTracker,
              intervalMs: config.polling.intervalMs,
            }),
          getIssue: async (issueNumber) => {
            const snapshot = await buildIssueSnapshot({
              issueNumber,
              tracker: runTracker,
            });
            if (snapshot.running === null) return null;
            return snapshot;
          },
          refresh: async () => ({ woken: wakeController.wake() }),
        },
      });
      logger.info('snapshot api started', {
        host: apiServer.host,
        port: apiServer.port,
      });
    } catch (error) {
      deps.stderr.write(`snapshot api の起動に失敗しました: ${describeError(error)}\n`);
      try {
        await lock.release();
      } catch (releaseError) {
        logger.warn('serve lock release に失敗', { error: describeError(releaseError) });
      }
      deps.exit(1);
      return;
    }
  }

  let workflowSource: WorkflowSource;
  try {
    workflowSource = await deps.createWorkflowSource({
      workflowPath: path.resolve(repoRoot, config.workflowFile),
      fallbackOnMissing: config.workflowFile === DEFAULT_WORKFLOW_FILE,
      watch: true,
      logger,
    });
  } catch (error) {
    deps.stderr.write(`${describeError(error)}\n`);
    try {
      await lock.release();
    } catch (releaseError) {
      logger.warn('serve lock release に失敗', { error: describeError(releaseError) });
    }
    deps.exit(1);
    return;
  }

  const maxConcurrent = config.agent.maxConcurrentAgents;

  const wrappedRunOnce = async (): Promise<RunOnceResult | undefined> => {
    if (maxConcurrent === 1) {
      return await deps.runOnce({
        config,
        repoRoot,
        githubClient,
        projectsClient,
        workspaceManager,
        workflowSource,
        runnerLogsRoot,
        dispatchStatuses: config.dispatchStatuses,
        logger,
        runTracker,
      });
    }

    const outcomes = await deps.runConcurrent({
      config,
      repoRoot,
      githubClient,
      projectsClient,
      workspaceManager,
      workflowSource,
      runnerLogsRoot,
      dispatchStatuses: config.dispatchStatuses,
      logger,
      maxConcurrent,
      runTracker,
    });
    if (outcomes.length === 0) {
      logger.info('no candidate');
    } else {
      for (const outcome of outcomes) {
        logConcurrentDispatch(logger, outcome);
      }
    }
    return undefined;
  };

  try {
    if (!controller.signal.aborted) {
      try {
        await deps.recoverInProgress({
          config,
          repoRoot,
          githubClient,
          projectsClient,
          workspaceManager,
          workflowSource,
          runnerLogsRoot,
          signal: controller.signal,
          logger,
          runTracker,
        });
      } catch (error) {
        logger.warn('recovery aborted', { error: describeError(error) });
      }
    }

    await deps.serveLoop({
      intervalMs: config.polling.intervalMs,
      signal: controller.signal,
      logger,
      runOnce: wrappedRunOnce,
      acquireWakeSignal: () => wakeController.acquire(),
      onPollTick: () => runTracker.recordPollTick(new Date()),
    });
  } finally {
    subscription.dispose();
    if (apiServer !== null) {
      try {
        await apiServer.close();
      } catch (error) {
        logger.warn('snapshot api close に失敗', { error: describeError(error) });
      }
    }
    try {
      await workflowSource.close();
    } catch (error) {
      logger.warn('workflow source close に失敗', { error: describeError(error) });
    }
    try {
      await lock.release();
    } catch (error) {
      logger.warn('serve lock release に失敗', { error: describeError(error) });
    }
  }
}

function createProcessSignalSubscription(): ServeSignalSubscription {
  const handlers: Array<{ signal: ServeSignal; handler: () => void }> = [];
  return {
    on: (signal, listener) => {
      const handler = (): void => listener(signal);
      process.on(signal, handler);
      handlers.push({ signal, handler });
    },
    dispose: () => {
      for (const { signal, handler } of handlers) {
        process.removeListener(signal, handler);
      }
      handlers.length = 0;
    },
  };
}

function logConcurrentDispatch(logger: Logger, outcome: ConcurrentDispatchOutcome): void {
  const { slot, result } = outcome;
  if (result.kind === 'success') {
    logger.info('dispatch success', {
      slot,
      runId: result.runId,
      issueNumber: result.issueNumber,
      branch: result.branch,
    });
    return;
  }
  logger.warn('dispatch failed', {
    slot,
    runId: result.runId,
    issueNumber: result.issueNumber,
    reason: result.reason,
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
