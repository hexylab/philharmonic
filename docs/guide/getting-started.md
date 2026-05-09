# Getting Started

Philharmonic を初めて動かすときの一気通貫の手順です。完了すると、GitHub Projects v2 の Todo に置いた Issue 1 件が Claude Code に処理され、`In Review` の Pull Request として返ってくる状態になります。

## 1. 必要なもの

| 項目                                                           | 必要バージョン / 備考                                                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [Node.js](https://nodejs.org/)                                 | **22 LTS 以上**                                                                                                                          |
| [pnpm](https://pnpm.io/)                                       | [Corepack](https://nodejs.org/api/corepack.html) 経由 (`corepack enable`) を推奨                                                         |
| [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) | `claude` コマンドにパスが通っていること。Philharmonic は `claude -p ... --output-format stream-json` で headless mode を起動します       |
| GitHub Personal Access Token                                   | fine-grained PAT 推奨。必要 scope: 対象リポジトリの `Contents: RW` / `Pull requests: RW` / `Issues: RW`、対象 user/org の `Projects: RW` |
| GitHub Projects v2                                             | 1 つ。後述する `Status` の単一選択フィールドが必要 (デフォルトの Status を流用してよい)                                                  |
| 対象リポジトリ                                                 | Philharmonic を **動かしたい先のリポジトリ**。Philharmonic 自身を clone するリポジトリとは別物                                           |

## 2. Philharmonic をビルドする

```sh
git clone https://github.com/hexylab/philharmonic.git
cd philharmonic
corepack enable
pnpm install
pnpm build
```

`dist/cli.js` が生成されます。`node dist/cli.js ...` で起動できますが、`pnpm link --global` でパスを通しておくと `philharmonic` コマンドとして使えるようになります。本ガイドはこちらを前提にします。

```sh
pnpm link --global
philharmonic --help
```

## 3. GitHub token を環境変数に置く

```sh
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

Philharmonic は `GITHUB_TOKEN` を **Orchestrator プロセスのみ** が保持します。Claude Code 子プロセスの環境変数からは自動的に除外されるため、Claude には GitHub への鍵が渡りません (allowlist 方式の env フィルタは [`docs/specs/claude-runner.md`](../specs/claude-runner.md) を参照)。

## 4. 対象リポジトリに `philharmonic.yaml` を置く

Philharmonic を **動かしたい先のリポジトリのルート** に最小構成で置きます。

```yaml
# philharmonic.yaml (最小構成)
owner: your-github-login
project_number: 1
```

| キー             | 説明                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `owner`          | Project owner の GitHub login (user または org)                                  |
| `project_number` | Project URL 末尾の整数。例: `https://github.com/users/<owner>/projects/1` の `1` |

これだけで動きます。ベースブランチを `main` 以外にする、`Status` 以外の field 名にする、`Todo` 以外の Status を dispatch 対象にする、常駐デーモンや lifecycle hooks をカスタマイズする、といった設定は [configuration.md](./configuration.md) を参照してください。

> **注意**: `philharmonic.yaml` は **対象リポジトリ側に置きます** (Philharmonic 自身の clone ではありません)。`philharmonic` コマンドは原則として対象リポジトリのルートで実行します。

## 5. Project の Status を整える

Philharmonic は Projects v2 の単一選択フィールド `Status` を駆動します。Project に以下のオプションが揃っていることを確認してください (新規作成した Project であれば `Todo` / `In Progress` / `Done` は最初から入っています。`In Review` / `Failed` は手動で追加が必要)。

| 値          | 役割                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Todo        | 候補のスタート地点 (人間がここに積む)                                                                          |
| In Progress | Philharmonic が候補選定 → 実行中に遷移させる                                                                   |
| In Review   | Philharmonic が PR を作成した後に遷移させる (人間レビュー待ち)                                                 |
| Failed      | Philharmonic が失敗時に遷移させる (再実行は人手で `Todo` に戻すか、`philharmonic serve` の自動 retry に任せる) |
| Done        | merge 後の終端。Philharmonic はこの遷移を **行わない** (人間 / 別ツールで管理)                                 |

Status 名やどの Status を dispatch 対象にするかはカスタマイズできます (`status_field` / `dispatch_statuses`)。詳細は [configuration.md](./configuration.md) を参照。

## 6. 任せたい Issue を Project に積む

Philharmonic は Issue 本文の以下 3 セクションから prompt を組み立てます。`.github/ISSUE_TEMPLATE/task.md` をベースにすると綺麗にハマります。

```markdown
## Goal

<!-- 達成したいことを 1〜3 文 -->

## Constraints

<!-- 制約条件 (使うライブラリ・性能・互換性 等) -->

-

## Acceptance Criteria

<!-- 客観的に判定可能な完了条件 -->

- [ ]
- [ ]
```

Issue を Project に追加し、`Status = Todo` にしておけば候補に入ります。

> `WORKFLOW.md` (Liquid テンプレート) をリポジトリ直下に置けば、prompt 構造そのものをカスタマイズできます (詳細: [configuration.md](./configuration.md#workflowmd-で-prompt-をカスタマイズする))。

## 7. 候補が拾えるか確認する

実行する前に、Philharmonic から見えている候補を一覧で確認できます。

```sh
philharmonic projects list --owner <owner> --project <project-number>

# JSON で取り出したい場合
philharmonic projects list --owner <owner> --project <project-number> --json
```

`Status: Todo` の Issue が表示されない場合は、Project への追加忘れ・Status 設定漏れ・assignee 設定 (`agent_user_login`) のいずれかを疑ってください。

## 8. `philharmonic serve` を起動する

Philharmonic の基本の使いかたは、`philharmonic serve` を **常駐デーモン** として起動しっぱなしにしておくことです。`polling.interval_ms` (既定 30 秒) ごとに Project board を polling し、Todo にチケットが積まれたら自動的に dispatch されて PR が立ちます。

```sh
philharmonic serve

# 別パスの設定ファイルを指定する場合
philharmonic serve --config ./path/to/philharmonic.yaml
```

`stdout` には起動・停止メッセージなど最低限のみが流れ、`stderr` に JSON line 形式の構造化ログが流れます。

```sh
# 進捗ログを人間向けに眺める
philharmonic serve 2>&1 1>/dev/null | jq -c '{ts, level, msg, run_id, issue_number}'
```

Todo に Issue を積めば、次の polling tick で以下のような流れがログに現れます。

| 主なログイベント                                              | タイミング                            |
| ------------------------------------------------------------- | ------------------------------------- |
| `poll tick`                                                   | polling 周期ごと                      |
| `candidate selected` / `dispatch success` / `dispatch failed` | 候補があったとき (1 件処理ごと)       |
| `no candidate`                                                | Todo が空のとき                       |
| `runner finished`                                             | Claude Code subprocess が終了したとき |

成功時は Project Status が `In Review` まで進み、PR が立ちます。失敗時は Issue に失敗コメントが残り、Status が `Failed` に (`philharmonic serve` は `retry.max_attempts` の範囲で自動的に `Todo` に戻して再試行します)。

### 停止のしかた

`philharmonic serve` は **SIGTERM / SIGINT** を受信すると、in-flight の run の完了を待ってから graceful に exit します (subprocess を強制終了したりはしない)。

```sh
# 前景で動かしているなら Ctrl+C を 1 回押す (= SIGINT)
# systemd や docker などで管理しているなら SIGTERM を送る
```

graceful shutdown 中の exit code は **0** です。systemd / Docker など PID 1 として走らせるユースケースでも安全に使えます。

### 観測 (Snapshot HTTP API)

`philharmonic.yaml` の `server.port` を指定すると、`philharmonic serve` 起動時に `127.0.0.1:<port>` に read-only な HTTP API が立ちます。dashboard や外部 health-check 用です。

```yaml
server:
  port: 4000
```

```sh
curl -s http://127.0.0.1:4000/api/v1/state | jq .
```

詳細は [operations.md#snapshot-http-api-philharmonic-serve-専用](./operations.md#snapshot-http-api-philharmonic-serve-専用) を参照。

### 単発で試したい / cron 駆動したい場合

1 件だけ動作確認したいとき、cron / systemd timer / GitHub Actions の `schedule` から呼びたいときは、daemon を立ち上げずに **単発実行** の `philharmonic run` を使えます (1 ターンで exit)。

```sh
philharmonic run
```

`philharmonic run` の出力 / `serve` との違い (自動 retry / 並列 dispatch / Snapshot API は `serve` のみ) は [operations.md#philharmonic-run--1-ターン実行](./operations.md#philharmonic-run--1-ターン実行) を参照してください。

## 次に読む

- 設定をカスタマイズしたい (Status 名 / WORKFLOW.md / hooks / serve daemon / Snapshot API) → [configuration.md](./configuration.md)
- 日常運用 (CLI 各コマンド / 構造化ログ / `.philharmonic/runs/` / トラブルシュート) → [operations.md](./operations.md)
- 仕様の真実 (フィールド全表 / state machine / API 仕様) → [`docs/specs/`](../specs/)
