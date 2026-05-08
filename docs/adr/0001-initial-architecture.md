# ADR-0001: 初期アーキテクチャ — 技術スタックと MVP スコープ

- **ステータス**: Accepted
- **決定日**: 2026-05-06

---

## コンテキスト

Philharmonic は、GitHub Projects v2 のアイテムを起点に Claude Code (headless mode) を分離環境で実行し、結果を Pull Request として人間レビューに回す coding-agent オーケストレータである。OpenAI Symphony から設計思想を借りつつ、GitHub Projects v2 と Claude Code を first-class target として扱う点が独自性となる。

本リポジトリにはまだ実装コードが存在せず、後続の実装 Issue が迷わず着手できるよう、本 ADR で以下を確定させる必要がある。

- 実装言語 / ランタイム
- CLI framework および対話 UI ライブラリ
- 設定ファイル形式 / スキーマ検証
- テスト framework と Lint / Format ツール
- GitHub API client 方針
- Claude Code runner 方針 (起動方式・permission mode)
- 実行分離方式
- MVP の in-scope / out-of-scope

制約として、初期方針は TypeScript / Node.js を第一候補とすること、OpenAI Symphony は fork せず別実装とすること、GitHub Projects v2 と Claude Code を first-class target として扱うことが Issue で指定されている。

## 決定

### 言語 / ランタイム

- **TypeScript + Node.js 22 LTS** を採用する
- パッケージマネージャは **pnpm** を採用する (ディスク効率と将来 monorepo 化への拡張余地のため)
- モジュールシステムは ESM とする

### CLI フレームワーク / 対話 UI

- 引数パースには **commander** を採用する
- 対話プロンプト・spinner・taskLog 等のターミナル UI には **`@clack/prompts`** を採用する
- ヘッドレス実行 (cron / CI / 非 TTY 環境) では Clack の描画をフォールバックし、plain stdout でログを出力する。これは `--no-tty` フラグまたは `process.stdout.isTTY` 判定で切り替える
- 将来 `philharmonic dashboard` のようなリアルタイム監視 TUI を作る際には **Ink** を別途追加する。Clack と Ink はコマンド単位で使い分け、同一画面で同時使用しない (stdout 制御権の競合を避ける)

### 設定ファイル

- 形式は **YAML** (`philharmonic.yaml` を既定ファイル名とする)
- スキーマ検証は **zod** を用い、TypeScript 型と二重管理しない (`z.infer` で型を導出する)
- 設定値は CLI フラグでオーバーライド可能とする

### テスト / Lint / Format

- テスト framework: **vitest** (ESM 親和性、TypeScript をそのまま実行可能、watch モードの DX が高い)
- Lint: **ESLint** (TypeScript 用設定として `typescript-eslint` を併用)
- Format: **Prettier**
- ESLint と Prettier の競合は `eslint-config-prettier` で解消する

### GitHub API client

- **Octokit** を採用する
- GitHub Projects v2 は GraphQL のみで操作可能なため `@octokit/graphql` を主軸とする
- Issue / PR の REST 操作には `@octokit/rest` を併用する
- 認証は当面 PAT (Personal Access Token) を環境変数で受け取る方式とし、GitHub Apps 化は MVP out-of-scope とする

### Claude Code runner

- **Claude Code CLI を subprocess として起動する headless mode** で利用する
- Anthropic 公式の Claude Agent SDK は採用しない。理由は以下のとおり:
  - Issue で「Claude Code (headless mode)」が明示されている
  - subprocess 方式の方がユーザーがローカルで普段使っている Claude Code 設定 (`CLAUDE.md` / hooks / MCP / slash commands) と挙動が一致し、結果の再現性が高い
  - SDK と CLI は機能が近しいが、CLI の方が公式な配布チャネルで一本化されており、運用上扱いやすい
- 主要な起動オプション:
  - `claude -p "<prompt>"` で non-interactive 実行
  - `--output-format stream-json` で各 turn の発言・tool use・最終応答・コストを行区切り JSON として捕捉する。`--verbose` の同時指定が必須
  - 作業対象ディレクトリは subprocess の `cwd` オプションで渡し、worktree ごとに分離した実行を実現する (Claude Code CLI に `--cwd` フラグは存在しないため。詳細は [docs/specs/claude-runner.md](../specs/claude-runner.md) を参照)
  - `--session-id` / `--resume` でセッションの再開を行う (将来のリトライ機能に必要)
  - `--mcp-config` で MCP サーバを注入可能にする

### Permission mode

- **`auto` / `bypass` の 2 モード** をサポートする
- `philharmonic.yaml` で指定可能、CLI フラグでオーバーライド可能とする
- マッピング:

| Philharmonic 上の名称 | Claude Code フラグ               | 挙動                                                                                          |
| --------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `auto`                | `--permission-mode acceptEdits`  | ファイル編集は自動承認、Bash 等の他ツールは対話プロンプトが起こり得る                         |
| `bypass`              | `--dangerously-skip-permissions` | すべての権限プロンプトをスキップ。git worktree + 非特権ユーザによる隔離環境前提でのみ推奨する |

- デフォルト値の選定 (`auto` か `bypass` か) は本 ADR では決定せず、実装着手前に後続 Issue で決定する

### 実行分離

- **git worktree (per task)** を採用する
- コンテナ / VM ベースの隔離は MVP out-of-scope とする (`bypass` モードを実運用に乗せる際の将来課題)
- worktree のライフサイクル (作成 / クリーンアップ / コンフリクト時の扱い) は実装段階で別途仕様化する

### MVP スコープ

#### In-scope

- GitHub Projects v2 をポーリングして候補 Issue を 1 件ピックアップ
- 対象 Issue 専用の git worktree を作成
- Claude Code を headless mode で実行 (`stream-json` でログ・コスト・tool use を記録)
- 生成された差分から feature ブランチを作成し、リポジトリに push
- 対応 Issue へのリンクを含む Pull Request を作成
- GitHub Project 上のアイテムのステータスを更新 (例: `In Progress` → `In Review`)
- 実行ログ・コスト・所要時間・最終応答をローカルに永続化

#### Out-of-scope

- 並列実行 (1 ターンに 1 タスクのみ処理)
- コンテナ / VM ベースの実行隔離 (git worktree のみ)
- 自動マージ (PR 作成までで止める。マージは人間判断)
- Web UI / リアルタイムダッシュボード (`philharmonic dashboard` も含めて MVP では作らない)
- 複数リポジトリ対応 (シングルリポジトリ前提)
- リトライ / 再開 (失敗したタスクは手動で再実行する)
- GitHub Apps 化 (PAT のみ)
- MCP サーバの自動セットアップ (ユーザーが事前に Claude Code 側で設定済みである前提)

## 結果

### 良い結果

- 言語 / ランタイム / CLI / テスト / Lint といった主要スタックが確定し、後続の実装 Issue で「環境構築 ADR を待つ」状態が解消される
- Claude Code を subprocess で起動する方式により、ユーザーが普段使う `CLAUDE.md` / hooks / MCP / slash commands がそのまま効くため、結果の再現性とデバッグ容易性が高い
- `auto` / `bypass` の 2 モード制限により、Permission の表現空間を狭めた上で実装・検証できる
- Octokit + zod + vitest + ESLint + Prettier はいずれも TypeScript エコシステムでの定番であり、新規参加者の学習コストが低い
- Clack ベースのため対話 UI を最小コストで導入でき、将来 Ink を追加する際もコマンド単位で並存可能

### トレードオフ・悪い結果

- TypeScript / Node.js 採用により、シングルバイナリ配布は標準では行えない (必要であれば `node --experimental-sea-config` などを将来検討する)
- subprocess 方式は SDK 統合に比べてエラー伝播が JSON ログのパースに依存し、ハンドリング実装にコストがかかる
- `bypass` モードは git worktree のみの隔離で運用される場合、ホストファイルシステム全体への副作用リスクを孕む。ユーザーには明示的に注意喚起する必要がある
- pnpm 採用は CI ランナー側に pnpm をセットアップする手間を増やす
- Clack のみの構成では、リアルタイム複数領域更新の TUI は将来 Ink を導入するまで作れない (MVP では問題にならないが、ロードマップ上の制約となる)

### 影響を受けるコンポーネントや今後の作業

- `AGENTS.md` のローカルコマンド欄 (build / format / lint / unit-test / e2e-test) は本 ADR の決定を反映する形で **後続 Issue にて更新する必要がある**
- `package.json` 初期化、`tsconfig.json`、`eslint.config.js`、`.prettierrc`、`vitest.config.ts`、`pnpm-workspace.yaml` (将来用) のスケルトン作成は別 Issue
- `philharmonic.yaml` のスキーマ詳細 (zod 定義) は別 Issue で `docs/specs/config-schema.md` として仕様化する
- Claude Code runner の `stream-json` 出力をどう永続化するか (ファイル名規約・保管期間) は別 Issue で仕様化する
- worktree のライフサイクル管理仕様は別 Issue で仕様化する

## 検討した他の選択肢

### 選択肢 A: Elixir / OTP

- 概要: BEAM 上で supervisor ツリーを構成し、並列タスクをアクター的に管理する
- 採用しなかった理由:
  - Claude Code および Anthropic 公式 SDK の Elixir 実装が存在しない
  - GitHub API クライアントも周辺エコシステムが TypeScript / Go / Rust より薄い
  - 並列実行は MVP out-of-scope のため、OTP の supervisor の旨味が活きにくい
  - 学習コストが Issue で示された開発スピード感と合わない

### 選択肢 B: Go

- 概要: 静的バイナリ配布が容易、並行プリミティブが標準で揃う
- 採用しなかった理由:
  - Anthropic 公式の Claude SDK が無く、Claude Code との連携は HTTP / CLI 直叩きになる (これは TypeScript でも同様だが、TypeScript の方が Claude Code エコシステム全体との文化的整合が高い)
  - Claude Code 自身が TypeScript / Ink で実装されており、設定ファイル・hooks・MCP の文法もすべて JS/TS 文化圏。同じ文化圏に揃えた方が運用上の摩擦が少ない
  - シングルバイナリ配布の利点は MVP では重要度が低い

### 選択肢 C: Rust

- 概要: 高い実行性能、安全性、シングルバイナリ配布
- 採用しなかった理由:
  - Go と同様に Claude Code 連携は CLI 直叩きとなり、Rust の型安全性の旨味が runner 部分には乗りにくい
  - 初期実装速度が TypeScript より大きく劣り、MVP を最短で立ち上げる目的に合わない
  - Octokit に相当する成熟した GitHub Projects v2 GraphQL クライアントの選定コストが上がる

### 選択肢 D: OpenAI Symphony を fork して改修する

- 概要: Symphony をベースに、Claude Code 連携と GitHub Projects v2 連携を後付けする
- 採用しなかった理由:
  - Symphony は Python ベースであり、本 ADR で採用する TypeScript 方針と整合しない
  - Symphony は OpenAI Codex / API 連携前提で設計されており、Claude Code (headless CLI) と git worktree を first-class に扱う構造ではないため、結局大幅な書き換えが必要となる
  - Issue で「設計思想を参考にした別実装とする前提」と明示されている

### 選択肢 E: Claude Code runner として Anthropic Claude Agent SDK を採用する

- 概要: `@anthropic-ai/claude-agent-sdk` を依存に追加し、TypeScript からプログラマブルに呼び出す
- 採用しなかった理由:
  - Issue で「Claude Code (headless mode)」が明示されており、CLI 起動が一次目的である
  - subprocess 方式の方がユーザーが普段使う `CLAUDE.md` / hooks / MCP / slash commands と挙動が一致する
  - SDK と CLI は機能が近接しているため、両方をサポートする価値より複雑度のコストが上回る

### 選択肢 F: CLI 描画レイヤーに最初から Ink を採用する (Clack 不採用)

- 概要: 引数パース (commander) と Ink を組み合わせ、対話 / 進捗表示も含めて全コマンドを Ink で実装する
- 採用しなかった理由:
  - Ink が真価を発揮するのはダッシュボードのような persistent TUI であり、MVP の主要動線 (poll → run → PR) は線形なステップ進行のため Clack の方が記述量が少なくて済む
  - プロンプト系を Ink 自前で組むより `@clack/prompts` の方が DX が高い
  - Ink と Clack はコマンド単位で並存できるため、将来 dashboard を作る際に Ink を追加導入するコストは低く、最初から両方入れる必要がない

### 選択肢 G: CLI 描画レイヤーに最初から Ink + Clack を両方採用する

- 概要: Clack を対話 / 進捗用、Ink を将来の dashboard 用として最初から両方依存に追加する
- 採用しなかった理由:
  - MVP では Ink を使うコマンドが存在しないため、未使用ライブラリが先に入る状態となり API 設計が Ink 都合に引っ張られるリスクがある
  - dashboard 実装着手時に Ink を追加するコストは低く、先送りで失うものが少ない
