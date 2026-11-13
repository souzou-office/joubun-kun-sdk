// 改正で条が丸ごと書き換えられたときの判断し直し（月に 1 回の作り直しの中。docs/lineage.md「判例の週次・改正にこの判定を当てる仕組み」）
//
//   node scripts/lineage/judge_cases.cjs enqueue [--dry]   build の後（--dry は数えるだけで書かない）: 書き換えの出来事が新しく付いた今の条に載っていた判例を待ち行列に入れる（Opus を呼ばない）
//   node scripts/lineage/judge_cases.cjs run       待ち行列を 1 回の上限・月の上限まで Opus 5.5 で判断し、手元の載せる条件の材料（$LINEAGE_DATA/out/policy/）に書く
//   node scripts/lineage/judge_cases.cjs status    待ち行列と今月の費用を見る
//
// enqueue: 今の系譜（$LINEAGE_DATA/out/{法令ID}/lineage.json）から作った書き換えの出来事（lib/currefs.cjs の rewritesOf）を、R2 の前の表
//   （lineage_v1/tables/{法令ID}.json の rewrites）と比べ、新しく付いた出来事のある今の条 X を出す。手元の作り直し（out/hanrei_v2/currefs_*）で
//   (a) 系譜で X に載せていたのに書き換えで載らなくなった引用（hide: rewrite・判決の版がその出来事より前）、(b) Jev の受け皿・判例ごとの Opus の判断・
//   条番号の無い判例の判断した条で X に載せていて、その判断の日（asof）がその出来事より前のもの を R2 update_state/lineage_judge_queue.json に入れる。
// run: 1 件ごとに「判決の判断・論理が今の条 X にも通用するか」を、問い方を変えて 2 回聞く（共有ノートの judge_lost.cjs の 1 回目・2 回目と同じ問い）。
//   両方が X を選んだときだけ載せる（lost_judge.json・lost_judge2.json に asof つきで書く＝decideShow がその条に載せる）。条番号の無い判例の分は、
//   両方が選ばなければ nonum_final.json の decided から X を外す。費用は 1 回 $5（vars JUDGE_RUN_USD）・月 $20（JUDGE_MONTH_USD）まで。溢れた分は翌月へ。
//   R2 update_state/lineage_judge_budget/{月}.json で数える（Jev の 1 日の上限とは別の財布）。
// 書いた材料は、続けて流す relink_hanrei.cjs build → upload が R2 lineage_v1/policy/ と hanrei_v2/ に入れる。ログには件数・判例 ID・費用だけ
'use strict';

const fs = require('fs');
const path = require('path');
const J = require('./lib/llm_jobs.cjs');
const C = require('./lib/currefs.cjs');

const REPO = path.join(__dirname, '..', '..');
const DATA = process.env.LINEAGE_DATA || path.join(REPO, 'lineage_data');
const QUEUE = 'update_state/lineage_judge_queue.json';
const ITEM_MAX_USD = 0.08;   // 1 件（2 回）の費用の見込みの上限
// 判断の日（材料の asof が無いもの）: 旧法の受け皿の判定と判例ごとの Opus の判断は 2026-10-16、条番号の無い判例の判断した条は 2026-10-17
const ASOF_DEFAULT = { jev: '2026-10-16', opus: '2026-10-16', nonum: '2026-10-17' };

const SYS1 = 'あなたは日本の判例と法令の改正に詳しい法律家です。旧法や改正前の条文を引いた判決について、その判決が示した法的な判断・論理が、今の条文の解釈にも通用するかを判断します。判決が実際に判断した法律問題（論点）を判示事項と判決文から読み取り、その論点を今定めている条を候補から選びます。条文同士が似ていても、判決の判断を支えていた前提（要件・効果・制度）が改正で変わっていれば、通用しないとします。判決が引いているのが別の法令の同じ番号の条なら misread とします。答えは JSON だけで返します。';
const SYS2 = 'あなたは日本の判例の評釈を書く法律家です。古い判決が今も先例として使えるかを点検します。手順は 2 段です。第 1 段: 判示事項と判決文から、その判決が実際に判断した法律上の論点を 1 文で書き出し、その論点についての判断の理由づけを 1 文でまとめます。第 2 段: 候補の今の条文のうち、その論点を今定めている条を選び、判決の理由づけを支えていた前提（要件・効果・制度）が今の条でも保たれているかを確かめます。保たれていれば、その条を選びます。前提が変わっていれば選びません。判決が引いているのが別の法令の同じ番号の条なら misread とします。答えは JSON だけで返します。';

const rd = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const wr = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
const policyPath = (f) => path.join(DATA, 'out', 'policy', f);

// ---------------------------------------------------------------- enqueue
/**
 * 新しく付いた書き換えの出来事 → 待ち行列に入れる項目
 * @param {Map<string,object>} oldTables R2 の前の表（法令 ID → 表）
 * @param {Map<string,object>} lineages 今の系譜（法令 ID → lineage.json）
 * @param {Iterable<[string, object[]]>} currefs 手元の作り直しの [判例 ID, curRefs]
 * @param {object} policy { judge, nonum }（asof を見る）
 */
function findQueueItems(oldTables, lineages, currefs, policy) {
  const fresh = new Map();   // 'lawId|art' → [[date, law]]（新しい出来事だけ）
  for (const [id, L] of lineages) {
    const T = oldTables.get(id);
    if (!T || !T.rewrites) continue;   // 前の表に rewrites が無い（初めて）: 比べる元が無いので入れない
    const now = C.rewritesOf(L);
    for (const [art, evs] of Object.entries(now)) {
      const before = new Set((T.rewrites[art] || []).map((e) => `${e[0]}|${e[1]}`));
      const add = evs.filter((e) => !before.has(`${e[0]}|${e[1]}`) && !/平成16年12月1日法律第147号|平成7年5月12日法律第91号/.test(e[1] || ''));
      if (add.length) fresh.set(`${id}|${art}`, add);
    }
  }
  const items = {};
  if (!fresh.size) return { fresh, items };
  const P = policy || {};
  for (const [cid, refs] of currefs) {
    for (const c of refs || []) {
      const fr = c.from || {};
      // (a) 系譜で載せていたのに書き換えで載らなくなった
      if (c.hide === 'rewrite') {
        const X = `${c.lawId}|${c.art}`;
        const ev = (fresh.get(X) || []).find((e) => (e[0] || '') > (fr.ver || ''));
        if (ev) items[`${cid}|${fr.lawId}|${fr.art}`] = { cid, kind: 'rewrite', from: fr, target: X, event: ev };
        continue;
      }
      // (b) AI の判断で載せていた（判断の日より後に書き換え）
      for (const d of c.show || []) {
        if (!['jev', 'opus', 'nonum'].includes(d.by)) continue;
        const X = `${d.lawId}|${d.art}`;
        let asof = ASOF_DEFAULT[d.by];
        if (d.by === 'opus') { const j = P.judge && P.judge[`${cid}|${fr.lawId}|${fr.art}`]; if (j && j.asof) asof = j.asof; }
        if (d.by === 'nonum') { const n = P.nonum && P.nonum[cid]; if (n && n.asof) asof = n.asof; }
        const ev = (fresh.get(X) || []).find((e) => (e[0] || '') > asof);
        if (!ev) continue;
        const key = d.by === 'nonum' ? `${cid}|nonum|${X}` : `${cid}|${fr.lawId}|${fr.art}`;
        items[key] = { cid, kind: d.by === 'nonum' ? 'nonum' : 'redo', by: d.by, from: d.by === 'nonum' ? null : fr, target: X, event: ev };
      }
    }
  }
  return { fresh, items };
}

async function enqueue({ r2, dry = false, log = console.log }) {
  const ids = fs.readdirSync(path.join(DATA, 'out')).filter((x) => /^[0-9A-Za-z]+$/.test(x) && fs.existsSync(path.join(DATA, 'out', x, 'lineage.json')));
  const oldTables = new Map(), lineages = new Map();
  const { R2 } = require('../update/lib/r2.cjs');
  await R2.pmap(ids, 8, async (id) => { const t = await r2.getJson(`lineage_v1/tables/${id}.json`); if (t) oldTables.set(id, t); });
  for (const id of ids) lineages.set(id, rd(path.join(DATA, 'out', id, 'lineage.json'), null));
  const dir = path.join(DATA, 'out', 'hanrei_v2', 'hanrei_v2');
  function* currefs() { for (const f of fs.readdirSync(dir).filter((x) => /^currefs_\d+\.json$/.test(x))) yield* Object.entries(rd(path.join(dir, f), {})); }
  const policy = { judge: rd(policyPath('lost_judge.json'), {}), nonum: rd(policyPath('nonum_final.json'), {}) };
  const { fresh, items } = findQueueItems(oldTables, lineages, currefs(), policy);
  const q = (await r2.getJson(QUEUE)) || { v: 1, items: {} };
  let added = 0;
  for (const [k, v] of Object.entries(items)) if (!q.items[k]) { q.items[k] = { ...v, added: J.today() }; added++; }
  q.updatedAt = new Date().toISOString();
  // 今月の書き換えの出来事の控え（R2 update_state/lineage_monthly/{月}.json。条と改正法と施行日・待ち行列に入れた件数だけ。判決文は置かない）
  const events = [...fresh].map(([k, evs]) => ({ article: k, events: evs.map((e) => ({ d: e[0], law: e[1] })) })).sort((a, b) => a.article.localeCompare(b.article));
  const byKind = {};
  for (const v of Object.values(items)) byKind[v.kind] = (byKind[v.kind] || 0) + 1;
  const report = { month: J.month(), at: new Date().toISOString(), fresh_articles: fresh.size, queued_new: added, queued_by_kind: byKind, queue_total: Object.keys(q.items).length, events };
  if (!dry) {
    await r2.put(QUEUE, JSON.stringify(q));
    // 同じ月にもう一度流したとき（手で流し直した・作り直しを 2 回）も、その月の出来事を消さずに足す
    const mkey = `update_state/lineage_monthly/${J.month()}.json`;
    const prev = await r2.getJson(mkey);
    if (prev && Array.isArray(prev.events)) {
      const have = new Map(prev.events.map((e) => [e.article, e]));
      for (const e of report.events) have.set(e.article, e);
      report.events = [...have.values()].sort((x, y) => x.article.localeCompare(y.article));
      report.fresh_articles = report.events.length;
      report.queued_new = (prev.queued_new || 0) + added;
      for (const [k, n] of Object.entries(prev.queued_by_kind || {})) report.queued_by_kind[k] = (report.queued_by_kind[k] || 0) + n;
      report.runs = (prev.runs || 1) + 1;
    }
    await r2.put(mkey, JSON.stringify(report));
  }
  log(`新しく書き換えの出来事が付いた今の条 ${fresh.size}・待ち行列に足した ${added} 件（${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join('・') || 'なし'}・全部で ${Object.keys(q.items).length} 件）${dry ? '（--dry: 書いていない）' : ''}`);
  for (const e of events.slice(0, 20)) log(`  ${e.article}: ${e.events.map((x) => `${x.d} ${x.law}`).join('、')}`);
  return { fresh: fresh.size, added, total: Object.keys(q.items).length, report };
}

// ---------------------------------------------------------------- run
const KAN = '〇一二三四五六七八九';
const kan = (n) => { let s = ''; for (const [v, u] of [[1000, '千'], [100, '百'], [10, '十']]) { const q = Math.floor(n / v); n %= v; if (q) s += (q === 1 ? '' : KAN[q]) + u; } return s + (n ? KAN[n] : ''); };
function passage(text, art) {
  const t = J.z2h(text);
  const b = Number(String(art || '').split(/[_の]/)[0]);
  if (!b) return '';
  for (const re of [new RegExp(`(?<!\\d)${b}条`), new RegExp(`${kan(b)}条`)]) { const m = t.match(re); if (m) return t.slice(Math.max(0, m.index - 300), m.index + 300).replace(/\s+/g, ''); }
  return '';
}
const artName = (a) => `第${String(a).replace(/_/g, 'の')}条`;

/** 1 件を 2 回判断する → { a1: boolean, a2: boolean, misread, usd, reason } */
async function judgeItem(it, ctx) {
  const { rec, text, oldText, cur } = ctx;
  const fr = it.from;
  const cited = fr ? `${fr.law || fr.lawId} ${artName(fr.art)}${fr.old ? '（旧法）' : '（判決のときの版）'}` : '（判決文に条番号は無い。判断した条として付けていた）';
  const head = `判決: ${rec.court || ''} ${rec.dateJp || ''} ${rec.caseNo || ''} ${rec.title || ''}\n判示事項: ${(rec.hanji || rec.yoshi || '（なし）').slice(0, 600)}\n判決文の該当箇所: ${(fr ? passage(text, fr.art) : J.judgePart(rec, J.cleanText(text)).slice(0, 4000)) || '（見つからない）'}\n\n判決が引いた条: ${cited}\n判決のときの条文: ${oldText || '（手元に無い）'}\n`;
  const candLine = cur ? `${cur.title} ${cur.caption} ${cur.text}` : `${it.target}（今の条文を取れなかった）`;
  const b1 = `${head}\n候補（今の条文。${it.event[0]} 施行の ${it.event[1]} で書き換えられた後）:\n[1] ${candLine}\n\n次の JSON だけを返してください: {"misread":true/false,"applies":["判決の判断・論理が今も通用する候補の番号。無ければ空"],"premise_changed":true/false（改正で判断の前提が変わったか）,"reason":"60字以内"}`;
  const b2 = `【判決】${rec.court || ''} ${rec.dateJp || ''} ${rec.caseNo || ''} ${rec.title || ''}\n${head.split('\n').slice(1).join('\n')}\n【今の条文の候補】（${it.event[0]} 施行の ${it.event[1]} で書き換えられた後）\n(A) ${candLine}\n\n次の JSON だけを返してください: {"issue":"判決が判断した論点（1文）","reasoning":"判断の理由づけ（1文）","misread":true/false,"select":["その論点を今定め、理由づけの前提も保たれている候補の記号（例: A）。無ければ空"],"why":"60字以内"}`;
  const o1 = await ctx.api.opus(SYS1, b1, 1500);
  const o2 = await ctx.api.opus(SYS2, b2, 1800);
  const r1 = J.parseJsonReply(o1.text), r2 = J.parseJsonReply(o2.text);
  const a1 = !!(r1 && !r1.misread && (r1.applies || []).map(String).includes('1'));
  const a2 = !!(r2 && !r2.misread && (r2.select || []).map((x) => String(x).trim().toUpperCase()).includes('A'));
  return { a1, a2, r1, r2, usd: o1.usd + o2.usd };
}

async function runQueue({ r2, api, runUsd, monthUsd, fetchImpl = fetch, log = console.log }) {
  const q = (await r2.getJson(QUEUE)) || { v: 1, items: {} };
  const keys = Object.keys(q.items).sort((a, b) => String(q.items[a].added || '').localeCompare(String(q.items[b].added || '')) || a.localeCompare(b));
  const budget = await J.loadBudget(r2);
  const jb = budget.doc.judge;
  const rid = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  jb.runs = jb.runs || {};
  let runSpent = 0, stopped = null;
  const L1 = rd(policyPath('lost_judge.json'), {}), L2 = rd(policyPath('lost_judge2.json'), {}), NF = rd(policyPath('nonum_final.json'), {});
  const memo = new Map();
  const textsMemo = new Map();
  const oldSrc = {};
  // 判決のときの条文の控え（texts.py）: 手元の $LINEAGE_DATA/out/texts/ か R2 lineage_v1/texts/
  const loadTexts = async (lawId) => {
    if (!textsMemo.has(lawId)) {
      const p = path.join(DATA, 'out', 'texts', `${lawId}.json`);
      let doc = null;
      try { doc = fs.existsSync(p) ? rd(p, null) : await r2.getJson(`lineage_v1/texts/${lawId}.json`); } catch { doc = null; }
      textsMemo.set(lawId, doc);
    }
    return textsMemo.get(lawId);
  };
  const done = [];
  const out = { keep: 0, drop: 0 };
  log(`待ち行列 ${keys.length} 件・今月の費用 $${(jb.usd || 0).toFixed(2)} / $${monthUsd}・1 回 $${runUsd}`);
  for (const k of keys) {
    if (runSpent + ITEM_MAX_USD > runUsd) { stopped = 'run_budget'; break; }
    if ((jb.usd || 0) + ITEM_MAX_USD > monthUsd) { stopped = 'month_budget'; break; }
    const it = q.items[k];
    const sk = `hanrei_v1/cases_${String(Math.floor(parseInt(it.cid, 10) / 100)).padStart(4, '0')}.json`;
    if (!memo.has(sk)) memo.set(sk, (await r2.getJson(sk)) || {});
    const rec = memo.get(sk)[it.cid];
    if (!rec) { done.push(k); continue; }
    const ft = await r2.getJson(`hanrei_v2/fulltext/${it.cid}.json`);
    const text = (ft && ft.text) || (rec.sections || []).map((s) => (s && s.text) || '').join('\n');
    const [tl, ta] = it.target.split('|');
    const at = await J.articleAtJudgment(it.from, rec.dateIso, loadTexts, fetchImpl);
    // 系譜の控えは名古屋大学のデータの改め文を当てて組み立てた文。e-Gov の版と食い違った条はそう添える（Opus が文の細部に頼りすぎない）
    const oldText = at.text && at.src === 'lineage' ? `${at.text}（改め文を当てて組み立て直した判決のときの文${at.approx ? '。この条は後の版との答え合わせで食い違いがあり、細かい改正が当たっていないことがある。参考にとどめる' : ''}）` : at.text;
    { const k = at.approx ? 'lineage_approx' : (at.src || 'none'); oldSrc[k] = (oldSrc[k] || 0) + 1; }
    let res;
    try { res = await judgeItem(it, { rec, text, oldText, cur: await api.article(tl, ta), api }); }
    catch (e) { it.tries = (it.tries || 0) + 1; if (it.tries >= 3) done.push(k); continue; }
    runSpent += res.usd;
    jb.usd = (jb.usd || 0) + res.usd;
    jb.items = (jb.items || 0) + 1;
    const keep = res.a1 && res.a2;
    if (keep) out.keep++; else out.drop++;
    const asof = J.today();
    if (it.kind === 'nonum') {
      const n = NF[it.cid];
      if (n && !keep) { n.decided = (n.decided || []).filter((x) => String(x).replace(/_/g, 'の') !== it.target); n.redone = { asof, target: it.target, event: it.event }; }
      if (n && keep) n.asof = asof;
    } else {
      // 両方が今の条 X を選んだときだけ applies に X（decideShow が両方の applies の重なりに載せる）。前の判断のほかの条はそのまま残す
      const norm = (a) => String(a).replace(/_/g, 'の');
      const keepOthers = (e) => ((e && !e.misread && Array.isArray(e.applies)) ? e.applies.map(norm).filter((a) => a !== it.target) : []);
      const o1 = keepOthers(L1[k]), o2 = keepOthers(L2[k]);
      L1[k] = { applies: [...o1, ...(res.a1 ? [it.target] : [])], misread: !!(res.r1 && res.r1.misread) && !o1.length, reason: res.r1 && res.r1.reason ? String(res.r1.reason).slice(0, 300) : ((L1[k] && L1[k].reason) || ''), asof, event: it.event, kind: it.kind };
      L2[k] = { applies: [...o2, ...(res.a2 ? [it.target] : [])], misread: !!(res.r2 && res.r2.misread) && !o2.length, why: res.r2 && res.r2.why ? String(res.r2.why).slice(0, 300) : '', asof };
    }
    done.push(k);
    log(`  ${it.cid} ${it.target}: ${keep ? '載せる' : '載せない'}（$${res.usd.toFixed(3)}）`);
  }
  wr(policyPath('lost_judge.json'), L1);
  wr(policyPath('lost_judge2.json'), L2);
  wr(policyPath('nonum_final.json'), NF);
  for (const k of done) delete q.items[k];
  q.updatedAt = new Date().toISOString();
  await r2.put(QUEUE, JSON.stringify(q));
  jb.runs[rid] = runSpent;
  await J.saveBudget(r2, budget);
  log(`判決のときの条文: ${Object.entries(oldSrc).map(([k, n]) => `${{ lineage: '系譜の控え', lineage_approx: '系譜の控え（食い違いあり）', egov: 'e-Gov の版', none: '無し' }[k] || k} ${n}`).join('・') || '（判断なし）'}`);
  log(`判断した ${done.length} 件（載せる ${out.keep}・載せない ${out.drop}）・この回 $${runSpent.toFixed(2)}・今月 $${(jb.usd || 0).toFixed(2)}・残り ${Object.keys(q.items).length} 件${stopped ? `・止めた理由 ${stopped}` : ''}`);
  return { judged: done.length, keep: out.keep, drop: out.drop, left: Object.keys(q.items).length, stopped };
}

module.exports = { findQueueItems, enqueue, runQueue, judgeItem, QUEUE };

if (require.main === module) {
  (async () => {
    const mode = process.argv[2] || 'status';
    const { R2 } = require('../update/lib/r2.cjs');
    const r2 = new R2();
    if (mode === 'enqueue') { await enqueue({ r2, dry: process.argv.includes('--dry') }); return; }
    if (mode === 'run') {
      const api = J.makeApi({ url: process.env.JUDGE_URL, key: process.env.JUDGE_KEY });
      const r = await runQueue({ r2, api, runUsd: Number(process.env.JUDGE_RUN_USD || 5), monthUsd: Number(process.env.JUDGE_MONTH_USD || 20) });
      // 判断した件数を Actions に渡す（0 なら作り直しをもう一度流さない）
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `judged=${r.judged}\n`);
      return;
    }
    const q = (await r2.getJson(QUEUE)) || { items: {} };
    const b = await J.loadBudget(r2);
    console.log(`待ち行列 ${Object.keys(q.items || {}).length} 件・今月 $${(b.doc.judge.usd || 0).toFixed(2)}（${b.doc.judge.items || 0} 件）`);
  })().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
}
