# Operations

日常運用 (CLI コマンド / 構造化ログ / 実行ファイル / Snapshot HTTP API / トラブルシュート) をまとめます。各機能の正確な仕様は [`docs/specs/`](../specs/) の対応 spec に置いています。

## CLI コマンドの早見表

| コマンド                     | 何をするか                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `philharmonic init`          | 対象リポジトリで `.philharmonic/philharmonic.yaml` を scaffold する (初回セットアップ用 / #66 / #67)                     |
| `philharmonic projects list` | Project Item のうち Issue に紐づいたものを一覧表示する (dispatch 候補が見えているか確認)                                 |
| `philharmonic run`           | 1 ターン分の orchestration を実行する (1 件処理して exit)                                                                |
| `philharmonic serve`         | 一定間隔でポーリングして候補があれば run を回す常駐デーモン (SIGTERM/SIGINT で graceful shutdown)                        |
| `philharmonic retry <n>`     | 指定 Issue の Project Status を dispatch 対象状態に戻し、stale な worktree を cleanup する (手動再実行)                  |
| `philharmonic clean`         | retention 経過済みの `issue-*` worktree とローカルブランチを掃除する (失敗 worktree のクリーンアップ用)                  |
| `philharmonic clean-stale`   | terminal state (Done 等) / closed Issue の `issue-*` worktree を、open PR / active run が無い場合のみ cleanup する (#89) |
| `philharmonic dashboard`     | `philharmonic serve` の Snapshot HTTP API を購読する read-only TUI dashboard を起動する                                  |

`init` 以外のコマンドは `--config <path>` が使えます (cwd 以外の `.philharmonic/philharmonic.yaml` を指定するとき)。`init` の手順詳細は [getting-started.md](./getting-started.md#4-対象リポジトリで-philharmonic-init-を実行する) を参照してください。

## `philharmonic projects list` — 候補確認

```sh
philharmonic projects list --owner <owner> --project <project-number>

# 取得件数を変える (1〜100、既定 100)
philharmonic projects list --owner <owner> --project <project-number> --first 30

# Status field 名を上書き (philharmonic.yaml と独立した一発実行用)
philharmonic projects list --owner <owner> --project <project-number> --status-field "Workflow Status"

# 整形 JSON で出す (パイプ用)
philharmonic projects list --owner <owner> --project <project-number> --json
```

候補 0 件のときは `no candidates`。Issue に紐づかない Project Item (Draft 等) は除外されます。フィルタ条件 (Status / assignee) に合わない場合もここで気づけるので、`philharmonic run` を回す前のセルフチェックに使ってください。

## `philharmonic run` — 1 ターン実行

```sh
philharmonic run

# 別パスの設定ファイルを指定する場合
philharmonic run --config ./path/to/.philharmonic/philharmonic.yaml
```

stdout / stderr の出力は次のとおり。

| 経路   | 出力                                       | 意味                                                   |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| stdout | `no candidate`                             | 候補 0 件 (exit 0)                                     |
| stdout | `success run-id=... issue=#... branch=...` | runner が exit 0 で終わった (exit 0)                   |
| stderr | `failed run-id=... issue=#... reason=...`  | runner が失敗した (exit 1)。worktree は debug 用に残る |
| stderr | JSON line (構造化ログ)                     | 進捗 / 警告 / 失敗。`run_id` などで絞り込みできる      |

並列実行 / 自動 retry / 自動 merge は **行いません**。常駐させたい場合は `philharmonic serve` を、cron 駆動にしたい場合は systemd timer / GitHub Actions の `schedule` から `philharmonic run` を呼んでください。

> Status 遷移 / PR 作成 / Issue コメントは agent が `gh` 経由で行います。`success` の stdout に PR 番号は含まれません (PR 番号は agent が `gh pr create` で発行するため、Issue / PR コメントから後追いするか `gh pr list` で確認してください)。

詳細仕様 (state machine / Failure ハンドリング) は [`docs/specs/orchestration-mvp.md`](../specs/orchestration-mvp.md)。

## `philharmonic serve` — 常駐デーモン

```sh
# polling.interval_ms (default 30s) ごとに 1 件ずつ run を回す
philharmonic serve

# 別パスの設定ファイルを指定する場合
philharmonic serve --config ./path/to/.philharmonic/philharmonic.yaml
```

`philharmonic serve` は SIGTERM / SIGINT を受信すると **in-flight run の完了を待ってから** graceful に exit します (subprocess を強制終了したりはしない)。systemd / Docker など PID 1 として走らせるユースケースでも安全です。終了 exit code は **0** (graceful shutdown は正常終了とみなす)。

主な違い (`philharmonic run` との比較):

| 項目              | `run`           | `serve`                                                                                                                                                    |
| ----------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実行回数          | 1 ターンで exit | ポーリング loop で繰り返す                                                                                                                                 |
| 並列 dispatch     | 無し            | `agent.max_concurrent_agents` で 1 tick 内に複数 dispatch                                                                                                  |
| Tracker recovery  | 無し            | 起動時に `In Progress` の Issue を引き取る                                                                                                                 |
| 自動 retry queue  | 無し            | `agent.max_retry_attempts` で failure / continuation 両方を再 dispatch。`.philharmonic/state/retry-queue.json` に永続化され再起動を跨ぐ (#84 / #85 / #104) |
| Snapshot HTTP API | 起動しない      | `server.port` 指定時に `127.0.0.1` で起動                                                                                                                  |
| 二重起動防止      | 無し            | `.philharmonic/serve.lock` で同一 repo の二重起動を弾く                                                                                                    |

### 自動 retry queue (`agent.max_retry_attempts`)

`philharmonic serve` は daemon プロセス内に **retry queue** を持ち、以下 2 種類の自動再 dispatch を 1 本の queue で扱います。最大 `agent.max_retry_attempts` 回 (default 5) まで再試行し、kind ごとに独立にカウントします (Issue #84 / [ADR-0008](../adr/0008-in-memory-retry-queue.md), Issue #85 / [ADR-0009](../adr/0009-continuation-retry-after-success.md))。state は `<repoRoot>/.philharmonic/state/retry-queue.json` に永続化され、serve 再起動を跨いで attempt counter が維持されます (Issue #104 / [ADR-0011](../adr/0011-persist-retry-queue-across-restart.md))。

#### kind=`failure` — 失敗の指数バックオフ retry

orchestrator 起源の失敗を再 dispatch:

- `workspace_provisioning`: worktree 作成 / git fetch の一過性失敗
- `runner_error`: claude subprocess の異常終了
- `timeout`: 30 分の subprocess timeout
- `stalled`: stdout 無音が `agent.stall_timeout_ms` を超過
- `hook_failed`: `before_run` / `after_run` / `before_remove` hook の失敗

backoff は `min(10s * 2^(attempt-1), agent.max_retry_backoff_ms)` (default `300_000` ms = 5 分で頭打ち)。

#### kind=`continuation` — 正常終了後の Status 再確認

agent が exit 0 で終わったが Project Status を `In Review` / `Failed` に flip し損ねたケース (max_turns 到達 / prompt 漏れ / `gh` API 一過性エラー) を救済します。

- `dispatchSelected` が success を返した直後に `fetchProjectCandidates` で Status を再取得
- Status が `dispatch_statuses` または `status_transitions.in_progress` (= active) のままなら、**10 秒後** に再 dispatch する continuation entry を schedule
- Status が `In Review` / `Failed` / `Done` / Issue closed なら queue に積まずに release

delay は **固定 10 秒** で指数バックオフは使いません (config 化していません)。

#### 機能の on / off

両 kind とも `agent.max_retry_attempts` で制御します。off にしたい場合:

```yaml
agent:
  max_retry_attempts: 0
```

retry の進行は構造化ログ (`retry scheduled` / `retry due` / `retry skipped` / `retry exhausted` / `continuation released`、いずれも `kind` field 付き) と Snapshot HTTP API (`/api/v1/state` の `retry_queue.entries[].kind` field) で観測できます。retry queue は `<repoRoot>/.philharmonic/state/retry-queue.json` に永続化され (ADR-0011 / Issue #104)、daemon 再起動を跨いで attempt counter / dueAt / failureReason が維持されます。state file が壊れた場合は `<state.json>.bak` に退避し empty queue で起動します。drain → dispatch 間の crash window で失われた 1 attempt は、次回 `serve` 起動時の Tracker-driven recovery (`In Progress` 引き取り) が代替で拾います。

`kind=failure` で上限に到達した場合は `.philharmonic/runs/<run-id>/failure-summary.md` に運用者向け Markdown サマリ (issue / final attempt / failure reason / log path / 手動復旧手順) を残します。発生時の手順は [自動 retry が上限に到達した](#自動-retry-が上限に到達した-retry-exhausted-kindfailure) を参照してください。

詳細仕様は [`docs/specs/retry-queue.md`](../specs/retry-queue.md) を参照。

> 旧仕様の **Status 駆動な** retry-state (`Failed → Todo` を orchestrator が書き戻す) は復活させていません。retry queue は `attempt` counter / `dueAt` だけを `.philharmonic/state/retry-queue.json` に永続化し (ADR-0011)、Status は引き続き agent が書きます。`Failed` flip 後の再実行は人手 / agent の判断で `Todo` に戻すか別 Issue を起票します。

`permission_mode: bypass` を `serve` で使う場合は、長時間稼働で `--dangerously-skip-permissions` が連続発火することへの opt-in が必要です。`philharmonic.yaml` で `safety.allow_bypass_in_serve: true` を設定するか (推奨)、環境変数 `PHILHARMONIC_ALLOW_BYPASS_IN_SERVE=1` を明示してください。両方未設定だと起動を拒否します。

詳細仕様 (lock file / signal handling / 並列 dispatch / Tracker recovery) は [`docs/specs/serve-daemon.md`](../specs/serve-daemon.md)。

## `philharmonic retry <issue-number>` — 手動再実行

自動 retry queue (`agent.max_retry_attempts`) で復旧できなかった Issue や、恒久原因を修正したあとに人間が明示的に再実行したい Issue を、単一コマンドで安全に再 dispatch 可能な状態へ戻すための **fallback コマンド** です。Project Status を dispatch 対象状態に戻し、stale な worktree を cleanup します。

```sh
# まずは plan を確認 (副作用ゼロ)
philharmonic retry 42 --dry-run

# 実行: worktree cleanup → Status を Todo に書き戻し
philharmonic retry 42

# Status の書き戻し先を上書き (default: dispatch_statuses[0]、通常 Todo)
philharmonic retry 42 --target-status "Ready for Agent"

# open PR が紐付いていても続行する (default は abort)
philharmonic retry 42 --force
```

何が起こるか:

1. **対象 Issue を Project Item から特定** — Project に居ないなら exit 1
2. **Issue が close 済みなら abort** (再実行しても意味がないため)
3. **`feature/<issue番号>-` で始まる open PR を確認** — 1 件でもあれば default で abort (`--force` で続行可能)
4. **worktree cleanup** — `<workspace_root>/issue-<番号>/` が残っていれば `WorkspaceManager.cleanupWorkspace` で削除。`feature/<issue番号>-` パターンに一致するローカルブランチも併せて削除します
5. **Project Status 書き戻し** — 既存 Status と target が違うときだけ `gh project item-edit` で書き戻し (idempotent)
6. **serve daemon が動いていれば次 tick で再 pick** — Status と worktree が dispatch 可能な状態に戻っているため

`--dry-run` は **副作用ゼロ** で plan を表示するだけです。`gh project item-edit` も `cleanupWorkspace` も呼ばないので、慣れないうちは `--dry-run` で確認してから本実行する運用を推奨します。

> **自動 retry queue との関係**: `philharmonic serve` の retry queue は daemon プロセス内の in-memory state を `.philharmonic/state/retry-queue.json` に永続化したもので、`philharmonic retry` (別プロセス) からは直接書き換えできません。同 Issue の retry entry が serve に残っていれば、`dueAt` 到来時の `drainRetryQueue` が新しい Status (= 本コマンドが書き戻した値) を見て普通に dispatch します。serve 停止中に state file を手で削除したい場合は `rm <repoRoot>/.philharmonic/state/retry-queue.json` が安全 (serve 再起動で empty queue になる)。

> **動作中の serve との race**: 対象 Issue が **まさに in-flight** な場合 (`philharmonic serve` の dispatch が runner 起動中) に `philharmonic retry` を実行すると、`cleanupWorkspace` が **動作中の runner の worktree を `--force` で吹き飛ばす** 可能性があります。spec 上 retry CLI は「自動 retry で復旧できなかった fallback」想定ですが、足元で in-flight な可能性を防ぐためには、実行前に `philharmonic dashboard` または `curl -s http://127.0.0.1:<port>/api/v1/<issue-number> | jq` で対象 Issue が `running[]` に居ないことを確認してから実行してください。`server.port` を未設定なら `philharmonic serve` の構造化ログの `dispatch success` / `run completed successfully` を grep する運用でも代替できます。

> **Status 書き戻しの経路**: 本コマンドは agent と同様 `gh project item-edit` を subprocess で呼びます。orchestrator は GraphQL の write 系を持ちません ([ADR-0005](../adr/0005-thin-orchestrator-agent-delegation.md) の境界を維持)。`gh` の認証は env (`GITHUB_TOKEN` / `GH_TOKEN`) または host の `gh auth login` を使います (既存の `github.token_source` 経路と同じ前提)。

詳細仕様 (plan 構造 / エラーハンドリング) は [`docs/specs/manual-retry.md`](../specs/manual-retry.md) を参照。

## `philharmonic clean` — 失敗 worktree の掃除

worktree は **runner exit 0 のときのみ自動削除** されます。失敗時 (`runner_error` / `timeout` / `stalled` / `hook_failed` / `workspace_provisioning`) は `.philharmonic/worktrees/issue-<番号>/` に残るので、調査後に手動削除するか、`philharmonic clean` で retention 経過後にまとめて掃除してください。

```sh
# 削除候補の確認 (何も削除しない)
philharmonic clean --dry-run

# retention 経過済みの worktree とローカルブランチを掃除する
philharmonic clean

# retention をその場で上書き (config の clean_retention_days より優先)
philharmonic clean --retention-days 3
```

`clean` の対象は `<workspace_root>/issue-*` worktree とそれに紐づくローカルブランチに **限定** されます。`main` などの主リポジトリ worktree や `issue-*` 以外のディレクトリは構造的に保護されます (詳細: [`docs/specs/orchestration-mvp.md#philharmonic-clean-失敗-worktree-のクリーンアップ`](../specs/orchestration-mvp.md))。

## `philharmonic clean-stale` — terminal Issue の自動掃除

retention (mtime) ではなく **Project Status** に基づいて、もう作業の必要がない Issue の worktree を掃除するコマンドです。`philharmonic serve` 起動時にも recovery 完了後に自動で 1 度走るため、daemon 運用していれば手動で叩く必要は通常ありません。

cleanup 対象になるのは以下のいずれか:

- GitHub Issue が CLOSED (Issue 本体が閉じられている)
- Project Status が `terminal_statuses` (default `['Done']`) に含まれる

cleanup を **skip する** safety 条件:

- `feature/<issue 番号>-` prefix の open PR が残っている (`open_pr_exists`)
- 同 Issue が run tracker で in-flight に積まれている (`active_run` — serve 起動時のみ)
- 対応する Project Item が見つからない (`no_project_item`)
- Open Issue かつ non-terminal Status (`issue_open_non_terminal` — Todo / In Progress / In Review / Failed 等)

```sh
# 何が消えるかを確認する (副作用ゼロ)
philharmonic clean-stale --dry-run

# 実行
philharmonic clean-stale

# terminal とみなす Status を一時的に上書き
philharmonic clean-stale --terminal-status Done --terminal-status Archived

# daemon が動作中 (serve.lock 存在) でも続行 (race を許容する場合のみ)
philharmonic clean-stale --force
```

branch (`feature/<番号>-...`) も `git branch -D` で同時に消します。**main や別 feature ブランチを checkout している `issue-*` worktree は worktree だけ消して branch は触りません** (`shouldDeleteBranch` 保護)。

`Todo` に戻したのに古い worktree が残って `philharmonic serve` の dispatch が進まないケース (= 二重 dispatch ガードの `workspace_exists` で skip され続ける) は、本コマンドの対象外です。個別 Issue の再実行は [`philharmonic retry`](#philharmonic-retry-issue-number--手動再実行) を使ってください。詳細仕様: [`docs/specs/stale-worktree-cleanup.md`](../specs/stale-worktree-cleanup.md)。

## 構造化ログ

すべての CLI は進捗 / 警告 / 失敗を **JSON line 形式の構造化ログ** として `stderr` に書き出します。各イベントには:

- `ts` — ISO 8601 タイムスタンプ
- `level` — `debug` / `info` / `warn` / `error`
- `msg` — 人間向け短文
- `run_id` / `issue_number` — Orchestrator 内のすべてのイベントに付与
- `session_id` — Claude Code subprocess 起動後のイベントに付与

`stdout` には人間向けの結果 (`success run-id=... branch=...` / `no candidate`) のみが流れます。「シェルスクリプトで結果を読み取る」のと「ログを集計する」の責務が綺麗に分離されています。

```sh
# 対象 run のログだけ取り出す
philharmonic run 2>&1 1>/dev/null | jq -c 'select(.run_id == "01956a91-...")'

# warn 以上だけ取り出す
philharmonic run 2>&1 1>/dev/null | jq -c 'select(.level == "warn" or .level == "error")'

# 進捗ログだけ流す
philharmonic serve 2>&1 1>/dev/null | jq -c 'select(.level == "info")'
```

レベルは `philharmonic.yaml` の `log_level` で制御します。詳細仕様 (出力フォーマット / bindings / child logger) は [`docs/specs/observability.md`](../specs/observability.md)。

## 実行ファイル (`.philharmonic/runs/`)

実行ごとに **対象リポジトリ** の `.philharmonic/runs/<run-id>/` に以下が残ります (`run-id` は UUIDv7 で時刻順ソート可能)。

| ファイル        | 内容                                              |
| --------------- | ------------------------------------------------- |
| `prompt.md`     | Claude に渡した prompt 全文                       |
| `stream.jsonl`  | Claude Code の stream-json 出力 (1 行 1 イベント) |
| `stderr.log`    | Claude Code の stderr                             |
| `metadata.json` | run-id / issue / branch / cost / status 等        |
| `summary.md`    | Claude の最終応答 (Markdown 整形済み)             |

失敗時のデバッグはこのディレクトリから始めます。`stream.jsonl` を `jq` で追えば、Claude Code がどの tool を呼び、どこで止まったかを再現できます。`metadata.json` には `total_cost_usd` も入っているので、コスト集計にも使えます。

## Snapshot HTTP API (`philharmonic serve` 専用)

`philharmonic.yaml` で `server.port` を指定すると、`philharmonic serve` 起動時に `127.0.0.1:<port>` に **read-only** な HTTP API が立ちます。dashboard や外部 health-check 用です。

```yaml
server:
  port: 4000
```

| エンドポイント           | method | 用途                                                                                |
| ------------------------ | ------ | ----------------------------------------------------------------------------------- |
| `/api/v1/state`          | GET    | 全体 snapshot (進行中の run / 累計コスト / DAG scheduler / retry queue 等)          |
| `/api/v1/<issue_number>` | GET    | 指定 Issue の snapshot (in-flight があれば返す、なければ 404)                       |
| `/api/v1/refresh`        | POST   | 次 tick の sleep を起こす (in-flight 中は no-op、`{"woken": true \| false}` を返す) |

```sh
# 全体 snapshot を見る
curl -s http://127.0.0.1:4000/api/v1/state | jq .

# 特定 Issue の状態だけ見る
curl -s http://127.0.0.1:4000/api/v1/42 | jq .

# 次 tick を待たずに即 poll させる
curl -s -X POST http://127.0.0.1:4000/api/v1/refresh
```

セキュリティ運用:

- bind は **`127.0.0.1` 固定** (loopback)。host を変えるオプションは出していません
- 認証はかかっていません (loopback 限定の前提)
- LAN 越しに見たい場合は SSH トンネル (`ssh -L 4000:127.0.0.1:4000 <host>`) を経由してください

レスポンス全フィールドは [`docs/specs/snapshot-api.md`](../specs/snapshot-api.md)。設計判断の背景は [`docs/adr/0004-snapshot-http-api.md`](../adr/0004-snapshot-http-api.md)。

## `philharmonic dashboard` — Snapshot を TUI で見る

`philharmonic serve` が Snapshot HTTP API (`server.port`) を出している間、別ターミナルから `philharmonic dashboard` を起動すると、daemon の uptime / polling / running runs / totals を一定間隔で再描画する **read-only な TUI** が立ち上がります。

```sh
# config (server.port) の設定を流用して 127.0.0.1:<port> に繋ぐ
philharmonic dashboard

# port を一時的に上書きする (config.server.port は触らない)
philharmonic dashboard --port 4001

# refresh 間隔を上書き (省略時は polling.interval_ms。最小 500ms)
philharmonic dashboard --interval 5000

# CI / cron / 動作確認向け: 1 回だけ snapshot を取得して text を出力して exit する
philharmonic dashboard --once
```

接続先は **`127.0.0.1` 固定** (Snapshot API の bind と一致)。`--port` も `server.port` も決まらない場合は `philharmonic.yaml` に `server.port` を追加するか `--port` を指定するよう案内して exit 1 します。

| キー         | 動作                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| `q`          | 終了 (exit 0)                                                                               |
| `Ctrl+C`     | 終了 (exit 0)                                                                               |
| `r`          | 即時 refresh (`GET /api/v1/state`)                                                          |
| `R` (大文字) | `POST /api/v1/refresh` で daemon の sleep を起こした上で即時 refresh (副作用は `wake` のみ) |

接続失敗 (daemon が未起動 / API server が応答しない) のときの挙動:

- TUI モードでは画面下部にエラーメッセージを表示し、interval ごとに自動 retry します (Ctrl+C / `q` で exit 0)
- `--once` モードでは `dashboard: <理由>` を stderr に書いて exit 1 します

詳細仕様 (フィールド構造 / state machine / `--once` の出力形式) は [`docs/specs/dashboard.md`](../specs/dashboard.md)。設計判断の背景は [`docs/adr/0006-tui-dashboard.md`](../adr/0006-tui-dashboard.md)。

## 依存関係付き Issue を運用する (DAG scheduling)

Issue 本文に `Depends-On:` 行を書くと、Philharmonic の scheduler は依存先 Issue がすべて close されるまでその Issue を dispatch しません。先行 Issue (例: DB schema 変更) と後続 Issue (例: API 変更) の順序を `Todo` の昇格タイミングで人手制御する代わりに、Issue body の 1 行で機械可読に表現できます。

設計判断の背景は [`ADR-0007`](../adr/0007-dependency-dag-aware-scheduler.md)、syntax の真実は [`docs/specs/dependency-parser.md`](../specs/dependency-parser.md)、scheduler semantics の真実は [`docs/specs/dependency-resolver.md`](../specs/dependency-resolver.md) にあります。本セクションは利用者視点で「どう書くと何が起きるか」だけを扱います。

### Issue body に依存関係を書く

Issue 本文の **行頭 (前後の空白を許す)** に半角コロンの `Depends-On:` で始まる行を置きます。値は `#<番号>` のカンマ区切り。

```md
Depends-On: #123, #124
```

書きかたのポイント:

- ヘッダ部 (`Depends-On:`) は case-insensitive (`depends-on:` / `DEPENDS-ON:` でも可)
- コロンは **半角 `:` のみ受理** されます (全角 `：` は parse されません)
- `#` の前後の空白は許容 (`Depends-On:#123` / `Depends-On: # 123` どちらも OK)
- 同一 Issue 内に複数行書いてもよく、parser はすべての行を **union で集約** します
- code fence (` ``` ` / `~~~`) と blockquote (`> `) の中の `Depends-On:` は **無視** されます (引用や例示で誤認識しないため)
- cross-repository 表記 (`owner/repo#123`) は MVP では未対応 (`invalid` として扱われ dispatch されません)
- `Depends-On:` 行が無ければ依存なし (= 即 ready) とみなされます

### Todo に積んだあとに何が起きるか

候補 Issue 1 件に対して、scheduler は以下 4 値のいずれかに分類します。dispatch されるのは **`ready` のみ**。

| state                | 条件                                                                               | dispatch | log key (`philharmonic serve` の structured log) |
| -------------------- | ---------------------------------------------------------------------------------- | -------- | ------------------------------------------------ |
| `ready`              | `Depends-On:` 行が無い、または列挙された依存先がすべて closed                      | する     | (通常通り `dispatch success` / `failed` 等)      |
| `blocked`            | 列挙された依存先のうち 1 件以上が **open**                                         | しない   | info: `dependency blocked`                       |
| `invalid_dependency` | 依存先が存在しない (404) / 権限不足 (403) / parse 不能 (`owner/repo#N` / 数値以外) | しない   | warn: `dependency invalid`                       |
| `cycle`              | 依存グラフに循環がある (自己依存 `Depends-On: #self` を含む)                       | しない   | warn: `dependency cycle`                         |

優先順位は `cycle > invalid_dependency > blocked > ready`。複数該当する候補は上位 1 つだけが報告されます (例: cycle 中の候補が invalid な entry も持つ場合、`cycle` のみ報告)。

補足:

- 「closed-but-not-merged」も resolved 扱いです。`closed-as-not-planned` (Issue 不採用) で close された依存先も自動的に ready 化します (ADR-0007 §2)
- 依存先 Issue が **Project board に積まれていなくても** state (open / closed) で判定されます
- 依存先 Issue が `agent:skip` ラベル付き / assignee 不一致で dispatch 対象外でも、依存解決には影響しません (close されない限り `blocked` のまま)
- recovery (`philharmonic serve` 起動時の `In Progress` 引き取り) は dependency filter を **適用しません**。mid-execution の Issue が依存先後退で永遠に停止しないためです

### TUI / Snapshot API で blocked を確認する

`philharmonic.yaml` で `server.port` を設定して `philharmonic serve` を起動すると、Snapshot HTTP API の `scheduler` フィールドで直近 tick の評価結果が読めます。

```sh
# scheduler サマリだけ取り出す
curl -s http://127.0.0.1:4000/api/v1/state | jq .scheduler
```

```json
{
  "last_evaluated_at": "2026-05-09T00:00:30.000Z",
  "ready": [{ "issue_number": 104, "title": "Add foo handler" }],
  "blocked": [{ "issue_number": 102, "title": "Switch to async API", "blocked_by": [101] }],
  "cycles": [{ "issue_numbers": [201, 202] }],
  "invalid_dependencies": [
    {
      "issue_number": 103,
      "title": "Migrate legacy endpoint",
      "entries": [{ "raw": "owner/repo#123", "issue_number": null, "reason": "parse_invalid" }]
    }
  ]
}
```

`philharmonic dashboard` の TUI でも同じ情報が `Scheduler` セクションに表示されます (詳細: [`docs/specs/dashboard.md`](../specs/dashboard.md) `Scheduler section の表示ルール`)。`scheduler: null` のときは「まだ poll tick が走っていない」(= 起動直後 / recovery のみ走った状態) です。

フィールドの全表は [`docs/specs/snapshot-api.md`](../specs/snapshot-api.md) の `scheduler` フィールド節を参照してください。

### `agent:skip` との使い分け

| やりたいこと                                                                 | 使うもの                 |
| ---------------------------------------------------------------------------- | ------------------------ |
| **永続的に dispatch 対象外** にしたい (人間が直接書きたい / agent NG タスク) | `agent:skip` ラベル      |
| **一時的に順序を制御** したい (依存先 Issue が close されたら自動 ready 化)  | `Depends-On: #<番号>` 行 |

`agent:skip` は人間が外すまで永続的に effective です。`Depends-On:` は依存先 Issue が close されると次 tick で自動的に ready 判定に移ります。両方 effective な Issue は `agent:skip` の段階で先に弾かれるため、dependency filter には到達しません。

### `agent.max_concurrent_agents` との関係

DAG filter は **既存 candidate filter (status / assignee / `agent:skip` / worktree / in-flight) を全件通過した acceptable candidate に対して、最終段で `ready` のみを残す** filter です。`agent.max_concurrent_agents = N` は **その後に残った `ready` candidate の上から N 件を 1 tick で並列 dispatch** します。

| 設定                              | 1 tick の挙動                                                           |
| --------------------------------- | ----------------------------------------------------------------------- |
| `max_concurrent_agents: 1` (既定) | board 順で先頭の `ready` 1 件のみ dispatch (MVP 互換)                   |
| `max_concurrent_agents: 5`        | board 順で先頭の `ready` 5 件を並列 dispatch。`ready` が 5 未満なら全件 |

scheduler は **continuous worker pool ではなく tick-batched** で動作します (ADR-0007 §4)。1 件完走するたびに即次 candidate を pick するわけではなく、`Promise.allSettled` で N 件揃って完走を待ってから次 tick (= `polling.interval_ms` だけ sleep) に進みます。依存先 Issue が close された直後でも、後続 Issue が dispatch されるまでは **最大 `polling.interval_ms` 1 周期分** (既定 30 秒) のレイテンシがあります。

`philharmonic run` (1 ターン実行) も同じ DAG filter を経由します。先頭 candidate が `blocked` のときはその次の `ready` 1 件を選びます。

### 並列実行に向く / 向かない Issue

| 並列に向く                                                      | 並列に向かない (= `Depends-On:` で直列化を推奨)                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 互いに独立した bug fix (例: `#A` は logger / `#B` は formatter) | DB schema 変更 → API 変更 → frontend 変更 のような縦割り                 |
| 別 module / 別 directory に閉じる feature                       | 共有 module (例: `src/config.ts`) を同時に書き換える Issue               |
| ドキュメント更新と独立した実装                                  | 同じファイルを編集する複数 Issue (merge conflict が多発する)             |
| 依存関係が無く、PR レビューも独立してできるタスク               | 同じ Project Item Status に依存する workflow (Done 待ちの後続が並ぶ場合) |

並列 dispatch を増やしすぎると merge conflict / GitHub API rate limit / Claude Code subprocess の host 負荷で実質スループットが下がります。`max_concurrent_agents` は最初は `1` か `2` から始め、運用ログ (`dispatch success` / `dispatch failed` / `dependency blocked` の比率) を見て段階的に増やすのが安全です。

## トラブルシュート

### `claude` コマンドが見つからない

```
ClaudeNotInstalledError: claude command not found
```

→ Claude Code CLI がインストールされていない、または PATH に通っていません。`which claude` でパスを確認してください。

### `GITHUB_TOKEN` が設定されていない

```
環境変数 GITHUB_TOKEN / GH_TOKEN が設定されていません ...
```

→ default の `github.token_source: auto` でも env が空 + `gh auth login` 未実行のときに出ます。対処は次のいずれか:

- ホストで `gh auth login` を実行する (推奨。`auto` で透過的に拾われる)
- `export GITHUB_TOKEN=...` を設定する (CI / systemd / cron など非対話環境向け)
- `philharmonic.yaml` で `github.token_source: env` または `: gh` に固定する

`GITHUB_TOKEN` / `GH_TOKEN` は Runner subprocess にも allowlist 経由で渡され、agent が `gh` / `git push` で利用します。`gh` 経由で取得した token も orchestrator が `process.env.GITHUB_TOKEN` に書き戻すため、runner には透過的に届きます。

### `gh` コマンドが見つからない / `gh auth login` していない

```
gh コマンドが見つかりません ... / gh auth token から GitHub token を取得できませんでした ...
```

→ `github.token_source: gh` (または `auto` で env が空) のときの起動失敗です。`gh` をインストールして `gh auth login` するか、env で `GITHUB_TOKEN` を設定してください。

`gh` の **scope 不足** (PAT に Project / Issue / Contents 権限が無い等) はここでは検出できず、後続の GitHub API 呼び出し時に 403 で落ちます。`fine-grained` PAT の scope を見直してください。

### `philharmonic.yaml` が見つからない / 検証エラー

```
ConfigFileNotFoundError: ... / ConfigValidationError: ... / ConfigParseError: ...
```

→ ファイルパス・YAML 文法・型違反のいずれか。エラーメッセージにファイルパス・該当フィールド・期待値が出ます。フィールドの正確な型 / 下限などのフル仕様は [`docs/specs/config-schema.md`](../specs/config-schema.md) を参照してください。既定の探索先は `.philharmonic/philharmonic.yaml` です。旧来の repo root 直下 `philharmonic.yaml` のみ存在する場合は当面 fallback で読み込みつつ warning が出ます。`mkdir -p .philharmonic && git mv philharmonic.yaml .philharmonic/philharmonic.yaml` で移行してください。

### 候補 Issue が拾われない (`no candidate` ばかり)

以下を順に確認:

1. Issue が Project に追加されているか
2. その Project Item の `Status` が `dispatch_statuses` のいずれか (既定: `Todo`) になっているか
3. `agent_user_login` が `null` の場合、Issue が **unassigned** になっているか (assignee が居ると拾われない)
4. `agent_user_login` を指定している場合、その login が assignee に居るか
5. `philharmonic projects list` で Philharmonic の視点を確認
6. Issue 本文に `Depends-On:` 行があり、依存先の少なくとも 1 件が **open のまま** になっていないか (Snapshot HTTP API の `scheduler.blocked` か structured log の `dependency blocked` で確認できます。詳細: [依存関係付き Issue を運用する](#依存関係付き-issue-を運用する-dag-scheduling))

### `philharmonic serve` が「lock held」で起動しない

```
ServeLockHeldError: another `philharmonic serve` is running on this repo
```

→ 同一 repo で別の `philharmonic serve` が走っています (`.philharmonic/serve.lock`)。本当に走っていないなら、stale lock の可能性があります。詳細な対処は [`docs/specs/serve-daemon.md`](../specs/serve-daemon.md) を参照。

### Failed worktree が溜まっている

→ `philharmonic clean --dry-run` で削除候補を見て、問題なければ `philharmonic clean` を実行。あるいは個別に `git worktree remove --force <path>` で削除してから `git branch -D <branch>` でローカルブランチも掃除。

### 自動 retry が上限に到達した (`retry exhausted kind=failure`)

`agent.max_retry_attempts` (default 5) まで再試行しても回復しなかった Issue は、retry queue から落ち、`retry exhausted` warn ログと **failure summary** を残します。発生時の手順:

1. 構造化ログから `retry exhausted` (`kind=failure`) の行を見つけ、`failureSummaryPath` フィールドを開く

   ```sh
   philharmonic serve 2>&1 | jq -c 'select(.msg=="retry exhausted" and .kind=="failure")'
   ```

2. `failureSummaryPath` が示す `.philharmonic/runs/<run-id>/failure-summary.md` を開いて、failure reason / 直近 error / branch / worktree path / 関連 run artifact (`summary.md` / `stream.jsonl` / `stderr.log`) の場所を確認する
3. `summary.md` (Claude の最終応答) と `stderr.log` から原因を特定する
4. 必要なら `worktree path` の worktree を `git worktree remove --force <path>` で掃除するか、`philharmonic clean` で retention 経過後にまとめて掃除する
5. 再実行する場合は **`philharmonic retry <issue-number>`** で Status を `dispatch_statuses` に戻し、stale な worktree を cleanup します (詳細: [手動再実行](#philharmonic-retry-issue-number--手動再実行))。手動でやる場合は GitHub UI で Status を戻したうえで `git worktree remove --force <path>` (または `philharmonic clean --retention-days 0`) で worktree を消してください (`philharmonic clean` の default は `clean_retention_days` 経過後のみ削除するため、retry 直後の worktree は基本残ります)。orchestrator は次 tick で再 dispatch します

> orchestrator は ADR-0005 の方針 ([thin-orchestrator-agent-delegation](../adr/0005-thin-orchestrator-agent-delegation.md)) に従い、**Issue comment や Project Status の自動更新は行いません** (失敗時も含む)。failure summary は file + 構造化ログのみです。Issue comment 投稿 / `Failed` 自動遷移を将来的に opt-in 機能として追加する案は spec のオープンクエスチョン ([retry-queue.md](../specs/retry-queue.md#オープンクエスチョン)) に挙げています。

continuation retry (`kind=continuation`) の exhaustion は「agent が exit 0 だが Status を flip しないまま上限到達」した状態であり、failure ではないため failure summary は出しません (warn ログのみ)。Status を見て手動で `In Review` / `Failed` / `Done` に動かしてください。

### `Depends-On:` を書いた Issue が永遠に dispatch されない

Snapshot HTTP API の `scheduler` フィールド (`curl -s http://127.0.0.1:<port>/api/v1/state | jq .scheduler`) または `philharmonic dashboard` の `Scheduler` セクションを見ます。

- `blocked[]` に出ている: 依存先 Issue がまだ open です。先行 Issue を close するか、依存関係の記述を修正してください。`closed-as-not-planned` (Issue 不採用) で close されても resolved 扱いになります
- `invalid_dependencies[]` に出ている: 各 entry の `reason` を確認します
  - `parse_invalid`: cross-repo 表記 `owner/repo#N` は MVP 未対応。半角コロン `:` を使っているか / `#<番号>` 形式になっているかも確認 (全角 `：` / 数値以外は parse されません)
  - `not_found`: 依存先 Issue 番号が存在しない (タイポを疑う)
  - `forbidden`: PAT に依存先 Issue の read 権限がない
  - `fetch_error`: GitHub API エラー (network / rate limit 等)。次 tick で再評価されます
- `cycles[]` に出ている: 依存グラフに循環があります (自己依存 `Depends-On: #self` も含む)。orchestrator は cycle を解消しないため、人間が Issue body を書き換えて循環を断ち切ってください

Issue 本文の **code fence (` ``` ` で囲まれたブロック) や blockquote (`> `) の中に書いた `Depends-On:` は parser に無視される** ため、引用扱いになって ready 化されているケースもあります。意図せず parse されたい場合は本文の地の文に置きます。

### `philharmonic serve` 起動直後に `Depends-On:` を書いた Issue が dispatch される

recovery (起動時の `In Progress` 引き取り) は dependency filter を **適用しません**。前回プロセスで途中だった Issue が依存先後退で永遠に停止しないようにするためです (詳細: [`docs/specs/orchestration-mvp.md`](../specs/orchestration-mvp.md) `Dependency filter (ADR-0007)` 節)。通常の poll tick では DAG filter が必ず効きます。

### Runner timeout が頻発する

→ `timeout_ms` (既定 30 分) と `agent.stall_timeout_ms` (既定 5 分) を確認。複雑なタスクで 30 分が短いなら `timeout_ms` を上げる。Claude が API 応答待ちで止まるパターンが多いなら `agent.stall_timeout_ms` を下げて早期検知する。詳細: [`docs/specs/claude-runner.md`](../specs/claude-runner.md)。

### 失敗の原因をもっと深掘りしたい

`.philharmonic/runs/<run-id>/` を見るのが第一手。

```sh
# 直近の run を時刻順で見る (UUIDv7 はソート可能)
ls -1 .philharmonic/runs/ | tail -5

# stream.jsonl を眺める
jq -c '{type, subtype, is_error, result}' .philharmonic/runs/<run-id>/stream.jsonl | tail
```

`metadata.json` に `status` / `failure_reason` が入っているので、Failed の理由 (`workspace_provisioning` / `runner_error` / `timeout` / `stalled` / `hook_failed`) もここから読めます。Status flip / PR 作成は agent が runner 内で行うため、当該操作の失敗は `summary.md` (Claude の最終応答) と Issue / PR コメント側にも痕跡が残ります。
