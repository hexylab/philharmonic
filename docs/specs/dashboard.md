# `philharmonic dashboard` (TUI)

## 概要

`philharmonic serve` が公開する Snapshot HTTP API ([snapshot-api.md](./snapshot-api.md)) を消費し、daemon の状態 (uptime / polling / running runs / totals) を一定間隔で表示する read-only な TUI コマンド。Ink (React) で実装する。

`philharmonic serve` 自体の API 仕様は変更しない (ADR-0006)。

## 関連

- 関連 Issue: #31 (Refs: #30)
- 設計判断: [ADR-0006 TUI dashboard は Ink で実装する](../adr/0006-tui-dashboard.md), [ADR-0004 Snapshot HTTP API は loopback 固定](../adr/0004-snapshot-http-api.md)
- 関連 spec: [snapshot-api.md](./snapshot-api.md), [serve-daemon.md](./serve-daemon.md), [config-schema.md](./config-schema.md)

## 要件

- `philharmonic dashboard` サブコマンドを追加し、`philharmonic --help` / `philharmonic dashboard --help` から見える
- フラグ:
  - `-c, --config <path>` … `philharmonic.yaml` のパス (省略時は `serve` / `clean` と同じ default 解決経路)
  - `--port <port>` … 接続先 port (1..65535)。指定がなければ config の `server.port` を使う
  - `--interval <ms>` … 自動 refresh 間隔。指定がなければ config の `polling.interval_ms` を流用する。下限 500ms (dashboard 専用)
  - `--once` … 1 回だけ snapshot を取得し、人間可読 text で stdout に出して exit する。TTY を要求しない
- 接続先 host は **`127.0.0.1` 固定** (Snapshot API の bind と一致)。`--host` キーは出さない
- TUI モードでは `polling.interval_ms` ごとに `GET /api/v1/state` を発行し、結果を再描画する
- TUI モードのキー操作:
  | キー | 動作 |
  | ------------ | ------------------------------------------------------------------------------------------------- |
  | `q` | 終了 (exit 0) |
  | `Ctrl+C` | 終了 (exit 0) |
  | `r` | 即時 refresh (`GET /api/v1/state`) |
  | `R` (大文字) | `POST /api/v1/refresh` で daemon の sleep を起こした上で即時 refresh (副作用は `wake` のみ) |
- 接続失敗 / HTTP エラー / JSON parse 失敗時の挙動:
  - **TUI モード**: 最後に取得した snapshot (あれば) を残しつつ、画面下部に 1 行のエラーメッセージを表示する。次回の自動 refresh で再試行する。Ctrl+C / `q` での exit code は 0
  - **`--once` モード**: 1 行エラーメッセージを stderr に書いて exit 1
- `--port` も `server.port` も決まらない場合は fail-fast し、stderr に 1 行のメッセージを書いて exit 1 (`philharmonic.yaml` に `server.port` を追加するか `--port` を指定してください、と案内する)
- `philharmonic serve` 側の API 仕様は変更しない

## 非機能要件

- **性能**: 1 refresh = `fetch('/api/v1/state')` 1 回。受け取るのは in-memory snapshot なので、daemon 側の追加負荷は ADR-0004 / spec 上の API request 1 行ぶん
- **可用性**: API server (= `philharmonic serve` 側) が未起動でも dashboard 自体は落ちず、エラー表示のまま retry する。daemon が落ちた場合も dashboard は気づいたあと自動的に再接続する
- **セキュリティ**: 接続先は `127.0.0.1` に固定。dashboard は副作用を持つリクエストとしては `POST /api/v1/refresh` (= sleep の wake) しか発行しない。Snapshot API 側で認証が無いことは ADR-0004 の前提どおり (loopback 限定)
- **アクセシビリティ**: 該当しない (CLI / TUI のみ)

## データモデル

dashboard は新規に永続化を持たない。in-memory な State 機械は以下:

```ts
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; snapshot: StateSnapshot; fetchedAt: Date }
  | { kind: 'error'; message: string; lastSnapshot: StateSnapshot | null; fetchedAt: Date };
```

- `StateSnapshot` は `src/server/snapshot.ts` の export 型をそのまま再利用する (snake_case のまま)
- 接続失敗後に再取得が成功したら `kind: 'ok'` に戻る。直近 ok snapshot は `lastSnapshot` で持ち続ける

## API / インターフェース

### CLI 入力

```
philharmonic dashboard [options]

Options:
  -c, --config <path>     設定ファイルのパス
  --port <port>           接続先 port (1-65535)。省略時は server.port を使う
  --interval <ms>         自動 refresh 間隔 (>=500ms)。省略時は polling.interval_ms
  --once                  1 回だけ snapshot を取得して人間可読 text を stdout に出して exit する
```

### `--once` の出力

stdout に以下のような human-readable text を出して exit 0。Snapshot API のフィールドを 1 対 1 で写像する。

```
host=127.0.0.1 port=4000
started_at=2026-05-09T00:00:00.000Z uptime=1h00m00s
polling.interval_ms=30000 polling.last_tick_at=2026-05-09T00:00:30.000Z

running:
  #42 branch=feature/42-foo started_at=2026-05-09T00:00:10.000Z slot=0

totals:
  runs_completed=12 runs_succeeded=10 runs_failed=2 total_cost_usd=4.32
```

`running` が空のときは `running: (none)` と書く。`polling.last_tick_at` が `null` のときは `(never)` と書く。

エラー時 (接続失敗 / HTTP エラー / JSON parse 失敗) は stderr に `dashboard: <理由>` を 1 行出して exit 1。

### TUI レイアウト (概念図)

```
┌────────────────────────────────────────────────────┐
│ Philharmonic Dashboard                             │
│ http://127.0.0.1:4000   refresh=30000ms            │
├────────────────────────────────────────────────────┤
│ started 2026-05-09T00:00:00.000Z   uptime 1h00m00s │
│ polling 30000ms   last tick 2026-05-09T00:00:30.000Z│
├────────────────────────────────────────────────────┤
│ Running (1)                                        │
│   #42  feature/42-foo  slot=0  started 00:00:10    │
├────────────────────────────────────────────────────┤
│ Totals                                             │
│   completed=12  succeeded=10  failed=2  cost=$4.32 │
├────────────────────────────────────────────────────┤
│ q quit  r refresh  R wake-and-refresh              │
│ last fetch ok @ 13:00:42                           │
└────────────────────────────────────────────────────┘
```

幅の自動調整は Ink/Yoga が行う。色は最小限 (running 件数 / エラーメッセージのみ強調)。

### Snapshot API との関係

- `GET /api/v1/state` を **読むだけ**。`GET /api/v1/<issue_number>` は本仕様では使わない (TUI に追加 query を出す UI を持たないため)
- `POST /api/v1/refresh` は `R` キーが明示的に押されたときのみ発行する
- いずれも追加の query / body は無し

## エラーハンドリング

| エラー                                 | 発生条件   | 扱い方針                                                                           |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| `--port` も `server.port` も無い       | 起動時     | stderr に 1 行ガイドして exit 1                                                    |
| `--port` / `server.port` が範囲外      | 起動時     | stderr に 1 行エラーで exit 1 (commander の InvalidArgumentError 経由でも可)       |
| `--interval` が 500 未満               | 起動時     | stderr に 1 行エラーで exit 1                                                      |
| 接続失敗 (`ECONNREFUSED` 等)           | refresh 時 | TUI では下部にエラー表示 + interval ごとに retry。`--once` は stderr + exit 1      |
| HTTP 4xx / 5xx                         | refresh 時 | 同上 (status code を含めたメッセージを出す)                                        |
| JSON parse 失敗                        | refresh 時 | 同上 (`malformed json` を含めたメッセージを出す)                                   |
| `POST /api/v1/refresh` 失敗 (`R` キー) | TUI 中     | 直近 snapshot は維持し、エラー表示を画面下部に 1 行出す。次回 refresh で再試行する |

## 外部依存

- `ink` ^5 — TUI 描画。React 18 を peer dependency として要求する
- `react` ^18 — Ink の peer dependency
- `@types/react` ^18 (devDependency) — TypeScript 型
- Node 22 LTS の組み込み `fetch` (= undici) — HTTP client

`tsconfig.json` の `compilerOptions.jsx` に `react-jsx` を追加し、`include` を `src/**/*.ts` と `src/**/*.tsx` に拡張する。`vitest.config.ts` の `include` も `tests/**/*.test.ts` と `tests/**/*.test.tsx` に拡張する。

## オープンクエスチョン

- 複数 daemon (= 複数 port) を 1 画面で見たいケースの扱い → 本 Issue の範囲外。dashboard を複数プロセス起動するか、別 Issue で multi-daemon view を切る
- `GET /api/v1/<issue_number>` を見る画面 / 個別 issue ドリルダウン → 本 Issue の範囲外 (UI 入力レイヤを増やす必要があるため別 Issue)
- 認証付きの非 loopback 接続 → ADR-0004 の認証 ADR と歩調を合わせて別途検討
