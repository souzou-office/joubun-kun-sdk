# 法令 XML（e-Gov の法令標準 XML と、それを広げた名古屋大学の法令 XML）から条を取り出す・本文の近さを測る
import re
import unicodedata
import xml.etree.ElementTree as ET

from .kansuji import NUM

LEVELS = ['Part', 'Chapter', 'Section', 'Subsection', 'Division']

# 旧字体 → 新字体（法令によく出るものだけ）
KYU = ('條条爲為擔担權権賣売讓譲證証繼継續続舊旧從従對対國国會会與与辨弁價価據拠餘余實実數数變変區区處処當当'
       '單単號号圖図廢廃學学營営醫医總総歸帰屬属擧挙豫予萬万竝並氣気經経惡悪應応檢検驗験傳伝轉転惠恵讀読寫写兩両'
       '滿満濟済狀状獨独盡尽禮礼稅税縣県聽聴辯弁遲遅鐵鉄關関隨随險険靜静顯顕體体黨党亂乱佛仏來来兒児內内劃画勞労'
       '卽即參参嚴厳圍囲壓圧壞壊壽寿將将專専屆届廣広廳庁彈弾徑径徵徴恆恒戰戦拂払拔抜擇択擴拡收収效効敍叙斷断樂楽'
       '樣様殘残每毎沒没溫温爭争產産畫画發発盜盗眞真祕秘稱称缺欠聲声臺台舍舎藏蔵蟲虫衞衛裝装覺覚觀観觸触譯訳豐豊'
       '貳弐賴頼贊賛輕軽辭辞遞逓釋釈錢銭鑛鉱閱閲雙双靈霊僞偽淨浄剩剰卷巻拜拝揭掲曆暦歷歴禪禅繩縄纖繊黃黄默黙齊斉'
       '壹壱龜亀廐厩囑嘱巢巣擊撃晝昼渴渇罐缶薰薫隱隠廳庁驛駅齡齢髮髪亞亜惡悪壯壮奧奥孃嬢寢寝峽峡巖巌恥恥戲戯拜拝'
       '晚晩條条棧桟榮栄歡歓毆殴淚涙渊淵滯滞燈灯爐炉犧犠獵猟瓣弁畵画癡痴礙碍禱祷稻稲穗穂竊窃粹粋絲糸縱縦繪絵罰罰'
       '聯連膽胆臟臓舊旧莊荘萬万蠶蚕裏裏褒褒觀観貓猫賣売贈贈趨趨跡跡蹟跡輛両辨弁邊辺鄕郷醉酔釀醸錄録鎭鎮鑄鋳'
       '陷陥隸隷雞鶏靑青韻韻顏顔飮飲餘余騷騒驅駆鬪闘鷄鶏麥麦黑黒點点齋斎')
KYU_MAP = {KYU[i]: KYU[i + 1] for i in range(0, len(KYU) - 1, 2)}


def shinji(s):
    return ''.join(KYU_MAP.get(c, c) for c in s)


def text_of(el):
    return re.sub(r'\s+', '', ''.join(el.itertext()))


def _expand_num(num):
    """Num="367:368"（1 つの Article にまとめた削除）を 1 条ずつに分ける"""
    if ',' in num:
        return [x for part in num.split(',') for x in _expand_num(part)]
    if ':' not in num:
        return [num]
    a, b = num.split(':', 1)
    if a.isdigit() and b.isdigit():
        return [str(x) for x in range(int(a), int(b) + 1)]
    pa, pb = a.split('_'), b.split('_')
    if len(pa) == len(pb) == 2 and pa[0] == pb[0] and pa[1].isdigit() and pb[1].isdigit():
        return [f'{pa[0]}_{x}' for x in range(int(pa[1]), int(pb[1]) + 1)]
    return [a, b]


def _num_from_title(title):
    from .kansuji import art_key
    t = shinji(unicodedata.normalize('NFKC', title)).replace('ノ', 'の').replace('乃至', 'から')
    m = re.fullmatch(rf'(第{NUM}条(?:の{NUM})*)(?:(から|及び|及ヒ)(第{NUM}条(?:の{NUM})*)(?:まで)?)?', t)
    if not m:
        return None
    a = art_key(m.group(1))
    if m.group(3):
        b = art_key(m.group(3))
        if not (a and b):
            return a
        return f'{a}:{b}' if m.group(2) == 'から' else f'{a},{b}'
    return a


def walk_articles(el, path, out):
    """el の下の条を [{num, path, caption, text}] にして out に足す（編章節の位置つき）"""
    for ch in el:
        if ch.tag in LEVELS:
            walk_articles(ch, path + [(ch.tag, ch.get('Num'))], out)
        elif ch.tag == 'Article':
            num = ch.get('Num') or ''
            ti = ch.find('ArticleTitle')
            # 番号は条の見出し（「第十六条の二」「第七十三條乃至第七十六條」）から取る。読めなければ Num 属性
            #   名古屋大学のデータには、改正法の NewProvision の Num が「2」のように崩れているものがある
            if ti is not None:
                tnum = _num_from_title(text_of(ti))
                if tnum:
                    num = tnum
            cap = ch.find('ArticleCaption')
            t = text_of(ch)
            rng = num.split(':', 1) if (':' in num and ',' not in num) else None
            for n in _expand_num(num):
                if not re.fullmatch(r'\d+(?:_\d+)*', n):
                    continue
                item = {'num': n, 'path': list(path), 'caption': text_of(cap) if cap is not None else '', 'text': t}
                if rng:
                    item['range'] = rng   # 「第三十二条から第五百条まで　削除」: 範囲の中の枝番も含めて消えている
                out.append(item)
        elif ch.tag in ('MainProvision', 'LawBody', 'Law', 'NewProvision'):
            walk_articles(ch, path, out)
    return out


def main_articles(xml_paths):
    """法令 XML（1 本か、a・b に分かれた複数）の本則の条"""
    out = []
    for p in xml_paths:
        root = ET.parse(p).getroot()
        body = root.find('LawBody')
        mp = body.find('MainProvision') if body is not None else None
        if mp is not None:
            walk_articles(mp, [], out)
    return out


# ---------------------------------------------------------------- 本文の近さ（漢字の続きの中の 2 字と 1 字の重なり・Dice）
TITLE_RE = re.compile(rf'^第{NUM}条(?:の{NUM})*(?:(?:から|及び)第{NUM}条(?:の{NUM})*(?:まで)?)?')


def feats(t):
    t = TITLE_RE.sub('', shinji(t))
    f = set()
    for r in re.findall(r'[一-鿿々]+', t):
        if len(r) == 1:
            f.add(r)
        for i in range(len(r) - 1):
            f.add(r[i:i + 2])
    return f


def sim(a, b):
    A, B = feats(a), feats(b)
    if not A or not B:
        return 0.0
    return 2 * len(A & B) / (len(A) + len(B))


def strip_caption(t):
    return re.sub(r'^（[^）]*）', '', t)


def is_deleted(t):
    t = strip_caption(shinji(unicodedata.normalize('NFKC', t)).replace('ノ', 'の').replace('乃至', 'から').replace('及ヒ', '及び'))
    t = TITLE_RE.sub('', t)
    return t.strip() in ('削除', '削除ス')


def norm_amend(s):
    """改め文を今の書き方に寄せる（旧字・カタカナ・乃至）"""
    s = shinji(unicodedata.normalize('NFKC', s))
    rep = [('乃至', 'から'), ('左ノ如ク', '次のように'), ('左ノ通', '次のように'), ('左の通り', '次のように'),
           ('左のように', '次のように'), ('左の如く', '次のように'), ('削除ス', '削除する'), ('ヲ', 'を'), ('ノ', 'の'), ('ニ', 'に'), ('ト', 'と'), ('ハ', 'は'),
           ('及ヒ', '及び'), ('改ム', '改める'), ('削ル', '削る'), ('加フ', '加える'), ('とス', 'とする'), ('とシ', 'とし'),
           ('削リ', '削り'), ('改メ', '改め'), ('加ヘ', '加え'), ('附ス', '付する'), ('次ニ', '次に'), ('ヨリ', 'より'), ('マテ', 'まで'), ('左の', '次の'), ('左に', '次に')]
    for a, b in rep:
        s = s.replace(a, b)
    # 「乃至」の言い換えで欠けた「まで」を補う（枝番の途中で切らない）
    s = re.sub(rf'(第{NUM}条(?:の{NUM})*)から(第{NUM}条(?:の{NUM})*)(?![〇一二三四五六七八九十百千の]|まで)', r'\1から\2まで', s)
    s = re.sub(r'及(?=第)', '及び', s).replace('及びび', '及び')
    # 旧い書き方は読点を打たない（「…を次のように改め第四編を削り第五編を第四編とする」）
    s = re.sub(r'(?<=改め|削り|とし|加え)(?=第|同)', '、', s)
    # 対象に付いた括弧書き（「第一編及第二編(第一条から第二百六十二条の三まで)」）は外す
    s = re.sub(r'(?<=[編章節款目条])\([^()]*\)(?=を)', '', s)
    return s
