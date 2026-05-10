import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveWorkflowPath } from '../../src/cli/paths.js';
import { DEFAULT_WORKFLOW_FILE, LEGACY_WORKFLOW_FILE } from '../../src/config/index.js';
import type { Logger } from '../../src/logger/index.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'phil-paths-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

async function writeFileEnsuring(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

describe('resolveWorkflowPath (#67)', () => {
  it('default パス (.philharmonic/WORKFLOW.md) が存在すればそれを使い fallbackOnMissing=true', async () => {
    const newDefault = path.join(workdir, DEFAULT_WORKFLOW_FILE);
    await writeFileEnsuring(newDefault, '# new template');
    const logger = fakeLogger();

    const result = await resolveWorkflowPath({
      repoRoot: workdir,
      workflowFile: DEFAULT_WORKFLOW_FILE,
      logger,
    });

    expect(result.workflowPath).toBe(newDefault);
    expect(result.fallbackOnMissing).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('default が無く legacy WORKFLOW.md が存在する場合は legacy を採用し warn を出す', async () => {
    const legacyPath = path.join(workdir, LEGACY_WORKFLOW_FILE);
    await writeFileEnsuring(legacyPath, '# legacy template');
    const logger = fakeLogger();

    const result = await resolveWorkflowPath({
      repoRoot: workdir,
      workflowFile: DEFAULT_WORKFLOW_FILE,
      logger,
    });

    expect(result.workflowPath).toBe(legacyPath);
    expect(result.fallbackOnMissing).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('legacy `WORKFLOW.md`'),
      expect.objectContaining({
        legacyPath,
        expectedPath: path.join(workdir, DEFAULT_WORKFLOW_FILE),
      }),
    );
    // ユーザ向け warning には内部 Issue 番号 / ADR 番号を含めない
    const warnMessage = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(warnMessage).not.toMatch(/\(#\d+\)/);
    expect(warnMessage).not.toMatch(/ADR-\d+/);
  });

  it('default も legacy も無いときは default パスを返し (fallbackOnMissing=true) warn は出ない', async () => {
    const logger = fakeLogger();

    const result = await resolveWorkflowPath({
      repoRoot: workdir,
      workflowFile: DEFAULT_WORKFLOW_FILE,
      logger,
    });

    expect(result.workflowPath).toBe(path.join(workdir, DEFAULT_WORKFLOW_FILE));
    expect(result.fallbackOnMissing).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('workflow_file を明示指定 (default 値以外) すると legacy 探索を行わず fallbackOnMissing=false', async () => {
    const legacyPath = path.join(workdir, LEGACY_WORKFLOW_FILE);
    await writeFileEnsuring(legacyPath, '# legacy template');
    const logger = fakeLogger();

    const result = await resolveWorkflowPath({
      repoRoot: workdir,
      workflowFile: 'PROMPT.md',
      logger,
    });

    expect(result.workflowPath).toBe(path.join(workdir, 'PROMPT.md'));
    expect(result.fallbackOnMissing).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('workflow_file: WORKFLOW.md と明示指定 (legacy default 値そのまま) も明示扱いし fallbackOnMissing=false', async () => {
    // legacy default 名 'WORKFLOW.md' は新 default ('.philharmonic/WORKFLOW.md') と一致しないため
    // 明示指定として扱う。ファイル不在なら createWorkflowSource 側で WorkflowFileNotFoundError を出す。
    const logger = fakeLogger();

    const result = await resolveWorkflowPath({
      repoRoot: workdir,
      workflowFile: LEGACY_WORKFLOW_FILE,
      logger,
    });

    expect(result.workflowPath).toBe(path.join(workdir, LEGACY_WORKFLOW_FILE));
    expect(result.fallbackOnMissing).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
