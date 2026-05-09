# Workspace Manager

## 概要

GitHub Projects v2 や Claude Code Runner と分離可能な、git worktree を中核とした **workspace manager** を提供する。1 task = 1 branch = 1 worktree を原則とし、workspace root 配下に隔離 worktree を作成・再利用・削除する責務を負う。本 spec は実装着手前の設計仕様であり、ADR-0001 および orchestration-mvp.md と整合させたうえで、ローカル git 操作の安全な抽象化を定義する。

## 関連 Issue

- #5 — git worktree workspace manager を実装する
- 設計前提: [ADR-0001 初期アーキテクチャ](../adr/0001-initial-architecture.md)
- 上位フロー: [orchestration-mvp.md](./orchestration-mvp.md)

## 用語と登場アクター

| 用語                  | 意味                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| **Workspace**         | 1 タスクに対応する隔離 worktree。`workspace root` 配下のサブディレクトリ                   |
| **Workspace Root**    | すべての workspace の親ディレクトリ。設定で指定し、manager はこの配下にのみ書き込む        |
| **Task Key**          | 1 つの workspace を識別する文字列 (例: `issue-5`)。ディレクトリ名にもなる                  |
| **Branch Name**       | worktree が checkout する git ブランチ名。`feature/<番号>-<slug>` 等を sanitize して使う   |
| **Workspace Manager** | workspace のライフサイクル (create / reuse / cleanup) と git worktree 操作を司るモジュール |

## 要件

- workspace root は **設定で指定する** (`.philharmonic/worktrees` 等のパスは manager がハードコードしない)
- workspace path は **必ず workspace root 配下** に収まる。path traversal (`..` / 絶対パス / `foo/../../bar` 等) は拒否する
- branch name は git refname のルールに従って **sanitize** する。空文字になる場合のフォールバック値を持つ
- 1 task = 1 branch = 1 worktree とし、task key と branch name の組み合わせで workspace を識別する
- 既存 worktree が見つかった場合は **再利用可能** にする。再利用時は `reused: true` で示す
- destructive cleanup (`git worktree remove --force` 相当 + ローカルブランチ削除) は **明示的な API 呼び出し** でのみ行う
- `git` コマンドの実行結果は **structured error** (`GitCommandError`) として扱い、引数 / exit code / stderr を保持する
- workspace root と現在の repo root の整合性は manager 自身では検証しない (上位レイヤの責務)

## 二層構造との関係 (orchestration-mvp との整合)

orchestration-mvp.md は「同名 worktree / 同名ブランチが存在する場合 abort → Failure」を要求している。本 manager はそれと矛盾せず、より低レイヤとして以下のような **API の選択肢** を提供する。

- `reuse: true` (default): 既存 worktree がそのまま使える場合は再利用する
- `reuse: false`: 既存があれば `WorkspaceConflictError` で abort する

orchestrator は MVP では `reuse: false` を選ぶことで、spec が要求する「既存衝突は Failure」の挙動を実現できる。一方で別ユースケース (再開・再試行) では `reuse: true` を使える、という二層構造とする。

## 非機能要件

- **性能**: 1 タスクあたりの create / cleanup は git 操作 1〜3 回で完結する。本 manager 自体はネットワーク I/O を行わない (fetch は呼び出し側責務)
- **可用性**: 単一プロセスでの逐次操作のみを想定。複数プロセスからの同時書き込みは MVP out-of-scope
- **セキュリティ**:
  - git コマンドは **shell を経由しない API** (`node:child_process` の `execFile`) で起動し、引数を配列で渡す
  - workspace root 外への書き込みは構造的に発生しないように `path.resolve` + `path.relative` で検査する
  - branch name の sanitize は許可リストではなく、git の禁止ルールを網羅した拒否ロジックで行う
- **アクセシビリティ**: 該当しない (内部モジュール)

## データモデル

### `WorkspaceManagerOptions`

| キー            | 型          | 必須 | 説明                                                                |
| --------------- | ----------- | ---- | ------------------------------------------------------------------- |
| `repoRoot`      | `string`    | yes  | `git` を実行する基準ディレクトリ (主リポジトリの絶対パス)           |
| `workspaceRoot` | `string`    | yes  | worktree 親ディレクトリ。絶対パスでない場合は `repoRoot` 基準で解決 |
| `runGit`        | `GitRunner` | no   | git 実行関数。テスト時のモック注入用。default は `execFile` ベース  |

### `Workspace`

| キー      | 型        | 説明                                                      |
| --------- | --------- | --------------------------------------------------------- |
| `taskKey` | `string`  | 入力 task key (sanitize 後)                               |
| `path`    | `string`  | worktree の絶対パス (workspace root 配下)                 |
| `branch`  | `string`  | sanitize 後の branch name                                 |
| `reused`  | `boolean` | 既存 worktree を再利用した場合 `true`、新規作成は `false` |

### `CreateWorkspaceInput`

| キー      | 型        | 必須 | 説明                                                                   |
| --------- | --------- | ---- | ---------------------------------------------------------------------- |
| `taskKey` | `string`  | yes  | workspace 識別子。`/` `..` 絶対パス等を含む値は拒否                    |
| `branch`  | `string`  | yes  | 期待 branch name (raw 可)。manager 内で sanitize する                  |
| `baseRef` | `string`  | yes  | worktree 作成時の起点 ref (例: `origin/main`)                          |
| `reuse`   | `boolean` | no   | 既存 worktree を再利用するか。default `true`。`false` だと衝突時 abort |

### `CleanupWorkspaceInput`

| キー           | 型        | 必須 | 説明                                                    |
| -------------- | --------- | ---- | ------------------------------------------------------- |
| `taskKey`      | `string`  | yes  | 削除対象の task key                                     |
| `branch`       | `string`  | no   | `deleteBranch: true` のときに削除するローカルブランチ名 |
| `deleteBranch` | `boolean` | no   | ローカルブランチも削除するか。default `false`           |

### Path Resolution

```
workspaceRootAbs = path.resolve(repoRoot, workspaceRoot)
worktreePathAbs  = path.resolve(workspaceRootAbs, sanitizedTaskKey)
```

`worktreePathAbs` が workspace root 配下に収まっているかを `path.relative(workspaceRootAbs, worktreePathAbs)` の結果で検査する。`..` から始まる、`path.isAbsolute()` が true、または `''` (= workspace root 自身) の場合は **`PathTraversalError`** を投げる。

## API / インターフェース

### Public API (`src/workspace/index.ts`)

```ts
export type WorkspaceManager = {
  resolveWorkspacePath(taskKey: string): string;
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  cleanupWorkspace(input: CleanupWorkspaceInput): Promise<void>;
  /**
   * lifecycle hook を発火する。`after_create` / `before_remove` は manager が
   * 自動で発火するため、呼び出し側 (orchestrator) は通常 `before_run` /
   * `after_run` のみ呼ぶ。詳細は「Lifecycle Hooks (#26)」を参照
   */
  runHooks(event: HookEvent, context: HookContext): Promise<void>;
};

export function createWorkspaceManager(options: WorkspaceManagerOptions): WorkspaceManager;
```

### Lifecycle

| フェーズ | 動作                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 解決     | `resolveWorkspacePath(taskKey)` は task key の検査と path traversal 検査のみを行い、ファイルシステムには触れない                                                                                                                         |
| 作成     | `createWorkspace` は (1) workspace root を `mkdir -p`、(2) `git worktree list --porcelain` で既存 worktree を確認、(3) 既存があり再利用可なら早期 return、(4) なければ `worktree add`、(5) **新規作成時のみ `after_create` hook を発火** |
| 再利用   | `reuse: true` のとき、同一 path に既存 worktree があり branch が一致すれば `reused=true` で即返す。path 一致 / branch 不一致なら `WorkspaceConflictError`。**`reused=true` のときは `after_create` を発火しない**                        |
| 競合     | `reuse: false` で同一 path に worktree が存在する、または同名ローカルブランチが存在するときは `WorkspaceConflictError` を投げる                                                                                                          |
| 削除     | `cleanupWorkspace` は (1) **`before_remove` hook を発火**、(2) `git worktree remove --force <path>` を実行し、`deleteBranch: true` のとき `git branch -D <branch>` も実行する。冪等性のため、未登録 worktree は no-op                    |

`reuse: true` でも、worktree が登録されていない一方で同名のローカルブランチだけが既存の場合、`git worktree add -b <branch>` が `branch already exists` で失敗するため `GitCommandError` がそのまま伝播する。orchestrator 側はこのケースを `philharmonic clean` 等で先に解消するか、`reuse: false` を選んで `WorkspaceConflictError` の `branch_already_exists` で扱う。

### Branch Name Sanitization

git の refname ルール (`git check-ref-format` 互換) に準拠して入力を整形する。

- 制御文字 (U+0000–U+001F, U+007F)、` `, `~`, `^`, `:`, `?`, `*`, `[`, `\\` を **削除**
- `..`, `@{`, 連続する `/`, `/.` を `-` に置換
- 末尾の `.lock` を削除
- 先頭・末尾の `/`, `.`, `-` を trim
- 結果が空、または `@` 単独になった場合は `task` をフォールバック値として返す

### `runGit` Contract

```ts
export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;
```

- 失敗時 (exit code != 0) は **`GitCommandError`** を throw する
- `args` は配列で渡す。shell を経由しない
- default 実装は `node:child_process` の `execFile` を Promise でラップする

## Lifecycle Hooks (#26)

Symphony の workspace hook 機構と同等のものを提供する。`philharmonic.yaml` の `hooks` セクションで指定された任意の shell コマンドを workspace ライフサイクルの各イベントで実行できる。

### Hook イベント

| イベント        | 発火タイミング                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `after_create`  | `createWorkspace` で **新規 worktree が作成された直後** (`reused=false` のときのみ)。reuse 時は発火しない             |
| `before_run`    | orchestrator が Claude Code runner を起動する **直前**                                                                |
| `after_run`     | runner が終了した **直後**。runner status (`success` / `timeout` / `stalled` / `failed`) に**かかわらず**毎回発火する |
| `before_remove` | `cleanupWorkspace` で `git worktree remove` を呼ぶ **直前**。worktree が登録されていない (no-op) 場合は発火しない     |

### 実行モデル

- 各 event の hook は **配列順に逐次実行**される (並列実行はしない)
- shell を経由せず引数を配列で `execFile` 相当で起動し、shell injection を避ける
- `cwd` は workspace path (worktree root)。すべての event で同じ
- 環境変数は親プロセスの env に以下を merge して渡す:
  - `PHILHARMONIC_EVENT` — hook event 名 (`after_create` 等)
  - `PHILHARMONIC_TASK_KEY` — task key (例: `issue-26`)
  - `PHILHARMONIC_BRANCH` — sanitize 後の branch 名 (detached worktree の `before_remove` では `(detached)`)
  - `PHILHARMONIC_WORKSPACE_PATH` — worktree の絶対パス
  - `PHILHARMONIC_REPO_ROOT` — 主リポジトリの絶対パス
  - `PHILHARMONIC_BASE_REF` — `createWorkspace` で渡した base ref (例: `origin/main`)。`before_remove` では未設定の場合あり
  - `PHILHARMONIC_ISSUE_NUMBER` — orchestrator 経由の発火時のみ
  - `PHILHARMONIC_RUN_ID` — orchestrator 経由の発火時のみ
  - `PHILHARMONIC_RUN_STATUS` — `after_run` 時のみ。runner status をそのまま入れる

### Hook 設定

```yaml
hooks:
  after_create:
    - command: pnpm
      args: [install, --frozen-lockfile]
      timeout_ms: 120000
      on_failure: fail
  before_run: []
  after_run: []
  before_remove:
    - command: ./scripts/cleanup.sh
      args: []
      timeout_ms: 10000
      on_failure: continue
```

| キー         | 型                     | 必須 | デフォルト | 説明                                                                              |
| ------------ | ---------------------- | ---- | ---------- | --------------------------------------------------------------------------------- |
| `command`    | `string` (空文字不可)  | yes  | -          | 実行コマンド (PATH 解決される)                                                    |
| `args`       | `string[]`             | no   | `[]`       | 引数。配列のまま渡る                                                              |
| `timeout_ms` | `integer (>= 1)`       | no   | `60000`    | 個別 hook の timeout。超過したら SIGTERM → grace period 後 SIGKILL                |
| `on_failure` | `'continue' \| 'fail'` | no   | `fail`     | 非ゼロ exit / spawn error / timeout のときの挙動 (`fail` で `HookExecutionError`) |

### 失敗時の挙動

- `on_failure: continue` のとき、hook の失敗は warn ログ 1 行に留めて以降の hook を続行する。manager / orchestrator は throw しない
- `on_failure: fail` のとき:
  - `after_create` — `HookExecutionError` を throw する。worktree は作成済みのため、上位 (orchestrator) は `markFailed` で `before_remove` 経由のクリーンアップを行う
  - `before_run` / `after_run` — `HookExecutionError` を throw し、orchestrator は `FailureReason='hook_failed'` として markFailed する
  - **`before_remove` だけは特殊**: `on_failure: fail` でも cleanup を停止させない (孤児 worktree のほうが運用上有害)。warn ログを残し、後続の `git worktree remove` を続行する

### Public API (hook 関連)

```ts
export type HookEvent = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

export type HookConfig = {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  onFailure: 'continue' | 'fail';
};

export type HookConfigMap = Record<HookEvent, readonly HookConfig[]>;

export type HookContext = {
  taskKey: string;
  branch: string;
  workspacePath: string;
  baseRef?: string;
  extraEnv?: Record<string, string>;
};

export class HookExecutionError extends Error {
  /* event / command / exitCode / stderr / stdout */
}
export class HookTimeoutError extends Error {
  /* event / command / timeoutMs */
}
```

`WorkspaceManagerOptions` に `hooks?: HookConfigMap` と `hookExecutor?: HookExecutor` (テスト用) を追加。`hooks` 未指定時は全 event 空配列扱い。

## エラーハンドリング

| エラー                     | 発生条件                                                                      | 扱い方針                                                                             |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PathTraversalError`       | `taskKey` を resolve すると workspace root 外、または root 自身に解決される   | throw。呼び出し側は task key を見直す                                                |
| `InvalidTaskKeyError`      | `taskKey` が空、または絶対パス、または `..` / `\\` などの禁止セグメントを含む | throw。sanitize 不能と判断する                                                       |
| `InvalidBranchNameError`   | sanitize 後も git refname ルールに違反する (理論上は発生しない安全網)         | throw                                                                                |
| `WorkspaceConflictError`   | `reuse: false` で同一 path / 同名ブランチが既存、または再利用不能             | throw。orchestrator 側で `Failure` フェーズに遷移する                                |
| `GitCommandError`          | `git` の exit code が 0 以外                                                  | throw。`args` / `exitCode` / `stderr` / `stdout` を保持し、上位で構造化ログに残せる  |
| `HookExecutionError`       | hook の非ゼロ exit / spawn error。`on_failure: 'fail'` のときのみ throw       | `before_remove` ではログのみで cleanup 続行、それ以外は throw                        |
| `HookTimeoutError`         | hook が `timeout_ms` を超えた。`on_failure: 'fail'` のときのみ throw          | 同上                                                                                 |
| 既存 worktree の path 不在 | `git worktree list --porcelain` には載っているがディレクトリは存在しない      | `git worktree prune` を試みず、`WorkspaceConflictError` で抜ける (運用 clean を要求) |

## 外部依存

- **git** — 2.40 以上推奨。`worktree add` / `worktree list --porcelain` / `worktree remove --force` / `branch -D` / `show-ref` を使用
- **Node.js 標準ライブラリ** — `node:child_process` (`execFile`)、`node:path`、`node:fs/promises`
- 外部ネットワーク I/O は本モジュールの責務外 (`git fetch` 等は呼び出し側で実施)

## オープンクエスチョン

- 既存 worktree が dirty (未コミット変更あり) の場合の再利用ポリシー — MVP では再利用許可とし、Runner 側に判断を委ねる予定だが、後続 Issue で再検討する
- `cleanupWorkspace` の retention (失敗 worktree を残すか) は orchestrator が制御するため、本 manager では引数で都度指定する。一括 cleanup コマンド (`philharmonic clean`) の仕様は別 Issue
- 並列タスク実行時の lock / 競合検知 — 単一プロセス前提のため未対応。後続で必要に応じて検討

## MVP でやらないこと

- ネットワーク I/O (`git fetch` / `git push`) は本モジュールの責務外
- 並列実行 / プロセス間 lock
- worktree の自動 prune (`git worktree prune` の自動呼び出し)
- 設定ファイル (`philharmonic.yaml`) からの読み込み — manager は options 引数のみを見る
