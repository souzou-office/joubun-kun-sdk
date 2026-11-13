// 条番号の無い新しい判例に「判断した条」を付ける（判例の週次の後。docs/lineage.md「判例の週次・改正にこの判定を当てる仕組み」）
//
//   node scripts/lineage/nonum_cases.cjs run [--dry]     待ち行列の判例を、1 週の上限まで判断して R2 に書く
//   node scripts/lineage/nonum_cases.cjs status          待ち行列と今週・今月の費用を見る（書かない）
//
// 待ち行列: R2 update_state/lineage_nonum_queue.json（判例の週次 scripts/hanrei/weekly/run.cjs が、引用を 1 つも読めず判決文に「法令名＋第○条」の
//   形も無い新しい判例を足す）。流れ（2026-10-17 に 3,776 件で作った共有ノートの nonum.cjs・llm_pick.cjs と同じ）:
//   1. 載せないもの: 判決文の無いもの・最高裁の「上告理由に当たらない」型の決定（lib/currefs.cjs の noGroundDecision）
//   2. 論点の文（判示事項・要旨。無ければ理由の冒頭 1,500 字。条番号は伏せる）→ 本番の /api/select（flags.jevNarrowOpus: 0）で候補の条
//   3. 判決の全文を Jev に 1 回渡して候補ごとに採点し、0.7 以上を判断した条（how: Jev）
//   4. 決まらなければ、条例の判決は載せない。それ以外は Opus 5.5 が判示事項・判決文（3 万字を超えたら判断の段から 2.8 万字）・候補の今の条文から
//      3 本まで選ぶ（how: Opus・理由つき）。候補の外の条は、法令名を辞書で引き、/api/articles で今の条があると確かめたものだけ。選ばなければ載せない
// 結果は R2 lineage_v1/policy/nonum_final.json に足し（判例 ID → { how, decided, reason, asof }）、hanrei_v2 の currefs・links にも足す
// （どちらも書く前に update_state/hanrei_v2_backup/nonum-{run}/ に退避・判例の週次と同じ作業中の印を取る）。
// 費用は 1 件 ¥3〜¥12。1 週の上限（vars NONUM_WEEK_JPY・既定 ¥1,500）と月の台帳（R2 update_state/lineage_judge_budget/{月}.json）で守り、
// 溢れた分は待ち行列に残して次の週に回す。Jev の 1 日の上限（JEV_DAILY_USD）に当たったら（429）その回は止める。
// 必要な env: JUDGE_URL（本番の Worker）・JUDGE_KEY（バイパスキー）と R2 の鍵。ログには件数・判例 ID・費用だけ
'use strict';

const path = require('path');
const crypto = require('crypto');
const J = require('./lib/llm_jobs.cjs');
const C = require('./lib/currefs.cjs');

const QUEUE = 'update_state/lineage_nonum_queue.json';
const POLICY_KEY = 'lineage_v1/policy/nonum_final.json';
const V2 = 'hanrei_v2';
const LOCK = 'update_state/hanrei_apply_inprogress.json';
const LM = require('./lib/links_more.cjs');
const LINKS_TOP = LM.LINKS_TOP;
const CASE_MAX_JPY = 12;   // 1 件の費用の見込みの上限（上限に当たる前に止めるため）

const SYS_PICK = 'あなたは日本の判例と法令に詳しい法律家です。判決文を読み、その判決が実際に争われた法律上の論点として解釈・適用を判断した条を、今の法令の条から選びます。判決が条番号を書いていなくても、判断の中身から条を特定します。判決のときの法令が今と違う（旧法・改正前・旧制度）なら、判決の判断・論理が今も通用する今の条を選び、通用する条が無ければ選びません。訴訟費用の負担・上訴の棄却の根拠など手続の決まりごとだけの条、事実の説明で触れただけの条は選びません。約款・契約の解釈だけで法律の条を判断していないなら何も選びません。迷う候補が並ぶときは、判決の判断の中心にある条を選び、関係の薄い条は外します。答えは JSON だけで返します。';

const KN = { '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const kan2n = (s) => { if (/^\d+$/.test(s)) return +s; if (/^[〇一二三四五六七八九]+$/.test(s) && s.length > 1) return +[...s].map((c) => KN[c]).join(''); let n = 0, cur = 0; for (const ch of s) { if (ch in KN) cur = KN[ch]; else { n += (cur || 1) * ({ 十: 10, 百: 100, 千: 1000 }[ch] || 0); cur = 0; } } return n + cur; };

// 「法令名第N条（のM）」→ 今の法令ID|条（法令名は辞書と略し方の表で引く・今の条があるものだけ）
async function resolveOther(s, lex, api) {
  const m = J.z2h(s).replace(/\s/g, '').match(/^(.+?)第?([0-9〇一二三四五六七八九十百千]+)条((?:の[0-9〇一二三四五六七八九十]+)*)/);
  if (!m) return null;
  const parse = require('../hanrei/03_parse.cjs');
  const id = lex.nameToId.get(m[1]) || (parse.ALIAS[m[1]] || [])[0] || null;
  if (!id) return null;
  const art = [kan2n(m[2]), ...(m[3] ? m[3].split('の').filter(Boolean).map(kan2n) : [])].join('の');
  const a = await api.article(id, art);
  return a ? `${id}|${art}` : null;
}

/**
 * 判例 1 件の判断した条を決める。→ { res: { how, decided, reason?, scores? }, jpy, usd }
 * @param {object} rec 判例（hanrei_v1/cases の 1 件）
 * @param {string} text 判決文の全文（無ければ区切りをつないだもの）
 */
async function decideCase(rec, text, api, lex) {
  let jpy = 0, usd = 0;
  const t = J.cleanText(text);
  if (!t) return { res: { how: '判決文なし', decided: [] }, jpy, usd };
  if (C.noGroundDecision({ court: rec.court, sections: [{ text: t }] })) return { res: { how: '上告理由に当たらない等', decided: [] }, jpy, usd };
  const q = J.issueText(rec, t);
  if (!q) return { res: { how: '論点の文が空', decided: [] }, jpy, usd };
  const s = await api.select(q);
  jpy += s.jpy;
  const j = await api.jevScore(rec, t, s.cands);
  usd += j.usd;
  const sc = Object.entries(j.scores).filter(([, v]) => typeof v === 'number').sort((a, b) => b[1] - a[1]);
  const decided = sc.filter(([, v]) => v >= 0.7).map(([k]) => k);
  if (decided.length) return { res: { how: 'Jev', decided, scores: j.scores }, jpy, usd };
  if (/条例/.test(t)) return { res: { how: '条例', decided: [], scores: j.scores }, jpy, usd };
  const body = `判決: ${rec.court || ''} ${rec.dateJp || ''} ${rec.caseNo || ''} ${rec.title || ''}\n判示事項・要旨: ${(`${rec.hanji || ''} ${rec.yoshi || ''}`.trim() || '（なし）').slice(0, 800)}\n判決文${t.length > 30000 ? '（判断の部分から 2.8 万字）' : ''}: ${J.judgePart(rec, t)}\n\n候補（今の条文）:\n` +
    s.cands.map((c, i) => `[${i + 1}] ${c.title} ${c.caption} ${c.text}`).join('\n') +
    '\n\n次の JSON だけを返してください: {"picks":[判決が判断した候補の番号。多くても 3 つ。無ければ空],"other":["候補に無い今の条で、判決が判断したもの。正式な法令名と条を『法令名第N条』の形で。無ければ空"],"none":"何も選ばないときの理由（約款の解釈だけ・手続だけ・通用する今の条が無い など）。選んだなら空","reason":"60字以内"}';
  const o = await api.opus(SYS_PICK, body, 1200);
  usd += o.usd;
  const r = J.parseJsonReply(o.text);
  const picks = ((r && r.picks) || []).map((n) => s.cands[Number(n) - 1]).filter(Boolean).map((c) => `${c.law}|${c.art}`);
  const other = [];
  for (const x of ((r && r.other) || []).slice(0, 3)) { const to = await resolveOther(String(x), lex, api); if (to) other.push(to); }
  const dec = [...new Set([...picks, ...other])].slice(0, 3);
  if (!dec.length) return { res: { how: 'Opusが選ばない', decided: [], ...(r && r.none ? { reason: String(r.none).slice(0, 200) } : {}) }, jpy, usd };
  return { res: { how: 'Opus', decided: dec, ...(r && r.reason ? { reason: String(r.reason).slice(0, 300) } : {}) }, jpy, usd };
}

// ---------------------------------------------------------------- R2
const shardOf = (id) => String(Math.floor(parseInt(id, 10) / 100)).padStart(4, '0');
async function caseRecord(r2, id, memo) {
  const k = `hanrei_v1/cases_${shardOf(id)}.json`;
  if (!memo.has(k)) memo.set(k, (await r2.getJson(k)) || {});
  return memo.get(k)[id] || null;
}
async function caseText(r2, id, rec) {
  const ft = await r2.getJson(`${V2}/fulltext/${id}.json`);
  if (ft && typeof ft.text === 'string' && ft.text) return ft.text;
  return ((rec && rec.sections) || []).map((s) => (s && s.text) || '').join('\n');
}

// hanrei_v2 に足す（links は 07 と同じ並び: 裁判所のランク → 判決日 → id の降順・上位 300 件。currefs に how: 'nonum'）
async function applyToV2(r2, decided, recs, rid, log) {
  const { courtRank, artCompare } = require('../hanrei/07_build_upload_r2.cjs');
  const { warekiToIso } = require('../hanrei/lib_common.cjs');
  const files = new Map();
  const load = async (k, d) => { if (!files.has(k)) files.set(k, (await r2.getJson(k)) || d); return files.get(k); };
  let added = 0;
  for (const [id, res] of Object.entries(decided)) {
    const rec = recs.get(id);
    if (!rec || !res.decided.length) continue;
    const sh = await load(`${V2}/currefs_${shardOf(id)}.json`, {});
    const cur = Array.isArray(sh[id]) ? sh[id].filter((c) => c.how !== 'nonum') : [];
    const refs = [];
    for (const key of res.decided) {
      const [lawId, art0] = key.split('|');
      const art = String(art0 || '').replace(/_/g, 'の');
      if (!/^[0-9A-Za-z_]+$/.test(lawId) || !/^\d+(の\d+)*$/.test(art)) continue;
      const s = res.scores && typeof res.scores[key] === 'number' ? res.scores[key] : null;
      const T = await load(`lineage_v1/tables/${lawId}.json`, null);   // 注記（判決の後の改正・判決の後にできた条）の材料
      files.delete(`lineage_v1/tables/${lawId}.json`);                   // 表は読むだけ（書かない）
      const notes = C.nonumNotes(T, art, rec.dateIso);
      refs.push({ lawId, art, how: 'nonum', from: null, conf: s, ...(notes.length ? { notes } : {}), show: [{ lawId, art, by: 'nonum', ...(s != null ? { s } : {}) }] });
      const links = await load(`${V2}/links/${lawId}.json`, {});
      const e = links[art] || { total: 0, items: [] };
      if (e.items.some((x) => String(x.id) === String(id))) continue;
      // 上位 300 件から押し出された判例は 301 件目からの続き（links_more）に移す（2026-10-18・lib/links_more.cjs）。続きは 300 件を超えるときだけ読む
      const more = (e.total || 0) > e.items.length || e.items.length + 1 > LINKS_TOP ? await load(LM.moreKey(lawId, art), { total: 0, items: [] }) : null;
      if (more && (more.items || []).some((x) => String(x.id) === String(id))) continue;
      const v = C.linkItem(rec, null, notes);
      const how = res.how === 'Opus' ? 'opus' : 'jev';
      v.judge = { by: 'nonum', how, ...(how === 'opus' && res.reason ? { reason: res.reason } : {}) };
      // 07 と同じ並び（裁判所のランク → 判決日 → id の降順）。item は判決日を和暦で持つので ISO に直して比べる
      const sk = (x) => ({ r: courtRank(x.court), d: (x === v ? rec.dateIso : warekiToIso(x.dateJp)) || '' });
      const next = LM.mergeTop(e, (more && more.items) || [], [v], sk);
      links[art] = { ...e, total: next.total, items: next.items };
      if (more) { more.total = next.total; more.items = next.more; }
      const sorted = {};
      for (const k of Object.keys(links).sort(artCompare)) sorted[k] = links[k];
      files.set(`${V2}/links/${lawId}.json`, sorted);
      added++;
    }
    sh[id] = [...cur, ...refs];
  }
  if (!files.size) return 0;
  // 退避してから書く（判例の週次と同じ作業中の印）
  const token = crypto.randomBytes(12).toString('hex');
  if (await r2.getJson(LOCK)) throw new Error(`${LOCK} がある（判例の週次か付け直しが動いている）。書かない`);
  if (!(await r2.putIfAbsent(LOCK, JSON.stringify({ run_id: `nonum-${rid}`, kind: 'nonum', token, started_at: new Date().toISOString() })))) throw new Error(`${LOCK} を取れなかった`);
  try {
    const backup = `update_state/hanrei_v2_backup/nonum-${rid}`;
    const over = [];
    for (const k of files.keys()) { const b = await r2.get(k); if (b) { await r2.put(`${backup}/${k}`, b); over.push(k); } }
    await r2.put(`${backup}/_manifest.json`, JSON.stringify({ run_id: rid, overwritten: over, added: [...files.keys()].filter((k) => !over.includes(k)) }));
    for (const [k, v] of files) await r2.put(k, JSON.stringify(v));
    log(`hanrei_v2 に足した: ${added} 組（${files.size} ファイル・退避 ${backup}/）`);
  } finally {
    const cur = await r2.getJson(LOCK);
    if (cur && cur.token === token) await r2.delete(LOCK);
  }
  return added;
}

/**
 * 待ち行列を 1 週の上限まで判断する。api・r2・lex は差し替えられる（check_judge.cjs）
 * @returns {{ done: string[], left: number, jpy: number, stopped: string|null, results: object }}
 */
async function runQueue({ r2, api, lex, weekJpy, dry = false, log = console.log }) {
  const q = (await r2.getJson(QUEUE)) || { v: 1, items: {} };
  const ids = Object.keys(q.items || {}).sort((a, b) => String(q.items[a].added || '').localeCompare(String(q.items[b].added || '')) || parseInt(a, 10) - parseInt(b, 10));
  const budget = await J.loadBudget(r2);
  const wk = J.isoWeek();
  const nb = budget.doc.nonum;
  nb.weeks = nb.weeks || {};
  const spentWeek = () => nb.weeks[wk] || 0;
  log(`待ち行列 ${ids.length} 件・今週（${wk}）の費用 ¥${Math.round(spentWeek())} / 上限 ¥${weekJpy}`);
  const memo = new Map(), recs = new Map(), results = {};
  const done = [];
  let stopped = null;
  for (const id of ids) {
    if (spentWeek() + CASE_MAX_JPY > weekJpy) { stopped = 'week_budget'; break; }
    const rec = await caseRecord(r2, id, memo);
    if (!rec) { done.push(id); continue; }   // 判例が無い（取り下げ）: 行列から外す
    recs.set(id, rec);
    if (dry) { done.push(id); continue; }
    let r;
    try { r = await decideCase(rec, await caseText(r2, id, rec), api, lex); }
    catch (e) { if (e.budget) { stopped = 'jev_daily'; break; } q.items[id].tries = (q.items[id].tries || 0) + 1; q.items[id].error = String(e.message || e).slice(0, 80); if (q.items[id].tries >= 3) done.push(id); continue; }
    const jpy = r.jpy + r.usd * J.USD_JPY;
    nb.weeks[wk] = spentWeek() + jpy;
    nb.jpy = (nb.jpy || 0) + jpy;
    nb.cases = (nb.cases || 0) + 1;
    results[id] = { ...r.res, asof: J.today() };
    done.push(id);
    log(`  ${id}: ${r.res.how}（${r.res.decided.length} 条・¥${jpy.toFixed(1)}）`);
  }
  if (dry) { log(`（--dry）判断する判例 ${done.length} 件`); return { done, left: ids.length - done.length, jpy: 0, stopped, results }; }
  // 結果 → nonum_final.json（退避してから書く）→ hanrei_v2 → 待ち行列と台帳
  const rid = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  if (Object.keys(results).length) {
    const got = await r2.getWithEtag(POLICY_KEY);
    const pol = got ? JSON.parse(got.body.toString('utf8')) : {};
    if (got) await r2.put(`update_state/hanrei_v2_backup/nonum-${rid}/${POLICY_KEY}`, got.body);
    for (const [id, r] of Object.entries(results)) pol[id] = r;
    if (!(await r2.putIfMatch(POLICY_KEY, JSON.stringify(pol), got ? got.etag : null))) throw new Error(`${POLICY_KEY} が書き込みの間に変わった。書かずに止める`);
    const decided = Object.fromEntries(Object.entries(results).filter(([, r]) => r.decided.length));
    if (await r2.getJson(`${V2}/index.json`)) await applyToV2(r2, decided, recs, rid, log);
  }
  for (const id of done) delete q.items[id];
  q.updatedAt = new Date().toISOString();
  await r2.put(QUEUE, JSON.stringify(q));
  await J.saveBudget(r2, budget);
  const by = {};
  for (const r of Object.values(results)) by[r.how] = (by[r.how] || 0) + 1;
  log(`判断した ${Object.keys(results).length} 件（${Object.entries(by).map(([k, n]) => `${k} ${n}`).join('・') || 'なし'}）・残り ${Object.keys(q.items).length} 件・今週 ¥${Math.round(spentWeek())}${stopped ? `・止めた理由 ${stopped}` : ''}`);
  return { done, left: Object.keys(q.items).length, jpy: spentWeek(), stopped, results };
}

// 判例の週次（run.cjs relinkNew）から: 新しい判例を待ち行列に入れるかの判定（引用を 1 つも読めず、判決文に「法令名＋第○条」の形も無い）
const isNoNumCase = (rec, text) => !(Array.isArray(rec && rec.lawRefs) && rec.lawRefs.length) && !!String(text || '').trim() && !J.hasLawArticle(text);

module.exports = { decideCase, runQueue, applyToV2, isNoNumCase, resolveOther, QUEUE, POLICY_KEY };

if (require.main === module) {
  (async () => {
    const mode = process.argv[2] || 'status';
    const { R2 } = require('../update/lib/r2.cjs');
    const r2 = new R2();
    if (mode === 'status') {
      const q = (await r2.getJson(QUEUE)) || { items: {} };
      const b = await J.loadBudget(r2);
      console.log(`待ち行列 ${Object.keys(q.items || {}).length} 件・今月 ¥${Math.round(b.doc.nonum.jpy || 0)}（${b.doc.nonum.cases || 0} 件）・今週 ¥${Math.round((b.doc.nonum.weeks || {})[J.isoWeek()] || 0)}`);
      return;
    }
    const dry = process.argv.includes('--dry');
    const api = dry ? null : J.makeApi({ url: process.env.JUDGE_URL, key: process.env.JUDGE_KEY });
    const lex = require('../hanrei/03_parse.cjs').buildLexicon();
    await runQueue({ r2, api, lex, weekJpy: Number(process.env.NONUM_WEEK_JPY || 1500), dry });
  })().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
}
