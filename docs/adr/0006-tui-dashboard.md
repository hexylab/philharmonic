# ADR-0006: TUI dashboard は Ink で実装し、`philharmonic dashboard` として提供する

- **ステータス**: Accepted
- **決定日**: 2026-05-10

---

## コンテキスト

Issue #31 は、ADR-0004 で確定した Snapshot HTTP API (`GET /api/v1/state` /
`GET /api/v1/<issue_number>` / `POST /api/v1/refresh`) を消費する **read-only な
監視ダッシュボード** を実装することを要求している。

`philharmonic serve` 自体はすでに daemon として動作しており、Snapshot API も
`config.server.port` を設定すれば `127.0.0.1` の loopback で稼働する。本 Issue で
追加するのは「すでに動いている daemon の状態を、運用者が見やすく監視するための
別コマンド」であり、daemon を止めたり書き換えたりするものではない。

確定が必要な論点は以下:

- 表示レイヤの実装手段 (HTML / Ink / 手書き ANSI)
- dashboard が API server に接続する port の解決順 (`--port` / `server.port`)
- Snapshot API が未起動 / 接続失敗のときの dashboard の振る舞いと exit code
- 検証 / CI / 自動 health-check 用に「人間 TUI 以外」のモードを持つかどうか

ADR-0001 では、persistent な TUI を作る際には Ink を別途追加することが想定済みだ
が、Ink は React + Yoga 等を含む比較的重い依存である。この ADR でその採否を確定
させる。

## 決定

### TUI 実装には Ink + React を採用する

- Issue #31 の `## Decision` 節で Ink が候補として明示されており、ADR-0001 の
  「将来 dashboard を作る際には Ink を別途追加する」方針とも一致する
- Snapshot API が `127.0.0.1` 固定 / 認証なしのため、HTML dashboard を別 port で
  立てると外部公開リスクが生まれる。CLI / TTY を前提とする TUI なら追加の bind
  surface を作らずに済む
- read-only の状態確認 + 一定間隔での自動 refresh を実装するには、Ink の
  `useEffect` / `useState` / `useApp` / `useInput` 等の React hooks が素直に書け、
  cell 単位の差分更新も Ink/Yoga が面倒を見てくれるため、ANSI を手書きするより
  メンテ性が高い
- ink-testing-library 等は導入しない。テストは「pure な formatter (snapshot →
  表示行)」と「fetch ラッパ」を Ink に依存しない形で切り出して unit test する
  方針とする (Issue AC が「主要 UI ロジック **または** API client」と OR で
  許容している)

依存として `ink` (^5) と `react` (^18) を `dependencies` に、`@types/react` を
`devDependencies` に追加する。`tsconfig.json` には `jsx: react-jsx` を加え、
`include` を `src/**/*.ts` と `src/**/*.tsx` に拡張する。

### コマンドは `philharmonic dashboard` として追加する

- `--config <path>` … `philharmonic.yaml` のパス上書き (`serve` / `clean` と統一)
- `--port <port>` … 接続先 port (1..65535)。優先順位は \*\*`--port` > `server.port`
  > エラー\*\* とする
- `--interval <ms>` … 自動 refresh 間隔。指定なしなら `polling.interval_ms` を
  そのまま使う (daemon と歩調が揃う)。最小値は dashboard 専用に 500ms とする
  (daemon 側 polling の `MIN_POLLING_INTERVAL_MS = 1000` とは別物)
- `--once` … 1 回だけ snapshot を取得し、human-readable text で stdout に出して
  exit する。TTY を要求しない (CI / cron / 動作確認用)

`--port` を持たず config の `server.port` も無いケースは fail-fast し、
「`server.port` を設定するか `--port` を指定してください」を stderr に出して
exit 1 とする。dashboard が「server が API を出していないが繋ぎに行く」ズレを
持たないようにするため。default port は持たない。

### 接続失敗時の振る舞い

- **TUI モード (default)**: 接続失敗・HTTP エラー・JSON parse 失敗のいずれも、
  画面下部にエラーメッセージを表示し、`--interval` 経過後に再試行する。Ctrl+C
  / `q` で exit 0。daemon の起動を待ちながら接続が回復したら、再描画で snapshot
  を出す
- **`--once` モード**: 1 回 fetch し、成功なら human-readable text を stdout に
  出して exit 0。失敗 (接続失敗 / HTTP 5xx 4xx / JSON parse 失敗) は 1 行
  エラーを stderr に書いて exit 1

### キーボード操作

最小限に絞る (read-only / 監視用途のため):

| キー         | 動作                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| `q`          | 終了 (exit 0)                                                           |
| `Ctrl+C`     | 終了 (exit 0)                                                           |
| `r`          | 即時 refresh (`GET /api/v1/state`)                                      |
| `R` (大文字) | `POST /api/v1/refresh` を呼んで daemon の sleep を起こす + 即時 refresh |

`R` を 2 段階に分けるのは、`POST /api/v1/refresh` には副作用 (daemon の poll を
即時発火させる) があるため。Issue Constraints の「副作用を入れる場合も
`/api/v1/refresh` の wake のみに限定する」を満たす。

### `philharmonic serve` 側の API は変更しない

- Snapshot API のレスポンス形 (snake_case フィールド) や endpoint 構成は
  ADR-0004 で確定済み。dashboard は **既存 endpoint をそのまま消費する**
- 必要な追加 endpoint がもし出てきたら、別 Issue / 別 ADR で扱う (本 ADR の
  範囲外)

## 結果

### 良い結果

- Snapshot API の状態を運用者が `jq` を介さず把握できる足場が揃う
- `--once` モードにより CI / cron からも health-check として利用でき、TUI を
  立ち上げずに JSON 相当の人間可読出力が取れる
- daemon 側の API 仕様 (ADR-0004) を 1 行も触らずに dashboard を実装できる
- `--port` > `server.port` の解決順に揃えることで、dashboard 専用の default
  port を持たずに済み、「daemon は API を出していないが dashboard が空振りする」
  ズレを構造的に避けられる

### トレードオフ・悪い結果

- `ink` / `react` / `@types/react` の追加で `node_modules` のサイズが
  数 MB 単位で増える。CLI ツールとして配布する以上、weight 増加は不可避
- TSX を `src/` 配下に持ち込むため、`tsconfig.json` / `vitest.config.ts` の
  include を拡張する必要がある (ESLint / Prettier はそのままで .tsx を扱える)
- ink-testing-library を入れない方針のため、Ink コンポーネント自体の rendering
  は単体テストの対象外になる。pure formatter の網羅と CLI 層の挙動 (--port が
  ない / --once + 失敗 / `--once` + 成功) でカバーする
- Ink は ESM-only で React も ESM 経路で import する。既存の ESM 構成 (NodeNext)
  と整合するが、JSX を吐くため `tsc` の出力にも `.tsx` から変換された `.js` が
  入る点に留意

## 検討した他の選択肢

### 選択肢 A: HTML dashboard を別 port で立てる

- 概要: Snapshot API の loopback とは別に、`philharmonic dashboard --port` で
  HTML ベースの管理画面を出す
- 採用しなかった理由:
  - Snapshot API が loopback / 認証なしを前提に設計されている (ADR-0004) ため、
    HTML を出しても「HTML 側だけ認証する」「LAN 経由で叩かれる」等の整合性
    問題が新たに出る
  - philharmonic は CLI / daemon 中心のツールであり、ブラウザ前提の運用は
    既存ユーザの運用フローと噛み合わない
  - read-only の状態確認に SPA ビルドや HTTP server を背負わせる費用対効果が
    低い

### 選択肢 B: Ink を入れず、ANSI escape sequence で手書き

- 概要: `process.stdout.write('\x1b[2J\x1b[H')` で全画面クリア + 再描画。
  `process.stdin.setRawMode(true)` でキーを受ける
- 採用しなかった理由:
  - cell 単位の差分更新やレイアウト計算 (列揃え / リサイズ追従) を自前で
    持つコストが、Ink を入れるコストより高い
  - Issue Decision で Ink が明示候補。ADR-0001 でも将来の dashboard で Ink を
    追加する想定が文書化済み
  - Ink を採用しても unit test は pure formatter で書けるので、依存削減の
    旨味が薄い

### 選択肢 C: dashboard でも default port (例: 4000) を持つ

- 概要: `--port` も `server.port` も無いとき、4000 等を仮定して接続を試みる
- 採用しなかった理由:
  - Snapshot API は `server.port` を設定して初めて起動する (ADR-0004 / 仕様)。
    dashboard 側だけ default port を持つと、daemon が API を出していない状況で
    dashboard が「default port に繋ぎに行ったが当然失敗する」という、原因が
    分かりにくいエラーになりやすい
  - port は運用者が config か `--port` で必ず明示するほうが認知負荷が低い

### 選択肢 D: `--once` モードを持たない

- 概要: TUI のみを提供し、CI / cron 等の用途は範囲外とする
- 採用しなかった理由:
  - 「API 未起動・接続失敗時の表示 / exit behavior がテストされている」という
    AC を満たすのに、TUI を mock / drive するための ink-testing-library を
    入れるか、CLI として 1 回呼び出して結果を assert するかの二択になる。
    後者 (= `--once`) のほうが TUI 依存を持ち込まずに済む
  - 同じバイナリを `gh` の CI で `philharmonic dashboard --once` として
    呼べると、軽量 health-check の用途も満たせる
