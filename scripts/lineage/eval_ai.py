# 判例の付け直しの正しさを、抜き取りと AI（Opus 5.5）の判定で測る（docs/lineage_eval.md を作る）
#   python -I -X utf8 scripts/lineage/eval_ai.py sample [--n 300] [--seed 20261015]   抜き取って判定の材料を作る（¥0・ネットに出ない）
#   python -I -X utf8 scripts/lineage/eval_ai.py estimate                            費用の目安（材料の文字数から）
#   CHAT_URL=… CHAT_KEY=… python -I -X utf8 scripts/lineage/eval_ai.py judge [--limit N]   AI に判定させる（/api/chat の model 'opus-5-5'・バイパスキー）
#   python -I -X utf8 scripts/lineage/eval_ai.py report                              割合と 95% の範囲・オーナーが見る 30 件の一覧（docs/lineage_eval.md）
#
# 材料（LINEAGE_DATA の下）: out/hanrei_v2/hanrei_v2/currefs_*.json（付け直し）・hanrei_cases/（判決文）・out/{法令ID}/lineage.json（条文）
# 抜き取りは層ごと（付け直した・そのまま・外した）。全体の割合は層の件数で重み付けする。判決文と公開の条文だけを送る（利用者の入力は無い）
import glob
import json
import math
import os
import random
import re
import sys
import time
import unicodedata
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S                 # noqa: E402
from lib.kansuji import int2kan              # noqa: E402
from lib.resolve import Resolver             # noqa: E402

OUT = os.path.join(S.DATA, 'out')
V2 = os.path.join(OUT, 'hanrei_v2', 'hanrei_v2')
P_SAMPLE = os.path.join(OUT, 'eval_ai_sample.json')
P_RESULT = os.path.join(OUT, 'eval_ai_result.json')
DOC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'lineage_eval.md')
STRATA = {'relinked': 170, 'same': 50, 'gone': 50, 'near': 30}   # 付け直した（行き先が元と違う）・そのまま・外した（別の規定）・判決の前後に改正（near の注記）
PRICE_IN, PRICE_OUT = 4.0, 20.0   # Opus 5.5 の $/100 万トークン

SYSTEM = ('あなたは日本の法令と判例に詳しい法律家です。判決文の中の条文の引用が、どの規定を指しているかを判定します。'
          '答えは指定された JSON だけで返します。')


def stratum(c):
    if any(n.get('k') == 'near' for n in c.get('notes') or []):
        return 'near'
    if c['how'] == 'gone':
        return 'gone'
    if c['how'] in ('same', 'nolineage', 'unverified') or (c.get('from') or {}).get('art') == c.get('art') and (c.get('from') or {}).get('lawId') == c.get('lawId'):
        return 'same'
    return 'relinked'


_lin = {}


def lineage(lid):
    if lid not in _lin:
        p = os.path.join(OUT, lid, 'lineage.json')
        _lin[lid] = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else None
    return _lin[lid]


def then_text(lid, art, ver):
    """判決のときのその番号の規定の本文（系譜の最後の形。番号が変わった・終わった規定は終わる直前）"""
    L = lineage(lid)
    if not L or not ver:
        return None
    k = art.replace('の', '_')
    pid = Resolver(L).pid_at(k, ver)
    if not pid:
        return None
    st = next((a for a in (L.get('state') or {}).values() if a.get('id') == pid), None)
    return (st or {}).get('text') or (L.get('last_text') or {}).get(pid)


def now_text(lid, art):
    L = lineage(lid)
    st = ((L or {}).get('state') or {}).get(art.replace('の', '_'))
    return st and st.get('text')


def art_patterns(art):
    n = art.split('の')
    kan = '第?' + int2kan(int(n[0])) + '条' + ''.join('の' + int2kan(int(x)) for x in n[1:])
    dig = '第?' + n[0] + '条' + ''.join('の' + x for x in n[1:])
    return [kan, dig]


def excerpt(rec, law, art, width=220):
    text = '\n'.join((s or {}).get('text', '') for s in (rec.get('sections') or [])) + '\n' + (rec.get('sanshoRaw') or '')
    text = unicodedata.normalize('NFKC', text)
    # 法令名つきで見つかったものだけ（「憲法二五条」の「五条」のような取り違えをしない）。条番号の前後に数字が続かないこと
    for pat in art_patterns(art):
        m = re.search(rf'(?:旧)?{re.escape(law)}[^。\n]{{0,30}}?(?<![0-9〇一二三四五六七八九十百千]){pat}(?![0-9〇一二三四五六七八九十])', text) if law else None
        if m:
            a, b = max(0, m.start() - width), min(len(text), m.end() + width)
            return text[a:b].replace('\n', ' ')
    return None


def load_cases():
    cases = {}
    for f in glob.glob(os.path.join(S.DATA, 'hanrei_cases', 'cases_*.json')):
        cases.update(json.load(open(f, encoding='utf-8')))
    return cases


def sample(n_total, seed):
    pools = {k: [] for k in STRATA}
    for f in sorted(glob.glob(os.path.join(V2, 'currefs_*.json'))):
        for cid, cs in json.load(open(f, encoding='utf-8')).items():
            for c in cs:
                if not (c.get('from') or {}).get('art'):
                    continue
                if c['how'] == 'nolineage':
                    continue
                pools[stratum(c)].append((cid, c))
    rnd = random.Random(seed)
    cases = load_cases()
    out = {'seed': seed, 'population': {k: len(v) for k, v in pools.items()}, 'items': []}
    scale = n_total / sum(STRATA.values())
    for k, want in STRATA.items():
        want = round(want * scale)
        got = 0
        cand = pools[k][:]
        rnd.shuffle(cand)
        for cid, c in cand:
            if got >= want:
                break
            rec = cases.get(cid)
            if not rec:
                continue
            f = c['from']
            cited = {r.get('lawId'): r.get('law') for r in (rec.get('lawRefs') or [])}
            law_name = cited.get(f['lawId']) or (lineage(f['lawId']) or {}).get('title') or S.title_of(f['lawId'])
            ex = excerpt(rec, law_name, f['art'])
            then = then_text(f['lawId'], f['art'], f.get('ver'))
            tgt_law = c.get('lawId') or (c.get('at') or [None])[0]
            tgt_art = c.get('art') or (c.get('at') or [None, None])[1]
            now = now_text(tgt_law, tgt_art) if tgt_law else None
            if not ex or not then or not now:
                continue
            out['items'].append({'stratum': k, 'case': cid, 'date': rec.get('dateIso'), 'court': rec.get('court'), 'caseNo': rec.get('caseNo'),
                                 'title': rec.get('title'), 'url': rec.get('url'), 'how': c['how'], 'conf': c.get('conf'), 'notes': c.get('notes') or [],
                                 'from': {**f, 'law': law_name}, 'to': {'lawId': tgt_law, 'art': tgt_art, 'law': S.title_of(tgt_law)},
                                 'excerpt': ex, 'then_text': then[:1500], 'now_text': now[:1500]})
            got += 1
    json.dump(out, open(P_SAMPLE, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps({'population': out['population'], 'sampled': {k: sum(1 for x in out['items'] if x['stratum'] == k) for k in STRATA}}, ensure_ascii=False))


def prompt(it):
    q = ('判決当時のこの番号の条（引用された規定）は、今の同じ番号の条とは別の事柄を定める規定か（今の同じ番号の条から外してよいか）。'
         if it['how'] == 'gone' else
         'この判決のこの引用（判決文の該当箇所で論じている規定）は、今の条（付け直し先）が定める事柄と同じ規定を指していると言えるか。'
         '条番号や法令名が変わっていても、判決が論じている事柄を今の条が定めていれば yes。判決文の該当箇所から判断できなければ unclear。')
    # 判決当時の本文は、系譜が終わった規定の終わる直前の本文しか持たない（今もある規定は今の形になる）ので、外した引用だけに付ける
    then = (f"# 引用された条（判決のとき）: {it['from']['law']} 第{it['from']['art']}条（この規定が差し替え・削除される直前の本文）\n{it['then_text']}\n\n"
            if it['how'] == 'gone' else f"# 引用された条: 判決文では {it['from']['law']} 第{it['from']['art']}条（{it['from'].get('ver')} の版）\n\n")
    return (f"# 判決\n{it['court'] or ''} {it['date']}（{it['caseNo'] or ''}）\n\n"
            f"# 判決文の該当箇所\n{it['excerpt']}\n\n" + then +
            f"# {'今の同じ番号の条' if it['how'] == 'gone' else '付け直し先の今の条'}: {it['to']['law']} 第{it['to']['art']}条\n{it['now_text']}\n\n"
            f"# 問い\n{q}\n\n"
            '次の JSON だけで答える: {"verdict": "yes" | "no" | "unclear", "reason": "根拠を 1〜2 文"}')


def estimate():
    s = json.load(open(P_SAMPLE, encoding='utf-8'))
    chars = sum(len(prompt(it)) + len(SYSTEM) for it in s['items'])
    tin = chars * 1.0   # 日本語はおよそ 1 文字 1 トークン（多めに見る）
    tout = len(s['items']) * 1300   # 考える分を含めた出力の目安（effort low）
    usd = tin / 1e6 * PRICE_IN + tout / 1e6 * PRICE_OUT
    print(json.dumps({'items': len(s['items']), 'input_tokens': round(tin), 'output_tokens': tout, 'usd': round(usd, 2), 'jpy_at_155': round(usd * 155)}, ensure_ascii=False))


def call(it):
    body = json.dumps({'model': 'opus-5-5', 'effort': 'low', 'maxTokens': 600, 'system': SYSTEM,
                       'messages': [{'role': 'user', 'content': prompt(it)}]}).encode('utf-8')
    req = urllib.request.Request(os.environ['CHAT_URL'].rstrip('/') + '/api/chat', data=body, method='POST',
                                 headers={'content-type': 'application/json', 'x-api-key': os.environ['CHAT_KEY'], 'user-agent': 'joubun-kun-lineage/1'})
    with urllib.request.urlopen(req, timeout=300) as r:
        j = json.loads(r.read())
    text = ''.join(b.get('text', '') for b in (j.get('content') or []) if b.get('type') == 'text')
    m = re.search(r'\{[\s\S]*\}', text)
    v = json.loads(m.group(0)) if m else {}
    u = j.get('usage') or {}
    return {'verdict': v.get('verdict'), 'reason': v.get('reason'), 'in': u.get('input_tokens', 0), 'out': u.get('output_tokens', 0)}


def judge(limit, workers=4):
    """判定（4 本ずつ並べて呼ぶ）。済んだものは控えから使い、呼び直さない"""
    from concurrent.futures import ThreadPoolExecutor
    s = json.load(open(P_SAMPLE, encoding='utf-8'))
    res = json.load(open(P_RESULT, encoding='utf-8')) if os.path.exists(P_RESULT) else {}
    keyof = lambda it: f"{it['case']}|{it['from']['lawId']}|{it['from']['art']}"
    todo = [it for it in s['items'] if keyof(it) not in res]
    if limit:
        todo = todo[:limit]

    def one(it):
        for attempt in range(3):
            try:
                return keyof(it), call(it)
            except Exception as e:
                print(f'失敗 {keyof(it)}: {type(e).__name__} {getattr(e, "code", "")}', flush=True)
                time.sleep(5 * (attempt + 1))
        return keyof(it), None

    n = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for k, r in ex.map(one, todo):
            if r is None:
                continue
            res[k] = r
            n += 1
            json.dump(res, open(P_RESULT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
            if n % 20 == 0:
                tin = sum(x['in'] for x in res.values()); tout = sum(x['out'] for x in res.values())
                print(f'{len(res)} 件・${tin / 1e6 * PRICE_IN + tout / 1e6 * PRICE_OUT:.2f}', flush=True)
    tin = sum(r['in'] for r in res.values()); tout = sum(r['out'] for r in res.values())
    print(json.dumps({'judged': len(res), 'input_tokens': tin, 'output_tokens': tout, 'usd': round(tin / 1e6 * PRICE_IN + tout / 1e6 * PRICE_OUT, 2)}))


def wilson(k, n, z=1.96):
    if not n:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(c - h, 3), round(c + h, 3))


if __name__ == '__main__':
    a = sys.argv[1:]
    cmd = a[0] if a else 'sample'
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    if cmd == 'sample':
        sample(int(opt('--n', 300)), int(opt('--seed', 20261015)))
    elif cmd == 'estimate':
        estimate()
    elif cmd == 'judge':
        judge(int(opt('--limit', 0)))


# ---------------------------------------------------------------- 報告（見えている残り・AI の判定・オーナーが見る 30 件）
def remainder():
    """付け直しの全件（currefs）から、自動で数えられる残りを数える"""
    tables = {}
    tdir = os.path.join(OUT, 'tables')
    for f in os.listdir(tdir):
        if f.endswith('.json') and f != 'index.json':
            t = json.load(open(os.path.join(tdir, f), encoding='utf-8'))
            tables[t['law_id']] = t
    c = {'all': 0, 'how': {}, 'notes': {}, 'low_conf': 0, 'ord_pre': 0, 'old_gone': 0, 'nolineage_ac': 0, 'nolineage_other': 0}
    for f in sorted(glob.glob(os.path.join(V2, 'currefs_*.json'))):
        for cs in json.load(open(f, encoding='utf-8')).values():
            for x in cs:
                c['all'] += 1
                c['how'][x['how']] = c['how'].get(x['how'], 0) + 1
                for n in x.get('notes') or []:
                    c['notes'][n['k']] = c['notes'].get(n['k'], 0) + 1
                if x['how'] in ('renum', 'old', 'moved', 'split') and x.get('conf') is not None and x['conf'] < 0.7:
                    c['low_conf'] += 1
                if x['how'] == 'gone' and (tables.get((x.get('from') or {}).get('lawId')) or {}).get('old_law'):
                    c['old_gone'] += 1
                if x['how'] == 'nolineage':
                    lid = x.get('lawId') or ''
                    if any(n['k'] == 'ord' for n in x.get('notes') or []) or ((tables.get(lid) or {}).get('egov_only')):
                        c['ord_pre'] += 1
                    elif lid == '321CONSTITUTION':
                        c['constitution'] = c.get('constitution', 0) + 1
                    elif re.match(r'^\d{3}AC', lid):
                        c['nolineage_ac'] += 1
                    else:
                        c['nolineage_other'] += 1
    return c


def parse_fix_lines():
    """判例の引用の読み取りの直し（#332）を R2 の判決文に当てた足し引き（parse_fix.cjs）"""
    p = os.path.join(OUT, 'parse_fix.json')
    if not os.path.exists(p):
        return []
    c = json.load(open(p, encoding='utf-8'))['counts']
    why = ' / '.join(f'{k} {v:,}' for k, v in c.get('removed_by_reason', {}).items())
    return ['### 読み取りの直し（#332）の足し引き', '',
            f"R2 にある判決文（セクションは 4,000 字で切れている）と参照法条に、直す前と今の読み取りを当てて比べた（`scripts/lineage/parse_fix.cjs`）。"
            f"判例 {c['cases']:,} 件のうち {c['changed']:,} 件で、**外す {c['removed']:,} 件**（{why}。同じ文で直す前は読めて今は読めないものだけ。切れた先にしか無い引用は残す）・"
            f"**足す {c['added']:,} 件**（〇 入りの条番号「七〇九条」など、今だけ読めるもの）・未解決の引用に移ったもの {c.get('unres_added', 0):,} 件（「有限会社法」など。旧法の名前で拾えるものは旧法の表に付く）。", '']


def report():
    s = json.load(open(P_SAMPLE, encoding='utf-8'))
    res = json.load(open(P_RESULT, encoding='utf-8')) if os.path.exists(P_RESULT) else {}
    rem = remainder()
    pct = lambda n: f"{n:,}（{n / rem['all'] * 100:.1f}%）"
    by = {}
    for it in s['items']:
        r = res.get(f"{it['case']}|{it['from']['lawId']}|{it['from']['art']}")
        if not r:
            continue
        b = by.setdefault(it['stratum'], {'yes': 0, 'no': 0, 'unclear': 0, 'n': 0})
        b[r.get('verdict') if r.get('verdict') in ('yes', 'no', 'unclear') else 'unclear'] += 1
        b['n'] += 1
    pop = s['population']
    tot_pop = sum(pop.values())
    weighted = sum(pop[k] * (by[k]['yes'] / by[k]['n']) for k in by if by[k]['n']) / sum(pop[k] for k in by if by[k]['n']) if by else None
    L = ['# 判例の付け直しの正しさ（条の系譜・測定）', '',
         f'作った日: {time.strftime("%Y-%m-%d")}。材料は `relink_hanrei.cjs build` の結果（hanrei_v2）。測り方は `scripts/lineage/eval_ai.py`。', '',
         '## 1. 見えている残り（自動で数えられるもの）', '',
         f"判例の引用（付け直しの単位）{rem['all']:,} 件のうち:", '',
         '| 残り | 件数（全体に対する割合） | 扱い |', '|---|---|---|',
         f"| 政令・省令で 2017 年より前の判決（e-Gov の版が無く系譜で引けない） | {pct(rem['ord_pre'])} | 今の同じ番号に付けたまま・「この判決の後、○回改正」の注記 |",
         f"| 旧法で受け皿の無い条 | {pct(rem['old_gone'])} | 今の条から外す（判例そのものは検索で出る） |",
         f"| 判決日より前にその条が無い（読み取りの誤りなど） | {pct(rem['how'].get('unverified', 0))} | 今の同じ番号に付けたまま |",
         f"| 付け直したが Jev の確からしさが 0.7 未満 | {pct(rem['low_conf'])} | 付け直す（AI の抜き取りで確かめる対象） |",
         f"| 系譜の無い法律（作れなかった・名古屋大学のデータに無い） | {pct(rem['nolineage_ac'])} | 今の同じ番号に付けたまま |",
         f"| 系譜の無いそのほか（省令・告示など） | {pct(rem['nolineage_other'])} | 今の同じ番号に付けたまま |",
         f"| （参考）日本国憲法（一度も改正されていないので付け直しは要らない） | {pct(rem.get('constitution', 0))} | そのまま（正しい） |", '',
         '付け直しの内訳（how）: ' + ' / '.join(f"{k} {v:,}" for k, v in sorted(rem['how'].items(), key=lambda x: -x[1])), '',
         '注記の種類ごとの件数（notes）: ' + ' / '.join(f"{k} {v:,}" for k, v in sorted(rem['notes'].items(), key=lambda x: -x[1])), '',
         *parse_fix_lines(),
         '## 2. 見えない残り（付け直したが行き先が誤っているもの）: 抜き取りと AI の判定', '',
         f"付け直しの全件から層ごとに無作為に抜き取り（seed {s['seed']}）、判決文の該当箇所・判決のときの条文・付け直し先の今の条文を並べて Opus 5.5 に判定させた。"
         '「付け直した」「そのまま」は「その条を指していると言えるか」、「外した」は「今の同じ番号の条とは別の規定か（外してよいか）」を問う。', '',
         '| 層 | 母数 | 判定した件数 | 正しい（yes） | 誤り（no） | 分からない | 正しい割合（95% の範囲） |', '|---|---|---|---|---|---|---|']
    for k in STRATA:
        b = by.get(k, {'yes': 0, 'no': 0, 'unclear': 0, 'n': 0})
        lo, hi = wilson(b['yes'], b['n'])
        L.append(f"| {dict(relinked='付け直した', same='そのまま', gone='外した', near='判決の前後に改正')[k]} | {pop.get(k, 0):,} | {b['n']} | {b['yes']} | {b['no']} | {b['unclear']} | "
                 f"{(b['yes'] / b['n'] * 100 if b['n'] else 0):.1f}%（{(lo or 0) * 100:.1f}〜{(hi or 0) * 100:.1f}%） |")
    if weighted is not None:
        L += ['', f"層の母数で重み付けした全体の正しい割合: **{weighted * 100:.1f}%**（「分からない」は正しくない側に数えた）。"]
    # 誤りの傾向: 付け直した・判決の前後に改正の層で、AI が yes でなかったもの
    bad = {}
    for it in s['items']:
        r = res.get(f"{it['case']}|{it['from']['lawId']}|{it['from']['art']}") or {}
        if it['stratum'] in ('relinked', 'near') and r.get('verdict') != 'yes':
            k = (it['stratum'], it['how'])
            bad.setdefault(k, []).append(f"{it['from']['law']}{it['from']['art']}条 → {'（外す）' if it['how'] == 'gone' else it['to']['law'] + it['to']['art'] + '条'}")
    if bad:
        L += ['', '### 誤り・分からないの傾向', '']
        for (st, how), xs in sorted(bad.items(), key=lambda x: -len(x[1])):
            from collections import Counter
            top = '・'.join(f'{k}（{v}）' if v > 1 else k for k, v in Counter(xs).most_common(6))
            L.append(f"- {dict(relinked='付け直した', near='判決の前後に改正')[st]}・{how}: {len(xs)} 件。例: {top}")
    tin = sum(r.get('in', 0) for r in res.values()); tout = sum(r.get('out', 0) for r in res.values())
    L += ['', f"AI の費用: 入力 {tin:,}・出力 {tout:,} トークン（約 ${tin / 1e6 * PRICE_IN + tout / 1e6 * PRICE_OUT:.2f}）。", '',
          '## 3. オーナーが目で確かめる 30 件', '',
          '層ごとに 10 件。「オーナー」の欄に ○（AI の判定に同意）・×（同意しない）を書くと、AI の判定がどれくらい信用できるかが分かる。', '',
          '| # | 層 | 判決 | 判決文の該当箇所（抜粋） | 付け直し前 → 後 | AI | AI の理由 | オーナー |', '|---|---|---|---|---|---|---|---|']
    i = 0
    for k in STRATA:
        for it in [x for x in s['items'] if x['stratum'] == k and f"{x['case']}|{x['from']['lawId']}|{x['from']['art']}" in res][:10]:
            i += 1
            r = res[f"{it['case']}|{it['from']['lawId']}|{it['from']['art']}"]
            ex = re.sub(r'\s+', ' ', it['excerpt'])[:140].replace('|', '｜')
            to = '（外す）' if k == 'gone' else f"{it['to']['law']}{it['to']['art']}条"
            L.append(f"| {i} | {dict(relinked='付け直した', same='そのまま', gone='外した', near='判決の前後に改正')[k]} | [{it['court'] or ''} {it['date']}]({it['url']}) | {ex} | "
                     f"{it['from']['law']}{it['from']['art']}条 → {to} | {r.get('verdict')} | {(r.get('reason') or '').replace('|', '｜')[:120]} | |")
    os.makedirs(os.path.dirname(DOC), exist_ok=True)
    open(DOC, 'w', encoding='utf-8').write('\n'.join(L) + '\n')
    print(f'→ {DOC}')


if __name__ == '__main__' and (sys.argv[1:2] == ['report']):
    report()
