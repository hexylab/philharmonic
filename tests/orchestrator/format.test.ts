import { describe, expect, it } from 'vitest';

import { buildFailureCommentBody, buildPullRequestBody } from '../../src/orchestrator/format.js';

describe('buildPullRequestBody', () => {
  it('Closes ヘッダ / Acceptance Criteria / 実行ログ / Runner Summary / 動作確認手順 を含む', () => {
    const body = buildPullRequestBody({
      issueNumber: 42,
      acceptanceCriteria: '- [x] 1\n- [ ] 2',
      runId: '0190ce80-0000-7000-8000-000000000000',
      durationMs: 12_345,
      totalCostUsd: 0.0123,
      finalText: '実装しました',
      numTurns: 3,
    });
    expect(body).toContain('Closes #42');
    expect(body).toContain('## Acceptance Criteria');
    expect(body).toContain('- [x] 1');
    expect(body).toContain('## 実行ログ');
    expect(body).toContain('Run ID: 0190ce80-0000-7000-8000-000000000000');
    expect(body).toContain('所要時間: 12.3s');
    expect(body).toContain('Total cost (USD): 0.0123');
    expect(body).toContain('Turns: 3');
    expect(body).toContain('## Runner Summary');
    expect(body).toContain('実装しました');
    expect(body).toContain('## 動作確認手順');
  });

  it('Acceptance Criteria 空 / finalText 空はプレースホルダで埋める', () => {
    const body = buildPullRequestBody({
      issueNumber: 1,
      acceptanceCriteria: '',
      runId: 'r',
      durationMs: 0,
      totalCostUsd: null,
      finalText: null,
      numTurns: null,
    });
    expect(body).toContain('Issue 本文に Acceptance Criteria が無いため');
    expect(body).toContain('Total cost (USD): unknown');
    expect(body).toContain('Turns: unknown');
    expect(body).toContain('Runner からの最終応答なし');
  });
});

describe('buildFailureCommentBody', () => {
  it('reason / runId / detail / Runner Summary を含む', () => {
    const body = buildFailureCommentBody({
      reason: 'runner_error',
      runId: 'rid',
      durationMs: 5_000,
      totalCostUsd: 0.5,
      runnerSummary: 'last assistant text',
      detail: 'exit code 1',
    });
    expect(body).toContain('Philharmonic Run Failed');
    expect(body).toContain('Phase: runner_error');
    expect(body).toContain('Run ID: rid');
    expect(body).toContain('所要時間: 5.0s');
    expect(body).toContain('Total cost (USD): 0.5000');
    expect(body).toContain('Detail: exit code 1');
    expect(body).toContain('last assistant text');
  });

  it('summary なしのときはプレースホルダを入れる', () => {
    const body = buildFailureCommentBody({
      reason: 'no_changes',
      runId: 'rid',
      durationMs: 0,
      totalCostUsd: null,
      runnerSummary: null,
    });
    expect(body).toContain('Phase: no_changes');
    expect(body).toContain('Runner 応答なし');
  });
});
