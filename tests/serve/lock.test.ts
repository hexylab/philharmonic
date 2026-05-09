import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireServeLock,
  DEFAULT_LOCK_FILE_RELATIVE,
  ServeLockHeldError,
  ServeLockHeldOnDifferentHostError,
} from '../../src/serve/index.js';

describe('acquireServeLock', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'philharmonic-lock-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('lock を取得すると .philharmonic/serve.lock が作成される', async () => {
    const handle = await acquireServeLock({
      repoRoot,
      pid: 1234,
      hostname: 'host-a',
      now: () => '2026-05-09T00:00:00.000Z',
    });

    expect(handle.lockPath).toBe(path.resolve(repoRoot, DEFAULT_LOCK_FILE_RELATIVE));
    const raw = await readFile(handle.lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toEqual({
      pid: 1234,
      hostname: 'host-a',
      startedAt: '2026-05-09T00:00:00.000Z',
    });
    expect(handle.contents.pid).toBe(1234);

    await handle.release();
    await expect(readFile(handle.lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('release を 2 回呼んでも安全', async () => {
    const handle = await acquireServeLock({
      repoRoot,
      pid: 1234,
      hostname: 'host-a',
    });
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('release は他 pid の lock を消さない (race 安全)', async () => {
    const handle = await acquireServeLock({
      repoRoot,
      pid: 1234,
      hostname: 'host-a',
    });

    // 他プロセスが奪取したシナリオを模擬
    await writeFile(
      handle.lockPath,
      JSON.stringify({ pid: 9999, hostname: 'host-a', startedAt: '2026-05-09T00:01:00.000Z' }),
      'utf8',
    );
    await handle.release();
    const raw = await readFile(handle.lockPath, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ pid: 9999 });
  });

  it('既に同 host + 生存 pid の lock があれば ServeLockHeldError', async () => {
    const lockPath = path.resolve(repoRoot, DEFAULT_LOCK_FILE_RELATIVE);
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 1111, hostname: 'host-a', startedAt: '2026-05-09T00:00:00.000Z' }),
      'utf8',
    ).catch(async () => {
      // .philharmonic ディレクトリが無いので作る
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({ pid: 1111, hostname: 'host-a', startedAt: '2026-05-09T00:00:00.000Z' }),
        'utf8',
      );
    });

    await expect(
      acquireServeLock({
        repoRoot,
        pid: 2222,
        hostname: 'host-a',
        isProcessAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(ServeLockHeldError);
  });

  it('同 host + pid 死亡なら stale 扱いで奪取できる', async () => {
    const { mkdir } = await import('node:fs/promises');
    const lockPath = path.resolve(repoRoot, DEFAULT_LOCK_FILE_RELATIVE);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 1111, hostname: 'host-a', startedAt: '2026-05-09T00:00:00.000Z' }),
      'utf8',
    );

    const handle = await acquireServeLock({
      repoRoot,
      pid: 2222,
      hostname: 'host-a',
      isProcessAlive: () => false,
    });
    expect(handle.contents.pid).toBe(2222);
    await handle.release();
  });

  it('hostname が異なれば ServeLockHeldOnDifferentHostError (自動奪取しない)', async () => {
    const { mkdir } = await import('node:fs/promises');
    const lockPath = path.resolve(repoRoot, DEFAULT_LOCK_FILE_RELATIVE);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 1111, hostname: 'other-host', startedAt: '2026-05-09T00:00:00.000Z' }),
      'utf8',
    );

    await expect(
      acquireServeLock({
        repoRoot,
        pid: 2222,
        hostname: 'host-a',
        isProcessAlive: () => false,
      }),
    ).rejects.toBeInstanceOf(ServeLockHeldOnDifferentHostError);
  });

  it('JSON parse 不能な lock は stale 扱い (前回 crash で半端書き)', async () => {
    const { mkdir } = await import('node:fs/promises');
    const lockPath = path.resolve(repoRoot, DEFAULT_LOCK_FILE_RELATIVE);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, '{ this is not valid json', 'utf8');

    const handle = await acquireServeLock({
      repoRoot,
      pid: 2222,
      hostname: 'host-a',
      isProcessAlive: () => true,
    });
    expect(handle.contents.pid).toBe(2222);
    await handle.release();
  });

  it('.philharmonic/ ディレクトリが無くても作成して lock を取れる', async () => {
    const handle = await acquireServeLock({
      repoRoot,
      pid: 1234,
      hostname: 'host-a',
    });
    const raw = await readFile(handle.lockPath, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ pid: 1234 });
    await handle.release();
  });
});
