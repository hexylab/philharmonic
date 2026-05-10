---
name: タスク
about: AIエージェントが開発するタスクを起票する
title: ''
labels: ['task']
assignees: []
---

<!--
Issue 本文の構造は自由フォーマットです。Philharmonic の orchestrator は本文をそのまま agent に渡します
(構造化セクション抽出は ADR-0005 で撤廃)。

agent (Claude Code + `gh` CLI) が Status 遷移 / commit / push / PR 作成 / 必要に応じ Issue コメント
までを完結させます。詳細は docs/adr/0005-thin-orchestrator-agent-delegation.md を参照。

以下は起票時に書きやすいガイドの例 (任意):

- やりたいこと / 達成したい状態
- 制約 (使うライブラリ・性能・互換性 等)
- 完了条件 (チェックボックスにすると agent が自己評価しやすい)
- 関連 Issue / PR / 仕様書 / 過去 run のリンク
- 備考 (背景・open questions・参考資料)
- 依存先 Issue (任意): 先行 Issue が close されてから dispatch したい場合は本文の地の文に
  `Depends-On: #<番号>, #<番号>` を 1 行書く (半角コロン `:` のみ受理 / cross-repo 表記は MVP 未対応)。
  詳細: docs/guide/operations.md の「依存関係付き Issue を運用する」
-->
