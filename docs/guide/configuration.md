# Configuration

Philharmonic の挙動は次の 3 つを通じてカスタマイズします。

1. `philharmonic.yaml` — Orchestrator / Runner / Workspace / serve daemon の設定値
2. `WORKFLOW.md` — Claude Code に渡す prompt の上位レイヤ (Liquid テンプレート)
3. Lifecycle hooks — workspace の各イベントで任意の shell コマンドを実行する

本ドキュメントは利用者視点で「どこをいじると何が変わるか」を扱います。フィールドの全リファレンス (型 / 下限 / strict 検証の挙動など) は [`docs/specs/config-schema.md`](../specs/config-schema.md) を参照してください。

## `philharmonic.yaml` の場所と最小構成

- 既定では Philharmonic を実行した cwd の `philharmonic.yaml` を読みます (`philharmonic run` / `philharmonic serve` / `philharmonic clean` 共通)
- `--config <path>` で別パスを指定できます
- `~` 展開などは行いません (絶対パスか cwd 相対で渡す)

最小構成:

```yaml
owner: your-github-login
project_number: 1
```

これ以外のキーはすべて省略可で、内側のデフォルト値が補完されます。

## よく触るキーと使いどころ

### Project / 候補選定

| キー                | 既定     | 何が変わるか                                                                                                                            |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`             | (必須)   | Project owner の GitHub login (user または org)                                                                                         |
| `project_number`    | (必須)   | Project URL 末尾の整数                                                                                                                  |
| `status_field`      | `Status` | Project 上の単一選択フィールド名。Status を別フィールド名で運用しているならここを変える                                                 |
| `dispatch_statuses` | `[Todo]` | dispatch 候補とする Status option 名の配列。`[Ready for Agent, Todo]` のように複数指定可。`status_field` のどの option を拾うか直交設定 |
| `agent_user_login`  | `null`   | `null` のとき unassigned のみ拾う。bot login (例: `philharmonic-bot`) を指定するとその assignee の Issue だけ拾う                       |
| `base_branch`       | `main`   | PR の base ブランチ。worktree もこの ref から派生する                                                                                   |

### Runner (Claude Code) の挙動

| キー                     | 既定              | 何が変わるか                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission_mode`        | `auto`            | `auto` = `--permission-mode acceptEdits` (worktree 内編集のみ自動承認)。`bypass` = `--dangerously-skip-permissions` (**worktree 外、ホスト全体への副作用が起き得る**)。**ADR-0005 で agent 委譲型に切り替えたため、`auto` では Bash tool (`gh` / `git push`) を agent が呼べず、Status 遷移 / PR 作成が失敗します。実用上は `bypass` を選んでください** |
| `timeout_ms`             | `1800000` (30 分) | Runner subprocess の timeout                                                                                                                                                                                                                                                                                                                            |
| `kill_grace_period_ms`   | `5000` (5 秒)     | timeout 後 SIGTERM → SIGKILL までの猶予                                                                                                                                                                                                                                                                                                                 |
| `agent.max_turns`        | `1`               | `1` で 1 セッション完結 (従来動作)。`>= 2` で `error_max_turns` で打ち切られたとき `--resume` で次ターンへ進む                                                                                                                                                                                                                                          |
| `agent.stall_timeout_ms` | `300000` (5 分)   | Runner stdout の無音許容時間。`0` で stall 検知を無効化                                                                                                                                                                                                                                                                                                 |
| `workflow_file`          | `WORKFLOW.md`     | リポジトリ直下の prompt テンプレートファイル名 (Liquid)。後述                                                                                                                                                                                                                                                                                           |

### Workspace / クリーンアップ

| キー                   | 既定                      | 何が変わるか                                                                                                                             |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_root`       | `.philharmonic/worktrees` | git worktree の親ディレクトリ。相対パスは repo root 基準で解決                                                                           |
| `clean_retention_days` | `7`                       | `philharmonic clean` で retention 経過済みと判定する日数。各 worktree の `mtime` が `now - clean_retention_days * 1day` 以下なら削除対象 |

### `philharmonic serve` (常駐デーモン)

| キー                          | 既定            | 何が変わるか                                                                                                  |
| ----------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `polling.interval_ms`         | `30000` (30 秒) | 1 tick 終了後の sleep 時間。**下限 1000ms**。1000〜4999ms は起動時に warning が出る                           |
| `agent.max_concurrent_agents` | `1`             | 1 tick で並列 dispatch する Issue 件数。`1` で逐次 (MVP 互換)                                                 |
| `server.port`                 | -               | Snapshot HTTP API (#30) の listen port。**未指定なら API 自体を起動しない**。指定時は `127.0.0.1` 固定で bind |

> 自動 retry (`retry.max_attempts` / `retry.max_backoff_ms`) は ADR-0005 で撤廃されました。Failed を再実行する場合は人手で `Todo` に戻すか、別 Issue で起票しなおします。

### 観測

| キー        | 既定   | 何が変わるか                                                                                                       |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `log_level` | `info` | 構造化ログの最低出力レベル。`debug` / `info` / `warn` / `error`。詳細: [operations.md](./operations.md#構造化ログ) |

### フィールドの全表

未知キーは `strict` で拒否される、各値の下限・transform 規則・camelCase の TypeScript 型などフル仕様は [`docs/specs/config-schema.md`](../specs/config-schema.md) を参照してください。本ガイドは「何を変えると何が変わるか」のみを書いています。

## フルサンプル (こうやって使うとこう動く)

```yaml
owner: hexylab
project_number: 1
status_field: Status
dispatch_statuses:
  - Ready for Agent
  - Todo
agent_user_login: philharmonic-bot
base_branch: main

workflow_file: WORKFLOW.md
permission_mode: bypass # ADR-0005: agent 委譲型では bypass が実用上必須
timeout_ms: 1800000

workspace_root: .philharmonic/worktrees
clean_retention_days: 7
log_level: info

polling:
  interval_ms: 30000
agent:
  max_concurrent_agents: 1
server:
  port: 4000

hooks:
  after_create:
    - command: pnpm
      args: [install, --frozen-lockfile]
      timeout_ms: 120000
      on_failure: fail
  before_remove:
    - command: ./scripts/cleanup.sh
      args: []
      timeout_ms: 10000
      on_failure: continue
```

このとき:

- `Status = Ready for Agent` または `Status = Todo` の **assignee が `philharmonic-bot` の Issue** だけが dispatch 候補
- 1 ターンの timeout は 30 分、Runner stdout 5 分無音で stall 判定
- `philharmonic serve` は 30 秒ごとに 1 件 dispatch (自動 retry は撤廃。Failed は人手で再起票)
- `localhost:4000` で Snapshot HTTP API が読める
- worktree 新規作成直後に `pnpm install --frozen-lockfile` が走る
- worktree 削除直前に `./scripts/cleanup.sh` が走る (失敗しても削除は止めない)

## `WORKFLOW.md` で prompt をカスタマイズする

リポジトリ直下に `WORKFLOW.md` を置くと、Claude Code に渡す prompt の **本体構造** をリポジトリごとに変えられます。`WORKFLOW.md` が無いリポジトリでは Issue body をそのまま埋めたデフォルト prompt が組み立てられます (構造化セクション必須は ADR-0005 で撤廃)。

### 仕組み

- テンプレートエンジンは [LiquidJS](https://liquidjs.com/)
- `philharmonic run` は dispatch ごとにファイルを読み直し、`philharmonic serve` は `fs.watch` で変更検出時にもログを出します
- prompt の **末尾には Orchestrator が無条件で agent 委譲指示を連結** します (Status を In Progress に遷移 / commit / push / PR 作成 / 失敗時の Issue コメント / Conventional Commits)。テンプレート側でこれを書く必要はありません

### 提供される変数 (snake_case)

| 変数名             | 例                                                  |
| ------------------ | --------------------------------------------------- |
| `repository.owner` | `hexylab`                                           |
| `repository.name`  | `philharmonic`                                      |
| `base_branch`      | `main`                                              |
| `issue.number`     | `27`                                                |
| `issue.title`      | `WORKFLOW.md ...`                                   |
| `issue.url`        | `https://github.com/hexylab/philharmonic/issues/27` |
| `issue.body`       | Issue body 全文                                     |
| `workspace_path`   | worktree の絶対パス                                 |
| `run_id`           | UUIDv7                                              |

> ADR-0005 で `issue.goal` / `issue.constraints` / `issue.acceptance_criteria` / `attempt` 変数は撤廃されました。本文を部分抽出したい場合はテンプレート側で `{{ issue.body | split: '## Goal' | last | split: '##' | first }}` のように加工してください。

### サンプル

```liquid
# {{ repository.owner }}/{{ repository.name }} — Task #{{ issue.number }}

- Issue: [#{{ issue.number }} {{ issue.title }}]({{ issue.url }})
- Workspace: {{ workspace_path }}
- Run ID: `{{ run_id }}`

## Issue 本文

{{ issue.body }}
```

`WORKFLOW.md` の hot-reload 仕様 / フォールバック挙動は [`docs/specs/workflow.md`](../specs/workflow.md) を参照。

## Lifecycle hooks の使いかた

workspace のライフサイクル各点で任意の shell コマンドを実行できます。`pnpm install` を毎回 worktree でやり直したいとき、`.env` を生成したいとき、cleanup 用スクリプトを動かしたいときに使います。

### 4 つの event

| event           | いつ動くか                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `after_create`  | git worktree が **新規作成** された直後 (再利用時は発火しない)                                                          |
| `before_run`    | Claude Code runner を起動する直前                                                                                       |
| `after_run`     | runner が終了した直後。`success` / `timeout` / `stalled` / `failed` のいずれでも **必ず** 発火                          |
| `before_remove` | `git worktree remove` を呼ぶ直前。`on_failure: fail` でも cleanup は止まらない (孤児 worktree のほうが運用上有害なため) |

### 設定例

```yaml
hooks:
  after_create:
    - command: pnpm
      args: [install, --frozen-lockfile]
      timeout_ms: 120000
      on_failure: fail
  before_run:
    - command: cp
      args: [/secrets/.env.template, .env]
      timeout_ms: 5000
      on_failure: fail
  after_run: []
  before_remove:
    - command: ./scripts/cleanup.sh
      args: []
      timeout_ms: 10000
      on_failure: continue
```

| キー         | 既定            | 説明                                                                                |
| ------------ | --------------- | ----------------------------------------------------------------------------------- |
| `command`    | (必須)          | 実行コマンド (PATH 解決される)                                                      |
| `args`       | `[]`            | 引数。**shell を経由せず** 配列として渡る (shell injection を避ける)                |
| `timeout_ms` | `60000` (60 秒) | hook 単体の timeout。超過時は SIGTERM → `kill_grace_period_ms` 後 SIGKILL           |
| `on_failure` | `fail`          | 非ゼロ exit / spawn error / timeout のときの挙動。`continue` で warn ログのみで続行 |

### hook に渡される環境変数

すべての event で以下が `cwd = workspace path` の親 env に merge されて渡ります。

| 変数                          | 内容                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `PHILHARMONIC_EVENT`          | event 名 (`after_create` / `before_run` / `after_run` / `before_remove`)       |
| `PHILHARMONIC_TASK_KEY`       | task key (例: `issue-26`)                                                      |
| `PHILHARMONIC_BRANCH`         | sanitize 後の branch 名                                                        |
| `PHILHARMONIC_WORKSPACE_PATH` | worktree の絶対パス                                                            |
| `PHILHARMONIC_REPO_ROOT`      | 主リポジトリの絶対パス                                                         |
| `PHILHARMONIC_BASE_REF`       | `createWorkspace` で渡した base ref                                            |
| `PHILHARMONIC_ISSUE_NUMBER`   | orchestrator 経由の発火時のみ                                                  |
| `PHILHARMONIC_RUN_ID`         | orchestrator 経由の発火時のみ                                                  |
| `PHILHARMONIC_RUN_STATUS`     | `after_run` のみ。runner status (`success` / `timeout` / `stalled` / `failed`) |

詳細仕様 (失敗時の正確な挙動 / Public API) は [`docs/specs/workspace-manager.md`](../specs/workspace-manager.md) を参照。
