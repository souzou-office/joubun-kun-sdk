// ¥0 の確認: 条文の引用の読み取り（03_parse.cjs の scanLawArticles。事例の関係法令欄と裁決の本文で共用）
//   node scripts/shitsugi/check_scan_law.cjs
//   2026-10-15: 略称の後ろの「施行令」「施行規則」と、ほかの法令の名前の末尾の略称（「臨時措置法」）の読み違いを直した。その確認と、
//   今まで読めていたものが変わらないことの確認
'use strict';
const { scanLawArticles, parseKankeiLine, loadLawIds } = require('./03_parse.cjs');
const { extractLawRefs } = require('../saiketsu/03_parse.cjs');

const ALL = loadLawIds();
let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'OK ' : 'NG '} ${name}${cond || !extra ? '' : `\n     ${extra}`}`);
  if (!cond) fails++;
}
// 裁決の本文と同じ通り道（extractLawRefs）で読んで「法令ID:条」の並びにする
const refs = (text) => extractLawRefs(text, 50, ALL).map((r) => `${r.law_id}:${r.article}`).sort();
const kankei = (line) => parseKankeiLine(line, ALL).filter((p) => p.kind === 'law' && p.law_id)
  .flatMap((p) => (p.articles && p.articles.length ? p.articles : [p.article]).map((a) => `${p.law_id}:${a}`)).sort();
const id = (name) => ALL[name];
const has = (arr, x) => arr.includes(x);

const SOCHI = id('租税特別措置法'), SOCHI_REI = id('租税特別措置法施行令'), SOCHI_KISOKU = id('租税特別措置法施行規則');
const TSUSOKU = id('国税通則法'), TSUSOKU_REI = id('国税通則法施行令');

// ---- 直したもの
let r = refs('原処分庁は、措置法第41条第1項及び措置法施行令第26条第2項の規定により判断した。');
check('「措置法施行令第26条」は措置法施行令の26条（措置法の26条にしない）',
  has(r, `${SOCHI}:41`) && has(r, `${SOCHI_REI}:26`) && !has(r, `${SOCHI}:26`), r.join(' '));
r = refs('措置法施行規則第15条第2項に規定する書類を添付していない。');
check('「措置法施行規則第15条」は措置法施行規則の15条', has(r, `${SOCHI_KISOKU}:15`) && !has(r, `${SOCHI}:15`), r.join(' '));
r = refs('なお、通則法第23条第2項第3号に規定する「政令で定めるやむを得ない理由」とは、通則法施行令第6条第1項各号に限定して列挙された理由を指す。');
check('「通則法施行令第6条」は国税通則法施行令の6条', has(r, `${TSUSOKU}:23`) && has(r, `${TSUSOKU_REI}:6`) && !has(r, `${TSUSOKU}:6`), r.join(' '));
r = scanLawArticles('国税通則法施行令（以下「通則法施行令」という）第6条第1項第2号', ALL, '').filter((p) => p.law_id).map((p) => `${p.law_id}:${p.article}`);
check('略称を定める括弧（「通則法施行令」）の後の条を国税通則法に付けない', !has(r, `${TSUSOKU}:6`), r.join(' '));
r = refs('特別減税の額は、平成7年分所得税の特別減税のための臨時措置法第4条の規定に従い算定した金額である。');
check('「…臨時措置法第4条」を租税特別措置法の4条にしない', !has(r, `${SOCHI}:4`), r.join(' '));
check('scanLawArticles でも「措置法施行令第26条」は施行令', (() => {
  const p = scanLawArticles('措置法施行令第26条', ALL, '');
  return p.length === 1 && p[0].law_id === SOCHI_REI && p[0].article === '26';
})());

// ---- 今まで読めていたもの（変わらないこと）
r = refs('租税特別措置法第69条の4第1項に規定する小規模宅地等に該当する。');
check('租税特別措置法の条', has(r, `${SOCHI}:69の4`), r.join(' '));
r = refs('通知するとともに、速やかに調査の目的等通則法第74条の9第1項各号に掲げる事項を通知した。');
check('「…の目的等通則法」は国税通則法のまま（名前の続きと読まない）', has(r, `${TSUSOKU}:74の9`), r.join(' '));
r = refs('事業者は、令和2年4月10日、新型インフル特措法第45条第2項に基づく要請を受けた。');
check('「新型インフル特措法第45条」を租税特別措置法の45条にしない', !has(r, `${SOCHI}:45`), r.join(' '));
r = refs('請求人に通則法第65条第4項に規定する正当な理由があるとは認められない。');
check('助詞の後の略称「通則法」は国税通則法のまま', has(r, `${TSUSOKU}:65`), r.join(' '));
r = refs('このことは措置法第35条第1項の規定による。');
check('略称「措置法」は租税特別措置法のまま', has(r, `${SOCHI}:35`), r.join(' '));
r = refs('租税特別措置法施行令第25条の2第2項は、租税特別措置法第37条の3第1項の規定を受けている。');
check('正式名の施行令と法律が並ぶ文', has(r, `${SOCHI_REI}:25の2`) && has(r, `${SOCHI}:37の3`), r.join(' '));
r = refs('所得税法施行令第8条第2号に掲げる所得に類する所得に当たり、所得税法第2条第1項第24号に規定する臨時所得に該当する。');
check('所得税法施行令と所得税法', has(r, `${id('所得税法施行令')}:8`) && has(r, `${id('所得税法')}:2`), r.join(' '));
r = kankei('租税特別措置法第35条第1項、第2項');
check('事例の関係法令欄（措置法）', has(r, `${SOCHI}:35`), r.join(' '));
r = kankei('所得税法施行令第14条、第15条、所得税基本通達2-1、3-3');
check('事例の関係法令欄（施行令と通達）', has(r, `${id('所得税法施行令')}:14`) && has(r, `${id('所得税法施行令')}:15`), r.join(' '));

console.log(`\n${fails ? `${fails} 件 失敗` : 'すべて通った'}`);
process.exit(fails ? 1 : 0);
