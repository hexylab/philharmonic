/**
 * Runner subprocess に渡してよい環境変数の allowlist。
 *
 * 方針: deny list ではすぐに穴が空く (新しい secret 形式の env がリリースされる度に追記が必要)
 * ため、Runner subprocess へ渡す env は **明示的に許可した key のみ** に絞る。
 * 一般的な secret は env 名を機械的に判別できない (例: `MY_PROJECT_TOKEN`) ため、
 * allowlist 方式で「既知の安全なものだけ通す」のが事故防止上もっとも堅牢。
 */
export const ALLOWED_ENV_KEYS: readonly string[] = [
  // 基本
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  // タイムゾーン / ロケール
  'TZ',
  'LANG',
  'LANGUAGE',
  // 端末
  'TERM',
  'COLUMNS',
  'LINES',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  // 一時ディレクトリ
  'TMPDIR',
  'TMP',
  'TEMP',
  // GitHub 認証 (ADR-0005)
  // agent が `gh` / `git push` で利用するため allowlist で透過する。
  // `GH_ENTERPRISE_TOKEN` / `OCTOKIT_*` は引き続き allowlist 外 (orchestrator 用途のみ)。
  'GITHUB_TOKEN',
  'GH_TOKEN',
];

/**
 * 環境変数の prefix allowlist。`<prefix>` で始まる key はすべて通す。
 *
 * - `LC_*`: ロケール詳細 (`LC_ALL` / `LC_CTYPE` ...)
 * - `XDG_*`: Linux user dirs (`XDG_CONFIG_HOME` 等で Claude Code の設定にも影響)
 * - `NODE_*`: Node.js 自身が見るオプション群 (`NODE_PATH` / `NODE_OPTIONS` 等)
 * - `ANTHROPIC_*` / `CLAUDE_*`: Claude Code が auth / 設定で参照する env
 * - `PHILHARMONIC_*`: 自分自身の env (debug 用)
 */
export const ALLOWED_ENV_PREFIXES: readonly string[] = [
  'LC_',
  'XDG_',
  'NODE_',
  'ANTHROPIC_',
  'CLAUDE_',
  'PHILHARMONIC_',
];

export function buildRunnerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!isAllowed(key)) continue;
    out[key] = value;
  }
  return out;
}

function isAllowed(key: string): boolean {
  if (ALLOWED_ENV_KEYS.includes(key)) return true;
  for (const prefix of ALLOWED_ENV_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}
