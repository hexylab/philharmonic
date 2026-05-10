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

Philharmonic は `GITHUB_TOKEN` / `GH_TOKEN` を Orchestrator + Runner の env allowlist 経由で透過させ、agent (Claude Code + `gh` CLI) が Status 遷移 / `git push` / PR 作成 / Issue コメント投稿に使います ([ADR-0005](../adr/0005-thin-orchestrator-agent-delegation.md))。fine-grained PAT (対象リポジトリと Project に絞ったもの) を強く推奨します。

> ホストで `gh auth login` 済みなら env 未設定でも動作します (`~/.config/gh` を runner subprocess が読みます)。daemon 用途や CI 用途では env 経由が確実です。

## 4. 対象リポジトリで `philharmonic init` を実行する

Philharmonic を **動かしたい先のリポジトリのルート** で `philharmonic init` を実行すると、最小構成の `.philharmonic/philharmonic.yaml` が scaffold されます (#67 で生成先を `.philharmonic/` 配下に集約)。対話的に主要項目だけを訊き、残りは default で埋めた yaml にコメント化されたサンプルが同梱されるので「どこをいじれば何が変わるか」が yaml 内から発見できます。

```sh
cd /path/to/target-repo
philharmonic init
```

対話モードで訊かれる項目は最小限です:

| 項目                                                                              | default                                                                                 |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `owner`                                                                           | `git remote get-url origin` から auto-detect                                            |
| `project_number`                                                                  | (必須・default なし)                                                                    |
| `permission_mode: bypass` を採用するか?                                           | Y/n。ADR-0005 により agent 委譲には実用上必須                                           |
| `.philharmonic/WORKFLOW.md` を scaffold するか?                                   | y/N。後から手で書いてもよい                                                             |
| `.philharmonic/` 生成物 (`worktrees/` / `runs/` / `serve.lock`) を ignore するか? | Y/n。`.gitignore` が既に存在する場合のみ訊く。config 本体は commit 可能なまま残す (#67) |

完全に非対話的に scaffold したい場合は flag だけで完走させられます。

```sh
# 非対話 (CI 等で使う)
philharmonic init --yes --owner your-github-login --project 1
```

| Flag              | 効果                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| `--owner <login>` | owner を flag で指定 (省略時は origin remote から auto-detect)            |
| `--project <n>`   | project_number を flag で指定                                             |
| `--yes`           | 対話プロンプトをすべてスキップ (非対話モード)                             |
| `--force`         | 既存の `.philharmonic/philharmonic.yaml` を上書きする                     |
| `--dry-run`       | 実ファイルを書かず、生成予定の内容を stdout に出すだけ                    |
| `--no-workflow`   | `.philharmonic/WORKFLOW.md` の scaffold をスキップ (対話プロンプトを抑止) |

非 TTY 環境 (`process.stdout.isTTY === false`) では自動的に `--yes` 相当に降格します。必須項目 (`owner` / `project_number`) が flag 経由でも揃わない場合は exit code 非ゼロで失敗します。

> **注意**: `.philharmonic/philharmonic.yaml` は **対象リポジトリ側に置きます** (Philharmonic 自身の clone ではありません)。`philharmonic` コマンドは原則として対象リポジトリのルートで実行します。

> 生成される yaml は `owner` / `project_number` のみ active で、それ以外のキー (`base_branch` / `status_field` / `dispatch_statuses` / `polling` / `server` / `hooks` 等) はコメントで default が同梱されます。`#` を外すと有効化できます。詳細は [configuration.md](./configuration.md) を参照してください。

> **既存ユーザー向けの移行 (#67)**: 旧来 repo root 直下に置いていた `philharmonic.yaml` / `WORKFLOW.md` は当面そのまま動作しますが、起動時に warning が出ます。`mkdir -p .philharmonic && git mv philharmonic.yaml .philharmonic/philharmonic.yaml` (および `WORKFLOW.md` も同様) で移行してください。

### コピペで書きたい場合 (副次的手順)

`philharmonic init` を使わず、`.philharmonic/philharmonic.yaml` を手で書いても OK です。最小構成は次の 2 行だけです。

```sh
mkdir -p .philharmonic
cat > .philharmonic/philharmonic.yaml <<'EOF'
# .philharmonic/philharmonic.yaml (最小構成)
owner: your-github-login
project_number: 1
EOF
```

| キー             | 説明                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `owner`          | Project owner の GitHub login (user または org)                                  |
| `project_number` | Project URL 末尾の整数。例: `https://github.com/users/<owner>/projects/1` の `1` |

ベースブランチを `main` 以外にする、`Status` 以外の field 名にする、`Todo` 以外の Status を dispatch 対象にする、常駐デーモンや lifecycle hooks をカスタマイズする、といった設定は [configuration.md](./configuration.md) を参照してください。

## 5. Project の Status を整える

Philharmonic は Projects v2 の単一選択フィールド `Status` を **読むだけ** (候補選定用) で、書き込みは agent が `gh project item-edit` 等で行います。Project に以下のオプションが揃っていることを確認してください。

| 値          | 役割                                                | 駆動元                             |
| ----------- | --------------------------------------------------- | ---------------------------------- |
| Todo        | 候補のスタート地点                                  | 人間が積む                         |
| In Progress | agent 実行中                                        | **Agent** (prompt 受領直後に flip) |
| In Review   | PR 作成完了。人間レビュー待ち                       | **Agent** (PR 作成後に flip)       |
| Failed      | 失敗時。人手で `Todo` に戻すか、別 Issue で対応する | **Agent** (失敗判断時に flip)      |
| Done        | merge 後の終端                                      | 人間 / 別ツール                    |

Status 名やどの Status を dispatch 対象にするかはカスタマイズできます (`status_field` / `dispatch_statuses`)。詳細は [configuration.md](./configuration.md) を参照。

> **`permission_mode` の注意**: agent が `gh` / `git push` を実行するには Bash tool が必要なため、`permission_mode: bypass` の設定が **実用上必須** です (`auto` では Bash tool が対話プロンプトになり、headless 環境では permission denied になります)。`bypass` は worktree 外への副作用リスクを伴うため、隔離環境前提で使ってください ([ADR-0005](../adr/0005-thin-orchestrator-agent-delegation.md))。

## 6. 任せたい Issue を Project に積む

Issue 本文は **自由フォーマット** で構いません ([ADR-0005](../adr/0005-thin-orchestrator-agent-delegation.md) で構造化セクション必須は撤廃されました)。Philharmonic は本文をそのまま agent に渡します。書きやすいガイドの一例:

```markdown
<!-- 達成したいこと / 完了条件 / 関連 Issue / 背景 などを自由に書く -->
```

Issue を Project に追加し、`Status = Todo` にしておけば候補に入ります。Status 遷移 / commit / push / PR 作成は agent が prompt 指示に従って完結します。

> `.philharmonic/WORKFLOW.md` (Liquid テンプレート) を置けば、prompt 構造そのものをカスタマイズできます (詳細: [configuration.md](./configuration.md#workflowmd-で-prompt-をカスタマイズする))。

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
philharmonic serve --config ./path/to/.philharmonic/philharmonic.yaml
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

成功時は agent が PR を立てて Status を `In Review` に遷移します。失敗時は agent が判断で Status を `Failed` に遷移し、必要に応じて Issue にコメントを残します。再実行は人手で `Failed → Todo` に戻すか、別 Issue で再起票します ([ADR-0005](../adr/0005-thin-orchestrator-agent-delegation.md) で自動 retry は撤廃)。

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
