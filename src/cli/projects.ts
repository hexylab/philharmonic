import { Command, InvalidArgumentError } from 'commander';

import {
  createProjectsClient,
  DEFAULT_STATUS_FIELD_NAME,
  InvalidFirstError,
  ProjectNotFoundError,
  type Candidate,
  type ProjectsClient,
} from '../projects/index.js';

export type ProjectsCommandDeps = {
  getToken?: () => string | undefined;
  createClient?: (token: string) => ProjectsClient;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => never;
};

const DEFAULT_DEPS: Required<ProjectsCommandDeps> = {
  getToken: () => process.env.GITHUB_TOKEN,
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
  json: boolean;
};

async function runList(options: ListOptions, deps: Required<ProjectsCommandDeps>): Promise<void> {
  const token = deps.getToken();
  if (token === undefined || token === '') {
    deps.stderr.write('環境変数 GITHUB_TOKEN を設定してください\n');
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
