# -*- coding: utf-8 -*-
"""
別表/様式(AppdxStyle 等)の添付画像を e-Gov から取得してローカルに保存するスクリプト。

背景:
  パーサ(egov_parser.py)は AppdxTable しか別表として抽出しておらず、
  AppdxStyle/AppdxNote/AppdxFig/AppdxFormat(様式系の別表=申告書フォーム等)が
  落ちている。これらの実体は <Fig src="./pict/xxx.jpg|pdf"> の画像。
  データ化せず「自前ホスト」する方針(版ズレ・リンク切れを構造的に回避)。

取得元:
  GET https://laws.e-gov.go.jp/api/2/attachment/{法令版ID}
    → その版の添付ファイル全部を ZIP で返す(1法令1リクエスト)
  法令版ID = all_xml_20260508 のディレクトリ名 = {法令ID}_{施行日}_{改正法令ID}
  (= 本文スナップショットと同じ版。これで本文⇔画像の版が一致する)

出力:
  rebuild_output/appdx_images/{law_id}/pict/{file}        # 画像本体
  rebuild_output/appdx_images/{law_id}/_manifest.json     # 版ID・ファイル一覧・取得日時
  rebuild_output/appdx_images_log.json                    # 全体ログ

特徴:
  - Fig を含む法令だけ対象(XMLを軽くスキャンして判定)
  - レジューム対応(_manifest.json があればスキップ。--force で再取得)
  - ThreadPoolExecutor で並列、e-Gov に配慮して控えめな並列数

使い方:
  python scripts/rebuild/10_download_appdx_images.py --law-id 340M50000040012   # 1法令テスト
  python scripts/rebuild/10_download_appdx_images.py --limit 20                  # 先頭20法令
  python scripts/rebuild/10_download_appdx_images.py                            # 全件
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import urllib.request
import urllib.error
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

XML_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/all_xml_20260508')
OUT_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/appdx_images')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/appdx_images_log.json')

ATTACHMENT_URL = 'https://laws.e-gov.go.jp/api/2/attachment/{rev}'
DIR_NAME_RE = re.compile(r'^([0-9A-Z]+)_(\d{8})_(.+)$')
FIG_RE = re.compile(rb'<Fig\s+src=')

USER_AGENT = f'joubun-kun-appdx-fetch/1.0 (+legal reference tool; contact {site_config.CRAWLER_CONTACT})'


def select_snapshot_versions(today: str) -> dict[str, tuple[str, Path]]:
    """law_id -> (revision_id, xml_path)。01_parse_xml と同じ「施行日<=today の最新版」選択。"""
    groups: dict[str, list[tuple[str, str, Path]]] = defaultdict(list)
    for d in XML_BASE.iterdir():
        if not d.is_dir():
            continue
        m = DIR_NAME_RE.match(d.name)
        if not m:
            continue
        groups[m.group(1)].append((m.group(2), d.name, d))

    selected: dict[str, tuple[str, Path]] = {}
    for law_id, versions in groups.items():
        enforced = [v for v in versions if v[0] <= today] or versions
        enforced.sort(key=lambda v: v[0])
        _, rev_id, dir_path = enforced[-1]
        xmls = list(dir_path.glob('*.xml'))
        if xmls:
            selected[law_id] = (rev_id, xmls[0])
    return selected


def has_fig(xml_path: Path) -> bool:
    try:
        with xml_path.open('rb') as f:
            return FIG_RE.search(f.read()) is not None
    except Exception:
        return False


def http_get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def download_one(law_id: str, rev_id: str, force: bool) -> dict:
    out_dir = OUT_BASE / law_id
    manifest_path = out_dir / '_manifest.json'
    if manifest_path.exists() and not force:
        return {'law_id': law_id, 'status': 'skip', 'reason': 'already_done'}

    url = ATTACHMENT_URL.format(rev=rev_id)
    try:
        data = http_get(url)
    except urllib.error.HTTPError as e:
        return {'law_id': law_id, 'status': 'error', 'reason': f'http {e.code}'}
    except Exception as e:
        return {'law_id': law_id, 'status': 'error', 'reason': f'{type(e).__name__}: {e}'}

    # ZIP として展開
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return {'law_id': law_id, 'status': 'error', 'reason': 'not_a_zip', 'bytes': len(data)}

    pict_dir = out_dir / 'pict'
    pict_dir.mkdir(parents=True, exist_ok=True)
    files = []
    total_bytes = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        # ZIP 内パスは "pict/xxx.jpg" 想定。basename で安全に保存。
        name = Path(info.filename).name
        if not name:
            continue
        content = zf.read(info)
        (pict_dir / name).write_bytes(content)
        files.append({'name': name, 'size': info.file_size})
        total_bytes += info.file_size

    # 画像が無い法令(別表がAppdxTable=テキスト表のみ等)は保存しない
    if not files:
        try:
            pict_dir.rmdir()
            out_dir.rmdir()
        except OSError:
            pass
        return {'law_id': law_id, 'status': 'empty', 'file_count': 0}

    manifest = {
        'law_id': law_id,
        'law_revision_id': rev_id,
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'source': url,
        'file_count': len(files),
        'total_bytes': total_bytes,
        'files': files,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'law_id': law_id, 'status': 'ok', 'file_count': len(files), 'bytes': total_bytes}


def main() -> int:
    ap = argparse.ArgumentParser(description='Download e-Gov appendix/style attachment images')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--law-id', type=str, default=None)
    ap.add_argument('--today', type=str, default=None, help='施行日カットオフ YYYYMMDD (default: 今日)')
    ap.add_argument('--force', action='store_true', help='既存 manifest を無視して再取得')
    args = ap.parse_args()

    today = args.today or datetime.now().strftime('%Y%m%d')
    OUT_BASE.mkdir(parents=True, exist_ok=True)

    print(f'スナップショット版を選択中 (cutoff={today}) ...')
    selected = select_snapshot_versions(today)
    print(f'  全法令: {len(selected)}')

    if args.law_id:
        if args.law_id not in selected:
            print(f'ERROR: {args.law_id} がスナップショットに無い')
            return 1
        targets = {args.law_id: selected[args.law_id]}
    else:
        print('  Fig(画像)を持つ法令を抽出中 ...')
        targets = {lid: v for lid, v in selected.items() if has_fig(v[1])}
        print(f'  画像あり法令: {len(targets)}')

    items = list(targets.items())
    if args.limit:
        items = items[:args.limit]
        print(f'  --limit={args.limit} 適用')

    start = time.time()
    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(download_one, lid, rev, args.force): lid for lid, (rev, _xml) in items}
        for i, fut in enumerate(as_completed(futs), 1):
            results.append(fut.result())
            if i % 50 == 0 or i == len(items):
                ok = sum(1 for r in results if r['status'] == 'ok')
                err = sum(1 for r in results if r['status'] == 'error')
                skip = sum(1 for r in results if r['status'] == 'skip')
                mb = sum(r.get('bytes', 0) for r in results) / 1024 / 1024
                print(f'  {i:5d}/{len(items):5d}  ok={ok} skip={skip} err={err}  {mb:.1f}MB')

    elapsed = time.time() - start
    ok = [r for r in results if r['status'] == 'ok']
    err = [r for r in results if r['status'] == 'error']
    total_files = sum(r.get('file_count', 0) for r in ok)
    total_mb = sum(r.get('bytes', 0) for r in results) / 1024 / 1024

    print('\n=== 完了 ===')
    print(f'  時間: {elapsed:.1f}s  成功:{len(ok)} 失敗:{len(err)}')
    print(f'  画像: {total_files}枚  {total_mb:.1f}MB')
    if err:
        print('  失敗例:', err[:5])

    LOG_FILE.write_text(json.dumps({
        'run_at': datetime.now(timezone.utc).isoformat(),
        'today_cutoff': today,
        'targets': len(items),
        'ok': len(ok),
        'error': len(err),
        'total_files': total_files,
        'total_mb': round(total_mb, 1),
        'errors': err[:100],
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'  ログ: {LOG_FILE}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
