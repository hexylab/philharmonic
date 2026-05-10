import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  DEFAULT_CONFIG_FILE,
  formatConfigError,
  LEGACY_CONFIG_FILE,
  loadConfig,
} from '../../src/config/index.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'phil-config-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeConfig(contents: string, name = DEFAULT_CONFIG_FILE): Promise<string> {
  const filePath = path.join(workdir, name);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

describe('loadConfig', () => {
  it('明示パスで指定された設定ファイルを読み込みデフォルトを補完する', async () => {
    const filePath = await writeConfig('owner: hexylab\nproject_number: 1\n');

    const config = await loadConfig(filePath);

    expect(config.owner).toBe('hexylab');
    expect(config.projectNumber).toBe(1);
    expect(config.baseBranch).toBe('main');
    expect(config.permissionMode).toBe('auto');
    expect(config.agentUserLogin).toBeNull();
    expect(config.workspaceRoot).toBe('.philharmonic/worktrees');
  });

  it('YAML の null / ~ / キー省略をいずれも null として解釈する (agent_user_login)', async () => {
    const explicitNullPath = await writeConfig(
      'owner: hexylab\nproject_number: 1\nagent_user_login: null\n',
      'explicit.yaml',
    );
    const tildeNullPath = await writeConfig(
      'owner: hexylab\nproject_number: 1\nagent_user_login: ~\n',
      'tilde.yaml',
    );
    const omittedPath = await writeConfig('owner: hexylab\nproject_number: 1\n', 'omitted.yaml');

    expect((await loadConfig(explicitNullPath)).agentUserLogin).toBeNull();
    expect((await loadConfig(tildeNullPath)).agentUserLogin).toBeNull();
    expect((await loadConfig(omittedPath)).agentUserLogin).toBeNull();
  });

  it('path 省略時は cwd の .philharmonic/philharmonic.yaml を読みに行く (#67)', async () => {
    await writeConfig('owner: hexylab\nproject_number: 1\n');

    const config = await loadConfig(undefined, { cwd: workdir });

    expect(config.owner).toBe('hexylab');
  });

  it('default が無く legacy `philharmonic.yaml` のみが存在する場合は legacy を採用し warning コールバックを呼ぶ (#67)', async () => {
    await writeConfig('owner: hexylab\nproject_number: 1\n', LEGACY_CONFIG_FILE);
    const onLegacyPathUsed = vi.fn();

    const config = await loadConfig(undefined, { cwd: workdir, onLegacyPathUsed });

    expect(config.owner).toBe('hexylab');
    expect(onLegacyPathUsed).toHaveBeenCalledTimes(1);
    expect(onLegacyPathUsed).toHaveBeenCalledWith(
      path.join(workdir, LEGACY_CONFIG_FILE),
      path.join(workdir, DEFAULT_CONFIG_FILE),
    );
  });

  it('default と legacy 両方ある場合は default を優先し warning は出ない (#67)', async () => {
    await writeConfig('owner: hexylab\nproject_number: 1\n');
    await writeConfig('owner: legacy-owner\nproject_number: 99\n', LEGACY_CONFIG_FILE);
    const onLegacyPathUsed = vi.fn();

    const config = await loadConfig(undefined, { cwd: workdir, onLegacyPathUsed });

    expect(config.owner).toBe('hexylab');
    expect(onLegacyPathUsed).not.toHaveBeenCalled();
  });

  it('default も legacy も無いときは新パスを含む ConfigFileNotFoundError を投げる (#67)', async () => {
    const expected = path.join(workdir, DEFAULT_CONFIG_FILE);

    const error = await loadConfig(undefined, { cwd: workdir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigFileNotFoundError);
    if (error instanceof ConfigFileNotFoundError) {
      expect(error.path).toBe(expected);
    }
  });

  it('--config 明示指定時は legacy fallback の探索を行わない (#67)', async () => {
    await writeConfig('owner: legacy-owner\nproject_number: 99\n', LEGACY_CONFIG_FILE);
    const explicit = path.join(workdir, 'missing.yaml');
    const onLegacyPathUsed = vi.fn();

    const error = await loadConfig(explicit, { cwd: workdir, onLegacyPathUsed }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigFileNotFoundError);
    if (error instanceof ConfigFileNotFoundError) {
      expect(error.path).toBe(explicit);
    }
    expect(onLegacyPathUsed).not.toHaveBeenCalled();
  });

  it('ファイルが存在しない場合は ConfigFileNotFoundError を投げる', async () => {
    const missing = path.join(workdir, 'missing.yaml');

    await expect(loadConfig(missing)).rejects.toBeInstanceOf(ConfigFileNotFoundError);
    await expect(loadConfig(missing)).rejects.toMatchObject({ path: missing });
  });

  it('YAML として不正な場合は ConfigParseError を投げる (path / 行番号を保持)', async () => {
    const filePath = await writeConfig(
      'owner: hexylab\nproject_number: 1\n  bad-indent: [unclosed',
      'broken.yaml',
    );

    const error = await loadConfig(filePath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigParseError);
    if (error instanceof ConfigParseError) {
      expect(error.path).toBe(filePath);
      expect(error.message).toContain(filePath);
      expect(error.line).toBeGreaterThan(0);
    }
  });

  it('owner / project_number が欠けていると ConfigValidationError を投げる', async () => {
    const filePath = await writeConfig('base_branch: main\n', 'missing-required.yaml');

    const error = await loadConfig(filePath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigValidationError);
    if (error instanceof ConfigValidationError) {
      const fields = error.issues.map((i) => i.path);
      expect(fields).toContain('owner');
      expect(fields).toContain('project_number');
    }
  });

  it('未知のキーは ConfigValidationError として通知する (strict)', async () => {
    const filePath = await writeConfig(
      'owner: hexylab\nproject_number: 1\ntypo_field: x\n',
      'unknown.yaml',
    );

    const error = await loadConfig(filePath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigValidationError);
    if (error instanceof ConfigValidationError) {
      expect(error.message).toContain(filePath);
    }
  });

  it('型違反 (timeout_ms に文字列) は ConfigValidationError を投げる', async () => {
    const filePath = await writeConfig(
      'owner: hexylab\nproject_number: 1\ntimeout_ms: "soon"\n',
      'wrong-type.yaml',
    );

    const error = await loadConfig(filePath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigValidationError);
    if (error instanceof ConfigValidationError) {
      const fields = error.issues.map((i) => i.path);
      expect(fields).toContain('timeout_ms');
    }
  });

  it('空ファイルでも owner / project_number 必須エラーを返す (parse error にしない)', async () => {
    const filePath = await writeConfig('', 'empty.yaml');

    const error = await loadConfig(filePath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigValidationError);
  });
});

describe('formatConfigError', () => {
  it('ConfigFileNotFoundError は path 付き message を返す', () => {
    const message = formatConfigError(new ConfigFileNotFoundError('/tmp/x.yaml'));
    expect(message).toContain('/tmp/x.yaml');
  });

  it('ConfigValidationError は各 issue を改行区切りで含める', () => {
    const error = new ConfigValidationError('/tmp/x.yaml', [
      { path: 'owner', message: '必須です' },
      { path: 'project_number', message: '必須です' },
    ]);
    const message = formatConfigError(error);
    expect(message).toContain('owner: 必須です');
    expect(message).toContain('project_number: 必須です');
  });

  it('未知のエラーでもそれっぽい文字列を返す', () => {
    expect(formatConfigError(new Error('boom'))).toContain('boom');
    expect(formatConfigError('raw string')).toContain('raw string');
  });
});
