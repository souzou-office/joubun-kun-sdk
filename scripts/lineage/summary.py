# out/{法令ID}/report.json を表にする（読むだけ）
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S   # noqa: E402

ids = sys.argv[1:] or sorted(d for d in os.listdir(os.path.join(S.DATA, 'out')) if os.path.isdir(os.path.join(S.DATA, 'out', d)))
rows = []
for lid in ids:
    p = os.path.join(S.DATA, 'out', lid, 'report.json')
    if not os.path.exists(p):
        continue
    r = json.load(open(p, encoding='utf-8'))
    rows.append(f"| {r['title']} | {r.get('asof')} | {r.get('acts_applied')}/{r.get('acts_total')} | {len(r.get('acts_without_segment') or [])} | "
                f"{r.get('unparsed')} | {r.get('egov_articles')} | {r.get('both')} | {len(r.get('only_egov') or [])} | {len(r.get('only_ours') or [])} | "
                f"{r.get('avg_sim')} | {r.get('low_sim_count')} | {r.get('excluded_partial')} |")
print('| 法令 | 答え合わせの版 | 当てた改正法 | 部分が見つからない | 読めない節 | e-Gov の条 | 一致 | e-Gov だけ | こちらだけ | 本文の近さ | 0.8 未満 | 段階施行で除外 |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|')
print('\n'.join(rows))
