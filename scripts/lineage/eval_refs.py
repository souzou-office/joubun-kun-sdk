# 判例側の引用の読み取りの誤りの抜き取り（読むだけ）
#   lawRefs のうち「判決日にその条が無い」ものを数え、判決文の前後を抜き出して原因を分ける材料にする
import glob
import json
import os
import random
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S          # noqa: E402
from lib.kansuji import int2kan       # noqa: E402
from lib.resolve import Resolver      # noqa: E402

LAW_IDS = ['129AC0000000089', '132AC0000000048', '140AC0000000045', '323AC0000000131', '408AC0000000109', '334AC0000000121',
           '337AC0000000139', '334AC0000000127', '345AC0000000048', '405AC0000000047', '322AC0000000067']


def arr(v):
    if isinstance(v, list):
        return v
    try:
        return json.loads(v) if isinstance(v, str) else []
    except Exception:
        return []


def main():
    res = {lid: Resolver(os.path.join(S.DATA, 'out', lid, 'lineage.json')) for lid in LAW_IDS
           if os.path.exists(os.path.join(S.DATA, 'out', lid, 'lineage.json'))}
    total, missing, samples = 0, 0, []
    old_law = {}
    per_law = {}
    for f in sorted(glob.glob(os.path.join(S.DATA, 'hanrei_cases', 'cases_*.json'))):
        for rec in json.load(open(f, encoding='utf-8')).values():
            jd = rec.get('dateIso') or ''
            if not jd:
                continue
            for r in arr(rec.get('lawRefs')):
                lid = r.get('lawId')
                if lid not in res:
                    continue
                rs = res[lid]
                d = min(jd, rs.asof) if rs.asof else jd
                k = str(r.get('art') or '').replace('の', '_')
                total += 1
                if rs.pid_at(k, d):
                    continue
                # 今の法令ができる前の判決（旧民訴法・旧不競法など、法令ごと作り直す前の旧法の引用）は別に数える
                born = min((e.get('date') or '9999') for evs in rs.lineage.values() for e in evs[:1])
                if jd < born:
                    old_law[r.get('law')] = old_law.get(r.get('law'), 0) + 1
                    continue
                missing += 1
                per_law[r.get('law')] = per_law.get(r.get('law'), 0) + 1
                samples.append((rec, r, k))
    random.seed(7)
    out = []
    for rec, r, k in samples:
        secs = arr(rec.get('sections'))
        text = unicodedata.normalize('NFKC', ''.join((s or {}).get('text', '') for s in secs) + ' ' + str(rec.get('sanshoRaw') or ''))
        p = k.split('_')
        pats = [rf'{p[0]}条' + ''.join(f'の{x}' for x in p[1:]), f'第{int2kan(int(p[0]))}条']
        ctx = ''
        for pat in pats:
            m = re.search(pat, text)
            if m:
                ctx = text[max(0, m.start() - 60):m.end() + 30].replace('\n', ' ')
                break
        # 原因の見当（前後の文から）
        pre = ctx[:70]
        if re.search(r'(米国|アメリカ|スペイン|フランス|ドイツ|中華民国|中国|韓国|大韓民国|台湾|イギリス|英国|スイス|イタリア|オランダ|カリフォルニア州|ニューヨーク州)[^。、]{0,6}' + re.escape(r.get('law') or '') + '$', pre):
            why = '外国の法律を日本の法律と読んだ'
        elif re.search(r'(旧|改正前|従前|施行前)', ctx):
            why = '旧法・改正前の条（判決日の版では無い）'
        elif len(k.split('_')) >= 2 and re.search(rf"{k.split('_')[0]}条(?:の{k.split('_')[1]})?第?{k.split('_')[-1]}(?:項|号)", ctx):
            why = '項・号を枝番と読んだ'
        elif not ctx:
            why = '判決文に見つからない（参照法条の書き方など）'
        else:
            why = 'そのほか（系譜の誤りを含む）'
        out.append({'case': rec.get('id'), 'date': rec.get('dateIso'), 'law': r.get('law'), 'art': k, 'kaiseimae': r.get('kaiseimae'), 'why': why, 'context': ctx})
    why_count = {}
    for o in out:
        why_count[o['why']] = why_count.get(o['why'], 0) + 1
    res_out = {'refs_checked': total, 'before_current_law': old_law, 'why': why_count, 'not_in_force_at_judgment': missing, 'per_law': per_law, 'samples': out}
    json.dump(res_out, open(os.path.join(S.DATA, 'out', 'eval_refs.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in res_out.items() if k != 'samples'}, ensure_ascii=False, indent=1))
    for s in [o for o in out if o['why'].startswith('そのほか')][:25]:
        print(s['date'], s['law'], s['art'], '|', s['context'])


if __name__ == '__main__':
    main()
