# 書き換えの判定の答え合わせ（読むだけ）: 本文の近さだけ（engine の仮置き）と、Jev で決め直したものを比べる
#   正解: 民法の債権法改正（平成29年法律第44号）で分かっている条と、平成16年の現代語化（番号の同じ条はほぼ全部が同じ規定）
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S          # noqa: E402
from lib.identity import Identity     # noqa: E402
from lib.resolve import Resolver      # noqa: E402

MINPO = '129AC0000000089'
BEFORE_2017 = '2017-01-01'
# (旧条, 判定): same=今も同じ番号の同じ規定 / moved=今の同じ番号ではない（別の規定に入れ替わった） / split=複数に分かれた
GOLD = [('415', 'same'), ('416', 'same'), ('424', 'same'), ('95', 'same'), ('96', 'same'), ('709', 'same'), ('90', 'same'),
        ('570', 'moved'), ('566', 'moved'), ('634', 'moved'), ('147', 'moved')]   # 147: 時効の中断の仕組みが無くなり、今の 147〜152 条は別の事柄（完成猶予・更新）


def ok(kind, num, now):
    if kind == 'same':
        return now == [num]
    if kind == 'moved':
        return num not in now
    return len(now) >= 2


def main():
    lin = os.path.join(S.DATA, 'out', MINPO, 'lineage.json')
    L = json.load(open(lin, encoding='utf-8'))
    asof = L.get('asof')
    rs = Resolver(L)
    idn = Identity(MINPO, S.DATA)
    rows = []
    # 系譜は e-Gov の一番古い版（2016-10-13）まで。債権法改正（2020-04-01）は 2018 年以降の分として後で e-Gov の版でつなぐので、
    # ここでは平成16年の現代語化（2005-04-01 ごろ）の前後で確かめる
    sim_ok = jev_ok = 0
    for num, kind in GOLD:
        a = rs.resolve(num, BEFORE_2017)
        b = idn.resolve(num, BEFORE_2017)
        a_now = [a['now']] if a.get('now') else []
        sim_ok += ok(kind, num, a_now)
        jev_ok += ok(kind, num, b.get('now') or [])
        rows.append({'art': num, 'expect': kind, 'sim_now': a_now, 'sim_ok': ok(kind, num, a_now),
                     'jev_now': b.get('now'), 'jev_status': b.get('status'), 'jev_ok': ok(kind, num, b.get('now') or [])})
    # 現代語化: 2004 年の第 1〜724 条（前三編）が今の同じ番号に行くか
    same_sim = same_jev = total = 0
    diffs = []
    for n in list(rs.by_num):
        if not n.split('_')[0].isdigit() or int(n.split('_')[0]) > 724:
            continue
        if not rs.pid_at(n, '2004-06-01'):
            continue
        total += 1
        a = rs.resolve(n, '2004-06-01')
        b = idn.resolve(n, '2004-06-01')
        same_sim += a.get('now') == n
        same_jev += b.get('now') == [n]
        if b.get('now') != [n] and len(diffs) < 30:
            diffs.append({'art': n, 'sim': a.get('status'), 'jev': b})
    out = {'asof': asof, 'jev_judged_pairs': idn.judged, 'gold_debt_2017': {'total': len(GOLD), 'similarity_ok': sim_ok, 'jev_ok': jev_ok},
           'gendaigoka_2004': {'articles': total, 'same_number_by_similarity': same_sim, 'same_number_by_jev': same_jev},
           'gendaigoka_not_same_by_jev': diffs, 'gold_rows_note': '債権法改正の正解は 2018 年以降の分（e-Gov の版）をつないでから確かめる', 'rows': rows}
    p = os.path.join(S.DATA, 'out', 'eval_identity.json')
    json.dump(out, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in out.items() if k not in ('rows', 'gendaigoka_not_same_by_jev')}, ensure_ascii=False, indent=1))
    for r in rows:
        print(r['art'], r['expect'], '| 近さ:', r['sim_now'], r['sim_ok'], '| Jev:', r['jev_status'], r['jev_now'], r['jev_ok'])
    for d in diffs[:12]:
        print('現代語化で同じ番号にならない:', d['art'], d['sim'], '→ Jev:', d['jev'].get('status'), d['jev'].get('now'))


if __name__ == '__main__':
    main()
