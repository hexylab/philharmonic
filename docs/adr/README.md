# Architecture Decision Records (ADR)

このディレクトリには、本プロジェクトにおける **永続的な影響を持つ技術選定や設計判断** を記録します。

---

## ADR の目的

- 「なぜその技術 / 設計を選んだのか」を後から追跡可能にする
- 同じ議論を繰り返さない
- 新規参加者 (人間・AI エージェント問わず) が背景を理解できるようにする
- 過去の判断を覆す際に、根拠を残した上で更新できるようにする

---

## 運用ルール

### 新規 ADR の作成

1. `template.md` をコピーして、連番のファイル名 `NNNN-<タイトル>.md` で作成する
   - 例: `0001-use-typescript.md`, `0002-database-postgresql.md`
   - 連番は 4 桁ゼロ埋め (`0001`, `0002`, ...)
2. 初期ステータスは **`Proposed`** とする
3. 議論・合意を経て **`Accepted`** に変更する
4. **`Accepted` になってから実装に着手する**

### 既存 ADR の更新

- ステータスのみの変更 (例: `Proposed` → `Accepted`) は同一 ADR を更新する
- 過去の決定を覆す場合は、**新しい ADR を起票** し、旧 ADR のステータスを `Superseded by ADR-XXXX` に変更する
- 旧 ADR の本文は削除せず、履歴として残す

### ステータス一覧

| ステータス               | 意味                          |
| ------------------------ | ----------------------------- |
| `Proposed`               | 提案中。議論・レビュー段階    |
| `Accepted`               | 承認済み。実装着手可能        |
| `Deprecated`             | 非推奨。新規利用は控える      |
| `Superseded by ADR-XXXX` | 別の ADR により置き換えられた |

---

## ADR が必要なケースの例

- 言語 / フレームワークの選定
- データベースの選定
- 認証方式の決定
- API 設計方針 (REST / GraphQL / gRPC 等)
- ディレクトリ構成方針
- 外部サービス・SaaS の採用判断
- ロギング / モニタリング戦略
- デプロイ・インフラ構成

逆に、一時的な実装判断や、コードを読めば自明な内容は ADR にしなくて構いません。

---

## ファイル一覧

<!-- 新規 ADR を追加したらこのリストを更新する -->

- [ADR-0001: 初期アーキテクチャ — 技術スタックと MVP スコープ](./0001-initial-architecture.md) (Accepted, 一部 Superseded by ADR-0005)
- [ADR-0002: 横串の構造化ロガーを自作で導入する](./0002-structured-logger.md) (Accepted)
- [ADR-0003: WORKFLOW.md の prompt テンプレートエンジンに LiquidJS を採用する](./0003-prompt-templating.md) (Accepted, 一部 Superseded by ADR-0005)
- [ADR-0004: Snapshot HTTP API は Node 標準 http で loopback 固定で公開する](./0004-snapshot-http-api.md) (Accepted)
- [ADR-0005: Philharmonic を薄い orchestrator に再設計し、Status 遷移 / PR 作成 / Issue コメントを agent に委譲する](./0005-thin-orchestrator-agent-delegation.md) (Accepted)
- [ADR-0006: TUI dashboard は Ink で実装し、`philharmonic dashboard` として提供する](./0006-tui-dashboard.md) (Accepted)
- [ADR-0007: Issue 依存関係を `Depends-On:` 行で表現する DAG-aware scheduler を導入する](./0007-dependency-dag-aware-scheduler.md) (Accepted)
- [ADR-0008: 失敗 / stalled run を指数バックオフで再 dispatch する in-memory retry queue を導入する](./0008-in-memory-retry-queue.md) (Accepted)
