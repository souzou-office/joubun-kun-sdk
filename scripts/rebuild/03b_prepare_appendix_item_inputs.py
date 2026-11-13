# -*- coding: utf-8 -*-
"""
別表の item (行) ごとに embedding 入力を生成するスクリプト。

用途:
  別表は paragraph 単位 (フラットテキスト) でしか embedding されていなかった。
  これに加えて item (行) 単位の embedding を追加することで、
  「株券発行会社の登録免許税」のような個別キーワード検索でも別表が hit するようにする。

入力:
  {LOCAL_DATA_ROOT}\rebuild_output\large_law_articles_v3\{law_id}\別表*.json

出力:
  {LOCAL_DATA_ROOT}\rebuild_output\embedding_inputs_appendix_items.jsonl
    各行: {
      "id": "{law_id}_{article_title}_item_{index}",
      "text": "{law_title} {article_title} {item_text}",
      "metadata": {
        "law_id": "...",
        "law_title": "...",
        "article_title": "別表第一",  ← parent と同じ title
        "item_index": 1,
        "item_title": "一" or "（一）" or "イ" etc.,
      }
    }

  Worker 側では law_id + article_title でキー化されるため、
  item hit は自動的に「別表第一」へ集約される (dedupe)。

使用方法:
  python scripts/rebuild/03b_prepare_appendix_item_inputs.py
  python scripts/rebuild/03b_prepare_appendix_item_inputs.py --law-id 342AC0000000035
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

INPUT_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/large_law_articles_v3')
OUTPUT_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/embedding_inputs_appendix_items.jsonl')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/embedding_inputs_appendix_log.json')

# bge-m3 token 上限を意識して item 1個あたりの最大文字数
MAX_ITEM_TEXT_LENGTH = 2000


def iter_appendix_files(law_id_filter: str | None = None):
    """別表*.json ファイルを yield"""
    for law_dir in INPUT_BASE.iterdir():
        if not law_dir.is_dir():
            continue
        if law_id_filter and law_dir.name != law_id_filter:
            continue
        for fp in law_dir.glob('別表*.json'):
            yield fp


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--law-id', help='指定の法令IDのみ処理 (テスト用)')
    ap.add_argument('--limit-files', type=int, help='処理する別表ファイル数の上限')
    args = ap.parse_args()

    start = time.time()
    total_files = 0
    total_items = 0
    skipped_no_items = 0

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_FILE.open('w', encoding='utf-8') as out:
        for fp in iter_appendix_files(args.law_id):
            if args.limit_files and total_files >= args.limit_files:
                break
            total_files += 1
            try:
                data = json.loads(fp.read_text(encoding='utf-8'))
            except Exception as e:
                print(f'parse error: {fp}: {e}', file=sys.stderr)
                continue

            law_id = data.get('law_id', '')
            law_title = data.get('law_title', '')

            for art in data.get('articles', []):
                article_title = art.get('title', '')
                if not article_title.startswith('別表'):
                    continue
                caption = art.get('caption', '')
                paragraphs = art.get('paragraphs') or []
                if not paragraphs:
                    continue
                items = paragraphs[0].get('items') or []
                if not items:
                    skipped_no_items += 1
                    continue

                for i, item in enumerate(items, start=1):
                    item_title = item.get('item_title') or ''
                    sentences = item.get('sentences') or []
                    item_text = ' '.join(s.get('text', '') for s in sentences if s.get('text'))
                    if not item_text:
                        continue
                    # truncate を MAX_ITEM_TEXT_LENGTH に
                    item_text_truncated = item_text[:MAX_ITEM_TEXT_LENGTH]

                    # embedding text: 法令名 + 別表名 + caption(関連条文) + item text
                    parts = [law_title, article_title]
                    if caption:
                        parts.append(caption)
                    if item_title:
                        parts.append(item_title)
                    parts.append(item_text_truncated)
                    text = ' '.join(parts)

                    entry = {
                        'id': f'{law_id}_{article_title}_item_{i}',
                        'text': text,
                        'metadata': {
                            'law_id': law_id,
                            'law_title': law_title,
                            'article_title': article_title,
                            'item_index': i,
                            'item_title': item_title,
                        },
                    }
                    out.write(json.dumps(entry, ensure_ascii=False) + '\n')
                    total_items += 1

    elapsed = time.time() - start
    print(f'\n=== 完了 ===')
    print(f'  経過: {elapsed:.1f}s')
    print(f'  別表ファイル数: {total_files}')
    print(f'  生成 item 数: {total_items}')
    print(f'  items 無しでスキップ: {skipped_no_items}')
    print(f'  出力: {OUTPUT_FILE}')

    LOG_FILE.write_text(json.dumps({
        'elapsed_seconds': elapsed,
        'total_files': total_files,
        'total_items': total_items,
        'skipped_no_items': skipped_no_items,
        'output_file': str(OUTPUT_FILE),
    }, ensure_ascii=False, indent=2), encoding='utf-8')

    return 0


if __name__ == '__main__':
    sys.exit(main())
