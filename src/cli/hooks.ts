import type { Config } from '../config/index.js';
import type { HookConfigMap } from '../workspace/index.js';

/**
 * `Config['hooks']` (camelCase) を `HookConfigMap` (snake_case event 名) に変換する。
 *
 * spec: `docs/specs/workspace-manager.md#lifecycle-hooks-26`
 */
export function configHooksToHookConfigMap(hooks: Config['hooks']): HookConfigMap {
  return {
    after_create: hooks.afterCreate,
    before_run: hooks.beforeRun,
    after_run: hooks.afterRun,
    before_remove: hooks.beforeRemove,
  };
}
