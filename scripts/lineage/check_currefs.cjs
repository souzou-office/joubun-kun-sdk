// 判例の付け直し（scripts/lineage/lib/currefs.cjs）の確認。¥0・ネットにも LLM にも出ない・固定の表で確かめる
//   node scripts/lineage/check_currefs.cjs
'use strict';

const C = require('./lib/currefs.cjs');

let fails = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'OK  ' : 'NG  '}${name}${!cond && detail !== undefined ? ` … ${JSON.stringify(detail)}` : ''}`);
  if (!cond) fails++;
};

// ---------------------------------------------------------------- 固定の表（tables.py の形）
const T = {
  // 民事訴訟法（今）: 1998 年から。旧法は 123AC
  NEWMINSO: {
    law_id: 'NEWMINSO', title: '民事訴訟法', born: '1998-01-01', old: 'OLDMINSO', acts: {},
    arts: { 61: [['1998-01-01', null, 'same', [['NEWMINSO', '61', 1]]]], 89: [['1998-01-01', null, 'same', [['NEWMINSO', '89', 1]]]] },
  },
  OLDMINSO: {
    law_id: 'OLDMINSO', title: '民事訴訟法', old_law: true, names: ['旧民訴法'],
    arts: { 89: [['1890-04-21', null, 'old', [['NEWMINSO', '61', 0.98]]]], 500: [['1890-04-21', '1980-10-01', 'old', [['EXEC', '22', 0.9]]], ['1980-10-01', null, 'gone', []]] },
  },
  // 民法: 平成29年法律第44号（2020-04-01）で 570 は別の規定に・415 は同じ・1の3 → 3（2005-04-01 から）
  MINPO: {
    law_id: 'MINPO', title: '民法', born: '1898-07-16', acts: { '平成29年法律第44号': '2020-04-01' },
    arts: {
      415: [['1898-07-16', null, 'same', [['MINPO', '415', 1]]]],
      570: [['1898-07-16', '2020-04-01', 'gone', []], ['2020-04-01', null, 'same', [['MINPO', '570', 1]]]],
      '1の3': [['1947-01-01', '2005-04-01', 'renum', [['MINPO', '3', 1]]]],
      3: [['1898-07-16', '2005-04-01', 'renum', [['MINPO', '4', 1]]], ['2005-04-01', null, 'same', [['MINPO', '3', 1]]]],
      777: [['1898-07-16', null, 'split', [['MINPO', '777', 1], ['MINPO', '778の2', 0.72]]]],
    },
  },
  // 商法の会社の規定 → 会社法
  SHOHO: {
    law_id: 'SHOHO', title: '商法', born: '1899-06-16', acts: {},
    arts: { 266: [['1899-06-16', '2006-05-01', 'moved', [['KAISHA', '423', 0.7]]]] },
  },
};
const table = (id) => T[id] || null;
const one = (ref, jd) => C.resolveRef(ref, jd, table);

// ---------------------------------------------------------------- 1 つの引用
let r = one({ lawId: 'MINPO', art: '415' }, '2010-01-01');
check('同じ番号の同じ規定', r.length === 1 && r[0].how === 'same' && r[0].art === '415' && r[0].conf === 1, r);
r = one({ lawId: 'MINPO', art: '570' }, '2010-01-01');
check('今の条に同じ規定が無い → 外す', r.length === 1 && r[0].how === 'gone' && r[0].lawId === null && r[0].from.art === '570', r);
r = one({ lawId: 'MINPO', art: '570' }, '2021-01-01');
check('改正後の判決の 570 はそのまま', r[0].how === 'same' && r[0].art === '570', r);
r = one({ lawId: 'MINPO', art: '570', before: ['平成29年法律第44号'] }, '2021-01-01');
check('「平成29年法律第44号による改正前」は改正の前日の版で引く', r[0].how === 'gone' && r[0].from.ver === '2020-03-31', r);
r = one({ lawId: 'MINPO', art: '1の3' }, '1990-01-01');
check('番号が変わった（1条の3 → 3条）', r[0].how === 'renum' && r[0].art === '3', r);
r = one({ lawId: 'MINPO', art: '3' }, '1990-01-01');
check('同じ番号でも判決のときは別の条（旧3条 → 今の4条）', r[0].how === 'renum' && r[0].art === '4', r);
r = one({ lawId: 'MINPO', art: '777' }, '1990-01-01');
check('分かれた（今の同じ番号＋ほかの条）', r.length === 2 && r.every((x) => x.how === 'split') && r[1].art === '778の2' && r[1].conf === 0.72, r);
r = one({ lawId: 'MINPO', art: '1の3' }, '2010-01-01');
check('判決日に無い条は直前にその条があった版で引く（prev）', r[0].how === 'renum' && r[0].art === '3' && r[0].prev === true && r[0].from.ver === '1947-01-01', r);
r = one({ lawId: 'MINPO', art: '9999' }, '2010-01-01');
check('一度も無い条は今の同じ番号のまま（unverified）', r[0].how === 'unverified' && r[0].art === '9999', r);
r = one({ lawId: 'SHOHO', art: '266' }, '2000-01-01');
check('ほかの法令に移った（商法 → 会社法）', r[0].how === 'moved' && r[0].lawId === 'KAISHA' && r[0].art === '423', r);
r = one({ lawId: 'NEWMINSO', art: '89' }, '1966-01-31');
check('今の法令ができる前の判決は旧法の表で引く', r[0].how === 'old' && r[0].lawId === 'NEWMINSO' && r[0].art === '61' && r[0].from.lawId === 'OLDMINSO', r);
r = one({ lawId: 'NEWMINSO', art: '89' }, '2000-01-01');
check('今の法令ができた後の判決は今の表', r[0].how === 'same' && r[0].art === '89', r);
r = one({ lawId: 'NEWMINSO', art: '500' }, '1990-01-01');
check('旧法で受け皿の無い条 → 外す', r[0].how === 'gone' && r[0].from.lawId === 'OLDMINSO', r);
r = one({ lawId: 'NEWMINSO', art: '500' }, '1970-01-01');
check('旧法の条 → ほかの法令の受け皿（民事執行法）', r[0].how === 'old' && r[0].lawId === 'EXEC', r);
r = one({ lawId: 'KENPO', art: '14' }, '1990-01-01');
check('系譜の無い法令は今の同じ番号のまま（nolineage）', r[0].how === 'nolineage' && r[0].lawId === 'KENPO' && r[0].art === '14', r);
r = one({ lawId: 'MINPO', art: '415' }, null);
check('判決日の無い判例は確かめずに残す', r[0].how === 'unverified', r);

// ---------------------------------------------------------------- 判例 1 件
const rec = {
  id: '2665', dateIso: '1966-01-31', court: '最高裁判所', title: '損害賠償請求事件', detailNs: [2],
  lawRefs: [{ lawId: 'NEWMINSO', art: '89' }, { lawId: 'NEWMINSO', art: '61' }, { lawId: 'MINPO', art: '570' }, { lawId: 'MINPO', art: '附則' }],
  unresolvedRefs: [{ name: '旧民訴法', art: '89', count: 1 }, { name: '本件条例', art: '3', count: 1 }],
};
const oldNames = new Map([['旧民訴法', 'OLDMINSO']]);
const cur = C.curRefsOf(rec, table, oldNames, null);
const at = (l, a) => cur.filter((c) => c.lawId === l && c.art === a);
check('同じ今の条に行き着いた引用は 1 件にまとめる（民訴法89条＋旧民訴法89条 → 61条）', at('NEWMINSO', '61').length === 1, cur);
const curB = C.curRefsOf({ ...rec, dateIso: '2000-01-01', lawRefs: [{ lawId: 'NEWMINSO', art: '61' }] }, table, oldNames, null);
check('まとめるときはそのまま引いた方を残す', curB.length === 1 && curB[0].how === 'same' && !C.viaOf(curB[0], table), curB);
check('外した引用も残す（gone）', cur.some((c) => c.how === 'gone' && c.from.art === '570'), cur);
check('条キーでない引用（附則）は付け直さない', !cur.some((c) => c.from && c.from.art === '附則'), cur);
check('今の 89 条には付けない（判決のときの 89 条は別の規定）', at('NEWMINSO', '89').length === 0, cur);
const cur2 = C.curRefsOf({ ...rec, lawRefs: [] }, table, oldNames, null);
check('旧法の名前で引いた未解決の引用も付け直す（旧民訴法89条 → 61条）', cur2.length === 1 && cur2[0].lawId === 'NEWMINSO' && cur2[0].art === '61', cur2);
const cur3 = C.curRefsOf({ ...rec, dateIso: '2021-01-01', unresolvedRefs: [], lawRefs: [{ lawId: 'MINPO', art: '570' }] }, table, null, (k) => (k === 'MINPO|570' ? ['平成29年法律第44号'] : null));
check('before を本文から取り直したものも使う', cur3[0].how === 'gone' && cur3[0].from.ver === '2020-03-31', cur3);

// ---------------------------------------------------------------- 条文ページの文言
const v = C.viaOf({ lawId: 'NEWMINSO', art: '61', from: { lawId: 'OLDMINSO', art: '89' } }, table);
check('旧法: 「旧民事訴訟法89条として引用」', C.viaText(v) === '旧民事訴訟法89条として引用', C.viaText(v));
const v2 = C.viaOf({ lawId: 'MINPO', art: '3', from: { lawId: 'MINPO', art: '1の3' } }, table);
check('同じ法令の改正前: 「改正前の民法1条の3として引用」', C.viaText(v2) === '改正前の民法1条の3として引用', C.viaText(v2));
check('そのまま引いたものは注記なし', C.viaOf({ lawId: 'MINPO', art: '415', from: { lawId: 'MINPO', art: '415' } }, table) === null);
const item = C.linkItem(rec, v);
check('links の item は 07 と同じ欄＋via', item.id === '2665' && item.url === 'https://www.courts.go.jp/hanrei/2665/detail2/index.html' && item.via && item.via.old === true, item);
check('外した引用は links に出さない', !C.linkable({ how: 'gone', lawId: null, art: null }) && C.linkable({ how: 'old', lawId: 'NEWMINSO', art: '61' }));

// ---------------------------------------------------------------- 本文から「…による改正前」を取り直す（03_parse と同じ読み取り）
const fakeParse = {
  buildLexicon: () => ({}),
  extractCitations: (text, lex, acc) => { if (/平成29年法律第44号による改正前の民法570条/.test(text)) acc.refs.set('MINPO|570', { lawId: 'MINPO', art: '570', before: ['平成29年法律第44号'] }); return { stats: {} }; },
};
const rb = C.makeBeforeReader(fakeParse);
check('改正前の無い判例は読み直さない', rb({ sections: [{ text: '民法570条' }] }) === null);
const bf = rb({ sections: [{ text: '平成29年法律第44号による改正前の民法570条' }] });
check('改正前のある判例は before を返す', bf && bf('MINPO|570')[0] === '平成29年法律第44号' && bf('MINPO|415') === null);

// ---------------------------------------------------------------- 注記（判決の日 → 今 の間にその条に起きたこと）と置き場所
const N = {
  law_id: 'NOTE', title: '注記法', born: '1950-01-01', acts: { '平成29年法律第44号': '2020-04-01' },
  arts: {
    // 10 条: 2005 年と 2020 年に文言の改正（同じ規定）
    10: [['1950-01-01', null, 'same', [['NOTE', '10', 1]], [['2005-04-01', 'amend', '平成16年12月1日法律第147号', '2004-12-01'], ['2020-04-01', 'amend', '平成29年5月26日法律第44号', '2017-05-26']], null]],
    // 20 条: 2020 年に別の規定に差し替え（判決当時の 20 条は今の 20 条とは別）。今の 20 条は 2020 年から
    20: [['1950-01-01', '2020-04-01', 'gone', [], [['2020-04-01', 'end', '平成29年5月26日法律第44号', '2017-05-26']], null],
      ['2020-04-01', null, 'same', [['NOTE', '20', 1]], [], ['2020-04-01', 'new', '平成29年5月26日法律第44号', '2017-05-26']]],
  },
};
const tn = (id) => (id === 'NOTE' ? N : table(id));
let q = C.resolveRef({ lawId: 'NOTE', art: '10' }, '2010-01-01', tn);
check('注記: 判決の後に改正（最初の施行日・改正法・回数）', q[0].notes && q[0].notes[0].k === 'amended' && q[0].notes[0].d === '2020-04-01' && q[0].notes[0].n === 1, q);
q = C.resolveRef({ lawId: 'NOTE', art: '20' }, '2010-01-01', tn);
check('注記: 判決当時の条は今の同じ番号の条とは別の規定（replaced）・今の 20 条の畳む枠に置く', q[0].how === 'gone' && q[0].notes[0].k === 'replaced' && q[0].notes[0].d === '2020-04-01' && JSON.stringify(q[0].at) === '["NOTE","20"]' && JSON.stringify(C.placeOf(q[0])) === '{"lawId":"NOTE","art":"20","box":"other"}', q);
q = C.resolveRef({ lawId: 'NOTE', art: '20' }, '2018-01-01', tn);
check('注記: 改正の公布と施行のあいだの判決は near（改正前の規定を当てている可能性）', q[0].notes.some((n) => n.k === 'near' && n.d === '2020-04-01'), q);
q = C.resolveRef({ lawId: 'NOTE', art: '20' }, '2021-01-01', tn);
check('注記: 差し替えの施行の直後（2 年以内）の判決も near', q[0].how === 'same' && q[0].notes.some((n) => n.k === 'near'), q);
q = C.resolveRef({ lawId: 'NOTE', art: '20' }, '2024-01-01', tn);
check('注記: 施行から 2 年を超えた判決には付けない', q[0].how === 'same' && !(q[0].notes || []).length, q);
q = C.resolveRef({ lawId: 'NOTE', art: '20', before: ['平成29年法律第44号'] }, '2021-01-01', tn);
check('注記: 判決文の明示（before）は改正前の規定として引用・near は付けない', q[0].how === 'gone' && q[0].notes[0].k === 'before' && !q[0].notes.some((n) => n.k === 'near'), q);
// 「改正前民法570条」のように改正前の印だけで引いた条（03 の prior・2026-10-17。大阪地裁 令和5年4月20日 令和2(ワ)7001）: 判決のときの版の一つ前の版
q = C.curRefsOf({ id: '92075', dateIso: '2023-04-20', lawRefs: [{ lawId: 'NOTE', art: '20', kaiseimae: true, prior: true }] }, tn);
check('改正前の印（prior）: 判決のときの版より一つ前の版（差し替えの前の 20 条＝今の 20 条とは別の規定）・注記 prior', q.length === 1 && q[0].how === 'gone' && q[0].notes.some((n) => n.k === 'prior') && q[0].notes.some((n) => n.k === 'replaced'), q);
q = C.curRefsOf({ id: '92076', dateIso: '2023-04-20', lawRefs: [{ lawId: 'NOTE', art: '20', kaiseimae: true }] }, tn);
check('改正前の印が全部の引用に付いていない（prior なし）なら判決のときの版', q.length === 1 && q[0].how === 'same' && q[0].art === '20', q);
// 条番号の無い判例の注記（2026-10-17）: 判決の後の改正・判決の後にできた条
{
  const a = C.nonumNotes(N, '10', '2010-01-01');
  check('条番号の無い判例: 判決の日に同じ規定なら判決の後の改正を amended（刑法181条と id 6871 の型）', a.length && a[0].k === 'amended' && a[0].d === '2020-04-01', a);
  const b = C.nonumNotes(N, '20', '2010-01-01');
  check('条番号の無い判例: 判決の日にその番号の今の規定が無ければ born（改正で足された条は期間の始まり＝施行日・改正法）', b.length === 1 && b[0].k === 'born' && b[0].d === '2020-04-01' && b[0].law === '平成29年5月26日法律第44号', b);
  const LB = { law_id: 'NEWLAW', born: '2013-11-27', enacted: { d: '2014-05-20' }, arts: { 5: [['2013-11-27', null, 'same', [['NEWLAW', '5', 1]], [], null]] } };
  const c = C.nonumNotes(LB, '5', '2008-09-09');
  check('法令ごと判決の後にできた条は e-Gov の制定の施行日（自動車運転死傷処罰法5条と id 37145 の型）', c.length === 1 && c[0].k === 'born' && c[0].d === '2014-05-20' && !c[0].prom
    && C.noteText(c[0]) === 'この条は判決の後（2014年5月20日）にできました。判決は前の規定で判断しています', c);
  const d = C.nonumNotes({ ...LB, enacted: null, born: '1991-10-04', arts: { 14: [['1991-10-04', null, 'same', [['NEWLAW', '14', 1]], [], null]] } }, '14', '1961-09-07');
  check('施行日が分からなければ系譜の最初の日（公布）と書く（借地借家法14条と id 63702 の型）', d[0].k === 'born' && d[0].prom && C.noteText(d[0]) === 'この条は判決の後（1991年10月4日公布）にできました。判決は前の規定で判断しています', d);
  check('判決の後に何も起きていなければ注記なし', !C.nonumNotes(LB, '5', '2020-01-01').length && !C.nonumNotes(null, '5', '2020-01-01').length);
}
// 上告審の結果（2026-10-18）: 3 点一致の審級リンクの appeals（最高裁だけ）。破棄 → 棄却 → 却下 の順・「その他」は付けない
{
  const ap = (aps) => C.linkItem({ id: '1', court: '東京高等裁判所', appeals: aps }, null, null).appeal;
  check('上告審の結果: 破棄自判・破棄差戻は haki、棄却は kikyaku、却下は kyakka、その他・最高裁でないものは付けない',
    ap([{ id: '2', court: '最高裁判所', kekka: '破棄差戻', dateJp: '平成20年6月4日' }]).k === 'haki' && ap([{ id: '2', court: '最高裁判所', kekka: '棄却' }]).k === 'kikyaku'
    && ap([{ id: '2', court: '最高裁判所', kekka: '却下' }]).k === 'kyakka' && !ap([{ id: '2', court: '最高裁判所', kekka: 'その他' }]) && !ap([{ id: '2', court: '東京高等裁判所', kekka: '棄却' }]) && !ap([])
    && ap([{ id: '2', court: '最高裁判所', kekka: '棄却' }, { id: '3', court: '最高裁判所', kekka: '破棄自判' }]).k === 'haki');
}
check('置き場所: 今の条の一覧（items）', JSON.stringify(C.placeOf({ how: 'same', lawId: 'NOTE', art: '10' })) === '{"lawId":"NOTE","art":"10","box":"items"}' && C.placeOf({ how: 'gone', lawId: null, art: null }) === null);
check('注記の文言', C.noteText({ k: 'replaced', d: '2020-04-01', law: '平成29年5月26日法律第44号' }, { art: '20' }) === '判決当時の第20条は、今の第20条とは別の規定です（2020年4月1日施行の平成29年5月26日法律第44号で差し替え・削除）'
  && C.noteText({ k: 'amended', d: '2005-04-01', law: 'X法', n: 2 }) === 'この判決の後、2005年4月1日に改正されています（X法）（ほか 1 回）');

// ---------------------------------------------------------------- 条文ページに載せるか（2026-10-16 の方針・decideShow）
{
  const W = { law_id: 'RW', title: '書換法', rewrites: C.rewritesOf({ final: { 5: 'P5', 6: 'P6', '7_2': 'P7' }, lineage: {
    P5: [{ date: '2010-04-01', op: '書き直し', law: '平成21年法律第1号' }],
    P6: [{ date: '2005-04-01', op: '書き直し', law: '平成16年12月1日法律第147号' }, { date: '2012-01-01', op: '文言の改正', law: '平成23年法律第2号' }],
    P7: [{ date: '2015-01-01', op: '新しい規定', law: '平成26年法律第3号' }] } }) };
  const OLD = { title: '旧法', old_law: true };
  const tw = (id) => (id === 'RW' ? W : id === 'OLDL' ? OLD : null);
  check('書き換えの出来事: 枝番は「の」のキー', W.rewrites['7の2'] && W.rewrites['5'] && W.rewrites['6'].length === 1);
  const ds = (c, judge) => C.decideShow('9', c, tw, { old: { OLDL: { rows: {
    3: { to: [{ law: 'RW', art: '5', jev: 0.95 }], band: '確か' },
    '4_2': { to: [{ law: 'RW', art: '7_2', jev: 0.92 }], band: '確か' },
    8: { to: [{ law: 'RW', art: '5', jev: 0.85 }], band: '確か' },
    9: { to: [{ law: 'RW', art: '5', jev: 0.95 }, { law: 'RW', art: '6', jev: 0.93 }], band: '確か' },
  } } }, judge });
  let d = ds({ lawId: 'RW', art: '5', how: 'same', from: { lawId: 'RW', art: '5', ver: '2000-01-01' } });
  check('same: 判決の後に条が書き換えられたら載せない', !d.show.length && d.hide === 'rewrite', d);
  d = ds({ lawId: 'RW', art: '5', how: 'same', from: { lawId: 'RW', art: '5', ver: '2011-01-01' } });
  check('same: 書き換えの後の判決は載せる', d.show.length === 1 && d.show[0].by === 'lineage' && !d.hide, d);
  d = ds({ lawId: 'RW', art: '6', how: 'same', from: { lawId: 'RW', art: '6', ver: '2000-01-01' } });
  check('same: 表記の現代語化（民法 平成16年法律第147号）と文言の改正だけなら載せる', d.show.length === 1, d);
  d = ds({ lawId: 'RW', art: '7の2', how: 'renum', from: { lawId: 'RW', art: '7', ver: '2000-01-01' } });
  check('renum: 新しい規定（枝番）は載せない', d.hide === 'rewrite', d);
  d = ds({ lawId: 'RW', art: '5', how: 'old', from: { lawId: 'OLDL', art: '3', ver: '1950-01-01', old: true } });
  check('旧法: 行き先 1 つ・確か・0.9 以上なら受け皿に載せる（Jev の点）', d.show.length === 1 && d.show[0].art === '5' && d.show[0].by === 'jev' && d.show[0].s === 0.95, d);
  d = ds({ lawId: null, art: null, how: 'old', from: { lawId: 'OLDL', art: '4の2', ver: '1950-01-01', old: true } });
  check('旧法: 枝番の旧条も対応表（_ のキー）を引く', d.show.length === 1 && d.show[0].art === '7の2', d);
  check('旧法: 0.9 未満・分かれた・対応表に無いは載せない', ds({ how: 'old', from: { lawId: 'OLDL', art: '8', old: true } }).hide === 'old_unsure'
    && ds({ how: 'old', from: { lawId: 'OLDL', art: '9', old: true } }).hide === 'old_split' && ds({ how: 'old', from: { lawId: 'OLDL', art: '99', old: true } }).hide === 'old_nomap');
  check('gone・unverified は載せない・nolineage は同じ番号', ds({ how: 'gone', lawId: null, art: null, from: { lawId: 'RW', art: '1' } }).hide === 'gone'
    && ds({ how: 'nolineage', lawId: 'X1', art: '3', from: { lawId: 'X1', art: '3' } }).show[0].art === '3');
  const J = { '9|RW|1': { applies: ['RW|7_2'], reason: '判断は今の 7 条の 2 にも通用する' }, '9|OLDL|3': { misread: true, applies: [] }, '9|RW|5': { applies: [] } };
  d = ds({ how: 'gone', lawId: null, art: null, from: { lawId: 'RW', art: '1', ver: '2000-01-01' }, notes: [{ k: 'replaced', d: '2010-04-01' }, { k: 'before', law: 'X' }] }, J);
  check('Opus の判断: applies の条に載せ、理由を持つ', d.show.length === 1 && d.show[0].art === '7の2' && d.show[0].by === 'opus' && d.show[0].reason && !d.hide, d);
  const its = C.linkItemsOf({ id: '9', court: '最高裁判所' }, d, tw);
  check('Opus の判断で載せた item: judge に理由・別の条なので注記は引用そのもの（before）だけ・via は元の条', its.length === 1 && its[0].v.judge.by === 'opus' && its[0].v.judge.reason
    && its[0].v.notes.length === 1 && its[0].v.notes[0].k === 'before' && its[0].v.via.art === '1', its);
  check('Opus の判断: 読み違いは載せない・通用しないも載せない', ds({ how: 'old', from: { lawId: 'OLDL', art: '3', old: true } }, J).hide === 'misread'
    && ds({ how: 'same', lawId: 'RW', art: '5', from: { lawId: 'RW', art: '5', ver: '2011-01-01' } }, J).hide === 'not_applicable');
  // 2 回目の判断（2026-10-17）: 両方が載せるとした条だけ。食い違いは judge_split
  const ds2 = (c, j1, j2) => C.decideShow('9', c, tw, { old: {}, judge: j1, judge2: j2 });
  const g = { how: 'gone', lawId: null, art: null, from: { lawId: 'RW', art: '1', ver: '2000-01-01' } };
  d = ds2(g, { '9|RW|1': { applies: ['RW|5', 'RW|6'], reason: 'r1' } }, { '9|RW|1': { applies: ['RW|6'], why: 'r2' } });
  check('2 回の判断: 両方が applies に入れた条だけ載せる（理由は 1 回目）', d.show.length === 1 && d.show[0].art === '6' && d.show[0].reason === 'r1', d);
  check('2 回の判断: 片方だけ載せる・行き先が違うは載せない（judge_split）', ds2(g, { '9|RW|1': { applies: ['RW|5'] } }, { '9|RW|1': { applies: [] } }).hide === 'judge_split'
    && ds2(g, { '9|RW|1': { applies: ['RW|5'] } }, { '9|RW|1': { applies: ['RW|6'] } }).hide === 'judge_split'
    && ds2(g, { '9|RW|1': { misread: true, applies: [] } }, { '9|RW|1': { applies: [] } }).hide === 'misread');
  // 判決の結びの決まり文句の中でだけ引いた条（2026-10-17）
  const rec = { sections: [{ text: '本件上告を棄却する。所論は理由がない。民法第七〇九条の解釈を誤る。よって、民事訴訟法第三一九条、第九五条、第八九条に従い、主文のとおり判決する。' }], sanshoRaw: '民法709条' };
  const co = C.makeClosingOnly(rec);
  check('結びだけ: 結びの中でだけ引いた条（三一九・八九）は true、本文・参照法条にも出る条（七〇九）は false', co && co('319') && co('89') && !co('709') && co('95の2'), co);
  const co2 = C.makeClosingOnly({ sections: [{ text: '被告人を懲役一年に処する。刑法二五条一項を適用し、刑事訴訟法第一八一条第一項本文により訴訟費用を負担させ、主文のとおり判決する。' }] });
  check('結びだけ: 「よって」で始まらない結びの文も拾う', co2 && co2('25') && co2('181'), co2);
  check('結びだけ: 結びが見つからない判例は null（今までどおり載せる）', C.makeClosingOnly({ sections: [{ text: '民訴法319条により棄却する。' }] }) === null);
  // 刑訴法411条の決まった言い回し（2026-10-17）
  const so = C.makeStockOnly({ sections: [{ text: '所論は単なる法令違反の主張であって、刑訴法四〇五条の上告理由に当たらない。また、記録を調べても、刑訴法四一一条を適用すべきものとは認められない。' }] });
  check('決まった言い回し: 刑訴法411条がこの文にしか出てこなければ boiler411', so && so('323AC0000000131', '411') === 'boiler411' && so('323AC0000000131', '405') === 'boiler405', so);
  const so2 = C.makeStockOnly({ sections: [{ text: '記録を調べても刑訴法四一一条を適用すべきものとは認められない。しかし、刑訴法四一一条一号により原判決を破棄する。' }] });
  check('決まった言い回し: 411条で破棄した判決（ほかの文にも 411条）は載せる', so2 && so2('323AC0000000131', '411') === null, so2);
  const so3 = C.makeStockOnly({ sections: [{ text: '本件上告の趣意は、単なる法令違反、量刑不当の主張であって、刑訴法四〇五条の上告理由に当たらない。上告について民事事件について最高裁判所に上告をすることが許されるのは、民訴法三一二条一項又は二項所定の場合に限られるところ、明らかに上記各項に規定する事由に該当しない。本件は、民訴法三一八条一項により受理すべきものとは認められない。' }] });
  check('決まった言い回し（2026-10-18）: 刑訴法405条・民訴法312条・民訴法318条', so3 && so3('323AC0000000131', '405') === 'boiler405' && so3('408AC0000000109', '312') === 'boiler312' && so3('408AC0000000109', '318') === 'boiler318', so3);
  const so4 = C.makeStockOnly({ sections: [{ text: '所論は刑訴法四〇五条の上告理由に当たらない。しかし、刑訴法四〇五条一号の憲法違反の主張について判断すると、次のとおりである。' }] });
  const so5 = C.makeStockOnly({ sections: [{ text: '同第三は量刑不当の各主張であつて、いずれも刑訴法四〇五条の上告理由にあたらない。民事事件について最高裁判所に上告をすることが許されるのは、民訴法三一二条一項又は二項所定の場合に限られるところ、本件上告理由は、本件規定（以下「本件規定」という。）の違憲をいうが、民訴法三一二条一項及び二項に規定する事由のいずれにも該当しない。' }] });
  check('決まった言い回しの書き方の違い: 「あたらない」・漢数字・「事由のいずれにも該当しない」・括弧の中の「。」で文を切らない', so5 && so5('323AC0000000131', '405') === 'boiler405' && so5('408AC0000000109', '312') === 'boiler312', so5);
  check('決まった言い回し: ほかの所でもその条を論じていれば載せる（405条）', so4 && so4('323AC0000000131', '405') === null, so4);
  check('上告理由に当たらない型: 最高裁の短い決定（「上告の理由としてその適法要件を欠く」）', C.noGroundDecision({ court: '最高裁判所', sections: [{ text: '本件上告の趣意は、上告の理由としてその適法要件を欠く。よって主文のとおり決定する。' }] })
    && !C.noGroundDecision({ court: '最高裁判所', sections: [{ text: '所論は上告理由に当たらない。なお、職権で判断すると、原判決は相当である。' }] })
    && !C.noGroundDecision({ court: '東京高等裁判所', sections: [{ text: '上告理由に当たらない。' }] }));
  check('結びだけの条はどの判断より先に載せない（hide: boiler）', C.decideShow('9', { how: 'same', lawId: 'RW', art: '5', from: { lawId: 'RW', art: '89', ver: '2011-01-01' } }, tw, {}, co).hide === 'boiler');
  const it2 = C.linkItemsOf({ id: '9' }, ds({ lawId: 'RW', art: '5', how: 'old', from: { lawId: 'OLDL', art: '3', ver: '1950-01-01', old: true } }), tw);
  check('Jev の受け皿に載せた item: 旧法の元の条（via.old）・judge は付けない', it2[0].v.via.old === true && it2[0].v.via.law === '旧法' && !it2[0].v.judge, it2);
}

console.log(fails ? `\n${fails} 件 失敗` : '\nすべて通った');
process.exit(fails ? 1 : 0);
