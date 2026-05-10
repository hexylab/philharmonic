/**
 * Candidate selection の終端 filter として `evaluateDependencyDag` を呼び、
 * `ready` の candidate のみを残すための glue コード (ADR-0007 §5 split 3)。
 *
 * - `createDependencyIssueFetcher`: GitHub REST `getIssue` を `FetchDependencyIssue` 契約に合わせる
 * - `logDependencyEvaluation`: `dependency blocked` / `dependency invalid` / `dependency cycle` を
 *   構造化ログに 1 行ずつ出す (ADR-0007 §3 / docs/specs/observability.md)
 *
 * 入力 candidate の repository は、ADR-0007 が cross-repository 依存を parser invalid として
 * 弾く前提のため、candidate が属する project の単一 repository を caller が決めた前提で渡す。
 */

import type {
  DependencyIssueLookupResult,
  EvaluatedCandidate,
  FetchDependencyIssue,
} from '../dependency/index.js';
import { GitHubApiError, type GitHubClient } from '../github/index.js';
import type { Logger } from '../logger/index.js';

export type DependencyIssueFetcherDeps = {
  githubClient: GitHubClient;
  /** dependency 解決時に lookup する repository (single-repo project 前提)。 */
  defaultRepository: { owner: string; name: string };
};

/**
 * GitHub REST `getIssue` を `FetchDependencyIssue` 契約に合わせる factory。
 *
 * - `state` と `body` を返す `found`
 * - 404 → `not_found`
 * - 403 → `forbidden`
 * - それ以外の例外 → `error` (`message` に元の例外文言)
 */
export function createDependencyIssueFetcher(
  deps: DependencyIssueFetcherDeps,
): FetchDependencyIssue {
  return async (issueNumber): Promise<DependencyIssueLookupResult> => {
    try {
      const issue = await deps.githubClient.getIssue({
        owner: deps.defaultRepository.owner,
        repo: deps.defaultRepository.name,
        issueNumber,
      });
      return {
        kind: 'found',
        state: issue.state,
        body: issue.body,
      };
    } catch (error) {
      if (error instanceof GitHubApiError) {
        if (error.status === 404) return { kind: 'not_found' };
        if (error.status === 403) return { kind: 'forbidden' };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'error', message };
    }
  };
}

/**
 * candidate の dependency state を 1 行ずつ log に出す。`ready` は出力しない。
 *
 * msg / level / fields は ADR-0007 §3 に従う:
 * - blocked: info `dependency blocked` (`blockingIssueNumbers`)
 * - invalid_dependency: warn `dependency invalid` (`invalidEntries`)
 * - cycle: warn `dependency cycle` (`cycleIssueNumbers`)
 */
export function logDependencyEvaluation(logger: Logger, evaluation: EvaluatedCandidate): void {
  switch (evaluation.state) {
    case 'ready':
      return;
    case 'blocked':
      logger.info('dependency blocked', {
        issueNumber: evaluation.candidate.issueNumber,
        blockingIssueNumbers: [...evaluation.blockingIssueNumbers],
      });
      return;
    case 'invalid_dependency':
      logger.warn('dependency invalid', {
        issueNumber: evaluation.candidate.issueNumber,
        invalidEntries: evaluation.invalidEntries.map((d) => ({
          raw: d.raw,
          issueNumber: d.issueNumber,
          reason: d.reason,
          ...(d.message !== undefined ? { message: d.message } : {}),
        })),
      });
      return;
    case 'cycle':
      logger.warn('dependency cycle', {
        issueNumber: evaluation.candidate.issueNumber,
        cycleIssueNumbers: [...evaluation.cycleIssueNumbers],
      });
      return;
  }
}
