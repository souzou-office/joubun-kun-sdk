# 法令ごと作り直したもの・ほかの法令に移った規定の付け直し（旧法の条 → 新しい法令の条）
#   python -I -X utf8 scripts/lineage/relink.py [--judge] [旧法ID ...]
#   旧法の系譜（out/{旧法}/lineage.json）で「終わった規定」と「旧法の最後まで残った規定」を取り、受け皿の法令の
#   制定時の条文（名古屋大学の XML）から本文の近い順に 5 条を候補にする。--judge で Jev に「同じ事柄を定めた規定か」を聞く
#   （JEV_URL・JEV_KEY。条文の本文だけを送る）。結果は out/relink/{旧法}.json
import hashlib
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S                    # noqa: E402
from lib.kansuji import parse_egov_id           # noqa: E402
from lib.xmlarts import is_deleted, main_articles, sim   # noqa: E402

# 旧法 → 受け皿（法令 ID・その法令が効き始めた日）と、旧法の規定がいつ終わったものを候補にするかの幅（日）
#   end: 旧法が効いていた最後の日（法令そのものを作り直したもの）。None は同じ法令の中の規定がほかの法令に移ったもの
#   current: 判決文で今の法令と同じ名前で引かれる旧法（判決日が今の法令より前なら旧法の表で引く。tables.py の old）
#   name: 条文ページの「旧○○法△条として引用」の○○法。names: 判決文で旧法を指す名前（今の法令の名前と違うもの。未解決の引用から拾う）
CONFIG = [
    {'old': '123AC0000000029', 'title': '旧民事訴訟法（明治23年法律第29号）', 'name': '民事訴訟法', 'end': '1997-12-31',
     'current': '408AC0000000109', 'names': ['旧民訴法', '旧民事訴訟法'],
     'succ': [('408AC0000000109', '1998-01-01', '民事訴訟法'), ('354AC0000000004', '1980-10-01', '民事執行法'),
              ('401AC0000000091', '1991-01-01', '民事保全法')]},
    {'old': '132AC0000000048', 'title': '商法（会社の規定）', 'name': '商法', 'end': None,
     'succ': [('417AC0000000086', '2006-05-01', '会社法')]},
    {'old': '129AC0000000089', 'title': '民法（法人の規定）', 'name': '民法', 'end': None,
     'succ': [('418AC0000000048', '2008-12-01', '一般社団法人及び一般財団法人に関する法律')]},
    {'old': '309AC0000000014', 'title': '旧不正競争防止法（昭和9年法律第14号）', 'name': '不正競争防止法', 'end': '1994-04-30',
     'current': '405AC0000000047', 'names': ['旧不正競争防止法', '旧不競法'],
     'succ': [('405AC0000000047', '1994-05-01', '不正競争防止法')]},
    {'old': '211AC0000000071', 'title': '旧破産法（大正11年法律第71号）', 'name': '破産法', 'end': '2004-12-31',
     'current': '416AC0000000075', 'names': ['旧破産法'],
     'succ': [('416AC0000000075', '2005-01-01', '破産法')]},
    {'old': '132AC0000000024', 'title': '旧不動産登記法（明治32年法律第24号）', 'name': '不動産登記法', 'end': '2005-03-06',
     'current': '416AC0000000123', 'names': ['旧不動産登記法', '旧不登法'],
     'succ': [('416AC0000000123', '2005-03-07', '不動産登記法')]},
    {'old': '337AC0000000160', 'title': '旧行政不服審査法（昭和37年法律第160号）', 'name': '行政不服審査法', 'end': '2016-03-31',
     'current': '426AC0000000068', 'names': ['旧行政不服審査法', '旧行審法'],
     'succ': [('426AC0000000068', '2016-04-01', '行政不服審査法')]},
    {'old': '211AC0000000075', 'title': '旧刑事訴訟法（大正11年法律第75号）', 'name': '刑事訴訟法', 'end': '1948-12-31',
     'current': '323AC0000000131', 'names': ['旧刑訴法', '旧刑事訴訟法'],
     'succ': [('323AC0000000131', '1949-01-01', '刑事訴訟法')]},
    {'old': '313AC0000000074', 'title': '有限会社法（昭和13年法律第74号）', 'name': '有限会社法', 'end': '2006-04-30',
     'current': None, 'names': ['有限会社法', '旧有限会社法'],
     'succ': [('417AC0000000086', '2006-05-01', '会社法')]},
    {'old': '210AC0000000049', 'title': '借地法（大正10年法律第49号）', 'name': '借地法', 'end': '1992-07-31',
     'current': None, 'names': ['借地法', '旧借地法'],
     'succ': [('403AC0000000090', '1992-08-01', '借地借家法')]},
    {'old': '210AC0000000050', 'title': '借家法（大正10年法律第50号）', 'name': '借家法', 'end': '1992-07-31',
     'current': None, 'names': ['借家法', '旧借家法'],
     'succ': [('403AC0000000090', '1992-08-01', '借地借家法')]},
    {'old': '322AC0000000152', 'title': '家事審判法（昭和22年法律第152号）', 'name': '家事審判法', 'end': '2012-12-31',
     'current': None, 'names': ['家事審判法', '旧家事審判法'],
     'succ': [('423AC0000000052', '2013-01-01', '家事事件手続法')]},
    {'old': '131AC0000000013', 'title': '人事訴訟手続法（明治31年法律第13号）', 'name': '人事訴訟手続法', 'end': '2004-03-31',
     'current': None, 'names': ['人事訴訟手続法', '旧人事訴訟手続法'],
     'succ': [('415AC0000000109', '2004-04-01', '人事訴訟法')]},
]
# 自動で拾った旧法の組（auto_old.py の出力）を足す。手で書いた CONFIG にある旧法は足さない
def _auto_config():
    p = os.path.join(S.DATA, 'out', 'relink_auto.json')
    if not os.path.exists(p):
        return []
    manual = {c['old'] for c in MANUAL_CONFIG}
    return [{**c, 'succ': [tuple(x) for x in c['succ']]} for c in json.load(open(p, encoding='utf-8'))['config'] if c['old'] not in manual]


MANUAL_CONFIG = CONFIG
CONFIG = MANUAL_CONFIG + _auto_config()
WINDOW = 1000   # 施行日が「政令で定める日」で分からない改正は公布日で置いているので、幅を広めにとる（候補は受け皿の法令に限る）
TOP = 8
SPLIT_MIN = 0.85
SPLIT_GAP = 0.1
MAX_ITEMS = int(os.environ.get('MAX_ITEMS', '4000'))   # 1 回の実行で Jev に聞く組の上限（本番と共用の 1 日の上限 JEV_DAILY_USD があるため）
QUESTION = {'q': {
    'type': 'noul',
    'instructions': '旧法の条文と新しい法令の条文は、同じ事柄（同じ制度・同じ権利義務・同じ手続）を定めた規定か。法令や条番号が変わっても、'
                    '文言・要件・効果が改められていても、同じ事柄を定めていれば同じとする。関連するだけの別の事柄なら別とする。',
    'criteria': {'true': '同じ事柄を定めた規定', 'false': '別の事柄を定めた規定'},
}}


def days(a, b):
    import datetime
    return abs((datetime.date.fromisoformat(a) - datetime.date.fromisoformat(b)).days)


def succ_articles(law_id):
    era, year, _, num = parse_egov_id(law_id)
    return [a for a in main_articles(S.lawdb_paths(era, year, num)) if not is_deleted(a['text'])]


def old_provisions(cfg):
    """旧法の系譜から、受け皿の効き始めの日の近くで終わった規定と、旧法の最後まで残った規定を取る"""
    L = json.load(open(os.path.join(S.DATA, 'out', cfg['old'], 'lineage.json'), encoding='utf-8'))
    last = L.get('last_text') or {}
    out = []
    for pid, evs in L['lineage'].items():
        nums = [e['num'] for e in evs if e.get('num')]
        if not nums:
            continue
        text = last.get(pid, '')
        if not text or is_deleted(text):
            continue
        end_ev = next((e for e in reversed(evs) if e['op'] in ('削る', '別の規定に差し替え・削除')), None)
        if end_ev:
            when = end_ev.get('date') or ''
        elif cfg['end'] and pid in set(L['final'].values()):
            when = cfg['end']
        else:
            continue
        succ = [s for s in cfg['succ'] if when and days(when, s[1]) <= WINDOW]
        if succ:
            out.append({'pid': pid, 'num': nums[-1], 'ended': when, 'text': text, 'succ': succ})
    return out


def pair_key(cfg, p, law, art):
    return hashlib.sha1(f"{cfg['old']}|{p['pid']}|{law}|{art}|{p['text'][:200]}".encode('utf-8')).hexdigest()[:16]


def call(items):
    body = json.dumps({'items': items, 'questions': QUESTION}).encode('utf-8')
    req = urllib.request.Request(os.environ['JEV_URL'].rstrip('/') + '/api/jev-score', data=body, method='POST',
                                 headers={'content-type': 'application/json', 'x-api-key': os.environ['JEV_KEY'], 'user-agent': 'joubun-kun-lineage/1'})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def main(judge, only=None):
    budget = MAX_ITEMS
    os.makedirs(os.path.join(S.DATA, 'out', 'relink'), exist_ok=True)
    arts_cache = {}
    summary = []
    for cfg in CONFIG:
        if only and cfg['old'] not in only:
            continue
        if not os.path.exists(os.path.join(S.DATA, 'out', cfg['old'], 'lineage.json')):
            print(json.dumps({'old': cfg['old'], 'skip': '旧法の系譜が無い（build.py 旧法ID:題名:最後の日 で作る）'}, ensure_ascii=False), flush=True)
            continue
        p_out = os.path.join(S.DATA, 'out', 'relink', f"{cfg['old']}.json")
        prev = json.load(open(p_out, encoding='utf-8')) if os.path.exists(p_out) else {}
        jev = prev.get('jev', {})
        provs = old_provisions(cfg)
        rows, todo = [], []
        for p in provs:
            cands = []
            for law, start, name in p['succ']:
                if law not in arts_cache:
                    arts_cache[law] = succ_articles(law)
                for a in arts_cache[law]:
                    cands.append((sim(p['text'], a['text']), law, name, a))
            cands.sort(key=lambda x: -x[0])
            cands = cands[:TOP]
            row = {'old_num': p['num'], 'old_pid': p['pid'], 'ended': p['ended'],
                   'cands': [{'law': law, 'law_name': name, 'art': a['num'], 'sim': round(s0, 3), 'key': pair_key(cfg, p, law, a['num'])}
                             for s0, law, name, a in cands]}
            rows.append(row)
            for (s0, law, name, a), c in zip(cands, row['cands']):
                if c['key'] not in jev:
                    todo.append({'id': c['key'], 'state': {'旧法の条文': {'法令': cfg['title'], '条': p['num'], '本文': p['text'][:1500]},
                                                           '新しい法令の条文': {'法令': name, '条': a['num'], '見出し': a['caption'], '本文': a['text'][:1500]}}})
        tok = 0
        if judge:
            todo = todo[:max(0, budget)]
            budget -= len(todo)
            for i in range(0, len(todo), 200):
                try:
                    res = call(todo[i:i + 200])
                except Exception as e:
                    print(f"{cfg['old']}: 呼び出しに失敗（{type(e).__name__} {getattr(e, 'code', '')}）", flush=True)
                    break
                for r in res.get('results', []):
                    a = (r.get('answers') or {}).get('q') or {}
                    if isinstance(a.get('noul'), (int, float)):
                        jev[r['id']] = a['noul']
                tok += res.get('usage', {}).get('input_tokens', 0)
                time.sleep(0.5)
        # 決める: Jev が 0.5 以上で一番の候補（無ければ受け皿なし）
        for row in rows:
            ok = []
            for c in row['cands']:
                c['jev'] = jev.get(c['key'])
                if c['jev'] is not None and c['jev'] >= 0.5:
                    ok.append(c)
            ok.sort(key=lambda c: -c['jev'])
            # 一番の受け皿と、それに近い確からしさの受け皿も残す（1 つの旧条が何条にも分かれた: 旧商法 266 条など）。
            #   2 つ目以降は SPLIT_MIN 以上で一番との差が SPLIT_GAP 以内だけ（旧民訴法 89 条 → 61 条 0.98・64 条 0.83 の 64 条は落とす。
            #   関連するだけの条に判例が何千件も並ぶのを避ける）
            keep = [c for i, c in enumerate(ok) if i == 0 or (c['jev'] >= SPLIT_MIN and c['jev'] >= ok[0]['jev'] - SPLIT_GAP)]
            row['to'] = [{'law': c['law'], 'law_name': c['law_name'], 'art': c['art'], 'jev': c['jev']} for c in keep] or None
        json.dump({'config': cfg, 'rows': rows, 'jev': jev}, open(p_out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        linked = sum(1 for r in rows if r['to'])
        summary.append({'old': cfg['old'], 'provisions': len(rows), 'pairs_to_judge': len(todo), 'linked': linked, 'usd': round(tok * 0.042 / 1e6, 4)})
        print(json.dumps(summary[-1], ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main('--judge' in sys.argv, [a for a in sys.argv[1:] if not a.startswith('--')] or None)
