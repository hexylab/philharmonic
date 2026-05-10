import type { GitHubClient } from '../github/index.js';
import type { Logger } from '../logger/index.js';

import type { RetryEntry, RetryQueue } from './retry-queue.js';

/**
 * `philharmonic serve` 起動時、`loadRetryQueueEntries` で読み込んだ entry を queue に積み戻したあと
 * 「もう retry してはいけない」ものを release するための一回限りの startup pass。
 *
 * - Issue `state === 'closed'` → drop
 * - open PR (head branch prefix `feature/<issueNumber>-`) が 1 件以上 → drop
 *
 * **terminal status (`In Review` / `Failed`) と inactive status は本関数では扱わない**。
 * 既存の `drainRetryQueue` (`src/orchestrator/run.ts`) が drain phase で再確認するため、
 * ここで重複させると startup の GitHub API call が膨らむため。
 *
 * 個別 entry 検証で fetch error が出た場合は entry を queue に残置する (= 次の drain tick が拾う
 * degraded fall-back)。本関数は throw しない。
 *
 * adr: docs/adr/0011-persist-retry-queue-across-restart.md §復元後の release 条件
 */
export type ReleaseRestoredRetriesDeps = {
  queue: RetryQueue;
  githubClient: GitHubClient;
  logger: Logger;
  /** AbortSignal を受け取れば中断可。recovery と同様に startup 中の SIGTERM で抜ける */
  signal?: AbortSignal;
};

export type ReleaseRestoredRetriesSummary = {
  inspected: number;
  released: number;
  retained: number;
  skipped: number;
};

export async function releaseRestoredRetries(
  deps: ReleaseRestoredRetriesDeps,
): Promise<ReleaseRestoredRetriesSummary> {
  const restored = deps.queue.list();
  const summary: ReleaseRestoredRetriesSummary = {
    inspected: restored.length,
    released: 0,
    retained: 0,
    skipped: 0,
  };

  for (const entry of restored) {
    if (deps.signal?.aborted === true) break;
    const result = await classifyRestoredEntry(entry, deps);
    if (result.kind === 'release') {
      deps.queue.remove(entry.issueNumber);
      summary.released += 1;
      deps.logger.info('retry skipped', {
        kind: entry.kind,
        issueNumber: entry.issueNumber,
        attempt: entry.attempt,
        reason: result.reason,
        via: 'restore',
      });
      continue;
    }
    if (result.kind === 'skip') {
      summary.skipped += 1;
      // fetch エラー時は queue に残す。drain tick で再判定される
      continue;
    }
    summary.retained += 1;
  }

  return summary;
}

type Classification =
  | { kind: 'retain' }
  | { kind: 'release'; reason: 'closed' | 'open_pr' }
  | { kind: 'skip' };

async function classifyRestoredEntry(
  entry: RetryEntry,
  deps: ReleaseRestoredRetriesDeps,
): Promise<Classification> {
  try {
    const issue = await deps.githubClient.getIssue({
      owner: entry.repository.owner,
      repo: entry.repository.name,
      issueNumber: entry.issueNumber,
    });
    if (issue.state !== 'open') {
      return { kind: 'release', reason: 'closed' };
    }
  } catch (error) {
    deps.logger.warn('retry queue restore fetch error', {
      issueNumber: entry.issueNumber,
      stage: 'getIssue',
      error: describeError(error),
    });
    return { kind: 'skip' };
  }

  try {
    const openPrs = await deps.githubClient.listOpenPullRequests({
      owner: entry.repository.owner,
      repo: entry.repository.name,
      headBranchPrefix: `feature/${entry.issueNumber}-`,
    });
    if (openPrs.length > 0) {
      return { kind: 'release', reason: 'open_pr' };
    }
  } catch (error) {
    deps.logger.warn('retry queue restore fetch error', {
      issueNumber: entry.issueNumber,
      stage: 'listOpenPullRequests',
      error: describeError(error),
    });
    return { kind: 'skip' };
  }

  return { kind: 'retain' };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
