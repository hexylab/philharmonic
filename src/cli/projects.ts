import { Command, InvalidArgumentError } from 'commander';

import {
  GITHUB_TOKEN_SOURCES,
  DEFAULT_GITHUB_TOKEN_SOURCE,
  type GitHubTokenSource,
} from '../config/index.js';
import {
  GhCliNotAuthenticatedError,
  GhCliNotFoundError,
  GitHubTokenNotSetError,
  resolveGitHubToken,
  type ResolveGitHubTokenInput,
  type ResolveGitHubTokenResult,
} from '../github/index.js';
import {
  createProjectsClient,
  DEFAULT_STATUS_FIELD_NAME,
  InvalidFirstError,
  ProjectNotFoundError,
  type Candidate,
  type ProjectsClient,
} from '../projects/index.js';

export type ProjectsCommandDeps = {
  resolveGitHubToken?: (input: ResolveGitHubTokenInput) => Promise<ResolveGitHubTokenResult>;
  createClient?: (token: string) => ProjectsClient;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => never;
};

const DEFAULT_DEPS: Required<ProjectsCommandDeps> = {
  resolveGitHubToken: (input) => resolveGitHubToken(input),
  createClient: (token) => createProjectsClient({ token }),
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code) as never,
};

export function createProjectsCommand(deps: ProjectsCommandDeps = {}): Command {
  const resolved: Required<ProjectsCommandDeps> = { ...DEFAULT_DEPS, ...deps };

  const projects = new Command('projects').description('GitHub Projects v2 関連コマンド');

  projects
    .command('list')
    .description('Project Item のうち Issue に紐づいたものを一覧表示する')
    .requiredOption('--owner <owner>', 'Project owner の login')
    .requiredOption('--project <number>', 'Project number (整数)', parseProjectNumber)
    .option(
      '--status-field <name>',
      'Status を取り出す Project field の名前',
      DEFAULT_STATUS_FIELD_NAME,
    )
    .option('--first <count>', '取得件数 (1〜100)', parseFirst, 100)
    .option(
      '--token-source <source>',
      `GitHub token の取得元 (${GITHUB_TOKEN_SOURCES.join(' / ')})`,
      parseTokenSource,
      DEFAULT_GITHUB_TOKEN_SOURCE,
    )
    .option('--json', '整形 JSON で出力する', false)
    .action(async (options: ListOptions) => {
      await runList(options, resolved);
    });

  return projects;
}

type ListOptions = {
  owner: string;
  project: number;
  statusField: string;
  first: number;
  tokenSource: GitHubTokenSource;
  json: boolean;
};

async function runList(options: ListOptions, deps: Required<ProjectsCommandDeps>): Promise<void> {
  let token: string;
  try {
    const resolved = await deps.resolveGitHubToken({ source: options.tokenSource });
    token = resolved.token;
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

  const client = deps.createClient(token);

  let candidates: Candidate[];
  try {
    candidates = await client.fetchProjectCandidates({
      owner: options.owner,
      projectNumber: options.project,
      statusFieldName: options.statusField,
      first: options.first,
    });
  } catch (error) {
    handleFetchError(error, deps.stderr);
    deps.exit(1);
    return;
  }

  if (candidates.length === 0) {
    deps.stdout.write('no candidates\n');
    return;
  }

  if (options.json) {
    deps.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
    return;
  }

  deps.stdout.write(formatTable(candidates));
}

function handleFetchError(error: unknown, stderr: NodeJS.WritableStream): void {
  if (error instanceof ProjectNotFoundError || error instanceof InvalidFirstError) {
    stderr.write(`${error.message}\n`);
    return;
  }
  if (error instanceof Error) {
    stderr.write(`${error.message}\n`);
    return;
  }
  stderr.write(`${String(error)}\n`);
}

function formatTable(candidates: readonly Candidate[]): string {
  const headers = ['ITEM_ID', 'ISSUE', 'REPOSITORY', 'STATUS', 'TITLE'];
  const rows = candidates.map((c) => [
    c.itemId,
    `#${c.issueNumber}`,
    c.repositoryNameWithOwner,
    c.status ?? '-',
    c.issueTitle,
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );

  const lines: string[] = [];
  lines.push(formatRow(headers, widths));
  for (const row of rows) {
    lines.push(formatRow(row, widths));
  }
  return `${lines.join('\n')}\n`;
}

function formatRow(row: readonly string[], widths: readonly number[]): string {
  return row
    .map((cell, i) => {
      // 最終列はパディングしない (タイトルは長いため)
      if (i === row.length - 1) {
        return cell;
      }
      const width = widths[i] ?? cell.length;
      return cell.padEnd(width, ' ');
    })
    .join('  ');
}

function parseProjectNumber(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError('--project は正の整数で指定してください');
  }
  return n;
}

function parseFirst(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new InvalidArgumentError('--first は 1〜100 の範囲で指定してください');
  }
  return n;
}

function parseTokenSource(value: string): GitHubTokenSource {
  if ((GITHUB_TOKEN_SOURCES as readonly string[]).includes(value)) {
    return value as GitHubTokenSource;
  }
  throw new InvalidArgumentError(
    `--token-source は ${GITHUB_TOKEN_SOURCES.join(' / ')} のいずれかで指定してください`,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
