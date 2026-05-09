import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname as defaultHostname } from 'node:os';
import path from 'node:path';

import { ServeLockHeldError, ServeLockHeldOnDifferentHostError } from './errors.js';

export const DEFAULT_LOCK_FILE_RELATIVE = '.philharmonic/serve.lock';

export type ServeLockContents = {
  pid: number;
  hostname: string;
  startedAt: string;
};

export type ServeLockHandle = {
  readonly lockPath: string;
  readonly contents: ServeLockContents;
  /**
   * lock を解放する。lock の中身が自分のものと一致しているときのみ unlink する。
   * 既に他プロセスが奪取済みのときは silently no-op (race 安全)。
   * 複数回呼んでも安全。
   */
  release: () => Promise<void>;
};

export type AcquireServeLockOptions = {
  repoRoot: string;
  /** テスト用 DI: 既定は process.pid */
  pid?: number;
  /** テスト用 DI: 既定は os.hostname() */
  hostname?: string;
  /** テスト用 DI: 既定は new Date().toISOString() */
  now?: () => string;
  /** テスト用 DI: pid 生存判定。既定は `process.kill(pid, 0)` を投げない=生存 */
  isProcessAlive?: (pid: number) => boolean;
};

/**
 * `philharmonic serve` の二重起動を防ぐ local lock を取得する。
 *
 * - lock file は `<repoRoot>/.philharmonic/serve.lock` (相対固定)
 * - `open(path, 'wx')` で atomic 作成 (既存ファイルがあると EEXIST を投げる)
 * - 既存 lock を見つけたら次の階層で扱う:
 *   1. JSON parse 失敗 → stale 扱い (前回 crash で半端書き) → 削除して再試行
 *   2. hostname が異なる → ServeLockHeldOnDifferentHostError (自動奪取しない)
 *   3. 同 host + pid 生存 → ServeLockHeldError
 *   4. 同 host + pid 死亡 → stale 扱い → 削除して再試行
 * - `release()` は lock の中身が自分の pid と一致しているときだけ unlink する
 */
export async function acquireServeLock(options: AcquireServeLockOptions): Promise<ServeLockHandle> {
  const pid = options.pid ?? process.pid;
  const host = options.hostname ?? defaultHostname();
  const now = options.now ?? (() => new Date().toISOString());
  const aliveCheck = options.isProcessAlive ?? defaultIsProcessAlive;

  const lockPath = path.resolve(options.repoRoot, DEFAULT_LOCK_FILE_RELATIVE);
  await mkdir(path.dirname(lockPath), { recursive: true });

  const contents: ServeLockContents = {
    pid,
    hostname: host,
    startedAt: now(),
  };
  const payload = `${JSON.stringify(contents, null, 2)}\n`;

  // 最大 2 回試行: 1 回目は素直に作る、衝突時は stale 判定で奪取して再試行する。
  // 奪取後の 2 回目で再衝突したら ServeLockHeldError として返す (別プロセスが先に取った)。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(payload, 'utf8');
      } finally {
        await handle.close();
      }
      return {
        lockPath,
        contents,
        release: () => releaseLock(lockPath, pid),
      };
    } catch (error) {
      if (!isEexist(error)) throw error;
    }

    // EEXIST. 既存 lock を読み取り、奪取可能か判定する。
    const existing = await readExistingLock(lockPath);
    if (existing === null) {
      // parse 不能 → stale
      await unlinkSafe(lockPath);
      continue;
    }
    if (existing.hostname !== host) {
      throw new ServeLockHeldOnDifferentHostError(lockPath, existing.pid, existing.hostname);
    }
    if (aliveCheck(existing.pid)) {
      throw new ServeLockHeldError(lockPath, existing.pid, existing.hostname, existing.startedAt);
    }
    // 同 host + pid 死亡 → stale
    await unlinkSafe(lockPath);
  }

  // 2 回試行しても取れなければ、誰かが奪い合っている。
  const last = await readExistingLock(lockPath);
  throw new ServeLockHeldError(
    lockPath,
    last?.pid ?? 0,
    last?.hostname ?? host,
    last?.startedAt ?? null,
  );
}

async function readExistingLock(lockPath: string): Promise<ServeLockContents | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'pid' in parsed && 'hostname' in parsed) {
      const obj = parsed as { pid: unknown; hostname: unknown; startedAt?: unknown };
      if (typeof obj.pid === 'number' && typeof obj.hostname === 'string') {
        return {
          pid: obj.pid,
          hostname: obj.hostname,
          startedAt: typeof obj.startedAt === 'string' ? obj.startedAt : '',
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function releaseLock(lockPath: string, ownPid: number): Promise<void> {
  const existing = await readExistingLock(lockPath);
  if (existing === null) return;
  if (existing.pid !== ownPid) return;
  await unlinkSafe(lockPath);
}

async function unlinkSafe(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error) && error.code === 'EPERM') {
      // 権限がなくてもプロセスは存在している
      return true;
    }
    return false;
  }
}

function isEexist(error: unknown): boolean {
  return isErrno(error) && error.code === 'EEXIST';
}

function isEnoent(error: unknown): boolean {
  return isErrno(error) && error.code === 'ENOENT';
}

function isErrno(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
