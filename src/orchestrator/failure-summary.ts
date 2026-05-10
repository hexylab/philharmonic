import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FailureReason } from './errors.js';

/**
 * retry 上限到達 (`kind=failure` の exhaustion) 時に運用者向けの失敗サマリを書き出すモジュール。
 *
 * - 出力先は既存 run log dir (`createRunLog` で作成済み) の中なので mkdir は不要
 * - 書き込みに失敗しても orchestrator 本体の failure handling は壊さない (呼び出し側が catch する)
 * - ADR-0005 「orchestrator は GitHub に書き込まない」方針を維持し、Issue comment / Status 遷移は
 *   行わない (代わりに本ファイル + 構造化ログで運用者に必要情報を残す)
 *
 * spec: docs/specs/retry-queue.md (Failure summary on exhaustion)
 */

const FILE_NAME = 'failure-summary.md';

export type FailureSummaryInput = {
  runnerLogsRoot: string;
  runId: string;
  issueNumber: number;
  /** 上限に到達した attempt 番号 (= 直前の retry の試行番号) */
  attempt: number;
  /** `agent.max_retry_attempts` の現値 */
  maxAttempts: number;
  failureReason: FailureReason;
  branch: string;
  workspacePath: string;
  /** `RunOnceResult.failed.errorSummary` (先頭 500 文字)。null / 空文字なら "(empty)" 表記 */
  errorSummary: string | null;
  exhaustedAt: Date;
};

export type FailureSummaryArtifact = {
  /** `<runnerLogsRoot>/<runId>/failure-summary.md` の絶対パス */
  path: string;
};

export function resolveFailureSummaryPath(runnerLogsRoot: string, runId: string): string {
  return path.join(runnerLogsRoot, runId, FILE_NAME);
}

export async function writeFailureSummary(
  input: FailureSummaryInput,
): Promise<FailureSummaryArtifact> {
  const filePath = resolveFailureSummaryPath(input.runnerLogsRoot, input.runId);
  await writeFile(filePath, renderFailureSummary(input), 'utf8');
  return { path: filePath };
}

export function renderFailureSummary(input: FailureSummaryInput): string {
  const summaryRel = `.philharmonic/runs/${input.runId}/summary.md`;
  const streamRel = `.philharmonic/runs/${input.runId}/stream.jsonl`;
  const stderrRel = `.philharmonic/runs/${input.runId}/stderr.log`;
  const metadataRel = `.philharmonic/runs/${input.runId}/metadata.json`;

  const trimmed = input.errorSummary?.trim() ?? '';
  const errorBody = trimmed.length > 0 ? trimmed : '_(empty)_';

  return [
    '# Run Failed (Retry Exhausted)',
    '',
    `Issue #${input.issueNumber} は自動 retry 上限 (${input.maxAttempts}) に到達したため queue から落ちました。手動で原因を確認し、必要なら再 dispatch してください。`,
    '',
    '## Summary',
    '',
    `- Issue: #${input.issueNumber}`,
    `- Final attempt: ${input.attempt}`,
    `- Max attempts: ${input.maxAttempts}`,
    `- Last failure reason: ${input.failureReason}`,
    `- Last run id: ${input.runId}`,
    `- Branch: ${input.branch}`,
    `- Workspace path: ${input.workspacePath}`,
    `- Exhausted at: ${input.exhaustedAt.toISOString()}`,
    '',
    '## Last error summary',
    '',
    errorBody,
    '',
    '## Run artifacts',
    '',
    `- Summary: ${summaryRel}`,
    `- Stream: ${streamRel}`,
    `- Stderr: ${stderrRel}`,
    `- Metadata: ${metadataRel}`,
    '',
    '## Manual recovery',
    '',
    `1. \`${summaryRel}\` と \`${stderrRel}\` を確認して原因を特定する`,
    `2. 必要なら \`${input.workspacePath}\` の worktree を調査・cleanup する (\`philharmonic clean\` でも掃除可)`,
    `3. 再実行する場合は Project Status を \`Todo\` 等の dispatch_statuses に戻す (将来 \`philharmonic retry #${input.issueNumber}\` コマンドで自動化予定)`,
    '',
  ].join('\n');
}
