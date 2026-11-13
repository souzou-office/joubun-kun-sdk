# 旧法の受け皿の答え合わせ（読むだけ・¥0）: 答えの分かっている旧条 → 今の条が、relink.py の結果（out/relink/{旧法}.json）で合っているか
#   python -I -X utf8 scripts/lineage/eval_relink.py
#   答え（KNOWN）は立法の対照表・逐条解説で広く知られた組だけ。受け皿が複数（分かれた）のときは、答えの条が受け皿に入っていれば合っている
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S   # noqa: E402

# (旧法, 旧条, 今の法令, 今の条, 中身)
KNOWN = [
    ('123AC0000000029', '89', '408AC0000000109', '61', '訴訟費用の敗訴者負担'),
    ('123AC0000000029', '95', '408AC0000000109', '67', '訴訟費用の負担の裁判'),
    ('132AC0000000048', '269', '417AC0000000086', '361', '取締役の報酬'),
    ('132AC0000000048', '267', '417AC0000000086', '847', '株主代表訴訟'),
    ('132AC0000000048', '266', '417AC0000000086', '423', '取締役の会社に対する責任'),
    ('129AC0000000089', '44', '418AC0000000048', '78', '法人の不法行為能力'),
    ('309AC0000000014', '1', '405AC0000000047', '2', '不正競争の定義'),
    ('211AC0000000071', '72', '416AC0000000075', '160', '否認権（破産債権者を害する行為）'),
    ('211AC0000000071', '104', '416AC0000000075', '71', '相殺の禁止'),
    ('211AC0000000071', '59', '416AC0000000075', '53', '双方未履行の双務契約'),
    ('132AC0000000024', '26', '416AC0000000123', '60', '共同申請'),
    ('132AC0000000024', '49', '416AC0000000123', '25', '申請の却下'),
    ('337AC0000000160', '14', '426AC0000000068', '18', '審査請求期間'),
    ('211AC0000000075', '485', '323AC0000000131', '435', '再審の事由'),
    ('211AC0000000075', '360', '323AC0000000131', '335', '有罪判決に示す理由'),
    ('210AC0000000049', '2', '403AC0000000090', '3', '借地権の存続期間'),
    ('210AC0000000049', '10', '403AC0000000090', '14', '第三者の建物買取請求権'),
    ('210AC0000000049', '12', '403AC0000000090', '11', '地代等増減請求権'),
    ('210AC0000000050', '1', '403AC0000000090', '31', '建物賃貸借の対抗力'),
    ('210AC0000000050', '7', '403AC0000000090', '32', '借賃増減請求権'),
    ('210AC0000000050', '5', '403AC0000000090', '33', '造作買取請求権'),
    ('322AC0000000152', '24', '423AC0000000052', '284', '調停に代わる審判'),
    ('322AC0000000152', '23', '423AC0000000052', '277', '合意に相当する審判'),
    ('322AC0000000152', '21', '423AC0000000052', '268', '調停の成立と効力'),
]


def main():
    rows = {}
    out, ok = [], 0
    for old, oart, law, art, what in KNOWN:
        if old not in rows:
            p = os.path.join(S.DATA, 'out', 'relink', f'{old}.json')
            rows[old] = {r['old_num']: r for r in json.load(open(p, encoding='utf-8'))['rows']} if os.path.exists(p) else None
        if rows[old] is None:
            out.append({'old': old, 'art': oart, 'want': f'{law}:{art}', 'got': None, 'ok': False, 'what': what, 'why': '受け皿の結果が無い'})
            continue
        r = rows[old].get(oart)
        got = [(t['law'], t['art'], t['jev']) for t in (r or {}).get('to') or []]
        hit = any(l == law and a == art for l, a, _ in got)
        ok += hit
        cand = [(c['law'], c['art'], c.get('jev')) for c in (r or {}).get('cands', [])] if r else None
        out.append({'old': old, 'art': oart, 'want': f'{law}:{art}', 'got': got, 'ok': hit, 'what': what,
                    **({} if hit else {'cands': cand, 'why': '旧条の規定が受け皿を探す候補に無い' if not r else ''})})
    for o in out:
        print(('OK  ' if o['ok'] else 'NG  ') + json.dumps(o, ensure_ascii=False))
    print(f'\n{ok} / {len(KNOWN)} 合った')
    json.dump({'ok': ok, 'total': len(KNOWN), 'rows': out}, open(os.path.join(S.DATA, 'out', 'eval_relink.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
