# 条の系譜の確認（¥0・ネットに出ない・LLM を呼ばない）
#   python -I -X utf8 scripts/lineage/check_lineage.py
#   手で作った小さな法令と改め文で、番号の付け替え・削除・追加・入れ替え・範囲の付け替え・目次の文・施行日・Jev の決め直し・版の差分を確かめる
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.engine import Lineage                                   # noqa: E402
from lib.enforce import read_enforcement, read_exceptions        # noqa: E402
from lib.identity import Identity, pair_id                       # noqa: E402
from lib.kansuji import art_key, int2kan, kan2int, key2art, lawnum_kanji, parse_jp_date   # noqa: E402
from lib.resolve import Resolver                                 # noqa: E402
from lib.segments import decl_regex                              # noqa: E402
from lib.xmlarts import is_deleted, norm_amend, walk_articles    # noqa: E402
import xml.etree.ElementTree as ET                               # noqa: E402

fails = []


def check(name, cond):
    print(('OK  ' if cond else 'NG  ') + name)
    if not cond:
        fails.append(name)


def art(num, text, part='1', chap='1', cap=''):
    return {'num': num, 'path': [('Part', part), ('Chapter', chap)], 'caption': cap, 'text': text}


def new_xml(*arts):
    body = ''.join(f'<Article Num="{n}"><ArticleTitle>{t}</ArticleTitle><Paragraph Num="1"><ParagraphSentence><Sentence>{s}</Sentence>'
                   f'</ParagraphSentence></Paragraph></Article>' for n, t, s in arts)
    return f'<NewProvision>{body}</NewProvision>'


def seg(*amends):
    return [{'decl': '甲法の一部を次のように改正する。', 'amends': [{'sentence': s, 'new': n} for s, n in amends]}]


# ---------------------------------------------------------------- 漢数字・条番号
check('漢数字: 千百四十六', kan2int('千百四十六') == 1146)
check('漢数字: 九一（位取り）', kan2int('九一') == 91)
check('条キー: 第七十条の六の二', art_key('第七十条の六の二') == '70_6_2')
check('条キーから見出し', key2art('398_10_2') == '第三百九十八条の十の二')
check('int2kan', int2kan(1044) == '千四十四')
check('法令番号', lawnum_kanji(3, 23, 131) == '昭和二十三年法律第百三十一号')
check('和暦の日付', parse_jp_date('平成十六年十二月一日') == '2004-12-01')

# ---------------------------------------------------------------- 改め文の正規化
check('乃至→から…まで（枝番の途中で切らない）', norm_amend('第十六條ノ三乃至第十六條ノ十二ヲ削ル') == '第十六条の三から第十六条の十二までを削る')
check('旧い書き方の読点', '、第四編を削り、' in norm_amend('第一編を左ノ如ク改メ第四編ヲ削リ第五編ヲ第四編トス'))
check('削除スは削除の印', norm_amend('第八十九條ヲ削除ス').endswith('を削除する'))
check('削除の印の判定', is_deleted('第三十二条から第五百条まで削除') and is_deleted('第八十九條削除') and not is_deleted('第一条甲は乙とする。'))

# ---------------------------------------------------------------- 条の見出しから番号を取る（データの Num が崩れていても）
el = ET.fromstring('<NewProvision><Article Num="2"><ArticleTitle>第十六条の二</ArticleTitle></Article>'
                   '<Article Num="x"><ArticleTitle>第七十三條乃至第七十六條</ArticleTitle><Paragraph><Sentence>削除</Sentence></Paragraph></Article></NewProvision>')
nums = [a['num'] for a in walk_articles(el, [], [])]
check('見出しから番号（崩れた Num を直す・範囲を分ける）', nums == ['16_2', '73', '74', '75', '76'])

# ---------------------------------------------------------------- 改め文を当てる
L = Lineage([art('1', '第一条甲は乙とする。'), art('2', '第二条丙は丁とする。'), art('3', '第三条戊は己とする。'),
             art('4', '第四条庚は辛とする。'), art('5', '第五条壬は癸とする。', chap='2')], '1950-01-01')
act = {'law': '昭和30年1月1日法律第1号', 'date': '1955-01-01'}
L.apply_act(act, seg(
    ('目次中「第一章」を「第一章　総則」に改め、第二章を削る。', None),            # 目次の文は丸ごと飛ばす
    ('第三条を削り、第四条を第三条とする。', None),
    ('第三条の次に次の一条を加える。', new_xml(('3_2', '第三条の二', '甲乙丙丁の届出をする。'))),
    ('第二条を次のように改める。', new_xml(('2', '第二条', '全く別の事柄を定める規定である。')))))
st = L.state
check('目次の文は本則に当てない（第二章の第五条が残る）', '5' in st)
check('削って番号を詰める（旧四条→三条）', '3' in st and st['3']['text'].startswith('第四条'))
check('条を加える', '3_2' in st and '4' not in st)
check('丸ごとの書き換えは候補に残る', any(r['new_num'] == '2' for r in L.reviews))
R = Resolver(L.to_json())
check('系譜を引く: 1954 年の第四条 → 今の第三条', R.resolve('4', '1954-12-31')['now'] == '3')
check('系譜を引く: 1954 年の第三条 → 今は無い', R.resolve('3', '1954-12-31')['status'] == '削除')

# 入れ替え（同じ文の中）と、範囲の付け替え「以下…順次…繰下グ」
L2 = Lineage([art(str(i), f'第{int2kan(i)}条本文{i}の規定。') for i in range(1, 8)], '1900-01-01')
L2.apply_act({'law': 'A', 'date': '1910-01-01'}, seg(('第一条を第二条とし、第二条中「x」を「y」に改め、同条を第一条とする。', None)))
check('入れ替え（脇に置いて戻す）', L2.state['2']['text'].endswith('本文1の規定。') and L2.state['1']['text'].endswith('本文2の規定。'))
L2.apply_act({'law': 'B', 'date': '1920-01-01'}, seg(('第五條ヲ第十條トシ以下第七條迄順次五條宛繰下グ', None)))
check('以下…迄順次…繰下グ', set(L2.state) >= {'10', '11', '12'} and '5' not in L2.state)

# 編章節の「第二章を削る」は、上の単位が分からなければ複数の編にまたがって消さない
L3 = Lineage([art('1', '第一条あ', part='1', chap='2'), art('2', '第二条い', part='2', chap='2')], '1900-01-01')
L3.apply_act({'law': 'C', 'date': '1930-01-01'}, seg(('第二章を削る。', None)))
check('上の単位の無い章の削除は取り違えない', set(L3.state) == {'1', '2'})

# ---------------------------------------------------------------- 施行日
check('施行日: 公布の日', read_enforcement('附則この法律は、公布の日から施行する。', '2000-05-01')['date'] == '2000-05-01')
check('施行日: 日付', read_enforcement('この法律は、平成十七年四月一日から施行する。', '2004-06-01')['date'] == '2005-04-01')
check('施行日: 起算して六月', read_enforcement('この法律は、公布の日から起算して六月を経過した日から施行する。', '2001-01-31')['date'] == '2001-07-31')
e = read_enforcement('この法律は、公布の日から起算して一年を超えない範囲内において政令で定める日から施行する。', '2004-12-01')
check('施行日: 政令で定める日は幅', e['date'] is None and e['hi'] == '2005-12-01')
ex = read_exceptions('この法律は、平成三十二年四月一日から施行する。ただし、次の各号に掲げる規定は、当該各号に定める日から施行する。一　第二十七条の規定　公布の日', '2017-06-02')
check('ただし書の各号', ex and ex[0]['date'] == '2017-06-02' and '第二十七条' in ex[0]['head'])

# ---------------------------------------------------------------- 改正の宣言を見つける
rx = decl_regex(['民法'], ['明治二十九年法律第八十九号'])
check('宣言: 番号つき', bool(rx.search(norm_amend('民法（明治二十九年法律第八十九号）の一部を次のように改正する。'))))
check('宣言: 旧い書き方', bool(rx.search(norm_amend('民法中左ノ通改正ス'))))
check('宣言: ほかの法令（民法施行法）は拾わない', not rx.search(norm_amend('民法施行法の一部を次のように改正する。')))

# ---------------------------------------------------------------- Jev の決め直し（旧条 → 新条を一番確からしいものだけ・否定で切る）
with tempfile.TemporaryDirectory() as d:
    os.makedirs(os.path.join(d, 'out', 'X'))
    L4 = Lineage([art('570', '第五百七十条売買の目的物に隠れた瑕疵があったときは担保責任を負う。'),
                  art('415', '第四百十五条債務者が債務の本旨に従った履行をしないときは損害の賠償を請求できる。')], '1900-01-01')
    L4.apply_act({'law': 'H29', 'date': '2020-04-01'}, seg(
        ('第五百七十条を次のように改める。', new_xml(('570', '第五百七十条', '抵当権等がある場合の買主は売主に費用の償還を請求できる売買の目的物。'))),
        ('第四百十五条を次のように改める。', new_xml(('415', '第四百十五条', '債務者が債務の本旨に従った履行をしないときは損害の賠償を請求できる。ただし帰責事由がない場合はこの限りでない。')))))
    J = L4.to_json()
    jev = {}
    for rv in J['reviews']:
        for c in rv['cands']:
            jev[pair_id('X', rv, c)] = 0.05 if rv['new_num'] == '570' else (0.94 if c['old'] == '415' else 0.1)
    json.dump(J, open(os.path.join(d, 'out', 'X', 'lineage.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(jev, open(os.path.join(d, 'out', 'X', 'jev_pairs.json'), 'w', encoding='utf-8'))
    I = Identity('X', d)
    check('Jev: 旧415 は今の415（同じ規定）', I.resolve('415', '2010-01-01')['now'] == ['415'])
    check('Jev: 旧570 は今の570 ではない（別の規定）', '570' not in (I.resolve('570', '2010-01-01')['now'] or []))

# ---------------------------------------------------------------- 版の差分（2018 年以降）: 番号の付け替えを本文の近さで見つける
L5 = Lineage([art('1028', '第千二十八条兄弟姉妹以外の相続人は遺留分として次の額を受ける。'), art('1029', '第千二十九条遺留分を算定するための財産の価額。')], '1980-01-01')
L5.apply_version([art('1028', '第千二十八条被相続人の配偶者は居住建物について配偶者居住権を取得する。'),
                  art('1042', '第千四十二条兄弟姉妹以外の相続人は遺留分として次の額を受ける。'),
                  art('1043', '第千四十三条遺留分を算定するための財産の価額。')], {'law': 'H30', 'date': '2019-07-01'})
R5 = Resolver(L5.to_json())
check('版の差分: 旧1028 → 今の1042（番号の付け替え）', R5.resolve('1028', '2010-01-01')['now'] == '1042')
check('版の差分: 今の1028 は新しい規定', R5.resolve('1028', '2020-01-01')['pid'] != R5.resolve('1028', '2010-01-01')['pid'])
check('版の差分: 付け替えた旧い番号（1029 → 1043）は今の条の一覧に残らない', set(L5.state) == {'1028', '1042', '1043'})

# ---------------------------------------------------------------- e-Gov との答え合わせで本文も置き換える（古い本文のまま版の差分にかけない）
L6 = Lineage([art('37', '第三十七条昭和の頃の古い本文で買換えに係る居住用財産の取得価額を定める。')], '1960-01-01')
fx = L6.reconcile([art('37', '第三十七条個人が事業用資産を譲渡し買換資産を取得した場合の譲渡所得の課税の特例を定める。')], '2017-04-01')
pid37 = L6.state['37']['id']
L6.apply_version([art('37', '第三十七条個人が事業用資産を譲渡し買換資産を取得した場合の譲渡所得の課税の特例を定める。ただし書を加える。')],
                 {'law': 'H29', 'date': '2017-05-01'})
check('答え合わせで本文を e-Gov に置き換える', fx.get('text_synced') == 1 and L6.state['37']['id'] == pid37 and not L6.reviews)

# ---------------------------------------------------------------- 誤って消した条を戻すときは、消えた日からずっとあったことにする（地方自治法10条）
L7 = Lineage([art('10', '第十条市町村の区域内に住所を有する者は住民とする。', part='2', chap='2'),
              art('11', '第十一条住民は選挙に参与する権利を有する。', part='2', chap='3')], '1947-05-03')
L7.apply_act({'law': '昭和23年法律第X号', 'date': '1948-08-01'}, seg(('第二編第二章を削る。', None)))
gone10 = '10' not in L7.state
L7.reconcile([art('10', '第十条市町村の区域内に住所を有する者は住民とする。', part='2', chap='2'),
              art('11', '第十一条住民は選挙に参与する権利を有する。', part='2', chap='3')], '2017-04-01')
R7 = Resolver(L7.to_json())
check('誤って消した条を戻すと 1948〜2017 年の判決でもその条がある', gone10 and R7.resolve('10', '1990-01-01')['now'] == '10')

# ---------------------------------------------------------------- 判決のときの条文の控え（texts.py）: 番号ごとに本文が変わるたびに [日, 本文]（2026-10-18）
import texts  # noqa: E402
C = texts.Capture([art('1', '第一条甲は乙とする。'), art('2', '第二条丙は丁とする。'), art('3', '第三条戊は己とする。'), art('4', '第四条庚は辛とする。')], '1950-01-01')
C.apply_act({'law': '昭和30年1月1日法律第1号', 'date': '1955-01-01'}, seg(('第三条を削り、第四条を第三条とする。', None)))
C.apply_act({'law': '昭和40年1月1日法律第1号', 'date': '1965-01-01'}, seg(('第一条を次のように改める。', new_xml(('1', '第一条', '全く別の事柄を定める規定である。')))))
check('控え: 番号を詰めた条は、その日から詰めた後の文（1954 年の第三条は戊・1955 年からは庚）',
      [d for d, _ in C.snaps['3']] == ['1950-01-01', '1955-01-01'] and C.snaps['3'][0][1].endswith('戊は己とする。') and C.snaps['3'][1][1].startswith('第四条庚'))
check('控え: 無くなった番号は null・変わらない条は 1 つだけ・書き換えはその日の文', C.snaps['4'][-1] == ['1955-01-01', None] and len(C.snaps['2']) == 1
      and C.snaps['1'][-1][0] == '1965-01-01' and '全く別の事柄' in C.snaps['1'][-1][1])
try:
    C.reconcile([art('1', '第一条甲は乙とする。'), art('2', '第二条丙は丁とする。')], '2017-04-01')
    stopped = False
except texts._Stop:
    stopped = True
check('控え: e-Gov の一番古い版での答え合わせで止める（その後は e-Gov の版を引く）・答え合わせの文も控える', stopped and C.snaps['1'][-1] == ['2017-04-01', '第一条甲は乙とする。'])
check('控え: 答え合わせで e-Gov の版と大きく違った条に印（low）・合っていた条には付けない', C.low == ['1'])

# ---------------------------------------------------------------- 月に 1 回の作り直し（monthly.py）: 書き直す lineage.json に前の欄を残す（2026-10-18）
import monthly  # noqa: E402
J0 = {'lineage': {}, 'final': {}, 'asof': '2012-04-01', 'egov_only': True, 'amend_dates': ['2003-08-06', '2011-12-02'], 'chain': [], 'acts': []}
J1 = monthly.merged_json(J0, {'lineage': {'P1': []}, 'final': {'1': 'P1'}}, [{'law': 'X', 'date': '2026-10-01', 'revision': 'r1'}], [{'law': 'X', 'date': '2026-10-01', 'revision': 'r1'}])
check('月次: e-Gov の版だけの法令（政令など）の egov_only を残し、足した版の施行日を amend_dates に足す', J1.get('egov_only') is True and J1['amend_dates'] == ['2003-08-06', '2011-12-02', '2026-10-01'] and J1['final'] == {'1': 'P1'})
J2 = monthly.merged_json({'asof': '2020-01-01', 'acts': [{'law': 'a'}], 'extra': 1}, {'lineage': {}}, [], [])
check('月次: Lineage が持たない欄（extra）も残す・e-Gov の版だけでない法令に amend_dates を足さない', J2.get('extra') == 1 and 'amend_dates' not in J2 and J2['acts'] == [{'law': 'a'}])

print('\n' + ('すべて通った' if not fails else f'{len(fails)} 件 失敗: ' + ' / '.join(fails)))
sys.exit(1 if fails else 0)
