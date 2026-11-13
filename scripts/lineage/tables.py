# 条の系譜から「付け直しの表」を作る（読むだけ・書くのは LINEAGE_DATA/out/tables だけ。¥0・ネットにも LLM にも出ない）
#   python -I -X utf8 scripts/lineage/tables.py [法令ID ...]      # 省略で out/ の全部の系譜と relink の旧法
#
# 表（out/tables/{法令ID}.json）は「判決が使った版の第 N 条は、今のどの条か」を、条番号ごとの期間で持つ:
#   { law_id, title, born, old, acts: {"平成29年法律第44号": "2020-04-01"（施行日）},
#     arts: { "89": [[from, to, how, [[今の法令ID, 今の条キー, 確からしさ], ...]], ...] } }
#   条キーは判例の lawRefs・links と同じ「89の2」の形。to は次の期間の始まり（その日を含まない。最後は null）。
#   how: same（同じ番号の同じ規定）・renum（番号が変わった）・split（分かれた）・moved（ほかの法令に移った）・
#        gone（今の条に同じ規定が無い）・old（作り直す前の旧法の条 → 受け皿）
# 判例ごとの付け直し（どの期間を使うか）は scripts/lineage/lib/currefs.cjs が引く（全件の作り直し・判例の週次で共用）。
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import sources as S                 # noqa: E402
from lib.identity import Identity            # noqa: E402
from lib.resolve import END_OPS              # noqa: E402
from lib.kansuji import ERA, ERA_BASE         # noqa: E402

VERSION = 2   # 2: 期間に「その後の出来事」と「直前の変化」を足した（注記に使う）


def jk(k):
    """系譜の条キー '70_6_2' → 判例の条キー '70の6の2'"""
    return k.replace('_', 'の')


def load_relink():
    """旧法（作り直す前の法令・ほかの法令に移った規定）の受け皿: {旧法の法令ID: {'config', 'rows': {規定ID: row}}}"""
    out = {}
    d = os.path.join(S.DATA, 'out', 'relink')
    if not os.path.isdir(d):
        return out
    for f in sorted(os.listdir(d)):
        if f.endswith('.json'):
            j = json.load(open(os.path.join(d, f), encoding='utf-8'))
            out[j['config']['old']] = {'config': j['config'], 'rows': {r['old_pid']: r for r in j['rows']}}
    return out


class Walker(Identity):
    """Identity の _walk に確からしさ（Jev の判定を通った所の一番低い値）と、行き止まりの規定を足したもの"""

    def __init__(self, law_id, data_dir):
        super().__init__(law_id, data_dir)
        self.pr = {}
        for old, by_law in self.succ.items():
            for law, lst in by_law.items():
                for n, p in lst:
                    self.pr[(old, law, n)] = p

    def walk(self, pid, d, seen=None, depth=0):
        """→ [(今の番号 or None, 確からしさ, 行き止まりの規定 ID or None, [その日より後の出来事])]
        出来事は [施行日, 種類, 改正法, 公布日]。種類: amend（文言の改正・書き直し）・renum（番号の変更）・end（差し替え・削除。引き継ぎ先があればその後も続く）"""
        seen = seen if seen is not None else set()
        if depth > 20 or (pid, d) in seen:
            return []
        seen.add((pid, d))
        evs = []
        for e in [e for e in self.lineage.get(pid, []) if (e.get('date') or '') > d]:
            law = e.get('law')
            cut = (pid, law) in self.breaks
            ended = e['op'] in END_OPS
            nxt = [n for n, _ in (self.succ.get(pid, {}).get(law) or []) if n != pid]
            k = ev_kind(e['op'])
            if cut or ended:
                ev = evs + [ev_row(e, 'end')]
                out = []
                for n in nxt:
                    p = self.pr.get((pid, law, n), 1.0)
                    out += [(now, min(p, q), dead, ev + later) for now, q, dead, later in self.walk(n, e.get('date') or d, seen, depth + 1)]
                return out or [(None, 1.0, pid, ev)]
            if k:
                evs.append(ev_row(e, k))
            if nxt:
                out = []
                for n in nxt:
                    p = self.pr.get((pid, law, n), 1.0)
                    out += [(now, min(p, q), dead, evs + later) for now, q, dead, later in self.walk(n, e.get('date') or d, seen, depth + 1)]
                if pid in self.cur_of:
                    rest = [ev_row(x, ev_kind(x['op'])) for x in self.lineage.get(pid, []) if (x.get('date') or '') > (e.get('date') or d) and ev_kind(x['op'])]
                    out.append((self.cur_of[pid], 1.0, None, evs + rest))
                return out
        if pid in self.cur_of:
            return [(self.cur_of[pid], 1.0, None, evs)]
        return [(None, 1.0, pid, evs)]

    def prev_change(self, pid, d):
        """その日までに、この規定が今の番号・中身になった最後の出来事（番号の変更・同じ番号の新しい規定）。判決が改正の直後かを見る"""
        best = None
        for e in self.lineage.get(pid, []):
            if (e.get('date') or '') <= d and e['op'] in ('番号の変更', '書き直し（番号の変更）', '新しい規定', '追加') and e.get('law'):
                best = e
        return ev_row(best, 'renum' if best['op'] in ('番号の変更', '書き直し（番号の変更）') else 'new') if best else None


AMEND_OPS = ('文言の改正', '書き直し')
RENUM_OPS = ('番号の変更', '書き直し（番号の変更）')


def ev_kind(op):
    if op in AMEND_OPS:
        return 'amend'
    if op in RENUM_OPS:
        return 'renum'
    return None


def ev_row(e, kind):
    """出来事 → [施行日, 種類, 改正法, 公布日]（改正法の名前「平成29年5月26日法律第44号」から公布日を読む）"""
    law = e.get('law') or ''
    m = re.match(r'^(明治|大正|昭和|平成|令和)(元|\d+)年(\d+)月(\d+)日', law)
    prom = None
    if m:
        y = 1 if m.group(2) == '元' else int(m.group(2))
        prom = f"{ERA_BASE[ERA[m.group(1)]] + y}-{int(m.group(3)):02d}-{int(m.group(4)):02d}"
    return [e.get('date'), kind, law, prom]


def ksort(k):
    return tuple(int(x) for x in k.split('_'))


def resolve_targets(W, law_id, num, pid, d, relink):
    """→ (how, [[法令ID, 条キー, 確からしさ]], [その日より後の出来事], 直前の変化)"""
    res = W.walk(pid, d)
    nows, deads, evs = {}, [], {}
    for now, p, dead, later in res:
        for x in later:
            evs[(x[0], x[1], x[2])] = x
        if now:
            nows[now] = max(nows.get(now, 0), p)
        elif dead:
            deads.append((dead, p))
    later = sorted(evs.values(), key=lambda x: (x[0] or '', x[1]))[:12]
    prev = W.prev_change(pid, d)
    if nows:
        keys = sorted(nows, key=ksort)
        tg = [[law_id, jk(k), round(nows[k], 2)] for k in keys]
        if len(keys) > 1:
            return 'split', tg, later, prev
        return ('same' if keys[0] == num else 'renum'), tg, later, prev
    # 今の条に無い: ほかの法令に移った規定（商法の会社の規定 → 会社法 など）なら受け皿へ
    rows = (relink.get(law_id) or {}).get('rows') or {}
    for dead, p in deads:
        row = rows.get(dead)
        if row and row.get('to'):
            return 'moved', [[t['law'], jk(t['art']), round(min(p, t['jev']), 2)] for t in row['to']], later, prev
    return 'gone', [], later, prev


def periods(W, num, fn):
    """その番号が指していた規定ごとの期間を切り、fn(pid, 期間の始まり) の結果が同じ所はつなぐ
    → [[from, to, how, 行き先, その後の出来事, 直前の変化]]（出来事は期間の中で変わらない: 期間の境目はその規定の出来事の日）"""
    pids = W.by_num.get(num, ())
    dates = sorted({dt for p in pids for dt, _, _ in W.tl[p]})
    out = []
    for i, d in enumerate(dates):
        pid = W.pid_at(num, d)
        nxt = dates[i + 1] if i + 1 < len(dates) else None
        if not pid:
            continue
        r = list(fn(pid, d))
        how, tg = r[0], r[1]
        later = r[2] if len(r) > 2 else []
        prev = r[3] if len(r) > 3 else None
        if out and out[-1][1] == d and out[-1][2] == how and out[-1][3] == tg and out[-1][4] == later:
            out[-1][1] = nxt
        else:
            out.append([d, nxt, how, tg, later, prev])
    return out


def acts_of(L):
    """判決文の「…法律第N号による改正前」で使う: 改正法の番号（月日なし）→ 施行日（分からなければ公布日）"""
    out = {}
    for a in L.get('acts', []):
        k = re.sub(r'\d+月\d+日', '', a['law'])
        out[k] = (a.get('enf') or {}).get('date') or a.get('promulgated')
    for c in L.get('chain', []):
        k = re.sub(r'\d+月\d+日', '', c['law'])
        out.setdefault(k, c['date'])
    return out


def build_current(law_id, relink, old_of):
    W = Walker(law_id, S.DATA)
    born = min(((evs[0].get('date') or '9999') for evs in W.lineage.values() if evs), default=None)
    # 作り直す前の旧法がある法令は、旧法の表へ切り替える境目を今の法令の施行日にする（公布日ではない。新しい民訴法は
    #   1996-06-26 公布・1998-01-01 施行で、その間の判決は旧民訴法を引いている）。施行日は受け皿の設定（succ の日）
    old = old_of.get(law_id)
    if old:
        cfg = relink[old]['config']
        start = next((s[1] for s in cfg.get('succ') or [] if s[0] == law_id), None)
        if start:
            born = start
    arts = {}
    for num in sorted(W.by_num, key=ksort):
        ps = periods(W, num, lambda pid, d: resolve_targets(W, law_id, num, pid, d, relink))
        if ps:
            arts[jk(num)] = ps
    return {'v': VERSION, 'law_id': law_id, 'title': S.title_of(law_id), 'born': born, 'old': old_of.get(law_id),
            'asof': W.L.get('asof'), 'acts': acts_of(W.L), 'jev_judged': W.judged, 'arts': arts,
            # 政令・省令・勅令（名古屋大学のデータに無い）: e-Gov の一番古い版（since）より前の判決は系譜で引けないので、
            # 日本法令索引の改正の公布日（amend_dates）から「この判決の後、○回改正」の注記にする
            **({'egov_only': True, 'since': W.L.get('asof'), 'amend_dates': W.L.get('amend_dates') or []} if W.L.get('egov_only') else {})}


def build_old(old_id, rl):
    """作り直す前の旧法: その日の第 N 条（規定）→ relink の受け皿"""
    W = Walker(old_id, S.DATA)
    rows = rl['rows']

    def fn(pid, d):
        row = rows.get(pid)
        if row and row.get('to'):
            return 'old', [[t['law'], jk(t['art']), round(t['jev'], 2)] for t in row['to']], [], None
        return 'gone', [], [], None

    arts = {}
    for num in sorted(W.by_num, key=ksort):
        ps = periods(W, num, fn)
        if ps:
            arts[jk(num)] = ps
    cfg = rl['config']
    return {'v': VERSION, 'law_id': old_id, 'title': cfg.get('name') or re.sub(r'（.*$', '', cfg['title']).lstrip('旧'), 'old_law': True,
            'end': cfg.get('end'), 'current': cfg.get('current'), 'names': cfg.get('names') or [], 'arts': arts}


def main(ids):
    relink = load_relink()
    # 今の法令 → 作り直す前の旧法（法令そのものを作り直したもの。end のある設定）。判決日が今の法令より前なら旧法の表で引く
    old_of = {}
    for old, rl in relink.items():
        cfg = rl['config']
        if cfg.get('end') and cfg.get('current'):
            old_of[cfg['current']] = old
    out_dir = os.path.join(S.DATA, 'out', 'tables')
    os.makedirs(out_dir, exist_ok=True)
    olds = {o for o, rl in relink.items() if rl['config'].get('end')}
    cur = ids or sorted(d for d in os.listdir(os.path.join(S.DATA, 'out'))
                        if re.fullmatch(r'\d{3}[A-Z]{2}\d{10}', d) and os.path.exists(os.path.join(S.DATA, 'out', d, 'lineage.json')))
    index = {}
    for lid in cur:
        try:
            t = None
            if lid in olds:
                t = build_old(lid, relink[lid])
            else:
                rep = json.load(open(os.path.join(S.DATA, 'out', lid, 'report.json'), encoding='utf-8'))
                if not rep.get('asof') or (rep.get('chain') and not rep['chain'].get('match_last')):
                    print(json.dumps({'law_id': lid, 'skip': '最新の版と条の番号が合っていない（表を作らない）'}, ensure_ascii=False), flush=True)
                    continue
                t = build_current(lid, relink, old_of)
        except Exception as e:   # 書きかけ・壊れた系譜で全体を止めない（その法令の表は作らない）
            print(json.dumps({'law_id': lid, 'skip': f'{type(e).__name__}: {str(e)[:120]}'}, ensure_ascii=False), flush=True)
            continue
        json.dump(t, open(os.path.join(out_dir, f'{lid}.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        hows = {}
        for ps in t['arts'].values():
            for p in ps:
                hows[p[2]] = hows.get(p[2], 0) + 1
        index[lid] = {'title': t['title'], 'old_law': bool(t.get('old_law')), 'old': t.get('old'), 'names': t.get('names') or [],
                      'arts': len(t['arts']), 'periods': hows}
        print(json.dumps({'law_id': lid, **index[lid]}, ensure_ascii=False), flush=True)
    p = os.path.join(out_dir, 'index.json')
    prev = json.load(open(p, encoding='utf-8')) if os.path.exists(p) and ids else {}
    prev.update(index)
    json.dump(prev, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main(sys.argv[1:])
