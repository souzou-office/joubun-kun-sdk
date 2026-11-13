# 改正法の施行日（附則の最初の条から読む）
#   返す形: {'date': 'YYYY-MM-DD' か None, 'lo': 下限, 'hi': 上限, 'how': 読み方, 'partial': ただし書で別の日がある}
#   「政令で定める日」は 1947〜2016 年の施行期日の政令が手元のどのデータにも無いので、公布日〜書いてある最大の期間の幅で持つ。
#   e-Gov の改正履歴（2012〜2016 年以降の分）に載っていれば、そちらの日（段ごと）を正にする（build.py）。
import datetime
import re

from .kansuji import kan2int, parse_jp_date
from .xmlarts import shinji
import unicodedata

N = r'[〇一二三四五六七八九十百千]+'


def _add(date, n, unit):
    d = datetime.date.fromisoformat(date)
    if unit == '日':
        return (d + datetime.timedelta(days=n)).isoformat()
    months = n * (12 if unit == '年' else 1)
    y, m = divmod(d.month - 1 + months, 12)
    y += d.year
    m += 1
    import calendar
    day = min(d.day, calendar.monthrange(y, m)[1])
    return datetime.date(y, m, day).isoformat()


def _date_phrase(s, promulgated):
    """「公布の日」「平成二十九年四月一日」「公布の日から起算して六月を経過した日」など、日を表す句 → (date, hi, how)"""
    s = s or ''
    if re.search(r'公布の日(?:から起算して|$|。)', s) and not re.search(r'起算して', s):
        return promulgated, promulgated, '公布の日'
    m = re.search(rf'公布の日から起算して({N})(日|月|年)を経過した日', s)
    if m:
        d = _add(promulgated, kan2int(m.group(1)), m.group(2))
        return d, d, '公布から起算'
    m = re.search(r'((?:明治|大正|昭和|平成|令和)(?:元|[〇一二三四五六七八九十]+)年[〇一二三四五六七八九十]+月[〇一二三四五六七八九十]+日)', s)
    if m:
        d = parse_jp_date(m.group(1))
        if d:
            return d, d, '日付'
    m = re.search(rf'公布の日から起算して({N})(日|月|年)を超えない範囲内において政令で定める日', s)
    if m:
        return None, _add(promulgated, kan2int(m.group(1)), m.group(2)), '政令で定める日（期限つき）'
    return None, None, None


IROHA = "イロハニホヘトチリヌルヲワカヨタレソツネナラム"


def read_exceptions(suppl_text, promulgated):
    """ただし書の各号「一　第二十七条の規定　公布の日」→ [{'head': 規定の名前, 'date','hi','how'}]"""
    t = shinji(unicodedata.normalize('NFKC', suppl_text or ''))
    t = re.sub(r'\s+', '', t)
    parts = re.split(r'ただし、|但し、', t, maxsplit=1)
    if len(parts) < 2:
        return []
    body = parts[1][:6000]
    out = []
    # 「次の各号に掲げる規定は、当該各号に定める日から施行する。一…二…」
    #   イロハで入れ子になった号（「…の規定五次に掲げる規定平成三十年四月一日イ…」）は「規定」の直後に次の号が来る
    items = re.split(r'(?<=[。日])(?=[一二三四五六七八九十]+(?:の[一二三四五六七八九十]+)?[^一二三四五六七八九十日年月])'
                     r'|(?<=規定)(?=[一二三四五六七八九十]+(?:の[一二三四五六七八九十]+)?(?:次に掲げる規定|第[一二三四五六七八九十百]+条))', body)
    for it in items:
        m = re.match(r'^[一二三四五六七八九十]+(?:の[一二三四五六七八九十]+)?(.*)$', it)
        if not m:
            continue
        rest = m.group(1)
        # 「次に掲げる規定　平成二十九年十月一日　イ　第一条中所得税法…の改正規定　ロ　…」（日が先・規定がイロハで続く）
        nm = re.match(r'^次に掲げる規定(公布の日(?:から起算して[^。イ]*?(?:経過した日|政令で定める日))?|(?:明治|大正|昭和|平成|令和)[^。イ]{0,12}日)(.*)$', rest)
        if nm:
            d, hi, how = _date_phrase(nm.group(1), promulgated)
            for sub in re.split(r'(?<!号)(?<!目)(?=[イロハニホヘトチリヌルヲワカヨタレソツネナラム](?:第|附則|同法|同条))', nm.group(2)):
                sub = sub[1:] if sub[:1] in IROHA else sub
                if sub:
                    out.append({'head': sub, 'date': d, 'hi': hi, 'how': how})
            continue
        # 規定の名前と日の境目: 日を表す句が最後に来る
        dm = re.search(r'(公布の日(?:から起算して[^。]*?(?:経過した日|政令で定める日))?|(?:明治|大正|昭和|平成|令和)[^。]{0,12}日)。?$', rest)
        if not dm:
            continue
        d, hi, how = _date_phrase(dm.group(1), promulgated)
        out.append({'head': rest[:dm.start()], 'date': d, 'hi': hi, 'how': how})
    # 「…の規定は、公布の日から施行する。」の 1 文の形
    if not out:
        m = re.match(r'(.{1,400}?)(?:の規定)?は、(.{1,80}?)から施行する', body)
        if m:
            d, hi, how = _date_phrase(m.group(2), promulgated)
            if how:
                out.append({'head': m.group(1), 'date': d, 'hi': hi, 'how': how})
    return out


def read_enforcement(suppl_text, promulgated):
    t = shinji(unicodedata.normalize('NFKC', suppl_text or ''))
    t = re.sub(r'\s+', '', t)
    head = re.split(r'ただし、|但し、|但シ', t, maxsplit=1)
    main = head[0][:400]
    partial = len(head) > 1 and bool(re.search(r'施行する|施行ス', head[1][:300]))
    out = {'date': None, 'lo': promulgated, 'hi': None, 'how': None, 'partial': partial}
    # 公布の日から施行
    if re.search(r'公布の日から(?:これを)?施行|公布ノ日ヨリ之ヲ施行|公布の日より施行', main):
        out.update(date=promulgated, hi=promulgated, how='公布の日')
        return out
    # 日本国憲法施行の日
    if re.search(r'日本国憲法施行の日から', main):
        out.update(date='1947-05-03', hi='1947-05-03', how='日本国憲法施行の日')
        return out
    # 公布の日から起算して N 日（月・年）を経過した日
    m = re.search(rf'公布の日から起算して({N})(日|月|年)を経過した日から', main)
    if m:
        d = _add(promulgated, kan2int(m.group(1)), m.group(2))
        out.update(date=d, hi=d, how='公布から起算')
        return out
    # 明示の日付
    m = re.search(r'((?:明治|大正|昭和|平成|令和)(?:元|[〇一二三四五六七八九十]+)年[〇一二三四五六七八九十]+月[〇一二三四五六七八九十]+日)(?:から|ヨリ)', main)
    if m:
        d = parse_jp_date(m.group(1))
        if d:
            out.update(date=d, hi=d, how='日付')
            return out
    # 政令（勅令）で定める日（〇〇を超えない範囲内）
    m = re.search(rf'公布の日から起算して({N})(日|月|年)を超えない範囲内において(?:政令|勅令)で定める日', main)
    if m:
        out.update(hi=_add(promulgated, kan2int(m.group(1)), m.group(2)), how='政令で定める日（期限つき）')
        return out
    if re.search(r'(?:政令|勅令)で(?:これを)?定める|勅令ヲ以テ(?:之ヲ)?定ム|勅令ヲ以テ定ムル', main):
        out.update(how='政令・勅令で定める日（期限なし）')
        return out
    # 「この法律は、民事訴訟法の施行の日から施行する」＝ほかの法律の施行日（その日は手元のデータに無いことが多い）
    m = re.search(r'この法律は、(.{1,80}?)の施行の日から施行する', main)
    if m:
        out.update(how='ほかの法律の施行の日', other=m.group(1))
        return out
    out['how'] = '読めない'
    return out
