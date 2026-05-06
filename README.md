# Philharmonic

Philharmonic is an experimental coding-agent orchestrator inspired by OpenAI Symphony, built around GitHub Projects v2 and Claude Code.

## Goal

Turn GitHub Project items into isolated Claude Code implementation runs, then produce pull requests for human review.

## Initial scope

- Poll GitHub Projects v2 for candidate issues
- Create isolated workspaces or git worktrees per task
- Run Claude Code in headless mode
- Capture logs, results, and costs
- Push branches and open pull requests
- Update GitHub Project item status
- Keep safe defaults: PR creation is automated, merging is human-approved

## Status

Just getting started.

## Local development

### Prerequisites

- [Node.js](https://nodejs.org/) 22 LTS 以上
- [pnpm](https://pnpm.io/) (推奨: [Corepack](https://nodejs.org/api/corepack.html) 経由で `corepack enable` してから `package.json` に固定された `packageManager` を利用)

### Setup

```sh
corepack enable
pnpm install
```

### Common commands

| 用途                                    | コマンド            |
| --------------------------------------- | ------------------- |
| ビルド                                  | `pnpm build`        |
| 型チェック (出力なし)                   | `pnpm typecheck`    |
| フォーマット (書き込み)                 | `pnpm format`       |
| フォーマット (チェックのみ / CI と同等) | `pnpm format:check` |
| Lint                                    | `pnpm lint`         |
| ユニットテスト                          | `pnpm test`         |
| ユニットテスト (watch)                  | `pnpm test:watch`   |

### Try the CLI

ビルド後にローカルで CLI 実行が可能。

```sh
pnpm build
node dist/cli.js --help
node dist/cli.js --version
```

詳細な開発フロー・ブランチ戦略・コミット規約は [AGENTS.md](./AGENTS.md) を参照。
