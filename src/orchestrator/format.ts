import type { RunResult } from '../runner/index.js';
import type { FailureReason } from './errors.js';

export type PullRequestBodyInput = {
  issueNumber: number;
  acceptanceCriteria: string;
  runId: string;
  durationMs: number;
  totalCostUsd: number | null;
  finalText: string | null;
  numTurns: number | null;
};

export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const acceptanceCriteria = input.acceptanceCriteria.trim();
  const acceptanceSection =
    acceptanceCriteria.length > 0
      ? acceptanceCriteria
      : '_(Issue 本文に Acceptance Criteria が無いため転記なし)_';

  const cost = typeof input.totalCostUsd === 'number' ? input.totalCostUsd.toFixed(4) : 'unknown';
  const seconds = (input.durationMs / 1000).toFixed(1);
  const turns = typeof input.numTurns === 'number' ? `${input.numTurns}` : 'unknown';

  const summary = (input.finalText ?? '').trim();
  const summarySection = summary.length > 0 ? summary : '_(Runner からの最終応答なし)_';

  return [
    `Closes #${input.issueNumber}`,
    '',
    '## Acceptance Criteria',
    '',
    acceptanceSection,
    '',
    '## 実行ログ',
    '',
    `- Run ID: ${input.runId}`,
    `- 所要時間: ${seconds}s`,
    `- Total cost (USD): ${cost}`,
    `- Turns: ${turns}`,
    '',
    '## Runner Summary',
    '',
    summarySection,
    '',
    '## 動作確認手順',
    '',
    '上記 Runner Summary に Runner が記載した検証ステップが含まれます。レビュアーは以下を追加で確認してください。',
    '',
    '- 変更ファイル一覧と diff の内容が Acceptance Criteria を満たしているか',
    '- 必要なテスト / Lint / 型チェック / format が CI で green か',
    '- Runner Summary に書かれた手動検証手順を再現できるか',
    '',
  ].join('\n');
}

export type FailureCommentInput = {
  reason: FailureReason;
  runId: string;
  durationMs: number;
  totalCostUsd: number | null;
  runnerSummary: string | null;
  detail?: string | null;
};

export function buildFailureCommentBody(input: FailureCommentInput): string {
  const cost = typeof input.totalCostUsd === 'number' ? input.totalCostUsd.toFixed(4) : 'unknown';
  const seconds = (input.durationMs / 1000).toFixed(1);

  const summary = (input.runnerSummary ?? '').trim();
  const summaryBlock = summary.length > 0 ? truncate(summary, 1500) : '_(Runner 応答なし)_';

  const lines: string[] = [
    '## Philharmonic Run Failed',
    '',
    `- Run ID: ${input.runId}`,
    `- Phase: ${input.reason}`,
    `- 所要時間: ${seconds}s`,
    `- Total cost (USD): ${cost}`,
  ];
  if (typeof input.detail === 'string' && input.detail.length > 0) {
    lines.push(`- Detail: ${oneLine(input.detail)}`);
  }
  lines.push('', '### Runner Summary 抜粋', '', summaryBlock, '');
  return lines.join('\n');
}

export function summarizeRunResult(run: RunResult): string | null {
  const finalText = run.finalText?.trim();
  if (finalText !== undefined && finalText.length > 0) return finalText;
  if (run.rawStderrTail.length > 0) return run.rawStderrTail.trim();
  return null;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n... (truncated)`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
