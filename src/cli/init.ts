import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { Command, InvalidArgumentError } from 'commander';
import yaml from 'js-yaml';

import { DEFAULT_CONFIG_FILE, DEFAULT_WORKFLOW_FILE, LEGACY_CONFIG_FILE } from '../config/index.js';
import { configSchema } from '../config/schema.js';
import { defaultGitRunner, type GitRunner } from '../workspace/index.js';

/**
 * `philharmonic init` は `.philharmonic/` 配下に config / workflow を生成する (#67)。
 * `.gitignore` には worktrees / runs / serve.lock のみを追記し、
 * `.philharmonic/philharmonic.yaml` と `.philharmonic/WORKFLOW.md` は commit 可能にしておく。
 */
const PHILHARMONIC_YAML_FILE = DEFAULT_CONFIG_FILE;
const LEGACY_PHILHARMONIC_YAML_FILE = LEGACY_CONFIG_FILE;
const WORKFLOW_FILE = DEFAULT_WORKFLOW_FILE;
const GITIGNORE_FILE = '.gitignore';
const GITIGNORE_LINES = [
  '.philharmonic/worktrees/',
  '.philharmonic/runs/',
  '.philharmonic/serve.lock',
] as const;
const PHILHARMONIC_PACKAGE_NAME = 'philharmonic';

const WORKFLOW_TEMPLATE = `# {{ repository.owner }}/{{ repository.name }} — Task #{{ issue.number }}

- Issue: [#{{ issue.number }} {{ issue.title }}]({{ issue.url }})
- Workspace: {{ workspace_path }}
- Run ID: \`{{ run_id }}\`

## Issue 本文

{{ issue.body }}
`;

export type Prompter = (question: string) => Promise<string>;

export type InitCommandDeps = {
  cwd?: () => string;
  runGit?: GitRunner;
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  pathExists?: (filePath: string) => Promise<boolean>;
  prompt?: Prompter;
  isTTY?: () => boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => never;
};

const defaultPathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const defaultPrompt: Prompter = async (question) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

const defaultWriteFile = async (filePath: string, content: string): Promise<void> => {
  // `.philharmonic/philharmonic.yaml` のような subdir を含むパスでも書き込めるよう
  // 親ディレクトリを recursive に作成してから書く (#67)。
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
};

const DEFAULT_DEPS: Required<InitCommandDeps> = {
  cwd: () => process.cwd(),
  runGit: defaultGitRunner,
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  writeFile: defaultWriteFile,
  pathExists: defaultPathExists,
  prompt: defaultPrompt,
  isTTY: () => Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code) as never,
};

type InitOptions = {
  owner?: string;
  project?: number;
  yes: boolean;
  force: boolean;
  dryRun: boolean;
  workflow: boolean;
};

export function createInitCommand(deps: InitCommandDeps = {}): Command {
  const resolved: Required<InitCommandDeps> = { ...DEFAULT_DEPS, ...deps };

  const cmd = new Command('init');
  cmd
    .description(
      '対象リポジトリで Philharmonic を始めるための .philharmonic/philharmonic.yaml を scaffold する',
    )
    .option(
      '--owner <login>',
      'Project owner の GitHub login (省略時は origin remote から auto-detect)',
    )
    .option('--project <number>', 'Project number (整数、必須)', parseProjectNumber)
    .option('--yes', '対話プロンプトをすべてスキップする (非対話モード)', false)
    .option('--force', '既存の .philharmonic/philharmonic.yaml を上書きする', false)
    .option('--dry-run', 'ファイルを書き込まず stdout に内容を出すだけ', false)
    .option(
      '--no-workflow',
      '.philharmonic/WORKFLOW.md の scaffold をスキップする (対話プロンプトを抑止)',
    )
    .action(async (options: InitOptions) => {
      await runInit(options, resolved);
    });
  return cmd;
}

async function runInit(options: InitOptions, deps: Required<InitCommandDeps>): Promise<void> {
  const cwd = deps.cwd();
  const interactive = !options.yes && deps.isTTY();

  if (await isPhilharmonicSelfRepo(cwd, deps.readFile)) {
    deps.stderr.write(
      'warning: Philharmonic 自身のリポジトリで init を実行しています (package.json の name が "philharmonic")\n',
    );
    if (interactive) {
      const ok = await confirm(deps.prompt, '本当に続行しますか?', false);
      if (!ok) {
        deps.stderr.write('aborted by user\n');
        deps.exit(1);
        return;
      }
    }
  }

  const yamlPath = path.resolve(cwd, PHILHARMONIC_YAML_FILE);
  if ((await deps.pathExists(yamlPath)) && !options.force) {
    deps.stderr.write(
      `${PHILHARMONIC_YAML_FILE} が既に存在します: ${yamlPath} (--force で上書き可)\n`,
    );
    deps.exit(1);
    return;
  }

  // 旧来 (#67 前) に repo root へ書いた `philharmonic.yaml` がある場合は移行を促す。
  // `--force` でも勝手には削除せず、ユーザに伝えるだけにとどめる。
  const legacyYamlPath = path.resolve(cwd, LEGACY_PHILHARMONIC_YAML_FILE);
  if (await deps.pathExists(legacyYamlPath)) {
    deps.stderr.write(
      `warning: legacy ${LEGACY_PHILHARMONIC_YAML_FILE} が repo root に存在します: ${legacyYamlPath}\n`,
    );
    deps.stderr.write(
      `  起動時の fallback で当面読み込まれますが、\`mkdir -p .philharmonic && git mv ${LEGACY_PHILHARMONIC_YAML_FILE} ${PHILHARMONIC_YAML_FILE}\` で移行することを推奨します\n`,
    );
  }

  const detectedOwner = await detectOriginOwner(cwd, deps.runGit);

  let owner = options.owner?.trim() ?? '';
  if (owner === '' && interactive) {
    const suffix = detectedOwner === null ? '' : ` [${detectedOwner}]`;
    const answer = (await deps.prompt(`owner${suffix}: `)).trim();
    owner = answer === '' ? (detectedOwner ?? '') : answer;
  } else if (owner === '' && detectedOwner !== null) {
    owner = detectedOwner;
  }
  if (owner === '') {
    deps.stderr.write(
      'owner が決まりません: --owner で指定するか、git remote の origin から auto-detect できる環境で実行してください\n',
    );
    deps.exit(1);
    return;
  }

  let projectNumber = options.project;
  if (projectNumber === undefined && interactive) {
    const answer = (await deps.prompt('project_number: ')).trim();
    const parsed = Number(answer);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      deps.stderr.write('project_number は正の整数で指定してください\n');
      deps.exit(1);
      return;
    }
    projectNumber = parsed;
  }
  if (projectNumber === undefined) {
    deps.stderr.write(
      'project_number が指定されていません: --project で指定するか、対話モードで実行してください\n',
    );
    deps.exit(1);
    return;
  }

  const permissionModeBypass = interactive
    ? await confirm(
        deps.prompt,
        'permission_mode を bypass にしますか? (agent が gh / git push を実行して PR を作るために実用上必須)',
        true,
      )
    : false;

  let generateWorkflow = false;
  if (options.workflow !== false && interactive) {
    generateWorkflow = await confirm(deps.prompt, `${WORKFLOW_FILE} を scaffold しますか?`, false);
  }

  const gitignorePath = path.resolve(cwd, GITIGNORE_FILE);
  const gitignoreExists = await deps.pathExists(gitignorePath);
  let appendGitignore = false;
  if (gitignoreExists && interactive) {
    // 生成物 (worktrees / runs / serve.lock) のみ ignore し、
    // `.philharmonic/philharmonic.yaml` / `.philharmonic/WORKFLOW.md` は commit 可能にする方針 (#67)。
    appendGitignore = await confirm(
      deps.prompt,
      `Philharmonic の生成物を ${GITIGNORE_FILE} に追記しますか? (worktrees/ / runs/ / serve.lock)`,
      true,
    );
  }

  const yamlContent = renderConfigYaml({ owner, projectNumber, permissionModeBypass });
  validateGeneratedYaml(yamlContent, deps.stderr, deps.exit);

  if (options.dryRun) {
    deps.stdout.write(`# would write ${yamlPath}\n`);
    deps.stdout.write(yamlContent);
    if (!yamlContent.endsWith('\n')) deps.stdout.write('\n');
    if (generateWorkflow) {
      deps.stdout.write(`\n# would write ${path.resolve(cwd, WORKFLOW_FILE)}\n`);
      deps.stdout.write(WORKFLOW_TEMPLATE);
    }
    if (appendGitignore) {
      deps.stdout.write(
        `\n# would append the following lines to ${gitignorePath}:\n${GITIGNORE_LINES.map((l) => `#   ${l}`).join('\n')}\n`,
      );
    }
    return;
  }

  await deps.writeFile(yamlPath, yamlContent);
  deps.stdout.write(`created ${yamlPath}\n`);

  if (generateWorkflow) {
    const workflowPath = path.resolve(cwd, WORKFLOW_FILE);
    await deps.writeFile(workflowPath, WORKFLOW_TEMPLATE);
    deps.stdout.write(`created ${workflowPath}\n`);
  }

  if (appendGitignore) {
    const appended = await appendGitignoreLines(gitignorePath, deps.readFile, deps.writeFile);
    if (appended.length > 0) {
      deps.stdout.write(
        `appended ${appended.length} line(s) to ${gitignorePath}: ${appended.join(', ')}\n`,
      );
    } else {
      deps.stdout.write(`skipped ${gitignorePath} (already contains generated artifact ignores)\n`);
    }
  }

  writeNextSteps(deps.stdout);
}

export function renderConfigYaml(input: {
  owner: string;
  projectNumber: number;
  permissionModeBypass: boolean;
}): string {
  const { owner, projectNumber, permissionModeBypass } = input;
  const ownerLine = yaml.dump({ owner }).trimEnd();
  const projectLine = yaml.dump({ project_number: projectNumber }).trimEnd();
  const permissionModeLine = permissionModeBypass
    ? 'permission_mode: bypass  # agent が gh / git push を実行して PR を作るために必要'
    : '# permission_mode: auto  # agent に PR 作成まで任せるなら bypass を有効化する';

  return `# Philharmonic configuration
# 詳細は docs/guide/configuration.md を参照
#
# このファイルは \`philharmonic init\` が生成しています。コメントアウトされた行は
# default 値の参考表示で、有効化したい行のみ \`#\` を外してください (strict 検証なので
# 未知のキーやタイポはエラーになります)。

${ownerLine}
${projectLine}

# === Project / 候補選定 ===
# base_branch: main
# status_field: Status
# dispatch_statuses:
#   - Todo
# status_transitions:
#   in_progress: In Progress
#   in_review: In Review
#   failed: Failed
# agent_user_login: null

# === Runner (Claude Code) ===
${permissionModeLine}
# timeout_ms: 1800000           # 30 分
# kill_grace_period_ms: 5000
# workflow_file: .philharmonic/WORKFLOW.md
# agent:
#   max_concurrent_agents: 1
#   max_turns: 1
#   stall_timeout_ms: 300000

# === Workspace / クリーンアップ ===
# workspace_root: .philharmonic/worktrees
# clean_retention_days: 7

# === serve daemon ===
# polling:
#   interval_ms: 30000
# server:
#   port: 4000

# === GitHub 認証 ===
# Philharmonic は GitHub token を YAML に保存しない (誤 commit リスク回避)。
# token の取得元のみを config で選ぶ:
#   env  ... GITHUB_TOKEN / GH_TOKEN を直接読む
#   gh   ... \`gh auth token\` を起動時に呼ぶ (gh auth login 済みであること)
#   auto ... env を試し、無ければ gh に fallback (デフォルト)
# github:
#   token_source: auto

# === Safety ===
# bypass モードを serve で使う場合、長時間 --dangerously-skip-permissions が連続発火する。
# 明示的な opt-in としてここで true にするか、PHILHARMONIC_ALLOW_BYPASS_IN_SERVE=1 を env で設定する
# (どちらか片方が必要。両方未設定なら serve は起動を拒否する)。
# safety:
#   allow_bypass_in_serve: false

# === 観測 ===
# log_level: info

# === Lifecycle hooks (default はすべて空配列) ===
# hooks:
#   after_create:
#     - command: pnpm
#       args: [install, --frozen-lockfile]
#       timeout_ms: 120000
#       on_failure: fail
#   before_run: []
#   after_run: []
#   before_remove: []
`;
}

function validateGeneratedYaml(
  content: string,
  stderr: NodeJS.WritableStream,
  exit: (code: number) => never,
): void {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (error) {
    stderr.write(`internal: 生成 YAML を parse できませんでした: ${describeError(error)}\n`);
    exit(1);
    return;
  }
  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('\n');
    stderr.write(`internal: 生成 YAML が schema 違反です\n${issues}\n`);
    exit(1);
  }
}

async function isPhilharmonicSelfRepo(
  cwd: string,
  readFile: (filePath: string) => Promise<string>,
): Promise<boolean> {
  try {
    const raw = await readFile(path.resolve(cwd, 'package.json'));
    const parsed = JSON.parse(raw) as { name?: unknown };
    return parsed.name === PHILHARMONIC_PACKAGE_NAME;
  } catch {
    return false;
  }
}

async function detectOriginOwner(cwd: string, runGit: GitRunner): Promise<string | null> {
  try {
    const { stdout } = await runGit(['remote', 'get-url', 'origin'], { cwd });
    return parseGitHubOwner(stdout.trim());
  } catch {
    return null;
  }
}

export function parseGitHubOwner(remoteUrl: string): string | null {
  if (remoteUrl === '') return null;
  const ssh = /^git@github\.com:([^/]+)\/[^/]+(?:\.git)?$/.exec(remoteUrl);
  if (ssh) return ssh[1] ?? null;
  const sshScheme = /^ssh:\/\/git@github\.com\/([^/]+)\/[^/]+(?:\.git)?$/.exec(remoteUrl);
  if (sshScheme) return sshScheme[1] ?? null;
  const https = /^https?:\/\/github\.com\/([^/]+)\/[^/]+(?:\.git)?$/.exec(remoteUrl);
  if (https) return https[1] ?? null;
  return null;
}

async function appendGitignoreLines(
  gitignorePath: string,
  readFile: (filePath: string) => Promise<string>,
  writeFile: (filePath: string, content: string) => Promise<void>,
): Promise<readonly string[]> {
  const existing = await readFile(gitignorePath);
  const trimmedLines = existing.split(/\r?\n/).map((line) => line.trim());
  // `.philharmonic/` (broad ignore) が既にあるなら追記しない (重複防止)。
  // 過去の init で broad ignore を入れていたユーザの .gitignore を尊重する。
  const hasBroadIgnore = trimmedLines.some(
    (line) => line === '.philharmonic/' || line === '.philharmonic',
  );
  if (hasBroadIgnore) return [];

  const toAdd = GITIGNORE_LINES.filter((entry) => !trimmedLines.includes(entry));
  if (toAdd.length === 0) return [];

  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const appended = toAdd.join('\n');
  await writeFile(gitignorePath, `${existing}${sep}${appended}\n`);
  return toAdd;
}

async function confirm(prompt: Prompter, message: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await prompt(`${message} ${hint}: `)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  return defaultYes;
}

function writeNextSteps(stdout: NodeJS.WritableStream): void {
  stdout.write('\nnext steps:\n');
  stdout.write(
    '  1. GitHub 認証を整える: `gh auth login` 済みなら追加設定不要 (default は github.token_source: auto)\n',
  );
  stdout.write('     CI 等で env を使う場合は `export GITHUB_TOKEN=<your fine-grained PAT>`\n');
  stdout.write('  2. philharmonic projects list --owner ... --project ...\n');
  stdout.write('  3. philharmonic serve\n');
}

function parseProjectNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('--project は正の整数で指定してください');
  }
  return parsed;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
