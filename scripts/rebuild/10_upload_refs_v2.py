# -*- coding: utf-8 -*-
"""
refs_chunks_v4 を R2 にアップロード。

入力:
  {LOCAL_DATA_ROOT}\\rebuild_output\\refs_chunks_v4\\
    refs_index.json
    refs_chunk_NNN.json

R2 出力先:
  refs_chunks_v4/refs_index.json
  refs_chunks_v4/refs_chunk_NNN.json
  refs_chunks_v4/summary.json

  ※ 既存の refs_chunks_v3/ には触らない (Blue-Green)

使い方:
  python scripts/rebuild/10_upload_refs_v2.py
  python scripts/rebuild/10_upload_refs_v2.py --dry-run
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

INPUT_DIR = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/refs_chunks_v4')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/upload_refs_v4_log.json')

ACCT = os.environ.get('R2_ACCOUNT_ID')
TOKEN = os.environ.get('R2_API_TOKEN')
if not ACCT or not TOKEN:
    sys.exit('環境変数 R2_ACCOUNT_ID と R2_API_TOKEN を設定してください（旧ハードコードは廃止）')
BUCKET = 'joubun-kun-data'
R2_PREFIX = 'refs_chunks_v4'


def upload_to_r2(r2_key: str, data: bytes, dry_run: bool = False, max_retries: int = 10) -> int:
    if dry_run:
        return 200
    import time as _t
    encoded_key = urllib.parse.quote(r2_key, safe='/')
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCT}/r2/buckets/{BUCKET}/objects/{encoded_key}'
    last_error = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(
                url, data=data, method='PUT',
                headers={
                    'Authorization': f'Bearer {TOKEN}',
                    'Content-Type': 'application/json',
                }
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status
        except urllib.error.HTTPError as e:
            last_error = e
            if (e.code == 429 or 500 <= e.code < 600) and attempt < max_retries - 1:
                retry_after = e.headers.get('Retry-After') if e.headers else None
                if retry_after:
                    try: wait = float(retry_after)
                    except ValueError: wait = 2 ** attempt
                else:
                    wait = min(60, 2 ** attempt) + (attempt * 0.1)
                _t.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_error = e
            if attempt < max_retries - 1:
                _t.sleep(min(30, 2 ** attempt))
                continue
            raise
    if last_error:
        raise last_error
    return 200


def upload_one(file_path: Path, dry_run: bool):
    try:
        r2_key = f'{R2_PREFIX}/{file_path.name}'
        with file_path.open('rb') as f:
            data = f.read()
        upload_to_r2(r2_key, data, dry_run)
        return (file_path.name, True, None)
    except Exception as e:
        return (file_path.name, False, f'{type(e).__name__}: {e}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not INPUT_DIR.exists():
        print(f'ERROR: {INPUT_DIR} not found')
        print('まず 09_split_refs_v2.cjs を実行してください')
        return 1

    files = sorted(INPUT_DIR.glob('*.json'))
    print(f'対象: {len(files)} ファイル')
    print(f'R2 prefix: {R2_PREFIX}/')
    if args.dry_run:
        print('★ DRY-RUN モード')
    print()

    start = time.time()
    success = []
    failed = []

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        future_map = {ex.submit(upload_one, f, args.dry_run): f for f in files}
        for fut in as_completed(future_map):
            name, ok, err = fut.result()
            if ok:
                success.append(name)
                print(f'  OK   {name}')
            else:
                failed.append({'file': name, 'error': err})
                print(f'  FAIL {name}  {err}')

    elapsed = time.time() - start
    print()
    print('=== 完了 ===')
    print(f'  処理時間: {elapsed:.1f} 秒')
    print(f'  成功:    {len(success)}')
    print(f'  失敗:    {len(failed)}')

    log = {
        'elapsed_seconds': elapsed,
        'success_count': len(success),
        'failed_count': len(failed),
        'r2_prefix': R2_PREFIX,
        'dry_run': args.dry_run,
        'failed_entries': failed,
    }
    with LOG_FILE.open('w', encoding='utf-8') as f:
        json.dump(log, f, ensure_ascii=False, indent=2)

    return 0 if not failed else 2


if __name__ == '__main__':
    sys.exit(main())
