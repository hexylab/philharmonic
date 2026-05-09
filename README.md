# Philharmonic

GitHub Projects v2 のボードに積んだ Issue を **Claude Code (headless mode)** に渡し、隔離された git worktree で作業させて、結果を Pull Request として提出してくれる coding-agent オーケストレータです。OpenAI Symphony から着想を得ています。

「Todo にあるタスクを 1 件、Claude に投げて PR にする」を 1 コマンドで完結させます。

## こんなときに使えます

- GitHub Projects v2 のバックログを Claude Code に少しずつ消化させたい
- 作業ごとに worktree を分け、ホスト環境を汚さずに複数タスクを試したい
- Claude には GitHub token を渡さず、PR 作成や Status 遷移は自分側で握りたい
- 結果は必ず人間レビュー (PR) を経て `main` に入れたい

## 1 ターンで何が起きるか

`philharmonic run` を呼ぶと、以下が **同一プロセスで逐次** 実行されます。

1. Project の `Status = Todo` から候補 Issue を 1 件選ぶ (該当 0 件なら `no candidate` を出して exit 0)
2. Project Item の Status を `Todo → In Progress` に遷移
3. `origin/<base>` から `feature/<番号>-<slug>` の git worktree を作成
4. Issue 本文 (`## Goal` / `## Constraints` / `## Acceptance Criteria`) から prompt を組み立て
5. Claude Code を `--output-format stream-json --permission-mode <auto|bypass>` で起動
6. 生成された差分を `git push` し、Octokit で PR を作成
7. Status を `In Progress → In Review` に遷移し、worktree を片付ける

失敗時 (timeout / 差分ゼロ / push 失敗 / PR 作成失敗 など) は Issue に失敗コメントを残し、Status を `Failed` に落とし、exit 1 で終了します。

並列実行・自動 retry・自動 merge は行いません (1 コマンドで 1 ターン)。常駐させたい場合は同梱の `philharmonic serve` (一定間隔で `runOnce` を繰り返すデーモン) を使うか、`philharmonic run` を cron / systemd timer / GitHub Actions の `schedule` から呼んでください。

## 必要なもの

- [Node.js](https://nodejs.org/) 22 LTS 以上
- [pnpm](https://pnpm.io/) ([Corepack](https://nodejs.org/api/corepack.html) 経由を推奨)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) — `claude` コマンドにパスが通っていること
- GitHub Personal Access Token (fine-grained 推奨)
  - 必要 scope: 対象リポジトリの `Contents: RW` / `Pull requests: RW` / `Issues: RW`、対象 user/org の `Projects: RW`

## はじめかた

### 1. Philharmonic をビルドする

```sh
git clone https://github.com/hexylab/philharmonic.git
cd philharmonic
corepack enable
pnpm install
pnpm build
```

ビルドすると `dist/cli.js` が生成され、`node dist/cli.js ...` で起動できます。`pnpm link --global` でパスを通すと `philharmonic` コマンドとして使えます (以降の例ではこちらを前提にします)。

### 2. GitHub token を環境変数に置く

```sh
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

token は Orchestrator プロセスのみが保持し、Claude Code 子プロセスの環境変数からは自動的に除外されます。

### 3. 走らせたい対象リポジトリの直下に `philharmonic.yaml` を置く

最小構成:

```yaml
owner: your-github-login
project_number: 1
```

主なキー:

| キー                  | 既定値        | 説明                                                                                                                                                                                                                                           |
| --------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`               | (必須)        | Project owner の GitHub login (user または org)                                                                                                                                                                                                |
| `project_number`      | (必須)        | Project URL 末尾の整数 (`https://github.com/users/<owner>/projects/1` の `1`)                                                                                                                                                                  |
| `base_branch`         | `main`        | PR の base ブランチ                                                                                                                                                                                                                            |
| `status_field`        | `Status`      | Project の単一選択フィールド名                                                                                                                                                                                                                 |
| `workflow_file`       | `WORKFLOW.md` | repo root 直下の Liquid テンプレート (上位 prompt レイヤ)。存在すれば render され、無ければ既存の `buildPrompt` にフォールバック (詳細: [docs/specs/workflow.md](./docs/specs/workflow.md))                                                    |
| `agent_user_login`    | `null`        | `null` なら unassigned のみ拾う。bot に任せたいなら login を指定                                                                                                                                                                               |
| `permission_mode`     | `auto`        | Claude Code の permission mode (`auto` = `--permission-mode acceptEdits`、`bypass` = `--dangerously-skip-permissions`。`bypass` は worktree 外 (ホスト全体) にも副作用が及び得るため、git worktree + 非特権ユーザによる隔離前提でのみ使用する) |
| `timeout_ms`          | `1800000`     | Runner の timeout (ミリ秒)                                                                                                                                                                                                                     |
| `log_level`           | `info`        | 構造化ログの最低出力レベル (`debug` / `info` / `warn` / `error`)。詳細は [observability.md](./docs/specs/observability.md)                                                                                                                     |
| `polling.interval_ms` | `30000`       | `philharmonic serve` のポーリング間隔 (ミリ秒)。詳細は [serve-daemon.md](./docs/specs/serve-daemon.md)                                                                                                                                         |
| `retry.max_attempts`  | `3`           | `philharmonic serve` が `Failed` を自動的に `Todo` に戻す最大回数。`0` で自動 retry 無効化。詳細は [serve-daemon.md#自動-retry-22](./docs/specs/serve-daemon.md#自動-retry-22)                                                                 |

全キーの仕様は [docs/specs/config-schema.md](./docs/specs/config-schema.md) を参照してください。

### 4. Project 側の Status を整える

Philharmonic は Projects v2 の単一選択フィールド `Status` を駆動します。Project に以下のオプションが揃っていることを確認してください。

| 値          | 役割                                                         |
| ----------- | ------------------------------------------------------------ |
| Todo        | 候補のスタート地点 (人間が積む)                              |
| In Progress | Philharmonic が選定 → 実行中に遷移                           |
| In Review   | Philharmonic が PR 作成後に遷移 (人間レビュー待ち)           |
| Failed      | Philharmonic が失敗時に遷移 (再実行は人手で `Todo` へ戻す)   |
| Done        | マージ後の終端 (運用で更新。Philharmonic はこの遷移をしない) |

任せたい Issue を Project に追加して `Status = Todo` にしておけば拾われます。Issue 本文に `## Goal` / `## Constraints` / `## Acceptance Criteria` セクションを入れておくと prompt が綺麗に組み上がります (`.github/ISSUE_TEMPLATE/task.md` を参考に)。

## 使う

候補が拾えるか先に確認したいとき:

```sh
philharmonic projects list --owner <owner> --project <project-number>
philharmonic projects list --owner <owner> --project <project-number> --json
```

1 ターン実行:

```sh
philharmonic run
# 別パスの設定ファイルを指定する場合
philharmonic run --config ./path/to/philharmonic.yaml
```

出力:

- 候補 0 件 → `no candidate` を出して exit 0
- 成功 → `success run-id=... issue=#... pr=#... branch=...` を出して exit 0、PR が立つ
- 失敗 → Issue に失敗コメントが入り、Status `Failed`、exit 1

常駐デーモンとして使う:

```sh
# polling.interval_ms (default 30s) ごとに 1 件ずつ run を回す
philharmonic serve

# 別パスの設定ファイルを指定する場合
philharmonic serve --config ./path/to/philharmonic.yaml
```

`philharmonic serve` は SIGTERM / SIGINT を受信すると **in-flight run の完了を待ってから** graceful に exit します (subprocess 強制終了はしません)。systemd / Docker など PID 1 として走らせるユースケースでも安全です。詳細は [docs/specs/serve-daemon.md](./docs/specs/serve-daemon.md) を参照してください。

## ログとデバッグ

### 構造化ログ (stderr)

`philharmonic run` は進捗・警告・失敗を **JSON line 形式の構造化ログ** として `stderr` に出力します。
全イベントに `run_id` / `issue_number` が付き、Claude Code の subprocess 起動後は `session_id` も
付与されるため、`jq` で対象 run のログだけを絞り込めます。

```sh
# 対象 run のログだけ取り出す
philharmonic run 2>&1 1>/dev/null | jq -c 'select(.run_id == "01956a91-...")'

# warn 以上だけ取り出す
philharmonic run 2>&1 1>/dev/null | jq -c 'select(.level == "warn" or .level == "error")'
```

`stdout` には人間向けの結果 (`success run-id=... pr=#... branch=...` / `no candidate`) のみが出るため、
shell スクリプトで結果を読み取るときと、ログを別途集計するときの責務が分離されています。

レベルは `philharmonic.yaml` の `log_level` で制御します (詳細: [docs/specs/observability.md](./docs/specs/observability.md))。

### 実行ファイル

実行ごとに **対象リポジトリ** の `.philharmonic/runs/<run-id>/` に以下が残ります (`run-id` は UUIDv7 で時刻順ソート可能)。

| ファイル        | 内容                                                 |
| --------------- | ---------------------------------------------------- |
| `prompt.md`     | Claude に渡した prompt 全文                          |
| `stream.jsonl`  | Claude Code の stream-json 出力 (1 行 1 イベント)    |
| `stderr.log`    | Claude Code の stderr                                |
| `metadata.json` | run-id / issue / branch / PR 番号 / cost / status 等 |
| `summary.md`    | Claude の最終応答 (Markdown 整形済み)                |

worktree は **成功時のみ自動削除** されます。失敗時は `.philharmonic/worktrees/issue-<番号>/` に残るので、調査後に `git worktree remove --force <path>` で手動削除するか、`philharmonic clean` で retention 経過後にまとめて掃除してください。

```sh
# 削除候補の確認 (何も削除しない)
philharmonic clean --dry-run

# retention 経過済みの worktree とローカルブランチを掃除する
philharmonic clean

# retention をその場で上書き (config の clean_retention_days より優先)
philharmonic clean --retention-days 3
```

`clean` の対象は `<workspace_root>/issue-*` worktree とそれに紐づくローカルブランチに限定されます。`main` などの主リポジトリ worktree や `issue-*` 以外のディレクトリは構造的に保護されます (詳細: [docs/specs/orchestration-mvp.md](./docs/specs/orchestration-mvp.md#philharmonic-clean-失敗-worktree-のクリーンアップ))。

## もっと知る

- 設計判断 (なぜそう決めたか): [docs/adr/](./docs/adr/)
- 機能仕様 (何が・どう動くか): [docs/specs/](./docs/specs/)
- リポジトリへのコントリビュート (ブランチ戦略 / コミット規約 / PR ルール): [AGENTS.md](./AGENTS.md)

## ライセンス

[MIT](./LICENSE)
