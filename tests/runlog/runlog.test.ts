import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InvalidRunIdError,
  createRunLog,
  renderSummary,
  writeMetadata,
  writeSummary,
  type RunMetadata,
  type WriteSummaryInput,
} from '../../src/runlog/index.js';

const RUN_ID = '0192a0c8-d4e5-7000-8000-000000000001';

describe('createRunLog', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'philharmonic-runlog-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('<runsRoot>/<runId>/ を mkdir し、4 ファイル分のパスを返す', async () => {
    const runsRoot = path.join(tmpRoot, 'runs');
    const runLog = await createRunLog({ runId: RUN_ID, runsRoot });

    expect(runLog.runId).toBe(RUN_ID);
    expect(runLog.dir).toBe(path.join(runsRoot, RUN_ID));
    expect(runLog.paths).toEqual({
      metadata: path.join(runLog.dir, 'metadata.json'),
      summary: path.join(runLog.dir, 'summary.md'),
      stream: path.join(runLog.dir, 'stream.jsonl'),
      stderr: path.join(runLog.dir, 'stderr.log'),
    });
    const dirStat = await stat(runLog.dir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it('UUID 形式でない runId は InvalidRunIdError', async () => {
    await expect(createRunLog({ runId: 'not-a-uuid', runsRoot: tmpRoot })).rejects.toBeInstanceOf(
      InvalidRunIdError,
    );
  });

  it('runsRoot が相対パスなら拒否する', async () => {
    await expect(createRunLog({ runId: RUN_ID, runsRoot: 'runs' })).rejects.toThrow(/絶対パス/);
  });
});

describe('writeMetadata', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'philharmonic-runlog-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('success ケース: 必須フィールドが snake_case で書かれる', async () => {
    const runLog = await createRunLog({ runId: RUN_ID, runsRoot: tmpRoot });
    const metadata: RunMetadata = {
      runId: RUN_ID,
      issueNumber: 18,
      startedAt: '2026-05-09T10:00:00.000Z',
      finishedAt: '2026-05-09T10:05:30.000Z',
      status: 'success',
      failureReason: null,
      totalCostUsd: 0.12345,
      branch: 'feature/18-runlog-persistence',
    };
    await writeMetadata(runLog, metadata);

    const raw = await readFile(runLog.paths.metadata, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      run_id: RUN_ID,
      issue_number: 18,
      started_at: '2026-05-09T10:00:00.000Z',
      finished_at: '2026-05-09T10:05:30.000Z',
      status: 'success',
      failure_reason: null,
      total_cost_usd: 0.12345,
      branch: 'feature/18-runlog-persistence',
    });
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('failed ケース: failure_reason / null フィールドもそのまま書かれる', async () => {
    const runLog = await createRunLog({ runId: RUN_ID, runsRoot: tmpRoot });
    const metadata: RunMetadata = {
      runId: RUN_ID,
      issueNumber: 7,
      startedAt: '2026-05-09T11:00:00.000Z',
      finishedAt: '2026-05-09T11:00:30.000Z',
      status: 'failed',
      failureReason: 'runner_error',
      totalCostUsd: null,
      branch: null,
    };
    await writeMetadata(runLog, metadata);

    const parsed = JSON.parse(await readFile(runLog.paths.metadata, 'utf8'));
    expect(parsed.status).toBe('failed');
    expect(parsed.failure_reason).toBe('runner_error');
    expect(parsed.total_cost_usd).toBeNull();
    expect(parsed.branch).toBeNull();
    expect(parsed.pr_number).toBeUndefined();
  });

  it('実行中の状態として finished_at=null を書ける', async () => {
    const runLog = await createRunLog({ runId: RUN_ID, runsRoot: tmpRoot });
    const metadata: RunMetadata = {
      runId: RUN_ID,
      issueNumber: 1,
      startedAt: '2026-05-09T12:00:00.000Z',
      finishedAt: null,
      status: 'success',
      failureReason: null,
      totalCostUsd: null,
      branch: null,
    };
    await writeMetadata(runLog, metadata);

    const parsed = JSON.parse(await readFile(runLog.paths.metadata, 'utf8'));
    expect(parsed.finished_at).toBeNull();
  });
});

describe('writeSummary / renderSummary', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'philharmonic-runlog-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('finalText を ## Final response セクションに貼る', async () => {
    const runLog = await createRunLog({ runId: RUN_ID, runsRoot: tmpRoot });
    const input: WriteSummaryInput = {
      runId: RUN_ID,
      issueNumber: 18,
      status: 'success',
      finalText: 'PR を作成しました。差分は X / Y / Z です。',
      resultSubtype: 'success',
      stopReason: 'end_turn',
      totalCostUsd: 0.25,
      durationMs: 12345,
      startedAt: '2026-05-09T10:00:00.000Z',
      finishedAt: '2026-05-09T10:05:30.000Z',
    };
    await writeSummary(runLog, input);

    const md = await readFile(runLog.paths.summary, 'utf8');
    expect(md).toContain('# Run Summary');
    expect(md).toContain(`- Run ID: ${RUN_ID}`);
    expect(md).toContain('- Issue: #18');
    expect(md).toContain('- Status: success');
    expect(md).toContain('- Stop reason: end_turn');
    expect(md).toContain('- Duration: 12345 ms');
    expect(md).toContain('- Total cost (USD): 0.25');
    expect(md).toContain('## Final response');
    expect(md).toContain('PR を作成しました。差分は X / Y / Z です。');
  });

  it('failed ケースでは failure_reason を含める', () => {
    const md = renderSummary({
      runId: RUN_ID,
      issueNumber: 9,
      status: 'failed',
      finalText: null,
      failureReason: 'timeout',
    });
    expect(md).toContain('- Status: failed');
    expect(md).toContain('- Failure reason: timeout');
    expect(md).toContain('## Final response');
    expect(md).toContain('_(empty)_');
  });

  it('finalText が空文字や空白のみでもプレースホルダを入れる', () => {
    const md = renderSummary({
      runId: RUN_ID,
      issueNumber: 1,
      status: 'success',
      finalText: '   \n\n   ',
    });
    expect(md).toContain('_(empty)_');
  });
});
