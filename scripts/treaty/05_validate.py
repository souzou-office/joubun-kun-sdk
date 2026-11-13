# -*- coding: utf-8 -*-
"""05: パース結果の機械検証。抽出バグの兆候を全条走査で検出する。

  python scripts/treaty/05_validate.py
"""
import io
import json
import pathlib
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

STATE = pathlib.Path(__file__).parent / 'state'
data = json.loads((STATE / 'treaty_articles_capped.json').read_text(encoding='utf-8'))

issues = []


def add(country, no, kind, detail):
    issues.append((country, no, kind, detail))


for t in data:
    arts = [a for a in t['articles'] if a['no'] > 0]
    nos = [a['no'] for a in arts]
    # 条番号の連番性
    if nos != list(range(1, len(nos) + 1)):
        add(t['country'], '-', '条番号非連続', str([n for i, n in enumerate(nos) if n != i + 1][:5]))
    for a in t['articles']:
        body = a.get('body', '')
        # ページ番号混入の兆候: 文中（。以外の直後）に唐突な半角2桁数字＋日本語
        for m in re.finditer(r'[ぁ-んる-ん一-龥][0-9]{2}(?=[ぁ-ん一-龥])', body):
            seg = body[max(0, m.start() - 8):m.end() + 8]
            # 「第12条」「その2分の1」等の正当パターンを除外
            if re.search(r'第[0-9]{2}|[0-9]{2}(?:年|月|日|条|項|号|パーセント|％|箇月|人|歳|時間)', seg):
                continue
            add(t['country'], a['no'], 'ページ番号混入疑い', seg)
        # 項の連番性
        paras = a.get('paras', [])
        pnos = [int(p['n']) for p in paras if p.get('n')]
        if pnos and pnos != list(range(pnos[0], pnos[0] + len(pnos))):
            add(t['country'], a['no'], '項番号非連続', str(pnos[:8]))
        # 号の連番性 (a),(b),(c)...
        for p in paras:
            its = [it['l'] for it in p.get('items', [])]
            if its:
                expected = ['(' + chr(ord('a') + i) + ')' for i in range(len(its))]
                if its != expected:
                    add(t['country'], a['no'], '号記号非連続', str(its[:6]))
        # 文の途切れ（本文が接続語や読点で終わる）
        if len(body) > 50 and re.search(r'[、にがはをのとへで]$', body.rstrip()):
            add(t['country'], a['no'], '末尾が文中で切れている疑い', body[-25:])
        # 監査用の異常な短さ（削除以外）
        if a['no'] > 0 and 0 < len(body) < 15 and '削除' not in body and '削除' not in (a.get('cap') or ''):
            add(t['country'], a['no'], '本文が異常に短い', body)

print(f'検証対象: {len(data)}か国 {sum(len(t["articles"]) for t in data)}条')
print(f'検出: {len(issues)}件')
for c, n, k, d in issues[:60]:
    print(f'  {c} 第{n}条 [{k}] {d[:60]}')
