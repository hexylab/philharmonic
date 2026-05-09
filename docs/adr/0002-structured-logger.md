# ADR-0002: 横串の構造化ロガーを自作で導入する

- **ステータス**: Accepted
- **決定日**: 2026-05-09

---

## コンテキスト

Philharmonic は orchestrator / runner / cli の各レイヤで進捗・警告・失敗をログ出力する。
現状の出力には以下の問題がある。

- `src/cli/run.ts` の `writeLog` は `[INFO] message {fields}` という独自整形で、JSON line 形式ではない
- `src/cli/clean.ts` / `src/cli/projects.ts` は `stdout.write` / `stderr.write` の plain text で、構造化されていない
- `src/cli.ts` の未捕捉例外は `console.error(error)` で生のオブジェクトを stderr に流す
- `runner` 内部にはログ出力が無い (subprocess の stream-json は `stream.jsonl` に永続化されるが、Philharmonic 自身の動作ログは無い)
- `run_id` / `issue_number` / `session_id` といった「どのタスク・どのセッションのログか」を識別する識別子が
  **呼び出しごとに毎回 fields 引数に手で渡されており抜け漏れが生じやすい**

Issue #28 (`Refs: #19`) は Symphony 相当の structured logging を要求する:

- `run_id` / `issue_id` / `session_id` を **全構造化ログに付与** する
- orchestrator / runner / 将来の serve 共通のロガーレイヤを作る
- ログレベル (`debug` / `info` / `warn` / `error`) を config で制御可能にする
- structured fields を JSON line 形式で出す (CI で grep / jq 可能)

本 ADR では、その実現のためにロガーライブラリを採用するのか自作するのか、出力先 (stdout / stderr) はどちらにするか、
出力形式の慣例 (キーの命名規則) はどうするかを確定する。

## 決定

### ロガーライブラリ: 自作の薄いロガーを `src/logger/` に置く

- 100〜150 行程度の自作実装 (`Logger` interface, `createLogger`, child logger, JSON line 出力)
- 依存ゼロ (Node.js 標準のみ)
- 主要な API:

  ```ts
  type LogLevel = 'debug' | 'info' | 'warn' | 'error';

  type Logger = {
    readonly level: LogLevel;
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    child(bindings: Record<string, unknown>): Logger;
  };

  function createLogger(options?: {
    level?: LogLevel;
    destination?: NodeJS.WritableStream;
    bindings?: Record<string, unknown>;
    clock?: () => Date;
  }): Logger;
  ```

### 出力先: `stderr` (人間向け結果は `stdout` のまま)

- 12-Factor 準拠 (`logs are streams: events to stderr`)
- `philharmonic projects list` の table、`philharmonic run` の `success run-id=...` のような
  「コマンドの実行結果」は stdout に維持し、ログとは責務を分離する
- `2>&1 | jq` で JSON line を絞れるため、Issue が要求する「CI で grep / jq できる」目的は満たす

#### Issue 文言からの逸脱について (重要)

Issue #28 の Constraints には「structured fields は JSON line 形式で **stdout** に出す」とある。
本 ADR では **stderr に出す** と決定した。理由は以下のとおり:

1. `philharmonic projects list` は人間向けの table を `stdout` に出力する設計が既に採用されている
   (`src/cli/projects.ts`)。ログを stdout に乗せると、table と JSON line が混在し
   `philharmonic projects list | column -t` のような単純パイプ処理が崩れる
2. `philharmonic run` も成功時の `success run-id=... pr=#... branch=...` を stdout に出している
   (これは shell スクリプトから `read` で受けることを想定した一行サマリ)
3. 12-Factor の「logs are streams」に従い、ログを `stderr`、結果データを `stdout` に分離するのが
   Unix 文化圏の慣例。CI / CLI ツールはこの分離を期待する
4. `2>&1` で `stdout` にマージするのは利用者側で容易だが、逆に「stdout に混ざったログだけを除外する」のは
   `jq -c '. | select(...)'` のフォールバックが必要で運用が脆くなる

Issue 文言の「stdout」は、ログ整形を独自形式から JSON line に切り替えるという**整形の話**として書かれた
ものと解釈する (Symphony が Python の `logging` でデフォルト stderr に出している点とも整合)。

### 出力フォーマット: snake_case JSON line

- 1 イベント = 1 行の JSON
- 固定キー: `ts` (ISO 8601), `level`, `msg`
- bindings + 呼び出し時 fields をトップレベルにマージして展開
- **キーは snake_case で出力**:
  - Issue 文言 (`run_id` / `issue_id` / `session_id`) と整合
  - 既存の `metadata.json` (`run_id`, `issue_number`, `total_cost_usd` 等) と整合
  - jq での運用慣例 (Datadog / Loki / CloudWatch 等の community convention) と整合
- 衝突時の優先度: 呼び出し時 fields > bindings > 固定キー
- 固定キー (`ts` / `level` / `msg`) は呼び出し側 fields でも上書き不可 (整合性保証のため)

サンプル:

```json
{"ts":"2026-05-09T12:34:56.789Z","level":"info","msg":"candidate selected","run_id":"01956a91-...","issue_number":42}
{"ts":"2026-05-09T12:35:01.123Z","level":"warn","msg":"permission_mode=bypass で Claude Code を起動します","run_id":"01956a91-...","issue_number":42}
{"ts":"2026-05-09T12:40:11.456Z","level":"info","msg":"runner finished","run_id":"01956a91-...","issue_number":42,"session_id":"abcd1234-..."}
```

#### コード内 (camelCase) との橋渡し

既存コードベースは `runId` / `issueNumber` / `sessionId` のような camelCase で内部値を持つ。ロガー呼び出し時は
camelCase のまま渡し、ロガーがシリアライズ時に **top-level のみ** snake_case へ変換する。

- `runId` → `run_id`
- `issueNumber` → `issue_number`
- `sessionId` → `session_id`
- 既に snake_case のキー (`status_field`) はそのまま
- ネストしたオブジェクトの内部キーは変換しない (再帰しない)。これは値オブジェクトをそのままダンプするケースで
  予期せぬキー変更を起こさないため

### bindings (child logger) の運用規約

- `cli` レイヤで `createLogger({ level: config.logLevel })` を作る (bindings は空)
- `runOnce` 冒頭で `runId` 確定後に `logger.child({ runId, issueNumber })` を作り、以降 orchestrator 内では
  この child を使う
- `runClaude` には `logger?: Logger` を optional で渡す。`system` イベントで `session_id` 取得時に
  `logger.child({ sessionId })` を作り、以降の runner 内部ログ (timeout / 完了 / spawn 失敗) に付与
- これにより AC 「`run_id` / `issue_id` / `session_id` を全構造化ログに付与」を満たす

### log level の制御

- `philharmonic.yaml` の `log_level: 'debug' | 'info' | 'warn' | 'error'` で指定 (既定: `info`)
- 環境変数オーバーライドは MVP out-of-scope (将来 `PHILHARMONIC_LOG_LEVEL` 等で追加可能)
- CLI フラグでの上書きは現状他のキーも未実装のため、本 Issue でも見送り

### CLI サブコマンドへの適用範囲

- `philharmonic run` は orchestration loop の進捗・警告・失敗を構造化ログとして出力するため
  `Logger` を生成して `runOnce` に渡す
- `philharmonic projects list` / `philharmonic clean` は「コマンドの最終結果 (table / 一行サマリ /
  エラー文)」だけを stdout / stderr に出している。これらは Unix 慣例上「ログ」ではなく「コマンドの
  出力」であり、JSON line 化すると `philharmonic projects list | column -t` のようなパイプ処理と
  競合するため、本 ADR では Logger 化の対象外とする
- `src/cli.ts` の未捕捉例外ハンドラは `Logger` 経由で `error` を吐く (ここは「コマンドの結果」では
  なく「実行ログ」のため)

### runner からの logger 利用

- `runClaude` のシグネチャに `logger?: Logger` を追加
- ログを出すタイミングは MVP では最小限に絞る:
  - `runner started`: subprocess spawn 直後
  - `runner finished`: subprocess close (`status` / `exit_code` / `duration_ms` を fields に)
  - `runner timeout`: timeout 発火時
  - `runner spawn failed`: spawn エラー時
- subprocess の各 turn (assistant / user / tool_use) を再ログ化することはしない。これらは `stream.jsonl` が
  一次ログを担う
- `runClaude` 内部で `logger.child({ session_id })` を組み立てるが、`logger` が未指定の場合は何も呼ばない
  (テスト容易性 / orchestrator 以外からの直接利用も維持)

## 結果

### 良い結果

- 依存ゼロで実装でき、Node.js 22 のネイティブ ESM / TypeScript と直接整合
- `runId` / `issueNumber` / `sessionId` の bindings 抜け漏れが構造的に防げる (child logger に上げれば呼び出し
  ごとに渡す必要がない)
- 出力形式が JSON line に統一され、`jq -c 'select(.level=="warn")'` のような後処理が容易になる
- stderr / stdout の責務分離により、`philharmonic run | tee result.txt` のような利用パターンが
  ログに汚されない
- 自作なので将来 `philharmonic serve` 追加時にも同一 API を使い回せる

### トレードオフ・悪い結果

- pino / winston が提供する pretty printer / file rotation / async transport のような高機能は持たない
  (が MVP では不要)
- 自作ゆえに将来運用上の追加要件 (sampling / OpenTelemetry 連携 / Loki への直接送信等) を入れる際は
  自分で書く必要がある。pino を入れていれば transport で済む話
- camelCase ↔ snake_case の自動変換ロジックは、ネストオブジェクトに対しては再帰しないことを
  ドキュメント化する必要がある
- Issue 文言 (`stdout`) からの意図的な逸脱を ADR で明示しない場合、レビュー時に毎回説明する手間が発生する
  (本 ADR で明示することで解決)

### 影響を受けるコンポーネントや今後の作業

- `src/logger/` を新設 (本 ADR 採択の作業)
- `src/cli/run.ts` / `src/cli/clean.ts` / `src/cli/projects.ts` / `src/cli.ts` を logger 経由に切り替え
- `src/orchestrator/run.ts` の `RunOnceLogger` 型を `Logger` に置換
- `src/runner/runner.ts` に `logger?: Logger` を追加
- `src/config/schema.ts` に `log_level` を追加
- `docs/specs/observability.md` を新設
- `docs/specs/config-schema.md` の `log_level` 行追加
- `README.md` の「ログとデバッグ」セクション拡張

## 検討した他の選択肢

### 選択肢 A: pino

- 概要: 高速 JSON ロガー。デフォルトで JSON line 出力、child logger / level filter / bindings をサポート
- 採用しなかった理由:
  - Philharmonic は「1 コマンド = 1 ターン」の単発実行 CLI であり、pino が想定する高スループット
    サーバ環境向けの worker / async transport / extreme-mode 等は不要
  - 依存サイズ (pino + sonic-boom + thread-stream) を導入するメリットが MVP 段階では低い
  - pino は呼び出し順 (msg, fields) が独特 (`logger.info({ fields }, 'msg')`) で、既存
    `RunOnceLogger` (msg, fields) との互換性が無く、全箇所書き換えが必要
  - 自作で 100 行強であれば学習コスト・依存追加コストの方が大きい

### 選択肢 B: winston

- 概要: 多機能ロガー。transport / format / level の組み合わせが柔軟
- 採用しなかった理由:
  - transport / format API が複雑で、本 Issue が要求する以上の機能を持つ
  - `formats.combine(format.timestamp(), format.json())` のような boilerplate が増える
  - 依存量が大きい (winston + 複数の format / transport モジュール)
  - 単発 CLI には worker / cluster 対応のような機能は不要

### 選択肢 C: console を wrapper で包む薄い実装

- 概要: `console.log` を JSON line 整形してラップするだけの極小実装
- 採用しなかった理由:
  - child logger / bindings / level filter を自前で実装すると、結局自作ロガーと同じ規模になる
  - `console` 経由は test 時の stdout/stderr 制御がしづらい (DI しにくい)
  - destination を WritableStream で受け取る方が test 容易性が高い

### 選択肢 D: Issue 文言通り stdout に出力する

- 概要: ログを stdout に出し、人間向け結果も stdout (混在)
- 採用しなかった理由:
  - 上述の「Issue 文言からの逸脱について」を参照
  - `philharmonic projects list` の table / `philharmonic run` の一行サマリと混在し、shell スクリプト
    からの利用が壊れる
  - 12-Factor / Unix 文化圏の慣例に逆行する

### 選択肢 E: ログのキーを camelCase で出力する

- 概要: コードベースの内部表現 (`runId` / `issueNumber`) をそのまま出力
- 採用しなかった理由:
  - Issue 文言 (`run_id` / `issue_id` / `session_id`) との不整合
  - 既存 `metadata.json` の snake_case (`run_id`, `issue_number`, `total_cost_usd`) との不整合
  - 後続のログ運用ツール (Datadog / Loki / CloudWatch 等) は snake_case を想定するクエリ例が多い
- ただしコード内では camelCase を維持し、ロガーがシリアライズ時に top-level のみ変換する形を採る
