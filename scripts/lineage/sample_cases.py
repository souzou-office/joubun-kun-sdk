# 付け直しの結果から抜き取って、目で確かめるための表を出す（読むだけ）
#   python -I -X utf8 scripts/lineage/sample_cases.py [件数=100] [種=1]
#   区分ごとに割り当てて抜き、判断の文（引用の前後）・判断のときの《見出し》・行き先の今の見出しを並べる
import glob
import json
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S   # noqa: E402

# (最後の決め方, 系譜の区分の頭, 版の手がかり, 件数)
QUOTA = [('keep', '変わらない', 'explicit|defined|abbr', 20), ('keep', '', 'caption', 10), ('relink', '', '', 25),
         ('remove', '今の条に同じ規定が無い', '', 35), ('remove', '施行令', '', 5), ('remove', 'ほかの法令', '', 5)]


def flat(secs):
    o = ''
    for x in secs or []:
        o += '\n' + (x.get('head') or '') + '\n' + (x.get('text') or '') + flat(x.get('children'))
    return o


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    random.seed(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    D = [json.loads(l) for l in open(os.path.join(S.DATA, 'out', 'eval_cases_details.ndjson'), encoding='utf-8')]
    texts = {}
    for f in glob.glob(os.path.join(S.DATA, 'cases_r2', 'saiketsu_v1', 'cases_*.json')):
        for it in json.load(open(f, encoding='utf-8')).values():
            texts[('裁決', it['id'])] = (it.get('title') or '') + '\n' + (it.get('abstract') or '') + flat(it.get('sections'))
    for f in glob.glob(os.path.join(S.DATA, 'cases_r2', 'shitsugi_v1', 'cases_*.json')):
        for it in json.load(open(f, encoding='utf-8')).values():
            texts[('事例', it['id'])] = '\n'.join(it.get('kankei_raw') or [])
    title = {k: v.get('law_title', k) for k, v in S.ledger().items()}
    picked = []
    for final, cat, how, q in QUOTA:
        if how == 'caption':   # 系譜は付け直す・外すと言ったが、判断の文の見出しが今の同じ番号の条と同じなので残したもの
            pool = [d for d in D if d.get('final') == 'keep' and not d['cat'].startswith(('変わらない', '系譜', '日付')) and '今のまま' not in d['cat']]
        else:
            pool = [d for d in D if d.get('final') == final and d['cat'].startswith(cat)
                    and (not how or d['how'] in how.split('|') or set(d['hows']) & set(how.split('|')))]
        picked += [(final + ':' + (cat or how), d) for d in random.sample(pool, min(q, len(pool)))]
    for i, (cat, d) in enumerate(picked[:n], 1):
        t = texts.get((d['kind'], d['id']), '').translate(str.maketrans('０１２３４５６７８９', '0123456789'))
        a = str(d['art'])
        lt = title.get(d['law_id'], d['law_id'])
        short = re.sub(r'^(租税特別|国税)', '', lt)[:4]
        ctx = ''
        for m in re.finditer(rf'第{re.escape(a)}条(?![の0-9])', t):
            pre = t[max(0, m.start() - 45):m.start()]
            if short[:2] in pre or '同法' in pre or '措置法' in pre or '通則法' in pre:
                ctx = (pre + t[m.start():m.end() + 25]).replace('\n', ' ')
                break
        print(f"{i:3d}. [{cat[:12]}] {d['kind']} {d['id']} {d['date']} {lt} {a}条 how={d['how']} → now={d['now']}")
        print(f"     当時《{d.get('cap_then') or ''}》 同番号の今《{d.get('cap_same_now') or ''}》 行き先の今{d.get('cap_target_now') or ''}")
        print(f"     文: {ctx[:120]}")


if __name__ == '__main__':
    main()
