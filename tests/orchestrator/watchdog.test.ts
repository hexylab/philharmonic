import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWatchdog, type RunMetadataSnapshot } from '../../src/orchestrator/watchdog.js';
import { createRunTracker, type RunTracker } from '../../src/server/tracker.js';

function startTracker(input: {
  runId: string;
  issueNumber: number;
  branch?: string;
  startedAt: Date;
  workspacePath: string;
  runLogPath: string;
}): RunTracker {
  const tracker = createRunTracker({ startedAt: input.startedAt });
  tracker.runStarted({
    runId: input.runId,
    issueNumber: input.issueNumber,
    branch: input.branch ?? `feature/${input.issueNumber}-x`,
    startedAt: input.startedAt,
    workspacePath: input.workspacePath,
    runLogPath: input.runLogPath,
  });
  return tracker;
}

describe('runWatchdog', () => {
  describe('terminal repair', () => {
    it('metadata.json (status: success) があれば runFinished で tracker から外す', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:01:00Z'),
        readMetadata: async () => ({
          status: 'success',
          failureReason: null,
          totalCostUsd: 1.5,
        }),
        processAlive: () => true,
      });

      expect(result.repaired).toEqual([
        {
          runId: 'r-1',
          issueNumber: 42,
          status: 'success',
          failureReason: null,
          totalCostUsd: 1.5,
        },
      ]);
      expect(result.markers).toEqual([]);
      expect(tracker.listRunning()).toEqual([]);
      expect(tracker.getTotals()).toMatchObject({
        runsCompleted: 1,
        runsSucceeded: 1,
        runsFailed: 0,
        totalCostUsd: 1.5,
      });
    });

    it('metadata.json (status: failed) は failureReason 付きで runFinished する', async () => {
      const tracker = startTracker({
        runId: 'r-2',
        issueNumber: 7,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-7',
        runLogPath: '/tmp/runs/r-2',
      });
      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:01:00Z'),
        readMetadata: async () => ({
          status: 'failed',
          failureReason: 'timeout',
          totalCostUsd: null,
        }),
        processAlive: () => true,
      });

      expect(result.repaired).toEqual([
        {
          runId: 'r-2',
          issueNumber: 7,
          status: 'failed',
          failureReason: 'timeout',
          totalCostUsd: null,
        },
      ]);
      expect(tracker.getTotals()).toMatchObject({ runsFailed: 1 });
    });

    it('metadata 読み取り error は warn を残して repair を skip し、orphaned/stale 判定は続ける', async () => {
      const tracker = startTracker({
        runId: 'r-3',
        issueNumber: 9,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-9',
        runLogPath: '/tmp/runs/r-3',
      });
      tracker.recordRunnerProcess('r-3', 99);

      const logger = {
        level: 'info' as const,
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      };
      logger.child = vi.fn(() => logger);

      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:01:00Z'),
        logger,
        readMetadata: async () => {
          throw new Error('boom');
        },
        // pid 99 は dead
        processAlive: () => false,
      });

      expect(result.repaired).toEqual([]);
      // orphaned 判定が続行されたことを確認
      expect(result.markers).toHaveLength(1);
      expect(result.markers[0]?.reasons).toContain('orphaned');
      expect(logger.warn).toHaveBeenCalledWith(
        'watchdog metadata read failed',
        expect.objectContaining({ runId: 'r-3', error: 'boom' }),
      );
    });

    it('metadata 不在 (ENOENT) は repair せず orphaned/stale も無ければ marker を出さない', async () => {
      const tracker = startTracker({
        runId: 'r-4',
        issueNumber: 11,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-11',
        runLogPath: '/tmp/runs/r-4',
      });
      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:30Z'),
        readMetadata: async () => null,
        processAlive: () => true,
      });
      expect(result.repaired).toEqual([]);
      expect(result.markers).toEqual([]);
      expect(tracker.listRunning()).toHaveLength(1);
    });
  });

  describe('orphaned 判定', () => {
    it('runnerPid が ESRCH なら orphaned marker を立てる', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      tracker.recordRunnerProcess('r-1', 12345);

      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:30Z'),
        readMetadata: async () => null,
        processAlive: (pid) => pid !== 12345,
      });

      expect(result.markers).toHaveLength(1);
      expect(result.markers[0]).toMatchObject({
        runId: 'r-1',
        reasons: ['orphaned'],
        orphanedSince: '2026-05-09T00:00:30.000Z',
        staleSince: null,
      });
      expect(tracker.getRunningByIssue(42)?.watchdog).toEqual({
        reasons: ['orphaned'],
        orphanedSince: '2026-05-09T00:00:30.000Z',
        staleSince: null,
        operatorActionRequired: true,
        operatorActionReasons: ['orphaned_only'],
      });
    });

    it('runnerPid が null の場合は orphaned 判定をスキップする (= marker を出さない)', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      // recordRunnerProcess を呼ばない → runnerPid は null

      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:30Z'),
        readMetadata: async () => null,
        processAlive: () => false,
      });
      expect(result.markers).toEqual([]);
    });

    it('orphanedSince は再評価で持続する (active な間は同じ値)', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      tracker.recordRunnerProcess('r-1', 999);

      const first = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:30Z'),
        readMetadata: async () => null,
        processAlive: () => false,
      });
      expect(first.markers[0]?.orphanedSince).toBe('2026-05-09T00:00:30.000Z');

      const second = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:01:00Z'),
        readMetadata: async () => null,
        processAlive: () => false,
      });
      // 初出時刻が保持される (繰り返しても新しい時刻に上書きされない)
      expect(second.markers[0]?.orphanedSince).toBe('2026-05-09T00:00:30.000Z');
    });

    it('orphaned が解消したら marker を null に戻す', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      tracker.recordRunnerProcess('r-1', 999);

      await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:30Z'),
        readMetadata: async () => null,
        processAlive: () => false,
      });
      expect(tracker.getRunningByIssue(42)?.watchdog).not.toBeNull();

      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:01:00Z'),
        readMetadata: async () => null,
        processAlive: () => true,
      });
      expect(result.markers).toEqual([]);
      expect(tracker.getRunningByIssue(42)?.watchdog).toBeNull();
    });
  });

  describe('stale 判定', () => {
    it('lastActivityAt から stallTimeoutMs * 2 を超えたら stale marker を立てる', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      tracker.recordActivity('r-1', new Date('2026-05-09T00:00:30Z'));

      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:03:00Z'), // last_activity から 150s = 60s * 2 = 120s 超過
        readMetadata: async () => null,
        processAlive: () => true,
      });

      expect(result.markers).toHaveLength(1);
      expect(result.markers[0]?.reasons).toEqual(['stale']);
      expect(result.markers[0]?.staleSince).toBe('2026-05-09T00:03:00.000Z');
    });

    it('stallTimeoutMs <= 0 は stale 判定 off', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 0,
        now: new Date('2026-05-09T01:00:00Z'),
        readMetadata: async () => null,
        processAlive: () => true,
      });
      expect(result.markers).toEqual([]);
    });

    it('stallTimeoutMs * 2 を超えていなければ stale を立てない', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:02:00Z'), // 120s = 2 * 60s; > は満たさない (= の外)
        readMetadata: async () => null,
        processAlive: () => true,
      });
      expect(result.markers).toEqual([]);
    });
  });

  describe('orphaned + stale 同時', () => {
    it('両方の reasons を載せる', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      tracker.recordRunnerProcess('r-1', 999);
      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:03:00Z'),
        readMetadata: async () => null,
        processAlive: () => false,
      });
      expect(result.markers[0]?.reasons).toEqual(['orphaned', 'stale']);
    });
  });

  describe('default readMetadata (実 fs)', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'philharmonic-watchdog-'));
    });
    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('実在の metadata.json を読んで repair する', async () => {
      const runDir = path.join(tempDir, 'run-x');
      await mkdir(runDir, { recursive: true });
      const metadata = {
        run_id: 'run-x',
        issue_number: 7,
        started_at: '2026-05-09T00:00:00Z',
        finished_at: '2026-05-09T00:00:30Z',
        status: 'failed',
        failure_reason: 'runner_error',
        total_cost_usd: 0.42,
        branch: 'feature/7-x',
      };
      await writeFile(path.join(runDir, 'metadata.json'), JSON.stringify(metadata));

      const tracker = startTracker({
        runId: 'run-x',
        issueNumber: 7,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: path.join(tempDir, 'ws', 'issue-7'),
        runLogPath: runDir,
      });

      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:01:00Z'),
        // readMetadata 未指定 = default 実装が走る
      });
      expect(result.repaired).toEqual([
        {
          runId: 'run-x',
          issueNumber: 7,
          status: 'failed',
          failureReason: 'runner_error',
          totalCostUsd: 0.42,
        },
      ]);
      expect(tracker.getTotals()).toMatchObject({ runsFailed: 1, totalCostUsd: 0.42 });
    });

    it('parse 不能な metadata.json は repair せず継続する', async () => {
      const runDir = path.join(tempDir, 'run-broken');
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, 'metadata.json'), 'not-json{');

      const tracker = startTracker({
        runId: 'run-broken',
        issueNumber: 8,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: path.join(tempDir, 'ws', 'issue-8'),
        runLogPath: runDir,
      });

      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:10Z'),
      });
      expect(result.repaired).toEqual([]);
      expect(tracker.listRunning()).toHaveLength(1);
    });
  });

  describe('default processAlive (process.kill)', () => {
    it('生存している現プロセスの pid を alive と判定する', async () => {
      const tracker = startTracker({
        runId: 'r',
        issueNumber: 1,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-1',
        runLogPath: '/tmp/runs/r',
      });
      // process.pid (= 自分自身) は当然 alive
      tracker.recordRunnerProcess('r', process.pid);
      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:30Z'),
        readMetadata: async () => null,
      });
      expect(result.markers).toEqual([]);
    });
  });

  describe('複数 entry の順序', () => {
    it('複数 entry を独立に処理し、結果を返す', async () => {
      const tracker = createRunTracker({ startedAt: new Date('2026-05-09T00:00:00Z') });
      tracker.runStarted({
        runId: 'r-orphan',
        issueNumber: 1,
        branch: 'feature/1-x',
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-1',
        runLogPath: '/tmp/runs/r-orphan',
      });
      tracker.recordRunnerProcess('r-orphan', 1001);
      tracker.runStarted({
        runId: 'r-repair',
        issueNumber: 2,
        branch: 'feature/2-x',
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-2',
        runLogPath: '/tmp/runs/r-repair',
      });
      tracker.runStarted({
        runId: 'r-healthy',
        issueNumber: 3,
        branch: 'feature/3-x',
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-3',
        runLogPath: '/tmp/runs/r-healthy',
      });

      const metadataMap: Record<string, RunMetadataSnapshot | null> = {
        '/tmp/runs/r-repair': { status: 'success', failureReason: null, totalCostUsd: 0.1 },
      };

      const result = await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:30Z'),
        readMetadata: async (p) => metadataMap[p] ?? null,
        processAlive: (pid) => pid !== 1001,
      });

      expect(result.repaired).toEqual([
        {
          runId: 'r-repair',
          issueNumber: 2,
          status: 'success',
          failureReason: null,
          totalCostUsd: 0.1,
        },
      ]);
      expect(result.markers).toHaveLength(1);
      expect(result.markers[0]?.runId).toBe('r-orphan');
      // r-healthy は marker / repair どちらにも残らない
      expect(
        tracker
          .listRunning()
          .map((r) => r.runId)
          .sort(),
      ).toEqual(['r-healthy', 'r-orphan'].sort());
    });
  });

  describe('warn ログのスロットリング', () => {
    it('reasons が変化しない再評価では warn を再送しない', async () => {
      const tracker = startTracker({
        runId: 'r-1',
        issueNumber: 42,
        startedAt: new Date('2026-05-09T00:00:00Z'),
        workspacePath: '/tmp/ws/issue-42',
        runLogPath: '/tmp/runs/r-1',
      });
      tracker.recordRunnerProcess('r-1', 999);

      const logger = {
        level: 'info' as const,
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      };
      logger.child = vi.fn(() => logger);

      await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:00:30Z'),
        logger,
        readMetadata: async () => null,
        processAlive: () => false,
      });
      expect(logger.warn).toHaveBeenCalledWith('watchdog marker', expect.any(Object));
      const firstWarnCount = logger.warn.mock.calls.length;

      await runWatchdog({
        tracker,
        stallTimeoutMs: 60_000,
        now: new Date('2026-05-09T00:01:00Z'),
        logger,
        readMetadata: async () => null,
        processAlive: () => false,
      });
      expect(logger.warn.mock.calls.length).toBe(firstWarnCount);
    });
  });
});
