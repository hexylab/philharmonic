import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  renderFailureSummary,
  resolveFailureSummaryPath,
  writeFailureSummary,
  type FailureSummaryInput,
} from '../../src/orchestrator/failure-summary.js';

const FIXED_RUN_ID = '0190ce80-0000-7000-8000-000000000000';

function makeInput(overrides: Partial<FailureSummaryInput> = {}): FailureSummaryInput {
  return {
    runnerLogsRoot: '/tmp/runs',
    runId: FIXED_RUN_ID,
    issueNumber: 19,
    attempt: 5,
    maxAttempts: 5,
    failureReason: 'runner_error',
    branch: 'feature/19-add-foo',
    workspacePath: '/home/user/.philharmonic/worktrees/issue-19',
    errorSummary: 'claude exited with code 1: connection reset',
    exhaustedAt: new Date('2026-05-09T00:00:00.000Z'),
    ...overrides,
  };
}

describe('renderFailureSummary', () => {
  it('運用者が必要な情報をすべて Markdown に含める', () => {
    const md = renderFailureSummary(makeInput());

    expect(md).toContain('# Run Failed (Retry Exhausted)');
    expect(md).toContain('Issue: #19');
    expect(md).toContain('Final attempt: 5');
    expect(md).toContain('Max attempts: 5');
    expect(md).toContain('Last failure reason: runner_error');
    expect(md).toContain(`Last run id: ${FIXED_RUN_ID}`);
    expect(md).toContain('Branch: feature/19-add-foo');
    expect(md).toContain('Workspace path: /home/user/.philharmonic/worktrees/issue-19');
    expect(md).toContain('Exhausted at: 2026-05-09T00:00:00.000Z');
    expect(md).toContain('claude exited with code 1: connection reset');
    expect(md).toContain(`.philharmonic/runs/${FIXED_RUN_ID}/summary.md`);
    expect(md).toContain(`.philharmonic/runs/${FIXED_RUN_ID}/stream.jsonl`);
    expect(md).toContain(`.philharmonic/runs/${FIXED_RUN_ID}/stderr.log`);
    expect(md).toContain(`.philharmonic/runs/${FIXED_RUN_ID}/metadata.json`);
    expect(md).toContain('philharmonic retry #19');
  });

  it('errorSummary が null / 空文字なら "(empty)" 表記にする', () => {
    expect(renderFailureSummary(makeInput({ errorSummary: null }))).toContain('_(empty)_');
    expect(renderFailureSummary(makeInput({ errorSummary: '' }))).toContain('_(empty)_');
    expect(renderFailureSummary(makeInput({ errorSummary: '   \n\t  ' }))).toContain('_(empty)_');
  });
});

describe('resolveFailureSummaryPath', () => {
  it('<runnerLogsRoot>/<runId>/failure-summary.md を返す', () => {
    expect(resolveFailureSummaryPath('/tmp/runs', FIXED_RUN_ID)).toBe(
      path.join('/tmp/runs', FIXED_RUN_ID, 'failure-summary.md'),
    );
  });
});

describe('writeFailureSummary', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-failsum-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('既存 run log dir に failure-summary.md を書き込み path を返す', async () => {
    const runId = FIXED_RUN_ID;
    const runDir = path.join(tempDir, runId);
    mkdirSync(runDir, { recursive: true });

    const result = await writeFailureSummary(makeInput({ runnerLogsRoot: tempDir, runId }));

    expect(result.path).toBe(path.join(runDir, 'failure-summary.md'));
    const body = readFileSync(result.path, 'utf8');
    expect(body).toContain('# Run Failed (Retry Exhausted)');
    expect(body).toContain('Issue: #19');
  });

  it('run log dir が存在しなければ ENOENT で reject する (caller が catch する)', async () => {
    await expect(
      writeFailureSummary(
        makeInput({ runnerLogsRoot: path.join(tempDir, 'missing'), runId: FIXED_RUN_ID }),
      ),
    ).rejects.toThrow();
  });
});
