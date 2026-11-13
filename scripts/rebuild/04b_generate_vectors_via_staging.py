# -*- coding: utf-8 -*-
"""
Staging Worker の /api/embed-batch 経由で別表item用の embedding を生成。

GPU不要・Workers AI 経由。コストは bge-m3 1Mトークンあたり ~$0.01 程度。
153K items × 50 tokens ≒ 7.6M tokens ≒ $0.08 程度の見込み。

入力:
  {LOCAL_DATA_ROOT}\rebuild_output\embedding_inputs_appendix_items.jsonl

出力:
  {LOCAL_DATA_ROOT}\rebuild_output\vectors_appendix.ndjson
  (wrangler vectorize insert 互換)

使い方:
  python scripts/rebuild/04b_generate_vectors_via_staging.py
  python scripts/rebuild/04b_generate_vectors_via_staging.py --resume
  python scripts/rebuild/04b_generate_vectors_via_staging.py --batch 50
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

STAGING_URL = site_config.WORKER_URLS['staging']
BYPASS_KEY = os.environ.get('BYPASS_KEY')   # 平文の既定値は置かない（鍵は取り替え済み。環境変数で渡す）
if not BYPASS_KEY:
    sys.exit('環境変数 BYPASS_KEY を設定してください')

INPUT_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/embedding_inputs_appendix_items.jsonl')
OUTPUT_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/vectors_appendix.ndjson')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/vectors_appendix_log.json')


def load_processed_ids(path: Path) -> set[str]:
    ids = set()
    if not path.exists():
        return ids
    with path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    ids.add(json.loads(line)['id'])
                except Exception:
                    continue
    return ids


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--batch', type=int, default=50, help='1リクエストあたりのテキスト数')
    ap.add_argument('--resume', action='store_true', help='処理済みIDをスキップ')
    ap.add_argument('--limit', type=int, help='処理する item 数上限 (テスト用)')
    ap.add_argument('--sleep', type=float, default=0.05, help='バッチ間スリープ秒')
    args = ap.parse_args()

    # Resume 対応
    processed = load_processed_ids(OUTPUT_FILE) if args.resume else set()
    if processed:
        print(f'resume: {len(processed)} 件既処理', flush=True)

    # 入力読み込み
    entries: list[dict] = []
    with INPUT_FILE.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            if entry['id'] in processed:
                continue
            entries.append(entry)
            if args.limit and len(entries) >= args.limit:
                break

    print(f'処理対象: {len(entries)} items, batch={args.batch}', flush=True)
    if not entries:
        print('対象なし')
        return 0

    # session with retry
    session = requests.Session()
    retry = Retry(total=5, backoff_factor=1.5, status_forcelist=[429, 500, 502, 503, 504])
    session.mount('https://', HTTPAdapter(max_retries=retry, pool_connections=2, pool_maxsize=4))
    session.headers.update({
        'Content-Type': 'application/json',
        'x-api-key': BYPASS_KEY,
    })

    open_mode = 'a' if args.resume else 'w'
    start = time.time()
    success = 0
    failed_batches = []

    with OUTPUT_FILE.open(open_mode, encoding='utf-8') as out:
        for i in range(0, len(entries), args.batch):
            batch = entries[i:i + args.batch]
            texts = [e['text'] for e in batch]
            try:
                resp = session.post(
                    f'{STAGING_URL}/api/embed-batch',
                    json={'texts': texts},
                    timeout=120
                )
                if resp.status_code != 200:
                    failed_batches.append({'start': i, 'status': resp.status_code, 'body': resp.text[:200]})
                    print(f'  [{i}] ERR status={resp.status_code} body={resp.text[:200]}', flush=True)
                    time.sleep(2)
                    continue
                data = resp.json()
                vectors = data.get('vectors') or []
                if len(vectors) != len(batch):
                    failed_batches.append({'start': i, 'reason': f'mismatch len(vectors)={len(vectors)} != len(batch)={len(batch)}'})
                    print(f'  [{i}] mismatch', flush=True)
                    continue
                for entry, vec in zip(batch, vectors):
                    out.write(json.dumps({
                        'id': entry['id'],
                        'values': vec,
                        'metadata': entry['metadata'],
                    }, ensure_ascii=False) + '\n')
                    success += 1
                out.flush()
            except Exception as e:
                failed_batches.append({'start': i, 'error': str(e)})
                print(f'  [{i}] EXC {e}', flush=True)
                time.sleep(5)
                continue

            if (i // args.batch) % 50 == 0:
                rate = success / (time.time() - start)
                eta = (len(entries) - success) / rate if rate > 0 else 0
                print(f'  {success}/{len(entries)} ({rate:.0f}/s, ETA {eta/60:.1f}分)', flush=True)
            time.sleep(args.sleep)

    elapsed = time.time() - start
    print(f'\n=== 完了 ===', flush=True)
    print(f'  経過: {elapsed:.0f}秒 ({elapsed/60:.1f}分)', flush=True)
    print(f'  成功: {success}', flush=True)
    print(f'  失敗batch: {len(failed_batches)}', flush=True)
    print(f'  出力: {OUTPUT_FILE}', flush=True)

    LOG_FILE.write_text(json.dumps({
        'elapsed_seconds': elapsed,
        'success_count': success,
        'failed_batches': failed_batches[:50],
        'output_file': str(OUTPUT_FILE),
    }, ensure_ascii=False, indent=2), encoding='utf-8')

    return 0 if not failed_batches else 1


if __name__ == '__main__':
    sys.exit(main())
