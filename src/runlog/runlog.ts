import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { InvalidRunIdError } from './errors.js';
import { isValidUuid } from './run-id.js';

export type RunLogStatus = 'success' | 'failed';

export type RunLogPaths = {
  metadata: string;
  summary: string;
  stream: string;
  stderr: string;
};

export type RunLog = {
  runId: string;
  dir: string;
  paths: RunLogPaths;
};

export type CreateRunLogInput = {
  runId: string;
  runsRoot: string;
};

export type RunMetadata = {
  runId: string;
  issueNumber: number;
  startedAt: string;
  finishedAt: string | null;
  status: RunLogStatus;
  failureReason: string | null;
  totalCostUsd: number | null;
  branch: string | null;
};

export type WriteSummaryInput = {
  runId: string;
  issueNumber: number;
  status: RunLogStatus;
  finalText: string | null;
  resultSubtype?: string | null;
  stopReason?: string | null;
  totalCostUsd?: number | null;
  durationMs?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  failureReason?: string | null;
};

export async function createRunLog(input: CreateRunLogInput): Promise<RunLog> {
  if (!isValidUuid(input.runId)) {
    throw new InvalidRunIdError(input.runId);
  }
  if (!path.isAbsolute(input.runsRoot)) {
    throw new Error('runsRoot は絶対パスで指定してください');
  }

  const dir = path.join(input.runsRoot, input.runId);
  await mkdir(dir, { recursive: true });

  return {
    runId: input.runId,
    dir,
    paths: {
      metadata: path.join(dir, 'metadata.json'),
      summary: path.join(dir, 'summary.md'),
      stream: path.join(dir, 'stream.jsonl'),
      stderr: path.join(dir, 'stderr.log'),
    },
  };
}

export async function writeMetadata(runLog: RunLog, metadata: RunMetadata): Promise<void> {
  const payload = {
    run_id: metadata.runId,
    issue_number: metadata.issueNumber,
    started_at: metadata.startedAt,
    finished_at: metadata.finishedAt,
    status: metadata.status,
    failure_reason: metadata.failureReason,
    total_cost_usd: metadata.totalCostUsd,
    branch: metadata.branch,
  };
  const json = JSON.stringify(payload, null, 2) + '\n';
  await writeFile(runLog.paths.metadata, json, 'utf8');
}

export async function writeSummary(runLog: RunLog, input: WriteSummaryInput): Promise<void> {
  await writeFile(runLog.paths.summary, renderSummary(input), 'utf8');
}

export function renderSummary(input: WriteSummaryInput): string {
  const fields: Array<[string, string]> = [
    ['Run ID', input.runId],
    ['Issue', `#${input.issueNumber}`],
    ['Status', input.status],
  ];

  if (input.startedAt != null) fields.push(['Started at', input.startedAt]);
  if (input.finishedAt != null) fields.push(['Finished at', input.finishedAt]);
  if (typeof input.durationMs === 'number') fields.push(['Duration', `${input.durationMs} ms`]);
  if (typeof input.totalCostUsd === 'number')
    fields.push(['Total cost (USD)', input.totalCostUsd.toString()]);
  if (input.resultSubtype != null) fields.push(['Result subtype', input.resultSubtype]);
  if (input.stopReason != null) fields.push(['Stop reason', input.stopReason]);
  if (input.status === 'failed' && input.failureReason != null)
    fields.push(['Failure reason', input.failureReason]);

  const header = ['# Run Summary', '', ...fields.map(([k, v]) => `- ${k}: ${v}`)].join('\n');

  const finalText = input.finalText?.trim();
  const body = finalText !== undefined && finalText.length > 0 ? finalText : '_(empty)_';

  return [header, '', '## Final response', '', body, ''].join('\n');
}
