# -*- coding: utf-8 -*-
"""
R2 から実際にアップロード済みのキー一覧を取得して resume.json を再構築する。

並行アップロード時に resume.json が乱れた場合や、実際の R2 状態を反映したい場合に使用。
"""

import json
import os
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

ACCT = os.environ.get('R2_ACCOUNT_ID')
TOKEN = os.environ.get('R2_API_TOKEN')
if not ACCT or not TOKEN:
    sys.exit('環境変数 R2_ACCOUNT_ID と R2_API_TOKEN を設定してください（旧ハードコードは廃止）')
BUCKET = 'joubun-kun-data'
PREFIX = 'large_law_articles_v3/'
OUTPUT = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/upload_r2_resume.json')


def list_all_keys(prefix: str) -> list[str]:
    keys = []
    cursor = None
    page = 0
    while True:
        page += 1
        params = {'per_page': '1000', 'prefix': prefix}
        if cursor:
            params['cursor'] = cursor
        url = f'https://api.cloudflare.com/client/v4/accounts/{ACCT}/r2/buckets/{BUCKET}/objects?{urllib.parse.urlencode(params)}'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {TOKEN}'})
        # 簡易リトライ
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.load(resp)
                break
            except Exception as e:
                if attempt < 4:
                    print(f'  retry {attempt+1}: {e}')
                    time.sleep(2 ** attempt)
                    continue
                raise
        items = data.get('result', [])
        for it in items:
            keys.append(it['key'])
        if page % 10 == 0:
            print(f'  page {page}: total {len(keys)}')
        cursor = data.get('result_info', {}).get('cursor')
        if not cursor or len(items) < 1000:
            break
        time.sleep(0.1)
    return keys


def main():
    print(f'Listing R2 keys under {PREFIX} ...')
    start = time.time()
    keys = list_all_keys(PREFIX)
    elapsed = time.time() - start
    print(f'  total: {len(keys)}')
    print(f'  elapsed: {elapsed:.1f}s')
    print()

    OUTPUT.write_text(json.dumps({'uploaded': keys}, ensure_ascii=False), encoding='utf-8')
    print(f'Wrote {OUTPUT}')


if __name__ == '__main__':
    main()
