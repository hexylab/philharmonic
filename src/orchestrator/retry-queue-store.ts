import { mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger/index.js';

import type { FailureReason } from './errors.js';
import type { RetryEntry, RetryKind } from './retry-queue.js';

/**
 * `philharmonic serve` の retry queue を local state file に永続化する store。
 *
 * spec: docs/specs/retry-queue.md §永続化
 * adr: docs/adr/0011-persist-retry-queue-across-restart.md
 */

/** 現行の state file schema version。破壊的変更時に bump する。 */
export const RETRY_QUEUE_STATE_VERSION = 1;

/** `<repoRoot>` からの相対 path。固定で `mkdir -p` 込みで上書きする */
export const RETRY_QUEUE_STATE_FILE_RELATIVE = '.philharmonic/state/retry-queue.json';

const RETRY_KINDS: readonly RetryKind[] = ['failure', 'continuation'];
const FAILURE_REASONS: readonly FailureReason[] = [
  'workspace_provisioning',
  'runner_error',
  'timeout',
  'stalled',
  'hook_failed',
];

export type RetryQueueStateJson = {
  version: number;
  entries: readonly RetryEntryJson[];
};

export type RetryEntryJson = {
  kind: RetryKind;
  issueNumber: number;
  repository: { owner: string; name: string };
  branch: string;
  workspacePath: string;
  attempt: number;
  dueAt: string;
  scheduledAt: string;
  failureReason: FailureReason | null;
  lastRunId: string;
  lastErrorSummary: string | null;
};

export type RetryQueueStore = {
  /**
   * mutation 後に呼ばれる永続化操作。複数回呼ばれても直列に実行し、後勝ち書き込みで snapshot を更新する。
   *
   * 失敗時 (disk full / 権限不足) は **throw せず** warn ログを 1 行出して return する
   * (orchestrator 本体は in-memory state を保持して動作継続する)。
   */
  save(entries: readonly RetryEntry[]): Promise<void>;
  /**
   * 起動時の load。pending な save がある場合はそれを待ってから読む (テスト用 / restore シナリオ)。
   * 通常は `loadRetryQueueEntries` を直接呼び出す経路を使う。
   */
  flush(): Promise<void>;
};

export type LoadResult = {
  entries: readonly RetryEntry[];
  /** load 時の version mismatch / parse failure 等を info/warn ログ用に伝える */
  outcome:
    | { kind: 'empty' }
    | { kind: 'restored'; count: number }
    | { kind: 'parse_failed'; backupPath: string | null; error: unknown }
    | { kind: 'version_mismatch'; version: unknown };
  /** skip された entry の詳細 (warn ログ用) */
  invalidEntries: readonly InvalidEntryReport[];
};

export type InvalidEntryReport = {
  index: number;
  issueNumber: number | null;
  reason: 'missing_field' | 'invalid_type' | 'invalid_kind' | 'invalid_failure_reason';
  field?: string;
};

/**
 * state file を 1 回だけ読み取り、復元可能な entry を返す。
 *
 * - file 不在: `entries: []`, `outcome: 'empty'`
 * - JSON parse 失敗: file を `<state.json>.bak` に rename し empty を返す (運用者の事後解析用)
 * - version mismatch: 既知の非互換として empty を返す (rename しない)
 * - entry 単位の schema 違反: その entry のみ drop し他は採用する
 *
 * **本関数は throw しない**。disk 操作の失敗 (rename 不可 等) は outcome に詰めて返す。
 */
export async function loadRetryQueueEntries(filePath: string): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return { entries: [], outcome: { kind: 'empty' }, invalidEntries: [] };
    }
    // 読めない (権限 / I/O) は parse_failed と同等に warn 扱い (backup は試みない)
    return {
      entries: [],
      outcome: { kind: 'parse_failed', backupPath: null, error },
      invalidEntries: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const backupPath = await renameToBackup(filePath);
    return {
      entries: [],
      outcome: { kind: 'parse_failed', backupPath, error },
      invalidEntries: [],
    };
  }

  if (!isPlainObject(parsed) || !('version' in parsed) || !('entries' in parsed)) {
    const backupPath = await renameToBackup(filePath);
    return {
      entries: [],
      outcome: {
        kind: 'parse_failed',
        backupPath,
        error: new Error('retry queue state file has no version/entries field'),
      },
      invalidEntries: [],
    };
  }

  const version = (parsed as { version: unknown }).version;
  if (version !== RETRY_QUEUE_STATE_VERSION) {
    return {
      entries: [],
      outcome: { kind: 'version_mismatch', version },
      invalidEntries: [],
    };
  }

  const entriesField = (parsed as { entries: unknown }).entries;
  if (!Array.isArray(entriesField)) {
    const backupPath = await renameToBackup(filePath);
    return {
      entries: [],
      outcome: {
        kind: 'parse_failed',
        backupPath,
        error: new Error('retry queue state file `entries` is not an array'),
      },
      invalidEntries: [],
    };
  }

  const restored: RetryEntry[] = [];
  const seen = new Map<number, number>();
  const invalid: InvalidEntryReport[] = [];
  for (let i = 0; i < entriesField.length; i += 1) {
    const validation = validateEntry(entriesField[i], i);
    if (validation.ok) {
      const existing = seen.get(validation.entry.issueNumber);
      if (existing !== undefined) {
        restored[existing] = validation.entry;
      } else {
        seen.set(validation.entry.issueNumber, restored.length);
        restored.push(validation.entry);
      }
    } else {
      invalid.push(validation.report);
    }
  }

  return {
    entries: restored,
    outcome: { kind: 'restored', count: restored.length },
    invalidEntries: invalid,
  };
}

/**
 * file system に retry queue snapshot を書き出す atomic store。
 *
 * `save()` の同時呼び出しは内部 chain で直列化する (後勝ち)。tmp → rename の 2 段書きで
 * crash safety を確保する。
 */
export function createRetryQueueFileStore(input: {
  filePath: string;
  logger?: Logger;
}): RetryQueueStore {
  let chain: Promise<void> = Promise.resolve();
  const { filePath, logger } = input;

  const doSave = async (entries: readonly RetryEntry[]): Promise<void> => {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    const payload: RetryQueueStateJson = {
      version: RETRY_QUEUE_STATE_VERSION,
      entries: entries.map(toJson),
    };
    // pretty print: 件数は少ないため可読性を優先
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    try {
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, filePath);
    } catch (error) {
      logger?.warn('retry queue persist failed', {
        path: filePath,
        error: describeError(error),
      });
      // tmp が残った可能性を best-effort で掃除する
      await rm(tmp, { force: true }).catch(() => {});
    }
  };

  return {
    save(entries) {
      // snapshot を関数内で確定 (呼び出し側の Array 変更から isolate)
      const frozen = [...entries];
      const next = chain.then(() => doSave(frozen));
      // 失敗時に chain 自体は再開可能であることを保証 (doSave 内で catch 済み)
      chain = next.catch(() => {});
      return next;
    },
    flush() {
      return chain;
    },
  };
}

function toJson(entry: RetryEntry): RetryEntryJson {
  return {
    kind: entry.kind,
    issueNumber: entry.issueNumber,
    repository: { owner: entry.repository.owner, name: entry.repository.name },
    branch: entry.branch,
    workspacePath: entry.workspacePath,
    attempt: entry.attempt,
    dueAt: entry.dueAt.toISOString(),
    scheduledAt: entry.scheduledAt.toISOString(),
    failureReason: entry.failureReason,
    lastRunId: entry.lastRunId,
    lastErrorSummary: entry.lastErrorSummary,
  };
}

type ValidationResult = { ok: true; entry: RetryEntry } | { ok: false; report: InvalidEntryReport };

function validateEntry(raw: unknown, index: number): ValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, report: { index, issueNumber: null, reason: 'invalid_type' } };
  }
  const issueNumberRaw = (raw as { issueNumber?: unknown }).issueNumber;
  const issueNumber =
    typeof issueNumberRaw === 'number' && Number.isInteger(issueNumberRaw) && issueNumberRaw > 0
      ? issueNumberRaw
      : null;

  const kindRaw = (raw as { kind?: unknown }).kind;
  if (typeof kindRaw !== 'string' || !RETRY_KINDS.includes(kindRaw as RetryKind)) {
    return { ok: false, report: { index, issueNumber, reason: 'invalid_kind', field: 'kind' } };
  }
  const kind = kindRaw as RetryKind;

  if (issueNumber === null) {
    return {
      ok: false,
      report: { index, issueNumber: null, reason: 'invalid_type', field: 'issueNumber' },
    };
  }

  const repository = (raw as { repository?: unknown }).repository;
  if (
    !isPlainObject(repository) ||
    typeof (repository as { owner?: unknown }).owner !== 'string' ||
    typeof (repository as { name?: unknown }).name !== 'string' ||
    (repository as { owner: string }).owner === '' ||
    (repository as { name: string }).name === ''
  ) {
    return {
      ok: false,
      report: { index, issueNumber, reason: 'missing_field', field: 'repository' },
    };
  }
  const branch = (raw as { branch?: unknown }).branch;
  if (typeof branch !== 'string' || branch === '') {
    return { ok: false, report: { index, issueNumber, reason: 'missing_field', field: 'branch' } };
  }
  const workspacePath = (raw as { workspacePath?: unknown }).workspacePath;
  if (typeof workspacePath !== 'string' || workspacePath === '') {
    return {
      ok: false,
      report: { index, issueNumber, reason: 'missing_field', field: 'workspacePath' },
    };
  }
  const attempt = (raw as { attempt?: unknown }).attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    return { ok: false, report: { index, issueNumber, reason: 'invalid_type', field: 'attempt' } };
  }
  const dueAtRaw = (raw as { dueAt?: unknown }).dueAt;
  const dueAt = typeof dueAtRaw === 'string' ? new Date(dueAtRaw) : null;
  if (dueAt === null || Number.isNaN(dueAt.getTime())) {
    return { ok: false, report: { index, issueNumber, reason: 'invalid_type', field: 'dueAt' } };
  }
  const scheduledAtRaw = (raw as { scheduledAt?: unknown }).scheduledAt;
  const scheduledAt = typeof scheduledAtRaw === 'string' ? new Date(scheduledAtRaw) : null;
  if (scheduledAt === null || Number.isNaN(scheduledAt.getTime())) {
    return {
      ok: false,
      report: { index, issueNumber, reason: 'invalid_type', field: 'scheduledAt' },
    };
  }
  const lastRunId = (raw as { lastRunId?: unknown }).lastRunId;
  if (typeof lastRunId !== 'string' || lastRunId === '') {
    return {
      ok: false,
      report: { index, issueNumber, reason: 'missing_field', field: 'lastRunId' },
    };
  }
  const failureReasonRaw = (raw as { failureReason?: unknown }).failureReason ?? null;
  let failureReason: FailureReason | null;
  if (failureReasonRaw === null) {
    failureReason = null;
  } else if (
    typeof failureReasonRaw === 'string' &&
    FAILURE_REASONS.includes(failureReasonRaw as FailureReason)
  ) {
    failureReason = failureReasonRaw as FailureReason;
  } else {
    return {
      ok: false,
      report: { index, issueNumber, reason: 'invalid_failure_reason', field: 'failureReason' },
    };
  }
  const lastErrorSummaryRaw = (raw as { lastErrorSummary?: unknown }).lastErrorSummary ?? null;
  const lastErrorSummary =
    lastErrorSummaryRaw === null || typeof lastErrorSummaryRaw === 'string'
      ? lastErrorSummaryRaw
      : null;

  // continuation kind は失敗情報を持たない。誤って persist された値は null に正規化する。
  const normalizedFailureReason = kind === 'continuation' ? null : failureReason;
  const normalizedLastErrorSummary = kind === 'continuation' ? null : lastErrorSummary;

  return {
    ok: true,
    entry: {
      kind,
      issueNumber,
      repository: {
        owner: (repository as { owner: string }).owner,
        name: (repository as { name: string }).name,
      },
      branch,
      workspacePath,
      attempt,
      dueAt,
      scheduledAt,
      failureReason: normalizedFailureReason,
      lastRunId,
      lastErrorSummary: normalizedLastErrorSummary,
    },
  };
}

async function renameToBackup(filePath: string): Promise<string | null> {
  const backupPath = `${filePath}.bak`;
  try {
    await rename(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
