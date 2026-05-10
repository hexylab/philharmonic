import { readFile } from 'node:fs/promises';
import path from 'node:path';

import yaml from 'js-yaml';
import { ZodError } from 'zod';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  type ConfigValidationIssue,
} from './errors.js';
import { configSchema, DEFAULT_CONFIG_FILE, LEGACY_CONFIG_FILE, type Config } from './schema.js';

export type LoadConfigOptions = {
  cwd?: string;
  /**
   * default パス (`.philharmonic/philharmonic.yaml`) が不在で、legacy `philharmonic.yaml`
   * (repo root 直下) から読み込むことになったときに 1 度だけ呼ばれる。CLI 側で warning を
   * 出すための seam (loader 自体は logger を持たない)。
   */
  onLegacyPathUsed?: (legacyPath: string, expectedPath: string) => void;
};

export async function loadConfig(
  configPath?: string,
  options: LoadConfigOptions = {},
): Promise<Config> {
  const cwd = options.cwd ?? process.cwd();
  const { resolvedPath, raw } = await readConfigSource({
    configPath,
    cwd,
    onLegacyPathUsed: options.onLegacyPathUsed,
  });

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { filename: resolvedPath });
  } catch (error) {
    throw toParseError(error, resolvedPath);
  }

  // null / undefined / 空ドキュメントは空オブジェクト相当として扱い、
  // zod のメッセージで「owner が必須」と教えるほうが親切なので空 object を渡す
  const target = parsed ?? {};

  const result = configSchema.safeParse(target);
  if (!result.success) {
    throw toValidationError(result.error, resolvedPath);
  }
  return result.data;
}

type ReadConfigSourceInput = {
  configPath: string | undefined;
  cwd: string;
  onLegacyPathUsed?: (legacyPath: string, expectedPath: string) => void;
};

type ReadConfigSourceResult = {
  resolvedPath: string;
  raw: string;
};

async function readConfigSource(input: ReadConfigSourceInput): Promise<ReadConfigSourceResult> {
  if (input.configPath !== undefined) {
    const explicitPath = input.configPath;
    try {
      const raw = await readFile(explicitPath, 'utf8');
      return { resolvedPath: explicitPath, raw };
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        throw new ConfigFileNotFoundError(explicitPath);
      }
      throw error;
    }
  }

  const defaultPath = path.resolve(input.cwd, DEFAULT_CONFIG_FILE);
  const defaultRaw = await tryReadFile(defaultPath);
  if (defaultRaw !== null) {
    return { resolvedPath: defaultPath, raw: defaultRaw };
  }

  const legacyPath = path.resolve(input.cwd, LEGACY_CONFIG_FILE);
  const legacyRaw = await tryReadFile(legacyPath);
  if (legacyRaw !== null) {
    input.onLegacyPathUsed?.(legacyPath, defaultPath);
    return { resolvedPath: legacyPath, raw: legacyRaw };
  }

  throw new ConfigFileNotFoundError(defaultPath);
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function toParseError(error: unknown, filePath: string): ConfigParseError {
  if (isYamlException(error)) {
    const reason = error.reason ?? error.message;
    const line = error.mark?.line !== undefined ? error.mark.line + 1 : null;
    return new ConfigParseError(filePath, reason, line);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ConfigParseError(filePath, message, null);
}

function toValidationError(error: ZodError, filePath: string): ConfigValidationError {
  const issues: ConfigValidationIssue[] = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return new ConfigValidationError(filePath, issues);
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

type YamlExceptionLike = {
  name: string;
  message: string;
  reason?: string;
  mark?: { line?: number };
};

function isYamlException(value: unknown): value is YamlExceptionLike {
  return (
    value instanceof Error &&
    (value.name === 'YAMLException' || value.constructor.name === 'YAMLException')
  );
}
