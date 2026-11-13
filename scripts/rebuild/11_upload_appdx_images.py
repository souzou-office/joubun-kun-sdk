# -*- coding: utf-8 -*-
"""
別表/様式の添付画像(10_download_appdx_images.py の出力)を R2 にアップロードするスクリプト。

方針(memory: 既存R2は触らない / Blue-Green):
  - 既存データは一切上書きせず、新パス appdx_images/ にのみ書き込む。
  - R2キー: appdx_images/{law_id}/pict/{file}
  - Worker は GET /api/appdx-image/{law_id}/{file} で env.R2.get('appdx_images/{law_id}/pict/{file}') して配信する想定。

認証(ハードコード回避。実行前に環境変数を設定):
  R2_ACCOUNT_ID   Cloudflare アカウントID
  R2_API_TOKEN    R2 書き込み権限のある APIトークン (Secret。リポジトリにコミットしない)
  R2_BUCKET       省略時 joubun-kun-data

入力:
  rebuild_output/appdx_images/{law_id}/pict/{file}

使い方:
  set R2_ACCOUNT_ID=...   (PowerShell: $env:R2_ACCOUNT_ID="...")
  set R2_API_TOKEN=...
  python scripts/rebuild/11_upload_appdx_images.py --dry-run     # 対象件数・サイズだけ表示
  python scripts/rebuild/11_upload_appdx_images.py               # 実アップロード
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

SRC_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/appdx_images')
DEST_PREFIX = 'appdx_images'  # R2 上の新パス
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/appdx_upload_log.json')

CONTENT_TYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.pdf': 'application/pdf', '.tif': 'image/tiff',
    '.tiff': 'image/tiff', '.bmp': 'image/bmp',
}


def content_type_for(name: str) -> str:
    return CONTENT_TYPES.get(Path(name).suffix.lower(), 'application/octet-stream')


def collect_files() -> list[tuple[Path, str]]:
    """(local_path, r2_key) の一覧。"""
    items = []
    for law_dir in sorted(SRC_BASE.iterdir()):
        if not law_dir.is_dir():
            continue
        law_id = law_dir.name
        pict = law_dir / 'pict'
        if not pict.is_dir():
            continue
        for f in sorted(pict.iterdir()):
            if f.is_file():
                key = f'{DEST_PREFIX}/{law_id}/pict/{f.name}'
                items.append((f, key))
    return items


def put_object(acct: str, token: str, bucket: str, key: str, data: bytes, ctype: str) -> int:
    url = f'https://api.cloudflare.com/client/v4/accounts/{acct}/r2/buckets/{bucket}/objects/{key}'
    req = urllib.request.Request(url, data=data, method='PUT',
                                 headers={'Authorization': f'Bearer {token}',
                                          'Content-Type': ctype})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status


def main() -> int:
    ap = argparse.ArgumentParser(description='Upload appendix images to R2 (new path, Blue-Green)')
    ap.add_argument('--workers', type=int, default=12)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not SRC_BASE.is_dir():
        print(f'ERROR: 入力が無い: {SRC_BASE}（先に 10_download_appdx_images.py を実行）')
        return 1

    items = collect_files()
    total_mb = sum(f.stat().st_size for f, _ in items) / 1024 / 1024
    laws = len({k.split('/')[1] for _, k in items})
    print(f'対象: {len(items)} ファイル / {laws} 法令 / {total_mb:.1f} MB')
    print(f'宛先: r2://<bucket>/{DEST_PREFIX}/...（既存パスは触らない）')

    if args.dry_run:
        print('--dry-run: アップロードはしません')
        return 0

    acct = os.environ.get('R2_ACCOUNT_ID')
    token = os.environ.get('R2_API_TOKEN')
    bucket = os.environ.get('R2_BUCKET', 'joubun-kun-data')
    if not acct or not token:
        print('ERROR: 環境変数 R2_ACCOUNT_ID と R2_API_TOKEN を設定してください')
        return 2

    start = time.time()
    ok = 0
    errors = []

    def work(item):
        f, key = item
        data = f.read_bytes()
        status = put_object(acct, token, bucket, key, data, content_type_for(f.name))
        return key, status

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(work, it): it for it in items}
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                _key, status = fut.result()
                ok += 1
            except Exception as e:
                f, key = futs[fut]
                errors.append({'key': key, 'error': f'{type(e).__name__}: {e}'})
            if i % 500 == 0 or i == len(items):
                print(f'  {i}/{len(items)}  ok={ok} err={len(errors)}')

    elapsed = time.time() - start
    print(f'\n完了: {elapsed:.1f}s  成功={ok} 失敗={len(errors)}')
    if errors:
        print('  失敗例:', errors[:5])
    LOG_FILE.write_text(json.dumps({
        'uploaded': ok, 'errors': len(errors), 'total_mb': round(total_mb, 1),
        'dest_prefix': DEST_PREFIX, 'error_samples': errors[:100],
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'  ログ: {LOG_FILE}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
