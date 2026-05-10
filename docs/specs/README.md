# 仕様書 (Specs)

このディレクトリには、各機能の **詳細仕様書** を配置します。

---

## 仕様書の目的

- Issue の `Goal` / `Acceptance Criteria` を補完する、機能の詳細仕様を記録する
- 実装着手前に、データモデル・インターフェース・エラーハンドリング等の設計を明文化する
- 機能の現在の振る舞いを参照可能にし、将来の改修時の判断材料とする

ADR が「なぜそう決めたか」を記録するのに対し、仕様書は「何が・どう動くか」を記述します。

---

## 配置ルール

- 機能ごとに 1 ファイル: `docs/specs/<機能名>.md`
  - 例: `docs/specs/user-login.md`, `docs/specs/payment.md`
- ファイル名は小文字 + ハイフン (ケバブケース) を推奨

---

## 執筆主体と更新タイミング

- **執筆主体**: AI エージェントが Issue 着手時に必要に応じて作成・更新する
- **新規作成**: 新機能の Issue に着手する際、`template.md` をコピーして仕様を起こす
- **更新**: 既存機能を変更する際、**該当機能の変更 PR の中で仕様書も同時に更新する**
  - 仕様書とコードが乖離した状態を残さない

---

## 仕様書に書くべき内容の例

機能の性質に応じて、以下のような項目を記述します (該当しない項目は省略可)。

- **概要**: その機能が何をするかを 1〜3 文で
- **要件**: 機能要件の詳細リスト
- **非機能要件**: 性能、可用性、セキュリティ、アクセシビリティ等
- **データモデル**: 扱うエンティティ、属性、リレーション
- **API / インターフェース**: エンドポイント、リクエスト / レスポンス、関数シグネチャ等
- **画面 / UI**: 画面遷移、レイアウト、操作フロー (該当する場合)
- **エラーハンドリング**: 想定されるエラーと、それぞれの扱い方針
- **外部依存**: 連携する外部システム / サービス
- **オープンクエスチョン**: 未決定事項、後続で検討する事項

---

## ファイル一覧

<!-- 新規仕様書を追加したらこのリストを更新する -->

- [orchestration-mvp.md](./orchestration-mvp.md) — Philharmonic MVP の orchestration loop / status 遷移 / failure ハンドリング仕様
- [github-projects-v2.md](./github-projects-v2.md) — GitHub Projects v2 から候補 Item を取得する読み取り専用 client (CLI `philharmonic projects list`) の仕様
- [workspace-manager.md](./workspace-manager.md) — git worktree workspace manager の lifecycle / sanitize / path traversal 防止 / error 仕様
- [claude-runner.md](./claude-runner.md) — Claude Code headless runner (`runClaude`) の subprocess 起動 / stream-json parse / timeout / 環境変数除外仕様
- [config-schema.md](./config-schema.md) — `philharmonic.yaml` の zod スキーマ / デフォルト値 / `loadConfig` の読み込みフロー仕様
- [github-rest-client.md](./github-rest-client.md) — Octokit REST/GraphQL ベースの書き込み系 GitHub クライアント (`getIssue` / `commentIssue` / `createPullRequest` / `updateProjectV2ItemStatus`) の仕様
- [prompt-construction.md](./prompt-construction.md) — Issue body から Claude Code Runner 用 prompt を組み立てる pure 関数 (`buildPrompt` / `parseIssueBody`) の仕様 (テンプレート不在時の下位レイヤ)
- [workflow.md](./workflow.md) — `WORKFLOW.md` (Liquid テンプレート) を上位レイヤとして prompt 構築する `WorkflowSource` の仕様 (#27)
- [observability.md](./observability.md) — `src/logger/` の構造化ロガー仕様 (JSON line / bindings / log_level / `run_id`/`issue_number`/`session_id` 付与規約)
- [snapshot-api.md](./snapshot-api.md) — `philharmonic serve` の Snapshot HTTP API (`/api/v1/state` / `/api/v1/<n>` / `/api/v1/refresh`) の仕様 (#30)
- [dashboard.md](./dashboard.md) — Snapshot HTTP API を購読する read-only TUI dashboard (`philharmonic dashboard`) の仕様 (#31)
- [serve-daemon.md](./serve-daemon.md) — `philharmonic serve` 常駐デーモンの起動 / graceful shutdown / Tracker-driven recovery / 並列 dispatch 仕様 (#21 ほか)
- [dependency-parser.md](./dependency-parser.md) — Issue body から `Depends-On:` 行を抽出する pure parser の仕様 (ADR-0007 §5 split 1)
- [dependency-resolver.md](./dependency-resolver.md) — Project candidate を `ready` / `blocked` / `invalid_dependency` / `cycle` に分類する evaluator 仕様 (ADR-0007 §5 split 2)
