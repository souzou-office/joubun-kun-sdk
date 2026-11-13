# 系譜の無い法令（政令・省令など）の引用を、e-Gov の版で「判断の日の第 N 条 → 今の第 N 条は同じ規定か」比べる（読むだけ）
#   python -I -X utf8 scripts/lineage/eval_asof.py [--judge]
#   対象: cases_refs.ndjson のうち、out/{法令ID}/lineage.json が無い法令で、判断の日が 2017-04-01 以後のもの
#     （e-Gov の版は 2017-04-01 より前を返さない。質疑応答事例はほぼ全部が「令和7年8月1日現在」なのでここで見られる）
#   決め方: 判断の日に施行されていた e-Gov の版と今の版の同じ番号の条を本文の近さで比べ、近ければ同じ。
#     近くなければ（--judge のとき）Jev で「同じ事柄を定めた規定か」を判定し、別なら今の版から本文の近い 3 条を Jev にかけて付け直し先を探す
#   Jev の判定は out/asof/jev_pairs.json に控えて呼び直さない（judge_rewrites.py と同じ問い・同じ入口・条文の本文だけを送る）
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S                    # noqa: E402
from lib.xmlarts import main_articles, sim      # noqa: E402
import judge_rewrites as JR                     # noqa: E402

SAME = 0.8      # 本文の近さがこれ以上なら Jev にかけず同じとする
TODAY = '2026-10-15'


def version_at(law_id, d):
    """d に施行されていた版の law_revision_id（施行済みの版のうち施行日が d 以前で一番新しいもの）"""
    best = None
    for r in S.egov_revisions(law_id):
        ed = r.get('amendment_enforcement_date') or ''
        if r.get('current_revision_status') == 'UnEnforced' or not ed or ed > d:
            continue
        if best is None or ed > best[0]:
            best = (ed, r['law_revision_id'])
    return best[1] if best else None


_arts = {}


def articles(rev):
    if rev not in _arts:
        p = S.egov_xml_revision(rev)
        _arts[rev] = {a['num']: a for a in main_articles([p])}
    return _arts[rev]


def pid(law_id, a_num, a_text, b_num, b_text):
    return hashlib.sha1(f'{law_id}|{a_num}|{b_num}|{a_text[:200]}|{b_text[:200]}'.encode('utf-8')).hexdigest()[:16]


def main():
    judge = '--judge' in sys.argv
    rows = [json.loads(l) for l in open(os.path.join(S.DATA, 'out', 'cases_refs.ndjson'), encoding='utf-8') if l.strip()]
    has_lineage = lambda lid: os.path.exists(os.path.join(S.DATA, 'out', lid, 'lineage.json'))   # noqa: E731
    j_dates = [r['date'] for r in rows if r['k'] == 'j' and r['date']]
    j_default = max(set(j_dates), key=j_dates.count)
    todo = []
    for r in rows:
        d = r['date'] or (j_default if r['k'] == 'j' else None)
        if not d or d < '2017-04-01' or has_lineage(r['law_id']):
            continue
        if any(o['before'] or o['how'] == 'old' for o in r['occ']):
            continue   # 改正前と書いた引用は版を特定しにくいので数えない（件数だけ出す）
        todo.append((r, d))
    cache_p = os.path.join(S.DATA, 'out', 'asof', 'jev_pairs.json')
    os.makedirs(os.path.dirname(cache_p), exist_ok=True)
    cache = json.load(open(cache_p, encoding='utf-8')) if os.path.exists(cache_p) else {}
    # 1) 版を引いて本文の近さで比べる
    pend, results = [], []
    for r, d in todo:
        lid, k = r['law_id'], str(r['art']).replace('の', '_')
        try:
            rv_then, rv_now = version_at(lid, d), version_at(lid, TODAY)
        except Exception as e:   # e-Gov に無い法令（告示・条約など）
            results.append((r, d, 'e-Gov の版が取れない', [], type(e).__name__))
            continue
        if not rv_then or not rv_now:
            results.append((r, d, 'e-Gov の版が取れない', [], ''))
            continue
        A, B = articles(rv_then), articles(rv_now)
        a = A.get(k)
        if not a:
            results.append((r, d, 'その日の版にその条が無い（読み取りの誤りなど）', [], rv_then))
            continue
        b = B.get(k)
        s = sim(a['text'], b['text']) if b else 0.0
        if b and s >= SAME:
            results.append((r, d, '変わらない（同じ番号の同じ規定）', [k], f'{s:.2f}'))
            continue
        # 2) 近くない: 同じ番号の条と、今の版で本文の近い 3 条を候補に
        cands = sorted(((sim(a['text'], x['text']), n) for n, x in B.items() if x['text']), reverse=True)[:3]
        cnums = [n for _, n in cands]
        if b and k not in cnums:
            cnums.append(k)
        pend.append((r, d, lid, k, a, [(n, B[n]) for n in cnums], s))
    # 3) Jev
    if judge:
        title = {lid: (S.ledger().get(lid) or {}).get('law_title', lid) for lid in {p[2] for p in pend}}
        items = []
        for r, d, lid, k, a, cs, s in pend:
            for n, b in cs:
                i = pid(lid, k, a['text'], n, b['text'])
                if i not in cache and i not in {x['id'] for x in items}:
                    items.append({'id': i, 'state': {
                        '旧条文': {'法令': title[lid], '条': k, '見出し': a.get('caption') or '', '本文': a['text'][:6000]},
                        '新条文': {'法令': title[lid], '条': n, '見出し': b.get('caption') or '', '本文': b['text'][:6000]}}})
        print(f'Jev にかける組: {len(items)}', flush=True)
        for i in range(0, len(items), JR.BATCH):
            res = JR.call(items[i:i + JR.BATCH])
            for x in res.get('results', []):
                v = ((x.get('answers') or {}).get('q') or {}).get('noul')
                if isinstance(v, (int, float)):
                    cache[x['id']] = v
            json.dump(cache, open(cache_p, 'w', encoding='utf-8'))
            time.sleep(0.5)
    for r, d, lid, k, a, cs, s in pend:
        sc = [(cache.get(pid(lid, k, a['text'], n, b['text'])), n) for n, b in cs]
        sc = [(v + (0.1 if n == k else 0), v, n) for v, n in sc if v is not None]
        if not sc:
            results.append((r, d, '本文が変わった（Jev 未判定）', [], f'{s:.2f}'))
            continue
        sc.sort(reverse=True)
        _, v, n = sc[0]
        if v < JR_YES:
            results.append((r, d, '今の条に同じ規定が無い（今の条から外す）', [], f'{s:.2f}'))
        elif n == k:
            results.append((r, d, '変わらない（同じ番号・本文は改正）', [k], f'{s:.2f}/{v:.2f}'))
        else:
            results.append((r, d, '別の番号の今の条に付け直す', [n], f'{s:.2f}/{v:.2f}'))
    counts = {}
    with open(os.path.join(S.DATA, 'out', 'eval_asof_details.ndjson'), 'w', encoding='utf-8') as f:
        for r, d, cat, now, note in results:
            kind = '裁決' if r['k'] == 's' else '事例'
            counts[f'{kind}|{cat}'] = counts.get(f'{kind}|{cat}', 0) + 1
            f.write(json.dumps({'kind': kind, 'id': r['id'], 'date': d, 'law_id': r['law_id'], 'art': r['art'], 'src': r['src'],
                                'cat': cat, 'now': now, 'note': note}, ensure_ascii=False) + '\n')
    json.dump({'counts': counts}, open(os.path.join(S.DATA, 'out', 'eval_asof.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    for k, v in sorted(counts.items(), key=lambda x: -x[1]):
        print(f'{v:6d}  {k}')


JR_YES = 0.5

if __name__ == '__main__':
    main()
