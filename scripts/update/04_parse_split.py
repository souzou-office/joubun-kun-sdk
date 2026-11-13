# -*- coding: utf-8 -*-
"""
Phase 1 Step D: 取得した XML をパースして条文単位ファイルにする（scripts/rebuild の統合パーサーを使う）。

  python scripts/update/04_parse_split.py [--workers 4] [--laws ID,ID]

入力: {UPDATE_STATE_DIR}/xml/{law_id}.xml
出力: {UPDATE_STATE_DIR}/out/{law_id}/{title}.json + _index.json（編・章の目次つき）
      {UPDATE_STATE_DIR}/parse_log.json  { success: [...], failed: [...] }

パース失敗が 1 件でもあると 05_diff が apply を止める（失敗した法令だけ古いままにはしない。理由: 失敗の原因が
パーサーの不具合なら他の法令にも同じ欠けが出ているかもしれないので、人が見てから流す）。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
REBUILD = HERE.parent / 'rebuild'
sys.path.insert(0, str(REBUILD))
from lib.egov_parser import parse_law_xml  # noqa: E402
from lib.split import split_law  # noqa: E402

STATE_DIR = Path(os.environ.get('UPDATE_STATE_DIR') or (HERE / 'state'))
XML_DIR = STATE_DIR / 'xml'
OUT_DIR = STATE_DIR / 'out'
LOG_FILE = STATE_DIR / 'parse_log.json'


def load_revisions() -> dict[str, str]:
    """change_report.json から law_id → 新しい改正 ID。_source に入れて出どころを残す（時刻は入れない: 同じ版なら同じバイト列になるように）。"""
    p = STATE_DIR / 'change_report.json'
    if not p.exists():
        return {}
    rep = json.load(p.open(encoding='utf-8'))
    out = {m['law_id']: m.get('new_revision_id') for m in rep.get('modified', []) if m.get('law_id')}
    nxt = STATE_DIR / 'sync_state.next.json'
    if nxt.exists():
        laws = json.load(nxt.open(encoding='utf-8')).get('laws', {})
        for law_id in rep.get('added', []):
            out[law_id] = (laws.get(law_id) or {}).get('law_revision_id')
    return out


REVISIONS = load_revisions()


def load_statuses() -> dict[str, str]:
    """law_id → e-Gov の current_revision_status（'UnEnforced' など）。未施行の新法を _source に残す。"""
    nxt = STATE_DIR / 'sync_state.next.json'
    if not nxt.exists():
        return {}
    laws = json.load(nxt.open(encoding='utf-8')).get('laws', {})
    return {law_id: e.get('revision_status') for law_id, e in laws.items() if isinstance(e, dict) and e.get('revision_status')}


STATUSES = load_statuses()


def parse_one(xml_path: Path) -> dict:
    law_id = xml_path.stem
    law = parse_law_xml(xml_path, law_id=law_id)
    law['_source'] = {
        'fetched_from': 'e-Gov 法令API v2 law_file/xml',
        'law_revision_id': REVISIONS.get(law_id),
    }
    if STATUSES.get(law_id) and STATUSES[law_id] != 'CurrentEnforced':
        law['_source']['revision_status'] = STATUSES[law_id]   # 例: 'UnEnforced'（未施行）
    # 出力先を作り直す（前回の残りが混ざらないように）
    dest = OUT_DIR / law_id
    if dest.exists():
        shutil.rmtree(dest)
    summary = split_law(law, OUT_DIR)
    summary['law_type'] = law.get('law_type', '')
    return summary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--laws', type=str, default=None)
    args = ap.parse_args()

    if not XML_DIR.exists():
        print(f'ERROR: {XML_DIR} がありません。先に 03_fetch_changed_laws.cjs を実行してください')
        return 1
    targets = sorted(XML_DIR.glob('*.xml'))
    if args.laws:
        want = set(s.strip() for s in args.laws.split(',') if s.strip())
        targets = [t for t in targets if t.stem in want]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f'パース対象: {len(targets)} 法令 → {OUT_DIR}')

    start = time.time()
    success: list[dict] = []
    failed: list[dict] = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(parse_one, t): t for t in targets}
        for i, fut in enumerate(as_completed(futs), 1):
            t = futs[fut]
            try:
                success.append(fut.result())
            except Exception as e:  # noqa: BLE001
                failed.append({'law_id': t.stem, 'error': f'{type(e).__name__}: {e}'})
            if i % 200 == 0 or i == len(targets):
                print(f'  {i}/{len(targets)}  ok={len(success)} failed={len(failed)}  {time.time() - start:.0f}s', flush=True)

    log = {
        'parsed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'elapsed_seconds': round(time.time() - start, 1),
        'success_count': len(success),
        'failed_count': len(failed),
        'total_articles': sum(s['articles_total'] for s in success),
        'total_files': sum(s['unique_files'] for s in success),
        'success': success,
        'failed': failed,
    }
    with LOG_FILE.open('w', encoding='utf-8') as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(f'完了: 成功 {len(success)} / 失敗 {len(failed)} / 条文 {log["total_articles"]:,} / ファイル {log["total_files"]:,}')
    if failed:
        for x in failed[:10]:
            print('  失敗:', x)
    return 0


if __name__ == '__main__':
    sys.exit(main())
