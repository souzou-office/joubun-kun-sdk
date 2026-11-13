# 判決のときの条文（改正の見直し＝段 3 で Opus に渡す）の控えを作る（読むだけ・書くのは LINEAGE_DATA/out/texts/ だけ。¥0・LLM なし）
#   LINEAGE_DATA={作業フォルダ} python -I -X utf8 scripts/lineage/texts.py [法令 ID ...]   # 省くと系譜のある全部の法令
# e-Gov の版は 2017 年ごろより後しか引けない（judge_cases.cjs は egovArticleAsof）。それより前の判決のときの条文は、名古屋大学
# 「法令XMLデータ」（CC BY 4.0）の原始の条文に改め文を当てていく系譜の組み立て（build.py）の途中にしか無いので、組み立てを
# もう一度流して、条ごとに本文が変わるたびに [当てた日, 本文] を控える（e-Gov の一番古い版での答え合わせ（reconcile）まで。
# その後は e-Gov の版を引く）。系譜そのもの（out/{法令ID}/lineage.json など）は書き換えない（組み立ての書き込みは捨てる）。
# 出力: out/texts/{法令ID}.json = {law_id, asof, built_at, low: [答え合わせで e-Gov の版と大きく違った条キー], arts: {条キー: [[日, 本文 or null（その日に無くなった）], ...]}}
#   本文は 1,500 字まで（段 3 に渡す長さ）。日は改め文の施行日。公布の順に当てるので、施行日が前後する改正は近い版になる
# 政令・勅令（名古屋大学のデータに無い・e-Gov の一番古い版から始める）は作らない（e-Gov の版を引けば足りる）
import io
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build as B                                               # noqa: E402
import relink as R                                              # noqa: E402
from lib import sources as S                                    # noqa: E402
from lib.engine import Lineage                                  # noqa: E402
from lib.kansuji import parse_egov_id                           # noqa: E402
from lib.xmlarts import is_deleted, sim                         # noqa: E402

MAX = 1500
LOW_SIM = 0.8   # build.py の low_sim と同じ
OUT = os.path.join(S.DATA, 'out', 'texts')


class _Stop(Exception):
    pass


class Capture(Lineage):
    """組み立ての途中で、条の本文が変わるたびに控える"""
    stop_after_reconcile = False

    def __init__(self, articles, date, label='制定'):
        super().__init__(articles, date, label)
        self.snaps = {}
        self.low = []
        self.snap(date)
        Capture.last = self   # 旧法（end あり）は答え合わせをしないので、組み立ての最後まで流してこれを拾う

    def snap(self, date):
        for n in set(self.state) | set(self.snaps):
            st = self.state.get(n)
            t = st['text'][:MAX] if st and st.get('text') else None
            h = self.snaps.get(n)
            if h is None:
                if t is not None:
                    self.snaps[n] = [[date, t]]
            elif h[-1][1] != t:
                h.append([date, t])

    def apply_act(self, act, segs):
        r = super().apply_act(act, segs)
        dates = [sg.get('date') for sg in segs if sg.get('date')]
        self.snap(max(dates) if dates else act['date'])   # ただし書で別の日にした部分があれば遅い方（その日には全部が効いている）
        return r

    def apply_version(self, new_arts, act, same_text=0.8):
        r = super().apply_version(new_arts, act, same_text)
        self.snap(act['date'])
        return r

    def reconcile(self, eg_arts, date, revive_sim=0.6):
        # 組み立てた文が e-Gov の一番古い版と大きく違う条（途中の改正の一部が当たっていない）は、それより前の控えも確かでない印を付ける
        eg = {a['num']: a['text'] for a in eg_arts}
        self.low = sorted(n for n, st in self.state.items() if n in eg and not is_deleted(st['text']) and not is_deleted(eg[n])
                          and sim(st['text'], eg[n]) < LOW_SIM)
        r = super().reconcile(eg_arts, date, revive_sim)
        self.snap(date)
        raise _Stop()   # その後の e-Gov の版は judge_cases.cjs が e-Gov から引く


_real_open = open


def _open(path, mode='r', *a, **kw):
    """組み立ての書き込み（out/{法令ID}/ の report.json・lineage.json・unparsed.json）を捨てる"""
    if any(c in mode for c in 'wax'):
        return io.StringIO() if 'b' not in mode else io.BytesIO()
    return _real_open(path, mode, *a, **kw)


def specs():
    """系譜のある法令（名古屋大学のデータから組み立てたもの）と、旧法の組（題名と最後の日）"""
    old = {c['old']: c for c in R.CONFIG if c.get('end')}
    out = []
    for d in sorted(os.listdir(os.path.join(S.DATA, 'out'))):
        if d in ('texts', 'relink', 'policy', 'tables') or not os.path.exists(os.path.join(S.DATA, 'out', d, 'lineage.json')):
            continue
        if d in old:
            out.append((d, old[d]['name'], old[d]['end']))
            continue
        pe = parse_egov_id(d)
        if not pe or pe[2] != 'AC':
            continue
        out.append((d, None, None))
    return out


def run(law_id, title=None, end=None):
    Capture.last = None
    B.Lineage = Capture
    B.open = _open
    try:
        try:
            r = B.build(law_id, title, end)
        except _Stop:
            r = {}
        lin = Capture.last
        if lin is None and r.get('error'):
            return {'law_id': law_id, 'error': r['error']}
        if lin is None:
            return {'law_id': law_id, 'error': 'e-Gov だけの法令（名古屋大学のデータから組み立てない）'}
        J = json.load(_real_open(os.path.join(S.DATA, 'out', law_id, 'lineage.json'), encoding='utf-8'))
        doc = {'law_id': law_id, 'asof': J.get('asof') or end, 'built_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
               'source': '名古屋大学「法令XMLデータ」（CC BY 4.0）の改め文を当てた系譜の組み立ての途中の本文', 'low': lin.low, 'arts': lin.snaps}
        os.makedirs(OUT, exist_ok=True)
        with _real_open(os.path.join(OUT, f'{law_id}.json'), 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        return {'law_id': law_id, 'arts': len(lin.snaps), 'versions': sum(len(h) for h in lin.snaps.values()), 'low': len(lin.low)}
    finally:
        B.Lineage = Lineage
        B.open = _real_open


if __name__ == '__main__':
    want = set(sys.argv[1:])
    todo = [s for s in specs() if not want or s[0] in want]
    for i, (lid, t, e) in enumerate(todo, 1):
        try:
            res = run(lid, t, e)
        except Exception as ex:   # 1 つの法令の失敗で残りを止めない
            res = {'law_id': lid, 'error': f'{type(ex).__name__}: {str(ex)[:200]}'}
        print(f'[{i}/{len(todo)}]', json.dumps(res, ensure_ascii=False), flush=True)
