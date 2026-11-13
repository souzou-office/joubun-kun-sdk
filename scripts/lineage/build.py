# 法令ごとに条の系譜を作り、e-Gov の一番古い版と答え合わせする（読むだけ・書くのは LINEAGE_DATA/out だけ）
#   python -I scripts/lineage/build.py 323AC0000000131 [ほかの法令 ID ...]
#   材料: 名古屋大学「法令XMLデータ」（CC BY 4.0）・日本法令索引の改正履歴・e-Gov 法令 API v2
import json
import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S                                    # noqa: E402
from lib.engine import Lineage                                  # noqa: E402
import re                                                        # noqa: E402
from lib.enforce import read_enforcement, read_exceptions       # noqa: E402
from lib.kansuji import ART, art_key, key_sort, lawnum_kanji, parse_egov_id   # noqa: E402
from lib.segments import segments, suppl_main                   # noqa: E402
from lib.xmlarts import is_deleted, main_articles, norm_amend, sim, walk_articles   # noqa: E402

LAWDB_END = '2017-12-31'   # 名古屋大学のデータは平成 29 年までの法律

# 1 つの法令が昔は 2 本だったもの（民法は前三編と後二編）
PARTS = {
    '129AC0000000089': [(1, 29, 89, '民法'), (1, 31, 9, '民法（第四編第五編）')],
}


def law_parts(law_id, title):
    if law_id in PARTS:
        return PARTS[law_id]
    era, year, _, num = parse_egov_id(law_id)
    return [(era, year, num, title)]


def collect_acts(parts):
    """日本法令索引の改正履歴から、名古屋大学のデータにある改正法（法律）を集める"""
    acts, missing, names = {}, [], set()
    for era, year, num, title in parts:
        ndl_id, info = S.ndl_find_law(f'{era}{year:02d}AC{num:010d}', title)
        if not ndl_id:
            missing.append({'part': title, 'why': '日本法令索引で見つからない'})
            continue
        names.add(info.get('subject') or title)
        sname = info.get('sname') or ''
        for nm in sname.replace('［', '').replace('］', '').replace('旧名称：', '').split('、'):
            if nm.strip():
                names.add(nm.strip())
        for h in S.ndl_history(ndl_id):
            a = S.parse_announcement(h.get('announcement_disp'))
            if not a or a['kind'] != '法律' or a['date'] > LAWDB_END:
                continue
            key = (a['era'], a['year'], a['num'])
            paths = S.lawdb_paths(*key)
            if not paths:
                missing.append({'act': h.get('announcement_disp'), 'why': '名古屋大学のデータに無い'})
                continue
            acts.setdefault(key, {'law': h['announcement_disp'], 'promulgated': a['date'], 'paths': paths,
                                  'note': h.get('recognize_sentence'), 'aspect': h.get('recognize_aspect')})
    return acts, missing, names


def egov_stages(law_id):
    """e-Gov の改正履歴: 改正法の番号（漢字） → 施行日の一覧（段ごと）・一番古い版の施行日"""
    revs = S.egov_revisions(law_id)
    st = {}
    for r in revs:
        n, d = r.get('amendment_law_num'), r.get('amendment_enforcement_date')
        if n and d:
            st.setdefault(n, set()).add(d)
    dated = sorted((r['amendment_enforcement_date'], r['law_revision_id']) for r in revs if r.get('amendment_enforcement_date'))
    return {k: sorted(v) for k, v in st.items()}, (dated[0] if dated else (None, None)), revs


def build(law_id, title=None, end=None):
    """title・end は e-Gov に無い旧法（「123AC0000000029:民事訴訟法:1997-12-31」）用。end までの改正だけ当て、答え合わせはしない"""
    led = S.ledger().get(law_id)
    title = title or (led['law_title'] if led else law_id)
    pe = parse_egov_id(law_id)
    if pe and pe[2] != 'AC' and not end:   # 名古屋大学のデータは法律だけ（同じ年・番号の法律と取り違えない）
        return build_egov_only(law_id, title)
    parts = law_parts(law_id, title)
    out_dir = os.path.join(S.DATA, 'out', law_id)
    os.makedirs(out_dir, exist_ok=True)

    # 原始の条文
    orig_paths = []
    for era, year, num, _ in parts:
        orig_paths += S.lawdb_paths(era, year, num)
    if not orig_paths:
        if not end:   # 政令・省令・勅令など名古屋大学のデータに無い法令は、e-Gov の一番古い版から始める（2017 年より前は引けない）
            return build_egov_only(law_id, title)
        return {'law_id': law_id, 'title': title, 'error': '原始の条文が名古屋大学のデータに無い'}
    original = main_articles(orig_paths)
    first = S.parse_announcement(None)
    era, year, _, num = parse_egov_id(law_id)

    acts, missing, names = collect_acts(parts)
    names.add(title)
    lawnums = [lawnum_kanji(e, y, n) for e, y, n, _ in parts]
    if end:
        stages, (earliest, earliest_rev), revs = {}, (None, None), []
    else:
        stages, (earliest, earliest_rev), revs = egov_stages(law_id)
        earliest, earliest_rev = first_nonempty(revs) or (earliest, earliest_rev)

    plan = []
    for key, a in acts.items():
        segs = segments(a['paths'], names, lawnums)
        sup = suppl_main(a['paths'])
        enf = read_enforcement(sup, a['promulgated'])
        enf['from_text'] = {k: enf[k] for k in ('date', 'hi', 'how')}   # 附則から読んだ分（e-Gov と比べる用）
        # ただし書で別の日にした規定のうち、この法令を直した部分の全体（改正法の「第二十七条の規定」か「第一条中所得税法の改正規定」）。
        #   「第一条中所得税法第百五十一条の二の改正規定」のような一部だけの例外は当てない（当てると所得税法の改正全体が
        #   その日にずれる。平成28年法律第15号で第百五十一条の三などが2019年まで出てこなかった）。一部の日のずれは残る
        exc = read_exceptions(sup, a['promulgated'])
        kan = lawnum_kanji(*key)
        # 「政令で定める日」のただし書は、e-Gov の改正履歴の段の施行日を順に当てる（本体の日＝最後の段と、日付の分かるただし書の日は除く）
        st0 = stages.get(kan) or []
        if st0:
            free = [d for d in st0[:-1] if d not in {e['date'] for e in exc if e.get('date')}]
            for e in exc:
                if not e.get('date') and free:
                    e['date'] = free.pop(0)
                    e['how'] = f"{e['how']}（e-Gov の段）"
        nm_rx = '|'.join(re.escape(n) for n in sorted(names, key=len, reverse=True))
        for sg in segs:
            hit = None
            for e in exc:
                h = e['head']
                # 「第一条の規定」「第一条（前号に掲げる改正規定を除く。）」は条の全体（一部の例外は split_partial が後から改め文ごとに当てる）
                whole_art = sg.get('act_article') and re.search(re.escape(sg['act_article']) + r'(?:の規定|並びに|及び|、|$|[（(][^）)]*除く。?[）)])', h)
                whole_law = nm_rx and re.search(rf'(?<![一-鿿])(?:{nm_rx})(?:[（(][^）)]*[）)])?の(?:一部)?改正規定', h)
                if whole_art or whole_law:
                    hit = e
            if hit:
                sg['enf'] = {'date': hit['date'], 'hi': hit['hi'], 'how': 'ただし書: ' + str(hit['how'])}
        segs = split_partial(segs, exc, nm_rx)
        if kan in stages:
            st = stages[kan]
            enf['stages'] = st
            # 附則から読んだ本体の日が e-Gov の段にあればそれ、無ければ e-Gov の最後の段（本体は遅い段が多い）
            if enf['date'] not in st:
                enf.update(date=st[-1] if len(st) > 1 else st[0], how='e-Gov の改正履歴')
            enf['hi'] = enf['hi'] or st[-1]
            for sg in segs:
                if sg.get('enf') and sg['enf']['date'] not in st and sg['enf']['date'] is not None:
                    sg['enf']['note'] = 'e-Gov の段に無い日'
        # 出来事の日付は施行日（分からなければ公布日を仮に置き、幅は enf に残す）
        apply_date = enf['date'] or a['promulgated']
        for sg in segs:
            sg['date'] = (sg.get('enf') or {}).get('date') or apply_date
        plan.append({**a, 'key': key, 'segs': segs, 'enf': enf, 'apply': apply_date})
    # 当てる順は公布の順（改め文は、先に公布された改正を当てた後の文を前提に書かれる）
    plan.sort(key=lambda p: (p['promulgated'], p['key']))

    # 答え合わせの時点: e-Gov の一番古い版（それより後は e-Gov の版でつなぐ）
    asof = earliest
    # 制定の日（日本法令索引の公布日。読めなければ法令 ID の年の 1 月 1 日）
    era0, year0, num0, title0 = parts[0]
    _, info0 = S.ndl_find_law(f'{era0}{year0:02d}AC{num0:010d}', title0)
    a0 = S.parse_announcement(((info0 or {}).get('announcement') or '').strip('（）'))
    orig_date = a0['date'] if a0 else f'{S.ERA_BASE[era0] + year0}-01-01'
    lin = Lineage(original, orig_date)
    applied, partial_acts, no_seg = [], [], []
    if end:
        plan = [p for p in plan if p['promulgated'] <= end]
    for p in plan:
        segs = [sg for sg in p['segs'] if not asof or sg['date'] <= asof]
        if asof and not segs and p['apply'] > asof:
            continue
        act = {'law': p['law'], 'date': p['apply']}
        if not p['segs']:
            no_seg.append({'law': p['law'], 'note': p['note']})
            continue
        if not segs:
            continue
        lin.apply_act(act, segs)
        applied.append(p['law'])
        st = p['enf'].get('stages') or []
        if asof and st and st[0] <= asof < st[-1]:
            partial_acts.append(p['law'])

    report = {'law_id': law_id, 'title': title, 'asof': asof, 'acts_total': len(plan), 'acts_applied': len(applied),
              'acts_without_segment': no_seg, 'missing': missing, 'partial_at_asof': partial_acts,
              'stats': lin.stats, 'unparsed': len(lin.unparsed), 'reviews': len(lin.reviews),
              'enforcement_how': _count(p['enf']['how'] for p in plan)}

    if asof:
        xml = S.egov_xml_revision(earliest_rev)   # asof= は 2017-04-01 より前を返さないので、改正履歴の ID で取る
        eg = {a['num']: a for a in main_articles([xml])}
        ours = lin.state
        touched = set()
        for pid, evs in lin.lineage.items():
            for e in evs:
                if e.get('law') in partial_acts:
                    touched.add(e.get('num'))
        both = sorted(set(eg) & set(ours), key=key_sort)
        def s_of(n):
            a, b = ours[n]['text'], eg[n]['text']
            if is_deleted(a) or is_deleted(b):
                return 1.0 if is_deleted(a) and is_deleted(b) else 0.0
            return sim(a, b)
        sims = {n: s_of(n) for n in both}
        scored = [n for n in both if n not in touched]
        # 段階施行の途中の改正法が触った条は、番号の有無も数えない（別に数える）
        oe = set(eg) - set(ours)
        oo = set(ours) - set(eg)
        report.update({
            'egov_articles': len(eg), 'our_articles': len(ours), 'both': len(both),
            'only_egov': sorted(oe - touched, key=key_sort), 'only_ours': sorted(oo - touched, key=key_sort),
            'only_partial': sorted((oe | oo) & touched, key=key_sort),
            'excluded_partial': len(touched & set(both)),
            'avg_sim': round(sum(sims[n] for n in scored) / len(scored), 4) if scored else None,
            'low_sim': sorted(((n, round(sims[n], 2)) for n in scored if sims[n] < 0.8), key=lambda x: x[1])[:40],
            'low_sim_count': sum(1 for n in scored if sims[n] < 0.8),
        })
    # 答え合わせで食い違った条は e-Gov に合わせる（直した条は report の reconciled に残す）
    if asof:
        report['reconciled'] = lin.reconcile(main_articles([S.egov_xml_revision(earliest_rev)]), asof)
    # 一番古い版より後は、e-Gov の版を施行日の順に比べてつなぐ（2018 年以降の改正法の改め文は手元に無いため）
    chain = []
    if asof:
        later = sorted((r for r in revs if r.get('amendment_enforcement_date') and r['amendment_enforcement_date'] > asof
                        and r.get('current_revision_status') in ('PreviousEnforced', 'CurrentEnforced')),
                       key=lambda r: (r['amendment_enforcement_date'], r['law_revision_id']))
        skipped = []
        for r in later:
            try:
                xml = S.egov_xml_revision(r['law_revision_id'])
            except Exception as e:   # e-Gov が版を返さない（404 など）。飛ばして次の版との差分でつなぐ
                skipped.append({'revision': r['law_revision_id'], 'why': f'{type(e).__name__} {getattr(e, "code", "")}'.strip()})
                continue
            arts = main_articles([xml])
            if not arts:   # e-Gov は同じ日の版の一部を中身の無い殻で返す（地方税法）。当てると全部の条が消えるので飛ばす
                skipped.append({'revision': r['law_revision_id'], 'why': '条が 0 本（中身の無い版）'})
                continue
            act = {'law': _ann(r), 'date': r['amendment_enforcement_date']}
            lin.apply_version(arts, act)
            chain.append({'law': act['law'], 'date': act['date'], 'revision': r['law_revision_id']})
        report['chain_skipped'] = skipped
        got = [c['revision'] for c in chain]
        if got:
            last = {a['num']: a for a in main_articles([S.egov_xml_revision(got[-1])])}
            report['chain'] = {'revisions': len(chain), 'skipped': len(skipped), 'last': got[-1],
                               'match_last': sorted(set(last)) == sorted(set(lin.state))}
    with open(os.path.join(out_dir, 'report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out_dir, 'lineage.json'), 'w', encoding='utf-8') as f:
        json.dump({**lin.to_json(), 'asof': asof, 'chain': chain, 'acts': [{'law': p['law'], 'promulgated': p['promulgated'], 'enf': p['enf'],
                                                             'seg_enf': [sg.get('enf') for sg in p['segs'] if sg.get('enf')]} for p in plan]}, f, ensure_ascii=False)
    with open(os.path.join(out_dir, 'unparsed.json'), 'w', encoding='utf-8') as f:
        json.dump(lin.unparsed, f, ensure_ascii=False, indent=1)
    return report


def split_partial(segs, exc, nm_rx):
    """ただし書の「第一条中刑事訴訟法第二百九十九条の三の次に四条を加える改正規定」のような一部だけの例外を、名指しされた条から
    始まる改め文だけに当てる。日の違う改め文が続くところで段を分ける（順は変えない。後の日の段は答え合わせの日より後なら当てない）"""
    if not nm_rx or not exc:
        return segs
    out = []
    for sg in segs:
        aa = sg.get('act_article')
        if not aa:
            out.append(sg)
            continue
        dated = [None] * len(sg['amends'])
        for e in exc:
            m = re.search(re.escape(aa) + rf'(?:中|[（(])(?:{nm_rx})', e['head'])
            if not m:
                continue
            keys = {art_key(x) for x in re.findall(ART, norm_amend(e['head'][m.end():]))}
            for i, am in enumerate(sg['amends']):
                f = re.search(ART, norm_amend(am['sentence']))
                if f and art_key(f.group(0)) in keys:
                    dated[i] = e
        if not any(dated):
            out.append(sg)
            continue
        base = sg.get('enf')
        run, cur = [], object()
        for am, e in zip(sg['amends'], dated):
            if e is not cur and run:
                out.append({**sg, 'amends': run, 'enf': {'date': cur['date'], 'hi': cur['hi'], 'how': 'ただし書（一部）: ' + str(cur['how'])} if cur else base})
                run = []
            cur = e
            run.append(am)
        out.append({**sg, 'amends': run, 'enf': {'date': cur['date'], 'hi': cur['hi'], 'how': 'ただし書（一部）: ' + str(cur['how'])} if cur else base})
    return out


def build_egov_only(law_id, title):
    """名古屋大学のデータに無い法令（政令・省令・勅令）: e-Gov の一番古い版を出発点にして、その後の版を施行日の順につなぐ。
    それより前（多くは 2017 年より前）の判決の引用は系譜で引けないので、日本法令索引の改正の履歴から「その後の改正の回数」を
    注記に使う（amend_dates: 改正法の公布日の一覧）"""
    out_dir = os.path.join(S.DATA, 'out', law_id)
    os.makedirs(out_dir, exist_ok=True)
    stages, _, revs = egov_stages(law_id)
    first = first_nonempty(revs)
    if not first:
        return {'law_id': law_id, 'title': title, 'error': 'e-Gov の版が取れない'}
    since, rid = first
    lin = Lineage(main_articles([S.egov_xml_revision(rid)]), since, label='e-Gov の一番古い版')
    later = sorted((r for r in revs if r.get('amendment_enforcement_date') and r['amendment_enforcement_date'] >= since and r['law_revision_id'] != rid
                    and r.get('current_revision_status') in ('PreviousEnforced', 'CurrentEnforced')),
                   key=lambda r: (r['amendment_enforcement_date'], r['law_revision_id']))
    later = [r for r in later if r['amendment_enforcement_date'] > since or r['law_revision_id'] > rid]
    chain, skipped = [], []
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
        chain.append({'law': act['law'], 'date': act['date'], 'revision': r['law_revision_id']})
    last_rev = chain[-1]['revision'] if chain else rid
    match = sorted({a['num'] for a in main_articles([S.egov_xml_revision(last_rev)])}) == sorted(lin.state)
    # 日本法令索引の改正の履歴（公布日）。e-Gov の一番古い版より前の判決に「その後○回改正」と出すため
    amend = []
    era, year, kind, num = parse_egov_id(law_id)
    ndl_id, _ = S.ndl_find_law(law_id, title)
    if ndl_id:
        for h in S.ndl_history(ndl_id):
            a = S.parse_announcement(h.get('announcement_disp'))
            if a and (h.get('recognize_aspect') or '') in ('改正', '全部改正'):
                amend.append(a['date'])
    report = {'law_id': law_id, 'title': title, 'egov_only': True, 'asof': since, 'acts_total': len(later), 'acts_applied': len(chain),
              'egov_articles': len(lin.state), 'our_articles': len(lin.state), 'both': len(lin.state),
              'chain': {'revisions': len(chain), 'skipped': len(skipped), 'last': last_rev, 'match_last': match}, 'chain_skipped': skipped,
              'ndl': bool(ndl_id), 'amend_dates': sorted(amend)}
    json.dump(report, open(os.path.join(out_dir, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump({**lin.to_json(), 'asof': since, 'egov_only': True, 'chain': chain, 'acts': [], 'amend_dates': sorted(amend)},
              open(os.path.join(out_dir, 'lineage.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    return report


def first_nonempty(revs):
    """一番古い施行日の版のうち、条の入っているもの（同じ日の版は後の方から）。無ければ次の日へ"""
    dated = sorted(((r['amendment_enforcement_date'], r['law_revision_id']) for r in revs
                    if r.get('amendment_enforcement_date') and r.get('current_revision_status') in ('PreviousEnforced', 'CurrentEnforced')),
                   key=lambda x: (x[0], x[1]))
    days = sorted({d for d, _ in dated})
    for d in days[:5]:
        for _, rid in sorted((x for x in dated if x[0] == d), key=lambda x: x[1], reverse=True):
            try:
                if main_articles([S.egov_xml_revision(rid)]):
                    return d, rid
            except Exception:
                continue
    return None


def _ann(r):
    """e-Gov の改正履歴 → 「令和5年5月17日法律第28号」の形（日本法令索引の書き方にそろえる）"""
    from lib.kansuji import kan2int
    import re as _re
    n = r.get('amendment_law_num') or ''
    m = _re.match(r'(明治|大正|昭和|平成|令和)(元|[〇一二三四五六七八九十]+)年法律第([〇一二三四五六七八九十百千]+)号', n)
    d = r.get('amendment_promulgate_date') or ''
    if not m or not d:
        return n or r.get('law_revision_id')
    y = 1 if m.group(2) == '元' else kan2int(m.group(2))
    return f'{m.group(1)}{y}年{int(d[5:7])}月{int(d[8:10])}日法律第{kan2int(m.group(3))}号'


def _count(it):
    c = {}
    for x in it:
        c[x] = c.get(x, 0) + 1
    return c


if __name__ == '__main__':
    res = []
    for spec in sys.argv[1:]:
        lid, _, rest = spec.partition(':')
        t, _, e = rest.partition(':')
        try:
            r = build(lid, t or None, e or None)
        except Exception as ex:   # 1 つの法令の失敗で残りを止めない
            r = {'law_id': lid, 'title': t or None, 'error': f'{type(ex).__name__}: {str(ex)[:200]}'}
        brief = {k: r.get(k) for k in ('law_id', 'title', 'asof', 'acts_total', 'acts_applied', 'unparsed', 'egov_articles', 'our_articles',
                                       'both', 'excluded_partial', 'avg_sim', 'low_sim_count', 'error')}
        brief['only_egov'] = len(r.get('only_egov') or [])
        brief['only_ours'] = len(r.get('only_ours') or [])
        brief['no_seg'] = len(r.get('acts_without_segment') or [])
        brief['missing'] = len(r.get('missing') or [])
        res.append(brief)
        print(json.dumps(brief, ensure_ascii=False), flush=True)
