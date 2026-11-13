# 系譜を引く: 「その日の第 N 条」はどの規定（ID）で、今（系譜の最後の時点）の何条か
import json

from .kansuji import key_sort

END_OPS = ('削る', '別の規定に差し替え・削除')


class Resolver:
    def __init__(self, lineage_json):
        L = lineage_json if isinstance(lineage_json, dict) else json.load(open(lineage_json, encoding='utf-8'))
        self.lineage = L['lineage']
        self.final = L['final']
        self.cur_of = {pid: n for n, pid in self.final.items()}
        self.asof = L.get('asof')
        self.tl = {}
        self.by_num = {}
        for pid, evs in self.lineage.items():
            seq = []
            for e in evs:
                d = e.get('date') if e.get('date') and e.get('date')[0].isdigit() else '0000-00-00'
                if e['op'] in END_OPS:
                    seq.append((d, None))
                elif e.get('num'):
                    seq.append((d, e['num']))
                    self.by_num.setdefault(e['num'], set()).add(pid)
            self.tl[pid] = sorted(seq, key=lambda x: x[0])

    def num_at(self, pid, d):
        cur = None
        for dt, n in self.tl[pid]:
            if dt <= d:
                cur = n
            else:
                break
        return cur

    def pid_at(self, num, d):
        """その日に第 num 条だった規定 ID（無ければ None）"""
        c = [pid for pid in self.by_num.get(num, ()) if self.num_at(pid, d) == num]
        return c[0] if c else None

    def resolve(self, num, d):
        """→ {'pid', 'status', 'now'}。status: 同じ番号 / 番号が変わった / 書き直し / 差し替え・削除 / 削除 / その日に無い条"""
        pid = self.pid_at(num, d)
        if not pid:
            return {'pid': None, 'status': 'その日に無い条', 'now': None}
        after = [e for e in self.lineage[pid] if (e.get('date') or '') > d]
        if pid in self.cur_of:
            now = self.cur_of[pid]
            rew = [e for e in after if e['op'].startswith('書き直し')]
            if now != num:
                return {'pid': pid, 'status': '番号が変わった', 'now': now, 'rewritten': bool(rew)}
            return {'pid': pid, 'status': '書き直し' if rew else '同じ番号', 'now': now}
        end = [e for e in after if e['op'] in END_OPS]
        last = end[-1] if end else None
        return {'pid': pid, 'status': '差し替え・削除' if last and last['op'] != '削る' else '削除', 'now': None,
                'ended': last.get('date') if last else None, 'law': last.get('law') if last else None}
