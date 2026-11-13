# -*- coding: utf-8 -*-
"""
別表ファイル (別表第*.json) だけを R2 にアップロードするスクリプト。

用途:
  パーサ修正 (parse_appdx_table を行単位構造化) 後、
  別表ファイルだけを差分アップロードする。
  通常条文ファイルは内容が変わらないので触らない。

入力:
  {LOCAL_DATA_ROOT}\rebuild_output\large_law_articles_v3\{law_id}\別表*.json

R2 出力先:
  large_law_articles_v3/{law_id}/別表*.json (既存パス上書き)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

INPUT_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/large_law_articles_v3')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/upload_appendix_log.json')

ACCT = os.environ.get('R2_ACCOUNT_ID')
TOKEN = os.environ.get('R2_API_TOKEN')
if not ACCT or not TOKEN:
    sys.exit('環境変数 R2_ACCOUNT_ID と R2_API_TOKEN を設定してください（旧ハードコードは廃止）')
BUCKET = 'joubun-kun-data'
R2_PREFIX = 'large_law_articles_v3'

_thread_local = threading.local()


def _get_session() -> requests.Session:
    s = getattr(_thread_local, 'session', None)
    if s is None:
        s = requests.Session()
        adapter = HTTPAdapter(pool_connections=4, pool_maxsize=8)
        s.mount('https://', adapter)
        s.headers.update({
            'Authorization': f'Bearer {TOKEN}',
            'Content-Type': 'application/json',
        })
        _thread_local.session = s
    return s


def upload_to_r2(r2_key: str, data: bytes, dry_run: bool = False, max_retries: int = 10) -> int:
    if dry_run:
        return 200
    encoded_key = urllib.parse.quote(r2_key, safe='/')
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCT}/r2/buckets/{BUCKET}/objects/{encoded_key}'
    session = _get_session()
    for attempt in range(max_retries):
        try:
            resp = session.put(url, data=data, timeout=60)
            if resp.status_code in (200, 201):
                return resp.status_code
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(min(2 ** attempt, 30))
                continue
            return resp.status_code
        except Exception:
            time.sleep(min(2 ** attempt, 30))
            continue
    return 0


def collect_appendix_files() -> list[Path]:
    """別表*.json ファイルを再帰収集"""
    files = []
    for law_dir in INPUT_BASE.iterdir():
        if not law_dir.is_dir():
            continue
        for fp in law_dir.glob('別表*.json'):
            files.append(fp)
    return files


def upload_one(fp: Path, dry_run: bool) -> tuple[Path, int]:
    law_id = fp.parent.name
    r2_key = f'{R2_PREFIX}/{law_id}/{fp.name}'
    data = fp.read_bytes()
    status = upload_to_r2(r2_key, data, dry_run=dry_run)
    return fp, status


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=16)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int)
    args = ap.parse_args()

    files = collect_appendix_files()
    if args.limit:
        files = files[:args.limit]
    print(f'別表ファイル数: {len(files)}', flush=True)

    success = 0
    failed = []
    start = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(upload_one, fp, args.dry_run): fp for fp in files}
        for i, fut in enumerate(as_completed(futures), start=1):
            fp, status = fut.result()
            if status in (200, 201):
                success += 1
            else:
                failed.append({'file': str(fp), 'status': status})
            if i % 100 == 0:
                rate = i / (time.time() - start)
                print(f'  {i}/{len(files)} success={success} failed={len(failed)} rate={rate:.1f}/s', flush=True)

    elapsed = time.time() - start
    print(f'\n=== 完了 ===')
    print(f'  経過: {elapsed:.1f}s')
    print(f'  成功: {success}')
    print(f'  失敗: {len(failed)}')

    LOG_FILE.write_text(json.dumps({
        'elapsed_seconds': elapsed,
        'success_count': success,
        'failed_count': len(failed),
        'total': len(files),
        'failed_entries': failed[:50],
    }, ensure_ascii=False, indent=2), encoding='utf-8')

    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
