import { readFile, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';

import { Liquid } from 'liquidjs';

import type { Logger } from '../logger/index.js';

import { WorkflowFileNotFoundError, WorkflowReadError, WorkflowRenderError } from './errors.js';
import { appendOrchestratorFooter } from './footer.js';
import {
  buildWorkflowVariables,
  renderFallbackPrompt,
  type BuildWorkflowVariablesInput,
  type WorkflowVariables,
} from './variables.js';

export type { WorkflowVariables, BuildWorkflowVariablesInput } from './variables.js';

export type RenderInput = BuildWorkflowVariablesInput;

export interface WorkflowSource {
  /**
   * 1 dispatch 分の prompt を組み立てる。
   *
   * - WORKFLOW.md があれば Liquid で render → 末尾に安全制約フッタ連結
   * - 無ければ buildPrompt フォールバック (Orchestrator 制約は Constraints セクション末尾に埋め込み)
   * - 呼び出しごとに `mtime` を確認し、変更があれば再 parse する (hot-reload)
   */
  render(input: RenderInput): Promise<string>;

  /** `fs.watch` を解除する。`watch=false` のときは何もしない。 */
  close(): Promise<void>;
}

export type CreateWorkflowSourceOptions = {
  /** WORKFLOW.md の絶対パス (repoRoot + workflow_file 相当を呼び出し側で resolve 済み) */
  workflowPath: string;
  /** デフォルト名のとき不在を許容してフォールバックする (config が未指定 = WORKFLOW.md のとき true) */
  fallbackOnMissing: boolean;
  /** `philharmonic serve` daemon でのみ true。fs.watch を仕掛けて reload ログを出す */
  watch?: boolean;
  logger?: Logger;
};

type CachedTemplate = {
  templateText: string;
  mtimeMs: number;
};

/**
 * WORKFLOW.md (Liquid) を上位レイヤとして prompt を組み立てる WorkflowSource を作る。
 *
 * 仕様: docs/specs/workflow.md / docs/adr/0003-prompt-templating.md
 */
export async function createWorkflowSource(
  options: CreateWorkflowSourceOptions,
): Promise<WorkflowSource> {
  const { workflowPath, fallbackOnMissing, watch: enableWatch = false, logger } = options;

  const liquid = new Liquid({ jsTruthy: true });
  let cache: CachedTemplate | null = null;
  let watcher: FSWatcher | null = null;

  const invalidate = (): void => {
    cache = null;
  };

  const initialState = await probeWorkflow(workflowPath);
  if (initialState.kind === 'present') {
    cache = initialState.cached;
    logger?.info('workflow loaded', { workflowPath });
  } else if (initialState.kind === 'missing') {
    if (!fallbackOnMissing) {
      throw new WorkflowFileNotFoundError(workflowPath);
    }
    logger?.info('workflow not found (falling back to buildPrompt)', { workflowPath });
  } else {
    throw new WorkflowReadError(workflowPath, initialState.cause);
  }

  if (enableWatch) {
    try {
      watcher = watch(workflowPath, { persistent: false }, () => {
        invalidate();
        logger?.info('workflow reloaded', { workflowPath });
      });
      watcher.on('error', (err) => {
        logger?.warn('workflow watcher エラー (dispatch ごとの mtime チェックは継続)', {
          workflowPath,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      // watch 自体が失敗しても dispatch ごとの読み直しは効くため warn だけ出して継続
      logger?.warn(
        'workflow watcher を開始できませんでした (dispatch ごとの mtime チェックは継続)',
        {
          workflowPath,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return {
    async render(input) {
      const state = await probeWorkflow(workflowPath);

      if (state.kind === 'present') {
        if (cache === null || cache.mtimeMs !== state.cached.mtimeMs) {
          cache = state.cached;
        }
        const variables = buildWorkflowVariables(input);
        return await renderTemplate({
          liquid,
          templateText: cache.templateText,
          workflowPath,
          variables,
        });
      }

      if (state.kind === 'missing') {
        if (!fallbackOnMissing) throw new WorkflowFileNotFoundError(workflowPath);
        invalidate();
        return renderFallbackPrompt(input);
      }

      throw new WorkflowReadError(workflowPath, state.cause);
    },

    async close() {
      if (watcher !== null) {
        watcher.close();
        watcher = null;
      }
    },
  };
}

type ProbeResult =
  | { kind: 'present'; cached: CachedTemplate }
  | { kind: 'missing' }
  | { kind: 'error'; cause: unknown };

async function probeWorkflow(workflowPath: string): Promise<ProbeResult> {
  let mtimeMs: number;
  try {
    const stats = await stat(workflowPath);
    if (!stats.isFile()) {
      return { kind: 'error', cause: new Error(`${workflowPath} はファイルではありません`) };
    }
    mtimeMs = stats.mtimeMs;
  } catch (err) {
    if (isNodeENOENT(err)) return { kind: 'missing' };
    return { kind: 'error', cause: err };
  }
  let templateText: string;
  try {
    templateText = await readFile(workflowPath, 'utf8');
  } catch (err) {
    if (isNodeENOENT(err)) return { kind: 'missing' };
    return { kind: 'error', cause: err };
  }
  return { kind: 'present', cached: { templateText, mtimeMs } };
}

async function renderTemplate(args: {
  liquid: Liquid;
  templateText: string;
  workflowPath: string;
  variables: WorkflowVariables;
}): Promise<string> {
  const { liquid, templateText, workflowPath, variables } = args;
  let parsed;
  try {
    parsed = liquid.parse(templateText);
  } catch (err) {
    throw new WorkflowRenderError(workflowPath, err);
  }
  let rendered: string;
  try {
    rendered = await liquid.render(parsed, variables);
  } catch (err) {
    throw new WorkflowRenderError(workflowPath, err);
  }
  return appendOrchestratorFooter(rendered);
}

function isNodeENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
