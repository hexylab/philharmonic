# Philharmonic Documentation

Philharmonic の設計判断と機能仕様を集約したディレクトリです。利用者向けの導入手順は [リポジトリルートの README.md](../README.md) を、開発フローやコミット規約は [AGENTS.md](../AGENTS.md) を参照してください。

## 構成

| ディレクトリ         | 役割                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| [`adr/`](./adr/)     | Architecture Decision Record。**なぜそう決めたか** (技術選定・設計方針) を時系列で記録     |
| [`specs/`](./specs/) | 機能仕様書。**何が・どう動くか** (要件・データモデル・エラーハンドリング) を機能単位で記述 |

ADR は判断の根拠を残すための文書で、原則として既存のものは書き換えず、決定が覆る場合は新規 ADR を起票します。仕様書は実装と歩調を合わせるための文書で、機能を変更した PR の中で同時に更新します。

## 入口ドキュメント

- ADR の運用ルールと一覧: [docs/adr/README.md](./adr/README.md)
- 仕様書の運用ルールと一覧: [docs/specs/README.md](./specs/README.md)

## どこから読むか

| 知りたいこと                                     | 読むべき文書                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Philharmonic の全体像と MVP スコープ             | [ADR-0001 初期アーキテクチャ](./adr/0001-initial-architecture.md) |
| 1 ターンの orchestration loop の振る舞い         | [docs/specs/orchestration-mvp.md](./specs/orchestration-mvp.md)   |
| `philharmonic run` の使い方と引数                | [リポジトリルートの README.md](../README.md)                      |
| GitHub Projects v2 から候補 Issue を取り出す方法 | [docs/specs/github-projects-v2.md](./specs/github-projects-v2.md) |
| `philharmonic.yaml` の設定キー一覧               | [docs/specs/config-schema.md](./specs/config-schema.md)           |
| git worktree workspace の lifecycle              | [docs/specs/workspace-manager.md](./specs/workspace-manager.md)   |
| Claude Code headless runner の起動仕様           | [docs/specs/claude-runner.md](./specs/claude-runner.md)           |

## 文書の追加 / 更新ルール

- ADR を追加するとき: `docs/adr/template.md` をコピーし、連番ファイル名で起票する。詳細は [docs/adr/README.md](./adr/README.md) を参照
- 仕様書を追加するとき: `docs/specs/template.md` をコピーし、機能名のケバブケースで配置する。詳細は [docs/specs/README.md](./specs/README.md) を参照
- いずれも `docs/{adr,specs}/README.md` のファイル一覧に追記する
