# -*- coding: utf-8 -*-
"""
条文単位ファイルを R2 にアップロード (S3 互換 API 版)。

REST API 版 (05_upload_to_r2.py) はレート制限が厳しすぎたため、
boto3 + S3 互換エンドポイントで高速並列アップロードする。

環境変数 (必須):
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY

使い方:
  python scripts/rebuild/05b_upload_s3.py
  python scripts/rebuild/05b_upload_s3.py --workers 32 --resume
  python scripts/rebuild/05b_upload_s3.py --law-id 129AC0000000089 --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

INPUT_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/large_law_articles_v3')
RESUME_LOG = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/upload_r2_resume.json')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/upload_r2_log.json')

ACCT = site_config.CF_ACCOUNT_ID
BUCKET = 'joubun-kun-data'
R2_PREFIX = 'large_law_articles_v3'

ENDPOINT = f'https://{ACCT}.r2.cloudflarestorage.com'

# スレッドローカル S3 クライアント (boto3 client は thread-safe だが念のため)
_thread_local = threading.local()


def load_dotenv(path: Path):
    """簡易 .env パーサー (KEY=VALUE 形式)"""
    if not path.exists():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        # 既存環境変数を優先 (上書きしない)
        if key not in os.environ:
            os.environ[key] = value


def get_credentials():
    # .env を自動読み込み
    load_dotenv(Path(f'{site_config.LOCAL_DATA_ROOT}/.env'))

    aki = os.environ.get('R2_ACCESS_KEY_ID')
    sak = os.environ.get('R2_SECRET_ACCESS_KEY')
    if not aki or not sak:
        print('ERROR: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY が見つかりません', file=sys.stderr)
        print(f'{site_config.LOCAL_DATA_ROOT}/.env に下記を追記してください:', file=sys.stderr)
        print('  R2_ACCESS_KEY_ID=...', file=sys.stderr)
        print('  R2_SECRET_ACCESS_KEY=...', file=sys.stderr)
        sys.exit(1)
    return aki, sak


def get_client(aki: str, sak: str):
    s = getattr(_thread_local, 'client', None)
    if s is None:
        cfg = Config(
            region_name='auto',
            signature_version='s3v4',
            retries={'max_attempts': 10, 'mode': 'adaptive'},
            max_pool_connections=64,
        )
        s = boto3.client(
            's3',
            endpoint_url=ENDPOINT,
            aws_access_key_id=aki,
            aws_secret_access_key=sak,
            config=cfg,
        )
        _thread_local.client = s
    return s


def upload_one_file(file_path: Path, law_id: str, aki: str, sak: str, dry_run: bool):
    """1ファイルアップ。戻り値: (law_id, filename, success, error_message)"""
    try:
        r2_key = f'{R2_PREFIX}/{law_id}/{file_path.name}'
        if dry_run:
            return (law_id, file_path.name, True, None)
        client = get_client(aki, sak)
        with file_path.open('rb') as f:
            client.put_object(
                Bucket=BUCKET,
                Key=r2_key,
                Body=f.read(),
                ContentType='application/json',
            )
        return (law_id, file_path.name, True, None)
    except ClientError as e:
        return (law_id, file_path.name, False, f'ClientError: {e}')
    except Exception as e:
        return (law_id, file_path.name, False, f'{type(e).__name__}: {e}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=32, help='並列度 (default 32)')
    ap.add_argument('--law-id', type=str, default=None)
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    aki, sak = get_credentials() if not args.dry_run else ('dummy', 'dummy')

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
        print(f'Resume: 既に {len(uploaded_keys)} 件アップ済み、残り {len(all_uploads)}',
              flush=True)

    print(f'対象: {len(law_dirs)} 法令、{len(all_uploads)} ファイル', flush=True)
    print(f'Endpoint: {ENDPOINT}', flush=True)
    print(f'Workers: {args.workers}', flush=True)
    if args.dry_run:
        print('★ DRY-RUN モード', flush=True)
    print(flush=True)

    if not all_uploads:
        print('アップロード対象なし')
        return 0

    start = time.time()
    success: list[str] = list(uploaded_keys)
    failed: list[dict] = []
    lock = threading.Lock()

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        future_map = {
            ex.submit(upload_one_file, fp, law_id, aki, sak, args.dry_run): (fp, law_id)
            for fp, law_id in all_uploads
        }
        for i, fut in enumerate(as_completed(future_map), 1):
            law_id, filename, ok, err = fut.result()
            r2_key = f'{R2_PREFIX}/{law_id}/{filename}'
            with lock:
                if ok:
                    success.append(r2_key)
                else:
                    failed.append({'law_id': law_id, 'file': filename, 'error': err})

            if i % 5000 == 0 or i == len(all_uploads):
                elapsed = time.time() - start
                rate = i / elapsed if elapsed > 0 else 0
                eta = (len(all_uploads) - i) / rate if rate > 0 else 0
                print(f'  {i:7d}/{len(all_uploads):7d}  '
                      f'success={len(success):7d}  failed={len(failed):4d}  '
                      f'rate={rate:.0f}/s  eta={eta/60:.1f}min',
                      flush=True)
                # resume log save
                with RESUME_LOG.open('w', encoding='utf-8') as f:
                    json.dump({'uploaded': success}, f, ensure_ascii=False)

    elapsed = time.time() - start
    print(flush=True)
    print('=== 完了 ===', flush=True)
    print(f'  処理時間: {elapsed/60:.1f} 分', flush=True)
    print(f'  成功:    {len(success)}', flush=True)
    print(f'  失敗:    {len(failed)}', flush=True)

    log = {
        'elapsed_seconds': elapsed,
        'success_count': len(success),
        'failed_count': len(failed),
        'r2_prefix': R2_PREFIX,
        'endpoint': ENDPOINT,
        'dry_run': args.dry_run,
        'failed_entries': failed[:100],
    }
    with LOG_FILE.open('w', encoding='utf-8') as f:
        json.dump(log, f, ensure_ascii=False, indent=2)

    return 0 if not failed else 2


if __name__ == '__main__':
    sys.exit(main())
