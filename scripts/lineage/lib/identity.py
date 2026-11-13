# 書き換えの所の「同じ規定か」を Jev の判定で決め直し、旧条 → 今の条（分かれたら複数）をたどる
#   engine の仮置き（本文の近さ）は、Jev の判定があればそれで上書きする:
#     - engine が「書き直し」とした組でも Jev が「別」（0.5 未満）なら、そこで切る
#     - engine が「新しい規定」とした条でも、Jev が「同じ」（0.5 以上）とした旧条があれば、旧条からそこへ引き継ぐ（1 つの旧条が複数の新条へ＝分かれた）
import hashlib
import json
import os

from .resolve import END_OPS

YES = 0.5


def pair_id(law_id, rv, c):
    h = hashlib.sha1(f"{law_id}|{rv['law']}|{rv['new_num']}|{c['old']}|{rv['new_text'][:200]}|{c['old_text'][:200]}".encode('utf-8')).hexdigest()
    return h[:16]


class Identity:
    def __init__(self, law_id, data_dir):
        d = os.path.join(data_dir, 'out', law_id)
        self.L = json.load(open(os.path.join(d, 'lineage.json'), encoding='utf-8'))
        p = os.path.join(d, 'jev_pairs.json')
        self.jev = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
        self.law_id = law_id
        self.lineage = self.L['lineage']
        self.final = self.L['final']
        self.cur_of = {pid: n for n, pid in self.final.items()}
        # 旧規定 ID → {改正法: [(新規定 ID, 確率)]}・切る所 {(旧規定 ID, 改正法)}
        #   新しい条ごとに、Jev が 0.5 以上とした旧条のうち一番確からしいものだけを引き継ぎ元にする（同じ番号の組は少し優先）。
        #   並びの条（成年被後見人・被保佐人・被補助人など）を Jev が「同じ事柄」と言っても、分かれたことにしないため
        self.succ, self.breaks, self.judged = {}, set(), 0
        self._merge_cands = []
        for rv in self.L.get('reviews', []):
            scored = []
            for c in rv['cands']:
                pr = self.jev.get(pair_id(law_id, rv, c))
                if pr is None:
                    continue
                self.judged += 1
                scored.append((pr + (0.1 if c['old'] == rv['new_num'] else 0.0), pr, c))
            if not scored:
                continue
            scored.sort(key=lambda x: -x[0])
            top_adj, top_pr, top_c = scored[0]
            if top_pr >= YES:
                self.succ.setdefault(top_c['old_id'], {}).setdefault(rv['law'], []).append((rv['new_id'], top_pr))
            # 統合: 一番ではないが Jev が強く同じ（0.8 以上）とした旧条は、ほかに行き先が無ければここへ合わさったとする（下で判定）
            for adj, pr, c in scored[1:]:
                if pr >= 0.8:
                    self._merge_cands.append((c['old_id'], rv['law'], rv['new_id'], pr))
            # engine が同じ規定として引き継いだ組（旧 ID = 新 ID）が、Jev の一番ではないか 0.5 未満なら、そこで切る
            for adj, pr, c in scored:
                if c['old_id'] == rv['new_id'] and (pr < YES or c is not top_c):
                    self.breaks.add((c['old_id'], rv['law']))
        for old, law, new, pr in self._merge_cands:
            if not (self.succ.get(old) or {}).get(law) and (old, law) not in self.breaks:
                if any(e.get('law') == law and e['op'] in END_OPS for e in self.lineage.get(old, [])):
                    self.succ.setdefault(old, {}).setdefault(law, []).append((new, pr))
        # 規定ごとの番号の移り変わり
        self.tl, self.by_num = {}, {}
        for pid, evs in self.lineage.items():
            seq = []
            for e in evs:
                dt = e.get('date') or '0000-00-00'
                if e['op'] in END_OPS:
                    seq.append((dt, None, e.get('law')))
                elif e.get('num'):
                    seq.append((dt, e['num'], e.get('law')))
                    self.by_num.setdefault(e['num'], set()).add(pid)
            self.tl[pid] = sorted(seq, key=lambda x: x[0])

    def num_at(self, pid, d):
        cur = None
        for dt, n, _ in self.tl[pid]:
            if dt <= d:
                cur = n
            else:
                break
        return cur

    def pid_at(self, num, d):
        c = [pid for pid in self.by_num.get(num, ()) if self.num_at(pid, d) == num]
        return c[0] if c else None

    def _walk(self, pid, d, seen, depth=0):
        """pid を日 d から今までたどる → [(今の番号, 道筋)]"""
        if depth > 20 or (pid, d) in seen:
            return []
        seen.add((pid, d))
        evs = [e for e in self.lineage.get(pid, []) if (e.get('date') or '') > d]
        for e in evs:
            law = e.get('law')
            cut = (pid, law) in self.breaks
            ended = e['op'] in END_OPS
            nxt = [n for n, pr in (self.succ.get(pid, {}).get(law) or []) if n != pid]
            if cut or ended:
                out = []
                for n in nxt:
                    for now, path in self._walk(n, e.get('date') or d, seen, depth + 1):
                        out.append((now, [f'{law}: {"別の規定とされた" if cut else "書き換え"} → 引き継ぎ'] + path))
                return out
            if nxt:   # 引き継ぎつつ、別の新条にも分かれた
                out = [(now, [f'{law}: 分かれた'] + path) for n in nxt for now, path in self._walk(n, e.get('date') or d, seen, depth + 1)]
                if pid in self.cur_of:
                    out.append((self.cur_of[pid], [f'{law}: 分かれた（元の条も残る）']))
                return out
        if pid in self.cur_of:
            return [(self.cur_of[pid], [])]
        return []

    def resolve(self, num, d):
        pid = self.pid_at(num, d)
        if not pid:
            return {'status': 'その日に無い条', 'now': []}
        res = self._walk(pid, d, set())
        nows = sorted({n for n, _ in res}, key=lambda k: tuple(int(x) for x in k.split('_')))
        if not nows:
            return {'status': '今は無い（削除・別の規定）', 'now': [], 'pid': pid}
        if len(nows) > 1:
            return {'status': '分かれた', 'now': nows, 'pid': pid}
        return {'status': '同じ番号' if nows[0] == num else '番号が変わった', 'now': nows, 'pid': pid}
