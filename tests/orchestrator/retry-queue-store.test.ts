import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRetryQueue,
  createRetryQueueFileStore,
  loadRetryQueueEntries,
  RETRY_QUEUE_STATE_VERSION,
  type RetryQueueScheduleInput,
  type RetryQueueStateJson,
} from '../../src/orchestrator/index.js';

let workDir: string;
let stateFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'phil-retry-store-'));
  stateFile = path.join(workDir, 'retry-queue.json');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const REPO = { owner: 'hexylab', name: 'philharmonic' };

function baseInput(overrides: Partial<RetryQueueScheduleInput> = {}): RetryQueueScheduleInput {
  return {
    kind: 'failure',
    issueNumber: 42,
    repository: REPO,
    branch: 'feature/42-foo',
    workspacePath: '/abs/.philharmonic/worktrees/issue-42',
    attempt: 1,
    failureReason: 'runner_error',
    lastRunId: '0190ce80-0000-7000-8000-000000000001',
    lastErrorSummary: 'boom',
    now: new Date('2026-05-09T00:00:00Z'),
    maxBackoffMs: 300_000,
    ...overrides,
  };
}

describe('loadRetryQueueEntries', () => {
  it('file 不在のときは outcome=empty を返し throw しない', async () => {
    const result = await loadRetryQueueEntries(stateFile);
    expect(result.outcome).toEqual({ kind: 'empty' });
    expect(result.entries).toEqual([]);
    expect(result.invalidEntries).toEqual([]);
  });

  it('正常な state file を schema 通りに復元する', async () => {
    const payload: RetryQueueStateJson = {
      version: RETRY_QUEUE_STATE_VERSION,
      entries: [
        {
          kind: 'failure',
          issueNumber: 42,
          repository: REPO,
          branch: 'feature/42-foo',
          workspacePath: '/abs/.philharmonic/worktrees/issue-42',
          attempt: 3,
          dueAt: '2026-05-09T00:00:30.000Z',
          scheduledAt: '2026-05-09T00:00:00.000Z',
          failureReason: 'runner_error',
          lastRunId: '0190ce80-0000-7000-8000-000000000001',
          lastErrorSummary: 'boom',
        },
      ],
    };
    await writeFile(stateFile, JSON.stringify(payload), 'utf8');

    const result = await loadRetryQueueEntries(stateFile);
    expect(result.outcome).toEqual({ kind: 'restored', count: 1 });
    expect(result.entries).toHaveLength(1);
    const restored = result.entries[0]!;
    expect(restored.attempt).toBe(3);
    expect(restored.dueAt.toISOString()).toBe('2026-05-09T00:00:30.000Z');
    expect(restored.scheduledAt.toISOString()).toBe('2026-05-09T00:00:00.000Z');
    expect(restored.failureReason).toBe('runner_error');
    expect(restored.lastErrorSummary).toBe('boom');
  });

  it('JSON parse 失敗時は state file を <path>.bak に rename し empty で起動する', async () => {
    await writeFile(stateFile, 'not-json-at-all', 'utf8');

    const result = await loadRetryQueueEntries(stateFile);
    expect(result.outcome.kind).toBe('parse_failed');
    if (result.outcome.kind === 'parse_failed') {
      expect(result.outcome.backupPath).toBe(`${stateFile}.bak`);
    }
    expect(result.entries).toEqual([]);
    await expect(stat(`${stateFile}.bak`)).resolves.toBeDefined();
    await expect(stat(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('version mismatch は warn outcome を返し file は残す', async () => {
    await writeFile(stateFile, JSON.stringify({ version: 999, entries: [] }), 'utf8');

    const result = await loadRetryQueueEntries(stateFile);
    expect(result.outcome).toEqual({ kind: 'version_mismatch', version: 999 });
    expect(result.entries).toEqual([]);
    await expect(stat(stateFile)).resolves.toBeDefined();
    await expect(stat(`${stateFile}.bak`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('entry 単位の schema 違反は該当 entry のみ skip し残りは採用する', async () => {
    const payload: RetryQueueStateJson = {
      version: RETRY_QUEUE_STATE_VERSION,
      entries: [
        // valid
        {
          kind: 'failure',
          issueNumber: 42,
          repository: REPO,
          branch: 'feature/42-foo',
          workspacePath: '/abs/issue-42',
          attempt: 1,
          dueAt: '2026-05-09T00:00:30.000Z',
          scheduledAt: '2026-05-09T00:00:00.000Z',
          failureReason: 'runner_error',
          lastRunId: 'run-1',
          lastErrorSummary: null,
        },
        // invalid: missing branch
        {
          kind: 'failure',
          issueNumber: 43,
          repository: REPO,
          branch: '',
          workspacePath: '/abs/issue-43',
          attempt: 1,
          dueAt: '2026-05-09T00:00:30.000Z',
          scheduledAt: '2026-05-09T00:00:00.000Z',
          failureReason: 'runner_error',
          lastRunId: 'run-2',
          lastErrorSummary: null,
        },
        // invalid: invalid kind
        {
          // @ts-expect-error -- 検証目的で不正な kind を渡す
          kind: 'unknown',
          issueNumber: 44,
          repository: REPO,
          branch: 'feature/44',
          workspacePath: '/abs/issue-44',
          attempt: 1,
          dueAt: '2026-05-09T00:00:30.000Z',
          scheduledAt: '2026-05-09T00:00:00.000Z',
          failureReason: 'runner_error',
          lastRunId: 'run-3',
          lastErrorSummary: null,
        },
      ],
    };
    await writeFile(stateFile, JSON.stringify(payload), 'utf8');

    const result = await loadRetryQueueEntries(stateFile);
    expect(result.entries.map((e) => e.issueNumber)).toEqual([42]);
    expect(result.invalidEntries).toHaveLength(2);
    expect(result.invalidEntries[0]!.issueNumber).toBe(43);
    expect(result.invalidEntries[0]!.reason).toBe('missing_field');
    expect(result.invalidEntries[1]!.issueNumber).toBe(44);
    expect(result.invalidEntries[1]!.reason).toBe('invalid_kind');
  });

  it('continuation kind で誤って failureReason が persist されても null に正規化される', async () => {
    const payload: RetryQueueStateJson = {
      version: RETRY_QUEUE_STATE_VERSION,
      entries: [
        {
          kind: 'continuation',
          issueNumber: 50,
          repository: REPO,
          branch: 'feature/50',
          workspacePath: '/abs/issue-50',
          attempt: 1,
          dueAt: '2026-05-09T00:00:10.000Z',
          scheduledAt: '2026-05-09T00:00:00.000Z',
          failureReason: 'runner_error', // 誤値
          lastRunId: 'run-50',
          lastErrorSummary: 'leftover', // 誤値
        },
      ],
    };
    await writeFile(stateFile, JSON.stringify(payload), 'utf8');

    const result = await loadRetryQueueEntries(stateFile);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.failureReason).toBeNull();
    expect(result.entries[0]!.lastErrorSummary).toBeNull();
  });

  it('重複 issueNumber は後勝ちで 1 件だけ採用される', async () => {
    const payload: RetryQueueStateJson = {
      version: RETRY_QUEUE_STATE_VERSION,
      entries: [
        {
          kind: 'failure',
          issueNumber: 42,
          repository: REPO,
          branch: 'feature/42-foo',
          workspacePath: '/abs/issue-42',
          attempt: 1,
          dueAt: '2026-05-09T00:00:30.000Z',
          scheduledAt: '2026-05-09T00:00:00.000Z',
          failureReason: 'runner_error',
          lastRunId: 'run-old',
          lastErrorSummary: null,
        },
        {
          kind: 'failure',
          issueNumber: 42,
          repository: REPO,
          branch: 'feature/42-foo',
          workspacePath: '/abs/issue-42',
          attempt: 5,
          dueAt: '2026-05-09T00:01:00.000Z',
          scheduledAt: '2026-05-09T00:00:30.000Z',
          failureReason: 'runner_error',
          lastRunId: 'run-new',
          lastErrorSummary: null,
        },
      ],
    };
    await writeFile(stateFile, JSON.stringify(payload), 'utf8');

    const result = await loadRetryQueueEntries(stateFile);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.attempt).toBe(5);
    expect(result.entries[0]!.lastRunId).toBe('run-new');
  });

  it('top-level entries が array でないときは parse_failed (bak rename あり) を返す', async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ version: RETRY_QUEUE_STATE_VERSION, entries: { not: 'array' } }),
      'utf8',
    );
    const result = await loadRetryQueueEntries(stateFile);
    expect(result.outcome.kind).toBe('parse_failed');
    await expect(stat(`${stateFile}.bak`)).resolves.toBeDefined();
  });
});

describe('createRetryQueueFileStore', () => {
  it('save 後の file は loadRetryQueueEntries で同じ entry に復元できる (roundtrip)', async () => {
    const store = createRetryQueueFileStore({ filePath: stateFile });
    const queue = createRetryQueue({ store });
    queue.schedule(baseInput({ attempt: 2, now: new Date('2026-05-09T00:00:00Z') }));
    queue.schedule(
      baseInput({
        issueNumber: 43,
        attempt: 1,
        lastErrorSummary: null,
        now: new Date('2026-05-09T00:00:00Z'),
      }),
    );
    await store.flush();

    const result = await loadRetryQueueEntries(stateFile);
    expect(result.outcome).toEqual({ kind: 'restored', count: 2 });

    const restoredById = new Map(result.entries.map((e) => [e.issueNumber, e]));
    const a = restoredById.get(42);
    const b = restoredById.get(43);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.attempt).toBe(2);
    // attempt=2 → 20s 後
    expect(a!.dueAt.toISOString()).toBe('2026-05-09T00:00:20.000Z');
    expect(a!.scheduledAt.toISOString()).toBe('2026-05-09T00:00:00.000Z');
    expect(a!.failureReason).toBe('runner_error');
    expect(a!.lastRunId).toBe('0190ce80-0000-7000-8000-000000000001');
    expect(a!.lastErrorSummary).toBe('boom');
    expect(a!.repository).toEqual(REPO);
    expect(b!.attempt).toBe(1);
    expect(b!.dueAt.toISOString()).toBe('2026-05-09T00:00:10.000Z');
  });

  it('複数 save が並列に発火しても直列化され、最後の snapshot で確定する', async () => {
    const store = createRetryQueueFileStore({ filePath: stateFile });
    const queue = createRetryQueue({ store });
    for (let i = 0; i < 10; i += 1) {
      queue.schedule(baseInput({ issueNumber: 100 + i, attempt: 1 }));
    }
    queue.remove(105);
    await store.flush();

    const result = await loadRetryQueueEntries(stateFile);
    expect(result.entries.map((e) => e.issueNumber).sort((a, b) => a - b)).toEqual([
      100, 101, 102, 103, 104, 106, 107, 108, 109,
    ]);
  });

  it('drainDue 後は queue 空状態を永続化する', async () => {
    const store = createRetryQueueFileStore({ filePath: stateFile });
    const queue = createRetryQueue({ store });
    queue.schedule(baseInput({ now: new Date('2026-05-09T00:00:00Z'), attempt: 1 }));
    await store.flush();
    queue.drainDue(new Date('2026-05-09T01:00:00Z'));
    await store.flush();

    const result = await loadRetryQueueEntries(stateFile);
    expect(result.entries).toEqual([]);
  });

  it('initialEntries を渡したときは save が走らず (= ファイル不在の場合は file 作成もしない)', async () => {
    const store = createRetryQueueFileStore({ filePath: stateFile });
    createRetryQueue({
      store,
      initialEntries: [
        {
          kind: 'failure',
          issueNumber: 1,
          repository: REPO,
          branch: 'feature/1',
          workspacePath: '/abs/1',
          attempt: 1,
          dueAt: new Date('2026-05-09T00:00:30Z'),
          scheduledAt: new Date('2026-05-09T00:00:00Z'),
          failureReason: 'runner_error',
          lastRunId: 'r1',
          lastErrorSummary: null,
        },
      ],
    });
    await store.flush();
    await expect(stat(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('save 失敗は warn ログを残しつつ throw しない (degraded behavior)', async () => {
    const logger = {
      level: 'info' as const,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    // file path 自体を directory にして writeFile を EISDIR で失敗させる
    const blocked = path.join(workDir, 'retry-queue-as-dir.json');
    await mkdir(blocked, { recursive: true });
    const store = createRetryQueueFileStore({ filePath: blocked, logger });
    const queue = createRetryQueue({ store });

    queue.schedule(baseInput({ attempt: 1 }));
    await store.flush();

    expect(logger.warn).toHaveBeenCalledWith(
      'retry queue persist failed',
      expect.objectContaining({ path: blocked }),
    );
    // in-memory state は失われない
    expect(queue.size()).toBe(1);
  });

  it('atomic write は tmp file を経由してから rename する (中断時に半端ファイルが残らない)', async () => {
    const store = createRetryQueueFileStore({ filePath: stateFile });
    const queue = createRetryQueue({ store });
    queue.schedule(baseInput({ attempt: 1 }));
    await store.flush();

    const text = await readFile(stateFile, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as RetryQueueStateJson;
    expect(parsed.version).toBe(RETRY_QUEUE_STATE_VERSION);

    // tmp ファイルは残っていない
    await expect(stat(`${stateFile}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('createRetryQueue with initialEntries', () => {
  it('initialEntries は load 直後の queue snapshot として採用される', () => {
    const queue = createRetryQueue({
      initialEntries: [
        {
          kind: 'failure',
          issueNumber: 7,
          repository: REPO,
          branch: 'feature/7',
          workspacePath: '/abs/7',
          attempt: 4,
          dueAt: new Date('2026-05-09T00:01:00Z'),
          scheduledAt: new Date('2026-05-09T00:00:00Z'),
          failureReason: 'runner_error',
          lastRunId: 'rId',
          lastErrorSummary: 'x',
        },
      ],
    });
    expect(queue.size()).toBe(1);
    expect(queue.list()[0]!.attempt).toBe(4);
    expect(queue.has(7)).toBe(true);
  });
});
