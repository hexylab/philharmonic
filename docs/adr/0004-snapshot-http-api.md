# ADR-0004: Snapshot HTTP API は Node 標準 http で loopback 固定で公開する

- **ステータス**: Accepted
- **決定日**: 2026-05-09

---

## コンテキスト

Issue #30 は Symphony の Snapshot API に相当する read-only HTTP API を `philharmonic serve` に追加することを要求している。既存の構造化ログ (#28) では「daemon が今どの Issue を走らせているか」「retry に積まれているのは何か」「累計トークンコストはいくらか」を都度 `jq` で集計しないと把握できない。dashboard (#31) や外部 health-check の前提として、最低限の snapshot を JSON で取り出せるエンドポイントが必要になる。

Issue Constraints は以下を求めている。

- ポートは config (`server.port`) で指定。未指定なら API は無効化
- `GET /api/v1/state` / `GET /api/v1/<issue_identifier>` / `POST /api/v1/refresh` を実装
- 認証は本 Issue の範囲外 (loopback / 内部利用前提。将来 ADR で扱う)
- 構造化ロガー (#28) を利用してリクエストログを残す

本 ADR では以下を確定する。

- HTTP 実装の選択 (フレームワーク導入 or Node 標準)
- bind の既定 (loopback 前提を運用上どう守るか)
- `daemon-lifetime` メトリクスの集計範囲 (in-memory or 永続化)
- `/api/v1/refresh` の意味論
- `/api/v1/<issue_identifier>` の解釈

## 決定

### 実装は Node.js 標準 `http` モジュールを使う

- 依存追加なし。`philharmonic` は CLI / daemon ツールであり、フレームワークの ergonomics より「依存を増やさない / startup を軽く保つ」を優先する
- ハンドラ数が 3 つ ( `/api/v1/state` / `/api/v1/:issue` / `/api/v1/refresh` ) かつ middleware が要らない
- routing は手書き (path 正規化 + switch)。Express / Fastify / Hono を入れる損益を覆すほど複雑にはならない
- TypeScript 型は `@types/node` だけで完結する

### bind は `127.0.0.1` 固定

- Issue Constraints の「認証は範囲外 (loopback 前提)」を **コード側で守る**。`config.server.host` は schema に出さない
- `0.0.0.0` などへの公開を許すと、認証無しの API が外部から叩けてしまう。将来 ADR で認証 (token / unix socket / GitHub Apps) を導入してから、明示的に host を増やす
- 検証時に LAN 越しで叩きたい場合は SSH トンネル (`ssh -L 4000:127.0.0.1:4000`) を使う運用とする

### config schema に `server.port` のみを追加

```yaml
server:
  port: 4000 # 1-65535。未指定 (= server セクション省略) なら API 無効
```

- `port` は **optional**。Issue 文言「未指定なら API は無効化」を schema レベルで満たす (zod の `.optional()`)
- 値域: `1..=65535` の整数。`0` は禁止 (実装の `port: 0 = ephemeral` は test 専用にする)
- `port` のみで `host` キーは出さない (上述の loopback 固定方針)

### `daemon-lifetime` の in-memory tracker を新設する

- `running rows` (in-flight dispatch) は **in-memory のみ**。daemon 再起動で消える
- 累計 (`runs_completed` / `runs_succeeded` / `runs_failed` / `total_cost_usd`) も **daemon プロセス起動以降の累計**
- 永続化は `runlog/<run-id>/metadata.json` 側で既に取れているため、API では「running 中の Issue + プロセス起動以降の累計」だけを保証する
- spec で「daemon プロセス起動以降の累計」と明記し、再起動を跨いだ全期間累計は本 Issue の範囲外と宣言する

理由: 全期間累計を取りに行くと `runlog/` 全件の都度走査または別 sqlite が必要になり、本 Issue の MVP スコープから外れる。in-memory なら lock 不要 / I/O ゼロで読み書きでき、`/refresh` のレスポンスも O(N_running) で返せる。

### `/api/v1/refresh` は次 tick の sleep を起こすだけにする

- semantics: 「次 tick の poll を待たずに発火させる」。in-flight 中なら何もしない
- 実装: serveLoop の sleep が wake 可能な AbortSignal を 1 つ追加で受け取り、refresh で abort する
- レスポンスは `202 Accepted` + `{ "woken": boolean }`。`woken: false` は「すでに sleep 中ではない (= dispatch 実行中) のため何もしなかった」を示す
- 副作用は wake のみ。実 dispatch は serveLoop に任せる (= API 側が GitHub に直接叩きに行かない)

### `/api/v1/<issue_identifier>` は issue number として解釈する

- philharmonic は単一 project 前提 (#34 で複数 repo 化が来るまで)。`<issue_identifier>` は **issue number** (positive integer) で固定する
- 当該 Issue が `running` / `retrying` のどちらにも無い場合は **404 Not Found** + `{"error":"not_found","issue_number":N}`
- 数値以外を渡した場合は **400 Bad Request** + `{"error":"invalid_issue_number"}`

理由: project に存在する全 Issue 一覧を返すには Project metadata fetch が必要 (= rate limit を消費する)。本 Issue は read-only / 軽量を主眼としており、in-memory にあるものだけを返すのが合理的。空 payload を返すと 「該当があるが空」と「該当が無い」が区別できないため 404 に倒す。

### 構造化ログ

`api request` イベントを `info` で 1 行出す。

| フィールド    | 型     | 例              |
| ------------- | ------ | --------------- |
| `method`      | string | `GET` / `POST`  |
| `path`        | string | `/api/v1/state` |
| `status`      | number | `200` / `404`   |
| `duration_ms` | number | `4`             |
| `remote`      | string | `127.0.0.1`     |

エラー時 (例外) は `warn` で `api request error` を出し、`status: 500` を返す。

## 結果

### 良い結果

- 依存ゼロで API を提供できる。bundle / startup / 監査負担が増えない
- loopback 固定で「認証無しで API を晒す」事故を仕様レベルで防げる
- in-memory tracker により retry-state ファイルや runlog ディレクトリへの追加 I/O が不要
- `/refresh` が sleep を起こすだけなので、API 経由で GitHub API を直接叩く副作用が無い
- dashboard (#31) や外部 health-check の足場ができる

### トレードオフ・悪い結果

- 全期間累計や過去 run の照会には対応できない (runlog ディレクトリを直接 grep する必要がある)
- routing を手書きするため、ハンドラを増やしたら早めにフレームワーク導入を再検討する必要がある (目安: 5 ハンドラ超 or middleware 要件発生)
- LAN 越しで叩きたい場合は SSH トンネルが必要になる (loopback 固定の制約)
- 認証を将来追加する際は `host` キーの追加と同時に別 ADR を起票する

## 検討した他の選択肢

### 選択肢 A: Hono / Fastify / Express の導入

- 概要: 標準的な Node HTTP フレームワークを 1 つ導入し、3 つのハンドラを定義する
- 採用しなかった理由: ハンドラ数が 3 つしかなく middleware も不要。`@types/node` + 手書き routing で十分。CLI ツールとしての依存を増やすデメリットの方が大きい

### 選択肢 B: Unix domain socket で公開

- 概要: TCP ではなく UDS にすれば認証無しでも file permission で守れる
- 採用しなかった理由: dashboard (#31) や curl での簡易確認、SSH トンネル経由のリモート確認のしやすさで TCP loopback の方が運用が楽。UDS 化は将来 ADR で認証層と一緒に検討する

### 選択肢 C: 累計を runlog ディレクトリ全件走査で算出

- 概要: `total_cost_usd` を「過去全期間」にしたい場合、`runlog/<run-id>/metadata.json` を集計する
- 採用しなかった理由: 1 リクエスト毎に O(N_runs) のディスク I/O が発生し、daemon プロセスが長期化するほど重くなる。`/refresh` のような連打を想定する API として不適切。in-memory + daemon 起動以降のスコープに限定し、過去全期間が必要なら別 CLI / 別 ADR で対応する

### 選択肢 D: `/api/v1/refresh` で実 dispatch を即時発火する

- 概要: `/refresh` で wake するだけでなく、レスポンスを返す前に runOnce を await する
- 採用しなかった理由: HTTP リクエストが Runner timeout 相当 (30 分) ブロックされる。`max_concurrent_agents` 並列とのインタラクションも複雑。「sleep を起こすだけ」に留めれば、API は薄く、dispatch ロジックは serveLoop に集中できる
