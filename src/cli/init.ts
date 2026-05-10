import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { Command, InvalidArgumentError } from 'commander';
import yaml from 'js-yaml';

import { configSchema } from '../config/schema.js';
import { defaultGitRunner, type GitRunner } from '../workspace/index.js';

const PHILHARMONIC_YAML_FILE = 'philharmonic.yaml';
const WORKFLOW_FILE = 'WORKFLOW.md';
const GITIGNORE_FILE = '.gitignore';
const GITIGNORE_LINE = '.philharmonic/';
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

const DEFAULT_DEPS: Required<InitCommandDeps> = {
  cwd: () => process.cwd(),
  runGit: defaultGitRunner,
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  writeFile: (filePath, content) => fs.writeFile(filePath, content, 'utf8'),
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
    .description('対象リポジトリで Philharmonic を始めるための philharmonic.yaml を scaffold する')
    .option(
      '--owner <login>',
      'Project owner の GitHub login (省略時は origin remote から auto-detect)',
    )
    .option('--project <number>', 'Project number (整数、必須)', parseProjectNumber)
    .option('--yes', '対話プロンプトをすべてスキップする (非対話モード)', false)
    .option('--force', '既存の philharmonic.yaml を上書きする', false)
    .option('--dry-run', 'ファイルを書き込まず stdout に内容を出すだけ', false)
    .option('--no-workflow', 'WORKFLOW.md の scaffold をスキップする (対話プロンプトを抑止)')
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
        'permission_mode を bypass にしますか? (ADR-0005 により agent 委譲には実用上必須)',
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
    appendGitignore = await confirm(
      deps.prompt,
      `${GITIGNORE_LINE} を ${GITIGNORE_FILE} に追記しますか?`,
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
      deps.stdout.write(`\n# would append "${GITIGNORE_LINE}" to ${gitignorePath}\n`);
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
    const updated = await appendGitignoreLine(gitignorePath, deps.readFile, deps.writeFile);
    if (updated) {
      deps.stdout.write(`appended "${GITIGNORE_LINE}" to ${gitignorePath}\n`);
    } else {
      deps.stdout.write(`skipped ${gitignorePath} (already contains "${GITIGNORE_LINE}")\n`);
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
    ? 'permission_mode: bypass  # ADR-0005: agent (gh / git push) を機能させるため bypass を採用'
    : '# permission_mode: auto  # ADR-0005: agent 委譲を機能させるには bypass が実用上必須';

  return `# Philharmonic configuration
# 詳細は docs/guide/configuration.md を参照
# 全フィールドの真実は docs/specs/config-schema.md
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
# workflow_file: WORKFLOW.md
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

async function appendGitignoreLine(
  gitignorePath: string,
  readFile: (filePath: string) => Promise<string>,
  writeFile: (filePath: string, content: string) => Promise<void>,
): Promise<boolean> {
  const existing = await readFile(gitignorePath);
  const lines = existing.split(/\r?\n/);
  const alreadyHas = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === GITIGNORE_LINE || trimmed === '.philharmonic';
  });
  if (alreadyHas) return false;
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await writeFile(gitignorePath, `${existing}${sep}${GITIGNORE_LINE}\n`);
  return true;
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
  stdout.write('  1. export GITHUB_TOKEN=<your fine-grained PAT>\n');
  stdout.write('  2. philharmonic projects list   # 候補となる Issue を確認\n');
  stdout.write('  3. philharmonic serve           # 常駐デーモンを起動\n');
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
