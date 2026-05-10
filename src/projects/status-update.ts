import { spawn } from 'node:child_process';

/**
 * `gh` CLI subprocess を実行する DI 可能な runner。
 *
 * `philharmonic retry <issue>` (#88) で Project Status を `gh project item-edit` 経由で
 * 書き戻す経路に使う。ADR-0005 で「orchestrator は Status を直接 GraphQL で書かない」と
 * 決まっているため、agent と同じ `gh` CLI 経由に倒している。
 *
 * spec: docs/specs/manual-retry.md
 */
export type GhRunner = (args: readonly string[]) => Promise<GhRunResult>;

export type GhRunResult = {
  stdout: string;
  stderr: string;
};

export class GhCommandError extends Error {
  constructor(
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
    message?: string,
  ) {
    super(message ?? `gh ${args.join(' ')} failed (exit=${exitCode ?? 'null'}): ${stderr.trim()}`);
    this.name = 'GhCommandError';
  }
}

export class StatusOptionNotFoundError extends Error {
  constructor(
    public readonly statusFieldName: string,
    public readonly targetStatus: string,
    public readonly availableOptions: readonly string[],
  ) {
    super(
      `target status '${targetStatus}' not found in field '${statusFieldName}'. ` +
        `available: ${availableOptions.join(', ') || '(none)'}`,
    );
    this.name = 'StatusOptionNotFoundError';
  }
}

export const defaultGhRunner: GhRunner = (args) =>
  new Promise<GhRunResult>((resolve, reject) => {
    const child = spawn('gh', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new GhCommandError(args, code, stderr));
    });
  });

type FieldListEntry = {
  id: string;
  name: string;
  type: string;
  options?: readonly { id: string; name: string }[];
};

type FieldListResponse = {
  fields: readonly FieldListEntry[];
};

export type UpdateProjectItemStatusInput = {
  owner: string;
  projectNumber: number;
  projectId: string;
  itemId: string;
  /** Project の Status field 名 (= config.statusField)。default `Status` */
  statusFieldName: string;
  /** 書き戻し先の option name (例: `Todo`) */
  targetStatus: string;
};

/**
 * `gh project field-list` で field/option ID を解決し、`gh project item-edit` で
 * Project Item の Status を書き戻す。
 *
 * 失敗系:
 * - `gh` 自体が non-zero exit: {@link GhCommandError}
 * - status field / target option が見つからない: {@link StatusOptionNotFoundError}
 */
export async function updateProjectItemStatus(
  runGh: GhRunner,
  input: UpdateProjectItemStatusInput,
): Promise<void> {
  const fieldList = await runGh([
    'project',
    'field-list',
    String(input.projectNumber),
    '--owner',
    input.owner,
    '--format',
    'json',
    '--limit',
    '100',
  ]);

  const fieldListResponse = parseFieldListResponse(fieldList.stdout);
  const statusField = fieldListResponse.fields.find(
    (field) => field.name === input.statusFieldName && field.type === 'ProjectV2SingleSelectField',
  );
  if (statusField === undefined) {
    throw new StatusOptionNotFoundError(input.statusFieldName, input.targetStatus, []);
  }
  const options = statusField.options ?? [];
  const option = options.find((opt) => opt.name === input.targetStatus);
  if (option === undefined) {
    throw new StatusOptionNotFoundError(
      input.statusFieldName,
      input.targetStatus,
      options.map((opt) => opt.name),
    );
  }

  await runGh([
    'project',
    'item-edit',
    '--id',
    input.itemId,
    '--project-id',
    input.projectId,
    '--field-id',
    statusField.id,
    '--single-select-option-id',
    option.id,
  ]);
}

function parseFieldListResponse(stdout: string): FieldListResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `failed to parse \`gh project field-list\` JSON output: ${describeError(error)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { fields?: unknown }).fields)
  ) {
    throw new Error('unexpected `gh project field-list` JSON shape: missing `fields[]`');
  }
  return parsed as FieldListResponse;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
