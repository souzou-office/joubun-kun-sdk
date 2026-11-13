# 条を丸ごと書き換えた所（「…を次のように改める」）だけ、新旧の条文を Jev で「同じ事柄を定めた規定か」判定する
#   python -I -X utf8 scripts/lineage/judge_rewrites.py <法令ID>...
#   環境変数: JEV_URL（Worker の origin）・JEV_KEY（バイパスキー）。Jev の 1 日の上限（vars JEV_DAILY_USD）は本番と共用なので、
#   1 回の実行で MAX_ITEMS（既定 4000 組 ≒ $0.12）までにする。結果は out/{法令ID}/jev_pairs.json に控え、呼び直さない。
#   条文の本文（公開の法令）だけを送る。利用者の入力は送らない。
import hashlib
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S   # noqa: E402

TOP = 3
BATCH = 200
MAX_ITEMS = int(os.environ.get('MAX_ITEMS', '4000'))
QUESTION = {'q': {
    'type': 'noul',
    'instructions': '旧条文と新条文は、同じ事柄（同じ制度・同じ権利義務・同じ手続）を定めた規定か。改正で文言・要件・効果が変わっていても、'
                    '同じ事柄を定めていれば同じとする。条番号が同じでも、別の事柄を定める規定に入れ替わっていれば別とする。',
    'criteria': {'true': '同じ事柄を定めた規定', 'false': '別の事柄を定めた規定'},
}}


def pair_id(law_id, rv, c):
    h = hashlib.sha1(f"{law_id}|{rv['law']}|{rv['new_num']}|{c['old']}|{rv['new_text'][:200]}|{c['old_text'][:200]}".encode('utf-8')).hexdigest()
    return h[:16]


def call(items):
    body = json.dumps({'items': items, 'questions': QUESTION}).encode('utf-8')
    req = urllib.request.Request(os.environ['JEV_URL'].rstrip('/') + '/api/jev-score', data=body, method='POST',
                                 headers={'content-type': 'application/json', 'x-api-key': os.environ['JEV_KEY'],
                                          'user-agent': 'joubun-kun-lineage/1'})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def judge(law_id, budget):
    d = os.path.join(S.DATA, 'out', law_id)
    L = json.load(open(os.path.join(d, 'lineage.json'), encoding='utf-8'))
    cache_p = os.path.join(d, 'jev_pairs.json')
    cache = json.load(open(cache_p, encoding='utf-8')) if os.path.exists(cache_p) else {}
    title = S.title_of(law_id)
    todo = []
    for rv in L['reviews']:
        cands = rv['cands'][:TOP]
        same = [c for c in rv['cands'] if c['old'] == rv['new_num']]
        if same and same[0] not in cands:
            cands.append(same[0])
        for c in cands:
            pid = pair_id(law_id, rv, c)
            if pid in cache:
                continue
            todo.append({'id': pid, 'state': {
                '旧条文': {'法令': title, '条': c['old'], '見出し': c.get('old_caption') or '', '本文': c['old_text']},
                '新条文': {'法令': title, '条': rv['new_num'], '見出し': rv.get('new_caption') or '', '本文': rv['new_text']}}})
    todo = todo[:budget]
    used = 0
    for i in range(0, len(todo), BATCH):
        part = todo[i:i + BATCH]
        try:
            res = call(part)
        except Exception as e:   # 上限（429）や通信の失敗は止めて、控えた分だけ残す
            print(f'{law_id}: 呼び出しに失敗（{type(e).__name__} {getattr(e, "code", "")}）。ここまでを控えて止める', flush=True)
            return i, used
        for r in res.get('results', []):
            a = (r.get('answers') or {}).get('q') or {}
            if isinstance(a.get('noul'), (int, float)):
                cache[r['id']] = a['noul']
        used += res.get('usage', {}).get('input_tokens', 0)
        json.dump(cache, open(cache_p, 'w', encoding='utf-8'))
        time.sleep(0.5)
    return len(todo), used


if __name__ == '__main__':
    left = MAX_ITEMS
    for lid in sys.argv[1:]:
        n, tok = judge(lid, left)
        left -= n
        print(json.dumps({'law_id': lid, 'judged': n, 'input_tokens': tok, 'usd': round(tok * 0.042 / 1e6, 4)}), flush=True)
        if left <= 0:
            print('今回の上限に達した。続きは次の実行で（控えた組は呼び直さない）')
            break
