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
import { configSchema, DEFAULT_CONFIG_FILE, type Config } from './schema.js';

export type LoadConfigOptions = {
  cwd?: string;
};

export async function loadConfig(
  configPath?: string,
  options: LoadConfigOptions = {},
): Promise<Config> {
  const cwd = options.cwd ?? process.cwd();
  const resolvedPath = configPath ?? path.resolve(cwd, DEFAULT_CONFIG_FILE);

  let raw: string;
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new ConfigFileNotFoundError(resolvedPath);
    }
    throw error;
  }

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
