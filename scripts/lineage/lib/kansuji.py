# 漢数字と条番号（条キー「70_6_2」＝第七十条の六の二）
import re

KD = {'〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
NUM = r'[〇一二三四五六七八九十百千]+'
ART = rf'第{NUM}条(?:の{NUM})*'


def kan2int(s):
    s = (s or '').strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    total, cur = 0, 0
    for ch in s:
        if ch in KD:
            cur = cur * 10 + KD[ch]
        elif ch == '十':
            total += (cur or 1) * 10
            cur = 0
        elif ch == '百':
            total += (cur or 1) * 100
            cur = 0
        elif ch == '千':
            total += (cur or 1) * 1000
            cur = 0
        else:
            return None
    return total + cur


def int2kan(n):
    d = '〇一二三四五六七八九'
    s = ''
    for v, u in [(1000, '千'), (100, '百'), (10, '十')]:
        q, n = divmod(n, v)
        if q:
            s += ('' if q == 1 else d[q]) + u
    return s + (d[n] if n else '')


def art_key(s):
    """「第七十条の六の二」→ '70_6_2'（条でなければ None）"""
    m = re.match(rf'第({NUM})条((?:の{NUM})*)', s or '')
    if not m:
        return None
    subs = [kan2int(x) for x in re.findall(NUM, m.group(2))]
    return '_'.join(str(x) for x in [kan2int(m.group(1))] + subs)


def key2art(k):
    p = [int(x) for x in k.split('_')]
    return '第' + int2kan(p[0]) + '条' + ''.join('の' + int2kan(x) for x in p[1:])


def key_sort(k):
    return tuple(int(x) for x in k.split('_'))


ERA = {'明治': 1, '大正': 2, '昭和': 3, '平成': 4, '令和': 5}
ERA_BASE = {1: 1867, 2: 1911, 3: 1925, 4: 1988, 5: 2018}
ERA_NAME = {v: k for k, v in ERA.items()}


def lawnum_kanji(era, year, num, kind='法律'):
    """(3, 23, 131) → 「昭和二十三年法律第百三十一号」"""
    y = '元' if year == 1 else int2kan(year)
    return f'{ERA_NAME[era]}{y}年{kind}第{int2kan(num)}号'


def parse_egov_id(law_id):
    """'323AC0000000131' → (3, 23, 'AC', 131)。議員立法は番号の前に印が付く（'325AC1000000100' 公職選挙法・'326AC0100000219' 土地収用法）ので、
    下 7 桁を番号にする"""
    m = re.fullmatch(r'(\d)(\d\d)([A-Z]{2})(\d{10})', law_id)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), m.group(3), int(m.group(4)[3:])


def west_year(era, year):
    return ERA_BASE[era] + year


def parse_jp_date(s):
    """「平成十六年十二月一日」「平成16年12月1日」→ '2004-12-01'（読めなければ None）"""
    s = s or ''
    m = re.search(r'(明治|大正|昭和|平成|令和)(元|[〇一二三四五六七八九十]+|\d+)年([〇一二三四五六七八九十]+|\d+)月([〇一二三四五六七八九十]+|\d+)日', s)
    if not m:
        return None
    y = 1 if m.group(2) == '元' else kan2int(m.group(2))
    mo, d = kan2int(m.group(3)), kan2int(m.group(4))
    if not (y and mo and d):
        return None
    return f'{west_year(ERA[m.group(1)], y)}-{mo:02d}-{d:02d}'
