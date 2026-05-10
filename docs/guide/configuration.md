# Configuration

Philharmonic の挙動は次の 3 つを通じてカスタマイズします。

1. `.philharmonic/philharmonic.yaml` — Orchestrator / Runner / Workspace / serve daemon の設定値
2. `.philharmonic/WORKFLOW.md` — Claude Code に渡す prompt の上位レイヤ (Liquid テンプレート)
3. Lifecycle hooks — workspace の各イベントで任意の shell コマンドを実行する

本ドキュメントは利用者視点で「どこをいじると何が変わるか」を扱います。フィールドの全リファレンス (型 / 下限 / strict 検証の挙動など) は [`docs/specs/config-schema.md`](../specs/config-schema.md) を参照してください。

## `.philharmonic/philharmonic.yaml` の場所と最小構成

- 既定では Philharmonic を実行した cwd の `.philharmonic/philharmonic.yaml` を読みます (`philharmonic run` / `philharmonic serve` / `philharmonic clean` 共通)
- 旧来の repo root 直下 `philharmonic.yaml` のみ存在する場合は当面 fallback で読み込み、warning を 1 行出します。`mv philharmonic.yaml .philharmonic/philharmonic.yaml` で移行してください
- `--config <path>` で別パスを指定できます (legacy fallback の探索は行いません)
- `~` 展開などは行いません (絶対パスか cwd 相対で渡す)

最小構成は次の 2 行だけです:

```yaml
# .philharmonic/philharmonic.yaml
owner: your-github-login
project_number: 1
```

これ以外のキーはすべて省略可で、内側のデフォルト値が補完されます。

### `philharmonic init` で scaffold する (推奨)

最小構成 + コメント化された default サンプルを 1 コマンドで生成できます (詳細手順: [getting-started.md#4-対象リポジトリで-philharmonic-init-を実行する](./getting-started.md#4-対象リポジトリで-philharmonic-init-を実行する))。生成先は `.philharmonic/philharmonic.yaml` (および任意で `.philharmonic/WORKFLOW.md`) です。

```sh
# 対象リポジトリのルートで
philharmonic init                                           # 対話モード
philharmonic init --yes --owner foo --project 1             # 非対話 (CI 等)
philharmonic init --dry-run --owner foo --project 1         # 書かずに内容だけ確認
```

生成 yaml は冒頭が `owner` / `project_number` のみ active で、`permission_mode` / `base_branch` / `polling` / `server` / `hooks` 等はコメントで default が同梱されます。`#` を外すと有効化できます。

> Philharmonic 関連ファイルは原則 `.philharmonic/` 配下に集約されます (config / workflow テンプレート / worktree / run ログ / serve.lock)。`.gitignore` には `.philharmonic/worktrees/` / `.philharmonic/runs/` / `.philharmonic/serve.lock` のみを登録し、`.philharmonic/philharmonic.yaml` と `.philharmonic/WORKFLOW.md` は commit 可能にしておくと、チーム間で設定を共有しやすくなります。

## よく触るキーと使いどころ

### Project / 候補選定

| キー                             | 既定          | 何が変わるか                                                                                                                            |
| -------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`                          | (必須)        | Project owner の GitHub login (user または org)                                                                                         |
| `project_number`                 | (必須)        | Project URL 末尾の整数                                                                                                                  |
| `status_field`                   | `Status`      | Project 上の単一選択フィールド名。Status を別フィールド名で運用しているならここを変える                                                 |
| `dispatch_statuses`              | `[Todo]`      | dispatch 候補とする Status option 名の配列。`[Ready for Agent, Todo]` のように複数指定可。`status_field` のどの option を拾うか直交設定 |
| `status_transitions.in_progress` | `In Progress` | agent が dispatch 直後に flip する遷移先 Status 名。Project の Status options に合わせて差し替える                                      |
| `status_transitions.in_review`   | `In Review`   | PR 作成成功後に agent が flip する遷移先 Status 名                                                                                      |
| `status_transitions.failed`      | `Failed`      | 失敗時に agent が flip する遷移先 Status 名                                                                                             |
| `agent_user_login`               | `null`        | `null` のとき unassigned のみ拾う。bot login (例: `philharmonic-bot`) を指定するとその assignee の Issue だけ拾う                       |
| `base_branch`                    | `main`        | PR の base ブランチ。worktree もこの ref から派生する                                                                                   |

### Runner (Claude Code) の挙動

| キー                     | 既定                        | 何が変わるか                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission_mode`        | `auto`                      | `auto` = `--permission-mode acceptEdits` (worktree 内編集のみ自動承認)。`bypass` = `--dangerously-skip-permissions` (**worktree 外、ホスト全体への副作用が起き得る**)。**`auto` では agent が `gh` / `git push` を実行できないため、Status 遷移 / PR 作成に失敗します。自動 PR 作成まで任せる場合は `bypass` を選んでください** |
| `timeout_ms`             | `1800000` (30 分)           | Runner subprocess の timeout                                                                                                                                                                                                                                                                                                    |
| `kill_grace_period_ms`   | `5000` (5 秒)               | timeout 後 SIGTERM → SIGKILL までの猶予                                                                                                                                                                                                                                                                                         |
| `agent.max_turns`        | `1`                         | `1` で 1 セッション完結 (従来動作)。`>= 2` で `error_max_turns` で打ち切られたとき `--resume` で次ターンへ進む                                                                                                                                                                                                                  |
| `agent.stall_timeout_ms` | `300000` (5 分)             | Runner stdout の無音許容時間。`0` で stall 検知を無効化                                                                                                                                                                                                                                                                         |
| `workflow_file`          | `.philharmonic/WORKFLOW.md` | prompt テンプレートファイルへのパス (Liquid、relative は repo root 基準)。default のときに不在で legacy `WORKFLOW.md` (repo root 直下) があれば warning 付きで採用。後述                                                                                                                                                        |

### Workspace / クリーンアップ

| キー                   | 既定                      | 何が変わるか                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_root`       | `.philharmonic/worktrees` | git worktree の親ディレクトリ。相対パスは repo root 基準で解決                                                                                                                                                                                            |
| `clean_retention_days` | `7`                       | `philharmonic clean` で retention 経過済みと判定する日数。各 worktree の `mtime` が `now - clean_retention_days * 1day` 以下なら削除対象                                                                                                                  |
| `terminal_statuses`    | `[Done]`                  | `philharmonic clean-stale` / `serve` 起動時の cleanup で terminal とみなす Status option 名の配列。custom Status (`Archived` 等) を使う Project は差し替える (詳細: [operations.md](./operations.md#philharmonic-clean-stale--terminal-issue-の自動掃除)) |

### `philharmonic serve` (常駐デーモン)

| キー                          | 既定            | 何が変わるか                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `polling.interval_ms`         | `30000` (30 秒) | 1 tick 終了後の sleep 時間。**下限 1000ms**。1000〜4999ms は起動時に warning が出る                                                                                                                                                                                                                                                             |
| `agent.max_concurrent_agents` | `1`             | 1 tick で並列 dispatch する Issue 件数。DAG filter (`Depends-On:` の解決) で `ready` 判定された候補のうち board 順で先頭 N 件が並列 dispatch される。`1` で逐次 (MVP 互換)。詳細: [operations.md `agent.max_concurrent_agents` との関係](./operations.md#agentmax_concurrent_agents-との関係)                                                   |
| `agent.max_retry_attempts`    | `5`             | `serve` daemon の in-memory retry queue (#84) で 1 つの Issue を retry する最大回数。`0` で機能 off。`runner_error` / `timeout` / `stalled` / `hook_failed` / `workspace_provisioning` を `10s * 2^(attempt-1)` の指数バックオフで再 dispatch。詳細: [operations.md 自動 retry queue](./operations.md#自動-retry-queue-agentmax_retry_attempts) |
| `agent.max_retry_backoff_ms`  | `300000` (5 分) | retry queue の指数バックオフの clamp 上限 (ms)。default で attempt 6 以降は 5 分で頭打ち                                                                                                                                                                                                                                                        |
| `server.port`                 | -               | Snapshot HTTP API の listen port。**未指定なら API 自体を起動しない**。指定時は `127.0.0.1` 固定で bind。`philharmonic dashboard` が default で繋ぐ port もここを見ます (`--port` で上書き可)                                                                                                                                                   |

> 永続 retry-state を伴う Status 駆動の旧 retry は ADR-0005 で撤廃したまま復活させていません。daemon 内 in-memory な retry queue (上記 `agent.max_retry_*`) でカバーされない `Failed` 状態の再実行は引き続き人手 / agent の判断で `Todo` に戻すか別 Issue を起票します。

### GitHub 認証

| キー                  | 既定   | 何が変わるか                                                                                                                                                                                                                         |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github.token_source` | `auto` | GitHub token の取得元。`env` は `GITHUB_TOKEN` / `GH_TOKEN` を直接読む。`gh` は `gh auth token` を起動時に呼ぶ (`gh auth login` 済みであること)。`auto` は env を試して空なら `gh` に fallback。**token 文字列は YAML に書きません** |

`gh` を使う場合は `gh auth login` 済みであることが必要です。`gh` 未インストール / 未ログインのときは起動時にエラーで exit 1 します。CI / systemd / cron などで env だけを使いたい場合は `github.token_source: env` を明示してください。

### Safety

| キー                           | 既定    | 何が変わるか                                                                                                                                                                                                                        |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safety.allow_bypass_in_serve` | `false` | `permission_mode: bypass` で `philharmonic serve` を起動するための明示的 opt-in。`true` か env `PHILHARMONIC_ALLOW_BYPASS_IN_SERVE=1` のどちらかが必要 (両方未設定なら起動拒否)。`philharmonic run` (1 ターン実行) には影響しません |

> `bypass` モードは worktree 外への副作用リスクを伴うため、隔離環境であることを必ず確認してください。`serve` daemon は長時間 `--dangerously-skip-permissions` が連続発火するため、env / config いずれかでの明示的な opt-in を必須にしています。

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
status_transitions:
  in_progress: In Progress
  in_review: In Review
  failed: Failed
agent_user_login: philharmonic-bot
base_branch: main

workflow_file: .philharmonic/WORKFLOW.md
permission_mode: bypass # agent が gh / git push を実行して PR を作るために必要
timeout_ms: 1800000

workspace_root: .philharmonic/worktrees
clean_retention_days: 7
terminal_statuses:
  - Done
log_level: info

polling:
  interval_ms: 30000
agent:
  max_concurrent_agents: 1
  max_retry_attempts: 5 # 一過性失敗を 10s, 20s, 40s, 80s, 160s で再 dispatch
  max_retry_backoff_ms: 300000 # attempt 6 以降は 5 分で頭打ち
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

github:
  token_source: auto # gh auth login 済みなら env 不要
safety:
  allow_bypass_in_serve: true # bypass + serve の OK 印 (env による上書きも可)
```

このとき:

- `Status = Ready for Agent` または `Status = Todo` の **assignee が `philharmonic-bot` の Issue** だけが dispatch 候補
- 1 ターンの timeout は 30 分、Runner stdout 5 分無音で stall 判定
- `philharmonic serve` は 30 秒ごとに 1 件 dispatch (自動 retry は撤廃。Failed は人手で再起票)
- `localhost:4000` で Snapshot HTTP API が読める
- worktree 新規作成直後に `pnpm install --frozen-lockfile` が走る
- worktree 削除直前に `./scripts/cleanup.sh` が走る (失敗しても削除は止めない)

## `WORKFLOW.md` で prompt をカスタマイズする

`.philharmonic/WORKFLOW.md` を置くと、Claude Code に渡す prompt の **本体構造** をリポジトリごとに変えられます。テンプレートが無いリポジトリでは Issue body をそのまま埋めたデフォルト prompt が組み立てられます (Issue body は構造化セクション無しの自由フォーマットで構いません)。

> 旧来の `WORKFLOW.md` (repo root 直下) も当面 fallback として読まれますが、警告ログが出ます。`mv WORKFLOW.md .philharmonic/WORKFLOW.md` で移行してください。

### 仕組み

- テンプレートエンジンは [LiquidJS](https://liquidjs.com/)
- `philharmonic run` は dispatch ごとにファイルを読み直し、`philharmonic serve` は `fs.watch` で変更検出時にもログを出します
- prompt の **末尾には Orchestrator が無条件で agent 委譲指示を連結** します (Status を `status_transitions.in_progress` に遷移 / commit / push / PR 作成 / 失敗時の Issue コメント / Conventional Commits)。テンプレート側でこれを書く必要はありません。Status 名はすべて `philharmonic.yaml` の `status_transitions` を参照するため、Project の Status options に合わせて差し替え可能です

### 提供される変数 (snake_case)

| 変数名                           | 例                                                  |
| -------------------------------- | --------------------------------------------------- |
| `repository.owner`               | `hexylab`                                           |
| `repository.name`                | `philharmonic`                                      |
| `base_branch`                    | `main`                                              |
| `issue.number`                   | `27`                                                |
| `issue.title`                    | `WORKFLOW.md ...`                                   |
| `issue.url`                      | `https://github.com/hexylab/philharmonic/issues/27` |
| `issue.body`                     | Issue body 全文                                     |
| `project.owner`                  | `hexylab`                                           |
| `project.number`                 | `1`                                                 |
| `project.status_field`           | `Status`                                            |
| `status_transitions.in_progress` | `In Progress` (config 既定) / Project の Status 名  |
| `status_transitions.in_review`   | `In Review` (config 既定)                           |
| `status_transitions.failed`      | `Failed` (config 既定)                              |
| `workspace_path`                 | worktree の絶対パス                                 |
| `run_id`                         | UUIDv7                                              |

> Issue 本文を構造化抽出した変数 (`issue.goal` / `issue.constraints` / `issue.acceptance_criteria`) や `attempt` 変数はサポートしていません。本文を部分抽出したい場合はテンプレート側で `{{ issue.body | split: '## Goal' | last | split: '##' | first }}` のように加工してください。

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
