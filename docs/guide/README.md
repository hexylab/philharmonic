# Philharmonic ユーザガイド

Philharmonic を **使う側** の視点からまとめた説明書です。インストールから日常運用、設定のカスタマイズ、トラブルシュートまでをタスク指向で扱います。仕様の真実 (フィールド全表 / state machine / API 全リファレンス) は [`docs/specs/`](../specs/) に置いてあるため、本ガイドは「どう使うか」だけを書き、必要な箇所からリンクで掘っていけるようにしています。

## ドキュメントの読みかた

| ドキュメント                                   | 役割                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **[getting-started.md](./getting-started.md)** | 前提・インストール・GitHub token・最小設定・Project Status の整備・最初の `philharmonic run` までを一気通貫で通す                        |
| **[configuration.md](./configuration.md)**     | `philharmonic.yaml` の利用者視点での解説、`WORKFLOW.md` (Liquid テンプレート) のカスタマイズ、lifecycle hooks の使いかた                 |
| **[operations.md](./operations.md)**           | CLI コマンド (`run` / `serve` / `projects` / `clean`) の使い分け、構造化ログ、`.philharmonic/runs/`、Snapshot HTTP API、トラブルシュート |

最初に Philharmonic を触るなら、`getting-started.md` をそのまま辿れば 1 件目の Pull Request が立つところまで行けます。そこから先は「設定を絞り込みたい」なら `configuration.md`、「常駐させて運用したい」なら `operations.md` に進んでください。

## 1 ターンで何が起きるか

Philharmonic の基本の使いかたは `philharmonic serve` の常駐デーモンです。daemon は `polling.interval_ms` (既定 30 秒) ごとに Project board を polling し、候補があれば以下の 1 ターン分の処理を **同一プロセスで逐次** 走らせて Pull Request にします (cron や CI から `philharmonic run` を呼んだ場合もこの 1 ターンが 1 回だけ走ります)。

```
   [Project: Todo]
        │
        │ ① 候補 Issue を 1 件選ぶ (なければ no candidate / 次の tick へ)
        ▼
   [Project: In Progress]
        │
        │ ② origin/main から git worktree を作成
        │ ③ Issue 本文 (or WORKFLOW.md) から prompt を組み立て
        │ ④ Claude Code を headless mode で起動 (token は渡さない)
        │ ⑤ 生成された差分を git push
        │ ⑥ Octokit で Pull Request を作成
        ▼
   [Project: In Review]                 ── 失敗時 ──▶  [Project: Failed]
        │                                                    │
        │ ⑦ 人間レビュー + merge (Philharmonic の範囲外)      │ Issue に失敗コメント
        ▼                                                    │ (serve daemon は retry.max_attempts の範囲で自動的に Todo に戻す)
   [Project: Done]
```

`philharmonic serve` は SIGTERM / SIGINT を受信すると in-flight run の完了を待って graceful に exit します。並列 dispatch / 自動 retry / Snapshot HTTP API は serve daemon のみが提供します (詳細: [operations.md](./operations.md))。`philharmonic run` は同じ 1 ターン分を 1 回だけ走らせて exit する単発モードで、cron / GitHub Actions の `schedule` 統合や動作検証用に使います。

## システム全体像

| コンポーネント                      | 役割                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Orchestrator** (Node.js)          | GitHub API・git worktree・Runner 起動・PR 作成を司る本体。GitHub token を **唯一** 保持するレイヤ                        |
| **Runner** (Claude Code 子プロセス) | `claude -p ... --output-format stream-json` で起動。worktree を `cwd` として作業し、token は **渡されない**              |
| **Workspace** (git worktree)        | `<repo>/.philharmonic/worktrees/issue-<番号>/`。1 タスク = 1 worktree = 1 ブランチ。失敗時は `philharmonic clean` で掃除 |
| **Project Item Status**             | `Todo` → `In Progress` → `In Review` (or `Failed`)。Orchestrator が GitHub Projects v2 GraphQL 経由で駆動                |
| **Snapshot HTTP API** (任意)        | `philharmonic serve` 起動時に `127.0.0.1` の loopback で `/api/v1/state` 等を提供。dashboard / 外部監視向け              |

## より詳しく (仕様の真実)

- 設計判断 (なぜそう決めたか): [`docs/adr/`](../adr/)
- 機能仕様 (何が・どう動くか — フィールド表 / state machine / API): [`docs/specs/`](../specs/)
- リポジトリへのコントリビュート (ブランチ戦略 / コミット規約 / PR ルール / ドキュメント運用): [`AGENTS.md`](../../AGENTS.md)
