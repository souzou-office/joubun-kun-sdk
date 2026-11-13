# -*- coding: utf-8 -*-
"""
ベクトル化対象のテキスト一覧を生成するスクリプト (GPU 推論前の準備)。

入力:
  {LOCAL_DATA_ROOT}\rebuild_output\large_law_articles_v3\{law_id}\*.json

処理:
  各 article の各 paragraph (項) ごとに:
    - vectorize ID を生成
    - embedding_text (法令名 + 条文タイトル + caption + 段落本文) を構築
    - メタデータをまとめる

出力:
  {LOCAL_DATA_ROOT}\rebuild_output\embedding_inputs.jsonl
    各行: { "id": "...", "text": "...", "metadata": {...} }

これを GPU 環境で 04_generate_vectors.py に食わせると bge-m3 でベクトル生成。

使用方法:
  python scripts/rebuild/03_prepare_embedding_inputs.py
  python scripts/rebuild/03_prepare_embedding_inputs.py --max-text-length 4000
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# import path
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from lib.ids import IdAllocator, make_vector_metadata  # noqa: E402
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

INPUT_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/large_law_articles_v3')
OUTPUT_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/embedding_inputs.jsonl')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/embedding_inputs_log.json')

# bge-m3 の入力上限 8192 token に余裕を見て文字数で制限
DEFAULT_MAX_TEXT_LENGTH = 6000


def collect_paragraph_texts(paragraph: dict) -> str:
    """
    paragraph 内の全テキストを連結 (sentences + items + sub_items)。
    """
    parts: list[str] = []
    for sent in paragraph.get('sentences', []):
        if sent.get('text'):
            parts.append(sent['text'])
    for item in paragraph.get('items', []):
        if item.get('item_title'):
            parts.append(item['item_title'])
        for sent in item.get('sentences', []):
            if sent.get('text'):
                parts.append(sent['text'])
        for sub in item.get('sub_items', []):
            _collect_subitem(sub, parts)
    return ' '.join(parts)


def _collect_subitem(subitem: dict, parts: list[str]) -> None:
    if subitem.get('subitem_title'):
        parts.append(subitem['subitem_title'])
    for sent in subitem.get('sentences', []):
        if sent.get('text'):
            parts.append(sent['text'])
    for child in subitem.get('sub_items', []):
        _collect_subitem(child, parts)


def build_embedding_text(
    law_title: str,
    article_title: str,
    caption: str,
    paragraph: dict,
    max_length: int,
) -> str:
    """
    bge-m3 の入力テキストを生成。
    "{law_title} {article_title} {caption} {paragraph 本文}"
    """
    para_body = collect_paragraph_texts(paragraph)
    parts = [law_title, article_title]
    if caption:
        parts.append(caption)
    if para_body:
        parts.append(para_body)
    text = ' '.join(p for p in parts if p)
    if len(text) > max_length:
        text = text[:max_length]
    return text


def process_law(
    law_dir: Path,
    allocator: IdAllocator,
    out_stream,
    max_text_length: int,
) -> dict:
    """
    1法令分の全条文ファイルを処理し、各 paragraph を embedding_inputs.jsonl に書き出す。
    """
    law_id = law_dir.name

    article_files = sorted(law_dir.glob('*.json'))
    article_files = [f for f in article_files if f.name != '_index.json']

    paragraph_count = 0

    for article_file in article_files:
        with article_file.open('r', encoding='utf-8') as f:
            data = json.load(f)

        law_title = data.get('law_title', '')
        articles = data.get('articles', [])

        for article in articles:
            article_title = article.get('title', '')
            caption = article.get('caption', '')

            paragraphs = article.get('paragraphs', [])
            for para in paragraphs:
                para_num = para.get('num', '1')

                text = build_embedding_text(
                    law_title, article_title, caption, para, max_text_length
                )
                if not text.strip():
                    continue

                vid = allocator.allocate(law_id, article_title, para_num, caption)

                metadata = make_vector_metadata(
                    law_id=law_id,
                    law_title=law_title,
                    article_title=article_title,
                    article_caption=caption,
                    paragraph_num=para_num,
                )

                record = {'id': vid, 'text': text, 'metadata': metadata}
                out_stream.write(json.dumps(record, ensure_ascii=False) + '\n')
                paragraph_count += 1

    return {
        'law_id': law_id,
        'articles': sum(
            len(json.loads(f.read_text(encoding='utf-8')).get('articles', []))
            for f in article_files
        ) if False else None,  # 計算コスト高なのでここでは出さない
        'paragraphs': paragraph_count,
    }


def collect_existing_law_ids(path: Path) -> set[str]:
    """既存の embedding_inputs.jsonl から処理済み law_id を収集 (resume 用)。"""
    if not path.exists():
        return set()
    seen: set[str] = set()
    with path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                lid = rec.get('metadata', {}).get('law_id')
                if lid:
                    seen.add(lid)
            except Exception:
                continue
    return seen


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-text-length', type=int, default=DEFAULT_MAX_TEXT_LENGTH)
    ap.add_argument('--law-id', type=str, default=None)
    ap.add_argument('--resume', action='store_true',
                    help='既存 embedding_inputs.jsonl の続きから (法令単位)')
    args = ap.parse_args()

    if not INPUT_BASE.exists():
        print(f'ERROR: {INPUT_BASE} not found. Run 02_split_articles.py first.')
        return 1

    if args.law_id:
        targets = [INPUT_BASE / args.law_id]
        if not targets[0].exists():
            print(f'ERROR: {targets[0]} not found')
            return 1
    else:
        targets = sorted([d for d in INPUT_BASE.iterdir() if d.is_dir()])

    # resume: 既存の law_id を除外
    skip_law_ids: set[str] = set()
    if args.resume:
        skip_law_ids = collect_existing_law_ids(OUTPUT_FILE)
        print(f'Resume: 既処理 law_id {len(skip_law_ids)} 件')
        targets = [t for t in targets if t.name not in skip_law_ids]

    print(f'対象: {len(targets)} 法令')
    print(f'出力: {OUTPUT_FILE}')
    print(f'max_text_length: {args.max_text_length}')
    print(f'mode: {"append (resume)" if args.resume else "fresh"}')
    print(flush=True)

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    allocator = IdAllocator()
    start = time.time()
    total_paragraphs = 0
    failed: list[dict] = []

    open_mode = 'a' if args.resume else 'w'
    with OUTPUT_FILE.open(open_mode, encoding='utf-8') as out_stream:
        for i, law_dir in enumerate(targets, 1):
            try:
                result = process_law(law_dir, allocator, out_stream, args.max_text_length)
                total_paragraphs += result['paragraphs']
                # 法令単位で flush (途中killでもデータが残る)
                out_stream.flush()
            except Exception as e:
                failed.append({'law_id': law_dir.name, 'error': f'{type(e).__name__}: {e}'})

            if i % 100 == 0 or i == len(targets):
                elapsed = time.time() - start
                rate = i / elapsed if elapsed > 0 else 0
                eta = (len(targets) - i) / rate if rate > 0 else 0
                print(f'  {i:5d}/{len(targets):5d}  '
                      f'paragraphs={total_paragraphs:,}  '
                      f'failed={len(failed)}  '
                      f'rate={rate:.0f}/s  eta={eta:.0f}s',
                      flush=True)

    elapsed = time.time() - start
    output_size = OUTPUT_FILE.stat().st_size if OUTPUT_FILE.exists() else 0

    print()
    print('=== 完了 ===')
    print(f'  処理時間:     {elapsed:.1f} 秒')
    print(f'  総項数:       {total_paragraphs:,}')
    print(f'  失敗:         {len(failed)}')
    print(f'  出力サイズ:   {output_size / 1024 / 1024:.1f} MB')
    print(f'  出力先:       {OUTPUT_FILE}')

    log = {
        'elapsed_seconds': elapsed,
        'total_paragraphs': total_paragraphs,
        'failed_count': len(failed),
        'output_size_bytes': output_size,
        'failed_entries': failed[:50],
    }
    with LOG_FILE.open('w', encoding='utf-8') as f:
        json.dump(log, f, ensure_ascii=False, indent=2)

    return 0 if not failed else 2


if __name__ == '__main__':
    sys.exit(main())
