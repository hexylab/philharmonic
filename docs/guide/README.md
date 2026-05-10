# Philharmonic ユーザガイド

Philharmonic を **使う側** の視点からまとめた説明書です。インストールから日常運用、設定のカスタマイズ、トラブルシュートまでをタスク指向で扱います。仕様の真実 (フィールド全表 / state machine / API 全リファレンス) は [`docs/specs/`](../specs/) に置いてあるため、本ガイドは「どう使うか」だけを書き、必要な箇所からリンクで掘っていけるようにしています。

## ドキュメントの読みかた

| ドキュメント                                   | 役割                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[getting-started.md](./getting-started.md)** | 前提・インストール・`philharmonic init` での scaffold・GitHub 認証 (`gh auth` / `token_source: auto`)・Project Status 整備・`philharmonic serve` 起動までを一気通貫で通す       |
| **[configuration.md](./configuration.md)**     | `.philharmonic/philharmonic.yaml` の利用者視点での解説、`.philharmonic/WORKFLOW.md` (Liquid テンプレート) のカスタマイズ、`github.token_source` / `safety` / lifecycle hooks 等 |
| **[operations.md](./operations.md)**           | CLI コマンド (`run` / `serve` / `projects` / `clean` / `init`) の使い分け、構造化ログ、`.philharmonic/runs/`、Snapshot HTTP API、トラブルシュート (gh auth / scope / lock 等)   |

最初に Philharmonic を触るなら、`getting-started.md` をそのまま辿れば `philharmonic serve` を起動して 1 件目の Pull Request が立つところまで行けます。そこから先は「設定を絞り込みたい」なら `configuration.md`、「daemon を運用したい / 失敗を切り分けたい」なら `operations.md` に進んでください。

## 1 ターンで何が起きるか

Philharmonic の基本の使いかたは `philharmonic serve` の常駐デーモンです。daemon は `polling.interval_ms` (既定 30 秒) ごとに Project board を polling し、候補があれば以下の 1 ターン分の処理を **同一プロセスで逐次** 走らせて Pull Request にします (cron や CI から `philharmonic run` を呼んだ場合もこの 1 ターンが 1 回だけ走ります)。

```
   [Project: Todo]
        │
        │ Orchestrator が候補を pick → worktree 作成 → Claude Code 起動
        ▼
   [Agent in flight (Claude Code in worktree)]
        │
        │ ① agent: Status を In Progress に flip (`gh project item-edit`)
        │ ② agent: コードを書いて Conventional Commits で commit
        │ ③ agent: `git push -u origin <branch>`
        │ ④ agent: `gh pr create` で PR 作成 (Closes #N を含める)
        │ ⑤ agent: Status を In Review に flip
        ▼
   [Project: In Review]                ── 失敗時 ──▶  [Project: Failed]
        │                                                    │
        │ 人間レビュー + merge (Philharmonic の範囲外)        │ agent が Issue に失敗コメント (token / 機微情報なし)
        ▼                                                    │ 再実行は人手で Failed → Todo に戻すか別 Issue で
   [Project: Done]
```

Status 遷移 / PR 作成 / Issue コメントは **agent (Claude Code + `gh` CLI)** が runner subprocess 内で行います。Orchestrator は worktree を作って Claude を起動し、runner exit 0 のときだけ worktree を片付ける薄い役割に縮小されています。

`philharmonic serve` は SIGTERM / SIGINT を受信すると in-flight run の完了を待って graceful に exit します。並列 dispatch / Snapshot HTTP API は serve daemon のみが提供します (詳細: [operations.md](./operations.md))。`philharmonic run` は同じ 1 ターン分を 1 回だけ走らせて exit する単発モードで、cron / GitHub Actions の `schedule` 統合や動作検証用に使います。

## システム全体像

| コンポーネント                      | 役割                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator** (Node.js)          | Project poll / 候補選定 / git worktree 作成 / Runner 起動までを担う薄いレイヤ (GitHub への書き込みは行わない)                                   |
| **Runner** (Claude Code 子プロセス) | `claude -p ... --output-format stream-json` で起動。worktree を `cwd` として作業し、env allowlist 経由で `GITHUB_TOKEN` / `GH_TOKEN` を渡される |
| **Agent** (Claude Code in worktree) | `gh` / `git` で Status 遷移 / commit / push / PR 作成 / Issue コメント投稿を行う                                                                |
| **Workspace** (git worktree)        | `<repo>/.philharmonic/worktrees/issue-<番号>/`。1 タスク = 1 worktree = 1 ブランチ。失敗時は `philharmonic clean` で掃除                        |
| **Project Item Status**             | `Todo` → `In Progress` → `In Review` (or `Failed`)。**Agent** が `gh` で駆動。Orchestrator は読むだけ                                           |
| **Snapshot HTTP API** (任意)        | `philharmonic serve` 起動時に `127.0.0.1` の loopback で `/api/v1/state` 等を提供。dashboard / 外部監視向け                                     |

## より詳しく (仕様の真実)

- 設計判断 (なぜそう決めたか): [`docs/adr/`](../adr/)
- 機能仕様 (何が・どう動くか — フィールド表 / state machine / API): [`docs/specs/`](../specs/)
- リポジトリへのコントリビュート (ブランチ戦略 / コミット規約 / PR ルール / ドキュメント運用): [`AGENTS.md`](../../AGENTS.md)
