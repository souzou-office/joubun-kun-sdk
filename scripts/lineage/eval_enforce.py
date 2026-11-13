# 施行日の読み取りを確かめる（読むだけ）
#   1. e-Gov の改正履歴に段ごとの施行日がある改正法: 附則から読んだ日（か幅）と合うか
#   2. 分かっている日（法令の施行で広く知られた日）と合うか
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S   # noqa: E402

KNOWN = {   # 改正法 → 施行日（主な部分）
    '昭和22年12月22日法律第222号': '1948-01-01',   # 民法の家族法の全面改正
    '平成16年12月1日法律第147号': '2005-04-01',    # 民法の現代語化
    '平成29年6月2日法律第44号': '2020-04-01',      # 民法の債権法改正
    '平成17年7月26日法律第87号': '2006-05-01',     # 会社法の施行に伴う整備法
    '平成7年5月12日法律第91号': '1995-06-01',      # 刑法の平易化
    '平成8年6月26日法律第110号': '1998-01-01',     # 民事訴訟法の施行に伴う整備法
}

rows, stats = [], {'egov_acts': 0, 'text_exact': 0, 'text_in_range': 0, 'text_unknown': 0, 'text_wrong': 0}
known = {}
for lid in sorted(os.listdir(os.path.join(S.DATA, 'out'))):
    p = os.path.join(S.DATA, 'out', lid, 'lineage.json')
    if not os.path.exists(p):
        continue
    for a in json.load(open(p, encoding='utf-8')).get('acts', []):
        enf, ft = a['enf'], a['enf'].get('from_text') or {}
        if a['law'] in KNOWN:
            got = ft.get('date')
            known[a['law']] = {'want': KNOWN[a['law']], 'text': got, 'hi': ft.get('hi'), 'how': ft.get('how'), 'final': enf.get('date')}
        st = enf.get('stages')
        if not st:
            continue
        stats['egov_acts'] += 1
        # 部分ごとの日（ただし書）も e-Gov の段にあるか
        for se in a.get('seg_enf') or []:
            stats['seg_dates'] = stats.get('seg_dates', 0) + 1
            if se.get('date') in st:
                stats['seg_in_stages'] = stats.get('seg_in_stages', 0) + 1
        if ft.get('date') in st:
            stats['main_in_stages'] = stats.get('main_in_stages', 0) + 1
        first = st[0]
        if ft.get('date') == first:
            stats['text_exact'] += 1
        elif ft.get('date') is None and ft.get('hi') and a['promulgated'] <= first <= ft['hi']:
            stats['text_in_range'] += 1
        elif ft.get('date') is None:
            stats['text_unknown'] += 1
        else:
            stats['text_wrong'] += 1
            rows.append({'law': a['law'], 'text': ft, 'egov': st, 'in': lid})
print(json.dumps({'stats': stats, 'known': known, 'wrong': rows[:30]}, ensure_ascii=False, indent=1))
