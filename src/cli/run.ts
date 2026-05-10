import path from 'node:path';

import { Command } from 'commander';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
  type Config,
  type LoadConfigOptions,
} from '../config/index.js';
import {
  GITHUB_TOKEN_ENV,
  GhCliNotAuthenticatedError,
  GhCliNotFoundError,
  GitHubTokenNotSetError,
  createGitHubClient,
  resolveGitHubToken,
  type GitHubClient,
  type ResolveGitHubTokenInput,
  type ResolveGitHubTokenResult,
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
import { resolveWorkflowPath } from './paths.js';

export type RunCommandDeps = {
  cwd?: () => string;
  loadConfig?: (configPath?: string, options?: LoadConfigOptions) => Promise<Config>;
  resolveGitHubToken?: (input: ResolveGitHubTokenInput) => Promise<ResolveGitHubTokenResult>;
  setEnv?: (key: string, value: string) => void;
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
  resolveGitHubToken: (input) => resolveGitHubToken(input),
  setEnv: (key, value) => {
    process.env[key] = value;
  },
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
    .option(
      '-c, --config <path>',
      '設定ファイルのパス (省略時は cwd の .philharmonic/philharmonic.yaml、不在なら legacy philharmonic.yaml に fallback)',
    )
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

  let config: Config;
  let legacyConfigUsed: { legacyPath: string; expectedPath: string } | null = null;
  try {
    config = await deps.loadConfig(options.config, {
      cwd,
      onLegacyPathUsed: (legacyPath, expectedPath) => {
        legacyConfigUsed = { legacyPath, expectedPath };
      },
    });
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

  let token: string;
  let tokenOrigin: ResolveGitHubTokenResult['origin'];
  try {
    const resolved = await deps.resolveGitHubToken({ source: config.github.tokenSource });
    token = resolved.token;
    tokenOrigin = resolved.origin;
  } catch (error) {
    if (
      error instanceof GitHubTokenNotSetError ||
      error instanceof GhCliNotFoundError ||
      error instanceof GhCliNotAuthenticatedError
    ) {
      deps.stderr.write(`${error.message}\n`);
      deps.exit(1);
      return;
    }
    deps.stderr.write(`${describeError(error)}\n`);
    deps.exit(1);
    return;
  }
  deps.setEnv(GITHUB_TOKEN_ENV, token);

  const githubClient = deps.createGitHubClient(token);
  const projectsClient = deps.createProjectsClient(token);
  const repoRoot = cwd;
  const runnerLogsRoot = path.resolve(repoRoot, '.philharmonic/runs');

  const logger: Logger = deps.createLogger({
    level: config.logLevel,
    destination: deps.stderr,
  });

  if (legacyConfigUsed !== null) {
    const { legacyPath, expectedPath } = legacyConfigUsed as {
      legacyPath: string;
      expectedPath: string;
    };
    logger.warn(
      'legacy `philharmonic.yaml` を repo root から読み込みました。`.philharmonic/philharmonic.yaml` への移動を推奨します (#67)',
      { legacyPath, expectedPath },
    );
  }

  logger.info('github token resolved', { source: config.github.tokenSource, origin: tokenOrigin });

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

  // WORKFLOW.md は `.philharmonic/WORKFLOW.md` を default とし、不在なら legacy `WORKFLOW.md`
  // (repo root 直下) に fallback する (#67)。`philharmonic run` は単発実行のため watch=false。
  const { workflowPath, fallbackOnMissing } = await resolveWorkflowPath({
    repoRoot,
    workflowFile: config.workflowFile,
    logger,
  });
  let workflowSource: WorkflowSource;
  try {
    workflowSource = await deps.createWorkflowSource({
      workflowPath,
      fallbackOnMissing,
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
