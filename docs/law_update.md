# 法令データの週次更新（自動反映・問題があるときだけ知らせる）

2026-09-20 設計・実装。5 月 21 日の全件再構築のあと、法令データ（`large_law_articles_v3`・`law-embeddings-v2`・`refs_chunks_v4`）は一度も更新されていなかった。
毎週自動で e-Gov の改正差分を取り込んで**そのまま反映**し、**問題があるときだけ人に知らせる**仕組みにする。コードは `scripts/update/`、ワークフローは `.github/workflows/update_laws.yml`。

## 毎週の流れ

```
日曜 05:00 JST  GitHub Actions が起動
  prepare（自動・R2 に書かない）
    02 e-Gov の全法令一覧を取り、台帳（R2 update_state/sync_state.json）の改正 ID と突合
    03 変わった法令の XML を取る
    04 パース → 条文単位ファイル（編・章の目次つき）
    05 R2 の今の中身と比較 → manifest（何を上書き・削除するか、条数、振り直し、宙に浮く紐付け、ベクトルの差分、blockers）
    06 変わった項だけ埋め込み（bge-m3）
    09 変わった法令の参照関係を抽出
    → Job Summary に report.md。artifact に state/ を保存
  安全チェック（blockers）に通り、見直す対象も無ければ、そのまま apply へ（人は何もしない）
  それ以外は書く前に止めて Issue（ラベル law-update）を立て、オーナーに割り当てる（= メールが届く）。本文は report.md
    【止めた・要修正】安全チェックに引っかかった。そのまま流す経路は無い。原因を直して再実行（Issue の URL を Claude に渡す）
    【未反映・要確認】見直す対象がある。表を見て問題なければ Issue に「反映」とコメント（メール返信可）→ apply が走る。直すなら直して再実行
  apply
    07 退避してから R2 を上書き・削除
    08 Vectorize upsert / delete
    09 refs チャンクへ差し込み（被参照も直す）
    10 台帳と data_metadata.json（画面の「○月○日時点」）を更新
    11 抜き取り検証
  反映に失敗したときも Issue（ログと戻し方つき）。通った週は静か。記録は Actions の Job Summary と artifact に残る
```

「反映」で動かせるのはリポジトリのオーナー（souzou-office）だけ。コメントの最初の行（メール返信の引用 `>` と空行を除く）がちょうど「反映」のときだけ動く（「反映しないで」「反映は来週」では動かない。2026-09-25。判例の週次と同じ）。【止めた・要修正】の Issue は「反映」では動かない。どうしても止めたまま流す必要があるとき（安全弁の閾値そのものが厳しすぎた等）は、手動実行の `mode=apply` に `prepare_run_id` と `force` を付ける。通常は使わない。

## 埋め込み（ベクトル）の一貫性

索引 `law-embeddings-v2` は 2026-05 にローカルの bge-m3（RTX 5070・CLS pooling）で作った。週次更新は Workers AI（`@cf/baai/bge-m3`）で作るので、**両者の出力が同じ空間であること**が前提になる。
2026-09-02 には Workers AI の出力と索引が cosine 1.0000 で一致していたが、09-13 には 0.91〜0.92 に落ちていた（Workers AI 側が変わった。`docs/benchmarks/tax_ab/EMBED_SELFMATCH_20260913.md`）。仮説は pooling の既定が cls → mean に変わったこと。

- 検査: `node scripts/update/check_embed_drift.cjs`（Actions では `mode=embedcheck`）。索引に入っている項 20 本を、既定 / cls / mean の 3 通りで埋め込み直して cosine を出す
- 一致する設定が分かったら、**Worker の vars `AI_POOLING`（wrangler.toml・staging）と GitHub の Variables `AI_POOLING` に同じ値**を入れる。検索時の埋め込みと週次更新の埋め込みが同じ設定になる
- 週次の prepare は毎回この検査を通す。今の設定で自己一致の最小が 0.98 未満なら blockers（`embed_drift`）として止まり、ベクトルを書かない
- どの pooling でも一致しない場合は、索引を Workers AI で全件作り直す（新しい索引に Blue-Green）か、埋め込みをローカル GPU に戻すかの判断が要る

## 安全弁（止める条件）

- 埋め込みのずれ（上）

- パース失敗が 1 件以上（パーサーの不具合なら他の法令も欠けている可能性があるので、全部止める）
- 変わった法令が 800 を超える（`UPDATE_MAX_CHANGED_LAWS`）
- 1 法令の条数が 30% 超減った（`UPDATE_MAX_DROP_RATIO`。条数 10 以上の法令のみ）
- 本文が取れていない法令がある

## 見直す対象（書く前に止めて知らせる。確認後「反映」で流せる）

- **条番号の振り直し疑い**: 改正前後で条タイトル集合の一致率が 0.5 未満。通達・判例・事例・裁決・委任先はすべて「法令 ID＋条番号」で紐付けているので、この法令の紐付けは人が見直す
- **宙に浮く紐付け**: 通達（`tsutatsu_chunks_*/{law_id}.json`）、判例（`hanrei_v1/links`）、質疑応答・裁決（`article_links_v1`）、委任先（`delegations_v1`）が指す条番号が、改正前の条の集合にはあって新しい集合に無い（この更新で新たに浮くもの）。改正前から無い条番号を指す紐付け（削除済み条への判例・事例など）は止める理由にせず、報告の「もとから浮いていた紐付け」に参考で出す（2026-09-27 の初回はこれ 139 件だけで止まった。掃除は別作業）
- **見出しの変化**: 通達・判例・事例・裁決が紐付いている条の見出し（caption）が変わった。中身が変わった可能性がある。委任先だけが付いた条の見出しの変化では止めない（2026-10-11。委任先の週次 `update_delegations.yml` が反映の後に紐付けをやり直し、委任が大きく減るなどは向こうの Issue で知らせる。判定は `lib/common.cjs` の `isReviewLaw`）
- 廃止された法令は止めずに消す（2026-11-07 オーナー: 「現行法令だけでいい・廃止法令はいらん・版ごとの法令は e-Gov で調べられる」。2026-10-11 から 11-07 までは報告に出すだけで、ファイルもベクトルも残していた）。05 の差分で「R2 に目次がある・新しい台帳に無い」法令（その週に廃止された法令と、前から残っている分）を拾い、e-Gov の法令 API（`lib/egov_api.cjs` の `fetchLawStatus`）が廃止（`repeal_status` が `None` 以外。`Repeal`・`Expire` など）と答えたものだけを manifest に `is_repeal` の法令として入れる。全ファイルを消し（07 が `backup_updates/{run_id}/` に退避してから）、ベクトルを全部消し（08 が値ごと退避してから）、09 がその法令の参照（参照している側）を空にして参照先の「参照されている」からも外す。今の法令からその法令への参照は今の法令の側に残る。e-Gov に無い・読めない・廃止でないと答えた法令は消さずに報告の「台帳に無いが消さなかった法令」に出す。ただし e-Gov に無い法令のうち、題名（目次 `_index.json` の `law_title`）が「…の施行期日を定める政令」「…の政令で定める日等を定める政令」のものは消す（2026-11-11 オーナー。施行日を決めるだけの 1 文の政令で、e-Gov の法令 API はこの種類を載せない。11-08 の時点で令和 8 年の 16 本と平成 21 年の 1 本が残っていた）。`repeal_status: 'NotInEgov'`・廃止日なしで扱い、条文ページは「この政令は掲載していません」と e-Gov へのリンクを 404 で出す。1 回に消す法令が `UPDATE_MAX_REPEALED_LAWS`（既定 60）を超えたら止める。新しいプレフィックスへの全件の作り直しでは消さない。通達・判例・事例と裁決・委任先の紐付けは消さない（条文ページが無くなるので画面には出ない）。別表・委任先の週次は条文が無くなった法令を自分で外す。月次の全件点検の「refs の行き先の法令が無い」などの件数は消した回に 1 度増える（注意）。消している途中に落ちても拾い直せるように、07 が消す前に控え `update_state/repeal_pending/{law_id}.json`（ファイル名・ベクトルの ID）を置き、10 が最後に外す。控えが残っていれば次の 05 が、目次が消えていても控えの ID で残りを消し直す。戻すのは `restore_backup.cjs {run_id}`（その回の控えも外す。廃止された法令なので次の週次がまた消す）。消し直しをまたいだ法令は、控えの `run_ids` に退避した回が全部残っているので、その回を全部 `restore_backup.cjs` で戻す（戻すとログに出る）。10 は消した法令の題名・廃止日を `update_state/repealed_laws.json` に足し、条文ページ（`worker/lawpages.js` の `missingLaw`）はその法令の URL に「この法令は廃止されました」と廃止日・e-Gov（時点を指定して過去の版を見られる）・同じ題名の現行の法令へのリンクを 404 で出す（2026-11-07）。今の法令から廃止された法令への参照は、廃止と同時に整備法で直されるのがふつうで、11-07 の 13 本では今の法令からの参照は 0 件だった。確かめは `node scripts/update/check_repeal.cjs`（¥0）

## 包括チェック（e-Gov と一致しているか）

- 毎週: 改正 ID の突合（02）。1 件でも違えばその法令は更新対象になる → 「今の版が最新か」は毎週保証される
- 月 1 回（手動: mode=check）: 全法令の本文を取り直し、条の集合と本文ハッシュを R2 と比べて報告だけ出す。差があれば翌週の対象に手で積む（`mode=laws`）
- 反映後（11）: R2 に置いたファイルのハッシュと、Vectorize の ID の有無を抜き取り

## 初回: 全件再構築（v4）

編・章の目次を全法令に入れるため、最初の 1 回は新しいプレフィックスへ全件を流す（本番の v3 は触らない）。

1. Actions → Update law data → Run workflow: `mode=full`, `articles_prefix=large_law_articles_v4`, `old_articles_prefix=large_law_articles_v3`, `refs_prefix=refs_chunks_v5`, `old_refs_prefix=refs_chunks_v4`
   - 全件の XML 取得（約 5GB）→ パース → v3 と比較（本文が同じ項はベクトルを作り直さない）→ v4 と v5 に書く。本番が読む v3 には書かないので、Run workflow を押すことが承認。台帳も更新される
   - 時間の目安: prepare 3〜4 時間 + apply 1〜2 時間。1 ジョブの上限（6 時間）に収まらないので `full`（prepare）と `full-apply` の 2 ジョブに分かれ、間は R2 の `update_state/runs/{run_id}/state.tar.gz`（`scripts/update/stash_state.cjs`）で渡す。prepare が終わって apply だけ流し直したいときは `mode=apply-full` に `prepare_run_id`（prepare の実行 ID）と同じ 3 つのプレフィックスを付けて Run workflow。**どちらも Branch は main**（他のブランチからは動かない）
   - runner の容量が足りずに落ちたら PC で同じコマンド（`run.cjs prepare --all` → `apply`）を流す
   - 2026-09-21 run #8 の実測: prepare 3 時間 28 分（9,011 法令、書き込み 286,798 ファイル、ベクトル upsert 16,253 / delete 3,612）。止まった理由は 2 つで、どちらも直した: (a) 未施行の新法（`current_revision_status: UnEnforced`。例 508AC1000000078）は `law_file/xml/{law_id}` が 404 になる → 改正 ID で取り直す（`_index.json` の `_source.revision_status` に `UnEnforced` が残る）。(b) 別表の見出しが 255 バイトを超えてファイルが作れない → ファイル名を UTF-8 で 200 バイトに切る（`split.py` / `lib/common.cjs` / Worker の `safeFilename` が同じ規則）。また lawtext が落ちる法令（化学物質名の `'` など 19 件）は `old_refs_prefix` の refs を写す
2. `wrangler.staging.toml` の `ARTICLES_PREFIX` を v4、`REFS_PREFIX` を v5 にして staging を配り、検索・MCP・条文ページを確認
3. `wrangler.toml` の `ARTICLES_PREFIX` と `REFS_PREFIX` を同じ値にして main から本番を配る。戻すときは v3 / v4 に戻して配る（2026-09-21 に実施: prepare 1 時間 28 分、apply は 07 が 3 時間 40 分（R2 の一時エラーで再試行が多い）、08〜11 が 20 分。refs 2,058,735 件・被参照 603,133 件・378 チャンク）
4. 1〜2 週間して問題なければ v3 と v4 を消す（手で）

以後の週次は v4 に差分を書く（`ARTICLES_PREFIX` は Actions の既定＝`lib/common.cjs` の既定なので、v4 に切り替えたら `lib/common.cjs` の既定も v4 に変える）。

## 事前準備（1 回だけ）

1. Cloudflare で API トークンを作る: アカウント権限 **Workers R2 Storage: Edit**、**Vectorize: Edit**、**Workers AI: Read**。GitHub の secret `CF_DATA_API_TOKEN` に入れる（Pages 配備用の `CLOUDFLARE_API_TOKEN` は流用しない）
   - R2 の読み書きはこのトークンから導いた S3 互換 API の鍵で行う（トークン ID と値の SHA-256。秘密は増えない）。REST API は Cloudflare 全体で 5 分 1,200 件の上限があり、全件再構築（数十万オブジェクト）は 429 で止まる（2026-09-20 run #7）。通り道は `R2_TRANSPORT`（auto / s3 / rest）
2. GitHub の通知メールが届く設定になっていることを確認（Settings → Notifications で Participating と Assigned にメール）。知らせは Issue の割り当てで届く
3. 初回の全件再構築（上）を流す。台帳 `update_state/sync_state.json` はこのとき R2 にできる（条文の公開ページ `worker/lawpages.js` もこの台帳を読んで法令一覧・サイトマップ・未施行の印を作る。`docs/law_pages.md`）

## 戻し方（数分・再ベクトル化なし）

```
node scripts/update/restore_backup.cjs {run_id} --dry-run   # 何が戻るか
node scripts/update/restore_backup.cjs {run_id}
```

apply は書く前に必ず `backup_updates/{run_id}/` に退避している。戻るのは次の全部:

- 条文ファイル: 上書き前の中身に戻し、その回で新規に作ったファイルは消す
- 参照関係のチャンクと索引
- Vectorize: 上書き・削除される ID の**ベクトルそのもの**を退避してあるので、それを upsert し直し、その回で新規に入れた ID は消す
- 台帳 `update_state/sync_state.json` と `data_metadata.json`（戻すと次の週次で同じ法令がもう一度「変更」として出る）

run_id は Actions の実行番号（`{run_id}-{attempt}`）。report.md の見出しにも出る。

## 通達・裁決・事例・判例の側の更新

条文側の紐付けは上の「宙に浮く紐付け」「見出しの変化」で監視する。通達そのものの改定（国税庁側）は `scripts/tsutatsu/` のクローラーに変更検知の台帳（`crawl_ledger.json`）があるので、月次でそれを回す段階を後で足す。

## 実装上の注意

- ベクトル ID は `scripts/rebuild/lib/ids.py` と 1 文字も違えてはいけない。`node scripts/update/check_vector_ids.cjs` で Python と突き合わせる
- 条文ファイルの JSON の並び・区切りを変えると全件「変更」になる（`scripts/rebuild/lib/split.py` を共用しているのはそのため）。`_source` に時刻を入れないのも同じ理由
- R2 にはステージングが無い（本番・staging・bench が同じバケット）。書くのは apply だけ、書く前に必ず退避
- 手元の確認は `R2_FAKE_DIR` / `VECTORIZE_FAKE_FILE` / `AI_FAKE=1` で ¥0（`scripts/update/README.md`）

## refs（参照関係）だけ作り直す（2026-09-22）

抽出ロジック（`scripts/rebuild/lib/refs_extract.cjs`）を変えたときは、条文・ベクトル・台帳を触らずに refs だけ全件作り直す。

- Actions → Update law data → Run workflow: `mode=refs`（**Branch は main**）。ジョブ `refs` が 02（全件を対象に）→ 03 XML 取得 → 09 抽出 → 09 反映（`--refs-only --rebuild-reverse`。reverse_refs も全法令から作り直す）を 1 ジョブで流す。上書き前のチャンクは `backup_updates/{run_id}/` に残る（`restore_backup.cjs {run_id}` で戻る）
- 02 は `--require-clean` で、台帳（本番に反映済みの改正 ID）と e-Gov の一覧が一致することを確かめる。違えば **書く前に止まる**（取ってくる XML が本番の条文と別の版だと、refs の位置情報（項・文・オフセット）が本番の本文とずれるため）。止まったら先に `mode=diff` を流して条文を最新にしてから `mode=refs` を流し直す。`--force` は手元の確認用（位置がずれてよい場合だけ）
- 09 は `--refs-only` で manifest を見ない（extract は state/xml、patch は state/refs の全法令。退避 ID は今回の実行 ID）。run.cjs refs は始めに state/xml と state/refs を消す
- 手元: `node scripts/update/run.cjs refs --laws ID,ID`（`R2_FAKE_DIR` で ¥0）
- 2026-09-22 の改修: (a) 「」内の読み替え文言の条文（「借地借家法第四十一条の事件の記録」「第百三十三条の四第一項」など。lawtext は鉤括弧の中を引用文として拾わない）を、法令名付きはその法令、裸の第N条は同じ文で鉤括弧より前に出た直近の他法令（準用元）として拾う。(b) 他法令の「同条第N項」「第N項」「同項」に直前の条番号を引き継がせる（`src/refsResolve.mjs`。画面・条文ページも同じものを使うので、データを作り直す前から表示は直っている）。固定データの確認は `node scripts/check_refs_resolve.cjs`



## 反映中の印（2026-09-26）

`run.cjs apply` と `run.cjs refs` は、書き始める前に `update_state/laws_apply_inprogress.json`（run_id・mode・開始時刻）を置き、全部の段が通ってから外す（`scripts/update/apply_mark.cjs`）。途中で落ちると残る。別表・委任先の週次は、この印があると条文・refs が書きかけとみなして下見・反映をしない。本番チェックも「法令の週次の反映中の印」として知らせる。流し直して反映を終えれば外れる。

- 別の mode の印が残っているとき（例: apply が途中で落ちた後に refs を流す）は、置くのも外すのも断る（refs の成功で apply の書きかけを隠さない）。同じ mode の流し直しは印を引き継ぎ（`resumed_from` に前の run_id）、全部の段が通ってから外す
- 別表・委任先の反映と同時には書かない: 法令は印を置いてから別表・委任先の作業中の印を見て、動いていれば印を戻して止まる（Issue が立つ。終わってから流し直す）。別表・委任先は自分の印を取ってから法令の印を見る。どちらも先に自分の印を書いてから相手を読むので、同時に始めても少なくとも片方が止まる。3 時間より古い相手の印は落ちて残ったものとみなし、法令は止めない
- 確かめ: `node scripts/update/check_apply_mark.cjs`（¥0）
