import path from 'node:path';

import { Command } from 'commander';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
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
  runOnce,
  serveLoop,
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
import { createWorkspaceManager, type WorkspaceManager } from '../workspace/index.js';

export type ServeSignal = 'SIGTERM' | 'SIGINT';

export type ServeSignalListener = (signal: ServeSignal) => void;

export type ServeSignalSubscription = {
  /**
   * Process が指定 signal を受け取ったら listener を呼ぶ subscription を作る。
   * 戻り値の `dispose()` は loop 終了後に listener を外すために必ず呼ぶ。
   */
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
  createWorkspaceManager?: (input: { repoRoot: string; workspaceRoot: string }) => WorkspaceManager;
  acquireServeLock?: (options: AcquireServeLockOptions) => Promise<ServeLockHandle>;
  runOnce?: typeof runOnce;
  serveLoop?: typeof serveLoop;
  recoverInProgress?: typeof recoverInProgress;
  createSignalSubscription?: CreateServeSignalSubscription;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  createLogger?: typeof createLogger;
  exit?: (code: number) => never;
};

const DEFAULT_DEPS: Required<ServeCommandDeps> = {
  cwd: () => process.cwd(),
  loadConfig: (configPath, options) => loadConfig(configPath, options),
  getToken: () => getGitHubTokenFromEnv(),
  getEnv: (key) => process.env[key],
  createGitHubClient: (token) => createGitHubClient({ token }),
  createProjectsClient: (token) => createProjectsClient({ token }),
  createWorkspaceManager: (input) => createWorkspaceManager(input),
  acquireServeLock,
  runOnce,
  serveLoop,
  recoverInProgress,
  createSignalSubscription: createProcessSignalSubscription,
  stdout: process.stdout,
  stderr: process.stderr,
  createLogger,
  exit: (code) => process.exit(code) as never,
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

  // bypass guard: serve で permission_mode=bypass を使うときは明示 opt-in を要求する。
  // run コマンドはこの制約を持たない (一過的実行なので)。
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

  // lock 取得は config / token / bypass guard を全て通った後に行う (失敗時に lock を残さないため)。
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
  const workspaceManager = deps.createWorkspaceManager({
    repoRoot,
    workspaceRoot: config.workspaceRoot,
  });
  const runnerLogsRoot = path.resolve(repoRoot, '.philharmonic/runs');

  const logger: Logger = deps.createLogger({
    level: config.logLevel,
    destination: deps.stderr,
  });

  if (config.permissionMode === 'bypass') {
    logger.warn(
      'permission_mode=bypass で serve を起動します。--dangerously-skip-permissions が tick ごとに発火するため、隔離環境であることを必ず確認してください',
      { optInEnv: BYPASS_OPT_IN_ENV },
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

  const wrappedRunOnce = (): Promise<RunOnceResult> =>
    deps.runOnce({
      config,
      repoRoot,
      githubClient,
      projectsClient,
      workspaceManager,
      runnerLogsRoot,
      dispatchStatuses: config.dispatchStatuses,
      logger,
    });

  try {
    // Recovery フェーズ: 前回プロセスのクラッシュ等で In Progress のまま残った Item を引き取る
    // (詳細: docs/specs/orchestration-mvp.md#tracker-driven-recovery-serve-起動時)
    if (!controller.signal.aborted) {
      try {
        await deps.recoverInProgress({
          config,
          repoRoot,
          githubClient,
          projectsClient,
          workspaceManager,
          runnerLogsRoot,
          signal: controller.signal,
          logger,
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
    });
  } finally {
    subscription.dispose();
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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
