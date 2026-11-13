# 条の系譜: 原始の条文に改め文を順に当て、規定（ID）ごとに「いつ・どの改正法で・何が起きたか」を残す
#   番号の変更・削除・追加は改め文のとおりに確定する。
#   条を丸ごと書き換えた所（「…を次のように改める」）は、新旧の本文の近さで仮に「同じ規定か」を決め、候補を残す
#   （後で Jev などで決め直す。review=True の印）。
import re
import xml.etree.ElementTree as ET

from .kansuji import ART, NUM, art_key, kan2int, key2art, key_sort
from .xmlarts import is_deleted, norm_amend, sim, text_of, walk_articles

import os
_TRACE = os.environ.get('LINEAGE_TRACE')
UNIT = {'編': 'Part', '章': 'Chapter', '節': 'Section', '款': 'Subsection', '目': 'Division'}
SAME = 0.35          # 書き換えでもこれ以上なら仮に「同じ規定の書き直し」（Jev で決め直す前の仮置き）
END_OPS = ('削る', '別の規定に差し替え・削除')


class Lineage:
    def __init__(self, articles, date, label='制定'):
        self.state = {}      # 条キー → {id, path, caption, text}
        self.lineage = {}    # 規定 ID → [出来事]
        self.reviews = []    # 書き換えで「同じ規定か」を決め直す候補
        self.unparsed = []
        self.stats = {}
        self._n = 0
        self._last_text = {}
        for a in articles:
            pid = self._new_id()
            self.state[a['num']] = {'id': pid, 'path': a['path'], 'caption': a['caption'], 'text': a['text']}
            self._ev(pid, {'date': date, 'op': label, 'num': a['num']})

    # ------------------------------------------------------------ 小道具
    def _new_id(self):
        self._n += 1
        return 'P%05d' % self._n

    def _ev(self, pid, ev):
        self.lineage.setdefault(pid, []).append(ev)
        st = next((a for a in self.state.values() if a['id'] == pid), None) if ev.get('op') in END_OPS else None
        if st:
            self._last_text[pid] = st['text']
        if _TRACE and ev.get('num') == _TRACE:   # 調べる用: LINEAGE_TRACE=10 で、その条の出来事を起こした節を出す
            print('TRACE', ev, '|', getattr(self, '_clause', '')[:200])

    def _bump(self, k):
        self.stats[k] = self.stats.get(k, 0) + 1

    def _alive(self):
        return self.state

    def arts_in_range(self, a, b):
        ka, kb = key_sort(a), key_sort(b)
        return sorted([n for n in self.state if ka <= key_sort(n) <= kb], key=key_sort)

    def target_arts(self, tgt):
        m = re.fullmatch(rf'({ART})から({ART})まで', tgt)
        if m:
            return self.arts_in_range(art_key(m.group(1)), art_key(m.group(2)))
        lst = re.findall(ART, tgt)
        if lst and re.fullmatch(rf'(?:{ART}(?:、|及び|並びに)?)+', tgt):
            return [art_key(x) for x in lst]
        return None

    def parse_units(self, tgt, ctx):
        out = []
        for m in re.finditer(rf'(同|第({NUM}))(編|章|節|款|目)(?:の({NUM}))?', tgt):
            tag = UNIT[m.group(3)]
            if m.group(1) == '同':
                v = ctx.get(tag)
            else:
                v = str(kan2int(m.group(2))) + (('_' + str(kan2int(m.group(4)))) if m.group(4) else '')
            out.append((tag, v))
        return out

    def arts_in_units(self, units, ctx=None):
        """編章節の指定に当たる条。上の単位が書いていない（「第二章」だけ）ときは、文脈の上の単位に絞る。
        絞れずに複数の編にまたがるなら、取り違えを避けて何も返さない"""
        res = []
        for num, a in self.state.items():
            p = dict(a['path'])
            if all(p.get(t) == v for t, v in units):
                res.append(num)
        order = ['Part', 'Chapter', 'Section', 'Subsection', 'Division']
        given = {t for t, _ in units}
        top = min((order.index(t) for t in given), default=0)
        for lvl in order[:top]:
            vals = {dict(self.state[n]['path']).get(lvl) for n in res}
            if len(vals) <= 1:
                continue
            want = (ctx or {}).get(lvl)
            if want and want in vals:
                res = [n for n in res if dict(self.state[n]['path']).get(lvl) == want]
            else:
                return []
        return sorted(res, key=key_sort)

    def _extend_pathless(self, arts):
        """位置（編章節）が分からない条（後から加えた条で位置を取れなかったもの）も、番号が範囲の中なら含める"""
        if not arts:
            return arts
        lo, hi = key_sort(arts[0]), key_sort(arts[-1])
        have = set(arts)
        for n, a in self.state.items():
            if n not in have and lo <= key_sort(n) <= hi and not a['path']:
                arts.append(n)
        return sorted(arts, key=key_sort)

    @staticmethod
    def new_articles(new_xml, base_path):
        if not new_xml:
            return []
        return walk_articles(ET.fromstring(new_xml), list(base_path), [])

    # ------------------------------------------------------------ 書き換え（条・範囲・編章節）
    def replace_block(self, old_nums, news, act, label, ctx=None):
        olds = {n: self.state[n] for n in old_nums if n in self.state}
        used = set()
        for na in news:
            cands = sorted(((sim(oa['text'], na['text']), on) for on, oa in olds.items()), reverse=True)[:5]
            best, bs = None, 0.0
            if na['num'] in olds:
                best, bs = na['num'], sim(olds[na['num']]['text'], na['text'])
            if bs < SAME:
                for s1, on in cands:
                    if on not in used and s1 > bs:
                        best, bs = on, s1
                        break
            deleted = is_deleted(na['text'])
            if best is not None and bs >= SAME and best not in used and not deleted:
                used.add(best)
                pid = olds[best]['id']
                op = '書き直し' if best == na['num'] else '書き直し（番号の変更）'
                self._ev(pid, {'date': act['date'], 'law': act['law'], 'op': op, 'num': na['num'], 'from': best, 'sim': round(bs, 2), 'via': label})
            else:
                pid = self._new_id()
                self._ev(pid, {'date': act['date'], 'law': act['law'], 'op': '削除の印' if deleted else '新しい規定', 'num': na['num'],
                               'sim_best': round(bs, 2), 'via': label})
            na['_id'] = pid
            if not deleted and olds:
                self.reviews.append({'law': act['law'], 'date': act['date'], 'new_num': na['num'], 'new_id': pid,
                                     'new_caption': na['caption'], 'new_text': na['text'][:1500],
                                     'cands': [{'old': on, 'old_id': olds[on]['id'], 'sim': round(s1, 3),
                                                'old_caption': olds[on]['caption'], 'old_text': olds[on]['text'][:1500]} for s1, on in cands],
                                     'chosen': best if (best in used and pid == olds.get(best, {}).get('id')) else None})
        new_nums = {na['num'] for na in news}
        # 編ごと書き換えた新しい条文に、もとの「削除」の条が載っていないことがある（データの抜け。e-Gov には残る）→ 削除の印のまま残す
        keep = {on for on, oa in olds.items() if on not in used and on not in new_nums and is_deleted(oa['text'])}
        for on, oa in olds.items():
            if on not in used and on not in keep:
                self._ev(oa['id'], {'date': act['date'], 'law': act['law'], 'op': '別の規定に差し替え・削除', 'num': on, 'via': label})
        for on in old_nums:
            if on not in keep:
                self.state.pop(on, None)
        for na in news:
            ex = self.state.get(na['num'])
            if ex and ex['id'] != na['_id'] and na['num'] not in old_nums:
                # 書き換えの外にいた同じ番号の条と重なった（昭和13年の商法改正: 第二編を書き換えた後で第三編の旧い番号を付け替える）
                if is_deleted(na['text']):
                    # 削除の範囲に入った → その条も終わる（平成17年の「第三十二条から第五百条まで　削除」）
                    self._ev(ex['id'], {'date': act['date'], 'law': act['law'], 'op': '削る', 'num': na['num'], 'via': label})
                elif ctx is not None:
                    ctx.setdefault('pending', {})[na['num']] = ex   # 同じ改正法の後の文で旧い番号のまま付け替えられる
            self.state[na['num']] = {'id': na['_id'], 'path': na['path'], 'caption': na['caption'], 'text': na['text']}
        # 「第X条から第Y条まで　削除」の範囲の中に残った枝番の条（例: 商法の第四十四条の二）も消す
        for rng in {tuple(na['range']) for na in news if na.get('range') and is_deleted(na['text'])}:
            try:
                lo, hi = key_sort(rng[0]), key_sort(rng[1])
            except ValueError:
                continue
            for n in [n for n in self.state if lo <= key_sort(n) <= hi and n not in new_nums]:
                self._ev(self.state[n]['id'], {'date': act['date'], 'law': act['law'], 'op': '削る', 'num': n, 'via': label})
                self.state.pop(n)

    # ------------------------------------------------------------ 文言の改正
    def text_edit(self, k, t, quotes, new_xml, act, ctx):
        pend = ctx.get('pending', {})
        st = pend.get(k) if k in pend else self.state.get(k)
        if not st:
            self._bump('文言の改正（条が見つからない）')
            return True
        for q in re.finditer(r'〔Q(\d+)〕を〔Q(\d+)〕に', t):
            a, b = quotes[int(q.group(1))], quotes[int(q.group(2))]
            st['text'] = st['text'].replace(a, b)
        for q in re.finditer(r'〔Q(\d+)〕を削', t):
            st['text'] = st['text'].replace(quotes[int(q.group(1))], '')
        if new_xml:
            st['text'] += text_of(ET.fromstring(new_xml))
        ev = self.lineage.get(st['id'], [])
        if not (ev and ev[-1].get('law') == act['law'] and ev[-1].get('op') == '文言の改正'):
            self._ev(st['id'], {'date': act['date'], 'law': act['law'], 'op': '文言の改正', 'num': k})
        ctx['last_art'] = k
        self._bump('文言の改正')
        return True

    def add_articles(self, news, act, cl, ctx=None):
        for na in news:
            pid = self._new_id()
            if na['num'] in self.state:
                # 同じ改正法の後の文で旧い番号のまま付け替えられる条（地方自治法の平成11年改正など）。脇に置いて、残れば改正法の終わりで知らせる
                if ctx is not None:
                    ctx.setdefault('pending', {})[na['num']] = self.state.pop(na['num'])
                else:
                    self.unparsed.append({'date': act['date'], 'law': act['law'], 'clause': cl[:160], 'why': f'加える条 {na["num"]} がまだある'})
            self.state[na['num']] = {'id': pid, 'path': na['path'], 'caption': na['caption'], 'text': na['text']}
            self._ev(pid, {'date': act['date'], 'law': act['law'], 'op': '追加', 'num': na['num']})
        self._bump('条を加える')

    # ------------------------------------------------------------ 1 つの節
    def apply_clause(self, t, quotes, new_xml, act, ctx):
        # 「第二編第五章中第九十六条の…」「同章第三節中同条を…」の編章節の前置きは外す（位置は文脈に残す）
        m = re.match(rf'^((?:(?:同|第{NUM})(?:編|章|節|款|目)(?:の{NUM})?)+)中(?=第{NUM}条|同条)', t)
        if m:
            for tag, v in self.parse_units(m.group(1), ctx):
                ctx[tag] = v
            t = t[m.end():]
        if t.startswith('同条から') and ctx.get('last_art'):
            t = key2art(ctx['last_art']) + t[2:]
        adds_article = bool(re.search(r'次の[^。]{0,30}条[^。]{0,30}を加え', t))
        # 目次・題名・附則・別表（条の番号に関わらない）。附則の後の「同条」は附則の条なので本則に当てない
        if re.match(r'(目次|目録|題名|次の題名|附則|別表|別記|様式|付録|附録)', t):
            ctx['last_art'] = '__outside__'
            self._bump('目次・題名・附則・別表')
            return True
        if ctx.get('last_art') == '__outside__' and t.startswith('同'):
            self._bump('目次・題名・附則・別表')
            return True
        # 古い書き方の「第X条を削除す」は条の番号を残して中身だけ「削除」にする
        m = re.fullmatch(r'(.+?)を削除する', t)
        if m:
            arts = self.target_arts(m.group(1))
            if arts:
                for n in arts:
                    if n in self.state:
                        old = self.state[n]
                        self._ev(old['id'], {'date': act['date'], 'law': act['law'], 'op': '削る', 'num': n, 'note': '削除の印を残す'})
                        pid = self._new_id()
                        self._ev(pid, {'date': act['date'], 'law': act['law'], 'op': '削除の印', 'num': n})
                        self.state[n] = {'id': pid, 'path': old['path'], 'caption': '', 'text': key2art(n) + '削除'}
                self._bump('削除の印')
                return True
        # 同条の次に条を加える
        if t.startswith('同条の次に') and adds_article and ctx.get('last_art') in self.state:
            self.add_articles(self.new_articles(new_xml, self.state[ctx['last_art']]['path']), act, t, ctx)
            return True
        # 同項・同条・「…」から始まる節＝直前の条の文言の改正
        if re.match(r'(同項|同条|同号|同表|〔Q|ただし書|後段|前段)', t) and not adds_article and not re.fullmatch(rf'同条を{ART}と(?:し|する)', t):
            return self.text_edit(ctx.get('last_art'), t, quotes, new_xml, act, ctx)
        if re.match(rf'第{NUM}(?:号|項)', t):
            return self.text_edit(ctx.get('last_art'), t, quotes, new_xml, act, ctx)
        # 編・章・節の番号の付け替えや名前の変更（条の番号は変わらない）
        if re.match(rf'(?:第{NUM}編)?(?:中)?(?:(?:同|第{NUM})(?:編|章|節|款|目)(?:の{NUM})?)+', t) and not re.search(ART, t) \
                and re.search(r'(?:と(?:し|する)$|(?:編|章|節|款|目)名)', t):
            # 「第五編を第四編とする」: 条の位置（編章節）だけ付け替える（後の「第四編…を改める」が正しい条を指すように）
            mm = re.fullmatch(r'(.+?)を(.+?)と(?:し|する)', t)
            if mm:
                src, dst = self.parse_units(mm.group(1), ctx), self.parse_units(mm.group(2), ctx)
                if src and dst and src[-1][0] == dst[-1][0]:
                    tag, newv = dst[-1]
                    for a in self.state.values():
                        p = dict(a['path'])
                        if all(p.get(tg) == v for tg, v in src):
                            a['path'] = [(tg, newv if tg == tag else v) for tg, v in a['path']]
            self._bump('編章節の付け替え')
            return True
        # 「第X条第N項…」「第X条中…」「第X条の見出し…」＝文言の改正
        m = re.match(rf'({ART})(?:第{NUM}(?:項|号)|ただし書|但書|後段|前段|本文|各号|の見出し|に見出し|の前の見出し|中)', t)
        if m and not re.search(r'次の[^。]{0,30}条[^。]{0,30}を加え', t):
            return self.text_edit(art_key(m.group(1)), t, quotes, new_xml, act, ctx)
        # 1. 〔編章節／条〕を次のように改める
        m = re.fullmatch(r'(.+?)を次のように改め(?:る)?', t)
        if m and new_xml and not re.search(r'条|編|章|節|款|目', m.group(1)):
            self._bump('条に関わらない')   # 「(十一)を次のように改める」（表の項）など
            return True
        if m and new_xml:
            tgt = m.group(1)
            arts = self.target_arts(tgt)
            base_path = []
            if arts is None:
                units = self.parse_units(tgt, ctx)
                # 「第一編から第三編まで」「第二編第十三章から第二十一章まで」（前に上の単位が付くことがある）
                rng = re.fullmatch(rf'((?:(?:同|第{NUM})(?:編|章|節|款)(?:の{NUM})?)*?)第({NUM})(編|章|節|款|目)から第({NUM})(編|章|節|款|目)まで', tgt)
                two = re.fullmatch(rf'第({NUM})編及び第({NUM})編', tgt)
                if rng:
                    pre = self.parse_units(rng.group(1), ctx) if rng.group(1) else []
                    tag = UNIT[rng.group(3)]
                    lo, hi = kan2int(rng.group(2)), kan2int(rng.group(4))
                    arts = sorted([n for n, a in self.state.items() if dict(a['path']).get(tag)
                                   and all(dict(a['path']).get(t0) == v0 for t0, v0 in pre)
                                   and lo <= int(dict(a['path'])[tag].split('_')[0]) <= hi], key=key_sort)
                    base_path = pre
                elif two:
                    parts = {str(kan2int(two.group(1))), str(kan2int(two.group(2)))}
                    arts = sorted([n for n, a in self.state.items() if dict(a['path']).get('Part') in parts], key=key_sort)
                elif units:
                    arts = self.arts_in_units(units, ctx)
                    base_path = units[:-1]
                else:
                    return False
                arts = self._extend_pathless(arts)
            elif arts and arts[0] in self.state:
                base_path = self.state[arts[0]]['path']
            news = self.new_articles(new_xml, base_path)
            if not news and arts:
                return False
            self.replace_block(arts, news, act, tgt + 'を改める', ctx)
            self._bump('書き換え')
            return True
        # 2. 条を削る
        m = re.fullmatch(r'(.+?)を削(?:る|り)', t)
        if m:
            arts = self.target_arts(m.group(1))
            # 「第四編を削り」「第二編第十章を削る」: 編章節ごと削る
            if arts is None and not re.search(r'[「〔]|項|号|見出し|ただし書|但書', m.group(1)) \
                    and re.fullmatch(rf'(?:(?:同|第{NUM})(?:編|章|節|款|目)(?:の{NUM})?)+', m.group(1)):
                units = self.parse_units(m.group(1), ctx)
                arts = self._extend_pathless(self.arts_in_units(units, ctx)) if units else None
            if arts:
                for n in arts:
                    if n in self.state:
                        self._ev(self.state[n]['id'], {'date': act['date'], 'law': act['law'], 'op': '削る', 'num': n})
                        self.state.pop(n)
                self._bump('削る')
                return True
        # 3. 番号の変更（入れ替えは、行き先にいた条を同じ文の間だけ脇に置く）
        m = re.fullmatch(rf'({ART}|同条)を({ART})と(?:し|する)', t)
        if m:
            a = ctx.get('last_art') if m.group(1) == '同条' else art_key(m.group(1))
            b = art_key(m.group(2))
            pend = ctx.setdefault('pending', {})
            if a in pend or a in self.state:
                st = pend.pop(a) if a in pend else self.state.pop(a)
                if b in self.state:
                    pend[b] = self.state.pop(b)
                self.state[b] = st
                ctx['last_art'] = b
                self._ev(st['id'], {'date': act['date'], 'law': act['law'], 'op': '番号の変更', 'from': a, 'num': b})
                ctx.setdefault('moved', set()).add(st['id'])
                self._bump('番号の変更')
                return True
        # 3'. 範囲の番号の変更「第X条から第Y条までを第A条から第B条までとし」
        #     「第X条を第A条とし以下第Y条迄順次N条宛繰下グ」（昭和13年の商法改正）
        m = re.fullmatch(rf'({ART})から({ART})までを({ART})から({ART})までと(?:し|する)', t)
        m2 = re.fullmatch(rf'({ART})を({ART})とし、?以下(?:({ART})(?:まで|迄))?順次({NUM})条(?:ずつ|宛)繰(?:り)?(?:下|上)(?:ぐ|げる|グ|げ)', t)
        if m2:
            m = m2
            x, a = art_key(m2.group(1)), art_key(m2.group(2))
            if m2.group(3):
                y = art_key(m2.group(3))
            else:
                # 終わりの条が書いていない＝同じ編の終わりまで（編が分からなければ法令の終わりまで）
                src = ctx.get('pending', {}).get(x) or self.state.get(x)
                part = dict(src['path']).get('Part') if src else None
                upper = key_sort(a) if key_sort(a) > key_sort(x) else (10 ** 9,)   # 繰り下げなら行き先より手前まで（付け替え済みの条を含めない）
                cands = [k for k, s in list(self.state.items()) + list(ctx.get('pending', {}).items())
                         if key_sort(x) <= key_sort(k) < upper and s['id'] not in ctx.get('moved', set())
                         and (part is None or dict(s['path']).get('Part') in (part, None))]
                y = max(cands, key=key_sort) if cands else x
        if m:
            if not m2:
                x, y, a = art_key(m.group(1)), art_key(m.group(2)), art_key(m.group(3))
            off = int(a.split('_')[0]) - int(x.split('_')[0])
            pend = ctx.setdefault('pending', {})
            lo, hi = key_sort(x), key_sort(y)
            moved_ids = ctx.get('moved', set())
            srcs = sorted({k for k in pend if lo <= key_sort(k) <= hi} |
                          {k for k, s0 in self.state.items() if lo <= key_sort(k) <= hi and s0['id'] not in moved_ids}, key=key_sort)
            moved = []
            for k in srcs:
                st = pend.pop(k) if k in pend else self.state.pop(k)
                p = k.split('_')
                moved.append((k, '_'.join([str(int(p[0]) + off)] + p[1:]), st))
            for k, nk, st in moved:
                if nk in self.state:
                    pend[nk] = self.state.pop(nk)
                self.state[nk] = st
                ctx.setdefault('moved', set()).add(st['id'])
                self._ev(st['id'], {'date': act['date'], 'law': act['law'], 'op': '番号の変更', 'from': k, 'num': nk})
            self._bump('番号の変更')
            return True
        # 4. 繰り下げ・繰り上げ
        m = re.fullmatch(rf'({ART})から({ART})までを({NUM})条ずつ繰り(下|上)げ(?:る)?', t)
        if m:
            lo, hi, n = art_key(m.group(1)), art_key(m.group(2)), kan2int(m.group(3))
            sign = 1 if m.group(4) == '下' else -1
            moved = {}
            for k in self.arts_in_range(lo, hi):
                p = k.split('_')
                nk = '_'.join([str(int(p[0]) + sign * n)] + p[1:])
                moved[nk] = self.state.pop(k)
                self._ev(moved[nk]['id'], {'date': act['date'], 'law': act['law'], 'op': '番号の変更', 'from': k, 'num': nk})
            self.state.update(moved)
            self._bump('繰り下げ・繰り上げ')
            return True
        # 5. 条を加える
        if re.search(r'次の[^。]{0,40}を加え(?:る)?$', t) and new_xml:
            anchor = re.search(ART, t)
            ak = art_key(anchor.group(0)) if anchor else None
            base_path = self.state[ak]['path'] if ak in self.state else self.parse_units(t, ctx)
            news = self.new_articles(new_xml, base_path)
            if not news:
                self._bump('加える（条ではない）')
                return True
            self.add_articles(news, act, t, ctx)
            return True
        # 6. 条で始まるそのほか＝文言の改正
        m = re.match(rf'({ART})', t)
        if m:
            return self.text_edit(art_key(m.group(1)), t, quotes, new_xml, act, ctx)
        # 7. 条が出てこない節（号・イロハ・款名・章名・「以下順次…」など）は条の番号に関わらない
        if '条' not in t:
            self._bump('条に関わらない')
            return True
        return False

    # ------------------------------------------------------------ 1 本の改正法
    def apply_act(self, act, segs):
        """act: {law, date}・segs: segments() の結果"""
        ctx = {}
        base = act
        for sg in segs:
            act = dict(base, date=sg.get('date') or base['date'])   # ただし書で別の日にした部分はその日
            for am in sg['amends']:
                quotes = []
                masked = _mask_quotes(am['sentence'], quotes)
                s = norm_amend(masked)
                s = re.sub(r'^[(（][0-9０-９一二三四五六七八九十]+[)）]', '', s)   # 「(2)第十一条中…」の頭の番号
                if am.get('inline'):
                    s = re.sub(r'^[^第]*?(?=第)', '', s)   # 「民法第三百七十四条に…」の法令名を落とす
                # 目次を直す文は、文の中の「第四編を削り、第五編を第四編とし」も目次のことなので丸ごと飛ばす
                if re.match(r'(目次|目録)', s):
                    self._bump('目次・題名・附則・別表')
                    continue
                cls = _split_clauses(s)
                # 新しい条文は「次のように改め」「次の…を加え」の節に付ける（無ければ最後の節）
                new_at = len(cls) - 1
                if am['new']:
                    hits = [i for i, c in enumerate(cls) if re.search(r'次の', c)]
                    if hits:
                        new_at = hits[-1]
                for i, cl in enumerate(cls):
                    nx = am['new'] if i == new_at else None
                    try:
                        self._clause = cl
                        ok = self.apply_clause(cl, quotes, nx, act, ctx)
                    except Exception as e:   # 読み違いで止めない（残りを当て続け、読めなかった節として数える）
                        self.unparsed.append({'date': act['date'], 'law': act['law'], 'clause': cl[:160], 'why': 'error ' + type(e).__name__ + ' ' + str(e)[:80]})
                        continue
                    if not ok:
                        self.unparsed.append({'date': act['date'], 'law': act['law'], 'clause': cl[:160], 'why': 'parse'})
                    for tag, v in self.parse_units(cl, ctx):
                        ctx[tag] = v
        # 番号の付け替えは 1 本の改正法の中で何文にもまたがる（昭和13年の商法改正）ので、脇に置いた条は改正法の終わりで戻す
        for k, v in list(ctx.get('pending', {}).items()):
            if k in self.state:
                # 後の文で付け替えられなかった＝書き換え・追加で置き換えられた旧い条。終わったと記録する
                self._ev(v['id'], {'date': act['date'], 'law': act['law'], 'op': '別の規定に差し替え・削除', 'num': k,
                                   'note': '同じ番号の新しい条に置き換えられた（付け替えの指示なし）'})
                self._last_text[v['id']] = v['text']
                self._bump('重なって終わった')
                # 編章の書き換えの範囲を読み違えると、同じ規定が「重なって終わった」になる（平成7年の刑法の現代語化で第三十五条など）。
                # 同じ番号の新しい条と組にして、書き換えと同じく Jev で「同じ規定か」を決め直す候補に入れる
                new = self.state[k]
                if not is_deleted(new['text']) and not is_deleted(v['text']):
                    cand = {'old': k, 'old_id': v['id'], 'sim': round(sim(v['text'], new['text']), 3),
                            'old_caption': v['caption'], 'old_text': v['text'][:1500]}
                    rv = next((r for r in self.reviews if r['law'] == act['law'] and r['new_num'] == k and r['new_id'] == new['id']), None)
                    if rv:
                        if not any(c['old_id'] == v['id'] for c in rv['cands']):
                            rv['cands'].append(cand)
                    else:
                        self.reviews.append({'law': act['law'], 'date': act['date'], 'new_num': k, 'new_id': new['id'],
                                             'new_caption': new['caption'], 'new_text': new['text'][:1500], 'via': '重なり', 'cands': [cand]})
            else:
                self.state[k] = v
        ctx['pending'] = {}

    # ------------------------------------------------------------ e-Gov の版どうしの差分でつなぐ（改め文が手元に無い 2018 年以降）
    def apply_version(self, new_arts, act, same_text=0.8):
        """new_arts: 次の版の条（main_articles の形）。番号の付け替えは本文の近さで見つけ、迷う所は reviews に残す"""
        newmap = {a['num']: a for a in new_arts}
        olds = dict(self.state)
        changed_old = {}   # 同じ番号で中身が大きく変わった旧条（付け替え・書き換えの候補）
        for n, na in newmap.items():
            if n not in olds:
                continue
            o = olds[n]
            if o['text'] == na['text']:
                o.update(path=na['path'], caption=na['caption'])
                continue
            if is_deleted(na['text']) and not is_deleted(o['text']):
                self._ev(o['id'], {'date': act['date'], 'law': act['law'], 'op': '削る', 'num': n, 'note': '削除の印になった'})
                pid = self._new_id()
                self._ev(pid, {'date': act['date'], 'law': act['law'], 'op': '削除の印', 'num': n})
                self.state[n] = {'id': pid, 'path': na['path'], 'caption': na['caption'], 'text': na['text']}
                continue
            s0 = sim(o['text'], na['text'])
            if s0 >= same_text:
                self._ev(o['id'], {'date': act['date'], 'law': act['law'], 'op': '文言の改正', 'num': n})
                self.state[n] = {'id': o['id'], 'path': na['path'], 'caption': na['caption'], 'text': na['text']}
                continue
            changed_old[n] = o
        removed = {n: o for n, o in olds.items() if n not in newmap}
        pool = {**removed, **changed_old}        # 行き先を探す旧条
        targets = [na for n, na in newmap.items() if n not in olds or n in changed_old]
        used = set()
        for na in targets:
            if is_deleted(na['text']):
                if na['num'] in changed_old:
                    pass
                pid = self._new_id()
                self._ev(pid, {'date': act['date'], 'law': act['law'], 'op': '削除の印', 'num': na['num']})
                self.state[na['num']] = {'id': pid, 'path': na['path'], 'caption': na['caption'], 'text': na['text']}
                continue
            cands = sorted(((sim(o['text'], na['text']), on) for on, o in pool.items()), reverse=True)[:5]
            best = next(((s1, on) for s1, on in cands if on not in used), (0.0, None))
            if best[1] is not None and best[0] >= same_text:
                on = best[1]
                used.add(on)
                o = pool[on]
                op = '番号の変更' if on != na['num'] else '文言の改正'
                self._ev(o['id'], {'date': act['date'], 'law': act['law'], 'op': op, 'from': on, 'num': na['num']})
                pid = o['id']
            elif na['num'] in changed_old and sim(changed_old[na['num']]['text'], na['text']) >= SAME and na['num'] not in used:
                on = na['num']
                used.add(on)
                pid = changed_old[on]['id']
                self._ev(pid, {'date': act['date'], 'law': act['law'], 'op': '書き直し', 'from': on, 'num': na['num'],
                               'sim': round(sim(changed_old[on]['text'], na['text']), 2), 'via': '版の差分'})
            else:
                pid = self._new_id()
                self._ev(pid, {'date': act['date'], 'law': act['law'], 'op': '新しい規定', 'num': na['num'],
                               'sim_best': round(best[0], 2), 'via': '版の差分'})
            if cands and not (best[1] is not None and best[0] >= same_text):
                self.reviews.append({'law': act['law'], 'date': act['date'], 'new_num': na['num'], 'new_id': pid,
                                     'new_caption': na['caption'], 'new_text': na['text'][:1500], 'via': '版の差分',
                                     'cands': [{'old': on, 'old_id': pool[on]['id'], 'sim': round(s1, 3),
                                                'old_caption': pool[on]['caption'], 'old_text': pool[on]['text'][:1500]} for s1, on in cands]})
            self.state.pop(na['num'], None)
            self.state[na['num']] = {'id': pid, 'path': na['path'], 'caption': na['caption'], 'text': na['text']}
        for on, o in pool.items():
            if on not in used:
                self._ev(o['id'], {'date': act['date'], 'law': act['law'], 'op': '別の規定に差し替え・削除', 'num': on, 'via': '版の差分'})
                if on not in newmap:
                    self.state.pop(on, None)
            elif on not in newmap and self.state.get(on, {}).get('id') == o['id']:
                # 別の番号に付け替えた旧い番号（労働契約法の旧第二十二条 → 第二十一条など）を、今の条の一覧に残さない
                self.state.pop(on, None)
        self._bump('版の差分')

    # ------------------------------------------------------------ e-Gov の一番古い版に合わせる（名古屋大学のデータの書き誤りなど、規則では直せない食い違い）
    def reconcile(self, eg_arts, date, revive_sim=0.6):
        """eg_arts: e-Gov の版の条。こちらに無い条は、同じ番号で終わった規定の本文が近ければ戻す（無ければ新しく置く）。
        こちらにだけある条は、その日に終わったことにする。どれも出来事に「e-Gov に合わせた」と残す"""
        eg = {a['num']: a for a in eg_arts}
        fixed = {'revived': [], 'added': [], 'ended': []}
        for n, a in eg.items():
            if n in self.state:
                continue
            best, bs = None, 0.0
            for pid, evs in self.lineage.items():
                if any(e.get('num') == n for e in evs) and pid not in {x['id'] for x in self.state.values()}:
                    s0 = sim(self._last_text.get(pid, ''), a['text'])
                    if s0 > bs:
                        best, bs = pid, s0
            if best and bs >= revive_sim:
                # 誤って終わらせた出来事（名古屋大学のデータの書き誤りの「第二編第二章を削る」など）を取り消し、消えた日から
                # ずっと続いていたことにする（地方自治法10〜13条）。その番号をほかの規定が後で使っていたら取り消さない（本当に入れ替わった）
                evs = self.lineage[best]
                end_i = max((i for i, e in enumerate(evs) if e['op'] in END_OPS and e.get('num') == n), default=None)
                if end_i is not None:
                    end_d = evs[end_i].get('date') or ''
                    taken = any(pid != best and any(e.get('num') == n and (e.get('date') or '') >= end_d and e['op'] not in END_OPS for e in es)
                                for pid, es in self.lineage.items())
                    if not taken and not any(e.get('num') and e.get('num') != n for e in evs[end_i + 1:]):
                        cancelled = evs.pop(end_i)
                        self._ev(best, {'date': date, 'op': 'e-Gov に合わせた（誤った終わりを取り消した）', 'num': n, 'sim': round(bs, 2),
                                        'cancelled': {k: cancelled.get(k) for k in ('date', 'law', 'op')}})
                        self.state[n] = {'id': best, 'path': a['path'], 'caption': a['caption'], 'text': a['text']}
                        fixed['revived'].append(n)
                        continue
                self._ev(best, {'date': date, 'op': 'e-Gov に合わせた（戻した）', 'num': n, 'sim': round(bs, 2)})
                self.state[n] = {'id': best, 'path': a['path'], 'caption': a['caption'], 'text': a['text']}
                fixed['revived'].append(n)
            else:
                pid = self._new_id()
                self._ev(pid, {'date': date, 'op': 'e-Gov に合わせた（置いた）', 'num': n})
                self.state[n] = {'id': pid, 'path': a['path'], 'caption': a['caption'], 'text': a['text']}
                fixed['added'].append(n)
        for n in [n for n in self.state if n not in eg]:
            self._ev(self.state[n]['id'], {'date': date, 'op': '削る', 'num': n, 'note': 'e-Gov に合わせた（e-Gov に無い）'})
            self.state.pop(n)
            fixed['ended'].append(n)
        # 両方にある条は、本文を e-Gov の版に置き換える（規定 ID はそのまま）。改め文の当て漏れで古い本文が残っていると、
        #   この後の版の差分で「書き直し」と誤って見つけ、Jev が別の規定と判定して系譜が切れる（租税特別措置法37条など。
        #   裁決・質疑応答事例のセッションの直し 79c729e を取り込んだもの）
        fixed['text_synced'] = 0
        for n, a in eg.items():
            st = self.state.get(n)
            if st and st['text'] != a['text']:
                st.update(path=a['path'], caption=a['caption'], text=a['text'])
                fixed['text_synced'] += 1
        return fixed

    def to_json(self):
        # 規定ごとの最後の本文（終わった規定は終わる直前・残っている規定は今）。ほかの法令の受け皿を探すときに使う
        last = {pid: t[:1500] for pid, t in self._last_text.items()}
        last.update({a['id']: a['text'][:1500] for a in self.state.values()})
        # state: 今の条の中身（月に 1 回、e-Gov の新しい版を足して続きを作るときに読み戻す。from_json）
        return {'lineage': self.lineage, 'final': {n: a['id'] for n, a in self.state.items()}, 'reviews': self.reviews, 'last_text': last,
                'state': {n: {'id': a['id'], 'path': [list(x) for x in a['path']], 'caption': a['caption'], 'text': a['text']} for n, a in self.state.items()},
                'n': self._n}

    @classmethod
    def from_json(cls, J):
        """to_json の結果から続きを作れる形に戻す（state の無い古い lineage.json は戻せない）"""
        if not J.get('state'):
            raise ValueError('lineage.json に state が無い（build.py で作り直す）')
        L = cls([], None)
        L.lineage = J['lineage']
        L.reviews = J.get('reviews') or []
        L.state = {n: {'id': a['id'], 'path': [tuple(x) for x in a['path']], 'caption': a['caption'], 'text': a['text']} for n, a in J['state'].items()}
        L._last_text = {pid: t for pid, t in (J.get('last_text') or {}).items() if pid not in {a['id'] for a in L.state.values()}}
        L._n = J.get('n') or max((int(p[1:]) for p in L.lineage), default=0)
        return L


def _mask_quotes(s, quotes):
    s = re.sub(r'\s+', '', s)
    out, depth, buf = [], 0, []
    for ch in s:
        if ch == '「':
            depth += 1
        if depth:
            buf.append(ch)
        else:
            out.append(ch)
        if ch == '」' and depth:
            depth -= 1
            if depth == 0:
                out.append('〔Q%d〕' % len(quotes))
                quotes.append(''.join(buf)[1:-1])
                buf = []
    return ''.join(out)


def _split_clauses(s):
    parts = re.split(r'(?<=とし|削り|改め|加え|付し|下げ|上げ|移し)、', s)
    return [p.strip('。 ') for p in parts if p.strip('。 ')]
