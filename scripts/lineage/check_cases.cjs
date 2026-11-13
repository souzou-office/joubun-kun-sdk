// ¥0 の確認: 裁決・事例の引用の「どの版か」の読み取り（cases_refs.cjs）と、版の地図の引き方（map_resolve.cjs）
//   node scripts/lineage/check_cases.cjs
'use strict';
const { scanDoc, loadNameIndex, beforeOf, isoDate } = require('./cases_refs.cjs');
const { resolveRef, resolveLink } = require('./map_resolve.cjs');
const { loadLawIds } = require('../shitsugi/03_parse.cjs');

const fails = [];
function check(name, cond) {
  console.log(`${cond ? 'OK ' : 'NG '} ${name}`);
  if (!cond) fails.push(name);
}

const ALL = loadLawIds();
const idx = loadNameIndex(ALL);
const SHOTOKU = ALL['所得税法'], SOCHI = ALL['租税特別措置法'], TSUSOKU = ALL['国税通則法'];
const occ = (text) => Object.fromEntries(scanDoc(text, idx, ALL));
const hows = (o, k) => (o[k] || []).map((x) => x.how);

check('改正法の番号: 漢数字・月だけの日付', beforeOf('平成二十七年法律第九号による改正前')[0] === '平成27年法律第9号'
  && beforeOf('平成27年3月法律第9号による改正前のもの')[0] === '平成27年法律第9号');
check('裁決日', isoDate('平成27年9月28日裁決') === '2015-09-28' && isoDate('令和元年5月1日') === '2019-05-01');

let o = occ('所得税法（平成18年法律第10号による改正前のものをいう。以下同じ。）第2条《定義》第1項第34号は、と定める。\nロ　所得税法第56条は、と定める。');
check('法令名の直後の改正前（以下同じ）: その引用は明示', hows(o, `${SHOTOKU}:2`)[0] === 'explicit' && o[`${SHOTOKU}:2`][0].before[0] === '平成18年法律第10号');
check('以下同じ: 後の同じ法令の引用にも効く', hows(o, `${SHOTOKU}:56`)[0] === 'defined');
check('《見出し》を引用に付ける', o[`${SHOTOKU}:2`][0].caption === '定義');

o = occ('国税通則法第65条《過少申告加算税》（平成28年法律第15号による改正前のもの。以下同じ。）第1項は。また国税通則法第66条も。さらに国税通則法第65条も。');
check('条の直後の改正前: その条だけ', hows(o, `${TSUSOKU}:65`)[0] === 'explicit' && hows(o, `${TSUSOKU}:66`)[0] === 'current');
check('条の直後の以下同じ: 後の同じ条にだけ効く', hows(o, `${TSUSOKU}:65`)[1] === 'defined');

o = occ('租税特別措置法（平成12年法律第13号による改正前のもの。以下「措置法」という。）第41条は。\n措置法第41条第1項の規定。');
check('略称の定め（以下「措置法」という）: 後の略称の引用は改正前', hows(o, `${SOCHI}:41`).includes('abbr'));

o = occ('租税特別措置法（昭和63年法律第4号による改正前のものをいい、以下「旧措置法」という。）第36条の2の規定。旧措置法第36条の4の規定。');
check('略称「旧措置法」の引用', hows(o, `${SOCHI}:36の4`)[0] === 'abbr' && o[`${SOCHI}:36の4`][0].before[0] === '昭和63年法律第4号');

o = occ('措置法第41条第1項及び措置法施行令第26条第2項に規定する。');
check('「措置法施行令」の条を措置法の条と読んだ印', hows(o, `${SOCHI}:26`)[0] === 'shikorei' && hows(o, `${SOCHI}:41`)[0] === 'current');
o = occ('国税通則法施行令（以下「通則法施行令」という。）第6条《更正の請求》第1項第2号は。');
check('「通則法施行令」の略称の後の条も同じ印', !o[`${TSUSOKU}:6`] || hows(o, `${TSUSOKU}:6`)[0] === 'shikorei');
o = occ('平成7年分所得税の特別減税のための臨時措置法第4条《特別減税の額》の規定。請求人に通則法第65条を適用する。');
check('「臨時措置法」を通称「措置法」と読んだ印（「請求人に通則法」は印を付けない）',
  hows(o, `${SOCHI}:4`)[0] === 'tailname' && hows(o, `${TSUSOKU}:65`)[0] === 'current');
o = occ('旧所得税法第95条の規定。');
check('「旧○○法」は改正の特定なし', hows(o, `${SHOTOKU}:95`)[0] === 'old');
o = occ('所得税法第234条&#12298;当該職員の質問検査権&#12299;第1項。');
check('文字参照の《》も見出しとして読む', o[`${SHOTOKU}:234`][0].caption === '当該職員の質問検査権');

// 版の地図: 37 条は 2000-04-01 に書き換わって今は別の規定、69 条の 3 は 2010-04-01 に 69 条の 4 へ番号が変わった
const map = {
  acts: { '平成12年法律第13号': '2000-04-01' },
  nums: {
    37: [['1960-01-01', []], ['2000-04-01', ['37']]],
    '69_3': [['1983-01-01', ['69_4']], ['2010-04-01', ['69_3']]],
    '69_4': [['1983-01-01', ['69_4']]],
    50: [['1960-01-01', ['50']], ['2005-04-01', null]],
  },
  placed: ['70'],
  caps: { 37: '特定の事業用資産の買換えの場合の譲渡所得の課税の特例', '69_3': '在外財産等の価額が算定可能となつた場合の修正申告等', '69_4': '小規模宅地等についての相続税の課税価格の計算の特例' },
};
check('判断の日の版: 今は別の規定', resolveRef(map, '37', '1999-01-01').cat === 'remove');
check('明示の改正前は、その改正の施行日の前日の版', resolveRef(map, '37', '2010-01-01', ['平成12年法律第13号']).cat === 'remove'
  && resolveRef(map, '37', '2010-01-01').cat === 'same');
check('番号が変わった条は付け直す', resolveRef(map, '69の3', '1997-01-01').cat === 'relink' && resolveRef(map, '69の3', '1997-01-01').now[0] === '69_4');
check('その日に無い条は直前にあった日の版', resolveRef(map, '50', '2010-01-01').cat === 'same');
check('系譜が欠けている番号は判定しない', resolveRef(map, '70', '2010-01-01').cat === 'gap');
check('明示の改正法が地図に無い', resolveRef(map, '37', '2010-01-01', ['平成1年法律第1号']).cat === 'unknown_act');
const row = (art, o2) => ({ art, occ: [o2] });
check('最後の決め方: 番号の変更は付け直す', resolveLink(map, row('69の3', { before: [], how: 'current' }), '1997-01-01').final === 'relink');
check('最後の決め方: 見出しが今の同じ番号の条と同じなら残す',
  resolveLink(map, row('37', { before: [], how: 'current', caption: '特定の事業用資産の買換えの場合の譲渡所得の課税の特例' }), '1999-01-01').final === 'keep');
check('最後の決め方: 見出しが違えば外す',
  resolveLink(map, row('37', { before: [], how: 'current', caption: '買換えに係る居住用財産の譲渡の場合の取得価額の計算' }), '1999-01-01').final === 'remove');
check('最後の決め方: 施行令の読み違いは外す', resolveLink(map, row('37', { before: [], how: 'shikorei' }), '2010-01-01').final === 'remove');
check('最後の決め方: どれか 1 回でも今の同じ規定なら残す',
  resolveLink(map, { art: '37', occ: [{ before: [], how: 'current' }, { before: ['平成12年法律第13号'], how: 'explicit' }] }, '2010-01-01').final === 'keep');

console.log('\n' + (fails.length ? `${fails.length} 件 失敗: ${fails.join(' / ')}` : 'すべて通った'));
process.exit(fails.length ? 1 : 0);
