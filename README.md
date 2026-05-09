# Philharmonic

> **GitHub Projects v2 の Todo に積んだ Issue を、隔離された git worktree の中で Claude Code に解かせ、Pull Request として返してもらう coding-agent オーケストレータ。**

[OpenAI Symphony](https://github.com/openai/symphony) から着想を得た TypeScript / Node.js 実装で、個人開発者や小規模チームが「やりたいけど手が回っていないタスク」を Claude Code に少しずつ消化させたいときに使えます。

```
   GitHub Projects v2: Todo
            │
            │   $ philharmonic run
            ▼
   隔離 git worktree で Claude Code (headless mode)
            │
            ▼
      Pull Request (Status: In Review)
```

最小設定 2 行と 1 コマンドで、Claude Code に GitHub の鍵を渡さずにコード生成 → PR 化までを任せられます。最後の merge 判断は必ず人間に残ります。

## なぜ Philharmonic を使うのか

- **Issue → Pull Request まで 1 コマンド**: `philharmonic run` を 1 度叩けば、候補選定 → worktree 作成 → Claude Code 起動 → push → PR 作成 → Project Status 遷移までが同一プロセスで終わる
- **Claude には GitHub token を渡さない**: token は Orchestrator のみが保持。Runner の env は allowlist で絞られ、PR 作成や Status 駆動はすべて Orchestrator 側が握る
- **タスクごとに git worktree で隔離**: 作業は `.philharmonic/worktrees/issue-<番号>/` の中だけ。ホスト環境を汚さず、複数タスクを並行して試せる
- **常駐デーモンも cron 駆動も両対応**: 一発実行 (`philharmonic run`) と常駐ポーリング (`philharmonic serve`) を同梱。`serve` は SIGTERM で graceful shutdown し、`localhost` の Snapshot HTTP API でダッシュボードを繋げられる
- **`WORKFLOW.md` で prompt をカスタマイズ**: Liquid テンプレートでリポジトリごとに Claude への指示を自由に組み立てられる
- **Lifecycle hooks**: workspace 作成直後に `pnpm install`、削除直前に cleanup スクリプト、といった shell コマンドをイベントごとに差し込める

## 1 分で動かす

前提: Node.js 22 LTS / pnpm / [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) / GitHub Projects v2 / GitHub PAT (対象リポジトリの `Contents: RW` / `Pull requests: RW` / `Issues: RW` + 対象 user/org の `Projects: RW`)

```sh
# 1) Philharmonic をビルド & コマンドにパスを通す
git clone https://github.com/hexylab/philharmonic.git
cd philharmonic
corepack enable
pnpm install && pnpm build
pnpm link --global

# 2) GitHub token を環境変数に置く (この token は Claude に渡されない)
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# 3) 動かしたい先のリポジトリに philharmonic.yaml を置く
cd /path/to/your-repo
cat > philharmonic.yaml <<'EOF'
owner: your-github-login
project_number: 1
EOF

# 4) Project の Todo に Issue を 1 件積んでから:
philharmonic run
```

`success run-id=... issue=#... pr=#... branch=...` が出れば、PR が立って Project Status は `In Review` まで進んでいます。失敗時は Issue に失敗コメントが残り、Status は `Failed`、exit code は 1 になります。

ステップごとの詳しい手順 (Project Status の整備 / Issue 本文の書きかた / 候補確認コマンド 等) は [`docs/guide/getting-started.md`](./docs/guide/getting-started.md) を参照してください。

## ユーザガイド

| ドキュメント                                                       | 内容                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [`docs/guide/README.md`](./docs/guide/README.md)                   | ユーザガイドの目次と、1 ターンで何が起きるかの全体像                                     |
| [`docs/guide/getting-started.md`](./docs/guide/getting-started.md) | 前提・インストール・最小設定・Project Status 整備・初回実行までの一気通貫                |
| [`docs/guide/configuration.md`](./docs/guide/configuration.md)     | `philharmonic.yaml` / `WORKFLOW.md` / lifecycle hooks のカスタマイズ                     |
| [`docs/guide/operations.md`](./docs/guide/operations.md)           | CLI コマンド / 構造化ログ / `.philharmonic/runs/` / Snapshot HTTP API / トラブルシュート |

## もっと知る

- 機能仕様の真実 (フィールド全表 / state machine / API 全定義): [`docs/specs/`](./docs/specs/)
- 設計判断の記録 (なぜそう決めたか): [`docs/adr/`](./docs/adr/)
- リポジトリへのコントリビュート (ブランチ戦略 / コミット規約 / PR ルール / ドキュメント運用): [`AGENTS.md`](./AGENTS.md)

## ライセンス

[MIT](./LICENSE)
