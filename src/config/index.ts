export {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  formatConfigError,
  type ConfigValidationIssue,
} from './errors.js';
export { loadConfig, type LoadConfigOptions } from './loader.js';
export {
  configSchema,
  DEFAULT_BASE_BRANCH,
  DEFAULT_CLEAN_RETENTION_DAYS,
  DEFAULT_CONFIG_FILE,
  DEFAULT_DISPATCH_STATUSES,
  DEFAULT_KILL_GRACE_PERIOD_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_POLLING_INTERVAL_MS,
  DEFAULT_STATUS_FIELD,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WORKSPACE_ROOT,
  LOW_POLLING_INTERVAL_WARN_THRESHOLD_MS,
  MIN_POLLING_INTERVAL_MS,
  type Config,
  type RawConfigInput,
} from './schema.js';
