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
-->
