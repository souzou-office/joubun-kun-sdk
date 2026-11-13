# 月に 1 回: 今の法令の系譜に、e-Gov の新しい版（前回の続き）を足す。docs/lineage.md の「月に 1 回の作り直し」
#   python -I -X utf8 scripts/lineage/monthly.py [法令ID ...]
#   読む: LINEAGE_DATA/out/{法令ID}/lineage.json・report.json（R2 lineage_v1/laws/{法令ID}/ から取ったもの。relink_hanrei.cjs pull）
#   書く: 同じファイル（足した版は chain に、書き換えの候補は reviews に足す）と out/monthly.json（法令ごとの足した版・合っているか）
#   e-Gov 法令 API の改正履歴を取り直し、chain の最後より後の版を施行日の順に当てる（build.py の「それより後」と同じ）。
#   名古屋大学のデータ（改め文）は使わないので Actions でも動く。旧法（作り直す前の法令）は変わらないので触らない。
#   書き換えの候補（reviews）が増えた法令は、この後 judge_rewrites.py で Jev に判定させてから tables.py を流す
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S                 # noqa: E402
from lib.engine import Lineage               # noqa: E402
from lib.xmlarts import main_articles        # noqa: E402
from build import _ann                       # noqa: E402


def extend(law_id):
    d = os.path.join(S.DATA, 'out', law_id)
    J = json.load(open(os.path.join(d, 'lineage.json'), encoding='utf-8'))
    rep = json.load(open(os.path.join(d, 'report.json'), encoding='utf-8'))
    if not J.get('asof'):
        return {'law_id': law_id, 'skip': '旧法（答え合わせの版が無い）は足さない'}
    lin = Lineage.from_json(J)
    chain = J.get('chain') or []
    done = {c['revision'] for c in chain}
    last = chain[-1]['date'] if chain else J['asof']
    revs = S.egov_revisions(law_id, refresh=True)
    later = sorted((r for r in revs if r.get('amendment_enforcement_date') and r['amendment_enforcement_date'] >= last
                    and r['law_revision_id'] not in done and r.get('current_revision_status') in ('PreviousEnforced', 'CurrentEnforced')),
                   key=lambda r: (r['amendment_enforcement_date'], r['law_revision_id']))
    # e-Gov の版だけで作った法令（政令など・egov_only）は chain が空のまま asof までの版を当ててあるので、asof より後の版だけ足す（2026-10-18）
    if J.get('egov_only') and not chain:
        later = [r for r in later if r['amendment_enforcement_date'] > last]
    # 前回の最後の版と同じ日の版で、前回より前の ID のもの（前回もう当てた日の殻など）は飛ばす
    if chain:
        later = [r for r in later if r['amendment_enforcement_date'] > last or r['law_revision_id'] > chain[-1]['revision']]
    reviews0 = len(lin.reviews)
    added, skipped = [], []
    for r in later:
        try:
            arts = main_articles([S.egov_xml_revision(r['law_revision_id'])])
        except Exception as e:
            skipped.append({'revision': r['law_revision_id'], 'why': f'{type(e).__name__} {getattr(e, "code", "")}'.strip()})
            continue
        if not arts:
            skipped.append({'revision': r['law_revision_id'], 'why': '条が 0 本（中身の無い版）'})
            continue
        act = {'law': _ann(r), 'date': r['amendment_enforcement_date']}
        lin.apply_version(arts, act)
        c = {'law': act['law'], 'date': act['date'], 'revision': r['law_revision_id']}
        chain.append(c)
        added.append(c)
    match = None
    if chain:
        lastv = {a['num'] for a in main_articles([S.egov_xml_revision(chain[-1]['revision'])])}
        match = sorted(lastv) == sorted(lin.state)
    out = {'law_id': law_id, 'title': rep.get('title'), 'added': len(added), 'skipped': skipped, 'new_reviews': len(lin.reviews) - reviews0,
           'match_last': match, 'last': chain[-1]['revision'] if chain else None}
    if added:
        J2 = merged_json(J, lin.to_json(), chain, added)
        json.dump(J2, open(os.path.join(d, 'lineage.json'), 'w', encoding='utf-8'), ensure_ascii=False)
        rep['chain'] = {**(rep.get('chain') or {}), 'revisions': len(chain), 'last': chain[-1]['revision'], 'match_last': match}
        rep['monthly'] = rep.get('monthly', []) + [{k: out[k] for k in ('added', 'new_reviews', 'match_last', 'last')}]
        json.dump(rep, open(os.path.join(d, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return out


def merged_json(J, lin_json, chain, added):
    """書き直す lineage.json: 前の J の欄（egov_only・amend_dates など Lineage が持たない欄）を残し、系譜・chain を今のものにする。
    e-Gov の版だけの法令は、足した版の施行日を amend_dates（判決の後の改正の回数の注記に使う）に足す（2026-10-18。前は欄が消えて
    政令の判例が unverified になった）"""
    J2 = {**J, **lin_json, 'asof': J['asof'], 'chain': chain, 'acts': J.get('acts', [])}
    if J.get('egov_only'):
        J2['amend_dates'] = sorted(set(J.get('amend_dates') or []) | {c['date'] for c in added if c.get('date')})
    return J2


def main(ids):
    ids = ids or sorted(x for x in os.listdir(os.path.join(S.DATA, 'out'))
                        if re.fullmatch(r'\d{3}[A-Z]{2}\d{10}', x) and os.path.exists(os.path.join(S.DATA, 'out', x, 'lineage.json')))
    res = []
    for lid in ids:
        try:
            r = extend(lid)
        except Exception as e:   # 1 つの法令の失敗で残りを止めない（失敗は報告に出し、その法令の表は前のまま）
            r = {'law_id': lid, 'error': f'{type(e).__name__}: {str(e)[:200]}'}
        res.append(r)
        print(json.dumps(r, ensure_ascii=False), flush=True)
    json.dump(res, open(os.path.join(S.DATA, 'out', 'monthly.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    bad = [r for r in res if r.get('error') or r.get('match_last') is False]
    if bad:
        print(f'最新の版と条の番号が合わない・失敗した法令が {len(bad)} 本（その法令の表は作り直さない）', flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
