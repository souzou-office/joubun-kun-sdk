# 判決が使った版: 判決文の「（…法律第N号による改正前のもの）」を正解にして、判決日で版を決めるやり方がどれだけ外れるかを測る（読むだけ）
#   python -I -X utf8 scripts/lineage/eval_versions.py
#   材料: LINEAGE_DATA/hanrei_cases/cases_*.json（本番 R2 hanrei_v1 の写し）と out/{法令ID}/lineage.json
import datetime
import glob
import json
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S                    # noqa: E402
from lib.kansuji import ERA, ERA_BASE, kan2int  # noqa: E402
from lib.resolve import Resolver                # noqa: E402

LAWS = {   # 判決文での名前 → 法令 ID（系譜を作った法令だけ）
    '民法': '129AC0000000089', '商法': '132AC0000000048', '刑法': '140AC0000000045', '地方自治法': '322AC0000000067',
    '刑事訴訟法': '323AC0000000131', '刑訴法': '323AC0000000131', '特許法': '334AC0000000121', '商標法': '334AC0000000127',
    '行政事件訴訟法': '337AC0000000139', '行訴法': '337AC0000000139', '著作権法': '345AC0000000048',
    '不正競争防止法': '405AC0000000047', '民事訴訟法': '408AC0000000109', '民訴法': '408AC0000000109',
}
NAME = '|'.join(sorted(LAWS, key=len, reverse=True))
DIG = r'[0-9〇一二三四五六七八九十百千]+'
LAWNUM = rf'(明治|大正|昭和|平成|令和)({DIG}|元)年法律第({DIG})号'
Q_BEFORE = rf'\((?:{LAWNUM}(?:[^()]{{0,40}}?))(?:による|で)改正(?:され)?る?前の(?:もの)?(?:[。、][^()]{{0,40}})?\)'
ART = rf'第?({DIG})条((?:の{DIG})*)'
# 1) 民法(平成29年法律第44号による改正前のもの)415条  2) 平成29年法律第44号による改正前の民法415条
RX1 = re.compile(rf'(?<![一-鿿])({NAME}){Q_BEFORE}{ART}')
RX2 = re.compile(rf'{LAWNUM}(?:[^()。]{{0,30}}?)による改正前の({NAME}){ART}')
# 3) 定義「民法(平成29年法律第44号による改正前のもの。以下「旧民法」という。)」→ 以後「旧民法415条」
RX_DEF = re.compile(rf'(?<![一-鿿])({NAME})\({LAWNUM}[^()]{{0,40}}?による改正前の(?:もの)?。以下(?:単に)?「([^「」]{{1,12}})」という。?\)')
# 引用一般（判決日で版を決める側の母数）
RX_ANY = re.compile(rf'(?<![一-鿿旧])({NAME})(?:\([^()]{{0,60}}\))?{ART}')


def num(s):
    return int(s) if s.isdigit() else kan2int(s)


def art_key(n, eda):
    subs = [num(x) for x in re.findall(DIG, eda or '')]
    return '_'.join(str(x) for x in [num(n)] + subs)


def act_key(era, year, n):
    return (ERA[era], 1 if year == '元' else num(year), num(n))


def day_before(d):
    return (datetime.date.fromisoformat(d) - datetime.timedelta(days=1)).isoformat()


def main():
    res, acts = {}, {}
    for lid in set(LAWS.values()):
        p = os.path.join(S.DATA, 'out', lid, 'lineage.json')
        if not os.path.exists(p):
            continue
        L = json.load(open(p, encoding='utf-8'))
        res[lid] = Resolver(L)
        for a in L.get('acts', []):
            m = re.match(r'^(明治|大正|昭和|平成|令和)(元|\d+)年\d+月\d+日法律第(\d+)号', a['law'])
            if m:
                acts[(lid,) + act_key(*m.groups())] = a
    out = {'explicit': 0, 'resolved': 0, 'same_identity': 0, 'differs': 0, 'act_unknown': 0, 'after_asof': 0,
           'by_status_judgment_date': {}, 'by_status_explicit': {}}
    examples = []
    for f in sorted(glob.glob(os.path.join(S.DATA, 'hanrei_cases', 'cases_*.json'))):
        for rec in json.load(open(f, encoding='utf-8')).values():
            jd = rec.get('dateIso') or ''
            if not jd:
                continue
            secs = rec.get('sections')
            if isinstance(secs, str):
                try:
                    secs = json.loads(secs)
                except Exception:
                    secs = []
            text = unicodedata.normalize('NFKC', ''.join((s or {}).get('text', '') for s in (secs or [])) + str(rec.get('sanshoRaw') or ''))
            text = text.replace('（', '(').replace('）', ')')
            hits = []
            for m in RX1.finditer(text):
                hits.append((m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), m.group(6)))
            for m in RX2.finditer(text):
                hits.append((m.group(4), m.group(1), m.group(2), m.group(3), m.group(5), m.group(6)))
            for d in RX_DEF.finditer(text):
                if len(d.group(5)) < 2 or d.group(5) in LAWS:   # 「法」「民法」のような略称は他の引用と区別できないので使わない
                    continue
                abbr = re.escape(d.group(5))
                for m in re.finditer(rf'(?<![一-鿿]){abbr}{ART}', text):
                    hits.append((d.group(1), d.group(2), d.group(3), d.group(4), m.group(1), m.group(2)))
            for name, era, year, n, a, eda in hits:
                lid = LAWS[name]
                if lid not in res:
                    continue
                out['explicit'] += 1
                act = acts.get((lid,) + act_key(era, year, n))
                if not act:
                    out['act_unknown'] += 1
                    continue
                enf = act['enf']
                when = enf.get('date') or act['promulgated']
                r = res[lid]
                if r.asof and when > r.asof:
                    out['after_asof'] += 1   # 系譜の最後（e-Gov の一番古い版）より後の改正（2018 年以降の分は e-Gov の版でつなぐ）
                    continue
                k = art_key(a, eda)
                ex = r.resolve(k, day_before(when))
                jr = r.resolve(k, min(jd, r.asof) if r.asof else jd)
                out['resolved'] += 1
                out['by_status_explicit'][ex['status']] = out['by_status_explicit'].get(ex['status'], 0) + 1
                out['by_status_judgment_date'][jr['status']] = out['by_status_judgment_date'].get(jr['status'], 0) + 1
                if ex['pid'] and ex['pid'] == jr['pid']:
                    out['same_identity'] += 1
                else:
                    out['differs'] += 1
                    if len(examples) < 40:
                        examples.append({'case': rec.get('id'), 'date': jd, 'law': name, 'art': k, 'before': f'{era}{year}年法律第{n}号',
                                         'explicit': ex, 'by_judgment_date': jr})
    out['examples'] = examples
    p = os.path.join(S.DATA, 'out', 'eval_versions.json')
    json.dump(out, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in out.items() if k != 'examples'}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
