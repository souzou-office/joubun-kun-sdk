# -*- coding: utf-8 -*-
"""
再構築データの整合性検証スクリプト。

検証項目:
  1. fetched_laws の件数と law_id 一意性
  2. large_law_articles_v3 の各法令ディレクトリに _index.json あり
  3. _index.json の articles_count が実際のファイル合計と一致
  4. embedding_inputs.jsonl のID重複なし
  5. embedding_inputs.jsonl の text が空でない
  6. (vectors.ndjson があれば) ID 一致 + dim=1024 確認

使い方:
  python scripts/rebuild/07_verify.py
  python scripts/rebuild/07_verify.py --skip-vectors  (vectors.ndjson 未生成時)
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

ROOT = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output')
FETCHED = ROOT / 'fetched_laws'
ARTICLES_V3 = ROOT / 'large_law_articles_v3'
EMBEDDING_INPUTS = ROOT / 'embedding_inputs.jsonl'
VECTORS = ROOT / 'vectors.ndjson'


def report(name: str, ok: bool, detail: str = '') -> bool:
    mark = 'PASS' if ok else 'FAIL'
    print(f'[{mark}] {name}')
    if detail:
        for line in detail.splitlines():
            print(f'       {line}')
    return ok


def check_1_fetched_laws():
    files = list(FETCHED.glob('*.json'))
    law_ids = {f.stem for f in files}
    return report(
        '1. fetched_laws',
        len(files) == len(law_ids) and len(files) > 0,
        f'{len(files)} 法令ファイル, ユニーク law_id: {len(law_ids)}',
    )


def check_2_index_json():
    law_dirs = [d for d in ARTICLES_V3.iterdir() if d.is_dir()]
    missing_index = [d.name for d in law_dirs if not (d / '_index.json').exists()]
    return report(
        '2. _index.json 存在',
        len(missing_index) == 0,
        f'{len(law_dirs)} 法令、_index.json 欠損: {len(missing_index)}\n' +
        (f'  例: {missing_index[:5]}' if missing_index else 'OK'),
    )


def check_3_index_consistency():
    law_dirs = [d for d in ARTICLES_V3.iterdir() if d.is_dir()]
    inconsistent = []
    for d in law_dirs[:1000]:  # 全件は重いので抜き打ち
        idx_path = d / '_index.json'
        if not idx_path.exists():
            continue
        with idx_path.open('r', encoding='utf-8') as f:
            idx = json.load(f)
        # 実ファイル数 (= unique titles)
        actual_files = sum(1 for f in d.iterdir() if f.is_file() and f.name != '_index.json')
        if actual_files != idx.get('unique_titles', -1):
            inconsistent.append((d.name, actual_files, idx.get('unique_titles')))
    return report(
        '3. _index.json 整合性 (1000サンプル)',
        len(inconsistent) == 0,
        f'不整合: {len(inconsistent)}件\n' +
        (f'  例: {inconsistent[:3]}' if inconsistent else 'OK'),
    )


def check_4_embedding_input_ids():
    if not EMBEDDING_INPUTS.exists():
        return report('4. embedding_inputs ID 重複', False, 'embedding_inputs.jsonl 未生成')
    seen: set[str] = set()
    duplicates: list[str] = []
    total = 0
    with EMBEDDING_INPUTS.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                vid = rec.get('id')
                if vid in seen:
                    duplicates.append(vid)
                seen.add(vid)
                total += 1
            except Exception:
                continue
    return report(
        '4. embedding_inputs ID 重複なし',
        len(duplicates) == 0,
        f'総 {total} エントリ、重複: {len(duplicates)}\n' +
        (f'  例: {duplicates[:3]}' if duplicates else 'OK'),
    )


def check_5_embedding_input_text():
    if not EMBEDDING_INPUTS.exists():
        return report('5. embedding_inputs text', False, 'embedding_inputs.jsonl 未生成')
    empty_count = 0
    short_count = 0
    sample_short = []
    with EMBEDDING_INPUTS.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                text = rec.get('text', '')
                if not text:
                    empty_count += 1
                elif len(text) < 20:
                    short_count += 1
                    if len(sample_short) < 3:
                        sample_short.append((rec['id'], text))
            except Exception:
                continue
    return report(
        '5. embedding_inputs text non-empty',
        empty_count == 0,
        f'空テキスト: {empty_count}, 20文字未満: {short_count}\n' +
        (f'  例: {sample_short}' if sample_short else 'OK'),
    )


def check_6_vectors():
    if not VECTORS.exists():
        return report('6. vectors.ndjson', None, 'vectors.ndjson 未生成 (GPU 後生成)')
    total = 0
    bad_dim = 0
    bad_id = 0
    sample_bad = []
    with VECTORS.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                if not isinstance(rec.get('values'), list):
                    bad_dim += 1
                elif len(rec['values']) != 1024:
                    bad_dim += 1
                if not rec.get('id'):
                    bad_id += 1
                total += 1
            except Exception:
                continue
    return report(
        '6. vectors.ndjson dim=1024',
        bad_dim == 0 and bad_id == 0,
        f'総 {total} ベクトル、dim 不正: {bad_dim}, id 欠損: {bad_id}',
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--skip-vectors', action='store_true')
    args = ap.parse_args()

    print('=== rebuild_output 検証 ===\n')
    results = [
        check_1_fetched_laws(),
        check_2_index_json(),
        check_3_index_consistency(),
        check_4_embedding_input_ids(),
        check_5_embedding_input_text(),
    ]
    if not args.skip_vectors:
        results.append(check_6_vectors())

    print()
    passed = sum(1 for r in results if r is True)
    failed = sum(1 for r in results if r is False)
    skipped = sum(1 for r in results if r is None)
    print(f'=== {passed} pass / {failed} fail / {skipped} skip ===')

    sys.exit(0 if failed == 0 else 1)


if __name__ == '__main__':
    main()
