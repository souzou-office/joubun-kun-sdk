# -*- coding: utf-8 -*-
"""監査用: 指定した国の全条文をUTF-8テキストで書き出す（エージェントの通読用）
  python scripts/treaty/_dump_for_audit.py 出力パス 国名1 国名2 ...
"""
import json
import pathlib
import sys

STATE = pathlib.Path(__file__).parent / 'state'
out_path = sys.argv[1]
countries = sys.argv[2:]
data = json.loads((STATE / 'treaty_articles_capped.json').read_text(encoding='utf-8'))
lines = []
for t in data:
    if t['country'] not in countries:
        continue
    lines.append(f"===== {t['country']}（{t['doc_type']}・{'縦書き由来' if t.get('vertical') else '横書き由来'}） {t['treaty_title'][:60]} =====")
    for a in t['articles']:
        label = '議定書等' if a['no'] == 0 else f"第{a['no']}条"
        lines.append(f"--- {label}（{a.get('cap', '')}） ---")
        lines.append(a.get('body', ''))
        lines.append('')
pathlib.Path(out_path).write_text('\n'.join(lines), encoding='utf-8')
print(f'wrote {out_path} ({len(lines)} lines)')
