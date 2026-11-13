# 裁決・質疑応答事例の条文リンクの付け直しの効き目（読むだけ）: eval_impact.py の判例と同じ決め方で
#   「判断が使った版の第 N 条 → 今の何条か」を引き、今の紐付け（同じ番号の今の条）と比べる
#   python -I -X utf8 scripts/lineage/eval_cases.py [cases_refs.ndjson]
#   入力: cases_refs.cjs の出力（既定 LINEAGE_DATA/out/cases_refs.ndjson）・out/{法令ID}/lineage.json（と jev_pairs.json）
#   版の決め方: 引用ごとに、明示の改正前（「（…法律第N号による改正前のもの）」・「以下同じ」で定めた法令・定めた略称）があれば
#     その改正の施行日の前日 → 無ければ判断の日（裁決日・事例の「○年○月○日現在」）。その日に条が無ければ直前にその条があった日
#   1 本のリンクに引用が何回もあるときは、どれか 1 回でも今の同じ番号の同じ規定に行き着けば「変わらない」
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S          # noqa: E402
from lib.identity import Identity     # noqa: E402
from lib.kansuji import kan2int       # noqa: E402
from lib.xmlarts import is_deleted, main_articles   # noqa: E402

ERA_W = {'明治': 1867, '大正': 1911, '昭和': 1925, '平成': 1988, '令和': 2018}


def day_before(d):
    return (datetime.date.fromisoformat(d) - datetime.timedelta(days=1)).isoformat()


def norm_act(s):
    """'平成23年12月2日法律第114号' / '平成二十三年法律第百十四号' → '平成23年法律第114号'"""
    s = re.sub(r'\d+月\d+日', '', s or '')
    m = re.match(r'(明治|大正|昭和|平成|令和)([0-9一二三四五六七八九十元]+)年法律第([0-9一二三四五六七八九十百千]+)号', s)
    if not m:
        return None
    y = 1 if m.group(2) == '元' else (int(m.group(2)) if m.group(2).isdigit() else kan2int(m.group(2)))
    n = int(m.group(3)) if m.group(3).isdigit() else kan2int(m.group(3))
    return f'{m.group(1)}{y}年法律第{n}号'


def act_dates(lid, I):
    """改正法 → 施行日（系譜の改正法の一覧 → e-Gov の改正履歴の順。段階施行は一番早い日）"""
    out = {}
    for a in I.L.get('acts', []):
        k = norm_act(a['law'])
        if k:
            out[k] = (a.get('enf') or {}).get('date') or a['promulgated']
    p = os.path.join(S.DATA, 'egov', 'revisions', f'{lid}.json')
    if os.path.exists(p):
        for r in json.load(open(p, encoding='utf-8')).get('revisions', []):
            k = norm_act(r.get('amendment_law_num') or '')
            d = r.get('amendment_enforcement_date')
            if k and d and (k not in out or d < out[k]):
                out.setdefault(k, d)
    return out


def caption_of(text):
    m = re.match(r'^（([^）]{1,60})）', text or '')
    return m.group(1) if m else ''


def cap_norm(c):
    return re.sub(r'[\s（）()「」、・等]', '', c or '')


def cap_same(a, b):
    """見出しが同じとみてよいか（字の 2 字の重なり・Dice 0.6 以上か、片方がもう片方を含む）"""
    a, b = cap_norm(a), cap_norm(b)
    if not a or not b:
        return False
    if a in b or b in a:
        return True
    A = {a[i:i + 2] for i in range(len(a) - 1)} or {a}
    B = {b[i:i + 2] for i in range(len(b) - 1)} or {b}
    return 2 * len(A & B) / (len(A) + len(B)) >= 0.6


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(S.DATA, 'out', 'cases_refs.ndjson')
    rows = [json.loads(l) for l in open(src, encoding='utf-8') if l.strip()]
    lids = sorted({r['law_id'] for r in rows})
    idn = {lid: Identity(lid, S.DATA) for lid in lids if os.path.exists(os.path.join(S.DATA, 'out', lid, 'lineage.json'))}
    acts = {lid: act_dates(lid, I) for lid, I in idn.items()}
    # 日付の無い裁決は同じ号の真ん中の日、事例は一番多い「現在」の日
    by_no = {}
    for r in rows:
        if r['k'] == 's' and r['date']:
            by_no.setdefault(r['id'].split('-')[0], []).append(r['date'])
    j_dates = [r['date'] for r in rows if r['k'] == 'j' and r['date']]
    j_default = max(set(j_dates), key=j_dates.count) if j_dates else None

    def date_of(r):
        if r['date']:
            return r['date']
        if r['k'] == 's':
            ds = sorted(by_no.get(r['id'].split('-')[0], []))
            return ds[len(ds) // 2] if ds else None
        return j_default

    def resolve_occ(I, lid, k, d, before):
        """→ (結果の区分, 今の条の一覧, 引いた日)"""
        for b in before:
            ad = acts[lid].get(b)
            if ad:
                d = min(d, day_before(ad))
                break
        else:
            if before:
                return ('明示の改正法が系譜に無い（今のまま残す）', [], d)
        res = I.resolve(k, d)
        if res['status'] == 'その日に無い条':
            prev = [dt for dt, n, _ in sum((I.tl[p] for p in I.by_num.get(k, ())), []) if n == k and dt <= d]
            if not prev:
                # 系譜の中でその番号が初めて出るのが e-Gov との答え合わせで置いた条なら、それより前は系譜が欠けている（改め文の読み漏れ）
                placed = any(e['op'].startswith('e-Gov に合わせた（置いた）') for p in I.by_num.get(k, ()) for e in I.lineage.get(p, [])[:1])
                if placed:
                    return ('判定できない（系譜が欠けている・今のまま残す）', [], d)
                return ('その日より前にその条が無い（読み取りの誤りなど・今のまま残す）', [], d)
            res = I.resolve(k, max(prev))
        now = res.get('now') or []
        if now == [k]:
            return ('変わらない（同じ番号の同じ規定）', now, d)
        if not now:
            return ('今の条に同じ規定が無い（今の条から外す）', now, d)
        if k in now:
            return ('分かれた（今の同じ番号の条＋ほかの条）', now, d)
        return ('別の番号の今の条に付け直す', now, d)

    # 今の条（e-Gov の最新の版。系譜の chain の最後）の見出しと本文
    cur = {}
    for lid, I in idn.items():
        ch = I.L.get('chain') or []
        try:
            xp = S.egov_xml_revision(ch[-1]['revision']) if ch else None
            cur[lid] = {a['num']: a for a in main_articles([xp])} if xp else {}
        except Exception:
            cur[lid] = {}

    def cap_now(lid, num):
        a = cur.get(lid, {}).get(str(num).replace('の', '_'))
        if a:
            return re.sub(r'^（|）$', '', a.get('caption') or '')
        I = idn.get(lid)
        p = I.final.get(str(num).replace('の', '_')) if I else None
        return caption_of(I.L['last_text'].get(p, '')) if p else ''

    def deleted_now(lid, num):
        a = cur.get(lid, {}).get(str(num).replace('の', '_'))
        return bool(a) and is_deleted(a['text'])

    counts, ex, per_law, details = {}, {}, {}, []
    capchk = {}
    finals = {}
    for r in rows:
        lid, k = r['law_id'], str(r['art']).replace('の', '_')
        kind = '裁決' if r['k'] == 's' else '事例'
        d = date_of(r)
        if lid not in idn:
            cat, now, how = '系譜なし（政令・省令・系譜を作っていない法令）', [], ''
        elif not d:
            cat, now, how = '日付なし', [], ''
        else:
            I = idn[lid]
            occ = r['occ'] or [{'before': [], 'how': 'current'}]
            results = []
            for o in occ:
                if o['how'] == 'shikorei':
                    results.append(('施行令・施行規則の条を法律の条と読んだ（今の条から外す）', [], d, o['how']))
                    continue
                if o['how'] == 'tailname':
                    results.append(('ほかの法令の名前の末尾を通称と読んだ（今の条から外す）', [], d, o['how']))
                    continue
                if o['how'] == 'old' and not o['before']:
                    results.append(('旧○○法・改正前（どの改正か書いていない・今のまま残す）', [], d, o['how']))
                    continue
                c, nw, dd = resolve_occ(I, lid, k, d, o['before'])
                results.append((c, nw, dd, o['how']))
            # 行き先が今「削除」の条なら、同じ規定は無い（削除の印で番号だけ残っている）
            results = [(('今の条に同じ規定が無い（今の条から外す）', [], x[2], x[3]) if x[1] and all(deleted_now(lid, n) for n in x[1]) else x)
                       for x in results]
            ok = [x for x in results if x[0].startswith('変わらない')]
            pick = ok[0] if ok else results[0]
            cat, now, how = pick[0], pick[1], pick[3]
        # 見出しでの答え合わせ（裁決の《見出し》＝判断のときの見出し）: 行き先の今の見出しと同じか
        cap_then = next((o.get('caption') for o in r['occ'] if o.get('caption')), '')
        same_now = cap_now(lid, r['art']) if lid in idn else ''
        tgt = [cap_now(lid, n) for n in (now or [])] if lid in idn else []
        if cap_then and lid in idn and d and not cat.startswith(('日付', '系譜')):
            if (now and not any(tgt)) or (not now and not same_now and not deleted_now(lid, r['art'])):
                verdict = '今の条に見出しが無い（比べられない）'   # 法人税法22条などは条ごとの見出しが無い（款の見出しで呼ばれる）
            elif now:
                verdict = '行き先の見出しと合う' if any(cap_same(cap_then, t) for t in tgt) else '行き先の見出しと合わない'
            else:
                verdict = '今の同じ番号の見出しと違う（外すのが合う）' if not cap_same(cap_then, same_now) else '今の同じ番号の見出しと同じ（外すのは誤りかも）'
            ck = (kind, cat, verdict)
            capchk[ck] = capchk.get(ck, 0) + 1
        else:
            verdict = ''
        key = (kind, cat)
        counts[key] = counts.get(key, 0) + 1
        pl = per_law.setdefault((kind, lid), {})
        pl[cat] = pl.get(cat, 0) + 1
        # 最後の決め方（本番に入れる形）: 系譜が付け直す・外すと言っても、判断の文の《見出し》が今の同じ番号の条の見出しと同じなら残す
        #   （改正で丸ごと書き換わっても、引いた人から見て同じ制度の条。外すと条文ページから消えてしまう）。読み取りの誤りは外す
        if cat.startswith('変わらない') or cat.startswith(('系譜', '日付')) or '今のまま残す' in cat:
            final = 'keep'
        elif how in ('shikorei', 'tailname'):
            final = 'remove'
        elif cap_then and same_now and cap_same(cap_then, same_now):
            final = 'keep'
        elif now:
            final = 'relink'
        else:
            final = 'remove'
        fc = (kind, final)
        finals[fc] = finals.get(fc, 0) + 1
        det = {'kind': kind, 'id': r['id'], 'date': d, 'law_id': lid, 'art': r['art'], 'src': r['src'], 'cat': cat, 'now': now, 'how': how,
               'hows': sorted({o['how'] for o in r['occ']}), 'final': final,
               'cap_then': cap_then, 'cap_same_now': same_now, 'cap_target_now': tgt, 'cap_check': verdict}
        details.append(det)
        ex.setdefault(key, det)
    out = {
        'links': len(rows),
        'counts': {f'{a}|{b}': n for (a, b), n in sorted(counts.items(), key=lambda x: (x[0][0], -x[1]))},
        'per_law': {f'{a}|{b}': v for (a, b), v in sorted(per_law.items(), key=lambda x: -sum(x[1].values()))},
        'examples': {f'{a}|{b}': v for (a, b), v in ex.items()},
        'final': {f'{a}|{b}': n for (a, b), n in sorted(finals.items())},
        'caption_check': {f'{a}|{b}|{c}': n for (a, b, c), n in sorted(capchk.items(), key=lambda x: (x[0][1], -x[1]))},
    }
    json.dump(out, open(os.path.join(S.DATA, 'out', 'eval_cases.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    with open(os.path.join(S.DATA, 'out', 'eval_cases_details.ndjson'), 'w', encoding='utf-8') as f:
        for d in details:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')
    for k, v in out['counts'].items():
        print(f'{v:6d}  {k}')
    print('-- 最後の決め方（keep 残す・relink 付け直す・remove 条文ページから外す）')
    for k, v in out['final'].items():
        print(f'{v:6d}  {k}')
    print('-- 見出しでの答え合わせ（判断のときの《見出し》がある引用）')
    for k, v in out['caption_check'].items():
        print(f'{v:6d}  {k}')


if __name__ == '__main__':
    main()
