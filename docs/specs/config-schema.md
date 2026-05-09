# philharmonic.yaml Config Schema

## 概要

Philharmonic の orchestration loop が必要とする設定値を `philharmonic.yaml` という単一の YAML ファイルに集約し、`src/config/` モジュールから zod スキーマ経由で読み込む。本 spec は実装に先行する設計仕様であり、ADR-0001 で確定した「YAML + zod (`z.infer`)」「CLI フラグでオーバーライド可能」という方針を、フィールド粒度・デフォルト値・エラーハンドリングまで具体化する。

## 関連 Issue

- #15 — philharmonic.yaml の zod スキーマと読み込み層を実装する
- 設計前提: [ADR-0001 初期アーキテクチャ](../adr/0001-initial-architecture.md)
- 関連 spec: [orchestration-mvp.md](./orchestration-mvp.md), [claude-runner.md](./claude-runner.md), [workspace-manager.md](./workspace-manager.md)

## 用語と登場アクター

| 用語                    | 意味                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| **Config File**         | プロジェクト直下の `philharmonic.yaml` (既定)。CLI 引数で別パスを指定可能      |
| **Raw Config**          | YAML をパースした直後の snake_case な JS オブジェクト                          |
| **Config**              | zod の transform を経て camelCase に正規化された TypeScript の設定オブジェクト |
| **`loadConfig(path?)`** | 設定ファイルを読み込み、検証済みの `Config` を返す関数                         |

## 要件

- `loadConfig(path?: string): Config` を `src/config/index.ts` から export する
- `path` 省略時は `path.resolve(process.cwd(), 'philharmonic.yaml')` を読み込む。`~` 展開等は行わない
- YAML パースは shell に依存せず、`js-yaml` の `load` を使用する
- スキーマは zod で定義し、TypeScript 型は `z.infer` で導出する (ADR-0001)
- 未指定値はデフォルトを補完する (下表参照)
- 設定ファイルが存在しない / YAML として不正 / 型違反のいずれの場合も、ユーザが原因を特定できる構造化エラー (ファイルパス・該当フィールドパス・期待値) を throw する
- CLI フラグでの override を可能にするため、`Config` は plain object で返す (override 合成は CLI レイヤの責務)
- bypass permission mode は config schema として受理可能だが、Runner 側 (`src/runner/`) が現時点で未対応な点はレイヤ境界の責務として割り切る

## 非機能要件

- **性能**: ファイル I/O とパースのみ。1 回 / プロセス起動。性能要件なし
- **可用性**: 単一プロセス・同期 (実装は async) で 1 回読み込むだけ。並列読み込み考慮なし
- **セキュリティ**:
  - `js-yaml` は `load` (デフォルトの `DEFAULT_SCHEMA`) を使う。`!!js/function` 等を含む `LOAD_FULL_SCHEMA` 系は使用しない
  - 設定値に GitHub PAT を含めない (token は環境変数のみ)。token 用フィールドはスキーマに定義しない
- **アクセシビリティ**: 該当しない

## データモデル

### YAML 形式 (snake_case)

| キー                   | 型                                       | 必須 | デフォルト                | 説明                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------- | ---- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`                | `string` (空文字不可)                    | yes  | -                         | Project owner の GitHub login                                                                                                                                                                            |
| `project_number`       | `integer (>= 1)`                         | yes  | -                         | GitHub Projects v2 の project number                                                                                                                                                                     |
| `base_branch`          | `string` (空文字不可)                    | no   | `main`                    | PR の base ブランチ。worktree 作成の起点となる ref のラベルとしても使う                                                                                                                                  |
| `status_field`         | `string` (空文字不可)                    | no   | `Status`                  | Project 上の Status を保持する単一選択フィールド名                                                                                                                                                       |
| `agent_user_login`     | `string \| null`                         | no   | `null`                    | Issue assignee がこの login 一致なら処理対象。`null` のときは `unassigned` のみが対象                                                                                                                    |
| `permission_mode`      | `'auto' \| 'bypass'`                     | no   | `auto`                    | Claude Code の permission mode (ADR-0001 のマッピング)                                                                                                                                                   |
| `timeout_ms`           | `integer (>= 1)`                         | no   | `1800000` (30 分)         | Runner の subprocess timeout                                                                                                                                                                             |
| `kill_grace_period_ms` | `integer (>= 0)`                         | no   | `5000` (5 秒)             | timeout 後 SIGTERM → SIGKILL までの猶予                                                                                                                                                                  |
| `workspace_root`       | `string` (空文字不可)                    | no   | `.philharmonic/worktrees` | git worktree の親ディレクトリ。相対パスは Workspace Manager が repo root 基準で解決する                                                                                                                  |
| `dispatch_statuses`    | `string[]` (要素は空文字不可、長さ >= 1) | no   | `['Todo']`                | Candidate Selection で dispatch 対象とする Status option 名の集合。`status_field` (どの field を Status として読むか) と直交し、本キーは「その field のどの option を candidate として扱うか」を指定する |

未知のキーは zod の `strict()` で**拒否**する (typo を早期発見するため)。

### 最小サンプル

```yaml
owner: hexylab
project_number: 1
```

### フルサンプル

```yaml
owner: hexylab
project_number: 1
base_branch: main
status_field: Status
agent_user_login: philharmonic-bot
permission_mode: auto
timeout_ms: 1800000
kill_grace_period_ms: 5000
workspace_root: .philharmonic/worktrees
dispatch_statuses:
  - Ready for Agent
  - Todo
```

### dispatch_statuses サンプル (#38)

GitHub Projects v2 の Status option 名はプロジェクトごとに自由に定義できる。
未指定時は MVP の挙動互換のため `['Todo']` が補完される。複数指定した場合は配列の前から順に判定するわけではなく、`Status in dispatch_statuses` の集合判定として扱う (Project board の上から順に最初に一致した item が選ばれる)。

```yaml
owner: hexylab
project_number: 1
status_field: Status
dispatch_statuses:
  - Ready for Agent
  - Todo
```

上記設定では `Status` field の option `Ready for Agent` または `Todo` の open Issue だけが dispatch 候補になる (`In Progress` / `Done` 等は対象外)。

### TypeScript 表現 (camelCase)

`z.infer<typeof configSchema>` から導出される `Config` 型は camelCase に正規化される。これは既存モジュール (`src/runner/`, `src/workspace/`, `src/projects/`) が camelCase を採用しているのと整合させるため。

```ts
type Config = {
  owner: string;
  projectNumber: number;
  baseBranch: string;
  statusField: string;
  agentUserLogin: string | null;
  permissionMode: 'auto' | 'bypass';
  timeoutMs: number;
  killGracePeriodMs: number;
  workspaceRoot: string;
  dispatchStatuses: string[];
};
```

snake_case → camelCase の変換は zod の `.transform()` で 1 度だけ行う。

## デフォルト値の根拠

| キー                   | デフォルト                | 根拠                                                                                                                                            |
| ---------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `base_branch`          | `main`                    | orchestration-mvp.md「PR Body 構成」と「Workspace ベースは `origin/main`」が `main` 前提                                                        |
| `status_field`         | `Status`                  | orchestration-mvp.md「Project Item Status」が field 名 `Status` を前提                                                                          |
| `agent_user_login`     | `null`                    | orchestration-mvp.md「Candidate Selection Rule」で「assignee 未指定 もしくは `agent_user_login` 一致」を要求                                    |
| `permission_mode`      | `auto`                    | ADR-0001「デフォルトは後続 Issue で決定」を本 Issue で `auto` に確定。`bypass` はホスト全体への副作用リスクを孕むため、明示指定でのみ有効化する |
| `timeout_ms`           | `1800000` (30 分)         | claude-runner.md / orchestration-mvp.md ともに「デフォルト 30 分」                                                                              |
| `kill_grace_period_ms` | `5000` (5 秒)             | claude-runner.md「SIGTERM → 5 秒後 SIGKILL」                                                                                                    |
| `workspace_root`       | `.philharmonic/worktrees` | orchestration-mvp.md「Workspace パス」が `<repo-root>/.philharmonic/worktrees/issue-<番号>/`                                                    |
| `dispatch_statuses`    | `['Todo']`                | orchestration-mvp.md「Candidate Selection Rule」の MVP 仕様 (`Status = Todo` のみ dispatch 候補) との後方互換のため。詳細は #38                 |

## API / インターフェース

### Public API (`src/config/index.ts`)

```ts
export function loadConfig(path?: string): Promise<Config>;
export const configSchema: z.ZodTypeAny;
export const DEFAULT_CONFIG_FILE = 'philharmonic.yaml';
export type Config;
export class ConfigFileNotFoundError extends Error {}
export class ConfigParseError extends Error {}
export class ConfigValidationError extends Error {}
export function formatConfigError(error: unknown): string;
```

### `loadConfig` の動作

1. `path ?? path.resolve(process.cwd(), DEFAULT_CONFIG_FILE)` を解決対象とする
2. `fs.readFile` で読み込む
   - `ENOENT` → `ConfigFileNotFoundError` (path を保持)
   - その他 I/O エラーは原因をそのまま伝播させない方針で wrap して throw する
3. `js-yaml` の `load` でパース。`YAMLException` を catch して `ConfigParseError` (path / line / reason) に変換する
4. zod の `safeParse` で検証。`success: false` のとき `ConfigValidationError` (path / 各 issue の `path` と `message` を整形) を throw する
5. 検証成功時は transform 済みの `Config` を返す

### Override の合成 (本 Issue では実装しない)

CLI フラグでの override は将来 `philharmonic run` 等のコマンドで実装する。本 Issue ではその準備として、`Config` を plain object で返し、上位レイヤで `{ ...config, ...overrides }` のような合成を可能にしておく。

## エラーハンドリング

| エラー                         | 発生条件                                    | 扱い方針                                                                                                              |
| ------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ConfigFileNotFoundError`      | 指定パスのファイルが存在しない (ENOENT)     | throw。message にパス。CLI 側で「設定ファイルが見つかりません: <path>」を出して exit 1                                |
| `ConfigParseError`             | YAML として parse 不能 (`YAMLException`)    | throw。message にパス + 行番号 + reason。CLI 側で stderr に出して exit 1                                              |
| `ConfigValidationError`        | zod の型違反 / 必須欠落 / 未知キー (strict) | throw。message にパス + 各 issue の `path.join('.')` と `message` を改行区切りで列挙。CLI 側で stderr に出して exit 1 |
| その他 I/O エラー (権限不足等) | `fs.readFile` の ENOENT 以外                | 原因をそのまま伝播させず Error にラップして throw                                                                     |

`formatConfigError(error: unknown)` は上記 3 種を unknown から判別し、ユーザ向けの整形済み文字列を返す。CLI 側はこの 1 関数だけを呼べば十分なように設計する。

## 外部依存

- **`js-yaml` 4.x** — YAML パーサ。`DEFAULT_SCHEMA` のみ使用 (任意関数実行を含む `LOAD_FULL_SCHEMA` は使用しない)
- **`zod` 4.x** — 既存依存。schema 定義 / transform / safeParse
- **`node:fs/promises`** — `readFile`
- **`node:path`** — パス解決

## オープンクエスチョン

- override の合成方針 (deep merge か shallow merge か、CLI 引数の命名) — 後続 Issue で `philharmonic run` を実装する際に確定する
- 設定ファイル不在時にデフォルトのみで起動を許すか — MVP では「不在ならエラー」を採用するが、将来の検討余地あり
- リポジトリごとに `.philharmonic/config.yaml` のような alternate location を許可するか — 将来検討

## MVP でやらないこと

- override 合成 (CLI フラグからの上書き) の実装
- 環境変数からの設定読み込み (`PHIL_*` のような prefix)
- 複数設定ファイルのマージ (global / repo-local)
- token 系フィールドのスキーマ化 (token は環境変数のみ)
