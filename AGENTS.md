# AGENTS.md

このリポジトリで AI コーディングエージェント (Claude Code, Codex 等) が開発作業を行うためのマスタドキュメントです。すべてのエージェントは作業を開始する前に本ドキュメントを必ず確認し、ここに記載されたルールに従って開発を進めてください。

---

## 1. プロジェクト概要

- **プロジェクト名**: Philharmonic
- **目的 / 解決したい課題**: GitHub Projects v2 上のアイテムを起点に、Claude Code (headless mode) を使った coding agent の実行を分離環境でオーケストレーションし、結果を Pull Request として人間レビューに回す実験的なオーケストレータ。OpenAI Symphony から着想を得ている
- **主要技術スタック**: <!-- TODO: 言語 / ランタイム / 主要ライブラリは未確定。確定したら ADR に記録すること -->
  - 連携対象: GitHub Projects v2 API, Claude Code (headless mode), git worktrees
- **対象ユーザー**: Claude Code を使った開発自動化を試したい個人開発者 / 小規模チーム
- **関連リンク**:
  - [README.md](./README.md)
  - インスピレーション元: OpenAI Symphony

---

## 2. 開発フロー

すべての開発作業は以下のフローで進めます。

1. **Issue 起票**: `.github/ISSUE_TEMPLATE/task.md` を使って、Goal / Constraints / Acceptance Criteria を明記した Issue を作成する
2. **既存ドキュメントの確認**: 着手前に `docs/adr/` と `docs/specs/` を確認し、関連する設計判断や仕様を把握する
3. **feature ブランチ作成**: `main` から `feature/<issue番号>-<短い英語の説明>` 形式でブランチを切る
4. **実装**: Acceptance Criteria を満たすように実装し、必要に応じて `docs/adr/` や `docs/specs/` を更新する
5. **PR 作成**: `.github/PULL_REQUEST_TEMPLATE.md` に従って PR を作成し、対応 Issue へのリンクと Acceptance Criteria の達成状況を明記する
6. **CI green の確認**: `format` / `lint` / `unit-test` / `e2e-test` の全ジョブがパスしていることを確認する
7. **レビュー**: レビューを受け、指摘事項があれば修正する
8. **main へ merge**: CI green かつレビュー承認後、`main` ブランチへ merge する

---

## 3. ブランチ戦略

- **管理対象ブランチ**: `main` と `feature/*` のみ
- **`main`**: 常にデプロイ可能な状態を保つ。直接 push は禁止。すべての変更は PR 経由でマージする
- **`feature/*`**: 1 Issue につき 1 ブランチを切る
- **命名規則**: `feature/<issue番号>-<短い英語の説明>`
  - 例: `feature/42-add-user-login`
  - 英語の説明部分はケバブケース (小文字 + ハイフン) で簡潔に記述する
- **マージ後**: マージ済みの feature ブランチは速やかに削除する

---

## 4. コミットメッセージ規約

[Conventional Commits](https://www.conventionalcommits.org/) に準拠します。

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type** (必須): 以下のいずれかを使用する
  - `feat`: 新機能の追加
  - `fix`: バグ修正
  - `docs`: ドキュメントのみの変更
  - `style`: フォーマット等、コードの意味に影響しない変更
  - `refactor`: バグ修正でも機能追加でもないコード変更
  - `test`: テストの追加・修正
  - `chore`: ビルドプロセスや補助ツールの変更
- **scope** (任意): 変更箇所の範囲 (例: `auth`, `api`, `ci`)
- **subject** (必須): 変更内容を簡潔に記述する
- **body** (任意): 変更の背景や詳細
- **footer** (任意): 破壊的変更や関連 Issue の記載 (例: `Refs: #42`)

例:

```
feat(auth): ユーザーログイン API を追加

メールアドレスとパスワードによるログインエンドポイントを実装。
セッションは JWT で管理する。

Refs: #42
```

---

## 5. PR 作成ルール

- **テンプレート**: `.github/PULL_REQUEST_TEMPLATE.md` を必ず使用する
- **対応 Issue へのリンク**: 本文に `Closes #<番号>` を必ず記載する
- **CI**: `format` / `lint` / `unit-test` / `e2e-test` のすべてのジョブが green であること
- **Acceptance Criteria の達成状況**: PR 本文で各項目をチェックボックス形式で再掲し、達成済みのものにチェックを入れる
- **動作確認手順**: レビュアーが追試できるように手順を記述する
- **関連ドキュメント**: 更新した ADR や仕様書へのリンクを記載する
- **レビュー**: 最低 1 名のレビュー承認を得てから merge する

---

## 6. Definition of Done

PR をマージするには以下のすべてを満たす必要があります。

- [ ] Issue の Acceptance Criteria をすべて満たしている
- [ ] CI (`format` / `lint` / `unit-test` / `e2e-test`) がすべて green である
- [ ] 必要なドキュメント (`docs/adr/` の ADR、`docs/specs/` の仕様書) を作成・更新している
- [ ] コミットメッセージが Conventional Commits に準拠している
- [ ] PR テンプレートのすべての項目が記入されている
- [ ] レビュー承認を得ている

---

## 7. ローカルコマンド

<!-- TODO: プロジェクト立ち上げ時に各コマンドを埋める。CI と同じコマンドを使用すること -->

| 用途 | コマンド |
|------|----------|
| build | `TODO` |
| format | `TODO` |
| lint | `TODO` |
| unit-test | `TODO` |
| e2e-test | `TODO` |

---

## 8. ドキュメント管理

### 8.1 ADR (Architecture Decision Record)

- **目的**: 永続的な影響を持つ技術選定や設計判断を記録する
- **配置**: `docs/adr/NNNN-<タイトル>.md` (連番)
- **テンプレート**: `docs/adr/template.md` をコピーして作成する
- **運用フロー**:
  1. 新規 ADR を `Proposed` ステータスで起票する
  2. 議論・合意を経て `Accepted` に変更する
  3. **`Accepted` になってから実装に着手する**
  4. 既存の ADR を覆す場合は新規 ADR を起票し、旧 ADR のステータスを `Superseded by ADR-XXXX` に変更する
- **必要なケース例**:
  - 言語 / フレームワーク選定
  - データベース選定
  - 認証方式の決定
  - API 設計方針
  - ディレクトリ構成方針
  - 外部サービスの採用判断

### 8.2 仕様書 (Specs)

- **目的**: Issue の Goal / Acceptance Criteria を補完する、機能の詳細仕様
- **配置**: `docs/specs/<機能名>.md` (機能ごとに 1 ファイル)
- **テンプレート**: `docs/specs/template.md` をコピーして作成する
- **執筆主体**: AI エージェントが Issue 着手時に必要に応じて作成・更新する
- **更新ルール**: 該当機能を変更する PR の中で、仕様書も同時に更新する

### 8.3 着手前の確認事項

Issue に着手する前に、以下を必ず確認すること。

- [ ] 関連する ADR (`docs/adr/`) を確認した
- [ ] 関連する仕様書 (`docs/specs/`) を確認した
- [ ] 新規の技術選定 / 設計判断が必要な場合は、先に ADR を起票し `Accepted` にする
