# Operations

日常運用 (CLI コマンド / 構造化ログ / 実行ファイル / Snapshot HTTP API / トラブルシュート) をまとめます。各機能の正確な仕様は [`docs/specs/`](../specs/) の対応 spec に置いています。

## CLI コマンドの早見表

| コマンド                     | 何をするか                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `philharmonic init`          | 対象リポジトリで `.philharmonic/philharmonic.yaml` を scaffold する (初回セットアップ用 / #66 / #67)    |
| `philharmonic projects list` | Project Item のうち Issue に紐づいたものを一覧表示する (dispatch 候補が見えているか確認)                |
| `philharmonic run`           | 1 ターン分の orchestration を実行する (1 件処理して exit)                                               |
| `philharmonic serve`         | 一定間隔でポーリングして候補があれば run を回す常駐デーモン (SIGTERM/SIGINT で graceful shutdown)       |
| `philharmonic clean`         | retention 経過済みの `issue-*` worktree とローカルブランチを掃除する (失敗 worktree のクリーンアップ用) |

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

> ADR-0005 で Status 遷移 / PR 作成 / Issue コメントは agent が `gh` 経由で行います。`success` の stdout に PR 番号は含まれません (PR 番号は agent が `gh pr create` で発行し、Issue / PR コメントから後追いするか `gh pr list` で確認してください)。

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

| 項目              | `run`           | `serve`                                                   |
| ----------------- | --------------- | --------------------------------------------------------- |
| 実行回数          | 1 ターンで exit | ポーリング loop で繰り返す                                |
| 並列 dispatch     | 無し            | `agent.max_concurrent_agents` で 1 tick 内に複数 dispatch |
| Tracker recovery  | 無し            | 起動時に `In Progress` の Issue を引き取る (#23)          |
| Snapshot HTTP API | 起動しない      | `server.port` 指定時に `127.0.0.1` で起動                 |
| 二重起動防止      | 無し            | `.philharmonic/serve.lock` で同一 repo の二重起動を弾く   |

> 自動 retry (`retry.*`) は ADR-0005 で撤廃されました。Failed の再実行は人手で `Todo` に戻すか別 Issue で起票します。

`permission_mode: bypass` を `serve` で使う場合は、長時間稼働で `--dangerously-skip-permissions` が連続発火することへの opt-in が必要です。`philharmonic.yaml` で `safety.allow_bypass_in_serve: true` を設定するか (#68 推奨)、環境変数 `PHILHARMONIC_ALLOW_BYPASS_IN_SERVE=1` を明示してください。両方未設定だと起動を拒否します。

詳細仕様 (lock file / signal handling / 並列 dispatch / Tracker recovery) は [`docs/specs/serve-daemon.md`](../specs/serve-daemon.md)。

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
| `/api/v1/state`          | GET    | 全体 snapshot (進行中の run / 累計コスト 等)                                        |
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

ADR-0005 で `GITHUB_TOKEN` / `GH_TOKEN` は Runner subprocess にも allowlist 経由で渡され、agent が `gh` / `git push` で利用します。`gh` 経由で取得した token も orchestrator が `process.env.GITHUB_TOKEN` に書き戻すため、runner には透過的に届きます。

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

→ ファイルパス・YAML 文法・型違反のいずれか。エラーメッセージにファイルパス・該当フィールド・期待値が出ます。`docs/specs/config-schema.md` のフィールド定義と突き合わせてください。既定の探索先は `.philharmonic/philharmonic.yaml` です (#67)。旧来の repo root 直下 `philharmonic.yaml` のみ存在する場合は当面 fallback で読み込みつつ warning が出ます。`mkdir -p .philharmonic && git mv philharmonic.yaml .philharmonic/philharmonic.yaml` で移行してください。

### 候補 Issue が拾われない (`no candidate` ばかり)

以下を順に確認:

1. Issue が Project に追加されているか
2. その Project Item の `Status` が `dispatch_statuses` のいずれか (既定: `Todo`) になっているか
3. `agent_user_login` が `null` の場合、Issue が **unassigned** になっているか (assignee が居ると拾われない)
4. `agent_user_login` を指定している場合、その login が assignee に居るか
5. `philharmonic projects list` で Philharmonic の視点を確認

### `philharmonic serve` が「lock held」で起動しない

```
ServeLockHeldError: another `philharmonic serve` is running on this repo
```

→ 同一 repo で別の `philharmonic serve` が走っています (`.philharmonic/serve.lock`)。本当に走っていないなら、stale lock の可能性があります。詳細な対処は [`docs/specs/serve-daemon.md`](../specs/serve-daemon.md) を参照。

### Failed worktree が溜まっている

→ `philharmonic clean --dry-run` で削除候補を見て、問題なければ `philharmonic clean` を実行。あるいは個別に `git worktree remove --force <path>` で削除してから `git branch -D <branch>` でローカルブランチも掃除。

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
