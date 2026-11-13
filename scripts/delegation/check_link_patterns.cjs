#!/usr/bin/env node
// 委任先の紐付け（02_link_by_reverse.cjs）を固定データで検査する。¥0・ネットワークなし・K: ドライブ不要。
//
//   node scripts/delegation/check_link_patterns.cjs
//
// 見るもの:
//   - 従来の受け皿パターン（「法第N条第M項第K号に規定する法務省令で定めるものは、」）が confirmed のまま
//   - 列挙型（柱書「次に掲げる規定に規定する法務省令で定めるべき事項は、当該各号に定める事項とする。」＋号「法第四百四十条第一項」）が confirmed になる
//     （2026-09-22 まで「無し」に落ちていた。会社法 440 条 1 項 → 会社法施行規則 116 条 の型）
//   - 文中の単なる言及（「…又は法第九百十一条第三項の登記の日の…」）は weak のまま
//   - 柱書が準用なら列挙型でも strong にしない
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-check-'));
process.env.DELEG_REBUILD_DIR = ROOT;   // lib.cjs はこの環境変数を見る（require より前に設定する）
const { FETCHED_DIR, DELEG_DIR } = require('./lib.cjs');
// 法令単位の受け皿（包括委任）の題名 → law_id 表。src/lawIds.js の代わりに固定の表を使う
process.env.DELEG_LAW_TITLES_JSON = path.join(ROOT, 'titles.json');
fs.writeFileSync(process.env.DELEG_LAW_TITLES_JSON, JSON.stringify({ '検査業法施行令': '900CO0000000001', '検査業法施行規則': '900M60000010001' }));
const { extractLaw } = require('./01_extract_delegations.cjs');
const { linkParent } = require('./02_link_by_reverse.cjs');

const PARENT = '900AC0000000001';   // 検査業法（法律）
const CHILD = '900M60000010001';    // 検査業法施行規則（法務省令）
const CHILD2 = '900M60000020001';   // 検査業等に関する内閣府令（題名に親法令名を丸ごと含まないが芯「検査業」を含む）
const CHILD3 = '900M60000030001';   // 合併等の手続に関する内閣府令（親と無関係）

const sent = (text) => ({ text });
const art = (number, title, caption, paragraphs) => ({ type: 'article', number, title, caption, paragraphs });
const para = (num, sentences, items) => ({ num, sentences, items: items || [] });
const item = (item_num, item_title, sentences, sub_items) => ({ item_num, item_title, sentences, sub_items: sub_items || [] });

const parentLaw = {
  law_id: PARENT, law_title: '検査業法', law_num: '令和八年法律第一号', law_type: 'Act',
  articles: [
    art('5', '第五条', '（基準）', [
      para('1', [sent('検査は、厚生労働大臣が定める基準に従って行わなければならない。')]),
    ]),
    art('7', '第七条', '（届出の期間）', [
      para('1', [sent('検査業者は、政令で定める期間内に届け出なければならない。')]),
    ]),
    art('8', '第八条', '（帳簿の保存）', [
      para('1', [sent('検査業者は、政令で定める期間、帳簿を保存しなければならない。')]),
    ]),
    art('9', '第九条', '（設立時募集株式の申込み）', [
      para('1', [sent('発起人は、申込みをしようとする者に対し、次に掲げる事項を通知しなければならない。')]),
      para('4', [sent('前項の申込みをする者は、同項の書面の交付に代えて、政令で定めるところにより、発起人の承諾を得て、同項の書面に記載すべき事項を電磁的方法により提供することができる。')]),
    ]),
    art('10', '第十条', '（準用）', [
      para('1', [sent('第五十九条の規定は、外国検査業者について準用する。')]),
    ]),
    art('12', '第十二条', '（通知事項）', [
      para('3', [sent('発起人は、政令で定める事項を通知しなければならない。')]),
    ]),
    art('26', '第二十六条', '（定款の作成）', [
      para('1', [sent('株式会社を設立するには、発起人が定款を作成し、その全員がこれに署名し、又は記名押印しなければならない。')]),
      para('2', [sent('前項の定款は、電磁的記録（電子的方式その他人の知覚によっては認識することができない方式で作られる記録であって、電子計算機による情報処理の用に供されるものとして法務省令で定めるものをいう。以下同じ。）をもって作成することができる。'), sent('この場合において、当該電磁的記録に記録された情報については、法務省令で定める署名又は記名押印に代わる措置をとらなければならない。')]),
    ]),
    art('49', '第四十九条', '（届出）', [
      para('1', [sent('検査業者は、届け出なければならない。')]),
      para('2', [sent('前項の届出は、法務省令で定める者を経由してすることができる。')]),
    ]),
    art('50', '第五十条', '（帳簿）', [
      para('1', [sent('検査業者は、法務省令で定めるものを備え置かなければならない。')]),
    ]),
    art('55', '第五十五条', '（準用）', [
      para('1', [sent('第三十条の規定は、検査業者について準用する。この場合において、必要な技術的読替えは、政令で定める。')]),
    ]),
    art('59', '第五十九条', '（書類の受理）', [
      para('1', [sent('検査業者は、書類を提出しなければならない。')]),
      para('2', [sent('前項の書類の受理は、法務省令で定める者が行う。')]),
    ]),
    art('60', '第六十条', '（報告）', [
      para('1', [sent('検査業者は、内閣府令で定める事項を報告しなければならない。')]),
    ]),
    art('301', '第三百一条', '（株主総会参考書類及び議決権行使書面の交付等）', [
      para('1', [sent('取締役は、株主総会の招集の通知に際して、法務省令で定めるところにより、株主に対し、株主総会参考書類及び議決権行使書面を交付しなければならない。')]),
    ]),
    art('302', '第三百二条', '', [
      para('1', [sent('取締役は、株主総会の招集の通知に際して、法務省令で定めるところにより、株主に対し、株主総会参考書類を交付しなければならない。')]),
    ]),
    art('396', '第三百九十六条', '（会計監査人の権限等）', [
      para('1', [sent('会計監査人は、株式会社の計算書類を監査する。この場合において、会計監査人は、法務省令で定めるところにより、会計監査報告を作成しなければならない。')]),
    ]),
    art('435', '第四百三十五条', '（計算書類等の作成及び保存）', [
      para('1', [sent('株式会社は、法務省令で定めるところにより、その成立の日における貸借対照表を作成しなければならない。')]),
      para('2', [sent('株式会社は、法務省令で定めるところにより、各事業年度に係る計算書類及び事業報告並びにこれらの附属明細書を作成しなければならない。')]),
    ]),
    art('440', '第四百四十条', '（計算書類の公告）', [
      para('1', [sent('株式会社は、法務省令で定めるところにより、定時株主総会の終結後遅滞なく、貸借対照表を公告しなければならない。')]),
      para('2', [sent('前項の規定にかかわらず、要旨を公告することで足りる。')]),
      para('3', [sent('前項の株式会社は、法務省令で定めるところにより、貸借対照表の内容である情報を提供する措置をとることができる。')]),
    ]),
    art('441', '第四百四十一条', '（臨時計算書類）', [
      para('1', [sent('株式会社は、法務省令で定めるところにより、臨時計算書類を作成することができる。')]),
      para('2', [sent('臨時計算書類は、法務省令で定めるところにより、監査役の監査を受けなければならない。')]),
      para('3', [sent('前項の臨時計算書類は、取締役会の承認を受けなければならない。')]),
      para('4', [sent('臨時計算書類は、法務省令で定めるところにより、株主総会の承認を受けなければならない。')]),
    ]),
    art('442', '第四百四十二条', '（計算書類等の備置き）', [
      para('1', [sent('株式会社は、法務省令で定めるところにより、計算書類を備え置かなければならない。')]),
    ]),
    art('443', '第四百四十三条', '（計算書類等の提出命令）', [
      para('1', [sent('裁判所は、法務省令で定めるところにより、計算書類の提出を命ずることができる。')]),
    ]),
    art('779', '第七百七十九条', '（債権者の異議）', [
      para('1', [sent('消滅株式会社の債権者は、異議を述べることができる。')]),
      para('2', [sent('前項の規定により異議を述べることができる場合には、次に掲げる事項を官報に公告しなければならない。')], [
        item('1', '一', [sent('組織変更をする旨')]),
        item('2', '二', [sent('債権者が一定の期間内に異議を述べることができる旨その他法務省令で定めるもの')]),
      ]),
    ]),
    art('900', '第九百条', '（政令への委任）', [
      para('1', [sent('この法律に定めるもののほか、この法律の実施のため必要な事項は、政令で定める。')]),
      para('2', [sent('前項の政令の実施のため必要な事項は、内閣府令で定める。')]),
    ]),
    art('911', '第九百十一条', '（株式会社の設立の登記）', [
      para('1', [sent('株式会社の設立の登記は、その本店の所在地において、二週間以内にしなければならない。')]),
      para('2', [sent('前項の登記は、次に掲げる日から二週間以内にしなければならない。')]),
      para('3', [sent('第一項の登記においては、次に掲げる事項を登記しなければならない。')], [
        item('1', '一', [sent('目的')]),
        item('2', '二', [sent('公告方法についての定款の定めがあるときは、法務省令で定める事項')]),
      ]),
    ]),
  ],
};
const childLaw = {
  law_id: CHILD, law_title: '検査業法施行規則', law_num: '平成十八年法務省令第十二号', law_type: 'MinisterialOrdinance',
  articles: [
    // 併記 + 「…は、次款の定めるところによる」（会社法施行規則 65 条の型）
    art('65', '第六十五条', '', [
      para('1', [sent('法第三百一条第一項又は第三百二条第一項の規定により交付すべき株主総会参考書類に記載すべき事項は、次款の定めるところによる。')]),
    ]),
    // 「後段」を挟む従来型（会社法施行規則 110 条の型）
    art('110', '第百十条', '', [
      para('1', [sent('法第三百九十六条第一項後段の規定により法務省令で定める事項については、この条の定めるところによる。')]),
    ]),
    // 列挙型（会社法施行規則 116 条の型）。号は引用だけ（Column の 2 文目は別の文）
    art('116', '第百十六条', '', [
      para('1', [sent('次に掲げる規定に規定する法務省令で定めるべき事項（事業報告及びその附属明細書に係るものを除く。）は、当該各号に定める事項とする。')], [
        item('1', '一', [sent('法第四百三十五条第二項'), sent('各事業年度に係る計算書類及びその附属明細書に係る事項')]),
        item('2', '二', [sent('法第四百四十条第一項及び第三項'), sent('貸借対照表に係る事項')]),
        item('3', '三', [sent('法第四百四十一条第一項、第二項及び第四項'), sent('臨時計算書類に係る事項')]),
        // 「、第○条」は別の文節の可能性があるので併記として拾わない（項・号だけの「、」は上の 三 で拾う）
        item('4', '四', [sent('法第四百四十二条第一項、第四百四十三条第一項'), sent('備置きに係る事項')]),
      ]),
    ]),
    // 従来の受け皿パターン。同じ文の中で 911 条 3 項にも触れる（これは単なる言及）
    art('181', '第百八十一条', '（計算書類に関する事項）', [
      para('1', [sent('法第七百七十九条第二項第二号に規定する法務省令で定めるものは、同項の規定による公告の日又は法第九百十一条第三項の登記の日のいずれか遅い日とする。')]),
    ]),
    // 準用先の受け皿: 「第十二条において準用する法第四十九条第二項に規定する…」（直接の受け皿は無い → これが受け皿）
    art('190', '第百九十条', '', [
      para('1', [sent('第十二条（第十五条において準用する場合を含む。）において準用する法第四十九条第二項に規定する法務省令で定める者は、次に掲げる者とする。')]),
    ]),
    // 直接の受け皿（191 条）と準用先の受け皿（192 条）が両方ある → confirmed のまま、準用先は候補の後ろに残る
    art('191', '第百九十一条', '', [
      para('1', [sent('法第五十条第一項に規定する法務省令で定めるものは、帳簿とする。')]),
    ]),
    art('192', '第百九十二条', '', [
      para('1', [sent('第十三条において読み替えて準用する法第五十条第一項に規定する法務省令で定めるものは、電磁的記録とする。')]),
    ]),
    // 親法令の中での準用を子法令が受ける型: 「法第十条第一項において準用する法第五十九条第二項に規定する…」（分布で最多）
    art('193', '第百九十三条', '', [
      para('1', [sent('法第十条第一項において準用する法第五十九条第二項に規定する法務省令で定める者は、外国検査機関とする。')]),
    ]),
    // 柱書が準用なら列挙型でも受け皿にしない
    art('200', '第二百条', '（準用）', [
      para('1', [sent('次に掲げる規定に規定する法務省令で定める事項は、第百十六条の規定を準用する。')], [
        item('1', '一', [sent('法第九百十一条第三項')]),
      ]),
    ]),
    // 従来型（目的語「もの」）と列挙型（柱書に目的語「署名又は記名押印に代わる措置」）が同じ 26 条 2 項を引く。
    // 2 つの委任のどちらの受け皿かは目的語で分かれること（会社法施行規則 224 条・225 条の型）
    art('224', '第二百二十四条', '（電磁的記録）', [
      para('1', [sent('法第二十六条第二項に規定する法務省令で定めるものは、電子計算機に備えられたファイルに情報を記録したものとする。')]),
    ]),
    art('225', '第二百二十五条', '（電子署名）', [
      para('1', [sent('次に掲げる規定に規定する法務省令で定める署名又は記名押印に代わる措置は、電子署名とする。')], [
        item('1', '一', [sent('法第二十六条第二項')]),
      ]),
    ]),
  ],
};

// 施行令（政令）。技術的読替えの受け皿（柱書だけで判定。表の中身は使わない）
const CHILD4 = '900CO0000000001';
const child4Law = {
  law_id: CHILD4, law_title: '検査業法施行令', law_num: '令和八年政令第五号', law_type: 'CabinetOrder',
  articles: [
    // 手続型の列挙型（会社法施行令 1 条の型）。柱書の「法務省令で定めるところにより」は再委任で、受け皿の種別ではない
    art('1', '第一条', '（電磁的方法による提供の承諾等）', [
      para('1', [sent('次に掲げる規定に規定する事項を電磁的方法（法第二条第三十四号に規定する電磁的方法をいう。以下同じ。）により提供しようとする者（次項において「提供者」という。）は、法務省令で定めるところにより、あらかじめ、当該事項の提供の相手方に対し、その用いる電磁的方法の種類及び内容を示し、書面又は電磁的方法による承諾を得なければならない。')], [
        item('1', '一', [sent('法第九条第四項')]),
        item('2', '二', [sent('法第十二条第三項（法第八十六条において準用する場合を含む。）')]),
      ]),
    ]),
    // 題名（＋法令番号・略称宣言の括弧）で親を引く受け皿。ポインタ側の ref は「第七条第一項」から始まる（引用の前は題名だけ）
    art('3', '第三条', '（届出の期間）', [
      para('1', [sent('検査業法（令和八年法律第一号。以下「法」という。）第七条第一項の政令で定める期間は、三月とする。')]),
    ]),
    // 引用の前に主語がある（「…について、法第八条第一項の…」）のは文頭扱いにしない（head）。ポインタ側の ref は「第八条第一項」から
    art('4', '第四条', '（保存の方法）', [
      para('1', [sent('帳簿の保存をする者について、法第八条第一項の政令で定める期間は、五年とする。')]),
    ]),
    art('20', '第二十条', '（技術的読替え）', [
      para('1', [sent('法第五十五条第一項の規定による技術的読替えは、次の表のとおりとする。'), sent('<table><tr><td>第三十条</td><td>検査機関</td><td>検査業者</td></tr></table>')]),
    ]),
  ],
};

// 題名に親法令名を丸ごと含まない内閣府令（芯「検査業」を含む）。フルネームで親を引く external ref
const child2Law = {
  law_id: CHILD2, law_title: '検査業等に関する内閣府令', law_num: '令和八年内閣府令第三号', law_type: 'MinisterialOrdinance',
  articles: [
    art('5', '第五条', '（報告事項）', [
      para('1', [sent('検査業法第六十条第一項に規定する内閣府令で定める事項は、次に掲げる事項とする。')]),
    ]),
  ],
};
// 親と無関係な題名の内閣府令。文型が合っていても専属でないので weak のまま
const child3Law = {
  law_id: CHILD3, law_title: '合併等の手続に関する内閣府令', law_num: '令和八年内閣府令第四号', law_type: 'MinisterialOrdinance',
  articles: [
    art('4', '第四条', '', [
      para('1', [sent('検査業法第六十条第一項に規定する内閣府令で定める事項は、次に掲げる事項とする。')]),
    ]),
  ],
};

// 逆引き索引（00_index_refs.cjs の出力と同じ形。key は引用している側＝子法令の条。「法」は略称宣言の varref で、
// 親の条ポインタは 02 が文から読む）
const varref = (childArt, paragraph, itemNum, start) => ({ src: CHILD, key: `${CHILD}_Art${childArt}`, i: 0, ref: { type: 'varref', abbreviation: '法', text: '法', start, end: start + 1, target_law_id: PARENT, paragraph, item: itemNum } });
const external = (src, childArt, paragraph, text, target) => ({ src, key: `${src}_Art${childArt}`, i: 0, ref: { type: 'external', text, start: 0, end: text.length, target_law_id: PARENT, target_article: target.article, target_paragraph: target.paragraph, paragraph, item: null } });
// ポインタ側の ref（略称 VarRef と別。text は条ポインタだけで、start は略称・題名の後ろ）
const pointer = (src, childArt, paragraph, text, target) => { const t = childLaw4Text(src, childArt); return { src, key: `${src}_Art${childArt}`, i: 0, ref: { type: 'external', text, start: t.indexOf(text), end: t.indexOf(text) + text.length, target_law_id: PARENT, target_article: target.article, target_paragraph: target.paragraph, paragraph, item: null } }; };
function childLaw4Text(src, childArt) { const law = { [CHILD4]: child4Law }[src]; return law.articles.find((a) => a.number === childArt).paragraphs[0].sentences[0].text; }
// 施行令（CHILD4）の号の冒頭の略称 VarRef「法」
const varref4 = (childArt, paragraph, itemNum) => ({ src: CHILD4, key: `${CHILD4}_Art${childArt}`, i: 0, ref: { type: 'varref', abbreviation: '法', text: '法', start: 0, end: 1, target_law_id: PARENT, paragraph, item: itemNum } });
const reverseIndex = [
  varref4('1', '1', '1'),   // 施行令 1 条 一 → 9 条 4 項（「政令で定めるところにより」→ 手続型で confirmed）
  varref4('1', '1', '2'),   // 施行令 1 条 二 → 12 条 3 項（「政令で定める事項」は ところにより ではないので受けない）
  pointer(CHILD4, '3', '1', '第七条第一項', { article: '7', paragraph: '1' }),    // 題名だけが前 → 文頭扱いで confirmed
  pointer(CHILD4, '4', '1', '第八条第一項', { article: '8', paragraph: '1' }),    // 主語が前 → head で weak
  varref('190', '1', null, childLaw.articles.find((a) => a.number === '190').paragraphs[0].sentences[0].text.indexOf('法第四十九条')),   // 190 条（準用先）→ 49 条 2 項
  varref('191', '1', null, 0),                // 191 条（直接）→ 50 条 1 項
  varref('193', '1', null, 0),                // 193 条 冒頭「法第十条第一項」（準用する側の条。受け皿ではない）
  varref('193', '1', null, childLaw.articles.find((a) => a.number === '193').paragraphs[0].sentences[0].text.indexOf('法第五十九条')),   // 193 条「法第五十九条第二項」（準用先の受け皿）
  varref('192', '1', null, childLaw.articles.find((a) => a.number === '192').paragraphs[0].sentences[0].text.indexOf('法第五十条')),   // 192 条（準用先）→ 50 条 1 項
  { src: CHILD4, key: `${CHILD4}_Art20`, i: 0, ref: { type: 'varref', abbreviation: '法', text: '法', start: 0, end: 1, target_law_id: PARENT, paragraph: '1', item: null } },   // 施行令 20 条 → 55 条 1 項（技術的読替え）
  external(CHILD2, '5', '1', '検査業法第六十条第一項', { article: '60', paragraph: '1' }),   // 芯が一致する内閣府令 → 専属扱い
  external(CHILD3, '4', '1', '検査業法第六十条第一項', { article: '60', paragraph: '1' }),   // 無関係な内閣府令 → weak
  varref('65', '1', null, 0),                 // 65 条 → 301 条 1 項 又は 302 条 1 項（併記）
  varref('110', '1', null, 0),                // 110 条 → 396 条 1 項後段
  varref('116', '1', '1', 0),                 // 116 条 一 → 435 条 2 項
  varref('116', '1', '2', 0),                 // 116 条 二 → 440 条 1 項 及び 第 3 項
  varref('116', '1', '3', 0),                 // 116 条 三 → 441 条 1 項、2 項 及び 4 項
  varref('116', '1', '4', 0),                 // 116 条 四 → 442 条 1 項（「、第四百四十三条第一項」は拾わない）
  varref('224', '1', null, 0),                // 224 条 → 26 条 2 項（従来型・目的語「もの」）
  varref('225', '1', '1', 0),                 // 225 条 一 → 26 条 2 項（列挙型・目的語「署名又は記名押印に代わる措置」）
  varref('181', '1', null, 0),                // 181 条 冒頭 → 779 条 2 項 2 号
  varref('181', '1', null, childLaw.articles.find((a) => a.number === '181').paragraphs[0].sentences[0].text.indexOf('法第九百十一条')),   // 181 条 文中 → 911 条 3 項
  varref('200', '1', '1', 0),                 // 200 条 一（準用）→ 911 条 3 項
];

fs.mkdirSync(FETCHED_DIR, { recursive: true });
fs.mkdirSync(path.join(DELEG_DIR, 'reverse_index'), { recursive: true });
fs.writeFileSync(path.join(FETCHED_DIR, `${PARENT}.json`), JSON.stringify(parentLaw));
fs.writeFileSync(path.join(FETCHED_DIR, `${CHILD}.json`), JSON.stringify(childLaw));
fs.writeFileSync(path.join(FETCHED_DIR, `${CHILD2}.json`), JSON.stringify(child2Law));
fs.writeFileSync(path.join(FETCHED_DIR, `${CHILD3}.json`), JSON.stringify(child3Law));
fs.writeFileSync(path.join(FETCHED_DIR, `${CHILD4}.json`), JSON.stringify(child4Law));
fs.writeFileSync(path.join(DELEG_DIR, 'reverse_index', `${PARENT}.json`), JSON.stringify(reverseIndex));

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  → ' + detail}`); if (!ok) fails++; };

const raw = extractLaw(PARENT);
const linked = linkParent(PARENT, { raw, noWrite: true, quiet: true });
const find = (article, paragraph, itemNum) => linked.delegations.find((d) => d.parent_article === article && String(d.parent_paragraph) === String(paragraph) && (itemNum == null ? d.parent_item == null : String(d.parent_item) === String(itemNum)));
const cands = (d) => (d ? d.candidates.map((c) => `${c.law_id}/${c.article}${c.item ? '#' + c.item : ''}:${c.strength}`) : []);

check('委任表現の抽出（28 か所）', raw.delegations.filter((d) => d.provision === 'main').length === 28, JSON.stringify(raw.delegations.map((d) => [d.article, d.paragraph, d.item, d.expr])));

const d301 = find('301', '1', null), d302 = find('302', '1', null);
check('併記: 301 条 1 項 と 302 条 1 項 の両方 → 施行規則 65 条 が confirmed', d301 && d302 && d301.status === 'confirmed' && d302.status === 'confirmed' && cands(d301).join() === `${CHILD}/65:strong` && cands(d302).join() === `${CHILD}/65:strong`, `${d301 && d301.status} ${cands(d301)} / ${d302 && d302.status} ${cands(d302)}`);
const d396 = find('396', '1', null);
check('「後段」を挟む従来型: 396 条 1 項 → 施行規則 110 条 が confirmed', d396 && d396.status === 'confirmed' && cands(d396).join() === `${CHILD}/110:strong`, d396 && `${d396.status} ${cands(d396)}`);
const d440 = find('440', '1', null);
check('列挙型: 440 条 1 項 → 施行規則 116 条 二 が confirmed', d440 && d440.status === 'confirmed' && cands(d440).join() === `${CHILD}/116#2:strong`, d440 && `${d440.status} ${cands(d440)}`);
const d440_3 = find('440', '3', null);
check('列挙型 + 項の併記「第一項及び第三項」: 440 条 3 項も 116 条 二 が confirmed', d440_3 && d440_3.status === 'confirmed' && cands(d440_3).join() === `${CHILD}/116#2:strong`, d440_3 && `${d440_3.status} ${cands(d440_3)}`);
const d441 = ['1', '2', '4'].map((p) => find('441', p, null));
check('列挙型 + 「第一項、第二項及び第四項」: 441 条の 1・2・4 項が 116 条 三 で confirmed', d441.every((d) => d && d.status === 'confirmed' && cands(d).join() === `${CHILD}/116#3:strong`), d441.map((d) => d && `${d.status} ${cands(d)}`).join(' / '));
const d55 = find('55', '1', null);
check('技術的読替え: 「必要な技術的読替えは、政令で定める」→ 施行令 20 条「…の規定による技術的読替えは、次の表のとおりとする」が confirmed', d55 && d55.status === 'confirmed' && cands(d55).join() === `${CHILD4}/20:strong`, d55 && `${d55.status} ${cands(d55)}`);
const d59 = find('59', '2', null);
check('親法令の中での準用を子が受ける型: 「法第十条第一項において準用する法第五十九条第二項に規定する…」→ 193 条が confirmed（via_junyo）', d59 && d59.status === 'confirmed' && cands(d59).join() === `${CHILD}/193:strong` && d59.candidates[0].via_junyo === true, d59 && `${d59.status} ${cands(d59)}`);
check('weak の理由が候補に残る（911 条の文中の言及は no_pattern）', (() => { const d = find('911', '3', '2'); const c = d && d.candidates.find((x) => x.article === '181'); return !!c && c.strength === 'weak' && JSON.stringify(c.weak_reasons) === '["no_pattern"]'; })());
const d49 = find('49', '2', null);
check('準用先の受け皿: 直接の受け皿が無ければ 190 条（via_junyo）が confirmed', d49 && d49.status === 'confirmed' && cands(d49).join() === `${CHILD}/190:strong` && d49.candidates[0].via_junyo === true, d49 && `${d49.status} ${cands(d49)}`);
const d50 = find('50', '1', null);
check('直接（191 条）と準用先（192 条）が両方: confirmed のまま、直接が先・準用先が後ろに残る', d50 && d50.status === 'confirmed' && cands(d50).join() === `${CHILD}/191:strong,${CHILD}/192:strong` && d50.candidates[0].via_junyo === false && d50.candidates[1].via_junyo === true, d50 && `${d50.status} ${cands(d50)}`);
const d60 = find('60', '1', null);
check('専属フィルタ: 題名の芯「検査業」を含む内閣府令は confirmed、無関係な内閣府令は weak のまま', d60 && d60.status === 'confirmed' && cands(d60).join() === `${CHILD2}/5:strong,${CHILD3}/4:weak` && d60.candidates[1].cross_system === true, d60 && `${d60.status} ${cands(d60)}`);
const d442 = find('442', '1', null), d443 = find('443', '1', null);
// 「、第四百四十三条第一項」は拾わないので 443 条には候補が付かない。442 条側も、号の文が引用だけにならない（拾わなかった続きが残る）ので列挙型にはならず weak 止まり
// 条が決まらない省令委任は、親に専属の施行規則があるので法令単位（law_level）に落ちる。weak の候補はそのまま残る
check('「、第○条」は併記として拾わない: 443 条 1 項は候補ゼロ、442 条 1 項は列挙型にならず weak の候補だけ（どちらも law_level）', d443 && d443.status === 'law_level' && d443.candidates.length === 0 && d442 && d442.status === 'law_level' && cands(d442).join() === `${CHILD}/116#4:weak`, `${d442 && d442.status} ${d442 && cands(d442)} / ${d443 && d443.status} ${d443 && cands(d443)}`);
const d26 = raw.delegations.filter((d) => d.article === '26' && String(d.paragraph) === '2').map((d) => find('26', '2', null) && linked.delegations.filter((x) => x.parent_article === '26' && String(x.parent_paragraph) === '2'))[0] || [];
const d26a = d26.find((d) => /ものをいう/.test(d.trailing)), d26b = d26.find((d) => /署名又は記名押印/.test(d.trailing));
check('同じ項の 2 つの委任: 「もの」は 224 条、「署名又は記名押印に代わる措置」は列挙型の 225 条に分かれて confirmed', d26a && d26b && d26a.status === 'confirmed' && cands(d26a).join() === `${CHILD}/224:strong` && d26b.status === 'confirmed' && cands(d26b).join() === `${CHILD}/225#1:strong`, `${d26a && d26a.status} ${d26a && cands(d26a)} / ${d26b && d26b.status} ${d26b && cands(d26b)}`);
const d435 = find('435', '2', null);
check('列挙型: 435 条 2 項 → 施行規則 116 条 一 が confirmed', d435 && d435.status === 'confirmed' && cands(d435).join() === `${CHILD}/116#1:strong`, d435 && `${d435.status} ${cands(d435)}`);
const d435a = find('435', '1', null);
check('列挙型: 引かれていない 435 条 1 項は候補ゼロ（law_level に落ちる）', d435a && d435a.status === 'law_level' && d435a.candidates.length === 0 && d435a.law_level.law_id === CHILD, d435a && `${d435a.status} ${cands(d435a)}`);
const d779 = find('779', '2', '2');
check('従来型: 779 条 2 項 2 号 → 施行規則 181 条 が confirmed（既存の判定は変えない）', d779 && d779.status === 'confirmed' && cands(d779).join() === `${CHILD}/181:strong`, d779 && `${d779.status} ${cands(d779)}`);
const d911 = find('911', '3', '2');
check('文中の言及（181 条）と準用の柱書（200 条）は weak 止まり（法令単位に落ちる）', d911 && d911.status === 'law_level' && d911.candidates.every((c) => c.strength === 'weak') && d911.candidates.length === 2, d911 && `${d911.status} ${cands(d911)}`);
// 手続型の列挙型（2026-09-22）
const d9 = find('9', '4', null), d12 = find('12', '3', null);
check('手続型の列挙型: 「政令で定めるところにより」→ 施行令 1 条 一（柱書「次に掲げる規定に規定する事項を…提供しようとする者は、法務省令で定めるところにより」）が confirmed', d9 && d9.status === 'confirmed' && cands(d9).join() === `${CHILD4}/1#1:strong` && d9.candidates[0].rec_kind === null, d9 && `${d9.status} ${cands(d9)} ${d9.candidates[0] && d9.candidates[0].rec_kind}`);
check('手続型の列挙型は「ところにより」でない委任（「政令で定める事項」）には当てない（候補ゼロ → law_level）', d12 && d12.status === 'law_level' && d12.candidates.length === 0, d12 && `${d12.status} ${cands(d12)}`);
// 引用の前が親法令の題名（＋括弧）だけ／主語つき（2026-09-22）
const d7 = find('7', '1', null), d8 = find('8', '1', null);
check('題名（＋法令番号・略称宣言）で親を引く受け皿「検査業法（…）第七条第一項の政令で定める期間は、」→ 施行令 3 条 が confirmed', d7 && d7.status === 'confirmed' && cands(d7).join() === `${CHILD4}/3:strong`, d7 && `${d7.status} ${cands(d7)}`);
check('引用の前に主語がある「…について、法第八条第一項の政令で定める期間は、」は head で weak（law_level に落ちる）', d8 && d8.status === 'law_level' && cands(d8).join() === `${CHILD4}/4:weak` && d8.candidates[0].weak_reasons.includes('head'), d8 && `${d8.status} ${cands(d8)} ${d8.candidates[0] && d8.candidates[0].weak_reasons}`);
// 法令単位の受け皿と告示（2026-09-22）
const d5 = find('5', '1', null), d900 = find('900', '1', null), d900_2 = find('900', '2', null);
check('告示への委任（「厚生労働大臣が定める基準」）は kokuji（受け皿は法令 DB に無い）', d5 && d5.status === 'kokuji' && !d5.law_level, d5 && `${d5.status}`);
check('包括委任「必要な事項は、政令で定める」は 検査業法施行令 への法令単位リンク（law_level）', d900 && d900.status === 'law_level' && d900.law_level && d900.law_level.law_id === CHILD4 && d900.law_level.law_title === '検査業法施行令' && d900.candidates.length === 0, d900 && `${d900.status} ${JSON.stringify(d900.law_level)}`);
check('種別が合わない専属の子（内閣府令 → 「検査業法施行規則」は法務省令）には落とさず none のまま', d900_2 && d900_2.status === 'none' && !d900_2.law_level, d900_2 && `${d900_2.status}`);
check('confirmed / multiple は法令単位に落とさない', linked.delegations.filter((d) => d.law_level).every((d) => d.status === 'law_level') && linked.delegations.filter((d) => d.status === 'confirmed').every((d) => !d.law_level));
check('統計: 列挙型 7（116 条 ×3・225 条・準用で落とす 200 条・手続型の施行令 1 条 ×2）・strong 17・準用先 3・未特定 0', linked.stats.enum_lead === 7 && linked.stats.strong === 17 && linked.stats.via_junyo === 3 && linked.stats.unlocatable === 0, JSON.stringify(linked.stats));
// 親の後続語が「ところにより」でも、受け皿の目的語が「事項」でも weak に落とさない（GENERIC_NOUN）
check('「法務省令で定めるところにより」の委任が名詞照合で落ちない', d396 && d396.candidates[0].strength === 'strong' && /ところにより/.test(d396.trailing), d396 && `${d396.trailing} ${cands(d396)}`);
check('列挙型の候補は柱書の目的語を持つが、名詞不一致で weak に落ちない', d440 && d440.candidates[0].noun === 'べき事項' && d440.candidates[0].strength === 'strong' && d440.candidates[0].matched_pattern.startsWith('列挙型'), d440 && JSON.stringify([d440.candidates[0].noun, d440.candidates[0].strength, d440.candidates[0].matched_pattern]));
// 庁令（2026-11-02 の防災庁設置法の施行で、災害対策基本法などの「内閣府令で定める」が「防災庁令で定める」になった）
const { findDelegations } = require('./lib.cjs');
const fdKinds = (t) => findDelegations(t).map((d) => `${d.expr}:${d.kind}`).join();
check('「防災庁令で定める」を委任として拾い、府令の受け皿（内閣府令）に寄せる', fdKinds('防災庁令で定めるところにより') === '防災庁令で定める:内閣府令', fdKinds('防災庁令で定めるところにより'));
check('併記「内閣府令・防災庁令・国土交通省令で定める」も 1 つの委任', fdKinds('内閣府令・防災庁令・国土交通省令で定める基準') === '内閣府令・防災庁令・国土交通省令で定める:内閣府令', fdKinds('内閣府令・防災庁令・国土交通省令で定める基準'));
check('復興庁令・デジタル庁令は今まで通り', fdKinds('復興庁令で定める') === '復興庁令で定める:内閣府令' && fdKinds('デジタル庁令で定める') === 'デジタル庁令で定める:内閣府令', fdKinds('復興庁令で定める') + ' / ' + fdKinds('デジタル庁令で定める'));

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(fails ? `\n${fails} 件失敗` : '\nすべて通過');
process.exit(fails ? 1 : 0);
