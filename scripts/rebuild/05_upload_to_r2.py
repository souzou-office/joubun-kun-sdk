# -*- coding: utf-8 -*-
"""
条文単位ファイルを R2 にアップロードするスクリプト。

入力:
  {LOCAL_DATA_ROOT}\rebuild_output\large_law_articles_v3\{law_id}\{title}.json

R2 出力先:
  large_law_articles_v3/{law_id}/{title}.json
  (新 prefix なので既存 large_law_articles_v2/ には影響しない)

注意:
  - 既存の R2 オブジェクトは削除しない (Blue-Green 方針)
  - 失敗時は再開可能 (アップロード済みリストを resume_log.json に記録)

使い方:
  python scripts/rebuild/05_upload_to_r2.py
  python scripts/rebuild/05_upload_to_r2.py --workers 16  # 並列度
  python scripts/rebuild/05_upload_to_r2.py --resume       # 続きから
  python scripts/rebuild/05_upload_to_r2.py --law-id 129AC0000000089  # 1法令だけ
  python scripts/rebuild/05_upload_to_r2.py --dry-run      # 実際にはアップしない
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
RESUME_LOG = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/upload_r2_resume.json')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/upload_r2_log.json')

# R2 認証情報 (環境変数から取得。ハードコード禁止)
ACCT = os.environ.get('R2_ACCOUNT_ID')
TOKEN = os.environ.get('R2_API_TOKEN')
if not ACCT or not TOKEN:
    sys.exit('環境変数 R2_ACCOUNT_ID と R2_API_TOKEN を設定してください（旧ハードコードは廃止）')
BUCKET = 'joubun-kun-data'

# R2 上の prefix (既存 large_law_articles_v2/ と区別するため v3)
R2_PREFIX = 'large_law_articles_v3'

# スレッドローカルの requests.Session (keep-alive で接続再利用)
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

    # URL エンコード (日本語ファイル名対応)
    encoded_key = urllib.parse.quote(r2_key, safe='/')
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCT}/r2/buckets/{BUCKET}/objects/{encoded_key}'

    session = _get_session()
    last_error = None
    for attempt in range(max_retries):
        try:
            resp = session.put(url, data=data, timeout=30)
            if 200 <= resp.status_code < 300:
                return resp.status_code
            # 429 (Too Many Requests) と 5xx はリトライ対象
            if resp.status_code == 429 or 500 <= resp.status_code < 600:
                if attempt < max_retries - 1:
                    retry_after = resp.headers.get('Retry-After')
                    if retry_after:
                        try:
                            wait = float(retry_after)
                        except ValueError:
                            wait = 2 ** attempt
                    else:
                        wait = min(30, (2 ** attempt)) + (attempt * 0.1)
                    time.sleep(wait)
                    continue
            last_error = Exception(f'HTTP {resp.status_code}: {resp.text[:200]}')
            raise last_error
        except requests.exceptions.RequestException as e:
            last_error = e
            if attempt < max_retries - 1:
                time.sleep(min(30, 2 ** attempt))
                continue
            raise
    if last_error:
        raise last_error
    return 200


def upload_one_file(file_path: Path, law_id: str, dry_run: bool) -> tuple[str, str, bool, str | None]:
    """
    1ファイル分アップ。返却: (law_id, filename, success, error_message)
    """
    try:
        r2_key = f'{R2_PREFIX}/{law_id}/{file_path.name}'
        with file_path.open('rb') as f:
            data = f.read()
        upload_to_r2(r2_key, data, dry_run)
        return (law_id, file_path.name, True, None)
    except Exception as e:
        return (law_id, file_path.name, False, f'{type(e).__name__}: {e}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=16)
    ap.add_argument('--law-id', type=str, default=None)
    ap.add_argument('--limit', type=int, default=None,
                    help='最初の N 法令だけアップ (テスト用)')
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not INPUT_BASE.exists():
        print(f'ERROR: {INPUT_BASE} not found')
        return 1

    # 対象収集
    if args.law_id:
        law_dirs = [INPUT_BASE / args.law_id]
        if not law_dirs[0].exists():
            print(f'ERROR: law_id={args.law_id} not found')
            return 1
    else:
        law_dirs = sorted([d for d in INPUT_BASE.iterdir() if d.is_dir()])

    if args.limit:
        law_dirs = law_dirs[:args.limit]

    # 全ファイル一覧
    all_uploads: list[tuple[Path, str]] = []
    for law_dir in law_dirs:
        for f in law_dir.iterdir():
            if f.is_file() and f.suffix == '.json':
                all_uploads.append((f, law_dir.name))

    # resume
    uploaded_keys: set[str] = set()
    if args.resume and RESUME_LOG.exists():
        with RESUME_LOG.open('r', encoding='utf-8') as f:
            uploaded_keys = set(json.load(f).get('uploaded', []))
        all_uploads = [
            (fp, law_id) for fp, law_id in all_uploads
            if f'{R2_PREFIX}/{law_id}/{fp.name}' not in uploaded_keys
        ]
        print(f'Resume: 既に {len(uploaded_keys)} 件アップ済み、残り {len(all_uploads)}')

    print(f'対象: {len(law_dirs)} 法令、{len(all_uploads)} ファイル')
    print(f'R2 prefix: {R2_PREFIX}/')
    print(f'Workers: {args.workers}')
    if args.dry_run:
        print('★ DRY-RUN モード (実際にはアップしません)')
    print()

    if not all_uploads:
        print('アップロード対象なし')
        return 0

    start = time.time()
    success: list[str] = list(uploaded_keys)
    failed: list[dict] = []

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        future_map = {
            ex.submit(upload_one_file, fp, law_id, args.dry_run): (fp, law_id)
            for fp, law_id in all_uploads
        }
        for i, fut in enumerate(as_completed(future_map), 1):
            law_id, filename, ok, err = fut.result()
            r2_key = f'{R2_PREFIX}/{law_id}/{filename}'
            if ok:
                success.append(r2_key)
            else:
                failed.append({'law_id': law_id, 'file': filename, 'error': err})

            # 1000件ごとに進捗 + resume log 保存
            if i % 1000 == 0 or i == len(all_uploads):
                elapsed = time.time() - start
                rate = i / elapsed if elapsed > 0 else 0
                eta = (len(all_uploads) - i) / rate if rate > 0 else 0
                print(f'  {i:6d}/{len(all_uploads):6d}  '
                      f'success={len(success):6d}  failed={len(failed):4d}  '
                      f'rate={rate:.0f}/s  eta={eta/60:.1f}min')
                # resume log 保存
                with RESUME_LOG.open('w', encoding='utf-8') as f:
                    json.dump({'uploaded': success}, f)

    elapsed = time.time() - start
    print()
    print('=== 完了 ===')
    print(f'  処理時間: {elapsed/60:.1f} 分')
    print(f'  成功:    {len(success)}')
    print(f'  失敗:    {len(failed)}')

    log = {
        'elapsed_seconds': elapsed,
        'success_count': len(success),
        'failed_count': len(failed),
        'r2_prefix': R2_PREFIX,
        'dry_run': args.dry_run,
        'failed_entries': failed[:50],
    }
    with LOG_FILE.open('w', encoding='utf-8') as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(f'  ログ: {LOG_FILE}')

    return 0 if not failed else 2


if __name__ == '__main__':
    sys.exit(main())
