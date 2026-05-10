import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger/index.js';
import type { ProjectsClient } from '../projects/index.js';
import { updateProjectItemStatus, type GhRunner } from '../projects/status-update.js';

import type { FailureReason } from './errors.js';

/**
 * retry queue が `kind=failure` の exhaustion を検知した瞬間に呼ばれる safety-net。
 *
 * ADR-0010 で「ADR-0005 の例外として、orchestrator が GitHub に最小限の書き込みを行う」と
 * 確定した。具体的には以下 2 件のみ。
 *
 *  1. Project Item の Status を `status_transitions.failed` に書き換える
 *  2. Issue にコメントを 1 件投稿する (HTML コメントマーカで run id ベース dedup)
 *
 * 3 つの GitHub 操作 (既存コメント取得 / Status 更新 / コメント投稿) はそれぞれ独立に
 * try/catch し、いずれが失敗しても orchestrator は throw しない。warn ログを 1 行残して
 * 続行する。dedup チェックそのものが失敗した場合は「skip + warn」で安全側に倒す
 * (Issue #103 完了条件「重複コメントしない」を最優先する)。
 *
 * spec: docs/specs/retry-queue.md
 * adr: docs/adr/0010-retry-exhaustion-github-safety-net.md
 */

const COMMENT_FILE_NAME = 'issue-comment.md';

export type ExhaustionNotifyInput = {
  /** Project owner (login) */
  owner: string;
  /** Project number (= `philharmonic.yaml` の `project_number`) */
  projectNumber: number;
  /** Project の Status field 名 (default `Status`) */
  statusFieldName: string;
  /** 書き戻し先の status option 名 (= `status_transitions.failed`) */
  failedStatus: string;
  /** retry exhausted した Issue */
  issueNumber: number;
  /** Issue が紐づく repository (owner / name) */
  repository: { owner: string; name: string };
  /** Project Item の node id (= candidate.itemId) */
  itemId: string;
  /** 直前 retry の attempt 番号 (= 上限) */
  attempt: number;
  /** `agent.max_retry_attempts` の現値 */
  maxAttempts: number;
  /** 上限到達時の failure reason */
  failureReason: FailureReason;
  /** retry exhausted した run id (dedup marker / log path 解決に使う) */
  runId: string;
  /** feature branch */
  branch: string;
  /** retry 対象 Issue の worktree path */
  workspacePath: string;
  /** `RunOnceResult.failed.errorSummary` (先頭 500 文字)。null / 空文字なら "(empty)" 表記 */
  errorSummary: string | null;
  /** retry queue が emit した failure-summary.md の absolute path。書けなかった場合は null */
  failureSummaryPath: string | null;
  /** `<repoRoot>/.philharmonic/runs` の絶対パス (issue-comment.md の出力先解決に使う) */
  runnerLogsRoot: string;
  exhaustedAt: Date;
};

export type ExhaustionNotifyDeps = {
  runGh: GhRunner;
  projectsClient: ProjectsClient;
  logger: Logger;
};

export type ExhaustionNotifyResult = {
  /** Status update を試みて成功したかどうか。dedup でも skip でも false */
  statusUpdated: boolean;
  /** Issue comment を実際に投稿したかどうか (dedup で skip した場合 false) */
  commentPosted: boolean;
  /** 既存コメントに同じ run_id の marker が存在し、投稿を skip したかどうか */
  duplicateSkipped: boolean;
};

/**
 * marker 付き Issue comment を投稿し、Project Status を `failed` に倒す。
 *
 * 失敗系の挙動:
 * - 既存コメント取得 (dedup チェック) 失敗時: comment 投稿を **skip**。Status 更新は試みる
 * - Status 更新失敗: warn ログを残して comment 投稿に進む
 * - Comment 投稿失敗: warn ログを残して return
 */
export async function notifyFailureExhausted(
  input: ExhaustionNotifyInput,
  deps: ExhaustionNotifyDeps,
): Promise<ExhaustionNotifyResult> {
  const marker = buildMarker(input.runId);
  const logFields = {
    issueNumber: input.issueNumber,
    runId: input.runId,
    attempt: input.attempt,
  };

  let duplicateSkipped = false;
  let canPostComment = true;
  try {
    const existingBodies = await listIssueCommentBodies(
      deps.runGh,
      input.repository,
      input.issueNumber,
    );
    if (existingBodies.some((body) => body.includes(marker))) {
      duplicateSkipped = true;
      canPostComment = false;
      deps.logger.info('exhaustion notify skipped (already commented)', logFields);
    }
  } catch (error) {
    canPostComment = false;
    deps.logger.warn('exhaustion comment dedup check failed', {
      ...logFields,
      error: describeError(error),
    });
  }

  let statusUpdated = false;
  try {
    const context = await deps.projectsClient.fetchProjectContext({
      owner: input.owner,
      projectNumber: input.projectNumber,
      statusFieldName: input.statusFieldName,
    });
    await updateProjectItemStatus(deps.runGh, {
      owner: input.owner,
      projectNumber: input.projectNumber,
      projectId: context.projectId,
      itemId: input.itemId,
      statusFieldName: input.statusFieldName,
      targetStatus: input.failedStatus,
    });
    statusUpdated = true;
    deps.logger.info('exhaustion status updated', {
      ...logFields,
      targetStatus: input.failedStatus,
    });
  } catch (error) {
    deps.logger.warn('exhaustion status update failed', {
      ...logFields,
      error: describeError(error),
    });
  }

  let commentPosted = false;
  if (canPostComment) {
    try {
      const body = renderExhaustionComment(input, marker);
      const bodyFilePath = resolveCommentBodyPath(input.runnerLogsRoot, input.runId);
      await writeFile(bodyFilePath, body, 'utf8');
      await deps.runGh([
        'issue',
        'comment',
        String(input.issueNumber),
        '--repo',
        `${input.repository.owner}/${input.repository.name}`,
        '--body-file',
        bodyFilePath,
      ]);
      commentPosted = true;
      deps.logger.info('exhaustion comment posted', {
        ...logFields,
        bodyFilePath,
      });
    } catch (error) {
      deps.logger.warn('exhaustion comment post failed', {
        ...logFields,
        error: describeError(error),
      });
    }
  }

  return { statusUpdated, commentPosted, duplicateSkipped };
}

export function buildMarker(runId: string): string {
  return `<!-- philharmonic-run-failed:run_id=${runId} -->`;
}

export function resolveCommentBodyPath(runnerLogsRoot: string, runId: string): string {
  return path.join(runnerLogsRoot, runId, COMMENT_FILE_NAME);
}

export function renderExhaustionComment(input: ExhaustionNotifyInput, marker: string): string {
  const summaryRel = `.philharmonic/runs/${input.runId}/summary.md`;
  const streamRel = `.philharmonic/runs/${input.runId}/stream.jsonl`;
  const stderrRel = `.philharmonic/runs/${input.runId}/stderr.log`;
  const metadataRel = `.philharmonic/runs/${input.runId}/metadata.json`;
  const failureSummaryRel =
    input.failureSummaryPath !== null
      ? `.philharmonic/runs/${input.runId}/failure-summary.md`
      : null;

  const trimmed = input.errorSummary?.trim() ?? '';
  const errorBody = trimmed.length > 0 ? trimmed : '_(empty)_';

  const artifactLines: string[] = [];
  if (failureSummaryRel !== null) {
    artifactLines.push(`- Failure summary: \`${failureSummaryRel}\``);
  }
  artifactLines.push(`- Run summary: \`${summaryRel}\``);
  artifactLines.push(`- Stream log: \`${streamRel}\``);
  artifactLines.push(`- Stderr log: \`${stderrRel}\``);
  artifactLines.push(`- Metadata: \`${metadataRel}\``);

  return [
    marker,
    '',
    '## philharmonic 自動 retry が上限に到達しました',
    '',
    `Issue #${input.issueNumber} は自動 retry 上限 (${input.maxAttempts}) に到達したため、orchestrator が safety-net として Project Status を \`${input.failedStatus}\` に倒し、本コメントを残しています (ADR-0010)。手動で原因を確認し、必要なら \`philharmonic retry ${input.issueNumber}\` で再実行してください。`,
    '',
    '### Summary',
    '',
    `- Issue: #${input.issueNumber}`,
    `- Final attempt: ${input.attempt} / ${input.maxAttempts}`,
    `- Last failure reason: \`${input.failureReason}\``,
    `- Last run id: \`${input.runId}\``,
    `- Branch: \`${input.branch}\``,
    `- Workspace path: \`${input.workspacePath}\``,
    `- Exhausted at: ${input.exhaustedAt.toISOString()}`,
    '',
    '### Last error summary',
    '',
    errorBody,
    '',
    '### Run artifacts',
    '',
    ...artifactLines,
    '',
    '### Manual recovery',
    '',
    `1. \`${summaryRel}\` と \`${stderrRel}\` を確認して原因を特定する`,
    `2. 必要なら \`${input.workspacePath}\` の worktree を調査・cleanup する (\`philharmonic clean\` でも掃除可)`,
    `3. 再実行する場合は \`philharmonic retry ${input.issueNumber}\` を実行する (Project Status を dispatch 対象に戻し、stale worktree を片付ける)`,
    '',
  ].join('\n');
}

type GhCommentListResponse = {
  comments?: ReadonlyArray<{ body?: string | null | undefined }>;
};

async function listIssueCommentBodies(
  runGh: GhRunner,
  repository: { owner: string; name: string },
  issueNumber: number,
): Promise<string[]> {
  const { stdout } = await runGh([
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    `${repository.owner}/${repository.name}`,
    '--json',
    'comments',
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `failed to parse \`gh issue view --json comments\` output: ${describeError(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('unexpected `gh issue view --json comments` shape: not an object');
  }
  const comments = (parsed as GhCommentListResponse).comments ?? [];
  const out: string[] = [];
  for (const c of comments) {
    if (typeof c.body === 'string') out.push(c.body);
  }
  return out;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
