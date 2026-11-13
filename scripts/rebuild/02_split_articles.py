# -*- coding: utf-8 -*-
"""
パース済み law JSON を条文単位ファイルに分割するスクリプト。

入力:
  {LOCAL_DATA_ROOT}\rebuild_output\fetched_laws\{law_id}.json  (1法令1ファイル)

出力構造:
  {LOCAL_DATA_ROOT}\rebuild_output\large_law_articles_v3\
    {law_id}\
      _index.json              # 法令メタ + article 一覧
      第一条.json              # 同名条文は配列でまとめる
      第二条.json
      ...
      別表第一.json
      ...

特徴:
  - 同名条文 (本則と附則の同 title) は1ファイル内の articles 配列に格納
  - ファイル名の特殊文字 (/, \, :, *, ?, <, >, |) は全角に置換
  - 各ファイルは Worker が直接 fetch する形式 (no chunk lookup needed)

使用方法:
  python scripts/rebuild/02_split_articles.py
  python scripts/rebuild/02_split_articles.py --law-id 129AC0000000089
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

INPUT_DIR = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/fetched_laws')
OUTPUT_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/large_law_articles_v3')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/split_log.json')


# ファイル名の変換と分割の本体は lib/split.py（週次更新 scripts/update/04_parse_split.py と共用）
from lib.split import safe_filename, split_law  # noqa: E402,F401


def split_one_law(law_json_path: Path) -> dict:
    """
    1法令分の JSON を読み込み、条文単位ファイルに分割。
    返却: 処理サマリ
    """
    with law_json_path.open('r', encoding='utf-8') as f:
        law = json.load(f)
    return split_law(law, OUTPUT_BASE)


def main() -> int:
    ap = argparse.ArgumentParser(description='Split parsed laws into per-article files')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--law-id', type=str, default=None)
    args = ap.parse_args()

    if not INPUT_DIR.exists():
        print(f'ERROR: input dir not found: {INPUT_DIR}')
        print('まず 01_parse_xml.py を実行してください')
        return 1

    OUTPUT_BASE.mkdir(parents=True, exist_ok=True)

    if args.law_id:
        targets = [INPUT_DIR / f'{args.law_id}.json']
        if not targets[0].exists():
            print(f'ERROR: {targets[0]} not found')
            return 1
    else:
        targets = sorted(INPUT_DIR.glob('*.json'))

    print(f'対象: {len(targets)} 法令')
    print(f'出力先: {OUTPUT_BASE}')
    print()

    start = time.time()
    success: list[dict] = []
    failed: list[dict] = []

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        future_map = {ex.submit(split_one_law, t): t for t in targets}
        for i, fut in enumerate(as_completed(future_map), 1):
            try:
                summary = fut.result()
                success.append(summary)
            except Exception as e:
                law_id = future_map[fut].stem
                failed.append({'law_id': law_id, 'error': f'{type(e).__name__}: {e}'})

            if i % 500 == 0 or i == len(targets):
                elapsed = time.time() - start
                rate = i / elapsed if elapsed > 0 else 0
                eta = (len(targets) - i) / rate if rate > 0 else 0
                print(f'  {i:5d}/{len(targets):5d}  '
                      f'success={len(success)}  failed={len(failed)}  '
                      f'rate={rate:.0f}/s  eta={eta:.0f}s')

    elapsed = time.time() - start

    # 集計
    total_articles = sum(s['articles_total'] for s in success)
    total_files = sum(s['unique_files'] for s in success)
    laws_with_dups = sum(1 for s in success if s['duplicate_titles'] > 0)

    print()
    print(f'=== 完了 ===')
    print(f'  処理時間:           {elapsed:.1f} 秒')
    print(f'  成功:              {len(success)}')
    print(f'  失敗:              {len(failed)}')
    print(f'  総条文数:          {total_articles:,}')
    print(f'  生成ファイル数:    {total_files:,}')
    print(f'  同名条文ありの法令: {laws_with_dups}')

    log = {
        'elapsed_seconds': elapsed,
        'success_count': len(success),
        'failed_count': len(failed),
        'total_articles': total_articles,
        'total_files': total_files,
        'laws_with_duplicate_titles': laws_with_dups,
        'failed_entries': failed[:50],
    }
    with LOG_FILE.open('w', encoding='utf-8') as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(f'\n  ログ: {LOG_FILE}')

    return 0 if not failed else 2


if __name__ == '__main__':
    sys.exit(main())
