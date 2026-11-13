// 質疑応答事例・裁決の週次更新: 今回の写しから作り直し、今の本番と比べて「反映したら何が変わるか」を作る（反映の下見）。
//
//   node scripts/cases/weekly/run.cjs build     （crawl の後に同じ作業フォルダで流す）
//
// **書かない**: R2 にも Vectorize にも書かない（読むだけ）。反映は apply（apply.cjs）。
//
// 今の本番を「前回の作り直しの結果」として読み、そこから引き継ぐ（PC の途中データは使わない）:
//   - 解析は今までの実物（scripts/{shitsugi,saiketsu}/03_parse.cjs）をそのまま流す。レコードの形は 07_build_upload_r2 と同じ
//   - 事例の画像: 本番のレコードにある画像（同じパス）の文字起こし（text・kind）を引き継ぐ。画像は毎週すべて国税庁から取り、
//     R2 に無いものは置き、中身が変わったもの（同じ URL のままの差し替え）は退避付きで差し替えて文字起こしを引き継がない。
//     文字起こし（05・LLM）はしない（新しい・差し替えた画像の text は空。件数を見直す対象に出す）
//   - 条文リンク（article_links_v1）: 原文にある引用（関係法令欄・要旨・本文・通達の帰属条）は今までの実物（04_relink_from_r2 の関数）で全件作り直す。
//     前回 LLM で割り当てたもの（s: 'llm'）は、その事例・裁決が残っている限り本番から引き継ぐ（LLM は使わない）
//   - 通達の帰属条の地図は、今の本番の通達（wrangler.toml の TSUTATSU_CHUNKS_PREFIX）から作る
// ベクトル（_shitsugi・_saiketsu）は 06_embed と同じ作り方（id・text・metadata）で「あるべき全体」を出す。homes は条文リンクから
//   （09_gen_homes_update と同じ並び）。前回反映した状態の控え（R2 update_state/cases/vec_state.json）と比べて、
//   新しい・本文が変わった・metadata だけ変わった・消えた、に分ける。控えが無い初回は、本番のレコードから同じ作り方で組み立て直した本文の hash と、
//   Vectorize の実物（get_by_ids）の metadata で作る。埋め込みは Workers AI（bge-m3）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { R2 } = require('../../update/lib/r2.cjs');
const { Vectorize } = require('../../update/lib/vectorize.cjs');
const { Embedder, cosine } = require('../../update/lib/ai.cjs');
const { stableJson, prodPrefix: tsuProdPrefix, loadFrom16, APPLY_LOCK_KEY: TSU_LOCK_KEY } = require('../../tsutatsu/weekly/build.cjs');
const { loadLawIds } = require('../../shitsugi/03_parse.cjs');
const { buildTsuRev, makeShitsugiLinker } = require('../../shitsugi/04_relink_from_r2.cjs');
const { linkSaiketsu } = require('../../saiketsu/04_relink_from_r2.cjs');
const { unitsFromSections } = require('../../saiketsu/03_parse.cjs');
const { makeGenGuard } = require('../../update/lib/delta_apply.cjs');
const SITE = require('../../site_config.cjs');

const SH = 'shitsugi_v1', SA = 'saiketsu_v1', AL = 'article_links_v1';
const VEC_INDEX = 'tsutatsu-embeddings-v1';
const NS = { j: '_shitsugi', s: '_saiketsu' };
const META_LIMIT = 10 * 1024;
const VEC_STATE_KEY = 'update_state/cases/vec_state.json';
const APPLY_LOCK_KEY = 'update_state/cases_apply_inprogress.json';
const MAX_EMBED = Number(process.env.CASES_MAX_EMBED || 2000);
const MAX_CHANGED = Number(process.env.CASES_MAX_CHANGED || 30);
const DROP_MIN = Number(process.env.CASES_DROP_MIN || 20);   // 減った数がこれ以下なら割合では止めない（件数の少ない確かめ用のデータで止まらないように。本番は数千件）
const IMG_BASE = (process.env.SHITSUGI_CRAWL_BASE || 'https://www.nta.go.jp').replace(/\/$/, '');
const IMG_SLEEP_MS = Number(process.env.SHITSUGI_CRAWL_SLEEP_MS || 1000);

const log = (...a) => console.log(...a);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const writeNdjson = (f, arr) => fs.writeFileSync(f, arr.map((o) => JSON.stringify(o)).join('\n') + (arr.length ? '\n' : ''));
function readNdjson(f) {
  if (!fs.existsSync(f)) throw new Error(`${path.basename(f)} が無い（前の段の出力が欠けている）。書かずに止める`);
  return fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [l, i]).filter(([l]) => l.trim()).map(([l, i]) => {
    try { return JSON.parse(l); } catch { throw new Error(`${path.basename(f)} の ${i + 1} 行目が読めない（壊れている）。書かずに止める`); }
  });
}
function runProc(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('close', (code, signal) => resolve(code === 0 ? 0 : (code == null ? `signal ${signal || '?'}` : code)));
    p.on('error', () => resolve(127));
  });
}

// ---------------------------------------------------------------- レコード（07_build_upload_r2 と同じ形）
function shitsugiRecords(items, prodImg) {
  const recs = {}, index = {};
  const newImages = new Map();   // path -> 取りに行く URL
  for (const it of items) {
    if (recs[it.id]) continue;
    if (!it.shokai || !it.kaito) continue;
    const ck = it.id.split('/')[0];
    const images = (it.images || []).map((im) => {
      const p = new URL(im.src, it.url).pathname;
      const t = prodImg.get(p);
      if (!t) newImages.set(p, new URL(im.src, it.url).pathname);
      return { path: p, alt: im.alt, section: im.section, text: t ? t.text : null, kind: t ? t.kind : null };
    });
    recs[it.id] = {
      id: it.id, url: it.url, category: it.category, title: it.title,
      shokai: it.shokai, kaito: it.kaito,
      kankei_raw: it.kankei_raw, anchors: it.anchors, tsutatsu_refs: it.tsutatsu_refs,
      images, related: it.related, as_of: it.as_of,
    };
    index[it.id] = { cat: it.category, title: it.title, chunk: `cases_${ck}.json` };
  }
  return { recs, index, newImages };
}
function saiketsuRecords(items) {
  const recs = {}, index = {};
  for (const it of items) {
    if (!it.abstract || it.abstract.length < 30) continue;
    recs[it.id] = {
      id: it.id, title: it.title, abstract: it.abstract, date: it.date,
      topics: it.topics, tax_laws: it.tax_laws, law_refs: it.law_refs,
      sections: it.sections, url: it.url, has_full: it.has_full,
    };
    index[it.id] = { title: (it.title || '').slice(0, 80), date: it.date, chunk: `cases_${it.no}.json` };
  }
  return { recs, index };
}
// 変わったレコードの内訳（下見の報告用。2026-09-27 の初回で 1,239 件・1,352 件が「変わった」と出たのを見分けるため）:
// 項目ごとの件数・空白だけの違いの件数・例（最初に違う項目の、違い始めの前後）
const noSpace = (v) => (typeof v === 'string' ? v.replace(/[\s\u3000]+/g, '') : Array.isArray(v) ? v.map(noSpace) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noSpace(x)])) : v);
function diffBreakdown(ids, prodRecs, curRecs, maxExamples = 3) {
  const fields = {};
  let spaceOnly = 0;
  const examples = [];
  for (const id of ids) {
    const a = prodRecs[id] || {}, b = curRecs[id] || {};
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => stableJson(a[k]) !== stableJson(b[k])).sort();
    for (const k of keys) fields[k] = (fields[k] || 0) + 1;
    if (stableJson(noSpace(a)) === stableJson(noSpace(b))) spaceOnly++;
    if (examples.length < maxExamples && keys.length) {
      const k = keys[0];
      const x = typeof a[k] === 'string' ? a[k] : stableJson(a[k] ?? null), y = typeof b[k] === 'string' ? b[k] : stableJson(b[k] ?? null);
      let i = 0;
      while (i < x.length && i < y.length && x[i] === y[i]) i++;
      const cut = (t) => JSON.stringify(t.slice(Math.max(0, i - 15), i + 45));
      examples.push({ id, field: k, fields: keys, before: cut(x), after: cut(y) });
    }
  }
  return { fields, space_only: spaceOnly, examples };
}
function chunksOf(recs, index) {
  const chunks = {};
  for (const [id, r] of Object.entries(recs)) (chunks[index[id].chunk] = chunks[index[id].chunk] || {})[id] = r;
  return chunks;
}

// ---------------------------------------------------------------- 条文リンク（build_article_index と同じ作り）
const RANK = { kankei: 0, abstract: 1, tsutatsu: 2, body: 3, llm: 4 };
function buildArticleIndex({ shLinks, saLinks, llm }) {
  const byLaw = {};
  const add = (lawId, article, entry) => {
    if (!lawId || !article) return;
    (byLaw[lawId] = byLaw[lawId] || {});
    (byLaw[lawId][article] = byLaw[lawId][article] || []).push(entry);
  };
  for (const [links, kind] of [[shLinks, 'j'], [saLinks, 's']]) {
    for (const [id, refs] of Object.entries(links)) for (const r of refs) add(r.law_id, r.article, { i: id, k: kind, s: r.src || 'kankei' });
  }
  for (const e of llm) add(e.law_id, e.article, { i: e.i, k: e.k, s: 'llm', c: e.c || 'low' });
  const rank = (e) => (RANK[e.s] === undefined ? 3 : RANK[e.s]);
  for (const law of Object.values(byLaw)) {
    for (const [a, arr] of Object.entries(law)) {
      const seen = new Set();
      law[a] = arr.filter((e) => (seen.has(e.i + e.k) ? false : seen.add(e.i + e.k))).sort((x, y) => rank(x) - rank(y));
    }
  }
  return byLaw;
}
// 事例・裁決 → homes（09_gen_homes_update と同じ: law_id:条 の昇順、{l, n, a}）
function homesIndex(byLaw, ID2NAME, jou2title) {
  const m = { j: new Map(), s: new Map() };
  for (const [lid, arts] of Object.entries(byLaw)) {
    for (const [jou, hits] of Object.entries(arts)) {
      for (const h of hits) {
        const t = m[h.k]; if (!t) continue;
        if (!t.has(h.i)) t.set(h.i, new Map());
        t.get(h.i).set(`${lid}:${jou}`, { l: lid, n: ID2NAME[lid] || lid, a: jou2title(jou) });
      }
    }
  }
  return (kind, id) => { const x = m[kind].get(id); return x ? [...x.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]) : []; };
}
// metadata が 10KiB を超えるときは homes を後ろから削る
function fitHomes(meta, homes) {
  let hs = homes;
  let m = { ...meta, homes: JSON.stringify(hs) };
  while (Buffer.byteLength(JSON.stringify(m)) > META_LIMIT && hs.length) { hs = hs.slice(0, hs.length - 1); m = { ...meta, homes: JSON.stringify(hs) }; }
  return m;
}

// ---------------------------------------------------------------- ベクトル（06_embed と同じ id・text・metadata）
function desiredVectors({ shRecs, saRecs, homesOf }) {
  const out = new Map();
  for (const it of Object.values(shRecs)) {
    const text = `${it.title}\n${it.shokai.slice(0, 900)}\n${it.kaito.slice(0, 500)}`;
    const meta = { sid: it.id, cat: it.category || '', title: (it.title || '').slice(0, 100), q: it.shokai.slice(0, 300), a: it.kaito.slice(0, 300), url: it.url, img: (it.images || []).length, as_of: it.as_of || '' };
    const id = md5(`shitsugi:${it.id}`);
    out.set(id, { id, namespace: NS.j, text, metadata: fitHomes(meta, homesOf('j', it.id)), sid: it.id, k: 'j' });
  }
  for (const it of Object.values(saRecs)) {
    const common = {
      sid: it.id, title: (it.title || '').slice(0, 90), abst: (it.abstract || '').replace(/\s+/g, ' ').slice(0, 200),
      cat: (it.tax_laws || []).map((x) => x.law).join('・'), date: it.date || '', topic: (it.topics || [])[0] || '', url: it.url || '',
    };
    const homes = homesOf('s', it.id);
    const ida = md5(`saiketsu:${it.id}#abst`);
    out.set(ida, { id: ida, namespace: NS.s, text: `${it.title}\n${it.abstract.slice(0, 1500)}`, metadata: fitHomes({ ...common, sec: '裁決要旨' }, homes), sid: it.id, k: 's' });
    unitsFromSections(it.sections).units.forEach((u, i) => {
      const id = md5(`saiketsu:${it.id}#s${i}`);
      out.set(id, { id, namespace: NS.s, text: `${it.title.slice(0, 100)}\n${u.text}`, metadata: fitHomes({ ...common, sec: u.sec.slice(0, 40) }, homes), sid: it.id, k: 's' });
    });
  }
  return out;
}
const vecSig = (v) => ({ ns: v.namespace, th: sha(v.text), mh: sha(stableJson(v.metadata)) });

// ---------------------------------------------------------------- 本番を読む
async function readProd(r2, prefix) {
  const index = await r2.getJson(`${prefix}/index.json`);
  if (!index) throw new Error(`本番の ${prefix}/index.json が読めない`);
  const chunks = {}, raw = {};
  for (const ch of [...new Set(Object.values(index).map((v) => v.chunk))].sort()) {
    const buf = await r2.get(`${prefix}/${ch}`);
    if (!buf) throw new Error(`本番の ${prefix}/${ch} が無い（index.json には載っている）`);
    raw[ch] = buf;
    chunks[ch] = JSON.parse(buf.toString('utf8'));
  }
  const indexBuf = await r2.get(`${prefix}/index.json`);
  const recs = {};
  for (const obj of Object.values(chunks)) for (const [id, r] of Object.entries(obj)) recs[id] = r;
  return { index, indexBuf, chunks, raw, recs };
}
async function readArticleLinks(r2) {
  const keys = (await r2.list(`${AL}/`)).map((o) => o.key).filter((k) => k.endsWith('.json'));
  const files = {}, raw = {};
  for (const k of keys) {
    const buf = await r2.get(k);
    if (!buf) throw new Error(`本番の ${k} が読めない`);
    raw[k] = buf;
    files[k] = JSON.parse(buf.toString('utf8'));
  }
  return { files, raw };
}
async function fetchImage(p) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${IMG_BASE}${p}`, { headers: { 'User-Agent': `joubun-kun-shitsugi-crawler/1.0 (+https://joubun-kun.com; contact: ${SITE.crawlerContact})` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) { if (i === 3) throw e; await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); }
  }
  return null;
}
const imgType = (p) => (/\.png$/i.test(p) ? 'image/png' : /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/gif');

// ---------------------------------------------------------------- build
async function build({ out, stamp, rid, gens = {} }) {
  const B = path.join(out, 'build');
  fs.rmSync(B, { recursive: true, force: true });
  fs.mkdirSync(path.join(B, 'files'), { recursive: true });
  const report = { blockers: [], review: [], notes: [] };
  const r2 = new R2();
  const gen = await makeGenGuard(r2, APPLY_LOCK_KEY);   // 世代 → 印の順に読む。読み終えるまでに反映・戻しが入ったら、この下見は使わない
  const lock = gen.lock;
  // 条文リンクは今の本番の通達（帰属条の地図）からも作るので、通達の反映・戻しも見張る（世代・印・版を下見に残し、反映のときも確かめる）
  const tsuGen = await makeGenGuard(r2, TSU_LOCK_KEY);
  const TSU = tsuProdPrefix();
  if (tsuGen.lock) report.blockers.push(`通達の${tsuGen.lock.kind === 'restore' ? '戻し' : '反映'}（run ${tsuGen.lock.run_id}・${tsuGen.lock.phase}）が途中で止まっている（${TSU_LOCK_KEY} が残っている）。条文リンクの元の通達が書きかけなので比べない。Actions の Update tsutatsu data で戻してから流し直す`);
  if (lock) report.blockers.push(`前回の事例・裁決の${lock.kind === 'restore' ? '戻し' : '反映'}（run ${lock.run_id}・${lock.phase}・${lock.started_at} 開始）が途中で止まっている（${APPLY_LOCK_KEY} が残っている）。Actions の Update cases data を mode=restore・restore_run_id=${lock.run_id} で戻してから流し直す`);

  // ---- 1. 解析（03 の実物を作業フォルダで流す）
  const items = {};
  for (const name of ['shitsugi', 'saiketsu']) {
    const work = path.join(out, 'work', name);
    const script = path.join(work, 'scripts', name, '03_parse.cjs');
    if (!fs.existsSync(path.join(work, `all_${name}_${stamp}`))) throw new Error(`今回の写し all_${name}_${stamp} が作業フォルダに無い（crawl が基準を更新した回だけ build する）`);
    // 確かめ用に 03 の代わりを渡せる（CASES_BUILD_SCRIPTS。本番では付けない）
    if (process.env.CASES_BUILD_SCRIPTS) fs.copyFileSync(path.join(process.env.CASES_BUILD_SCRIPTS, name, '03_parse.cjs'), script);
    const code = await runProc(process.execPath, [script], { cwd: work });
    if (code) throw new Error(`${name} の 03_parse が落ちた（${code}）`);
    items[name] = readNdjson(path.join(work, 'scripts', name, 'state', `${name}_items_${stamp}.ndjson`));
    if (!items[name].length) throw new Error(`${name}_items_${stamp}.ndjson が空（03 が 1 件も取れなかった）。書かずに止める`);
  }

  // ---- 2. 本番を読む
  const prodSh = await readProd(r2, SH);
  const prodSa = await readProd(r2, SA);
  const prodAl = await readArticleLinks(r2);
  const prodImg = new Map();
  for (const r of Object.values(prodSh.recs)) for (const im of r.images || []) if (im.path && !prodImg.has(im.path)) prodImg.set(im.path, { text: im.text ?? null, kind: im.kind ?? null });

  const files = {};   // R2 キー -> { sha_before, local, content_type? }
  const putFile = (key, buf, before, ct) => {
    const local = `files/${key.replace(/\//g, '__')}`;
    fs.writeFileSync(path.join(B, local), buf);
    files[key] = { sha_before: before ? sha(before) : null, local, ...(ct ? { content_type: ct, sha_after: sha(buf) } : {}) };
  };

  // ---- 3. 画像（事例が載せている画像を毎週すべて国税庁から取り、R2 の画像と中身で比べる。文字起こしはしない）
  //   R2 に無い（新しい・前に取れなかった）→ 置く。取れなかったものは R2 に無いままなので翌週また取りに行く。
  //   R2 にあって中身が違う（国税庁が同じ URL のまま差し替えた）→ 退避付きで差し替え、その画像の文字起こしは引き継がない（空にして見直す対象に出す）。
  //   R2 の中身は一覧の ETag（1 回で置いたファイルは MD5）で比べ、MD5 の形でなければ実物を読んで比べる
  const imgPaths = [...new Set(Object.values(shitsugiRecords(items.shitsugi, prodImg).recs).flatMap((r) => (r.images || []).map((im) => im.path)))].sort();
  const imgList = new Map((await r2.list(`${SH}/img/`)).map((o) => [o.key, o]));
  const imgFail = [], imgCheckFail = [], imgChanged = [];
  let imgGot = 0, imgMissing = 0;
  for (const p of imgPaths) {
    if (process.env.CASES_SKIP_IMAGES === '1') break;
    const key = `${SH}/img${p}`;
    const inR2 = imgList.get(key);
    if (!inR2) imgMissing++;
    let buf;
    try { buf = await fetchImage(p); } catch (e) { (inR2 ? imgCheckFail : imgFail).push(`${p}（${String(e.message).slice(0, 60)}）`); }
    if (buf && !inR2) { putFile(key, buf, null, imgType(p)); imgGot++; }
    else if (buf) {
      let same = /^[0-9a-f]{32}$/.test(inR2.etag || '') ? inR2.etag === md5(buf) : null;
      let before = null;
      if (same === null || !same) { before = await r2.get(key); same = !!before && sha(before) === sha(buf); }
      if (!same) { putFile(key, buf, before, imgType(p)); imgChanged.push(p); }
    }
    if (IMG_SLEEP_MS) await new Promise((r) => setTimeout(r, IMG_SLEEP_MS));
  }
  for (const p of imgChanged) prodImg.delete(p);

  // ---- 4. レコード
  const sh = shitsugiRecords(items.shitsugi, prodImg);
  const sa = saiketsuRecords(items.saiketsu);
  // 本番では本文（全文）があった裁決が、今回は要旨だけになった: 本文のページを取れなかった回か、審判所が本文を外したか。
  // どちらか分からないので本文（節・関係法令・URL）は本番のまま残し、見直す対象に出す（黙って本文と節のベクトルを消さない）
  const keptFull = [];
  for (const [id, r] of Object.entries(sa.recs)) {
    const p = prodSa.recs[id];
    if (!p || !p.has_full || r.has_full) continue;
    sa.recs[id] = { ...r, sections: p.sections, has_full: p.has_full, url: p.url, law_refs: p.law_refs, date: r.date || p.date };
    keptFull.push(id);
  }
  if (keptFull.length) report.review.push(`本番では本文（全文）があった裁決 ${keptFull.length} 件が、今回は要旨だけだった（本文のページを取れなかったか、審判所が本文を外した）。本文は本番のまま残す（外すなら手で）: ${keptFull.slice(0, 10).join('、')}${keptFull.length > 10 ? ' ほか' : ''}`);
  const newImg = [...sh.newImages.keys()].filter((p) => !imgChanged.includes(p)).sort();   // 本番のレコードに無い画像（文字起こしが空になるもの）
  if (newImg.length) report.review.push(`新しい画像 ${newImg.length} 枚（文字起こしは LLM を使わないので空のまま。画面には画像として出る）`);
  if (imgChanged.length) report.review.push(`国税庁が同じ URL のまま中身を差し替えた画像 ${imgChanged.length} 枚（R2 の画像を差し替える。前の文字起こしは引き継がず空にする。画面には画像として出る）: ${imgChanged.slice(0, 5).join('、')}${imgChanged.length > 5 ? ' ほか' : ''}`);
  if (imgFail.length) report.review.push(`R2 に無い画像 ${imgMissing} 枚のうち ${imgFail.length} 枚を取れなかった（画面ではその画像が出ない。R2 に無いままなので翌週また取りに行く）: ${imgFail.slice(0, 5).join('、')}${imgFail.length > 5 ? ' ほか' : ''}`);
  if (imgCheckFail.length) report.notes.push(`R2 にある画像 ${imgCheckFail.length} 枚は国税庁から取れず、差し替えを確かめられなかった（R2 の画像はそのまま。翌週また確かめる）: ${imgCheckFail.slice(0, 5).join('、')}${imgCheckFail.length > 5 ? ' ほか' : ''}`);
  if (process.env.CASES_SKIP_IMAGES === '1' && imgPaths.length) report.notes.push('画像を国税庁から取りに行かなかった（CASES_SKIP_IMAGES。確かめ用）');
  const stats = {};
  for (const [label, prefix, cur, prod] of [['質疑応答事例', SH, sh, prodSh], ['裁決', SA, sa, prodSa]]) {
    const newChunks = chunksOf(cur.recs, cur.index);
    const allChunks = new Set([...Object.keys(newChunks), ...Object.keys(prod.chunks)]);
    for (const ch of [...allChunks].sort()) {
      const now = newChunks[ch] || {};
      if (prod.chunks[ch] && stableJson(prod.chunks[ch]) === stableJson(now)) continue;
      // index.json に載っていないチャンクでも、R2 に実物が残っていることがある（前に最後の 1 件が消えて {} を書いたもの）。
      // その中身を「書く前」として控える（控えが無いと、反映のときに「下見の後に変わった」と取り違えて止まり続ける）
      const before = prod.raw[ch] || await r2.get(`${prefix}/${ch}`);
      if (!prod.raw[ch] && before && stableJson(JSON.parse(before.toString('utf8'))) === stableJson(now)) continue;
      putFile(`${prefix}/${ch}`, Buffer.from(JSON.stringify(now)), before);
    }
    if (stableJson(prod.index) !== stableJson(cur.index)) putFile(`${prefix}/index.json`, Buffer.from(JSON.stringify(cur.index)), prod.indexBuf);
    const prodIds = new Set(Object.keys(prod.recs)), nowIds = new Set(Object.keys(cur.recs));
    const added = [...nowIds].filter((id) => !prodIds.has(id)).sort();
    const removed = [...prodIds].filter((id) => !nowIds.has(id)).sort();
    const changed = [...nowIds].filter((id) => prodIds.has(id) && stableJson(prod.recs[id]) !== stableJson(cur.recs[id])).sort();
    stats[label] = { prod: prodIds.size, now: nowIds.size, added, removed, changed, diff: diffBreakdown(changed, prod.recs, cur.recs) };
    if (nowIds.size < prodIds.size * 0.9 && prodIds.size - nowIds.size > DROP_MIN) report.blockers.push(`${label}の件数が 1 割超減った（${prodIds.size} → ${nowIds.size}）`);
    if (removed.length) report.review.push(`${label}が ${removed.length} 件消える（国税庁・審判所から消えたか、解析できなくなった）: ${removed.slice(0, 10).join('、')}${removed.length > 10 ? ' ほか' : ''}`);
    if (changed.length + added.length > MAX_CHANGED) report.review.push(`${label}が ${changed.length + added.length} 件変わる・増える（${MAX_CHANGED} 件超）`);
  }

  // ---- 5. 条文リンク（原文の引用は全件作り直し・LLM の割当は本番から引き継ぐ）
  const ALL = loadLawIds();
  const tsuIndex = await r2.getJson(`${TSU}/index.json`);
  if (!tsuIndex || !tsuIndex.laws) throw new Error(`本番の通達 ${TSU}/index.json が読めない（通達の帰属条の地図に使う）`);
  const tsuChunks = [];
  for (const lawId of Object.keys(tsuIndex.laws)) {
    // 台帳に載っているのに読めない・形が違うチャンクがあれば止める（黙って飛ばすと、その通達から来る条文リンクを消す下見になる）
    const d = await r2.getJson(`${TSU}/${lawId}.json`);
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`本番の通達 ${TSU}/${lawId}.json が無い・形が違う（index.json には載っている）。書かずに止める`);
    tsuChunks.push([lawId, d]);
  }
  const { link } = makeShitsugiLinker(ALL, buildTsuRev(tsuChunks));
  const shLinks = {}, saLinks = {};
  for (const [id, r] of Object.entries(sh.recs)) { const f = link(r).found; if (f.length) shLinks[id] = f; }
  for (const [id, r] of Object.entries(sa.recs)) { const f = linkSaiketsu(r, ALL).found; if (f.length) saLinks[id] = f; }
  const llm = [];
  let prodEntries = 0;
  const prodLinked = { j: new Set(), s: new Set() };
  for (const [k, obj] of Object.entries(prodAl.files)) {
    if (k.endsWith('/_cases.json')) continue;
    const lawId = path.basename(k, '.json');
    for (const [jou, arr] of Object.entries(obj)) {
      for (const e of arr || []) {
        prodEntries++;
        if (prodLinked[e.k]) prodLinked[e.k].add(e.i);
        const alive = e.k === 'j' ? sh.recs[e.i] : e.k === 's' ? sa.recs[e.i] : null;
        if (e.s === 'llm' && alive) llm.push({ law_id: lawId, article: jou, i: e.i, k: e.k, c: e.c });
      }
    }
  }
  const byLaw = buildArticleIndex({ shLinks, saLinks, llm });
  let nowEntries = 0;
  for (const arts of Object.values(byLaw)) for (const arr of Object.values(arts)) nowEntries += arr.length;
  for (const lawId of [...new Set([...Object.keys(byLaw), ...Object.keys(prodAl.files).filter((k) => !k.endsWith('/_cases.json')).map((k) => path.basename(k, '.json'))])].sort()) {
    const key = `${AL}/${lawId}.json`;
    const now = byLaw[lawId] || {};
    if (prodAl.files[key] && stableJson(prodAl.files[key]) === stableJson(now)) continue;
    if (!prodAl.files[key] && !Object.keys(now).length) continue;
    putFile(key, Buffer.from(JSON.stringify(now)), prodAl.raw[key]);
  }
  const cases = {};
  for (const r of Object.values(sh.recs)) cases[r.id] = { t: r.title || '', u: r.url || '', k: 'j', d: r.as_of || '' };
  for (const r of Object.values(sa.recs)) cases[r.id] = { t: r.title || '', u: r.url || '', k: 's', d: r.date || '' };
  const casesKey = `${AL}/_cases.json`;
  if (!prodAl.files[casesKey] || stableJson(prodAl.files[casesKey]) !== stableJson(cases)) putFile(casesKey, Buffer.from(JSON.stringify(cases)), prodAl.raw[casesKey]);
  if (nowEntries < prodEntries * 0.9 && prodEntries - nowEntries > DROP_MIN) report.blockers.push(`条文リンクの総数が 1 割超減った（${prodEntries} → ${nowEntries}）`);
  const linkedNow = { j: new Set(), s: new Set() };
  for (const arts of Object.values(byLaw)) for (const arr of Object.values(arts)) for (const e of arr) linkedNow[e.k].add(e.i);
  const lost = [...[...prodLinked.j].filter((i) => sh.recs[i] && !linkedNow.j.has(i)), ...[...prodLinked.s].filter((i) => sa.recs[i] && !linkedNow.s.has(i))];
  if (lost.length) report.review.push(`条文リンクが無くなる事例・裁決 ${lost.length}: ${lost.slice(0, 10).join('、')}${lost.length > 10 ? ' ほか' : ''}`);
  const newUnlinked = [...[...stats['質疑応答事例'].added].filter((i) => !linkedNow.j.has(i)), ...[...stats['裁決'].added].filter((i) => !linkedNow.s.has(i))];
  if (newUnlinked.length) report.review.push(`新しい事例・裁決のうち条文リンクが付かないもの ${newUnlinked.length}（LLM での割当はしない。条文ページの一覧には出ないが、検索には出る）: ${newUnlinked.slice(0, 10).join('、')}${newUnlinked.length > 10 ? ' ほか' : ''}`);

  // ---- 6. ベクトル（あるべき全体を出し、前回反映した状態と比べる）
  const ID2NAME = {};
  for (const [n, i] of Object.entries(ALL)) if (!ID2NAME[i]) ID2NAME[i] = n;
  const { jou2title } = loadFrom16();
  const desired = desiredVectors({ shRecs: sh.recs, saRecs: sa.recs, homesOf: homesIndex(byLaw, ID2NAME, jou2title) });
  const tooBig = [...desired.values()].filter((v) => Buffer.byteLength(JSON.stringify(v.metadata)) > META_LIMIT);
  if (tooBig.length) report.blockers.push(`metadata が 10KiB を超えるベクトルが ${tooBig.length} 本（例 ${tooBig[0].id}）`);
  const vec = new Vectorize({ index: VEC_INDEX });
  const stateBuf = await r2.get(VEC_STATE_KEY);
  let vecState = stateBuf ? JSON.parse(stateBuf.toString('utf8')) : null;
  const firstRun = !vecState;
  if (firstRun) {
    report.review.push('初回: 反映した状態の控え（update_state/cases/vec_state.json）が無いので、本番のレコードから同じ作り方で組み立て直した本文と、Vectorize の実物（get_by_ids）の metadata で作った');
    const prodHomes = homesIndex(Object.fromEntries(Object.entries(prodAl.files).filter(([k]) => !k.endsWith('/_cases.json')).map(([k, v]) => [path.basename(k, '.json'), v])), ID2NAME, jou2title);
    const prodDesired = desiredVectors({ shRecs: prodSh.recs, saRecs: prodSa.recs, homesOf: prodHomes });
    const cand = new Map([...prodDesired].map(([id, v]) => [id, { ns: v.namespace, th: sha(v.text) }]));
    for (const [id, v] of desired) if (!cand.has(id)) cand.set(id, { ns: v.namespace, th: null });
    const ids = [...cand.keys()];
    vecState = {};
    const PACE = Number(process.env.CASES_VEC_PACE_MS || 400);
    for (let i = 0; i < ids.length; i += 20) {
      for (const g of await vec.getByIds(ids.slice(i, i + 20))) {
        const c = cand.get(g.id);
        vecState[g.id] = { ns: c.ns, th: c.th, mh: sha(stableJson(g.metadata || {})) };
      }
      if (PACE && !vec.fakeFile) await new Promise((r) => setTimeout(r, PACE));
    }
    report.notes.push(`初回の確かめ: 候補 ${ids.length} 本のうち Vectorize にあった ${Object.keys(vecState).length} 本`);
  }
  const upserts = [], metaUpdates = [], deletes = [];
  const nextState = {};
  for (const [id, v] of desired) {
    const s = vecSig(v);
    nextState[id] = s;
    const cur = vecState[id];
    if (!cur || cur.th === null || cur.th !== s.th || cur.ns !== s.ns) upserts.push({ ...v, why: !cur ? 'new' : 'text' });
    else if (cur.mh !== s.mh) metaUpdates.push({ id, namespace: v.namespace, metadata: v.metadata });
  }
  for (const [id, cur] of Object.entries(vecState)) if (!desired.has(id)) deletes.push({ id, namespace: cur.ns });
  if (upserts.length > MAX_EMBED) report.review.push(`埋め込むベクトルが ${upserts.length} 本（${MAX_EMBED} 本超）`);
  const HARD_MAX = MAX_EMBED * 5;
  if (upserts.length > HARD_MAX) report.blockers.push(`埋め込むベクトルが ${upserts.length} 本（${HARD_MAX} 本超）。状態の控えか解析が崩れている疑い`);
  const emb = new Embedder();
  const toEmbed = upserts.length > HARD_MAX ? [] : upserts;
  const values = toEmbed.length ? await emb.embed(toEmbed.map((u) => u.text)) : [];
  const vectors = toEmbed.map((u, i) => ({ id: u.id, namespace: u.namespace, values: values[i], metadata: u.metadata, why: u.why }));
  const samples = [...desired.values()].filter((v) => vecState[v.id] && vecState[v.id].th === sha(v.text)).slice(0, 5);
  if (samples.length) {
    const got = new Map((await vec.getByIds(samples.map((s) => s.id))).map((g) => [g.id, g]));
    const re = await emb.embed(samples.map((s) => s.text));
    const cos = samples.map((s, i) => (got.get(s.id) && Array.isArray(got.get(s.id).values) ? cosine(re[i], got.get(s.id).values) : NaN));
    const bad = cos.filter((c) => !Number.isFinite(c) || c < 0.98);
    report.notes.push(`埋め込みの自己一致: ${cos.map((c) => (Number.isFinite(c) ? c.toFixed(4) : '取れない')).join(' / ')}`);
    if (bad.length) report.blockers.push(`埋め込みのずれ: 既存 ${samples.length} 本のうち ${bad.length} 本が 0.98 未満（Workers AI の出力が索引と合わない。AI_POOLING を確かめる）`);
    if (samples.length < 3) report.review.push(`埋め込みのずれを ${samples.length} 本しか確かめられなかった`);
  } else if (upserts.length) report.review.push('埋め込みのずれを確かめる既存のベクトルが無かった');

  // ---- 7. 成果物（本番を読み終えた。途中で反映・戻しが入っていれば捨てる）
  if (process.env.CASES_TEST_MID_BUILD) require('child_process').execSync(process.env.CASES_TEST_MID_BUILD, { stdio: 'inherit' });   // 確かめ用: 下見の途中に戻しを挟む
  await gen.verify();
  await tsuGen.verify();
  writeNdjson(path.join(B, 'vectors.ndjson'), vectors);
  writeNdjson(path.join(B, 'meta_updates.ndjson'), metaUpdates);
  writeNdjson(path.join(B, 'deletes.ndjson'), deletes);
  fs.writeFileSync(path.join(B, 'vec_state_next.json'), JSON.stringify(nextState));
  const m = {
    run_id: rid, stamp, baseline_gens: gens, created_at: new Date().toISOString(), first_run: firstRun,
    vec_state_sha_before: stateBuf ? sha(stateBuf) : null, gen_sha_before: gen.sha, deps: { tsutatsu: { prefix: TSU, gen_sha: tsuGen.sha } },
    files, counts: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { prod: v.prod, now: v.now, added: v.added.length, removed: v.removed.length, changed: v.changed.length }])),
    records: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { added: v.added, removed: v.removed, changed: v.changed }])),
    changed_breakdown: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.diff])),
    links: { prod: prodEntries, now: nowEntries, llm_carried: llm.length },
    new_images: newImg.length, images_fetched: imgGot, images_failed: imgFail.length, images_changed: imgChanged.length, images_unchecked: imgCheckFail.length,
    vectors: { upsert: vectors.length, upsert_new: upserts.filter((u) => u.why === 'new').length, upsert_text: upserts.filter((u) => u.why === 'text').length, meta_update: metaUpdates.length, delete: deletes.length },
    blockers: report.blockers, review: report.review, notes: report.notes,
  };
  m.ok_to_apply = !m.blockers.length;
  m.needs_review = m.review.length > 0;
  m.nothing_to_do = !Object.keys(files).length && !vectors.length && !metaUpdates.length && !deletes.length && !m.blockers.length && !m.review.length;
  fs.writeFileSync(path.join(B, 'manifest.json'), JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(B, 'report.md'), renderReport(m));
  log(`\nbuild: ファイル ${Object.keys(files).length} / ベクトル 埋め込み ${vectors.length}・metadata ${metaUpdates.length}・削除 ${deletes.length} / 止めた理由 ${m.blockers.length}・見直す ${m.review.length}`);
  return m;
}

function renderReport(m) {
  const L = [`# 質疑応答事例・裁決の作り直し（反映の下見）${m.stamp}（run ${m.run_id}）`, ''];
  for (const [k, v] of Object.entries(m.counts)) L.push(`- ${k}: 本番 ${v.prod} → 今回 ${v.now}（新しい ${v.added}・変わった ${v.changed}・消える ${v.removed}）`);
  L.push(`- 条文リンク: ${m.links.prod} → ${m.links.now}（LLM の割当を引き継いだ ${m.links.llm_carried}）`,
    `- 書くファイル: ${Object.keys(m.files).length}（新しい画像 ${m.new_images}・差し替えた画像 ${m.images_changed}）`,
    `- ベクトル: 埋め込む ${m.vectors.upsert}（新しい ${m.vectors.upsert_new}・本文が変わった ${m.vectors.upsert_text}）・metadata だけ ${m.vectors.meta_update}・消す ${m.vectors.delete}${m.first_run ? '（初回）' : ''}`, '');
  if (m.blockers.length) { L.push('## 止めた理由', ''); for (const b of m.blockers) L.push(`- ${b}`); L.push(''); }
  if (m.review.length) { L.push('## 見直す対象', ''); for (const b of m.review) L.push(`- ${b}`); L.push(''); }
  if (m.notes.length) { L.push('## メモ', ''); for (const b of m.notes) L.push(`- ${b}`); L.push(''); }
  // 変わったレコードの内訳（どの項目が変わったか・空白だけの違いか）
  for (const [k, d] of Object.entries(m.changed_breakdown || {})) {
    const n = (m.counts[k] || {}).changed || 0;
    if (!n || !d) continue;
    const fs = Object.entries(d.fields).sort((x, y) => y[1] - x[1]).map(([f, c]) => `${f} ${c}`).join('・');
    L.push(`## ${k}: 変わった ${n} 件の内訳`, '', `- 項目ごと: ${fs || 'なし'}`, `- 空白（改行・字下げ）だけの違い: ${d.space_only} 件`);
    for (const e of d.examples) L.push(`- 例 ${e.id}（${e.fields.join('・')}）: ${e.field} 前 ${e.before} → 後 ${e.after}`);
    L.push('');
  }
  for (const [k, v] of Object.entries(m.records)) {
    for (const [f, t] of [['added', '新しい'], ['changed', '変わった'], ['removed', '消える']]) {
      if (!v[f].length) continue;
      L.push(`## ${k}: ${t}（${v[f].length}）`, '', ...v[f].slice(0, 100).map((x) => `- ${x}`), ...(v[f].length > 100 ? [`- ほか ${v[f].length - 100} 件`] : []), '');
    }
  }
  return L.join('\n') + '\n';
}

module.exports = { build, diffBreakdown, desiredVectors, buildArticleIndex, homesIndex, shitsugiRecords, saiketsuRecords, VEC_STATE_KEY, APPLY_LOCK_KEY, META_LIMIT, VEC_INDEX, SH, SA, AL };
