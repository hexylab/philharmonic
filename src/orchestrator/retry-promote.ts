import type { Config } from '../config/index.js';
import type { GitHubClient } from '../github/index.js';
import type { Logger } from '../logger/index.js';
import type { Candidate, ProjectsClient } from '../projects/index.js';
import type { RetryScheduler } from '../serve/index.js';

const RETRY_PROMOTE_TARGET_STATUS = 'Todo';
const FAILED_STATUS = 'Failed';

export type PromoteRetryReadyDeps = {
  config: Config;
  scheduler: RetryScheduler;
  projectsClient: ProjectsClient;
  githubClient: GitHubClient;
  logger: Logger;
  clock?: () => Date;
};

export type PromoteRetryReadySummary = {
  ready: number;
  promoted: number;
  skipped: number;
  failed: number;
};

/**
 * `pickReady` で取得した issue を `Failed` → `Todo` に戻して再 dispatch を促す。
 *
 * - state が空 (= `pickReady` が空) のときは Project metadata fetch を行わず early return する
 * - state にあるが現状 Status が `Failed` でないものは skip する (人手で戻された / 別状態に遷移した等)
 * - `Todo` option が project に存在しないときは warn を出して全件 skip する
 *   (`dispatch_statuses` カスタマイズ時のフォールバックは別 Issue。spec の Open Question 参照)
 *
 * spec: docs/specs/serve-daemon.md#自動-retry-22
 */
export async function promoteRetryReady(
  deps: PromoteRetryReadyDeps,
): Promise<PromoteRetryReadySummary> {
  const clock = deps.clock ?? (() => new Date());
  const ready = await deps.scheduler.pickReady(clock());
  const summary: PromoteRetryReadySummary = {
    ready: ready.length,
    promoted: 0,
    skipped: 0,
    failed: 0,
  };
  if (ready.length === 0) return summary;

  const metadata = await deps.projectsClient.fetchProjectMetadata({
    owner: deps.config.owner,
    projectNumber: deps.config.projectNumber,
    statusFieldName: deps.config.statusField,
  });
  const todoOption = metadata.statusOptions.find((o) => o.name === RETRY_PROMOTE_TARGET_STATUS);
  if (todoOption === undefined) {
    deps.logger.warn(
      `retry promote 対象の Status option '${RETRY_PROMOTE_TARGET_STATUS}' が見つかりません — 全件 skip します`,
      {
        availableStatuses: metadata.statusOptions.map((o) => o.name),
      },
    );
    summary.skipped = ready.length;
    return summary;
  }

  const candidates = await deps.projectsClient.fetchProjectCandidates({
    owner: deps.config.owner,
    projectNumber: deps.config.projectNumber,
    statusFieldName: deps.config.statusField,
  });
  const candidateByIssue = new Map<number, Candidate>();
  for (const c of candidates) candidateByIssue.set(c.issueNumber, c);

  for (const entry of ready) {
    const candidate = candidateByIssue.get(entry.issueNumber);
    if (candidate === undefined) {
      deps.logger.info('retry promote skipped (candidate not found)', {
        issueNumber: entry.issueNumber,
      });
      summary.skipped += 1;
      continue;
    }
    if (candidate.status !== FAILED_STATUS) {
      deps.logger.info('retry promote skipped (status no longer Failed)', {
        issueNumber: entry.issueNumber,
        currentStatus: candidate.status,
      });
      summary.skipped += 1;
      continue;
    }
    try {
      await deps.githubClient.updateProjectV2ItemStatus({
        projectId: metadata.projectId,
        itemId: candidate.itemId,
        fieldId: metadata.statusFieldId,
        optionId: todoOption.id,
      });
      deps.logger.info('retry promoted to Todo', {
        issueNumber: entry.issueNumber,
        attempts: entry.attempts,
      });
      summary.promoted += 1;
    } catch (error) {
      deps.logger.warn('retry promote failed', {
        issueNumber: entry.issueNumber,
        error: describeError(error),
      });
      summary.failed += 1;
    }
  }

  return summary;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
