# 通達データの取り込み直し（v3 → v4・2026-09-23〜24）

**2026-09-24 に本番を v4 に切り替え済み**（Worker Version `497fd317-65d7-468a-b2cf-ab4f5f91ce6b`・PR #158 staging / #159 本番。直前の本番は `e8358462-4306-4c01-a809-34e0e81ba296`）。経過と数字は `docs/relations/TSUTATSU_V4_BUILD_20260923.md`。次に作り直すときは、下の手順の v3→v4 を v4→v5 に読み替え、「実際にやったこと」の注意を先に読む。

国税庁の通達を取り直して、R2 の新しいプレフィックス `tsutatsu_chunks_v4` に作る。本番が読む `tsutatsu_chunks_v3` には書かない。
前回（v3）の作り方と失敗の記録は `docs/benchmarks/tax_ab/STATUS.md`（`tsutatsu_chunks_v3`・`13_assign`・`19_recover` で検索）。

## 前提

- 取り直し: 2026-09-23 に、台帳を脇にどけて全ページを取り直した（`all_tsutatsu_20260923`）。台帳があるまま流すと 304 のページの下をたどらないので、この方法で取った。台帳は元に戻してあり、今回分は `crawl_ledger_20260923.json`
  - 本番の v3（2026-09-02 ビルド）の元の HTML は **2026-06-02 のクロール**（台帳もこの日）。9/2 は PDF の取得と作り直しだけだった
  - 6/2 と比べて: 新規 65 ページ（すべて国税庁の追加。取りこぼしではない）・変更 226（うち約半分が措置法通達。中身の改正が 200 件あまり）・消えた 3（国税庁の削除 2・6/2 時点で既にエラーページ 1）。6/2・9/23 どちらのクロールにも取りこぼしは無かった
- 方針（オーナー決定 2026-09-23）: 前回の紐付け（LLM の結果を含む）は、見出しが同じなら使い回す。新規・変更で機械で紐付かないものだけ LLM（`13_assign`）に聞く。LLM でも決まらないものは件数を報告に出す
- 作業は K: ドライブのある PC。スクリプトは main の最新（`TSU_PREV` 対応。下記）

## 2026-09-23 のスクリプト修正

- 19・20・21・23・24・17 は「前回ビルド」を `tsutatsu_chunks_${TSU_PREV}`（既定 v3）から読む。以前は v2 固定で、そのまま流すと v2 基準に巻き戻った
- 21・24 は `TSU_VER`（新しい版）が必須。`TSU_PREV` と同じ値は拒否する。21 の出力名は `vec_*_${TSU_VER}.ndjson`（v3 のロールバック材料を上書きしない）
- 21 に `PREV_ITEMS`（前回ビルドの items。v4 のときは本番 v3 の元 `tsutatsu_items_20260602.ndjson`）を渡すと、同じ id で本文か見出しが変わった通達を埋め込み直しに入れ、前回あって今回無い通達を `vec_delete_${TSU_VER}.ndjson` に出す。削除は最終チャンク（08・24 の後のローカル `tsutatsu_chunks_v4`）に無いものだけ（24 が復元して残した通達は消さない）。互換性チェック用の 20 本は本文・見出しが変わっていないものから選ぶ
- 09 は v1〜v3 と、`wrangler*.toml` の `TSUTATSU_CHUNKS_PREFIX`（本番・staging・bench が今読んでいる版）には書かない

## 手順（【】は書き込み先）

1. `node scripts\tsutatsu\18_parse_delta.cjs --ref HEAD` 【読むだけ】同じページ内の番号衝突（v3 は 466）が増えていないこと
2. `node scripts\tsutatsu\03_parse.cjs --snapshot 20260923` 【ローカル】通達の本数を v3 の 15,633 と比べる
3. PDF 【ローカル】
   - `node scripts\tsutatsu\04_fetch_pdfs.cjs --snapshot 20260923 --list` で件数 → 取得（1 秒 1 件・国税庁に要求が出る・¥0）
   - `python scripts\tsutatsu\05_extract_pdf_text.py --snapshot 20260923` → すぐ別名で退避
   - `node scripts\tsutatsu\20_recover_pdf_items.cjs --dump-titles --write`（v3 から復元）→ 05 の結果とマージ（v3 と同じ手作業。帳票 PDF は LLM に回さない）
4. `node scripts\tsutatsu\07_build_links.cjs 20260923` 【ローカル】`--allow-missing-pdf` は付けない
5. `node scripts\tsutatsu\19_recover_assignments.cjs` で件数 → `--write` 【ローカル・R2 は読むだけ】**必ず 4 の後**（v3 では先に流して古い浮きの一覧を使った）。割当ファイルは流す前に手で退避
6. `node scripts\tsutatsu\13_assign.cjs --targets scripts\tsutatsu\state\tsutatsu_assign_targets_20260923.json --dry` で件数 → **オーナーに件数と見込み費用を出して OK をもらってから** `--dry` を外す 【LLM】
   - staging の `/api/chat` 経由（Sonnet）。`--opus` は付けない。`WORKER_URL` と `BYPASS_KEY` は環境変数で渡す
   - 費用の目安: v3 は 1,280 本で ¥181（1 本 ¥0.14 前後）
7. `07_build_links.cjs 20260923` をもう一度。浮きが減り、LLM 割当が増えたこと
8. `set TSU_VER=v4` → `node scripts\tsutatsu\08_build_chunks.cjs 20260923` 【ローカル `tsutatsu_chunks_v4\`】目次エントリの除外（v3 は 1,512）
9. `set TSU_VER=v4` → `node scripts\tsutatsu\24_restore_dead_pages.cjs` で件数 → `--write` 【ローカル】v3 は 10 本。数百なら取り直しの欠けを疑う。08 を流し直したら 24 も
10. `set TSU_VER=v4` → `node scripts\tsutatsu\09_upload_chunks.cjs --dry` → 実行 【R2 `tsutatsu_chunks_v4/` だけ】
11. ベクトルの入力 【ローカル・R2 と Vectorize は読むだけ】
    - `set TSU_VER=v4` と `set PREV_ITEMS=scripts\tsutatsu\state\tsutatsu_items_20260602.ndjson`（前回ビルドの元の items。v3 は 6/2 の HTML から作られていた）
    - 21 を `--dump-rev-all=…` / `--dump-giant-all=…` で流す → `22_check_reverse_ids.cjs` で実在確認 → `REVERSE_EXISTING` を付けて 21 を流す
    - 出るもの: `vec_input_v4`（新規＋本文が変わったもの）・`vec_homes_update_v4`・`vec_compat_check_v4`・`vec_delete_v4`
12. ベクトルを入れる 【Vectorize `tsutatsu-embeddings-v1`。**本番に即時に効く**（版を分ける仕組みは無い）】`local_vec_v3.py`（ローカル GPU・¥0）
    - `compat`（cosine 0.99 以上）→ **`backup`**（上書きする id と `vec_delete_v4` の id を全部）→ `embed` → カナリア（`--ns 340AC0000000034:22`）で入れて戻せることを確認 → 巨大条文 → `_reverse` → `homes-apply`
    - **削除（`vec_delete_v4`）はここではしない**（本番がまだ v3 を読んでいる）
13. staging で確かめる: `wrangler.staging.toml` の `TSUTATSU_CHUNKS_PREFIX` を v4 にする PR → main にマージ → Actions の Deploy staging。法人税法 22 条・相続税法 22 条・措置法 70 条の 6 などで v3 と本数を比べる
14. 本番: `wrangler.toml` を v4 にする PR → main にマージ → **オーナーの OK をもらって** main を checkout してから `npx wrangler deploy`
15. 本番を確かめてから `local_vec_v3.py delete --in vec_delete_v4…` で消えた通達のベクトルを消す

## 止める条件（v3 の値と比べる。差し引きでなく、増えたものと失ったものの両方を出す）

| 見るもの | v3 |
|---|---|
| 通達（1 本単位） | 15,633 |
| 浮き | 3,289（新規 PDF 2,514・重複 392・連結 386・実質 約 70） |
| 法令ファイル / 条 / 参照 | 37 / 2,318 / 18,658 |
| 目次エントリの除外 | 1,512 |
| 国税徴収法 15 / 19 / 47 条 | 55 / 47 / 76 本 |
| 24 の復元 | 10 本 |
| 番号衝突 | 466 |

## 戻し方

- R2: `wrangler.toml` を v3 に戻す PR → main から配る（v3 は消さない）
- ベクトル: 足した id は入力ファイルの id で `delete`。上書き・削除したものは `backup` を `upsert` し直す
- 12〜14 の間は本番（v3）の巨大条文の絞り込みと `_reverse` の橋渡しが少し変わるので、この間は短くする

## 残っていること

- 19 は見出しだけ比べて前回の紐付けを使い回す（本文が改正されても見出しが同じなら同じ条とみなす）
- 週次の差分更新（通達・判例の順）は別に作る。その前提の「台帳を使うクロールの直し」は済んだ（下）

## 台帳を使う取り直し（2026-09-24〜）

- `01_crawl`・`04_fetch_pdfs` は、304（未変更）のページ・PDF を前回スナップショットの写しから今回のスナップショットにコピーし、そこからリンクと PDF を辿る。台帳を脇にどけなくても、今回のスナップショットは全件取り直しと同じ中身になる（03 以降はそのまま使える）
- 写しは台帳の `local_path` → 今回より前の `all_tsutatsu_*`（新しい順）の同じパス、の順に探し、台帳の `content_hash` と合うものだけ使う。合う写しが無ければ条件なしで取り直し、件数を「取り直した: N 件」と出す
- 次に流す前に、台帳を 9/23 の取り直しの分に揃える: `crawl_ledger.json` を控えてから `crawl_ledger_20260923.json` をコピーする（今の `crawl_ledger.json` は 6/2 のまま。そのままでも hash で確かめるので壊れないが、6/2 以降に変わったページを全部取り直す）
- 確かめ: `node scripts/tsutatsu/check_crawl_304.cjs`（¥0・偽の国税庁を手元に立てる。国税庁に要求を出さない）

## 実際にやったこと・次回の注意（2026-09-24）

- **v3 の元は 6/2 のクロール**だった（9/2 は PDF の取得と作り直しだけ）。前回ビルドの items の日付は state で確かめる
- クロールは台帳を脇にどけて全件取り直した（当時の `01_crawl` は 304 のページの下をたどらず、04 も 304 の PDF を新しいスナップショットに保存しなかった。2026-09-24 に直した。上の「台帳を使う取り直し」）
- 13_assign は重複 392 本（`sozoku2/01.htm`）と目次 9 本を外して 557 本・実費 ¥124（1 本 ¥0.22）。null 59 本（石油石炭税 20・国際観光旅客税 18・消費税 13・石油ガス税 8）
- 24（国税庁から消えたページの復元）は**流さなかった**（オーナー判断。今の画面は `gone` を読まないので、廃止されたかもしれない通達が現役と同じ顔で出る。R1）
- 20 の `--dump-titles` を 07 の前に流さないと、前回ビルドの PDF の見出しを引き継げない（v4 で 29 件が空になり、流し直して戻した）
- 国税庁が PDF 114 本を文字の無い画像だけの版に差し替えていた。本文で検索に掛からない（見出しと紐付けは残る）。直すには OCR が要る（未対応）
- Vectorize の上限: `get_by_ids` は 1 回 20 件、`delete_by_ids` は 100 件（22 と `local_vec_v3.py` の既定を合わせた）。upsert は 200 件で通る
- ベクトル: 投入 6,304（巨大条文 1,272・_reverse 5,032）＋ homes 更新 1,522、削除 456 指定（実在 47）。互換性 cosine 1.0000、法人税法 22 条でカナリアと控えからの戻しを確認
- 措置法 70 条の 7 の 2 の条キーに空白（`70 の7の2`）があるように見えたのは、PowerShell の長い 1 行の折り返しをコピーしたときに入った空白だった（2026-09-24 に紐付けとベクトルの実物を文字コードで確かめ、`70の7の2` の 1 本・58 本で問題なし）。長い出力の中の文字は貼られた見た目で判断せず、`JSON.stringify` や文字コードで確かめる。07 は念のため条キーの空白を除き、08・21 は空白入りのキーがあれば止まる（PR #161）
- PC の Claude Code（リモート接続）では、R2・Vectorize への書き込みと LLM の実行は自動モードの権限判定で止まる。オーナーが PC の PowerShell で直接流した
