# Philharmonic

GitHub Projects v2 のアイテムを起点に Claude Code (headless mode) を分離環境で実行し、結果を Pull Request として人間レビューに回す coding-agent オーケストレータ。OpenAI Symphony から着想を得ている。

## ステータス

`mvp-runtime` milestone まで進み、CLI から 1 ターンを通しで実行する `philharmonic run` コマンドが利用可能になりました。

- [x] 技術スタック / MVP スコープの確定 ([ADR-0001](./docs/adr/0001-initial-architecture.md))
- [x] GitHub Projects v2 候補取得 client (`philharmonic projects list` / [docs/specs/github-projects-v2.md](./docs/specs/github-projects-v2.md))
- [x] git worktree ベースの Workspace Manager ([docs/specs/workspace-manager.md](./docs/specs/workspace-manager.md))
- [x] Claude Code headless runner (`runClaude` / [docs/specs/claude-runner.md](./docs/specs/claude-runner.md))
- [x] 設定ファイル / GitHub REST client / Prompt 構築 / Run Log 永続化
- [x] 1 ターン orchestration loop (`philharmonic run` / [docs/specs/orchestration-mvp.md](./docs/specs/orchestration-mvp.md))

並列実行 / 自動 retry / 自動 merge は MVP の対象外です (Phase 2 で別 Issue として扱います)。

## 必要なもの

- [Node.js](https://nodejs.org/) 22 LTS 以上
- [pnpm](https://pnpm.io/) ([Corepack](https://nodejs.org/api/corepack.html) 経由を推奨)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (Runner を実機で動かす場合のみ)
- GitHub Personal Access Token (`GITHUB_TOKEN` 環境変数。`projects` / `run` コマンドで使用)

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

### 1 ターンの orchestration を実行する (`philharmonic run`)

`philharmonic.yaml` をリポジトリ直下に置き、`GITHUB_TOKEN` を設定したうえで以下を実行すると、`Status = Todo` の候補 Issue を 1 件だけ拾って Claude Code を分離 worktree で起動し、PR まで作成します。

```sh
export GITHUB_TOKEN=ghp_xxxx
node dist/cli.js run
```

主な動作:

- 候補 0 件のときは `no candidate` を出力して exit 0 (no-op)
- 成功時は Status を `Todo → In Progress → In Review` に遷移させ、PR を作成して exit 0
- Runner 失敗 / 差分なし / push 失敗 / PR 作成失敗 時は Issue (PR ではない) に失敗コメントを残し、Status を `Failed` に遷移させて exit 1

設定キーの仕様は [docs/specs/config-schema.md](./docs/specs/config-schema.md)、状態遷移と Failure ハンドリングの仕様は [docs/specs/orchestration-mvp.md](./docs/specs/orchestration-mvp.md) を参照してください。

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
