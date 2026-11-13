# 系譜から「版の地図」を作る（読むだけ・書くのは LINEAGE_DATA/out/maps/ だけ）
#   python -I -X utf8 scripts/lineage/export_map.py <法令ID>...
#   出力 out/maps/{法令ID}.json:
#     {v: 1, law_id, acts: {'平成23年法律第114号': 施行日}, nums: {'37': [[から, [今の条…] | null], …]}}
#     nums の各組は「その日から次の組の日の前日まで、第 N 条として引かれた規定は、今の何条か」。
#     null はその間その番号の条が無い。[] は今の条に同じ規定が無い（削除・別の規定・今は「削除」の印だけ）。
#     placed: 系譜に初めて出るのが e-Gov との答え合わせで置いた条の番号（それより前は系譜が欠けていて分からない）
#     caps: 今の条の見出し（判断の文の《見出し》と比べて、同じなら付け直さずに残す）
#   週次（Node）はこの地図だけで「判断の日の第 N 条 → 今の何条か」を引ける（Jev も Python も要らない）。
#   引き方は scripts/lineage/map_resolve.cjs（eval_cases.py と同じ決め方）
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S                    # noqa: E402
from lib.identity import Identity               # noqa: E402
from lib.xmlarts import is_deleted, main_articles   # noqa: E402
from eval_cases import act_dates                # noqa: E402


def export(law_id):
    I = Identity(law_id, S.DATA)
    ch = I.L.get('chain') or []
    cur = {a['num']: a for a in main_articles([S.egov_xml_revision(ch[-1]['revision'])])} if ch else {}
    deleted = {n for n, a in cur.items() if is_deleted(a['text'])}
    nums = {}
    for num, pids in I.by_num.items():
        dates = sorted({dt for p in pids for dt, _, _ in I.tl[p]})
        seq = []
        for d in dates:
            res = I.resolve(num, d)
            if res['status'] == 'その日に無い条':
                val = None
            else:
                val = [n for n in (res.get('now') or []) if n not in deleted]
            if seq and seq[-1][1] == val:
                continue
            seq.append([d, val])
        while seq and seq[0][1] is None:
            seq.pop(0)
        if seq:
            nums[num] = seq
    # その番号が系譜に初めて出るのが e-Gov との答え合わせで置いた条（改め文の読み漏れ）なら、それより前は分からない
    placed = sorted(n for n, pids in I.by_num.items()
                    if any(I.lineage.get(p, [{}])[0].get('op', '').startswith('e-Gov に合わせた（置いた）') for p in pids))
    caps = {n: re.sub(r'^（|）$', '', a.get('caption') or '') for n, a in cur.items() if a.get('caption')}
    out = {'v': 1, 'law_id': law_id, 'acts': act_dates(law_id, I), 'nums': nums, 'placed': placed, 'caps': caps}
    d = os.path.join(S.DATA, 'out', 'maps')
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f'{law_id}.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    return len(nums), os.path.getsize(os.path.join(d, f'{law_id}.json'))


if __name__ == '__main__':
    for lid in sys.argv[1:]:
        n, size = export(lid)
        print(json.dumps({'law_id': lid, 'nums': n, 'bytes': size}), flush=True)
