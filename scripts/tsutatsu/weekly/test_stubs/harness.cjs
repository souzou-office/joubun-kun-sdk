// 通達の週次（段 3a・3b）の確かめの共通部分。check_build.cjs と check_apply.cjs が使う。¥0。
//   偽の本番（R2_FAKE_DIR の tsutatsu_chunks_vT と VECTORIZE_FAKE_FILE）を作り、crawl が済んだ作業フォルダから build を流す。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = path.join(__dirname, '..');

const RUN = path.join(W, 'run.cjs');
const STUBS = __dirname;
const { desiredVectors, vecSig } = require('../build.cjs');
const { buildLinks, buildChunks } = require('./lib.cjs');
const { Embedder } = require('../../../update/lib/ai.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tsu-build-'));
const R2DIR = path.join(TMP, 'r2');
const VECFILE = path.join(TMP, 'vec.json');
const PROD = 'tsutatsu_chunks_vT';
const STAMP = '20260927';
const HOJIN = '340AC0000000034', SOZOKU = '325AC0000000073', CHOSYU = '334AC0000000147';
const NTA = 'https://www.nta.go.jp/law/tsutatsu';

// ---------------------------------------------------------------- 素材
function baseItems() {
  const it = (no, home, body, caption = `（見出し${no}）`, page = 'kihon/hojin/01.htm') => ({
    tsutatsu_no: no, circular_path: page.split('/').slice(0, 2).join('/'), home, caption, body,
    citations: [], source_url: `${NTA}/${page}`, source_path: `all_tsutatsu_${STAMP}/${page}`,
  });
  const items = [
    it('22-1', `${HOJIN}:22`, '内国法人の各事業年度の所得の金額の計算上、益金の額に算入すべき金額は、別段の定めがあるものを除き…。'),
    it('22-2', `${HOJIN}:22`, '資産の販売に係る収益の額は、原則として、その引渡しの日の属する事業年度の益金の額に算入する。'),
    it('34-1', `${HOJIN}:34`, '役員給与の損金不算入の規定の適用に当たっては、次に掲げるところによる。役員とは…。'),
    it('3-1', `${SOZOKU}:3`, '相続税法第3条に規定するみなし相続財産の範囲は次のとおりとする。…', '（みなし相続財産）', 'kihon/sisan/sozoku2/01.htm'),
    // 機械では紐付かない（本番では LLM の割当で 34 条に付いていた）
    it('9-1', null, '役員の報酬の支給に関する取扱いは次のとおりとする（本番では LLM が 34 条に割り当てた）。', '（役員報酬）'),
  ];
  // 巨大条文（徴収法 47 条に 72 本）
  for (let i = 1; i <= 72; i++) items.push(it(`47-${i}`, `${CHOSYU}:47`, `差押えの要件に関する取扱いその${i}。国税徴収法第47条の適用に当たっては次による。`, `（差押え${i}）`, 'kihon/chosyu/01.htm'));
  return items;
}
const PDF_A = `${NTA}/kobetsu/hojin/a.pdf`;
function prodPdfRefs() { return [{ url: PDF_A, title: '別表 耐用年数表', abolished: false, circular_path: 'kobetsu/hojin', recovered_arts: [`${HOJIN}:22`] }]; }

// 本番のチャンクを「今の作り方で作ったもの」として置く（浮きの 9-1 は本番では 34 条に付いていた）
function putProd(items, { extraAssign = true } = {}) {
  const asg = extraAssign ? { [`all_tsutatsu_${STAMP}/kihon/hojin/01.htm#9-1`]: { law_id: HOJIN, article: '34' } } : {};
  const { links } = buildLinks(items, prodPdfRefs(), asg);
  const { byLaw, index } = buildChunks(links, items);
  fs.rmSync(path.join(R2DIR, PROD), { recursive: true, force: true });
  fs.mkdirSync(path.join(R2DIR, PROD), { recursive: true });
  for (const [law, arts] of Object.entries(byLaw)) fs.writeFileSync(path.join(R2DIR, PROD, `${law}.json`), JSON.stringify(arts));
  fs.writeFileSync(path.join(R2DIR, PROD, 'index.json'), JSON.stringify(index));
  return { links, byLaw };
}
const fake = new Embedder({ fake: true });
async function putVectors(links, items, { state = true, drift = false } = {}) {
  const itemMap = {};
  for (const o of items) itemMap[`${o.source_url}|${o.tsutatsu_no}`] = { body: o.body || '', caption: o.caption || '' };
  const d = desiredVectors(links, itemMap, require('../build.cjs')._from16 || loadFrom16());
  const db = {};
  const vals = await fake.embed([...d.values()].map((v) => (drift ? `ずれ ${v.text}` : v.text)));
  [...d.values()].forEach((v, i) => { db[v.id] = { values: vals[i], metadata: v.metadata, namespace: v.namespace }; });
  fs.writeFileSync(VECFILE, JSON.stringify(db));
  const st = {};
  for (const v of d.values()) st[v.id] = vecSig(v);
  const sk = path.join(R2DIR, 'update_state', 'tsutatsu', 'vec_state.json');
  fs.mkdirSync(path.dirname(sk), { recursive: true });
  if (state) fs.writeFileSync(sk, JSON.stringify(st)); else fs.rmSync(sk, { force: true });
  return d;
}
function loadFrom16() {
  const src = fs.readFileSync(path.join(W, '..', '16_embed_reverse.cjs'), 'utf8');
  const g = (re) => (src.match(re) || [])[0];
  return new Function(`${g(/const LAW_NAME = \{[\s\S]*?\n\};/)}\n${g(/function intToKanji\([\s\S]*?\n\}/)}\n${g(/function jou2title\([\s\S]*?\n\}/)}\nreturn { LAW_NAME, jou2title };`)();
}

// crawl が済んだ作業フォルダ（summary.json・今回の写し・PDF の manifest）を作って build を流す
function runBuild(items, { pdfManifest = [{ url: PDF_A, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/a.pdf` }], env = {}, saved = true, rawItems = null, outDir = null, runId = 'run-1', gen = null, pdfChanged = [], pdfHash = {}, pages = null } = {}) {
  const out = outDir || path.join(TMP, `out-${Math.random().toString(36).slice(2, 7)}`);
  const state = path.join(out, 'work', 'scripts', 'tsutatsu', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(out, 'work', `all_tsutatsu_${STAMP}`), { recursive: true });
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ run_id: runId, stamp: STAMP, saved, gen, pdf: { added: [], changed: pdfChanged.map((url) => ({ url })), gone: [] } }));
  if (pdfManifest) fs.writeFileSync(path.join(state, `pdf_manifest_${STAMP}.ndjson`), pdfManifest.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // 04 の台帳（PDF の中身の hash）。既定は url ごとに決まった値
  fs.writeFileSync(path.join(state, 'pdf_ledger.json'), JSON.stringify(Object.fromEntries((pdfManifest || []).filter((r) => !r.error).map((r) => [r.url, { content_hash: pdfHash[r.url] || `h:${r.url}` }]))));
  // ページの見出し（page_titles.cjs）を確かめるときだけ、取り込んだ HTML を置く（{ 'kihon/hojin/01.htm': '<title>…</title>' }）
  for (const [rel, html] of Object.entries(pages || {})) { const f = path.join(out, 'work', `all_tsutatsu_${STAMP}`, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, html); }
  for (const r of pdfManifest || []) if (r.body) { const f = path.join(out, 'work', r.local_path); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, r.body); }
  const fix = path.join(out, 'items.ndjson');
  fs.writeFileSync(fix, rawItems !== null ? rawItems : items.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const before = snapshotR2();
  const e = { ...process.env, TSU_WEEKLY_OUT: out, R2_FAKE_DIR: R2DIR, VECTORIZE_FAKE_FILE: VECFILE, AI_FAKE: '1', TSU_PROD_PREFIX: PROD,
    TSU_BUILD_SCRIPTS: STUBS, TSU_STUB_LIB: path.join(STUBS, 'lib.cjs'), TSU_FIX_ITEMS: fix, TSU_SKIP_PDF_TEXT: '1', TSU_VEC_PACE_MS: '0', ...env };
  delete e.CLOUDFLARE_API_TOKEN; delete e.CLOUDFLARE_ACCOUNT_ID;
  const r = spawnSync(process.execPath, [RUN, 'build'], { env: e, encoding: 'utf8' });
  const B = path.join(out, 'build');
  const m = fs.existsSync(path.join(B, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(B, 'manifest.json'), 'utf8')) : null;
  const nd = (f) => (fs.existsSync(path.join(B, f)) ? fs.readFileSync(path.join(B, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir: out, code: r.status, out: r.stdout + r.stderr, m, B, vectors: nd('vectors.ndjson'), meta: nd('meta_updates.ndjson'), deletes: nd('deletes.ndjson'),
    report: fs.existsSync(path.join(B, 'report.md')) ? fs.readFileSync(path.join(B, 'report.md'), 'utf8') : '', r2Unchanged: snapshotR2() === before };
}
function snapshotR2() {
  const out = [];
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(`${p}:${fs.readFileSync(p).length}:${require('crypto').createHash('md5').update(fs.readFileSync(p)).digest('hex')}`); } };
  walk(R2DIR);
  out.push(fs.existsSync(VECFILE) ? require('crypto').createHash('md5').update(fs.readFileSync(VECFILE)).digest('hex') : '-');
  return out.join('\n');
}


module.exports = { TMP, R2DIR, VECFILE, PROD, STAMP, HOJIN, SOZOKU, CHOSYU, NTA, PDF_A, RUN, baseItems, putProd, putVectors, runBuild, snapshotR2, loadFrom16 };
