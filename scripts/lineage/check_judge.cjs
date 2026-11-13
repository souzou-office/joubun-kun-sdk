// ¥0 の確かめ: 条番号の無い判例の判断した条（nonum_cases.cjs）と、改正で書き換えられた条の判断し直し（judge_cases.cjs）。
//   Worker（/api/select・/api/jev-score・/api/chat・/api/articles）と e-Gov は呼ばない作り物、R2 は R2_FAKE_DIR（一時フォルダ）
//   node scripts/lineage/check_judge.cjs
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-judge-'));
process.env.LINEAGE_DATA = path.join(TMP, 'data');
const { R2 } = require('../update/lib/r2.cjs');
const N = require('./nonum_cases.cjs');
const JC = require('./judge_cases.cjs');
const J = require('./lib/llm_jobs.cjs');

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'OK ' : 'NG '} ${name}${ok ? '' : `  → ${JSON.stringify(detail).slice(0, 400)}`}`); if (!ok) fails++; };
const lex = { nameToId: new Map([['民法', '129AC0000000089'], ['刑法', '140AC0000000045']]) };

// 作り物の Worker: 候補は固定、Jev の点は判決文の言葉で決め、Opus は決まった JSON を返す
function fakeApi(opts = {}) {
  const calls = { select: 0, jev: 0, opus: 0, article: 0 };
  return {
    calls,
    async select() { calls.select++; return { jpy: 4, cands: [{ law: '129AC0000000089', art: '709', title: '民法第七百九条', caption: '（不法行為）', text: '故意又は過失によって…' }, { law: '140AC0000000045', art: '199', title: '刑法第百九十九条', caption: '（殺人）', text: '人を殺した者は…' }] }; },
    async jevScore(rec, text, cands) { calls.jev++; if (opts.jev429) { const e = new Error('HTTP 429'); e.budget = true; throw e; } const s = {}; for (const c of cands) s[`${c.law}|${c.art}`] = /損害賠償/.test(text) && c.art === '709' ? 0.91 : 0.2; return { scores: s, usd: 0.001 }; },
    async opus(sys, body) {
      calls.opus++;
      if (/旧法や改正前|評釈/.test(sys)) return { text: opts.judgeReply ? opts.judgeReply(sys) : '{"misread":false,"applies":["1"],"select":["A"],"reason":"通用する","why":"保たれている"}', usd: 0.02 };
      return { text: '{"picks":[2],"other":["民法第七一〇条"],"none":"","reason":"殺人の故意を判断"}', usd: 0.03 };
    },
    async article(law, art) { calls.article++; return law === '129AC0000000089' && ['709', '710'].includes(String(art)) ? { law, art, title: `民法第${art}条`, caption: '', text: '…' } : null; },
  };
}

(async () => {
  // ---------------------------------------------------------------- decideCase
  {
    const api = fakeApi();
    let r = await N.decideCase({ court: '東京地方裁判所', hanji: '交通事故の損害賠償' }, '理由 被告は原告に損害賠償の責任を負う。', api, lex);
    check('Jev で 0.7 以上の候補を判断した条にする（how: Jev）', r.res.how === 'Jev' && r.res.decided.join() === '129AC0000000089|709' && api.calls.opus === 0, r);
    check('費用: 選定の円と Jev のドル', r.jpy === 4 && r.usd > 0, r);
    r = await N.decideCase({ court: '大阪地方裁判所' }, '理由 被告人は被害者を殺害した。', api, lex);
    check('Jev で決まらなければ Opus が候補から選び、候補の外の条は今の条があると確かめたものだけ（how: Opus・理由）', r.res.how === 'Opus' && r.res.decided.join() === '140AC0000000045|199,129AC0000000089|710' && r.res.reason === '殺人の故意を判断', r);
    r = await N.decideCase({ court: '最高裁判所' }, '本件上告の趣意は、上告の理由としてその適法要件を欠く。よって主文のとおり決定する。', api, lex);
    check('最高裁の上告理由に当たらない型の決定は載せない（Worker を呼ばない）', r.res.how === '上告理由に当たらない等' && !r.res.decided.length, r);
    r = await N.decideCase({ court: '東京地方裁判所' }, '理由 本件条例の解釈について判断する。', api, lex);
    check('Jev で決まらない条例の判決は載せない（Opus を呼ばない）', r.res.how === '条例' && !r.res.decided.length, r);
    r = await N.decideCase({ court: '東京地方裁判所' }, '', api, lex);
    check('判決文の無い判例は載せない', r.res.how === '判決文なし', r);
    check('待ち行列に入れる判定: 引用なし・「法令名＋第○条」の形なし', N.isNoNumCase({ lawRefs: [] }, '被告は損害を賠償する責任を負う。') && !N.isNoNumCase({ lawRefs: [] }, '民法七〇九条により責任を負う。') && !N.isNoNumCase({ lawRefs: [{ lawId: 'x', art: '1' }] }, '責任を負う。'));
  }

  // ---------------------------------------------------------------- runQueue（R2 は一時フォルダ）
  {
    const dir = path.join(TMP, 'r2a');
    const put = (k, v) => { const p = path.join(dir, ...k.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
    const get = (k) => { const p = path.join(dir, ...k.split('/')); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
    put(N.QUEUE, { v: 1, items: { 90010: { added: '2026-10-18' }, 90011: { added: '2026-10-18' }, 90012: { added: '2026-10-19' } } });
    put('hanrei_v1/cases_0900.json', {
      90010: { id: '90010', court: '東京地方裁判所', dateJp: '令和8年10月1日', dateIso: '2026-10-01', title: '損害賠償請求事件', hanji: '交通事故の損害賠償', sections: [] },
      90011: { id: '90011', court: '大阪地方裁判所', dateJp: '令和8年10月2日', dateIso: '2026-10-02', title: '殺人被告事件', sections: [{ text: '被告人は被害者を殺害した。' }] },
      90012: { id: '90012', court: '東京地方裁判所', dateJp: '令和8年10月3日', dateIso: '2026-10-03', title: '損害賠償請求事件', sections: [{ text: '損害賠償' }] },
    });
    put('hanrei_v2/fulltext/90010.json', { id: '90010', text: '理由 被告は原告に損害賠償の責任を負う。' });
    put('hanrei_v2/index.json', { cases: 3 });
    put('hanrei_v2/links/129AC0000000089.json', { 709: { total: 1, items: [{ id: '80001', court: '最高裁判所', dateJp: '平成20年1月1日', url: 'u' }] } });
    const r2 = new R2({ fakeDir: dir });
    const logs = [];
    const res = await N.runQueue({ r2, api: fakeApi(), lex, weekJpy: 20, log: (s) => logs.push(s) });
    check('1 週の上限: 1 件 ¥12 の見込みで上限に当たる前に止め、残りは待ち行列に残す', res.stopped === 'week_budget' && res.left === 1 && Object.keys(get(N.QUEUE).items).join() === '90012', { res, q: get(N.QUEUE) });
    const pol = get(N.POLICY_KEY);
    check('結果を nonum_final.json に足す（asof つき）', pol && pol['90010'].how === 'Jev' && pol['90011'].how === 'Opus' && pol['90010'].asof, pol);
    const L = get('hanrei_v2/links/129AC0000000089.json');
    const it = L && L['709'] && L['709'].items.find((x) => x.id === '90010');
    check('hanrei_v2 の links に judge.by = nonum の item を足す（最高裁の後ろ・total を増やす）', it && it.judge.by === 'nonum' && it.judge.how === 'jev' && L['709'].total === 2 && L['709'].items[0].id === '80001', L);
    const L2 = get('hanrei_v2/links/140AC0000000045.json');
    check('Opus の分は理由を持つ', L2 && L2['199'].items[0].judge.how === 'opus' && L2['199'].items[0].judge.reason === '殺人の故意を判断', L2);
    const cr = get('hanrei_v2/currefs_0900.json');
    check('currefs に how: nonum', cr && cr['90010'][0].how === 'nonum' && cr['90010'][0].show[0].by === 'nonum', cr);
    const b = get(`${J.BUDGET_PREFIX}/${J.month()}.json`);
    check('費用の台帳（月・週）に数える', b && b.nonum.cases === 2 && b.nonum.weeks[J.isoWeek()] > 0, b);
    check('退避してから書き、作業中の印を外す', fs.readdirSync(path.join(dir, 'update_state', 'hanrei_v2_backup')).some((x) => x.startsWith('nonum-')) && !get('update_state/hanrei_apply_inprogress.json'));
    const r2b = new R2({ fakeDir: dir });
    const res2 = await N.runQueue({ r2: r2b, api: fakeApi({ jev429: true }), lex, weekJpy: 1000, log: () => {} });
    check('Jev の 1 日の上限（429）に当たったらその回は止め、待ち行列に残す', res2.stopped === 'jev_daily' && res2.left === 1, res2);
  }

  // ---------------------------------------------------------------- judge_cases: 待ち行列に入れるもの
  {
    const oldTables = new Map([['129AC0000000089', { rewrites: { 570: [['2020-04-01', '平成29年6月2日法律第44号']] } }]]);
    const lineages = new Map([['129AC0000000089', { final: { 570: 'P1', 415: 'P2', 709: 'P3' }, lineage: {
      P1: [{ date: '2020-04-01', op: '新しい規定', law: '平成29年6月2日法律第44号' }],
      P2: [{ date: '2027-04-01', op: '書き直し', law: '令和8年法律第1号' }],
      P3: [{ date: '2027-04-01', op: '書き直し', law: '令和8年法律第1号' }] } }]]);
    const currefs = [
      ['1', [{ lawId: '129AC0000000089', art: '415', how: 'same', from: { lawId: '129AC0000000089', art: '415', ver: '2010-01-01' }, show: [], hide: 'rewrite' }]],
      ['2', [{ lawId: '129AC0000000089', art: '570', how: 'same', from: { lawId: '129AC0000000089', art: '570', ver: '2010-01-01' }, show: [], hide: 'rewrite' }]],
      ['3', [{ lawId: null, art: null, how: 'gone', from: { lawId: '129AC0000000089', art: '43', ver: '1950-01-01' }, show: [{ lawId: '129AC0000000089', art: '709', by: 'opus' }] }]],
      ['4', [{ lawId: '129AC0000000089', art: '709', how: 'nonum', from: null, show: [{ lawId: '129AC0000000089', art: '709', by: 'nonum' }] }]],
      ['5', [{ lawId: '129AC0000000089', art: '709', how: 'same', from: { lawId: '129AC0000000089', art: '709', ver: '2028-01-01' }, show: [{ lawId: '129AC0000000089', art: '709', by: 'lineage' }] }]],
    ];
    const { fresh, items } = JC.findQueueItems(oldTables, lineages, currefs, { judge: {}, nonum: {} });
    check('新しく付いた書き換えの出来事だけ（前の表にある出来事は入れない）', fresh.size === 2 && fresh.has('129AC0000000089|415') && !fresh.has('129AC0000000089|570'), [...fresh]);
    check('待ち行列: 書き換えで載らなくなった引用・Opus の判断・条番号の無い判例の判断した条（系譜で載せたまま・書き換えより後の判決は入れない）',
      items['1|129AC0000000089|415'] && items['1|129AC0000000089|415'].kind === 'rewrite' && items['3|129AC0000000089|43'] && items['3|129AC0000000089|43'].kind === 'redo'
      && items['4|nonum|129AC0000000089|709'] && items['4|nonum|129AC0000000089|709'].kind === 'nonum' && !items['2|129AC0000000089|570'] && Object.keys(items).length === 3, items);
    const none = JC.findQueueItems(new Map([['129AC0000000089', {}]]), lineages, currefs, {});
    check('前の表に rewrites が無ければ（初めて）入れない', none.fresh.size === 0 && !Object.keys(none.items).length);

    // run: 2 回とも通用するなら載せる・片方だけなら載せない・上限
    const dir = path.join(TMP, 'r2b');
    const put = (k, v) => { const p = path.join(dir, ...k.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
    put(JC.QUEUE, { v: 1, items: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { ...v, added: '2026-11-02' }])) });
    put('hanrei_v1/cases_0000.json', { 1: { id: '1', court: '最高裁判所', dateJp: '平成22年1月1日', dateIso: '2010-01-01', sections: [{ text: '民法415条の債務不履行について判断する。' }] }, 3: { id: '3', court: '最高裁判所', dateIso: '1950-01-01', sections: [{ text: '民法43条' }] }, 4: { id: '4', court: '東京地方裁判所', dateIso: '2020-01-01', sections: [{ text: '損害賠償' }] } });
    fs.mkdirSync(path.join(process.env.LINEAGE_DATA, 'out', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(process.env.LINEAGE_DATA, 'out', 'policy', 'nonum_final.json'), JSON.stringify({ 4: { how: 'Jev', decided: ['129AC0000000089|709'] } }));
    fs.writeFileSync(path.join(process.env.LINEAGE_DATA, 'out', 'policy', 'lost_judge.json'), JSON.stringify({ '3|129AC0000000089|43': { applies: ['129AC0000000089|34', '129AC0000000089|709'] } }));
    const r2 = new R2({ fakeDir: dir });
    // 1 回目の問いだけ「通用する」・2 回目は「通用しない」→ 条番号の無い判例（4）から 709 を外す。ほかは 2 回とも通用する
    const api = fakeApi({ judgeReply: (sys) => (/評釈/.test(sys) && api._n++ >= 2 ? '{"misread":false,"select":[],"why":"前提が変わった"}' : '{"misread":false,"applies":["1"],"select":["A"],"reason":"通用する","why":"保たれている"}') });
    api._n = 0;
    const fetchImpl = async () => ({ ok: false, text: async () => '' });   // e-Gov を呼ばない
    const res = await JC.runQueue({ r2, api, runUsd: 5, monthUsd: 20, fetchImpl, log: () => {} });
    const rdp = (f) => JSON.parse(fs.readFileSync(path.join(process.env.LINEAGE_DATA, 'out', 'policy', f), 'utf8'));
    const L1 = rdp('lost_judge.json'), L2 = rdp('lost_judge2.json'), NF = rdp('nonum_final.json');
    check('2 回とも通用する: lost_judge と lost_judge2 の applies に今の条（asof つき）', L1['1|129AC0000000089|415'].applies.join() === '129AC0000000089|415' && L2['1|129AC0000000089|415'].applies.join() === '129AC0000000089|415' && L1['1|129AC0000000089|415'].asof, { L1, L2 });
    check('前の判断のほかの条は残す（34 条はそのまま・709 条を判断し直す）', L1['3|129AC0000000089|43'].applies.includes('129AC0000000089|34') && L1['3|129AC0000000089|43'].applies.includes('129AC0000000089|709'), L1);
    check('条番号の無い判例: 2 回目が通用しないとしたら decided から外す', NF['4'].decided.length === 0 && NF['4'].redone, NF);
    check('判断したものは待ち行列から外し、台帳に数える', res.judged === 3 && res.left === 0, res);
    const r2c = new R2({ fakeDir: dir });
    put(JC.QUEUE, { v: 1, items: { 'x|y|1': { cid: '1', kind: 'rewrite', from: { lawId: '129AC0000000089', art: '415', ver: '2010-01-01' }, target: '129AC0000000089|415', event: ['2027-04-01', 'x'] } } });
    const res3 = await JC.runQueue({ r2: r2c, api: fakeApi(), runUsd: 5, monthUsd: 0.1, fetchImpl, log: () => {} });
    check('月の上限に当たる前に止め、待ち行列に残す', res3.stopped === 'month_budget' && res3.left === 1, res3);
  }

  // ---------------------------------------------------------------- 判例の逆引きの 301 件目以降（lib/links_more.cjs・2026-10-18）
  {
    const LM = require('./lib/links_more.cjs');
    const it = (id, r, d) => ({ id: String(id), r, d });
    const sk = (v) => ({ r: v.r, d: v.d });
    const top = Array.from({ length: 300 }, (_, i) => it(1000 + i, 1, `2020-01-${String(1 + (i % 28)).padStart(2, '0')}`));
    const more = [it(10, 1, '1990-01-01'), it(11, 1, '1980-01-01')];
    const r1 = LM.mergeTop({ total: 302, items: top }, more, [it(5, 3, '2000-01-01'), it(1000, 1, '2020-01-01'), it(12, 1, '1970-01-01')], sk);
    const ids = [...r1.items, ...r1.more].map((x) => x.id);
    check('links_more: 上に入った判例の分だけ上位から押し出して続きの先頭に・下の判例は続きの末尾に・同じ id は足さない・total は足した分だけ',
      r1.items.length === 300 && r1.items[0].id === '5' && r1.added === 2 && r1.total === 304 && new Set(ids).size === 304 && r1.more.length === 4
      && r1.more[r1.more.length - 1].id === '12' && r1.more[r1.more.length - 2].id === '11' && !r1.items.some((x) => x.id === '12'), { more: r1.more.map((x) => x.id), added: r1.added });
    const r2 = LM.mergeTop({ total: 2, items: [it(1, 1, '2020-01-01'), it(2, 1, '2019-01-01')] }, [], [it(3, 2, '2000-01-01')], sk);
    check('links_more: 300 件に届かなければ続きは空', r2.items.length === 3 && r2.more.length === 0 && r2.items[0].id === '3' && r2.total === 3);
    check('links_more: 置き場所（「の」は「_」）', LM.moreKey('129AC0000000089', '709') === 'hanrei_v2/links_more/129AC0000000089/709.json' && LM.moreKey('X', '70の6の2') === 'hanrei_v2/links_more/X/70_6_2.json');
  }

  // ---------------------------------------------------------------- 判決のときの条文（texts.py の控え → 無ければ e-Gov の版）
  {
    const doc = { law_id: '129AC0000000089', asof: '2016-10-13', arts: {
      415: [['1896-04-27', '第四百十五條債務者カ其債務ノ本旨ニ從ヒタル履行ヲ爲ササルトキハ'], ['2004-12-01', '（債務不履行による損害賠償）第四百十五条債務者がその債務の本旨に従った履行をしないときは']],
      34: [['1896-04-27', '第三十四條祭祀、宗教'], ['2008-12-01', null]],
      '398_2': [['1971-06-03', '第三百九十八条ノ二抵当権ハ'], ['1971-06-03', '第三百九十八条ノ二抵当権は（同じ日の後の改正）']] } };
    check('控え: 判決の日より前で一番新しい版（2004 年の現代語化より前の判決は文語の文）・頭の条番号は外す（見出しは残す）', J.textAt(doc, '415', '2003-03-01') === '債務者カ其債務ノ本旨ニ從ヒタル履行ヲ爲ササルトキハ' && J.textAt(doc, '415', '2005-04-13') === '（債務不履行による損害賠償）債務者がその債務の本旨に従った履行をしないときは', [J.textAt(doc, '415', '2003-03-01'), J.textAt(doc, '415', '2005-04-13')]);
    check('控え: 番号を付け替えた条の頭に残る元の番号（第十八条ノ二）も外す', J.textAt({ arts: { 26: [['1983-01-01', '第十八条ノ二管理者は、共用部分を保存し']] } }, '26', '1990-01-01') === '管理者は、共用部分を保存し');
    check('控え: 無くなった後・作られる前は null・枝番は「の」でも引ける・同じ日は後に当てた方', J.textAt(doc, '34', '2010-01-01') === null && J.textAt(doc, '415', '1800-01-01') === null && /同じ日の後/.test(J.textAt(doc, '398の2', '1980-01-01')));
    const xml = '<Law><MainProvision><Article Num="415"><ArticleCaption>（債務不履行）</ArticleCaption><ArticleTitle>第四百十五条</ArticleTitle><Sentence>e-Gov の版の文</Sentence></Article></MainProvision></Law>';
    const egovCalls = [];
    const fetchImpl = async (u) => { egovCalls.push(u); return { ok: true, text: async () => xml }; };
    const load = async (id) => (id === '129AC0000000089' ? doc : null);
    const a = await J.articleAtJudgment({ lawId: '129AC0000000089', art: '415', ver: '2005-04-13' }, null, load, fetchImpl);
    const b = await J.articleAtJudgment({ lawId: '129AC0000000089', art: '415', ver: '2019-05-01' }, null, load, fetchImpl);
    const c = await J.articleAtJudgment({ lawId: '123AC0000000029', art: '89', ver: '1990-01-01', old: true }, null, load, fetchImpl);
    const d = await J.articleAtJudgment({ lawId: '129AC0000000089', art: '415' }, '2003-03-01', load, fetchImpl);
    const e = await J.articleAtJudgment({ lawId: '129AC0000000089', art: '415', ver: '2003-03-01' }, null, async () => ({ ...doc, low: ['415'] }), fetchImpl);
    check('答え合わせで食い違った条（low）は approx', e.approx === true && a.approx === false, { a, e });
    check('asof までの判決は控え（e-Gov を呼ばない）・それより後は e-Gov の版・旧法で控えが無ければ null（e-Gov に旧法は無い）・ver が無ければ判決の日',
      a.src === 'lineage' && b.src === 'egov' && b.text === 'e-Govの版の文' && c.src === null && c.text === null && d.src === 'lineage' && /^債務者カ/.test(d.text) && egovCalls.length === 1, { a, b, c, d, egovCalls });

    // runQueue が R2 lineage_v1/texts/ の控えを Opus への問いに入れる
    const dir = path.join(TMP, 'r2t');
    const put = (k, v) => { const p = path.join(dir, ...k.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
    put(JC.QUEUE, { v: 1, items: { '1|129AC0000000089|415': { cid: '1', kind: 'rewrite', from: { lawId: '129AC0000000089', art: '415', ver: '2003-03-01' }, target: '129AC0000000089|415', event: ['2020-04-01', '平成29年法律第44号'], added: '2026-11-02' } } });
    put('hanrei_v1/cases_0000.json', { 1: { id: '1', court: '最高裁判所', dateIso: '2003-03-01', sections: [{ text: '民法415条の債務不履行について判断する。' }] } });
    put('lineage_v1/texts/129AC0000000089.json', doc);
    const bodies = [];
    const api = fakeApi();
    const opus0 = api.opus;
    api.opus = async (sys, body, n) => { bodies.push(body); return opus0(sys, body, n); };
    const logs = [];
    await JC.runQueue({ r2: new R2({ fakeDir: dir }), api, runUsd: 5, monthUsd: 20, fetchImpl: async () => { throw new Error('e-Gov を呼んだ'); }, log: (s) => logs.push(s) });
    check('段3 の問いに判決のときの条文（控えの文語の文）が入る・2 回とも・数だけログ', bodies.length === 2 && bodies.every((x) => /判決のときの条文: 債務者カ其債務ノ[^（]*（改め文を当てて組み立て直した判決のときの文）/.test(x)) && logs.some((s) => /判決のときの条文: 系譜の控え 1/.test(s)), { bodies: bodies.map((x) => x.slice(0, 300)), logs });
  }

  // ---------------------------------------------------------------- enqueue: 今月の書き換えの出来事の控え・--dry は書かない
  {
    const D = process.env.LINEAGE_DATA;
    const w = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
    w(path.join(D, 'out', 'LAWX', 'lineage.json'), { final: { 3: 'P3' }, lineage: { P3: [{ date: '2027-04-01', op: '書き直し', law: '令和8年法律第9号' }] } });
    w(path.join(D, 'out', 'hanrei_v2', 'hanrei_v2', 'currefs_0001.json'), { 100: [{ lawId: 'LAWX', art: '3', how: 'same', from: { lawId: 'LAWX', art: '3', ver: '2010-01-01' }, show: [], hide: 'rewrite' }] });
    const dir = path.join(TMP, 'r2c');
    const put = (k, v) => w(path.join(dir, ...k.split('/')), v);
    put('lineage_v1/tables/LAWX.json', { law_id: 'LAWX', rewrites: {} });
    const r2 = new R2({ fakeDir: dir });
    const d1 = await JC.enqueue({ r2, dry: true, log: () => {} });
    check('enqueue --dry: 数えるだけで待ち行列も控えも書かない', d1.fresh === 1 && d1.added === 1 && !fs.existsSync(path.join(dir, 'update_state', 'lineage_judge_queue.json')) && !fs.existsSync(path.join(dir, 'update_state', 'lineage_monthly')), d1);
    const d2 = await JC.enqueue({ r2, log: () => {} });
    const rep = JSON.parse(fs.readFileSync(path.join(dir, 'update_state', 'lineage_monthly', `${J.month()}.json`), 'utf8'));
    put('lineage_v1/tables/LAWX.json', { law_id: 'LAWX', rewrites: { 3: [['2027-04-01', '令和8年法律第9号']] } });   // 1 回目の後に表を書いた（2 回目には新しい出来事が無い）
    await JC.enqueue({ r2, log: () => {} });
    const rep2 = JSON.parse(fs.readFileSync(path.join(dir, 'update_state', 'lineage_monthly', `${J.month()}.json`), 'utf8'));
    check('enqueue: 同じ月にもう一度流しても、その月の出来事を消さない（足す）', rep2.events.length === 1 && rep2.events[0].article === 'LAWX|3' && rep2.runs === 2 && rep2.queued_new === 1, rep2);
    check('enqueue: 待ち行列に入れ、今月の書き換えの出来事の控え（条・改正法・施行日・件数だけ）を R2 に残す', d2.added === 1 && rep.fresh_articles === 1 && rep.events[0].article === 'LAWX|3' && rep.events[0].events[0].law === '令和8年法律第9号' && rep.queued_by_kind.rewrite === 1, rep);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `\n${fails} 件 失敗` : '\nすべて通った');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
