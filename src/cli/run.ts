import path from 'node:path';

import { Command } from 'commander';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  DEFAULT_WORKFLOW_FILE,
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
import { BootstrapError, runOnce, type RunOnceResult } from '../orchestrator/index.js';
import { createProjectsClient, type ProjectsClient } from '../projects/index.js';
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

export type RunCommandDeps = {
  cwd?: () => string;
  loadConfig?: (configPath?: string, options?: { cwd?: string }) => Promise<Config>;
  getToken?: () => string;
  createGitHubClient?: (token: string) => GitHubClient;
  createProjectsClient?: (token: string) => ProjectsClient;
  createWorkspaceManager?: (input: {
    repoRoot: string;
    workspaceRoot: string;
    hooks?: HookConfigMap;
    logger?: ReturnType<typeof createLogger>;
  }) => WorkspaceManager;
  createWorkflowSource?: (options: CreateWorkflowSourceOptions) => Promise<WorkflowSource>;
  runOnce?: typeof runOnce;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  createLogger?: typeof createLogger;
  exit?: (code: number) => never;
};

const DEFAULT_DEPS: Required<RunCommandDeps> = {
  cwd: () => process.cwd(),
  loadConfig: (configPath, options) => loadConfig(configPath, options),
  getToken: () => getGitHubTokenFromEnv(),
  createGitHubClient: (token) => createGitHubClient({ token }),
  createProjectsClient: (token) => createProjectsClient({ token }),
  createWorkspaceManager: (input) => createWorkspaceManager(input),
  createWorkflowSource: (options) => createWorkflowSource(options),
  runOnce,
  stdout: process.stdout,
  stderr: process.stderr,
  createLogger,
  exit: (code) => process.exit(code) as never,
};

export function createRunCommand(deps: RunCommandDeps = {}): Command {
  const resolved: Required<RunCommandDeps> = { ...DEFAULT_DEPS, ...deps };

  const cmd = new Command('run');
  cmd
    .description(
      'GitHub Projects v2 から候補 Issue を 1 件だけ処理する 1 ターン分の orchestration を実行する',
    )
    .option('-c, --config <path>', '設定ファイルのパス (省略時は cwd の philharmonic.yaml)')
    .action(async (options: { config?: string }) => {
      await runRunCommand(options, resolved);
    });
  return cmd;
}

async function runRunCommand(
  options: { config?: string },
  deps: Required<RunCommandDeps>,
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

  if (config.permissionMode === 'auto') {
    // ADR-0005: agent 委譲型では bypass が実用上必須。auto では agent が gh / git push を呼べず
    // Status 遷移 / PR 作成が失敗する。
    logger.warn(
      'permission_mode=auto では agent が Bash tool (gh / git push) を呼べず、Status 遷移 / PR 作成が失敗します (ADR-0005)。philharmonic.yaml の permission_mode を bypass に変更してください',
    );
  }

  // WORKFLOW.md は repoRoot 直下に解決する。`philharmonic run` は単発実行のため watch=false。
  let workflowSource: WorkflowSource;
  try {
    workflowSource = await deps.createWorkflowSource({
      workflowPath: path.resolve(repoRoot, config.workflowFile),
      fallbackOnMissing: isDefaultWorkflowFile(config.workflowFile),
      watch: false,
      logger,
    });
  } catch (error) {
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }

  let result: RunOnceResult;
  try {
    result = await deps.runOnce({
      config,
      repoRoot,
      githubClient,
      projectsClient,
      workspaceManager,
      workflowSource,
      runnerLogsRoot,
      dispatchStatuses: config.dispatchStatuses,
      logger,
    });
  } catch (error) {
    await workflowSource.close();
    if (error instanceof BootstrapError) {
      deps.stderr.write(`${error.message}\n`);
      deps.exit(1);
      return;
    }
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }
  await workflowSource.close();

  switch (result.kind) {
    case 'no_candidate':
      deps.stdout.write('no candidate\n');
      return;
    case 'success':
      deps.stdout.write(
        `success run-id=${result.runId} issue=#${result.issueNumber} branch=${result.branch}\n`,
      );
      return;
    case 'failed':
      deps.stderr.write(
        `failed run-id=${result.runId} issue=#${result.issueNumber} reason=${result.reason}\n`,
      );
      deps.exit(1);
      return;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isDefaultWorkflowFile(value: string): boolean {
  return value === DEFAULT_WORKFLOW_FILE;
}
