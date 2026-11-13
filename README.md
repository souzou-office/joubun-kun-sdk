# 条文くんの法令データの更新のプログラム

[条文くん](https://joubun-kun.com/)（司法書士法人そうぞう）が、検索と条文ページに使う法令データを毎週作り直しているプログラムです。条文くんの本番で毎週動いているものを、そのまま写しています。

できあがったデータは Hugging Face で公開しています。何が入っていて、何が入っていないかは、データの公開のページにまとめています。

- データ: [huggingface.co/datasets/souzou-office/joubun-kun-law-data](https://huggingface.co/datasets/souzou-office/joubun-kun-law-data)
- データの公開のページ: [joubun-kun.com/law/data](https://joubun-kun.com/law/data)

データベースの中身を誰でも確かめられるように公開しています。**完成品ではなく、「今ここまで整えています」の公開です。** 条文くんの検索（質問から条文を選ぶ仕組み・説明文の作り方）は含みません。

## このプログラムがすること

毎週、次の順に流れます。

1. **法令を取り直す**: e-Gov法令検索（デジタル庁）の法令 API から、前の週から改正された法令だけを取り直します。廃止された法令は、法令 API で廃止を確かめてから消します（現行の法令だけを持ちます。改正前の版・廃止された法令は e-Gov法令検索で調べられます）。
2. **条に分ける**: 法令の XML を読んで、条・項・号・イロハまで分けます。
3. **参照関係を付ける**: 条文の中の「第○条」「同条第N項」「前項」などを読んで、どの条がどの条を引いているかを付けます。読み替えの文言の中の条も解決します。
4. **委任先を付ける**: 「政令で定める」「法務省令で定める」と書いた箇所に、受け皿になる政令・省令の条を付けます。確からしさの段階つきです。
5. **資料を条に紐付ける**: 国税庁の通達・質疑応答事例、国税不服審判所の裁決、裁判所の判例を取り直し、どの条についての資料かを付けます。
6. **判例を今の条に付け直す（条の系譜）**: 判例は判決のときの条番号で条文を引いています。改正で番号が変わった条や作り直された法令の条を、今の条へつなぎます（旧民事訴訟法89条 → 今の民事訴訟法61条など）。
7. **書き出す**: データを JSONL にして、Hugging Face に新しい版として上げます。前の版と同じなら版を増やしません。

途中で件数が急に減る・反映が途中で止まる・書き出しの間に元のデータが変わる、といったときは、書く前に止めて知らせます。

## コード

| フォルダ | 中身 |
|---|---|
| `scripts/rebuild/`・`scripts/update/` | e-Gov からの取得・パーサー・参照関係の抽出・毎週の差分の反映 |
| `scripts/delegation/`・`scripts/beppyo/` | 委任先（「政令で定める」の受け皿）・別表 |
| `scripts/tsutatsu/`・`scripts/cases/`・`scripts/shitsugi/`・`scripts/saiketsu/` | 通達・質疑応答事例・裁決の取得と条への紐付け |
| `scripts/hanrei/` | 判例の取得と、判決文の中の条文の引用の読み取り |
| `scripts/lineage/` | 条の系譜（判決のときの条 → 今の条） |
| `scripts/treaty/` | 租税条約 |
| `scripts/open_data/` | Hugging Face への書き出しと上げ方 |
| `examples/workflows/` | 条文くんで毎週流している GitHub Actions |

各フォルダの `check_*` は、本番に触らずに流せる確かめです（¥0・LLM なし・固定のデータ）。

```sh
node scripts/update/check_apply_mark.cjs
node scripts/open_data/check_export.cjs
python3 -I -X utf8 scripts/lineage/check_lineage.py
```

自分で動かすときは、データの置き場（Cloudflare R2 か、手元のディレクトリ）が要ります。手元で試すときは `R2_FAKE_DIR`（手元のディレクトリを置き場に見立てる）と `AI_FAKE=1` を使います（`scripts/update/README.md`）。置き場の中の名前（プレフィックス）は `wrangler.toml` に書いてあります。

## できあがるデータ

| ファイル | 中身 |
|---|---|
| `laws.jsonl.gz` | 法令 1 本 1 行（現行の法令 約 9,000 本。題名・法令番号・種別・改正 ID・目次） |
| `articles.jsonl.gz` | 条 1 件 1 行（項・号・イ ロ ハまで分けた本文） |
| `refs.jsonl.gz` | 参照 1 件 1 行（この条 → 引いている条） |
| `delegations.jsonl.gz` | 委任 1 件 1 行（「政令で定める」等の受け皿） |
| `kokuji_gaps.jsonl.gz` | 告示に委任しているのに、受け皿の告示が条文くんにまだ入っていない箇所 |
| `links.jsonl.gz` | 条 → 通達・質疑応答事例・裁決・判例の紐付け（資料の ID・題名・日付・原文の URL・付け方。本文は入れない） |
| `MANIFEST.json` | 版・時点・件数・バイト数・sha256 |

項目の説明は [SCHEMA.md](SCHEMA.md)、足りないところは [KNOWN_GAPS.md](KNOWN_GAPS.md) にあります。検索用のベクトルは入れていません。条文から bge-m3（MIT ライセンス）で作り直せます。

```sh
# 最新の版の件数
curl -sL https://huggingface.co/datasets/souzou-office/joubun-kun-law-data/resolve/main/MANIFEST.json | jq '{release, files}'

# 会社法（417AC0000000086）第26条の本文
curl -sLO https://huggingface.co/datasets/souzou-office/joubun-kun-law-data/resolve/main/data/articles.jsonl.gz
zcat articles.jsonl.gz | jq -c 'select(.article_id == "417AC0000000086_Art26") | {title, caption, full_text}'
```

条の ID は `{法令ID}_Art{条の数字を _ でつなぐ}` です（例 会社法第26条 `417AC0000000086_Art26`、第七十条の六の二 `332AC0000000026_Art70_6_2`）。1 条ずつなら、鍵なしの JSON（`https://joubun-kun.com/law/{法令ID}/{条}.json`）でも読めます。

## 誤りを見つけたら

- **データの誤り**: Hugging Face のデータのページの [Community](https://huggingface.co/datasets/souzou-office/joubun-kun-law-data/discussions) で知らせてください。ID と、正しい内容、根拠（原典の URL）を書いてもらえると助かります。
- **プログラムの誤り**: このリポジトリの Issue か PR で。パーサーや紐付けのルールを直すと、全部の法令に効きます。

確かめて直し、条文くんにも反映します。個別のサポートと返事は約束できません。

## 出典とライセンス

- データ（構造化・参照関係・委任先・紐付け）は **CC BY 4.0**、コードは **MIT**（[LICENSE-CODE](LICENSE-CODE)）です。
- 法令の本文の出典は e-Gov法令検索（デジタル庁）です。紐付け先の資料は、国税庁・国税不服審判所・裁判所の公開情報です。判例の今の条への付け直しは、名古屋大学「法令XMLデータ」（佐野智也・外山勝彦・増田知子、CC BY 4.0）の改正の経過に基づきます。詳しい条件は [LICENSE.md](LICENSE.md) にあります。

表示の例：

> 出典: e-Gov法令検索（デジタル庁）。条文くん（司法書士法人そうぞう）が加工 https://huggingface.co/datasets/souzou-office/joubun-kun-law-data （2026-11-06 版）

**保証はありません。** 正確さ・完全さ・最新であることを保証しません。法令の正本は官報です。法的な助言ではありません。

## 運営

条文くん（司法書士法人そうぞう）
