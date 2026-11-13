// 判例の条文への紐付けを、条の系譜（付け直しの表）で作り直す（hanrei_v2/）。docs/lineage.md
//
//   node scripts/lineage/relink_hanrei.cjs build     手元で作る（書くのは --out だけ。¥0・LLM なし・R2 に書かない）
//   node scripts/lineage/relink_hanrei.cjs upload    作ったものを R2 に書く（hanrei_v2/ と lineage_v1/）。**初回はオーナーの OK をもらってから**
//        --changed-only  R2 と中身が同じファイルは書かない（月に 1 回の作り直し）
//        --max-change R  付け直した（同じ番号・系譜なしでない）引用の数が R2 の hanrei_v2/index.json から R（既定 0.05）を超えて変わったら書かずに止める
//        --dry           書くものを数えるだけ
//   node scripts/lineage/relink_hanrei.cjs pull      R2 の lineage_v1/（系譜・Jev の控え・受け皿・表・載せる条件の材料）を $LINEAGE_DATA/out に取る（月に 1 回の作り直しの最初）
//
// 入力（build）:
//   --cases DIR    判例の全件（R2 hanrei_v1/cases_*.json の写し。既定 $LINEAGE_DATA/hanrei_cases）。--cases-r2 で R2 から直に読む
//   --tables DIR   付け直しの表（scripts/lineage/tables.py の出力。既定 $LINEAGE_DATA/out/tables）。--tables-r2 で R2 lineage_v1/tables/ を読む
//   --out DIR      出力（既定 $LINEAGE_DATA/out/hanrei_v2）
//   --fulltext-r2  判決文の全文を手元（$LINEAGE_DATA/hanrei_raw/pdftext）に無ければ R2 hanrei_v2/fulltext/ から読む（Actions の月に 1 回）
//   載せる条件の材料（2026-10-16・lib/currefs.cjs の decideShow）: $LINEAGE_DATA/out/policy/old_to_current.json（旧法の条ごとの受け皿の Jev の判定）と
//   lost_judge.json・lost_judge2.json（判例ごとの Opus の判断の 1 回目・2 回目）。無ければ R2 lineage_v1/policy/。表には系譜（out/{法令ID}/lineage.json）から rewrites を足す
// 出力（R2 のキーと同じ並び）:
//   hanrei_v2/links/{法令ID}.json   条文 → 判例の逆引き（07 と同じ形 { 条キー: { total, items } }。付け直した判例の item に via、Opus の判断で載せたものに judge）
//   hanrei_v2/links_more/{法令ID}/{条キー}.json  300 件を超える条の 301 件目からの続き { total, items }（lib/links_more.cjs）
//   hanrei_v2/currefs_{NNNN}.json   判例ごとの付け直し先 { id: [curRefs] }（NNNN は cases と同じ id/100。各 curRef に show（載せた先）か hide（載せない理由））
//   hanrei_v2/index.json            { builtAt, cases, laws, lineage: { tables, version }, counts }
//   lineage_v1/tables/{法令ID}.json・lineage_v1/tables/index.json（判例の週次が新しい判例を付け直すのに読む）
//   lineage_v1/laws/{法令ID}/lineage.json・jev_pairs.json・report.json、lineage_v1/relink/{旧法}.json（月に 1 回の作り直しが続きを作る元）
//   lineage_v1/texts/{法令ID}.json（判決のときの条文の控え。texts.py が手元の out/texts/ に作ったときだけ。段 3 の judge_cases.cjs が読む）
//   report.json（hanrei_v1 の紐付けとの差・付け直しの内訳）
// upload は、書く先に既にあるキーを update_state/hanrei_v2_backup/{run}/ に退避してから上書きする。
// 本番の Worker が今読んでいるプレフィックス（wrangler.toml の HANREI_LINKS_PREFIX）には --live を付けないと書かない。
// ログには件数と法令 ID だけを出す。
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./lib/currefs.cjs');
const parse = require('../hanrei/03_parse.cjs');
const { courtRank, artCompare } = require('../hanrei/07_build_upload_r2.cjs');

const REPO = path.join(__dirname, '..', '..');
const DATA = process.env.LINEAGE_DATA || path.join(REPO, 'lineage_data');
const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'build';
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const OUT = path.resolve(opt('--out', path.join(DATA, 'out', 'hanrei_v2')));
const CASES = path.resolve(opt('--cases', path.join(DATA, 'hanrei_cases')));
const TABLES = path.resolve(opt('--tables', path.join(DATA, 'out', 'tables')));
const PREFIX = 'hanrei_v2';
const TABLES_PREFIX = 'lineage_v1/tables';
const LM = require('./lib/links_more.cjs');
const LINKS_TOP = LM.LINKS_TOP;   // 07 と同じ

const log = (...a) => console.log(...a);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
const shard = (id) => String(Math.floor(parseInt(id, 10) / 100)).padStart(4, '0');

// ---------------------------------------------------------------- 表
async function loadTables(r2) {
  const tables = new Map();
  let index = {};
  if (r2) {
    index = (await r2.getJson(`${TABLES_PREFIX}/index.json`)) || {};
    const R2 = r2.constructor;
    await R2.pmap(Object.keys(index), 8, async (id) => { const t = await r2.getJson(`${TABLES_PREFIX}/${id}.json`); if (t) tables.set(id, t); });
  } else {
    if (!fs.existsSync(TABLES)) throw new Error(`表が無い: ${TABLES}（scripts/lineage/tables.py を先に流す）`);
    for (const f of fs.readdirSync(TABLES)) {
      if (f === 'index.json') { index = readJson(path.join(TABLES, f)); continue; }
      if (/^[0-9A-Za-z]+\.json$/.test(f)) tables.set(f.slice(0, -5), readJson(path.join(TABLES, f)));
    }
  }
  const oldNames = new Map();
  for (const t of tables.values()) if (t.old_law) for (const n of t.names || []) oldNames.set(n, t.law_id);
  return { tables, index, oldNames };
}

// ---------------------------------------------------------------- 判例の全件
async function* iterCases(r2) {
  if (r2) {
    const keys = (await r2.list('hanrei_v1/cases_')).map((o) => o.key).filter((k) => /cases_\d{4}\.json$/.test(k)).sort();
    for (const k of keys) { const j = await r2.getJson(k); if (j) yield j; }
    return;
  }
  if (!fs.existsSync(CASES)) throw new Error(`判例の写しが無い: ${CASES}`);
  for (const f of fs.readdirSync(CASES).filter((x) => /^cases_\d{4}\.json$/.test(x)).sort()) yield readJson(path.join(CASES, f));
}

// ---------------------------------------------------------------- build
async function build() {
  const useR2 = flag('--cases-r2') || flag('--tables-r2') || flag('--fulltext-r2');
  let r2 = null;
  if (useR2) { const { R2 } = require('../update/lib/r2.cjs'); r2 = new R2(); }
  const { tables, index: tIndex, oldNames } = await loadTables(flag('--tables-r2') ? r2 : null);
  const table = (id) => tables.get(id) || null;
  fs.rmSync(OUT, { recursive: true, force: true });
  const readBefore = C.makeBeforeReader(parse);
  // 判例の引用の読み取りの直し（#332）の足し引き（parse_fix.cjs の表）。手元の out/parse_fix.json、無ければ R2 lineage_v1/parse_fix.json
  const { applyFix, fullTextOf } = require('./parse_fix.cjs');
  let fixDoc = null;
  const fixLocal = path.resolve(opt('--parse-fix', path.join(DATA, 'out', 'parse_fix.json')));
  if (fs.existsSync(fixLocal)) fixDoc = readJson(fixLocal);
  else if (r2) fixDoc = await r2.getJson('lineage_v1/parse_fix.json');
  const fix = fixDoc && fixDoc.cases;
  if (fix) log(`読み取りの直しの足し引き: 判例 ${Object.keys(fix).length} 件`);
  const readOldName = C.makeOldNameReader(parse);
  // 載せる条件の材料（2026-10-16）: 旧法の受け皿の判定（old_to_current.json）と判例ごとの Opus の判断（lost_judge.json）。
  // 手元の out/policy/、無ければ R2 lineage_v1/policy/。表には系譜から「条が丸ごと書き換えられた出来事」（rewrites）を足す
  const policy = { old: null, judge: null, judge2: null, nonum: null };
  for (const [k, f] of [['old', 'old_to_current.json'], ['judge', 'lost_judge.json'], ['judge2', 'lost_judge2.json'], ['nonum', 'nonum_final.json']]) {
    const loc = path.join(DATA, 'out', 'policy', f);
    if (fs.existsSync(loc)) policy[k] = readJson(loc);
    else if (r2) policy[k] = await r2.getJson(`lineage_v1/policy/${f}`);
    if (policy[k]) writeJson(path.join(OUT, 'lineage_v1', 'policy', f), policy[k]);
  }
  if (!policy.old) throw new Error('旧法の受け皿の判定（out/policy/old_to_current.json か R2 lineage_v1/policy/old_to_current.json）が無い');
  log(`載せる条件: 旧法の受け皿 ${Object.keys(policy.old).length} 法令・Opus の判断 ${policy.judge ? Object.keys(policy.judge).length : 0} 件（2 回目 ${policy.judge2 ? Object.keys(policy.judge2).length : 0} 件）`);
  let withRw = 0;
  for (const [id, t] of tables) {
    const lp = path.join(DATA, 'out', id, 'lineage.json');
    if (!t.old_law && fs.existsSync(lp)) { t.rewrites = C.rewritesOf(readJson(lp)); withRw++; }
    // 法令ができた日（制定の施行日。e-Gov の改正履歴の新規制定）: 条番号の無い判例の「判決の後にできた条」の注記に使う。手元に無ければ前の表の値のまま
    const rv = path.join(DATA, 'egov', 'revisions', `${id}.json`);
    if (!t.old_law && fs.existsSync(rv)) {
      try {
        const j = readJson(rv);
        const list = Array.isArray(j) ? j : (j.revisions || j.law_revisions || []);
        const nw = list.find((x) => x && String(x.amendment_type) === '1' && x.amendment_enforcement_date);
        if (nw) t.enacted = { d: nw.amendment_enforcement_date, prom: nw.amendment_promulgate_date || null };
      } catch { /* 読めなければ付けない */ }
    }
  }
  log(`系譜から書き換えの出来事を足した表: ${withRw}（無い表は前の rewrites のまま）`);   // 「旧民法」「旧刑訴法」のように今と同じ名前に「旧」を付けて引いた条
  log(`表: ${tables.size} 法令（旧法 ${[...tables.values()].filter((t) => t.old_law).length}・旧法の名前 ${oldNames.size}）`);

  if (fix) writeJson(path.join(OUT, 'lineage_v1', 'parse_fix.json'), fixDoc);   // R2 にも置く（月に 1 回の作り直しが使う）
  const links = new Map();    // lawId → art → [{v, r, d}]
  const v1 = new Map();       // lawId|art → 件数（hanrei_v1 の紐付け: lawRefs をそのまま）
  const counts = { cases: 0, refs: 0, curRefs: 0, how: {}, prev: 0, withBefore: 0, oldName: 0, notes: {}, other: 0, withOldName: 0, fixed: 0, hide: {}, by: {}, pairs: 0, casesWithRefs: 0, casesShown: 0, withClose: 0, fulltext: 0 };
  const samples = {};
  const currefsShards = new Map();
  for await (const chunk of iterCases(flag('--cases-r2') ? r2 : null)) {
    // --fulltext-r2: 手元に判決文の全文（$LINEAGE_DATA/hanrei_raw/pdftext）が無い所（Actions の月に 1 回）は R2 hanrei_v2/fulltext/ から読む
    const ftR2 = new Map();
    if (flag('--fulltext-r2')) {
      const ids = Object.keys(chunk).filter((id) => !fullTextOf(id));
      await r2.constructor.pmap(ids, 16, async (id) => { const j = await r2.getJson(`${PREFIX}/fulltext/${id}.json`); if (j && typeof j.text === 'string' && j.text) ftR2.set(id, j.text); });
    }
    for (const rec0 of Object.values(chunk)) {
      if (!rec0 || !rec0.id) continue;
      const rec = fix ? applyFix(rec0, fix) : rec0;
      if (rec !== rec0) counts.fixed++;
      counts.cases++;
      for (const r of (Array.isArray(rec0.lawRefs) ? rec0.lawRefs : [])) {   // hanrei_v1 の紐付けと比べるので直す前の lawRefs
        if (r && r.lawId && /^[0-9A-Za-z_]+$/.test(r.lawId) && typeof r.art === 'string' && /^\d+(の\d+)*$/.test(r.art)) {
          counts.refs++;
          v1.set(`${r.lawId}|${r.art}`, (v1.get(`${r.lawId}|${r.art}`) || 0) + 1);
        }
      }
      // 判決文の全文（2026-10-17 に切れた判例を裁判所から取り直した。$LINEAGE_DATA/hanrei_raw/pdftext）があれば、本文から読むもの（改正前・「旧」・判決の結び）は全文で読む
      const ft = fullTextOf(rec.id) || ftR2.get(String(rec.id)) || null;
      if (ft) counts.fulltext++;
      const recT = ft ? { ...rec, sections: [{ text: ft }] } : rec;
      const bf = readBefore(recT);
      if (bf) counts.withBefore++;
      const on = readOldName(recT);
      if (on) counts.withOldName++;
      const cur = C.curRefsOf(rec, table, oldNames, bf, on);
      for (const u of (Array.isArray(rec.unresolvedRefs) ? rec.unresolvedRefs : [])) if (u && oldNames.has(u.name) && /^\d+(の\d+)*$/.test(String(u.art || ''))) counts.oldName++;
      counts.curRefs += cur.length;
      for (const c of cur) {
        counts.how[c.how] = (counts.how[c.how] || 0) + 1;
        if (c.prev) counts.prev++;
        const sk = c.how + (c.prev ? '+prev' : '');
        if (!samples[sk]) samples[sk] = [];
        if (samples[sk].length < 8) samples[sk].push({ id: rec.id, date: rec.dateIso, from: c.from, to: c.lawId ? `${c.lawId}:${c.art}` : null, conf: c.conf });
        for (const n of c.notes || []) counts.notes[n.k] = (counts.notes[n.k] || 0) + 1;
      }
      // 条文ページに載せるか（2026-10-16 の方針・C.decideShow）。同じ判例が同じ今の条に何本で行き着いても 1 件（系譜 → Jev → Opus の順に残す）
      // 判決の結びの決まり文句の中でだけ引いた条は載せない（2026-10-17。判決文から見分ける・結びが見つからない判例は今までどおり）
      const closingOnly = C.makeClosingOnly(recT);
      if (closingOnly) counts.withClose++;
      const stockOnly = C.makeStockOnly(recT);   // 刑訴法411条の決まった言い回しだけの引用（2026-10-17）
      const shown = cur.map((c) => C.decideShow(rec.id, c, table, policy, closingOnly, stockOnly));
      const placed = new Map();
      const rank = { lineage: 0, jev: 1, opus: 2 };
      for (const c of shown) {
        if (c.hide) counts.hide[c.hide] = (counts.hide[c.hide] || 0) + 1;
        for (const d of c.show) counts.by[d.by] = (counts.by[d.by] || 0) + 1;
        for (const it of C.linkItemsOf(rec, c, table)) {
          const k = `${it.lawId}|${it.art}`;
          const by = (c.show.find((d) => d.lawId === it.lawId && d.art === it.art) || {}).by;
          const prev = placed.get(k);
          if (!prev || (rank[by] < rank[prev.by]) || (rank[by] === rank[prev.by] && !it.v.via && prev.it.v.via)) placed.set(k, { it, by });
        }
      }
      // 判決文に条番号の書かれていない判例の「判断した条」（2026-10-17・nonum_final.json の decided。条文くんの選定の候補を判決の全文で Jev が 0.7 以上と
      // 採点した条（how: Jev）と、決めきれなかった分を Opus 5.5 が判決文から選んだ条（how: Opus・reason つき））。decided の無い判例（上告理由に当たらない・
      // 条例・Opus が選ばない・判決文なし。オーナーの決定）と、条の無い行き先（「法令ID|」）は載せない
      let nn = policy.nonum && policy.nonum[rec.id];
      // 条番号が読めるようになった判例（「借地法一○条」の「○」など。2026-10-17）は、普通の引用の判定に回し、判断した条は使わない
      // ただし普通の判定でどこにも載らないときは、判断した条（decided）に戻す（2026-10-18 のオーナーの決定。手形法16条・銃刀法3条など実体の判断をしていた）
      if (nn && Array.isArray(nn.decided) && nn.decided.length && cur.length) {
        if (placed.size) { counts.nonumHasRefs = (counts.nonumHasRefs || 0) + 1; nn = null; }
        else { counts.nonumFallback = (counts.nonumFallback || 0) + 1; (counts.nonumFallbackIds = counts.nonumFallbackIds || []).push(rec.id); }
      }
      if (nn && Array.isArray(nn.decided) && nn.decided.length && C.noGroundDecision(recT)) { counts.nonumNoGround = (counts.nonumNoGround || 0) + 1; (counts.nonumNoGroundIds = counts.nonumNoGroundIds || []).push(rec.id); nn = null; }
      const nonumRefs = [];
      for (const key of (nn && Array.isArray(nn.decided) ? nn.decided : [])) {
        const [lawId, art0] = String(key).split('|');
        const art = String(art0 || '').replace(/_/g, 'の');
        if (!/^[0-9A-Za-z_]+$/.test(lawId) || !/^\d+(の\d+)*$/.test(art)) continue;
        const s = nn.scores && typeof nn.scores[key] === 'number' ? nn.scores[key] : null;
        // 注記（2026-10-17）: 判決の日 → 今 の間にこの条に起きたこと（番号を引いた判例と同じ材料）・判決の後にできた条
        const nNotes = C.nonumNotes(table(lawId), art, rec.dateIso);
        nonumRefs.push({ lawId, art, how: 'nonum', from: null, conf: s, ...(nNotes.length ? { notes: nNotes } : {}), show: [{ lawId, art, by: 'nonum', ...(s != null ? { s } : {}) }] });
        for (const n of nNotes) counts.notes[`nonum_${n.k}`] = (counts.notes[`nonum_${n.k}`] || 0) + 1;
        counts.by.nonum = (counts.by.nonum || 0) + 1;
        const k = `${lawId}|${art}`;
        if (placed.has(k)) continue;
        const v = C.linkItem(rec, null, nNotes);
        const how = String(nn.how || '').toLowerCase() === 'opus' ? 'opus' : 'jev';
        v.judge = { by: 'nonum', how, ...(how === 'opus' && typeof nn.reason === 'string' && nn.reason ? { reason: nn.reason.slice(0, 300) } : {}) };
        placed.set(k, { it: { lawId, art, v }, by: 'nonum' });
      }
      if (nonumRefs.length) counts.nonumCases = (counts.nonumCases || 0) + 1;
      if (cur.length || nonumRefs.length) { counts.casesWithRefs++; if (placed.size) counts.casesShown++; }
      for (const { it } of placed.values()) {
        counts.pairs++;
        if (!links.has(it.lawId)) links.set(it.lawId, new Map());
        const per = links.get(it.lawId);
        if (!per.has(it.art)) per.set(it.art, { items: [], other: [] });
        per.get(it.art).items.push({ v: it.v, r: courtRank(rec.court), d: rec.dateIso || '' });
      }
      const sh = shard(rec.id);
      if (!currefsShards.has(sh)) currefsShards.set(sh, {});
      currefsShards.get(sh)[rec.id] = [...shown, ...nonumRefs];
    }
    if (counts.cases % 10000 < 100) log(`  判例 ${counts.cases} 件`);
  }
  // links（07 と同じ並び: 裁判所のランク → 判決日 → id の降順・上位 300 件）
  const lawIds = [...links.keys()].sort();
  const v2 = new Map();
  let viaItems = 0, moreFiles = 0;
  if (fs.existsSync(path.join(OUT, LM.MORE_PREFIX))) fs.rmSync(path.join(OUT, LM.MORE_PREFIX), { recursive: true, force: true });   // 前の作り直しの続きを残さない
  for (const lawId of lawIds) {
    const per = links.get(lawId);
    const out = {};
    for (const art of [...per.keys()].sort(artCompare)) {
      const { items: a, other } = per.get(art);
      const order = (x, y) => (y.r - x.r) || y.d.localeCompare(x.d) || (parseInt(y.v.id, 10) - parseInt(x.v.id, 10));
      a.sort(order);
      other.sort(order);
      // other: 判決当時のこの番号の条は今の条とは別の規定（差し替え・削除）だった判例。条文ページでは注記つきで畳む枠に出す
      out[art] = { total: a.length, items: a.slice(0, LINKS_TOP).map((x) => x.v), ...(other.length ? { other: { total: other.length, items: other.slice(0, LINKS_TOP).map((x) => x.v) } } : {}) };
      // 301 件目からの続き（条文ページの /law/{法令ID}/{条}/hanrei/{N}。lib/links_more.cjs）
      if (a.length > LINKS_TOP) { writeJson(path.join(OUT, ...LM.moreKey(lawId, art).split('/')), { total: a.length, items: a.slice(LINKS_TOP).map((x) => x.v) }); moreFiles++; }
      if (a.length) v2.set(`${lawId}|${art}`, a.length);
      viaItems += a.filter((x) => x.v.via).length;
    }
    writeJson(path.join(OUT, PREFIX, 'links', `${lawId}.json`), out);
  }
  for (const [sh, obj] of currefsShards) writeJson(path.join(OUT, PREFIX, `currefs_${sh}.json`), obj);
  // 表も R2 に置く形で写す（判例の週次が読む）
  for (const [id, t] of tables) writeJson(path.join(OUT, TABLES_PREFIX, `${id}.json`), t);
  writeJson(path.join(OUT, TABLES_PREFIX, 'index.json'), tIndex);
  // 系譜そのもの（月に 1 回の作り直しの元）。手元に無い（--tables-r2 だけで作った）ときは写さない
  for (const id of tables.keys()) {
    for (const f of ['lineage.json', 'jev_pairs.json', 'report.json']) {
      const src = path.join(DATA, 'out', id, f);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.join(OUT, 'lineage_v1', 'laws', id), { recursive: true });
      fs.copyFileSync(src, path.join(OUT, 'lineage_v1', 'laws', id, f));
    }
  }
  const relDir = path.join(DATA, 'out', 'relink');
  if (fs.existsSync(relDir)) {
    for (const f of fs.readdirSync(relDir).filter((x) => /^[0-9A-Za-z]+\.json$/.test(x))) {
      fs.mkdirSync(path.join(OUT, 'lineage_v1', 'relink'), { recursive: true });
      fs.copyFileSync(path.join(relDir, f), path.join(OUT, 'lineage_v1', 'relink', f));
    }
  }
  // 判決のときの条文の控え（texts.py。PC だけで作る・月に 1 回の作り直しの段 3 が R2 lineage_v1/texts/ を読む）。手元に無ければ写さない（R2 のものは残る）
  const txDir = path.join(DATA, 'out', 'texts');
  if (fs.existsSync(txDir)) {
    fs.mkdirSync(path.join(OUT, 'lineage_v1', 'texts'), { recursive: true });
    for (const f of fs.readdirSync(txDir).filter((x) => /^[0-9A-Za-z]+\.json$/.test(x))) fs.copyFileSync(path.join(txDir, f), path.join(OUT, 'lineage_v1', 'texts', f));
  }
  // v1 との差
  let same = 0, onlyV1 = 0, onlyV2 = 0;
  const lost = [], gained = [];
  for (const [k, n] of v1) { const m = v2.get(k) || 0; if (m) same += Math.min(n, m); if (n > m) { onlyV1 += n - m; lost.push([k, n - m]); } }
  for (const [k, m] of v2) { const n = v1.get(k) || 0; if (m > n) { onlyV2 += m - n; gained.push([k, m - n]); } }
  lost.sort((a, b) => b[1] - a[1]); gained.sort((a, b) => b[1] - a[1]);
  const idx = { builtAt: new Date().toISOString(), cases: counts.cases, laws: lawIds, lineage: { tables: tables.size, prefix: TABLES_PREFIX }, counts };
  writeJson(path.join(OUT, PREFIX, 'index.json'), idx);
  const report = { counts, links: { laws: lawIds.length, pairs: v2.size, via_items: viaItems }, v1_vs_v2: { same, only_v1: onlyV1, only_v2: onlyV2, lost_top: lost.slice(0, 40), gained_top: gained.slice(0, 40) }, samples };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  log(`\n判例 ${counts.cases} 件・引用 ${counts.refs} 件 → 付け直し ${counts.curRefs} 件`);
  log(`内訳: ${Object.entries(counts.how).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' / ')}（直前の版で引いた ${counts.prev}・本文から改正前を読んだ判例 ${counts.withBefore}・旧法の名前で拾った ${counts.oldName}）`);
  log(`links: ${lawIds.length} 法令・${v2.size} 条・付け直した item ${viaItems}・別の規定として畳む枠 ${counts.other}・300 件を超えた条の続き（links_more）${moreFiles} ファイル`);
  log(`読み取りの直しを当てた判例: ${counts.fixed}`);
  log(`条文ページに載せる組（判例 × 今の条）: ${counts.pairs}・載る判例 ${counts.casesShown} / 引用のある判例 ${counts.casesWithRefs}・判決の結びが見つかった判例 ${counts.withClose}・全文で読んだ判例 ${counts.fulltext}・条番号の無い判例に判断した条を付けた判例 ${counts.nonumCases || 0}（上告理由に当たらない型で外した ${counts.nonumNoGround || 0}: ${(counts.nonumNoGroundIds || []).join(',')}・条番号が読めるようになって普通の判定で載る ${counts.nonumHasRefs || 0}・普通の判定でどこにも載らず判断した条に戻した ${counts.nonumFallback || 0}: ${(counts.nonumFallbackIds || []).join(',')}）`);
  log(`載せる先: ${Object.entries(counts.by).map(([k, n]) => `${k} ${n}`).join(' / ')}・載せない理由: ${Object.entries(counts.hide).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' / ')}`);
  log(`注記: ${Object.entries(counts.notes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' / ')}`);
  log(`hanrei_v1 との差: 同じ ${same} / v1 だけ（外した・付け直した元） ${onlyV1} / v2 だけ（付け直した先・旧法の名前） ${onlyV2}`);
  log(`出力: ${OUT}`);
  return report;
}

// ---------------------------------------------------------------- upload（初回はオーナーの OK の後だけ。月に 1 回の作り直しは --changed-only）
async function upload() {
  const { R2 } = require('../update/lib/r2.cjs');
  const crypto = require('crypto');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const r2 = new R2();
  const live = liveLinksPrefix();
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.json')) files.push(p); } };
  for (const top of [PREFIX, 'lineage_v1']) if (fs.existsSync(path.join(OUT, top))) walk(path.join(OUT, top));
  let items = files.map((f) => ({ local: f, key: path.relative(OUT, f).split(path.sep).join('/') }));
  if (!items.length) throw new Error(`書くものが無い: ${OUT}（build を先に）`);
  if (items.some((x) => x.key.startsWith(`${live}/`)) && !flag('--live')) {
    throw new Error(`本番の Worker が今読んでいるプレフィックス（${live}）に書こうとしている。切り替えた後の作り直しは --live を付ける（退避してから上書きする）`);
  }
  const prevIdx = await r2.getJson(`${PREFIX}/index.json`);
  const nextIdx = JSON.parse(fs.readFileSync(path.join(OUT, PREFIX, 'index.json'), 'utf8'));
  // 作り直した判例の件数が今の R2（hanrei_v1/index.json）と違えば書かない（写しが古い・作っている間に判例の週次が足した。
  // 書くと足した判例が逆引きから消える）。--cases-r2 で読み直して流し直す
  const v1Idx = await r2.getJson('hanrei_v1/index.json');
  if (v1Idx && Number(v1Idx.cases) !== Number(nextIdx.cases) && !flag('--approved')) {
    throw new Error(`判例の件数が R2（hanrei_v1/index.json の ${v1Idx.cases} 件）と作り直し（${nextIdx.cases} 件）で違う。build --cases-r2 で読み直してから書く`);
  }
  // 急な変化で止める: 付け直した（同じ番号・系譜なしでない）引用の数を、R2 の今の index と比べる
  if (prevIdx && prevIdx.counts && nextIdx.counts) {
    const moved = (c) => Object.entries(c.how || {}).filter(([k]) => !['same', 'nolineage'].includes(k)).reduce((a, [, n]) => a + n, 0);
    const a = moved(prevIdx.counts), b = moved(nextIdx.counts), lim = Number(opt('--max-change', '0.05'));
    const rel = a ? Math.abs(b - a) / a : (b ? 1 : 0);
    log(`付け直した引用: 今 ${a} → 作り直し ${b}（${(rel * 100).toFixed(2)}%・上限 ${(lim * 100).toFixed(0)}%）`);
    if (rel > lim && !flag('--approved')) throw new Error(`付け直した引用の数が ${(rel * 100).toFixed(2)}% 変わった（上限 ${(lim * 100).toFixed(0)}%）。系譜か表の不具合の疑いがあるので書かない。中身を確かめてから --approved で書く`);
  }
  const rid = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const existing = new Set();
  for (const p of [`${PREFIX}/`, 'lineage_v1/']) for (const o of await r2.list(p)) existing.add(o.key);
  // 作り直しで載せる判例が 1 件も無くなった法令の逆引きは、R2 に古いものが残るので空（{}）で上書きする（退避してから）
  const localKeys = new Set(items.map((x) => x.key));
  const stale = [...existing].filter((k) => (k.startsWith(`${PREFIX}/links/`) || k.startsWith(`${LM.MORE_PREFIX}/`)) && !localKeys.has(k));
  if (stale.length) log(`載せる判例が無くなった法令の逆引き: ${stale.length}（空で上書きする）`);
  // 300 件以下になった条の続き（links_more）は、件数 0 の続きで上書きする（条文ページは続きのページを出さない）
  items.push(...stale.map((k) => ({ key: k, body: Buffer.from(k.startsWith(`${LM.MORE_PREFIX}/`) ? '{"total":0,"items":[]}' : '{}') })));
  const bodyOf = (x) => x.body || fs.readFileSync(x.local);
  if (flag('--changed-only')) {
    const keep = [];
    await R2.pmap(items, 8, async (x) => { const b = await r2.get(x.key); if (!b || sha(b) !== sha(bodyOf(x))) keep.push(x); });
    log(`中身が変わったファイル: ${keep.length} / ${items.length}`);
    items = keep;
  }
  const backup = `update_state/hanrei_v2_backup/${rid}`;
  const toBackup = items.filter((x) => existing.has(x.key)).map((x) => x.key);
  log(`書く: ${items.length} ファイル（上書き ${toBackup.length}・退避先 ${backup}）`);
  if (flag('--dry') || !items.length) return;
  // 判例の週次と同じ作業中の印を取る（週次の prepare は印があれば止まる。同時に hanrei_v2 を書かない）
  const LOCK = 'update_state/hanrei_apply_inprogress.json';
  const token = crypto.randomBytes(12).toString('hex');
  if (await r2.getJson(LOCK)) throw new Error(`${LOCK} がある（判例の週次の反映か戻しが動いているか途中で落ちている）。書かない`);
  if (!(await r2.putIfAbsent(LOCK, JSON.stringify({ run_id: `lineage-${rid}`, kind: 'lineage', token, phase: 'writing', started_at: new Date().toISOString() })))) {
    throw new Error(`${LOCK} を取れなかった。書かない`);
  }
  try {
    await R2.pmap(toBackup, 8, async (k) => { const b = await r2.get(k); if (b) await r2.put(`${backup}/${k}`, b); });
    await r2.put(`${backup}/_manifest.json`, JSON.stringify({ run_id: rid, overwritten: toBackup, added: items.filter((x) => !existing.has(x.key)).map((x) => x.key) }));
    // 系譜 → 表 → currefs → links → index の順（index は最後。途中で落ちても index は前のまま）
    const order = (k) => (k.startsWith('lineage_v1/laws/') || k.startsWith('lineage_v1/relink/') ? 0 : k.startsWith('lineage_v1/') ? 1 : /currefs_/.test(k) ? 2 : /\/links(?:_more)?\//.test(k) ? 3 : 4);
    let n = 0;
    for (const grp of [0, 1, 2, 3, 4]) {
      await R2.pmap(items.filter((x) => order(x.key) === grp), 8, async (x) => { await r2.put(x.key, bodyOf(x)); n++; });
    }
    log(`書いた: ${n} ファイル。戻すときは ${backup}/ を元のキーに書き戻し、_manifest.json の added を消す`);
  } finally {
    const cur = await r2.getJson(LOCK);
    if (cur && cur.token === token) await r2.delete(LOCK);
  }
}

// R2 の lineage_v1/ を手元に取る（月に 1 回の作り直しの最初）
async function pull() {
  const { R2 } = require('../update/lib/r2.cjs');
  const r2 = new R2();
  const keys = (await r2.list('lineage_v1/')).map((o) => o.key);
  if (!keys.includes(`${TABLES_PREFIX}/index.json`)) throw new Error('R2 に lineage_v1/tables/index.json が無い（全件の作り直しをまだ書いていない）');
  let n = 0;
  await R2.pmap(keys, 8, async (k) => {
    let rel = null;
    if (k.startsWith('lineage_v1/laws/')) rel = path.join('out', ...k.slice('lineage_v1/laws/'.length).split('/'));
    else if (k.startsWith('lineage_v1/relink/')) rel = path.join('out', 'relink', k.slice('lineage_v1/relink/'.length));
    else if (k.startsWith(`${TABLES_PREFIX}/`)) rel = path.join('out', 'tables', k.slice(TABLES_PREFIX.length + 1));
    else if (k === 'lineage_v1/parse_fix.json') rel = path.join('out', 'parse_fix.json');
    else if (k.startsWith('lineage_v1/policy/')) rel = path.join('out', 'policy', k.slice('lineage_v1/policy/'.length));   // 載せる条件の材料
    if (!rel) return;
    const b = await r2.get(k);
    if (!b) return;
    fs.mkdirSync(path.dirname(path.join(DATA, rel)), { recursive: true });
    fs.writeFileSync(path.join(DATA, rel), b);
    n++;
  });
  log(`取った: ${n} ファイル → ${DATA}`);
}

function liveLinksPrefix() {
  const toml = fs.readFileSync(path.join(REPO, 'wrangler.toml'), 'utf8');
  const m = toml.match(/^HANREI_LINKS_PREFIX\s*=\s*"([^"]+)"/m);
  return (m ? m[1] : 'hanrei_v2/links').replace(/\/links$/, '');
}

if (require.main === module) {
  (mode === 'upload' ? upload() : mode === 'pull' ? pull() : build()).catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
}

module.exports = { loadTables };
