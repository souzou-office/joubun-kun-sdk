# データの形式（format_version 1）

どのファイルも JSON Lines（1 行 1 件）を gzip で固めたものです。どの記録にも、次の共通の項目があります。

| 項目 | 意味 |
|---|---|
| `as_of` | データの時点（法令は e-Gov から取った日） |
| `source_url` | 原文の場所（ある記録だけ） |
| `method` | どう作ったか。`original`（原文の写し・構造化だけ）／`rule`（決まったルールで作った）／`llm`（AI が付けた）／`human`（人が確かめた・入れた） |

項目を足すだけのときは `format_version` を変えません。意味を変えるときだけ上げます。知らない項目は読み飛ばしてください。

## laws.jsonl.gz（法令 1 本 1 行）

| 項目 | 意味 |
|---|---|
| `law_id` | e-Gov の法令 ID（改正しても変わらない） |
| `law_title` / `law_num` | 題名・法令番号 |
| `law_type` | `Constitution`・`Act`・`CabinetOrder`・`ImperialOrder`・`MinisterialOrdinance`・`Rule`・`Misc` |
| `law_revision_id` | 今の版の ID（`{法令ID}_{施行日}_{改正法令ID}`） |
| `revision_status` | `CurrentEnforced`（施行中）・`UnEnforced`（未施行の改正がある）など |
| `amendment_promulgate_date` / `amendment_enforcement_date` | 最後の改正の公布日・施行日 |
| `abbrev` / `category` | 略称・分類（e-Gov の値） |
| `article_count` / `main_article_count` | 条のファイルの件数（附則・別表を含む）／本則の条の数 |
| `toc` | 目次（編・章・節と、その最初の条） |
| `page_url` | 条文くんの法令ページ |

## articles.jsonl.gz（条 1 件 1 行）

| 項目 | 意味 |
|---|---|
| `article_id` | 本則の条の ID（`{法令ID}_Art70_6_2`）。附則・別表・様式は `null` |
| `law_id` | 法令 ID |
| `provision` | `main`（本則）／`suppl`（附則） |
| `type` | `article`（条）・`appdx_table`（別表）・`appdx_style`（様式）・`appdx_fig`（図）・`appdx_format`（書式）・`appdx_note`（備考） |
| `number` | e-Gov の XML の条番号（`70_6_2`） |
| `title` / `caption` | 条名（`第七十条の六の二`）・見出し（`（定款の作成）`） |
| `structure` | 編・章・節・款・目（`part`・`chapter`・`section`・`subsection`・`division`）。附則は `{suppl: true, amend_law_num}` |
| `paragraphs` | 項の配列。`[{num, sentences:[{num,text}], items:[{item_num, item_title, sentences, sub_items:[…]}]}]` |
| `full_text` | 本文（改行でつないだもの） |
| `images` / `is_form` | 様式・図の画像のファイル名（e-Gov の添付）／様式か |
| `page_url` | 条文くんの条文ページ（本則の条だけ） |

同じ見出しの附則（改正法ごとの附則 第一条など）は別の行になります。区別は `structure.amend_law_num` です。

## refs.jsonl.gz（参照 1 件 1 行）

| 項目 | 意味 |
|---|---|
| `from` / `from_article_id` | 参照している条（`{法令ID}_Art26`）。附則・別表から参照しているときは `from_article_id` が `null` |
| `paragraph` / `item` / `subitem` / `sentence_index` | 参照が書いてある項・号・文 |
| `start` / `end` | その文の中の文字の位置 |
| `type` | `internal`（同じ法令）・`external`（他の法令）・`varref`（読み替え） |
| `to_law_id` / `to_article_id` | 参照されている法令・条 |
| `target_*` | 抽出したままの行き先（条・項・号・別表・法令名・法令番号） |

「この条を参照している条」（逆向き）は、`to_article_id` で引いてください。

## delegations.jsonl.gz（委任 1 件 1 行）

| 項目 | 意味 |
|---|---|
| `from_article_id` | 委任している条 |
| `paragraph` / `item` | 委任が書いてある項・号 |
| `expr` / `trailing` | 委任の文言（`政令で定める`）とその後の数文字 |
| `kind` | 委任先の種類（政令・省令・告示など） |
| `status` | 受け皿の確からしさ。`confirmed`（1 つに決まった）・`multiple`（候補が複数）・`weak`（関連する条のレベル）・`none`（見つからない）・`law_level`（条は決まらないが受け皿の法令は 1 本）・`kokuji`（告示への委任。受け皿が無い） |
| `candidates` | 受け皿の候補 `[{law_id, article, article_id, paragraph, item, strength, …}]` |
| `law_level` | `status: law_level` のときの受け皿の法令 |

`confirmed` は試験で 96〜98% 正しいことを確かめています。`weak` と `none` は確かではありません。

## kokuji_gaps.jsonl.gz（告示の未収録箇所）

| 項目 | 意味 |
|---|---|
| `gap_id` | 未収録箇所の ID（委任元の条・項・号・文言から作るので、版が変わっても同じ委任は同じ ID） |
| `law_id` / `law_title` / `from_article_id` / `article_title` | 委任している法令と条 |
| `paragraph` / `item` / `expr` / `trailing` / `kind` | 委任の場所と文言 |
| `page_url` | 条文くんの条文ページ |

`gap_id` は委任元の条・項・号・文言から作るので、版が変わっても同じ委任は同じ ID です。

## links.jsonl.gz（条 → 通達・質疑応答事例・裁決・判例の紐付け 1 件 1 行）

条文ページの「関連する一次情報」に出しているものと同じ紐付けです。**資料の本文は入れていません**（原文は `url` から読んでください）。

| 項目 | 意味 |
|---|---|
| `article_id` / `law_id` / `page_url` | 紐付け元の条と、その条文ページ |
| `kind` | `tsutatsu`（通達）／`shitsugi`（質疑応答事例）／`saiketsu`（裁決）／`hanrei`（判例） |
| `source_id` | 資料の ID（通達は無いことがある） |
| `title` / `date` / `url` / `source` | 資料の題名・日付・原文の URL（国税庁・国税不服審判所・裁判所のものだけ）・出典 |
| `method` | `rule`（条文の引用の読み取りなど決まったルール）／`llm`（AI が付けた）／`null`（行ごとの区別が無い。通達は一部を AI が付けている） |
| `number` / `group` / `format` / `abolished` | 通達だけ: 通達の番号・通達の分け（`kihon/hojin` など）・`html` か `pdf`・廃止の印 |
| `confidence` | 質疑応答事例・裁決だけ: 紐付けの確からしさ（0〜1） |
| `court` / `case_number` / `result` | 判例だけ: 裁判所・事件番号・結果 |
| `cited_as` | 判例だけ: 判決文での引き方（`{ law, art, old }`。旧法・改正前の条を今の条に付け直したとき） |
| `notes` | 判例だけ: 判決の後の改正などの注記（`{ k, d, law, n }`。`k` は `amended`・`before`・`near`・`ord`・`old_name`・`prior`・`born`・`other_law`） |
| `ai_reason` | 判例だけ: AI が「今の条にも通用する」とした理由（`method: llm` のとき） |

判例は、判決のときの条番号を条の系譜で今の条に付け直した結果です（名古屋大学「法令XMLデータ」CC BY 4.0 に基づく）。今の条にも判断が通用すると確かめたものだけを入れています。

## 条 1 つの JSON（`https://joubun-kun.com/law/{法令ID}/{条}.json`）

条文ページと同じデータを 1 条ずつ返します（毎週更新・鍵なし・CORS 可）。本則の条だけです（附則は条文ページで）。

| 項目 | 中身 |
|---|---|
| `article_id`・`law_id`・`law_title`・`title`・`caption` | 条の ID・法令・見出し |
| `paragraphs`・`full_text` | 本文（項・号まで構造化）と全文 |
| `refs` | この条が引いている条（`to_article_id` は行き先の条の ID） |
| `referenced_by` | この条を引いている条の ID |
| `delegations` | 委任先（「政令で定める」等の受け皿。`status` は確定・複数・法令単位・告示） |
| `tsutatsu`・`shitsugi`・`saiketsu` | 通達・質疑応答事例・裁決へのリンク |
| `hanrei.items` | この条についての判例（上位 300 件）。`cited_as`：判決文での引き方（「旧民事訴訟法89条として引用」など。今の番号と違うときだけ）・`notes`：判決の後の改正などの注記・`assigned_by`：判決文に今の条番号が無く AI が付けたときはその理由 |
| `hanrei.other_provision` | 判決当時はこの番号が別の規定だった判例（今の条の判例ではない） |
| `amendments` | この条の改正（施行日・改正法・どんな改正か） |
| `prev`・`next` | 前後の条 |
| `source_url`・`page_url` | e-Gov の原文・条文くんの条文ページ |
| `license`・`attribution` | ライセンスと出典の表示 |

判例の付け直し（判決のときの条番号 → 今の条）は、名古屋大学「法令XMLデータ」（CC BY 4.0）の改正の経過と e-Gov の版から作った「条の系譜」によります（コードは `scripts/lineage/`）。

