# 改正法の XML から、ある法令を直している部分（改め文と、入れる新しい条文）を取り出す
import re
import xml.etree.ElementTree as ET

from .xmlarts import norm_amend, text_of

TAIL = (r'(?:の一部を次の(?:ように|通り)?改正|中次の(?:ように|通り)?(?:改正|追加)|の一部を次のように改める'
        r'|中[^。]{0,80}(?:改める|を削る|を加える|改め)|第[^。]{0,40}を次のように改める|に次の[^。]{0,10}を加える'
        r'|第[^。]{0,60}中[^。]{0,160}(?:改める|を削る|を加える))')


def decl_regex(names, lawnums):
    """names: 題名（今と昔）・lawnums: 「昭和二十三年法律第百三十一号」など"""
    alts = []
    num = '|'.join(re.escape(n) for n in lawnums)
    if names:
        name = '|'.join(re.escape(n) for n in sorted(set(names), key=len, reverse=True))
        # 正規化（NFKC）で全角の括弧は半角になる
        alts.append(rf'(?<![一-鿿])(?:{name})(?:[（(](?:{num})[）)])?' if num else rf'(?<![一-鿿])(?:{name})')
    if num:
        alts.append(rf'[（(](?:{num})[）)]')
    return re.compile(rf'(?:{"|".join(alts)}){TAIL}')


def _new_of(amend):
    news = amend.findall('NewProvision')
    if not news:
        return None
    # 目次と本文で NewProvision が複数に分かれることがある（昭和22年法律第222号）
    return '<NewProvision>' + ''.join(''.join(ET.tostring(c, encoding='unicode') for c in n) for n in news) + '</NewProvision>'


def segments(xml_paths, names, lawnums):
    rx = decl_regex(names, lawnums)
    out = []
    for p in xml_paths:
        root = ET.parse(p).getroot()
        parent = {c: q for q in root.iter() for c in q}
        for par in root.iter('Paragraph'):
            ps = par.find('ParagraphSentence')
            if ps is None:
                continue
            decl = text_of(ps)
            if not rx.search(norm_amend(decl)):
                continue
            amends = []
            for a in par:
                if a.tag != 'AmendProvision':
                    continue
                aps = a.find('AmendProvisionSentence')
                sent = text_of(aps) if aps is not None else ''
                new = _new_of(a)
                if not sent and new:
                    prev = amends[-1] if amends else None
                    # 文だけの AmendProvision（「…を次のように改める」「…を加える」で終わる）の次に、文の無い NewProvision だけが来る形をまとめる
                    if prev and not prev['new'] and re.search(r'(次のように改める|加える|改む|加ふ|左ノ如ク改ム|左ノ通改ム)。?$', norm_amend(prev['sentence'])):
                        prev['new'] = new
                        continue
                    # 文が無く条文だけがある（データで改め文が抜けている）→ その条を書き換えると読む
                    arts = [a2 for a2 in ET.fromstring(new).iter('Article') if a2.find('ArticleTitle') is not None]
                    if arts:
                        for art in arts:   # 1 条（「第七十三條乃至第七十六條」のようなまとめも 1 つ）ずつ書き換える
                            amends.append({'sentence': text_of(art.find('ArticleTitle')) + 'を次のように改める。', 'implied': True,
                                           'new': '<NewProvision>' + ET.tostring(art, encoding='unicode') + '</NewProvision>'})
                        continue
                amends.append({'sentence': sent, 'new': new})
            if not amends:
                # 宣言と改め文が 1 文になっている古い形（「民法第三百七十四條ニ左ノ一項ヲ加フ」）は、その文を改め文として扱う
                amends = [{'sentence': decl, 'new': None, 'inline': True}]
            # 改正法のどの条（「第二十七条」）か・附則の中か（施行日のただし書と突き合わせる）
            art_title, in_suppl, q = None, False, par
            while q is not None:
                if q.tag == 'Article' and art_title is None:
                    t = q.find('ArticleTitle')
                    art_title = text_of(t) if t is not None else None
                if q.tag == 'SupplProvision':
                    in_suppl = True
                q = parent.get(q)
            out.append({'decl': decl, 'amends': amends, 'file': p, 'act_article': art_title, 'in_suppl': in_suppl})
    return out


def suppl_main(xml_paths):
    """改正法の最初の附則（施行期日の条）の文。施行日を読むのに使う"""
    for p in xml_paths:
        root = ET.parse(p).getroot()
        for sp in root.iter('SupplProvision'):
            if sp.get('AmendLawNum'):
                continue
            return text_of(sp)
    return ''
