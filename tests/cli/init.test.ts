import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createInitCommand,
  parseGitHubOwner,
  renderConfigYaml,
  type InitCommandDeps,
  type Prompter,
} from '../../src/cli/init.js';
import { loadConfig } from '../../src/config/index.js';

type Streams = {
  stdout: { write: ReturnType<typeof vi.fn> };
  stderr: { write: ReturnType<typeof vi.fn> };
};

function createStreams(): Streams {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function joinWrites(stream: { write: ReturnType<typeof vi.fn> }): string {
  return stream.write.mock.calls.map((c) => c[0] as string).join('');
}

type FsMocks = {
  files: Map<string, string>;
  pathExists: (filePath: string) => Promise<boolean>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: ReturnType<typeof vi.fn>;
};

function createFsMocks(initial: Record<string, string> = {}): FsMocks {
  const files = new Map<string, string>(Object.entries(initial));
  const writeFile = vi.fn(async (filePath: string, content: string) => {
    files.set(filePath, content);
  });
  return {
    files,
    pathExists: async (filePath: string) => files.has(filePath),
    readFile: async (filePath: string) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error(`ENOENT: ${filePath}`);
      return value;
    },
    writeFile,
  };
}

function makeQueuePrompter(answers: string[]): Prompter {
  const queue = [...answers];
  return vi.fn(async () => {
    if (queue.length === 0) throw new Error('prompt was called more times than expected');
    return queue.shift() ?? '';
  });
}

async function runCmd(streams: Streams, deps: InitCommandDeps, args: string[] = []) {
  const exit = vi.fn(() => {
    throw new Error('__exit__');
  });
  const cmd = createInitCommand({ ...deps, ...streams, exit: exit as never });
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if ((error as Error).message !== '__exit__') throw error;
  }
  return { exit };
}

const REPO_ROOT = '/tmp/repo';
// #67: init は `.philharmonic/` 配下に config / workflow を生成する
const yamlPath = (cwd: string) => path.resolve(cwd, '.philharmonic/philharmonic.yaml');
const legacyYamlPath = (cwd: string) => path.resolve(cwd, 'philharmonic.yaml');
const workflowPath = (cwd: string) => path.resolve(cwd, '.philharmonic/WORKFLOW.md');
const gitignorePath = (cwd: string) => path.resolve(cwd, '.gitignore');

describe('parseGitHubOwner', () => {
  it('git@github.com:foo/bar.git から owner を抽出する', () => {
    expect(parseGitHubOwner('git@github.com:hexylab/philharmonic.git')).toBe('hexylab');
  });

  it('https://github.com/foo/bar.git から owner を抽出する', () => {
    expect(parseGitHubOwner('https://github.com/hexylab/philharmonic.git')).toBe('hexylab');
  });

  it('https URL の .git なしでも抽出する', () => {
    expect(parseGitHubOwner('https://github.com/hexylab/philharmonic')).toBe('hexylab');
  });

  it('GitHub 以外の URL では null を返す', () => {
    expect(parseGitHubOwner('git@gitlab.com:foo/bar.git')).toBeNull();
    expect(parseGitHubOwner('')).toBeNull();
    expect(parseGitHubOwner('not a url')).toBeNull();
  });
});

describe('renderConfigYaml', () => {
  it('owner / project_number のみ active で残りはコメント化されている', () => {
    const out = renderConfigYaml({
      owner: 'hexylab',
      projectNumber: 1,
      permissionModeBypass: false,
    });
    expect(out).toMatch(/^owner: hexylab$/m);
    expect(out).toMatch(/^project_number: 1$/m);
    expect(out).toMatch(/^# permission_mode: auto/m);
    expect(out).toMatch(/^# base_branch: main/m);
    expect(out).toMatch(/^# polling:/m);
    expect(out).toMatch(/^# server:/m);
    expect(out).toMatch(/^# hooks:/m);
  });

  it('permissionModeBypass=true なら permission_mode 行が active になる', () => {
    const out = renderConfigYaml({
      owner: 'hexylab',
      projectNumber: 1,
      permissionModeBypass: true,
    });
    expect(out).toMatch(/^permission_mode: bypass\b/m);
    expect(out).not.toMatch(/^# permission_mode:/m);
  });
});

describe('philharmonic init CLI コマンド', () => {
  it('--help にコマンドの説明と全フラグが表示される', () => {
    const cmd = createInitCommand();
    const helpText = cmd.helpInformation();
    expect(cmd.description()).toContain('.philharmonic/philharmonic.yaml');
    expect(helpText).toContain('--owner');
    expect(helpText).toContain('--project');
    expect(helpText).toContain('--yes');
    expect(helpText).toContain('--force');
    expect(helpText).toContain('--dry-run');
    expect(helpText).toContain('--no-workflow');
  });

  it('--yes --owner --project の最小フラグで非対話的に .philharmonic/philharmonic.yaml を生成する', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks();

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt: vi.fn(),
        isTTY: () => true,
      },
      ['--yes', '--owner', 'hexylab', '--project', '1'],
    );

    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      yamlPath(REPO_ROOT),
      expect.stringContaining('owner: hexylab'),
    );
    const written = fsMocks.files.get(yamlPath(REPO_ROOT)) ?? '';
    expect(written).toMatch(/^owner: hexylab$/m);
    expect(written).toMatch(/^project_number: 1$/m);
    // --yes は対話モードではないため permission_mode は active 化しない
    expect(written).toMatch(/^# permission_mode: auto/m);
  });

  it('--dry-run では writeFile を呼ばず stdout に YAML 内容を出力する', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks();

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt: vi.fn(),
        isTTY: () => false,
      },
      ['--dry-run', '--owner', 'hexylab', '--project', '1'],
    );

    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    const out = joinWrites(streams.stdout);
    expect(out).toContain('would write');
    expect(out).toContain('owner: hexylab');
    expect(out).toContain('project_number: 1');
  });

  it('既存の .philharmonic/philharmonic.yaml があると --force なしでは error exit する', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks({
      [yamlPath(REPO_ROOT)]: 'owner: old\nproject_number: 99\n',
    });

    const { exit } = await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt: vi.fn(),
        isTTY: () => false,
      },
      ['--yes', '--owner', 'hexylab', '--project', '1'],
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(joinWrites(streams.stderr)).toMatch(/既に存在/);
  });

  it('--force を渡せば既存ファイルを上書きする', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks({
      [yamlPath(REPO_ROOT)]: 'owner: old\nproject_number: 99\n',
    });

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt: vi.fn(),
        isTTY: () => false,
      },
      ['--yes', '--force', '--owner', 'hexylab', '--project', '1'],
    );

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      yamlPath(REPO_ROOT),
      expect.stringContaining('owner: hexylab'),
    );
  });

  it('git remote から owner を auto-detect する (https / ssh 両方)', async () => {
    for (const remoteUrl of [
      'https://github.com/hexylab/philharmonic.git',
      'git@github.com:hexylab/philharmonic.git',
    ]) {
      const streams = createStreams();
      const fsMocks = createFsMocks();
      const runGit = vi.fn(async () => ({ stdout: `${remoteUrl}\n`, stderr: '' }));

      await runCmd(
        streams,
        {
          cwd: () => REPO_ROOT,
          runGit,
          readFile: fsMocks.readFile,
          writeFile: fsMocks.writeFile,
          pathExists: fsMocks.pathExists,
          prompt: vi.fn(),
          isTTY: () => false,
        },
        ['--yes', '--project', '1'],
      );

      expect(runGit).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], { cwd: REPO_ROOT });
      const written = fsMocks.files.get(yamlPath(REPO_ROOT)) ?? '';
      expect(written).toMatch(/^owner: hexylab$/m);
    }
  });

  it('非 TTY 環境で必須項目 (owner / project_number) が揃わなければ exit 1', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks();

    const { exit } = await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(async () => {
          throw new Error('no remote');
        }),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt: vi.fn(),
        isTTY: () => false,
      },
      ['--project', '1'],
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(joinWrites(streams.stderr)).toMatch(/owner/);
  });

  it('対話モードで bypass=Yes / WORKFLOW=Yes / .gitignore=Yes を選ぶと全部反映される (#67)', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks({
      [gitignorePath(REPO_ROOT)]: 'node_modules\ndist\n',
    });
    const prompt = makeQueuePrompter([
      '', // owner: detected default を採用
      '1', // project_number
      'y', // permission_mode bypass
      'y', // .philharmonic/WORKFLOW.md
      'y', // .gitignore (worktrees/ / runs/ / serve.lock)
    ]);

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(async () => ({
          stdout: 'git@github.com:hexylab/philharmonic.git\n',
          stderr: '',
        })),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt,
        isTTY: () => true,
      },
      [],
    );

    const yamlContent = fsMocks.files.get(yamlPath(REPO_ROOT)) ?? '';
    expect(yamlContent).toMatch(/^permission_mode: bypass/m);
    const workflowContent = fsMocks.files.get(workflowPath(REPO_ROOT)) ?? '';
    expect(workflowContent).toContain('{{ issue.body }}');
    const gitignoreContent = fsMocks.files.get(gitignorePath(REPO_ROOT)) ?? '';
    // `.philharmonic/philharmonic.yaml` 等は commit 可能にしておくため、
    // 生成物 (worktrees / runs / serve.lock) のみを ignore に追記する (#67)
    expect(gitignoreContent).toContain('.philharmonic/worktrees/\n');
    expect(gitignoreContent).toContain('.philharmonic/runs/\n');
    expect(gitignoreContent).toContain('.philharmonic/serve.lock\n');
    expect(gitignoreContent).not.toMatch(/^\.philharmonic\/$/m);
  });

  it('対話モードで bypass=No なら permission_mode はコメントのまま', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks();
    const prompt = makeQueuePrompter([
      'hexylab', // owner
      '1', // project_number
      'n', // permission_mode bypass
      'n', // WORKFLOW.md
    ]);

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(async () => {
          throw new Error('no remote');
        }),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt,
        isTTY: () => true,
      },
      [],
    );

    const yamlContent = fsMocks.files.get(yamlPath(REPO_ROOT)) ?? '';
    expect(yamlContent).toMatch(/^# permission_mode: auto/m);
    expect(yamlContent).not.toMatch(/^permission_mode:/m);
    expect(fsMocks.files.has(workflowPath(REPO_ROOT))).toBe(false);
  });

  it('.gitignore に既に broad ignore (.philharmonic/) がある場合は重複追記しない (#67 後方互換)', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks({
      [gitignorePath(REPO_ROOT)]: 'node_modules\n.philharmonic/\n',
    });
    const prompt = makeQueuePrompter([
      'hexylab', // owner
      '1', // project_number
      'n', // bypass
      'n', // workflow
      'y', // gitignore
    ]);

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(async () => {
          throw new Error('no remote');
        }),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt,
        isTTY: () => true,
      },
      [],
    );

    const gitignoreContent = fsMocks.files.get(gitignorePath(REPO_ROOT)) ?? '';
    const occurrences = gitignoreContent.split('\n').filter((l) => l.trim() === '.philharmonic/');
    expect(occurrences.length).toBe(1);
    // 生成物用の細かい行は重複しない (broad ignore の側で既にカバーされているとみなす)
    expect(gitignoreContent).not.toContain('.philharmonic/worktrees/');
    expect(joinWrites(streams.stdout)).toMatch(/already contains/);
  });

  it('.gitignore に既に worktrees / runs / serve.lock がある場合は重複追記しない (#67)', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks({
      [gitignorePath(REPO_ROOT)]:
        'node_modules\n.philharmonic/worktrees/\n.philharmonic/runs/\n.philharmonic/serve.lock\n',
    });
    const prompt = makeQueuePrompter(['hexylab', '1', 'n', 'n', 'y']);

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(async () => {
          throw new Error('no remote');
        }),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt,
        isTTY: () => true,
      },
      [],
    );

    const gitignoreContent = fsMocks.files.get(gitignorePath(REPO_ROOT)) ?? '';
    expect(gitignoreContent.match(/\.philharmonic\/worktrees\//g)?.length ?? 0).toBe(1);
    expect(joinWrites(streams.stdout)).toMatch(/already contains/);
  });

  it('--no-workflow を渡すと対話プロンプトが上がっても .philharmonic/WORKFLOW.md は生成しない', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks();
    const prompt = makeQueuePrompter([
      'hexylab', // owner
      '1', // project_number
      'n', // bypass
      // workflow prompt は飛ばされる (--no-workflow のため)
    ]);

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(async () => {
          throw new Error('no remote');
        }),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt,
        isTTY: () => true,
      },
      ['--no-workflow'],
    );

    expect(fsMocks.files.has(workflowPath(REPO_ROOT))).toBe(false);
  });

  it('repo root に legacy philharmonic.yaml があると warning を出して移行を促す (#67)', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks({
      [legacyYamlPath(REPO_ROOT)]: 'owner: legacy\nproject_number: 99\n',
    });

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt: vi.fn(),
        isTTY: () => false,
      },
      ['--yes', '--owner', 'hexylab', '--project', '1'],
    );

    const stderr = joinWrites(streams.stderr);
    expect(stderr).toMatch(/legacy philharmonic\.yaml/);
    expect(stderr).toMatch(/\.philharmonic\/philharmonic\.yaml/);
    // 新規 yaml は `.philharmonic/` 配下に書かれており、legacy は触らない
    expect(fsMocks.files.has(yamlPath(REPO_ROOT))).toBe(true);
    expect(fsMocks.files.get(legacyYamlPath(REPO_ROOT))).toBe(
      'owner: legacy\nproject_number: 99\n',
    );
  });

  it('default writeFile は親ディレクトリ (.philharmonic/) を recursive に作成する (#67)', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'philharmonic-init-mkdir-'));
    try {
      const streams = createStreams();
      // deps.writeFile を default 実装に任せる (defaultWriteFile が `.philharmonic/` を作るかを実 fs で検証)
      await runCmd(
        streams,
        {
          cwd: () => tmpRoot,
          runGit: vi.fn(),
          isTTY: () => false,
        },
        ['--yes', '--owner', 'hexylab', '--project', '1'],
      );

      const written = await import('node:fs/promises').then((fsmod) =>
        fsmod.readFile(path.join(tmpRoot, '.philharmonic/philharmonic.yaml'), 'utf8'),
      );
      expect(written).toMatch(/^owner: hexylab$/m);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('Philharmonic 自身のリポジトリでは warning を出す', async () => {
    const streams = createStreams();
    const fsMocks = createFsMocks({
      [path.resolve(REPO_ROOT, 'package.json')]: JSON.stringify({ name: 'philharmonic' }),
    });

    await runCmd(
      streams,
      {
        cwd: () => REPO_ROOT,
        runGit: vi.fn(),
        readFile: fsMocks.readFile,
        writeFile: fsMocks.writeFile,
        pathExists: fsMocks.pathExists,
        prompt: vi.fn(),
        isTTY: () => false,
      },
      ['--yes', '--owner', 'hexylab', '--project', '1'],
    );

    expect(joinWrites(streams.stderr)).toMatch(/Philharmonic 自身のリポジトリ/);
    expect(fsMocks.files.has(yamlPath(REPO_ROOT))).toBe(true);
  });

  it('生成された philharmonic.yaml は loadConfig() でラウンドトリップ valid になる', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'philharmonic-init-'));
    try {
      // bypass=true 含めて active 化された行があっても schema が通ることを確認
      const yamlContent = renderConfigYaml({
        owner: 'hexylab',
        projectNumber: 1,
        permissionModeBypass: true,
      });
      const filePath = path.join(tmpDir, 'philharmonic.yaml');
      await writeFile(filePath, yamlContent, 'utf8');

      const config = await loadConfig(filePath);
      expect(config.owner).toBe('hexylab');
      expect(config.projectNumber).toBe(1);
      expect(config.permissionMode).toBe('bypass');
      // commented-out keys retain default values
      expect(config.baseBranch).toBe('main');
      expect(config.statusField).toBe('Status');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('renderConfigYaml の生成内容は強引に YAML 抜き出ししても loadConfig で valid', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'philharmonic-init-default-'));
    try {
      const yamlContent = renderConfigYaml({
        owner: 'hexylab',
        projectNumber: 1,
        permissionModeBypass: false,
      });
      const filePath = path.join(tmpDir, 'philharmonic.yaml');
      await writeFile(filePath, yamlContent, 'utf8');
      const config = await loadConfig(filePath);
      expect(config.permissionMode).toBe('auto');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('--project に負数を指定すると Commander が拒否する', async () => {
    const cmd = createInitCommand({
      cwd: () => REPO_ROOT,
      runGit: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      pathExists: vi.fn(async () => false),
      prompt: vi.fn(),
      isTTY: () => false,
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      stderr: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      exit: ((code: number) => {
        throw new Error(`__exit__${code}`);
      }) as never,
    });
    cmd.exitOverride();
    await expect(cmd.parseAsync(['--project', '-1'], { from: 'user' })).rejects.toThrow();
  });
});
