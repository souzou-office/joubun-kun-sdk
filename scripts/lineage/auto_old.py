# 旧法の組（relink.py の CONFIG）を自動で拾う（読むだけ・書くのは LINEAGE_DATA/out/relink_auto.json だけ。¥0・LLM なし）
#   python -I -X utf8 scripts/lineage/auto_old.py [--min 5]
#
# 判例の引用から「今の法令ができる前の判決が、同じ名前で引いている法令」を数え（今の法令ができる前の旧法の引用）、
# 日本法令索引で同じ題名の前の法令（今の法令の公布より前・その後に「廃止」された法律）を旧法にする。
#   end: 今の法令の施行日の前日（今の法令の附則から読む。読めなければ公布日の前日）
#   succ: 今の法令＋旧法の改正の履歴に出てくる「新しく作られた法律」（題名に改正・整備・施行・特例を含まず、今もある法律。
#         旧民訴法 → 民事執行法・民事保全法のように、規定がほかの法令に移ったもの）
#   names: 「旧」＋題名（判決文の「旧破産法」などの未解決の引用から拾う）
# 手で書いた CONFIG（relink.py）にある旧法・今の法令は足さない（手で書いた方を正にする）。
import datetime
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S                       # noqa: E402
from lib.enforce import read_enforcement            # noqa: E402
from lib.kansuji import ERA, ERA_BASE, parse_egov_id   # noqa: E402
from lib.segments import suppl_main                 # noqa: E402
import relink                                       # noqa: E402
import xml.etree.ElementTree as ET                  # noqa: E402
from lib.kansuji import kan2int                     # noqa: E402
from lib.xmlarts import norm_amend, text_of         # noqa: E402

NEW_LAW_EXCLUDE = re.compile(r'改正|整備|施行|特例|臨時|経過|暫定|廃止|関係法律|等の一部')


def ref_counts():
    """今の法令の法令 ID → 今の法令の公布の年より前の判決の引用の数（同じ名前で旧法を引いたもの）"""
    cnt, names = {}, {}
    for f in glob.glob(os.path.join(S.DATA, 'hanrei_cases', 'cases_*.json')):
        for rec in json.load(open(f, encoding='utf-8')).values():
            jd = rec.get('dateIso') or ''
            if not jd:
                continue
            for r in rec.get('lawRefs') or []:
                p = parse_egov_id(r.get('lawId') or '')
                if p and p[2] == 'AC' and int(jd[:4]) < ERA_BASE[p[0]] + p[1]:
                    cnt[r['lawId']] = cnt.get(r['lawId'], 0) + 1
                    names[r['lawId']] = r.get('law')
    return cnt, names


def egov_id(a, kind='AC'):
    return f"{a['era']}{a['year']:02d}{kind}{a['num']:010d}"


def enforcement_of(law_id):
    """今の法令の制定時の附則から施行日（読めなければ公布日）"""
    era, year, _, num = parse_egov_id(law_id)
    paths = S.lawdb_paths(era, year, num)
    for d in S.ndl_search(S.title_of(law_id)):
        a = S.parse_announcement((d.get('announcement') or '').strip('（）'))
        if a and (a['era'], a['year'], a['num']) == (era, year, num):
            e = read_enforcement(suppl_main(paths), a['date']) if paths else {}
            return e.get('date') or e.get('hi') or a['date'], a['date']
    return None, None


def day_before(d):
    return (datetime.date.fromisoformat(d) - datetime.timedelta(days=1)).isoformat()


def abolished_in_suppl(law_id, title):
    """今の法令の制定時の附則の「○○法（昭和二十二年法律第二十七号）は、廃止する」から旧法（同じ題名）を読む → (元号, 年, 番号) か None"""
    era, year, _, num = parse_egov_id(law_id)
    for p in S.lawdb_paths(era, year, num):
        root = ET.parse(p).getroot()
        for sp in root.iter('SupplProvision'):
            if sp.get('AmendLawNum'):
                continue
            t = norm_amend(text_of(sp))
            m = re.search(re.escape(norm_amend(title)) + r'[（(]((?:明治|大正|昭和|平成|令和))((?:元|[〇一二三四五六七八九十]+))年法律第([〇一二三四五六七八九十百千]+)号[）)]は[、,]?廃止する', t)
            if m:
                return ERA[m.group(1)], 1 if m.group(2) == '元' else kan2int(m.group(2)), kan2int(m.group(3))
    return None


def find_old(law_id, title, prom):
    """旧法: 今の法令の附則で廃止した同じ題名の法律。無ければ日本法令索引で同じ題名の前の法律（今の法令の公布より前で、
    名古屋大学のデータにあるもの）の一番新しいもの"""
    k = abolished_in_suppl(law_id, title)
    if k and S.lawdb_paths(*k):
        a = {'era': k[0], 'year': k[1], 'num': k[2], 'kind': '法律', 'date': None}
        for d in S.ndl_search_all(title):
            x = S.parse_announcement((d.get('announcement') or '').strip('（）'))
            if x and (x['era'], x['year'], x['num']) == k:
                return x, d
        return a, {'law_id': None, 'announcement': f'{title}', 'how': '附則の廃止'}
    best = None
    for d in S.ndl_search_all(title):
        if (d.get('subject') or '') != title or d.get('div') != '法律':
            continue
        a = S.parse_announcement((d.get('announcement') or '').strip('（）'))
        if not a or a['kind'] != '法律' or a['date'] >= prom:
            continue
        if not S.lawdb_paths(a['era'], a['year'], a['num']):
            continue
        if not best or a['date'] > best[0]['date']:
            best = (a, d)
    return best


def shares_word(a, b):
    """題名に「法」「法律」「関する」以外の 2 文字の語が共通にあるか（旧所得税法 → 中小企業支援法 のような、同じ時期に旧法を直しただけの法律を外す）"""
    stop = {'法律', '関する', 'する法', 'に関', '及び'}
    grams = lambda t: {t[i:i + 2] for i in range(len(t) - 1)} - stop - {x for x in (t[i:i + 2] for i in range(len(t) - 1)) if x.endswith('法')}
    return bool(grams(a) & grams(b))


def extra_successors(ndl_id, law_id, end, title):
    """旧法の改正の履歴に出てくる、新しく作られた今もある法律（規定がほかの法令に移った先の候補）。旧法が終わった日の
    前後 2 年に施行されたものだけ（途中で旧法の一部を直しただけの法律は受け皿にしない）"""
    led = S.ledger()
    out = []
    if not ndl_id:
        return out
    for h in S.ndl_history(ndl_id):
        a = S.parse_announcement(h.get('announcement_disp'))
        if not a or a['kind'] != '法律':
            continue
        lid = egov_id(a)
        if lid == law_id or lid not in led:
            continue
        t = (led[lid] or {}).get('law_title') or ''
        if not t or NEW_LAW_EXCLUDE.search(t):
            continue
        enf, _ = enforcement_of(lid)
        when = enf or a['date']
        if abs((datetime.date.fromisoformat(when) - datetime.date.fromisoformat(end)).days) <= 730 and shares_word(t, title):
            out.append((lid, when, t))
    return out


def main(min_refs):
    cnt, names = ref_counts()
    manual_old = {c['old'] for c in relink.MANUAL_CONFIG}
    manual_cur = {c.get('current') for c in relink.MANUAL_CONFIG if c.get('current')}
    out, skipped = [], []
    for lid, n in sorted(cnt.items(), key=lambda x: -x[1]):
        if n < min_refs or lid in manual_cur:
            continue
        title = S.title_of(lid) if S.title_of(lid) != lid else (names.get(lid) or lid)
        enf, prom = enforcement_of(lid)
        if not prom:
            skipped.append({'current': lid, 'title': title, 'refs': n, 'why': '日本法令索引で今の法令が見つからない'})
            continue
        hit = find_old(lid, title, prom)
        if not hit:
            skipped.append({'current': lid, 'title': title, 'refs': n, 'why': '同じ題名の前の法律が無い（法令の名前が変わった・前は勅令など）'})
            continue
        a, d = hit
        old = egov_id(a)
        if old in manual_old:
            continue
        hist = S.ndl_history(d['law_id']) if d.get('law_id') else []
        abolished = [h for h in hist if (h.get('recognize_aspect') or '') == '廃止']
        end = day_before(enf or prom)
        succ = [(lid, enf or prom, title)] + [s for s in extra_successors(d.get('law_id'), lid, end, title) if s[0] != lid]
        out.append({'old': old, 'title': f"旧{title}（{(d.get('announcement') or '').strip('（）')}）", 'name': title,
                    'end': end, 'current': lid, 'names': [f'旧{title}'], 'succ': succ,
                    'refs': n, 'abolished_by': [h.get('announcement_disp') for h in abolished][:3], 'ndl_id': d.get('law_id'), 'how': d.get('how') or '日本法令索引', 'auto': True})
        print(json.dumps({k: out[-1][k] for k in ('old', 'title', 'end', 'refs', 'abolished_by')} | {'succ': [s[2] for s in succ]}, ensure_ascii=False), flush=True)
    p = os.path.join(S.DATA, 'out', 'relink_auto.json')
    json.dump({'config': out, 'skipped': skipped}, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'旧法の組 {len(out)}・見つからない {len(skipped)} → {p}')


if __name__ == '__main__':
    a = sys.argv[1:]
    main(int(a[a.index('--min') + 1]) if '--min' in a else 5)
