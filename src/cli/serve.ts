import path from 'node:path';

import { Command } from 'commander';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
  type Config,
} from '../config/index.js';
import {
  GitHubTokenNotSetError,
  createGitHubClient,
  getGitHubTokenFromEnv,
  type GitHubClient,
} from '../github/index.js';
import { createLogger, type Logger } from '../logger/index.js';
import { runOnce, serveLoop, type RunOnceResult } from '../orchestrator/index.js';
import { createProjectsClient, type ProjectsClient } from '../projects/index.js';
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

export type ServeCommandDeps = {
  cwd?: () => string;
  loadConfig?: (configPath?: string, options?: { cwd?: string }) => Promise<Config>;
  getToken?: () => string;
  createGitHubClient?: (token: string) => GitHubClient;
  createProjectsClient?: (token: string) => ProjectsClient;
  createWorkspaceManager?: (input: { repoRoot: string; workspaceRoot: string }) => WorkspaceManager;
  runOnce?: typeof runOnce;
  serveLoop?: typeof serveLoop;
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
  createGitHubClient: (token) => createGitHubClient({ token }),
  createProjectsClient: (token) => createProjectsClient({ token }),
  createWorkspaceManager: (input) => createWorkspaceManager(input),
  runOnce,
  serveLoop,
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

  const githubClient = deps.createGitHubClient(token);
  const projectsClient = deps.createProjectsClient(token);
  const repoRoot = cwd;
  const workspaceManager = deps.createWorkspaceManager({
    repoRoot,
    workspaceRoot: config.workspaceRoot,
  });
  const runnerLogsRoot = path.resolve(repoRoot, '.philharmonic/runs');

  const logger: Logger = deps.createLogger({
    level: config.logLevel,
    destination: deps.stderr,
  });

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
    await deps.serveLoop({
      intervalMs: config.polling.intervalMs,
      signal: controller.signal,
      logger,
      runOnce: wrappedRunOnce,
    });
  } finally {
    subscription.dispose();
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
