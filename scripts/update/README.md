# scripts/update — 法令データの週次更新

e-Gov 法令 API v2 の改正差分を、R2（条文ファイル・参照関係・台帳）と Vectorize に反映するパイプライン。
GitHub Actions（`.github/workflows/update_laws.yml`）が毎週回し、**書き込みは承認を押したときだけ**。
設計と運用は [`docs/law_update.md`](../../docs/law_update.md)。

## 手順（番号 = ファイル）

| 番号 | 役割 | R2 への書き込み |
|---|---|---|
| 01 | e-Gov から全法令一覧を取って台帳を作る（初回のみ。今は 02 が兼ねる） | なし |
| 02 | 最新一覧と台帳（R2 `update_state/sync_state.json`）を突合 → `change_report.json` | なし |
| 03 | 変わった法令の XML を取る → `xml/` | なし |
| 04 | パース（`scripts/rebuild/lib/egov_parser.py`）→ 条文単位ファイル + 編章の目次 → `out/` | なし |
| 05 | R2 の今の中身と比較 → `manifest.json`（put/delete、条数、振り直し、宙に浮く紐付け、ベクトルの差分、blockers） | なし（読むだけ） |
| 06 | 変わった項だけ Workers AI（bge-m3）で埋め込み → `vectors.ndjson` | なし |
| 09 extract | 変わった法令の refs を lawtext で抽出 → `refs/` | なし |
| 07 | 退避 → 上書き → 削除 | **あり** |
| 08 | Vectorize upsert / delete | **あり**（Vectorize） |
| 09 patch | refs チャンクに差し込み（被参照も差分で直す） | **あり** |
| check_refs_resolve | `node scripts/check_refs_resolve.cjs`: refs の補完（`src/refsResolve.mjs`）と「」内の条文参照の抽出の固定データ確認 | なし |
| 10 | 台帳と `data_metadata.json` を更新、`report.md` | **あり** |
| 11 | 抜き取り検証（R2 のハッシュ・Vectorize の ID） | なし |

`run.cjs prepare` が 02→03→04→05→06→09extract→報告、`run.cjs apply` が 07→08→09patch→10→11。`run.cjs check --all` は全件を比べて報告だけ。 `run.cjs refs` は refs（参照関係）だけ全件作り直す（02 --all --require-clean → 03 → 09 extract --refs-only → 09 patch --refs-only --rebuild-reverse。条文・ベクトル・台帳は触らない。02 で台帳と e-Gov の一覧が一致しなければ書く前に止まる＝本番の条文と同じ版の XML だけ使う。抽出ロジックを変えたときに使う。Actions では `mode=refs`）。

## 手元で動かす（¥0・R2 に書かない）

```
export R2_FAKE_DIR=/tmp/fake_r2 VECTORIZE_FAKE_FILE=/tmp/fake_vec.json AI_FAKE=1 UPDATE_STATE_DIR=/tmp/state
node scripts/update/run.cjs prepare --laws 325AC1000000197
node scripts/update/run.cjs apply
node scripts/update/check_vector_ids.cjs     # ベクトル ID が Python 版と一致するか
```

lawtext は `npm i lawtext@0.2.1`（`NODE_PATH` で場所を指定できる）。lxml は `pip install lxml`。

## 本物の R2 を読む（書かない）

```
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...   # R2 編集・Vectorize 編集・Workers AI 読み取り
export UPDATE_DRY_RUN=1                                     # apply も書かない
node scripts/update/run.cjs prepare
```

## 戻す

```
node scripts/update/restore_backup.cjs {run_id} --dry-run   # 何が戻るか
node scripts/update/restore_backup.cjs {run_id}
```

`backup_updates/{run_id}/` に上書き前のファイル・refs チャンク・台帳・上書き前のベクトル（values 込み）が残っていて、全部まとめて戻る。再ベクトル化はしない。

## 環境変数

`lib/common.cjs` の先頭にまとめてある。主なもの: `ARTICLES_PREFIX`（既定 v3）、`OLD_ARTICLES_PREFIX`（全件再構築のときの比較元）、`REFS_PREFIX`、`VECTORIZE_INDEX`、`UPDATE_MAX_CHANGED_LAWS`（既定 800）、`UPDATE_MAX_DROP_RATIO`（既定 0.3）。
`OLD_REFS_PREFIX`（全件再構築で refs の抽出に失敗した法令の refs を写してくる元。既定は `REFS_PREFIX` と同じ＝写さない）、`UPDATE_CONCURRENCY`（05 の読み取りと 07 の書き込みの並列数。既定 16、全件再構築は 48）、`R2_TRANSPORT`（既定 auto。R2 は S3 互換 API を使い、鍵は API トークンから導く＝Access Key ID がトークン ID・Secret がトークン値の SHA-256。導けなければ REST API に落ちるが、REST は Cloudflare 全体で 5 分 1,200 件の上限があり全件再構築は 429 で止まる。`node scripts/update/lib/r2.cjs --selftest` で通り道を確認できる。`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` を直接与えてもよい）。
