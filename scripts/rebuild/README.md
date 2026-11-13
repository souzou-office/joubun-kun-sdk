# scripts/rebuild — 再構築パイプライン

条文くんの R2 / Vectorize データを e-Gov XML から再構築するパイプライン。

詳細設計: [`docs/rebuild_design.md`](../../docs/rebuild_design.md)
Worker 改修案: [`docs/worker_patch.md`](../../docs/worker_patch.md)

## ディレクトリ

```
scripts/rebuild/
├── lib/
│   ├── egov_parser.py        統合パーサー (sub_items + 別表 + Ruby + 同名条文)
│   └── ids.py                Vectorize ID 生成 (64バイト制限対応)
├── tests/
│   └── test_parser.py        パーサーの動作確認 (6 ケース)
├── 01_parse_xml.py           XML → law_data JSON (1法令1ファイル)
├── 02_split_articles.py      law_data → 条文単位ファイル群
├── 03_prepare_embedding_inputs.py  ベクトル化対象テキスト一覧生成
├── 04_generate_vectors.py    bge-m3 でベクトル生成 (GPU、★未実装)
├── 05_upload_to_r2.py        R2 にアップロード (★未実装)
├── 06_upload_vectorize.sh    Vectorize 投入 (★未実装)
└── README.md                 (本ファイル)
```

## 実行順

### 前提条件

- Python 3.11+
- lxml (`pip install lxml`)
- `{localDataRoot}\all_xml_20260508\` に e-Gov 法令XML (一括ダウンロード済み)
  - `{localDataRoot}` は作業フォルダの根。`scripts/site_config.cjs`・`scripts/site_config.py` の localDataRoot（条文くんの値は `site_config.private.cjs`・`site_config_private.py`。無ければ環境変数 `LOCAL_DATA_ROOT`）
- (GPU 推論時のみ) sentence-transformers + torch[cuda] + RTX 5070

### Step 1: パーサーテスト

```bash
python scripts/rebuild/tests/test_parser.py
```

期待: `6/6 passed`

### Step 2: 全 XML をパース

```bash
python scripts/rebuild/01_parse_xml.py
```

オプション:
- `--workers 8`: 並列度
- `--limit 100`: 最初の N 法令だけ (テスト用)
- `--law-id 129AC0000000089`: 1 法令だけ
- `--include-future`: 将来施行版も含める

出力:
- `{localDataRoot}/rebuild_output/fetched_laws/{law_id}.json`
- `{localDataRoot}/rebuild_output/parse_log.json`

実測: 8,953 法令を 75 秒 (failed 0)

### Step 3: 条文単位ファイル化

```bash
python scripts/rebuild/02_split_articles.py
```

出力:
- `{localDataRoot}/rebuild_output/large_law_articles_v3/{law_id}/{title}.json`
- `{localDataRoot}/rebuild_output/large_law_articles_v3/{law_id}/_index.json`
- `{localDataRoot}/rebuild_output/split_log.json`

実測: 266,143 ファイル、1.37 GB、127 秒

### Step 4: ベクトル化対象テキスト生成

```bash
python scripts/rebuild/03_prepare_embedding_inputs.py
```

出力:
- `{localDataRoot}/rebuild_output/embedding_inputs.jsonl`
  各行: `{"id": "...", "text": "...", "metadata": {...}}`
- `{localDataRoot}/rebuild_output/embedding_inputs_log.json`

実測: 約53万エントリ (項単位)

### Step 5: bge-m3 でベクトル生成 (★ GPU 到着後)

```bash
python scripts/rebuild/04_generate_vectors.py  # まだ未実装
```

入力: `embedding_inputs.jsonl`
出力: `vectors.ndjson` (Vectorize 投入形式)

GPU 想定: RTX 5070 で約 30〜60 分

### Step 6: R2 にアップロード (★未実装)

```bash
python scripts/rebuild/05_upload_to_r2.py
```

入力: `large_law_articles_v3/`
出力先: R2 `large_law_articles_v3/{law_id}/{title}.json`

### Step 7: Vectorize 投入 (★未実装)

```bash
bash scripts/rebuild/06_upload_vectorize.sh
```

新規 index `law-embeddings-v2` を作成し `vectors.ndjson` を投入。

## 中間成果物の場所

```
{localDataRoot}/rebuild_output/
├── fetched_laws/                     パース直後の法令データ (8,953 法令)
├── large_law_articles_v3/            条文単位ファイル (266K ファイル)
├── embedding_inputs.jsonl            ベクトル化対象 (約53万件)
├── vectors.ndjson                    bge-m3 出力 (GPU 後)
├── parse_log.json                    01 のログ
├── split_log.json                    02 のログ
└── embedding_inputs_log.json         03 のログ
```

## トラブルシュート

### lxml がインストールされていない

```bash
pip install lxml
```

### parse 中にメモリ不足 (Killed)

`--workers` を減らす:

```bash
python scripts/rebuild/01_parse_xml.py --workers 2
```

### 大規模法令だけテストしたい

```bash
# 民法
python scripts/rebuild/01_parse_xml.py --law-id 129AC0000000089
python scripts/rebuild/02_split_articles.py --law-id 129AC0000000089
```

### 1法令の parsed JSON を眺める

```bash
python -c "import json; d = json.load(open('rebuild_output/fetched_laws/129AC0000000089.json', encoding='utf-8')); print('articles:', len(d['articles'])); print('first article keys:', list(d['articles'][0].keys()))"
```
