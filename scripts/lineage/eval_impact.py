# 付け直しの効き目（読むだけ）: 判例の引用ごとに「判決が使った版の第 N 条 → 今の何条か」を引き、今の紐付け（同じ番号の今の条）と比べる
#   版の決め方: lawRefs.before（判決文の「…による改正前」）があればその改正の直前 → 無ければ判決日。
#   その日に条が無ければ、今の法令ができる前の判決は旧法（relink の受け皿）、そうでなければ直前にその条があった日（経過措置・旧い番号のまま引いた）
import datetime
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S          # noqa: E402
from lib.identity import Identity     # noqa: E402

LAW_IDS = ['129AC0000000089', '132AC0000000048', '140AC0000000045', '323AC0000000131', '408AC0000000109', '334AC0000000121',
           '337AC0000000139', '334AC0000000127', '345AC0000000048', '405AC0000000047', '322AC0000000067']
OLD_OF = {'408AC0000000109': '123AC0000000029', '405AC0000000047': '309AC0000000014'}   # 今の法令 → 作り直す前の旧法


def arr(v):
    if isinstance(v, list):
        return v
    try:
        return json.loads(v) if isinstance(v, str) else []
    except Exception:
        return []


def day_before(d):
    return (datetime.date.fromisoformat(d) - datetime.timedelta(days=1)).isoformat()


def main():
    idn = {lid: Identity(lid, S.DATA) for lid in LAW_IDS if os.path.exists(os.path.join(S.DATA, 'out', lid, 'lineage.json'))}
    born = {lid: min((e.get('date') or '9999') for evs in I.lineage.values() for e in evs[:1]) for lid, I in idn.items()}
    old_idn = {o: Identity(o, S.DATA) for o in OLD_OF.values() if os.path.exists(os.path.join(S.DATA, 'out', o, 'lineage.json'))}
    relink = {}
    for p in glob.glob(os.path.join(S.DATA, 'out', 'relink', '*.json')):
        j = json.load(open(p, encoding='utf-8'))
        relink[j['config']['old']] = {r['old_pid']: r for r in j['rows']}
    acts = {}
    for lid, I in idn.items():
        for a in I.L.get('acts', []):
            acts[(lid, re.sub(r'\d+月\d+日', '', a['law']))] = a
    c = {}
    ex = {}

    def bump(k, sample):
        c[k] = c.get(k, 0) + 1
        ex.setdefault(k, sample)

    for f in sorted(glob.glob(os.path.join(S.DATA, 'hanrei_cases', 'cases_*.json'))):
        for rec in json.load(open(f, encoding='utf-8')).values():
            jd = rec.get('dateIso') or ''
            if not jd:
                continue
            for r in arr(rec.get('lawRefs')):
                lid = r.get('lawId')
                if lid not in idn:
                    continue
                I = idn[lid]
                k = str(r.get('art') or '').replace('の', '_')
                d = jd
                for b in r.get('before') or []:
                    a = acts.get((lid, b))
                    if a:
                        d = day_before(a['enf'].get('date') or a['promulgated'])
                smp = {'case': rec.get('id'), 'date': jd, 'law': r.get('law'), 'art': k}
                res = I.resolve(k, d)
                if res['status'] == 'その日に無い条':
                    if jd < born[lid] and OLD_OF.get(lid) in old_idn:
                        o = OLD_OF[lid]
                        OI = old_idn[o]
                        pid = OI.pid_at(k, jd)
                        row = relink.get(o, {}).get(pid) if pid else None
                        if row and row.get('to'):
                            tos = [t for t in row['to'] if t['law'] == lid]
                            if tos and [t['art'] for t in tos] == [k]:
                                bump('旧法: 同じ番号の今の条に受け皿', smp)
                            elif tos:
                                bump('旧法: 別の番号の今の条に付け直す', {**smp, 'to': [t['art'] for t in tos]})
                            else:
                                bump('旧法: ほかの法令に受け皿', {**smp, 'to': row['to']})
                        else:
                            bump('旧法: 受け皿なし（今の条から外す）', smp)
                        continue
                    # 直前にその条があった日で引き直す（経過措置・旧い番号のまま引いた）
                    prev = [dt for dt, n, _ in sum((I.tl[p] for p in I.by_num.get(k, ())), []) if n == k and dt <= jd]
                    if prev:
                        res = I.resolve(k, max(prev))
                    else:
                        bump('判決日より前にその条が無い（読み取りの誤りなど）', smp)
                        continue
                now = res.get('now') or []
                if not now and res.get('pid') and res['pid'] in relink.get(lid, {}):
                    row = relink[lid][res['pid']]
                    if row.get('to'):
                        bump('ほかの法令に移った（受け皿に付け直す）', {**smp, 'to': row['to']})
                        continue
                if now == [k]:
                    bump('変わらない（同じ番号の同じ規定）', smp)
                elif not now:
                    bump('今の条に同じ規定が無い（今の条から外す）', smp)
                elif k in now:
                    bump('分かれた（今の同じ番号の条＋ほかの条）', {**smp, 'to': now})
                else:
                    bump('別の番号の今の条に付け直す', {**smp, 'to': now})
    tot = sum(c.values())
    out = {'refs': tot, 'counts': dict(sorted(c.items(), key=lambda x: -x[1])), 'examples': ex}
    json.dump(out, open(os.path.join(S.DATA, 'out', 'eval_impact.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
