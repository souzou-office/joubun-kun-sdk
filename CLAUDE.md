# 条文くんの法令データの更新のプログラム — AI 向けの手引き

このリポジトリは、条文くん（https://joubun-kun.com/）が法令データを毎週作り直しているプログラムの写しです。できあがったデータは Hugging Face（`https://huggingface.co/datasets/souzou-office/joubun-kun-law-data`）で公開しています。全体の説明は `README.md` にあります。

利用者はふつう「このデータはどう作っているの」「この条の参照関係はなぜこうなるの」「このパーサーの誤りを直して」のように頼んできます。

## どこに何があるか

| 頼まれたこと | 見るところ |
|---|---|
| 法令の取り直し・条への分け方 | `scripts/rebuild/lib/egov_parser.py`・`lib/split.py`・`scripts/update/` |
| 参照関係（「第○条」「同条第N項」の読み取り） | `scripts/rebuild/lib/refs_extract.cjs`・`src/refsResolve.mjs` |
| 委任先（「政令で定める」の受け皿） | `scripts/delegation/` |
| 通達・質疑応答事例・裁決の紐付け | `scripts/tsutatsu/`・`scripts/cases/`・`scripts/shitsugi/`・`scripts/saiketsu/` |
| 判例と、判例の今の条への付け直し（条の系譜） | `scripts/hanrei/`・`scripts/lineage/`（`docs/lineage.md`） |
| 公開データの書き出し（JSONL・Hugging Face） | `scripts/open_data/` |
| データの項目の意味 | `SCHEMA.md`・足りないところは `KNOWN_GAPS.md` |

## 直すときの決まり

- **直したら、そのフォルダの `check_*` を流して通す**（本番に触らない・¥0・LLM なし）。手元で試すときは `R2_FAKE_DIR` と `AI_FAKE=1`（`scripts/update/README.md`）
- **パーサーの出力の形を変えない。** 変えると全部の法令が「変わった」扱いになる。直したいときは、出力の形を保ったまま読み取りを直す
- **条文の本文を書き換えない。** 条文は e-Gov法令検索の原文のまま。足すのは構造・参照関係・紐付けだけ
- **出典の表示を消さない**（e-Gov法令検索（デジタル庁）・国税庁・国税不服審判所・裁判所・名古屋大学「法令XMLデータ」）
- 条の ID は `{法令ID}_Art{条の数字を _ でつなぐ}`。推測で ID を作らず、データか条 1 つの JSON（`https://joubun-kun.com/law/{法令ID}/{条}.json`）で実在を確かめる

## してはいけないこと

- 鍵（API キー・トークン）をコードやファイルに書く
- 取り直し先のサイト（e-Gov・国税庁・裁判所など）に、間を空けずにたくさん読みに行く（取り直しのコードの間隔と条件付きの取得を守る）
