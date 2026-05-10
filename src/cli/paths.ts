import { stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_WORKFLOW_FILE, LEGACY_WORKFLOW_FILE } from '../config/index.js';
import type { Logger } from '../logger/index.js';

export type ResolveWorkflowPathInput = {
  repoRoot: string;
  /** `config.workflowFile` をそのまま渡す (default なら新パス、明示指定なら任意の値) */
  workflowFile: string;
  /** 解決過程で legacy `WORKFLOW.md` を採用したときに warn を出すための logger */
  logger?: Logger;
};

export type ResolveWorkflowPathResult = {
  /** `createWorkflowSource` に渡す絶対パス */
  workflowPath: string;
  /** ファイル不在時に `buildPrompt` フォールバックを許すか (= default を採用しているか) */
  fallbackOnMissing: boolean;
};

/**
 * `workflow_file` のパスを解決する。default (`.philharmonic/WORKFLOW.md`) が不在で
 * legacy `WORKFLOW.md` (repo root 直下) が存在する場合だけ legacy にフォールバックし、
 * その場合は warn を 1 回だけ出す (#67)。
 *
 * 明示指定 (`workflow_file: ...` を config に書いた) のときは legacy fallback を行わない。
 * 「明示指定されたファイルが無い」のは typo の可能性が高いため、`createWorkflowSource`
 * 側で `WorkflowFileNotFoundError` を出して dispatch を Failed に倒す。
 */
export async function resolveWorkflowPath(
  input: ResolveWorkflowPathInput,
): Promise<ResolveWorkflowPathResult> {
  const isDefault = input.workflowFile === DEFAULT_WORKFLOW_FILE;
  const primaryPath = path.resolve(input.repoRoot, input.workflowFile);

  if (!isDefault) {
    return { workflowPath: primaryPath, fallbackOnMissing: false };
  }

  if (await pathExists(primaryPath)) {
    return { workflowPath: primaryPath, fallbackOnMissing: true };
  }

  const legacyPath = path.resolve(input.repoRoot, LEGACY_WORKFLOW_FILE);
  if (await pathExists(legacyPath)) {
    input.logger?.warn(
      'legacy `WORKFLOW.md` を repo root から読み込みました。`.philharmonic/WORKFLOW.md` への移動を推奨します (#67)',
      { legacyPath, expectedPath: primaryPath },
    );
    return { workflowPath: legacyPath, fallbackOnMissing: true };
  }

  return { workflowPath: primaryPath, fallbackOnMissing: true };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
