import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMarker,
  notifyFailureExhausted,
  renderExhaustionComment,
  resolveCommentBodyPath,
  type ExhaustionNotifyInput,
} from '../../src/orchestrator/exhaustion-notify.js';
import type { ProjectsClient } from '../../src/projects/index.js';
import type { GhRunner } from '../../src/projects/status-update.js';

const FIXED_RUN_ID = '0190ce80-0000-7000-8000-000000000000';

type LoggerMock = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  level: 'info';
  child: () => LoggerMock;
};

function makeLogger(): LoggerMock {
  const logger: LoggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    level: 'info',
    child: () => logger,
  };
  return logger;
}

function makeInput(
  runnerLogsRoot: string,
  overrides: Partial<ExhaustionNotifyInput> = {},
): ExhaustionNotifyInput {
  return {
    owner: 'hexylab',
    projectNumber: 2,
    statusFieldName: 'Status',
    failedStatus: 'Failed',
    issueNumber: 103,
    repository: { owner: 'hexylab', name: 'philharmonic' },
    itemId: 'PVTI_xyz',
    attempt: 5,
    maxAttempts: 5,
    failureReason: 'runner_error',
    runId: FIXED_RUN_ID,
    branch: 'feature/103-retry-exhausted',
    workspacePath: '/home/user/.philharmonic/worktrees/issue-103',
    errorSummary: 'claude exited with code 1: connection reset',
    failureSummaryPath: path.join(runnerLogsRoot, FIXED_RUN_ID, 'failure-summary.md'),
    runnerLogsRoot,
    exhaustedAt: new Date('2026-05-11T00:00:00.000Z'),
    ...overrides,
  };
}

function makeProjectsClient(projectId = 'PVT_xyz'): ProjectsClient {
  return {
    fetchProjectCandidates: vi.fn(async () => []),
    fetchProjectContext: vi.fn(async () => ({ projectId, candidates: [] })),
  };
}

describe('buildMarker', () => {
  it('run_id を埋め込んだ HTML コメント marker を返す', () => {
    expect(buildMarker('abc')).toBe('<!-- philharmonic-run-failed:run_id=abc -->');
  });
});

describe('resolveCommentBodyPath', () => {
  it('<runnerLogsRoot>/<runId>/issue-comment.md を返す', () => {
    expect(resolveCommentBodyPath('/tmp/runs', FIXED_RUN_ID)).toBe(
      path.join('/tmp/runs', FIXED_RUN_ID, 'issue-comment.md'),
    );
  });
});

describe('renderExhaustionComment', () => {
  it('marker / 復旧手順 / artifact path / failure reason を本文に含める', () => {
    const marker = buildMarker(FIXED_RUN_ID);
    const body = renderExhaustionComment(makeInput('/tmp/runs'), marker);

    expect(body.startsWith(marker)).toBe(true);
    expect(body).toContain('Issue #103 は自動 retry 上限');
    expect(body).toContain('`Failed`');
    expect(body).toContain('Final attempt: 5 / 5');
    expect(body).toContain('Last failure reason: `runner_error`');
    expect(body).toContain(`Last run id: \`${FIXED_RUN_ID}\``);
    expect(body).toContain('Branch: `feature/103-retry-exhausted`');
    expect(body).toContain(`.philharmonic/runs/${FIXED_RUN_ID}/failure-summary.md`);
    expect(body).toContain(`.philharmonic/runs/${FIXED_RUN_ID}/summary.md`);
    expect(body).toContain(`.philharmonic/runs/${FIXED_RUN_ID}/stream.jsonl`);
    expect(body).toContain(`.philharmonic/runs/${FIXED_RUN_ID}/stderr.log`);
    expect(body).toContain('philharmonic retry 103');
  });

  it('failureSummaryPath が null の場合は failure summary 行を省略する', () => {
    const marker = buildMarker(FIXED_RUN_ID);
    const body = renderExhaustionComment(
      makeInput('/tmp/runs', { failureSummaryPath: null }),
      marker,
    );
    expect(body).not.toContain('failure-summary.md');
    expect(body).toContain('summary.md');
  });

  it('failedStatus が config 値 (例: Aborted) を反映する', () => {
    const body = renderExhaustionComment(
      makeInput('/tmp/runs', { failedStatus: 'Aborted' }),
      buildMarker(FIXED_RUN_ID),
    );
    expect(body).toContain('`Aborted`');
  });
});

describe('notifyFailureExhausted', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'phil-exhaust-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('既存 marker 無しなら Status 更新 + Comment 投稿を実行する', async () => {
    mkdirSync(path.join(tempDir, FIXED_RUN_ID), { recursive: true });
    const runGh = vi.fn<GhRunner>(async (args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: JSON.stringify({ comments: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          stdout: JSON.stringify({
            fields: [
              {
                id: 'F_status',
                name: 'Status',
                type: 'ProjectV2SingleSelectField',
                options: [
                  { id: 'F_failed', name: 'Failed' },
                  { id: 'F_todo', name: 'Todo' },
                ],
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const projectsClient = makeProjectsClient('PVT_xyz');
    const logger = makeLogger();

    const result = await notifyFailureExhausted(makeInput(tempDir), {
      runGh,
      projectsClient,
      logger,
    });

    expect(result).toEqual({
      statusUpdated: true,
      commentPosted: true,
      duplicateSkipped: false,
    });

    // 引数アサート
    const calls = runGh.mock.calls.map((c) => c[0]);
    // gh issue view --json comments
    const viewArgs = calls.find((args) => args[0] === 'issue' && args[1] === 'view');
    expect(viewArgs).toEqual([
      'issue',
      'view',
      '103',
      '--repo',
      'hexylab/philharmonic',
      '--json',
      'comments',
    ]);
    // gh project field-list
    expect(calls.find((args) => args[0] === 'project' && args[1] === 'field-list')).toEqual([
      'project',
      'field-list',
      '2',
      '--owner',
      'hexylab',
      '--format',
      'json',
      '--limit',
      '100',
    ]);
    // gh project item-edit --field-id F_status --single-select-option-id F_failed
    const editArgs = calls.find((args) => args[0] === 'project' && args[1] === 'item-edit');
    expect(editArgs).toEqual([
      'project',
      'item-edit',
      '--id',
      'PVTI_xyz',
      '--project-id',
      'PVT_xyz',
      '--field-id',
      'F_status',
      '--single-select-option-id',
      'F_failed',
    ]);
    // gh issue comment with --body-file
    const commentArgs = calls.find((args) => args[0] === 'issue' && args[1] === 'comment');
    expect(commentArgs?.slice(0, 6)).toEqual([
      'issue',
      'comment',
      '103',
      '--repo',
      'hexylab/philharmonic',
      '--body-file',
    ]);
    const bodyFilePath = commentArgs![6]!;
    const body = readFileSync(bodyFilePath, 'utf8');
    expect(body).toContain(buildMarker(FIXED_RUN_ID));
    expect(body).toContain('Issue #103 は自動 retry 上限');
  });

  it('既存コメントに同じ run_id の marker があれば comment 投稿を skip する', async () => {
    mkdirSync(path.join(tempDir, FIXED_RUN_ID), { recursive: true });
    const marker = buildMarker(FIXED_RUN_ID);
    const runGh = vi.fn<GhRunner>(async (args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            comments: [{ body: `${marker}\n\n## previously notified` }],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          stdout: JSON.stringify({
            fields: [
              {
                id: 'F_status',
                name: 'Status',
                type: 'ProjectV2SingleSelectField',
                options: [{ id: 'F_failed', name: 'Failed' }],
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const projectsClient = makeProjectsClient();
    const logger = makeLogger();

    const result = await notifyFailureExhausted(makeInput(tempDir), {
      runGh,
      projectsClient,
      logger,
    });

    expect(result.duplicateSkipped).toBe(true);
    expect(result.commentPosted).toBe(false);
    // Status 更新は実行される (Issue の状態と Project Status は独立に保つ)
    expect(result.statusUpdated).toBe(true);

    // gh issue comment は呼ばれない
    const calls = runGh.mock.calls.map((c) => c[0]);
    expect(calls.find((args) => args[0] === 'issue' && args[1] === 'comment')).toBeUndefined();
    expect(
      logger.info.mock.calls.find((c) => c[0] === 'exhaustion notify skipped (already commented)'),
    ).toBeDefined();
  });

  it('Status 更新が失敗しても Comment 投稿は試みる (warn ログ + 続行)', async () => {
    mkdirSync(path.join(tempDir, FIXED_RUN_ID), { recursive: true });
    const runGh = vi.fn<GhRunner>(async (args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: JSON.stringify({ comments: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        throw new Error('gh project field-list: boom');
      }
      return { stdout: '', stderr: '' };
    });
    const projectsClient = makeProjectsClient();
    const logger = makeLogger();

    const result = await notifyFailureExhausted(makeInput(tempDir), {
      runGh,
      projectsClient,
      logger,
    });

    expect(result.statusUpdated).toBe(false);
    expect(result.commentPosted).toBe(true);
    expect(
      logger.warn.mock.calls.find((c) => c[0] === 'exhaustion status update failed'),
    ).toBeDefined();
  });

  it('Comment 投稿が失敗しても throw せず warn ログを残す', async () => {
    mkdirSync(path.join(tempDir, FIXED_RUN_ID), { recursive: true });
    const runGh = vi.fn<GhRunner>(async (args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: JSON.stringify({ comments: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          stdout: JSON.stringify({
            fields: [
              {
                id: 'F_status',
                name: 'Status',
                type: 'ProjectV2SingleSelectField',
                options: [{ id: 'F_failed', name: 'Failed' }],
              },
            ],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        throw new Error('gh issue comment: rate limited');
      }
      return { stdout: '', stderr: '' };
    });
    const projectsClient = makeProjectsClient();
    const logger = makeLogger();

    await expect(
      notifyFailureExhausted(makeInput(tempDir), {
        runGh,
        projectsClient,
        logger,
      }),
    ).resolves.toMatchObject({ statusUpdated: true, commentPosted: false });
    expect(
      logger.warn.mock.calls.find((c) => c[0] === 'exhaustion comment post failed'),
    ).toBeDefined();
  });

  it('dedup チェックが throw した場合は安全側に倒し comment を投稿しない (Status は更新する)', async () => {
    mkdirSync(path.join(tempDir, FIXED_RUN_ID), { recursive: true });
    const runGh = vi.fn<GhRunner>(async (args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        throw new Error('gh issue view: 403');
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          stdout: JSON.stringify({
            fields: [
              {
                id: 'F_status',
                name: 'Status',
                type: 'ProjectV2SingleSelectField',
                options: [{ id: 'F_failed', name: 'Failed' }],
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const projectsClient = makeProjectsClient();
    const logger = makeLogger();

    const result = await notifyFailureExhausted(makeInput(tempDir), {
      runGh,
      projectsClient,
      logger,
    });

    expect(result.statusUpdated).toBe(true);
    expect(result.commentPosted).toBe(false);
    expect(result.duplicateSkipped).toBe(false);
    const calls = runGh.mock.calls.map((c) => c[0]);
    expect(calls.find((args) => args[0] === 'issue' && args[1] === 'comment')).toBeUndefined();
    expect(
      logger.warn.mock.calls.find((c) => c[0] === 'exhaustion comment dedup check failed'),
    ).toBeDefined();
  });
});
