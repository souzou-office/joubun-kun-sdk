# -*- coding: utf-8 -*-
"""
全 XML を一括パースして law_data JSON を出力するバッチスクリプト。

入力:
  {LOCAL_DATA_ROOT}\all_xml_20260508\{law_id}_{enforce_date}_{amending_law_id}\*.xml

処理:
  1. ディレクトリを law_id でグループ化
  2. 各 law_id について「施行日 <= 今日」の中で最新版を選択
  3. 統合パーサー (lib.egov_parser) でパース
  4. {LOCAL_DATA_ROOT}\rebuild_output\fetched_laws\{law_id}.json に保存

出力:
  {LOCAL_DATA_ROOT}\rebuild_output\fetched_laws\{law_id}.json
  {LOCAL_DATA_ROOT}\rebuild_output\parse_log.json (成功/失敗ログ)

並列化: ThreadPoolExecutor (lxml は GIL 解放するため有効)

使用方法:
  python scripts/rebuild/01_parse_xml.py
  python scripts/rebuild/01_parse_xml.py --workers 4
  python scripts/rebuild/01_parse_xml.py --limit 100      # テスト時 (最初の100法令だけ)
  python scripts/rebuild/01_parse_xml.py --law-id 129AC0000000089   # 1法令だけ
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

# import path
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from lib.egov_parser import parse_law_xml  # noqa: E402
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

XML_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/all_xml_20260508')
OUTPUT_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output')
FETCHED_DIR = OUTPUT_BASE / 'fetched_laws'
LOG_FILE = OUTPUT_BASE / 'parse_log.json'

# ディレクトリ名形式: {law_id}_{enforce_date(8桁)}_{amending_law_id}
DIR_NAME_RE = re.compile(r'^([0-9A-Z]+)_(\d{8})_(.+)$')


def collect_xml_dirs() -> dict[str, list[tuple[str, str, Path]]]:
    """
    XML ディレクトリを law_id でグループ化。
    返却: { law_id: [(enforce_date, amending_law_id, dir_path), ...] }
    """
    groups: dict[str, list[tuple[str, str, Path]]] = defaultdict(list)
    if not XML_BASE.exists():
        raise FileNotFoundError(f'XML base not found: {XML_BASE}')

    for d in XML_BASE.iterdir():
        if not d.is_dir():
            continue
        m = DIR_NAME_RE.match(d.name)
        if not m:
            continue
        law_id, enforce_date, amending = m.group(1), m.group(2), m.group(3)
        groups[law_id].append((enforce_date, amending, d))

    return groups


def select_latest_enforced(
    versions: list[tuple[str, str, Path]],
    today_yyyymmdd: str,
) -> tuple[str, str, Path] | None:
    """
    複数バージョンから「施行日 <= today」の中で最新を選択。

    全ての版が将来施行の場合は None (= 現行版なし)。
    """
    enforced = [v for v in versions if v[0] <= today_yyyymmdd]
    if not enforced:
        return None
    # 施行日昇順 (新しい順にしたいので最後)
    enforced.sort(key=lambda v: v[0])
    return enforced[-1]


def find_xml_file(dir_path: Path) -> Path | None:
    """ディレクトリ内の .xml ファイルを取得 (1ファイル想定)。"""
    xml_files = list(dir_path.glob('*.xml'))
    if not xml_files:
        return None
    return xml_files[0]


def parse_one(
    law_id: str,
    enforce_date: str,
    amending: str,
    xml_path: Path,
) -> tuple[bool, dict | None, str | None]:
    """
    1法令分パースし、出力ファイルへ書き出す。
    返却: (success, summary, error_message)
    """
    try:
        law = parse_law_xml(xml_path)
        # 取得時メタ情報を追加
        law['_source'] = {
            'xml_path': str(xml_path),
            'enforce_date': enforce_date,
            'amending_law_id': amending,
            'parsed_at': datetime.utcnow().isoformat() + 'Z',
        }

        out_path = FETCHED_DIR / f'{law_id}.json'
        FETCHED_DIR.mkdir(parents=True, exist_ok=True)
        with out_path.open('w', encoding='utf-8') as f:
            json.dump(law, f, ensure_ascii=False, separators=(',', ':'))

        summary = {
            'law_id': law_id,
            'law_title': law.get('law_title', ''),
            'articles_count': len(law.get('articles', [])),
            'enforce_date': enforce_date,
            'output_size': out_path.stat().st_size,
        }
        return True, summary, None
    except Exception as e:
        return False, None, f'{type(e).__name__}: {e}'


def main() -> int:
    ap = argparse.ArgumentParser(description='Parse all e-Gov XML to JSON')
    ap.add_argument('--workers', type=int, default=8, help='並列数 (default 8)')
    ap.add_argument('--limit', type=int, default=None, help='最初の N 法令だけ処理 (テスト用)')
    ap.add_argument('--law-id', type=str, default=None, help='特定の law_id だけ処理')
    ap.add_argument('--today', type=str, default=None,
                    help='施行日カットオフ (YYYYMMDD). default: 今日の日付')
    ap.add_argument('--include-future', action='store_true',
                    help='将来施行の版も含める (最新版を取る)')
    args = ap.parse_args()

    OUTPUT_BASE.mkdir(parents=True, exist_ok=True)
    FETCHED_DIR.mkdir(parents=True, exist_ok=True)

    today = args.today or datetime.now().strftime('%Y%m%d')
    print(f'Cut-off date (施行日): {today}')

    print('XML ディレクトリを収集...')
    groups = collect_xml_dirs()
    print(f'  ユニーク law_id 数: {len(groups)}')
    print(f'  総ディレクトリ数:  {sum(len(v) for v in groups.values())}')

    # フィルタ
    if args.law_id:
        if args.law_id not in groups:
            print(f'ERROR: law_id={args.law_id} が見つかりません')
            return 1
        groups = {args.law_id: groups[args.law_id]}

    # 各 law_id の現行版を選択
    targets: list[tuple[str, str, str, Path]] = []
    no_enforced: list[str] = []
    for law_id, versions in groups.items():
        if args.include_future:
            # 文字列ソートの最後 (最新日付)
            versions.sort(key=lambda v: v[0])
            chosen = versions[-1]
        else:
            chosen = select_latest_enforced(versions, today)
        if chosen is None:
            no_enforced.append(law_id)
            continue
        enforce_date, amending, dir_path = chosen
        xml_file = find_xml_file(dir_path)
        if xml_file is None:
            no_enforced.append(law_id)
            continue
        targets.append((law_id, enforce_date, amending, xml_file))

    print(f'  パース対象:        {len(targets)}')
    print(f'  施行待ち/XML欠損:  {len(no_enforced)}')

    if args.limit:
        targets = targets[:args.limit]
        print(f'  --limit={args.limit} 適用')

    # 並列パース
    print()
    print(f'パース開始 (workers={args.workers})...')
    start = time.time()
    success: list[dict] = []
    failed: list[dict] = []

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        future_map = {
            ex.submit(parse_one, law_id, ed, am, xp): law_id
            for (law_id, ed, am, xp) in targets
        }
        for i, fut in enumerate(as_completed(future_map), 1):
            law_id = future_map[fut]
            ok, summary, err = fut.result()
            if ok:
                success.append(summary)
            else:
                failed.append({'law_id': law_id, 'error': err})

            if i % 100 == 0 or i == len(targets):
                elapsed = time.time() - start
                rate = i / elapsed if elapsed > 0 else 0
                eta = (len(targets) - i) / rate if rate > 0 else 0
                print(f'  {i:5d}/{len(targets):5d}  '
                      f'success={len(success)}  '
                      f'failed={len(failed)}  '
                      f'rate={rate:.1f}/s  '
                      f'eta={eta:.0f}s')

    elapsed = time.time() - start
    print()
    print(f'=== 完了 ===')
    print(f'  処理時間: {elapsed:.1f} 秒')
    print(f'  成功:    {len(success)}')
    print(f'  失敗:    {len(failed)}')
    print(f'  施行待ち: {len(no_enforced)}')

    log = {
        'run_at': datetime.utcnow().isoformat() + 'Z',
        'today_cutoff': today,
        'workers': args.workers,
        'total_law_ids_in_xml': len(groups),
        'parsed_success': len(success),
        'parsed_failed': len(failed),
        'no_enforced_version': len(no_enforced),
        'elapsed_seconds': elapsed,
        'failed_entries': failed[:100],  # 最初の100件だけ
        'no_enforced_law_ids': no_enforced[:100],
    }
    with LOG_FILE.open('w', encoding='utf-8') as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(f'\n  ログ: {LOG_FILE}')
    print(f'  出力先: {FETCHED_DIR}')

    return 0 if not failed else 2


if __name__ == '__main__':
    sys.exit(main())
