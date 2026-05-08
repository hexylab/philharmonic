# Philharmonic

GitHub Projects v2 のアイテムを起点に Claude Code (headless mode) を分離環境で実行し、結果を Pull Request として人間レビューに回す coding-agent オーケストレータ。OpenAI Symphony から着想を得ている。

## ステータス

`initiation` milestone (Issue #1〜#6) を完了し、MVP の主要構成要素が揃いました。

- [x] 技術スタック / MVP スコープの確定 ([ADR-0001](./docs/adr/0001-initial-architecture.md))
- [x] GitHub Projects v2 候補取得 client (`philharmonic projects list` / [docs/specs/github-projects-v2.md](./docs/specs/github-projects-v2.md))
- [x] git worktree ベースの Workspace Manager ([docs/specs/workspace-manager.md](./docs/specs/workspace-manager.md))
- [x] Claude Code headless runner (`runClaude` / [docs/specs/claude-runner.md](./docs/specs/claude-runner.md))
- [x] Orchestration MVP の仕様書 ([docs/specs/orchestration-mvp.md](./docs/specs/orchestration-mvp.md))

CLI から 1 ターンを通しで回す `orchestrate` コマンド・設定ファイル読み込み・PR 作成・Status 更新は次フェーズで実装予定です。

## 必要なもの

- [Node.js](https://nodejs.org/) 22 LTS 以上
- [pnpm](https://pnpm.io/) ([Corepack](https://nodejs.org/api/corepack.html) 経由を推奨)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (Runner を実機で動かす場合のみ)
- GitHub Personal Access Token (`GITHUB_TOKEN` 環境変数。`projects` コマンドで使用)

## セットアップ

```sh
corepack enable
pnpm install
```

## 試す

ビルド後、CLI のヘルプとバージョンを確認できます。

```sh
pnpm build
node dist/cli.js --help
node dist/cli.js --version
```

GitHub Projects v2 から候補 Issue を一覧表示する例 (`GITHUB_TOKEN` が必要):

```sh
export GITHUB_TOKEN=ghp_xxxx
node dist/cli.js projects list --owner <owner> --project <project-number>
node dist/cli.js projects list --owner <owner> --project <project-number> --json
```

`--owner` は Project を所有する User / Organization の login、`--project` は Project URL 末尾の整数 (例: `https://github.com/users/hexylab/projects/1` の `1`) を指定します。

## ローカルコマンド

| 用途                                    | コマンド            |
| --------------------------------------- | ------------------- |
| ビルド                                  | `pnpm build`        |
| 型チェック (出力なし)                   | `pnpm typecheck`    |
| フォーマット (書き込み)                 | `pnpm format`       |
| フォーマット (チェックのみ / CI と同等) | `pnpm format:check` |
| Lint                                    | `pnpm lint`         |
| ユニットテスト                          | `pnpm test`         |
| ユニットテスト (watch)                  | `pnpm test:watch`   |

## 詳しく知るには

- 開発フロー / ブランチ戦略 / コミット規約: [AGENTS.md](./AGENTS.md)
- 設計判断 (なぜそう決めたか): [docs/adr/](./docs/adr/)
- 機能仕様 (何が・どう動くか): [docs/specs/](./docs/specs/)
- ドキュメント全体の入口: [docs/README.md](./docs/README.md)

## ライセンス

[MIT](./LICENSE)
