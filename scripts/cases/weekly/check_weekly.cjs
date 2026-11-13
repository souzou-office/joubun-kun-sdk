// 質疑応答事例・裁決の週次更新の確かめ（¥0・国税庁にも国税不服審判所にも Cloudflare にも要求を出さない）
//
//   node scripts/cases/weekly/check_weekly.cjs
//
// 手元に偽の国税庁（事例）と偽の国税不服審判所（裁決）を立て（ETag で 304 を返す）、偽の R2（R2_FAKE_DIR）・偽の Vectorize・
// 偽の埋め込み（AI_FAKE=1）で crawl → build → apply → もう一度 build → restore を流す。解析（03）と条文リンク（04 の関数）は実物。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const RUN = path.join(__dirname, 'run.cjs');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).slice(0, 2500)}` : ''}`); }
}
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const etagOf = (b) => `"${md5(b)}"`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-weekly-'));
const R2DIR = path.join(TMP, 'r2');
const VECFILE = path.join(TMP, 'vec.json');
const rk = (k) => path.join(R2DIR, ...k.split('/'));
const readR2 = (k) => (fs.existsSync(rk(k)) ? fs.readFileSync(rk(k)) : null);
const readR2J = (k) => { const b = readR2(k); return b ? JSON.parse(b.toString('utf8')) : null; };
const putR2 = (k, o) => { fs.mkdirSync(path.dirname(rk(k)), { recursive: true }); fs.writeFileSync(rk(k), Buffer.isBuffer(o) ? o : typeof o === 'string' ? o : JSON.stringify(o)); };
const vecDb = () => (fs.existsSync(VECFILE) ? JSON.parse(fs.readFileSync(VECFILE, 'utf8')) : {});

// ---------------------------------------------------------------- 偽のサイト
const SH_SEEDS = ['/law/shitsugi/01.htm', '/law/shitsugi/shotoku/01.htm', '/law/shitsugi/gensen/01.htm', '/law/shitsugi/juto/01.htm', '/law/shitsugi/sozoku/01.htm',
  '/law/shitsugi/hyoka/01.htm', '/law/shitsugi/hojin/01.htm', '/law/shitsugi/shohi/01.htm', '/law/shitsugi/inshi/01.htm', '/taxes/sake/qa/01.htm', '/law/shitsugi/hotei/01.htm'];
function shCase({ title, q, a, kankei, img }) {
  return `<html><head><title>${title}｜国税庁</title></head><body>
<ol class="breadcrumb"><li><a href="/law/shitsugi/01.htm">質疑応答事例</a></li><li><a href="/law/shitsugi/hojin/01.htm">法人税</a></li></ol>
<!-- InstanceBeginEditable name="bodyArea" -->
<h1>${title}</h1>
<h2>【照会要旨】</h2><p>${q}</p>
<h2>【回答要旨】</h2><p>${a}</p>${img ? `<p><img src="${img}" alt="計算式"></p>` : ''}
<h2>【関係法令通達】</h2><p>${kankei}</p><p class="red">注記<br>令和6年7月1日現在の法令・通達等に基づいて作成しています。</p>
<!-- InstanceEndEditable --></body></html>`;
}
const SA_SEEDS = ['/service/index.html', '/service/JP/index.html', '/service/MP/index.html'];
function saMp(entries) {
  return `<html><head><title>法人税法｜損金の額</title></head><body>${entries.map((e, i) => `<h2 class="likeH3" id="a${i + 1}"><span>${e.title}</span></h2>
<p><a href="/service/JP/${e.no}/${e.nn}/index.html">令和6年5月1日裁決</a></p><p>《ポイント》${e.point}</p><p>《要旨》${e.body}</p>`).join('\n')}</body></html>`;
}
function saJp({ no, title, facts, judge }) {
  return `<html><head><title>${title}（令和6年5月1日裁決）</title></head><body><p>《裁決書（抄）》</p>
<p>１　事実</p><p>（1）　事案の概要</p><p>${facts}</p><p>２　判断</p><p>${judge}</p><p>３　関係法令</p><p>法人税法第22条</p></body></html>`;
}
const site = {};   // path -> body
function resetSite() {
  for (const k of Object.keys(site)) delete site[k];
  for (const s of SH_SEEDS) site[s] = '<html><head><title>目次</title></head><body>目次</body></html>';
  site['/law/shitsugi/hojin/01.htm'] = '<html><head><title>法人税 目次</title></head><body><a href="/law/shitsugi/hojin/01/01.htm">事例1</a><a href="/law/shitsugi/hojin/01/02.htm">事例2</a></body></html>';
  site['/law/shitsugi/hojin/01/01.htm'] = shCase({ title: '役員給与の損金算入', q: '役員に支給した給与の取扱いを教えてください。'.repeat(3), a: '定期同額給与に該当するものは損金の額に算入されます。'.repeat(3), kankei: '法人税法第34条第1項' });
  site['/law/shitsugi/hojin/01/02.htm'] = shCase({ title: '資産の販売の収益計上', q: '資産を販売したときの収益の計上時期はいつですか。'.repeat(3), a: '引渡しの日の属する事業年度の益金の額に算入します。'.repeat(3), kankei: '法人税法第22条第2項' });
  for (const s of SA_SEEDS) site[s] = '<html><head><title>目次</title></head><body><a href="/service/MP/03/0101000000.html">法人税</a></body></html>';
  site['/service/MP/03/0101000000.html'] = saMp([
    { no: '141', nn: '01', title: '役員給与の額が過大であるとした事例', point: '過大な役員給与の判断。', body: '法人税法第34条第2項に規定する不相当に高額な部分の金額は損金の額に算入されない。'.repeat(2) },
    { no: '141', nn: '02', title: '収益の計上時期を誤ったとした事例', point: '収益計上の時期。', body: '法人税法第22条第2項に規定する収益の額は引渡しの日に計上すべきである。'.repeat(2) },
  ]);
  site['/service/JP/141/01/index.html'] = saJp({ no: '141', title: '役員給与事件 裁決事例集No.141', facts: '請求人は役員に高額な給与を支給した。'.repeat(5), judge: '不相当に高額な部分は損金の額に算入されないと判断する。'.repeat(5) });
  site['/service/JP/141/02/index.html'] = saJp({ no: '141', title: '収益計上事件 裁決事例集No.141', facts: '請求人は売上の計上時期を翌期とした。'.repeat(5), judge: '引渡しの日に計上すべきであると判断する。'.repeat(5) });
  site['/law/shitsugi/hojin/01/fig.gif'] = 'GIF89a-fake-image';
}
const hits = {};
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const body = site[u];
  hits[u] = (hits[u] || 0) + 1;
  if (body === undefined) { res.writeHead(404); res.end(); return; }
  const et = etagOf(body);
  if (req.headers['if-none-match'] === et) { res.writeHead(304, { ETag: et }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': u.endsWith('.gif') ? 'image/gif' : 'text/html; charset=utf-8', ETag: et });
  res.end(body);
});

// ---------------------------------------------------------------- 本番（最初は空）
function emptyProd() {
  fs.rmSync(R2DIR, { recursive: true, force: true });
  fs.rmSync(VECFILE, { force: true });
  putR2('shitsugi_v1/index.json', {});
  putR2('saiketsu_v1/index.json', {});
  // 通達の帰属条の地図（本番の通達。TSU_PROD_PREFIX で渡す）
  putR2('tsutatsu_chunks_vT/index.json', { laws: { '340AC0000000034': { articles: 1, refs: 1 } } });
  putR2('tsutatsu_chunks_vT/340AC0000000034.json', { 22: [{ src: 'html', no: '2-1-1', cap: '（収益）' }] });
}

let BASE = '';
function run(args, env = {}, out) {
  return new Promise((resolve) => {
    const e = { ...process.env, CASES_WEEKLY_OUT: out, R2_FAKE_DIR: R2DIR, VECTORIZE_FAKE_FILE: VECFILE, AI_FAKE: '1', TSU_PROD_PREFIX: 'tsutatsu_chunks_vT',
      SHITSUGI_CRAWL_BASE: BASE, SAIKETSU_CRAWL_BASE: BASE, SHITSUGI_CRAWL_SLEEP_MS: '0', SAIKETSU_CRAWL_SLEEP_MS: '0', SHITSUGI_CRAWL_RETRY_BASE_MS: '1', SAIKETSU_CRAWL_RETRY_BASE_MS: '1',
      CASES_MIN_PAGES: '3', CASES_VEC_PACE_MS: '0', CASES_VEC_POLL_MS: '0', ...env };
    for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GITHUB_ACTIONS', 'CASES_APPROVED']) if (!(k in env)) delete e[k];
    const p = spawn(process.execPath, [RUN, ...args], { env: e });
    let so = '';
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { so += d; });
    p.on('close', (code) => resolve({ code, out: so }));
  });
}
async function week(stamp, { out = path.join(TMP, `out-${stamp}`), env = {}, apply = true, approve = false } = {}) {
  const c = await run(['crawl'], { CASES_STAMP: stamp, UPDATE_RUN_ID: `run-${stamp}`, ...env }, out);
  const b = c.code === 0 ? await run(['build'], { UPDATE_RUN_ID: `run-${stamp}`, ...env }, out) : null;
  const mf = path.join(out, 'build', 'manifest.json');
  const m = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : null;
  const a = apply && m ? await run(['apply'], { ...(approve ? { CASES_APPROVED: '1' } : {}), ...env }, out) : null;
  return { out, c, b, a, m, report: fs.existsSync(path.join(out, 'build', 'report.md')) ? fs.readFileSync(path.join(out, 'build', 'report.md'), 'utf8') : '' };
}

async function main() {
  {
    // 関係法令通達の注記: <p class="red">注記 のほか <p><strong class="red">注記<br> の形もある（国税庁の実ページ。Issue #201 で 558 件）。
    // どちらでも注記の定型文を関係法令・通達の行に入れない（入ると「令和７年…現在の法令・通達」が通達名として拾われる）
    const { parseCase } = require('../../shitsugi/03_parse.cjs');
    const page = (note) => shCase({ title: '注記の書き方', q: '照会'.repeat(10), a: '回答'.repeat(10), kankei: '　所得税基本通達36・37共-7' }).replace(/<p class="red">注記<br>令和6年7月1日現在の法令・通達等に基づいて作成しています。<\/p>/, note);
    const a = parseCase(page('<p class="red">注記<br>令和6年7月1日現在の法令・通達等に基づいて作成しています。</p>'), { url: 'x' });
    const b = parseCase(page('<p><strong class="red">注記<br>\n　令和７年８月１日現在の法令・通達等に基づいて作成しています。<br>\n　この質疑事例は、照会に係る事実関係を前提とした一般的な回答であり…</strong></p>'), { url: 'x' });
    check('関係法令通達: 注記は <p class="red"> でも <strong class="red"> でも切る（定型文を通達の行にしない）・現在日は読む',
      JSON.stringify(a.kankeiRaw) === '["所得税基本通達36・37共-7"]' && JSON.stringify(b.kankeiRaw) === '["所得税基本通達36・37共-7"]' && a.asOf === '令和6年7月1日' && b.asOf === '令和7年8月1日',
      JSON.stringify({ a: [a.kankeiRaw, a.asOf], b: [b.kankeiRaw, b.asOf] }));
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  resetSite();
  emptyProd();

  console.log('\n# 1. 初回: 全部取り直し → 全部「新しい」（見直す対象）→ 承認で反映');
  let w = await week('20260927', { apply: false });
  check('crawl・build が通る', w.c.code === 0 && w.b && w.b.code === 0, (w.c.out + (w.b ? w.b.out : '')).slice(-2500));
  check('基準（写し）を R2 に置いた（事例・裁決とも）', readR2J('update_state/cases/shitsugi/current.json') && readR2J('update_state/cases/saiketsu/current.json'));
  check('事例 2・裁決 2 が「新しい」・初回は見直す対象', w.m && w.m.counts['質疑応答事例'].added === 2 && w.m.counts['裁決'].added === 2 && w.m.first_run && w.m.needs_review, JSON.stringify(w.m && { c: w.m.counts, rv: w.m.review }));
  check('条文リンク（関係法令欄・要旨から）ができる', w.m && w.m.links.now >= 4, JSON.stringify(w.m && w.m.links));
  check('ベクトル: 事例 2（要旨）・裁決 2 の要旨＋節を埋め込む', w.m && w.m.vectors.upsert >= 6, JSON.stringify(w.m && w.m.vectors));
  let r = await run(['apply'], {}, w.out);
  check('承認なし → 反映しない', r.code === 1 && /反映」コメントからしか/.test(r.out), r.out.slice(-400));
  r = await run(['apply'], { CASES_APPROVED: '1' }, w.out);
  check('承認で反映する', r.code === 0, r.out.slice(-1500));
  const shIdx = readR2J('shitsugi_v1/index.json'), saIdx = readR2J('saiketsu_v1/index.json');
  check('事例・裁決の索引とチャンクが入る', shIdx['hojin/01/01'] && shIdx['hojin/01/02'] && saIdx['141-01'] && readR2J('shitsugi_v1/cases_hojin.json')['hojin/01/01'].kaito && readR2J('saiketsu_v1/cases_141.json')['141-02'].abstract, JSON.stringify({ shIdx, saIdx }));
  const al34 = readR2J('article_links_v1/340AC0000000034.json');
  check('条文 → 事例・裁決の索引（法人税法 34 条に事例と裁決）', al34 && al34['34'] && al34['34'].some((e) => e.i === 'hojin/01/01' && e.k === 'j') && al34['34'].some((e) => e.i === '141-01' && e.k === 's'), JSON.stringify(al34));
  check('_cases.json に事例・裁決のメタ', (readR2J('article_links_v1/_cases.json') || {})['hojin/01/01'].k === 'j');
  const db1 = vecDb();
  const shVec = db1[md5('shitsugi:hojin/01/01')];
  check('事例のベクトル（_shitsugi・homes に法人税法第三十四条）', shVec && shVec.namespace === '_shitsugi' && /第三十四条/.test(shVec.metadata.homes), JSON.stringify(shVec && shVec.metadata));
  check('裁決の要旨・節のベクトル（_saiketsu）', db1[md5('saiketsu:141-01#abst')] && db1[md5('saiketsu:141-01#s0')] && db1[md5('saiketsu:141-01#abst')].namespace === '_saiketsu');

  console.log('\n# 2. 変わらない週: 全部 304 → 何もしない回');
  const hitsBefore = { ...hits };
  w = await week('20261004');
  check('何もしない回（nothing_to_do）', w.m && w.m.nothing_to_do && w.a && /反映するものが無い/.test(w.a.out), JSON.stringify(w.m && { f: Object.keys(w.m.files), v: w.m.vectors, rv: w.m.review }) + (w.b ? w.b.out.slice(-800) : ''));
  check('ページは 304（事例 1 件目を取り直していない）', (hits['/law/shitsugi/hojin/01/01.htm'] || 0) > (hitsBefore['/law/shitsugi/hojin/01/01.htm'] || 0) && fs.existsSync(path.join(w.out, 'work', 'shitsugi', 'all_shitsugi_20261004', 'law', 'shitsugi', 'hojin', '01', '01.htm')));

  console.log('\n# 2b. 本番はあるが状態の控えが無い（PC で作った今の本番と同じ）: 本番のレコードから本文を組み立て直す → 埋め込み直さない');
  fs.rmSync(rk('update_state/cases/vec_state.json'), { force: true });
  w = await week('20261005', { apply: false });
  check('初回扱い（見直す対象）だが、埋め込み直し・metadata の差し替え・削除は 0（本番の本文・homes から組み立て直せる）', w.m && w.m.first_run && w.m.needs_review && w.m.vectors.upsert === 0 && w.m.vectors.meta_update === 0 && w.m.vectors.delete === 0 && !Object.keys(w.m.files).length, JSON.stringify(w.m && { v: w.m.vectors, f: Object.keys(w.m.files) }));
  r = await run(['apply'], { CASES_APPROVED: '1' }, w.out);
  check('承認で反映 → 状態の控えができる', r.code === 0 && readR2J('update_state/cases/vec_state.json'), r.out.slice(-500));

  console.log('\n# 3. LLM の割当は引き継ぐ');
  const al22 = readR2J('article_links_v1/340AC0000000034.json');
  al22['66'] = [{ i: 'hojin/01/02', k: 'j', s: 'llm', c: 'mid' }];
  putR2('article_links_v1/340AC0000000034.json', al22);
  w = await week('20261011');
  check('本番の LLM の割当（66 条）は消さない・何もしない回のまま', w.m && w.m.links.llm_carried === 1 && !Object.keys(w.m.files).some((k) => k.startsWith('article_links_v1/340AC')), JSON.stringify(w.m && { l: w.m.links, f: Object.keys(w.m.files), rv: w.m.review }));

  console.log('\n# 4. 回答が変わった事例 1 件: 見直す対象なし → 自動で反映');
  site['/law/shitsugi/hojin/01/01.htm'] = shCase({ title: '役員給与の損金算入', q: '役員に支給した給与の取扱いを教えてください。'.repeat(3), a: '定期同額給与・事前確定届出給与に該当するものは損金の額に算入されます（改正）。'.repeat(3), kankei: '法人税法第34条第1項' });
  w = await week('20261018');
  check('変わった 1 件・チャンクだけ書く・見直す対象なし', w.m && w.m.counts['質疑応答事例'].changed === 1 && !w.m.needs_review && Object.keys(w.m.files).join() === 'shitsugi_v1/cases_hojin.json', JSON.stringify(w.m && { c: w.m.counts, f: Object.keys(w.m.files), rv: w.m.review }));
  check('本文が変わったベクトルを埋め込み直す（why text）', w.m && w.m.vectors.upsert === 1 && w.m.vectors.upsert_text === 1, JSON.stringify(w.m && w.m.vectors));
  {
    const d = w.m && w.m.changed_breakdown && w.m.changed_breakdown['質疑応答事例'];
    check('下見の報告に変わったレコードの内訳（項目ごと・空白だけの違い・例）', !!d && d.fields.kaito === 1 && d.space_only === 0 && d.examples.length === 1 && d.examples[0].id === 'hojin/01/01' && /改正/.test(d.examples[0].after), JSON.stringify(d));
  }
  {
    const { diffBreakdown } = require('./build.cjs');
    const d = diffBreakdown(['a', 'b'], { a: { t: 'x\n        y', n: 1 }, b: { t: 'p', q: 'r' } }, { a: { t: 'x\ny', n: 1 }, b: { t: 'p2', q: 'r' } });
    check('内訳: 空白だけの違いを数える・項目ごとの件数', d.space_only === 1 && d.fields.t === 2 && !d.fields.n && d.examples.length === 2, JSON.stringify(d));
  }
  check('自動で反映（承認なし）', w.a && w.a.code === 0 && /改正/.test(readR2J('shitsugi_v1/cases_hojin.json')['hojin/01/01'].kaito), w.a && w.a.out.slice(-800));

  console.log('\n# 5. 新しい事例（画像あり）: 画像を取って R2 に置く・文字起こしは空・見直す対象');
  site['/law/shitsugi/hojin/01.htm'] = site['/law/shitsugi/hojin/01.htm'].replace('</body>', '<a href="/law/shitsugi/hojin/01/03.htm">事例3</a></body>');
  site['/law/shitsugi/hojin/01/03.htm'] = shCase({ title: '減価償却の計算', q: '減価償却費の計算方法を教えてください。'.repeat(3), a: '次の計算式によります。'.repeat(3), kankei: '法人税法第31条第1項', img: '/law/shitsugi/hojin/01/fig.gif' });
  w = await week('20261025', { apply: false });
  check('新しい事例 1・新しい画像 1・見直す対象（画像）', w.m && w.m.counts['質疑応答事例'].added === 1 && w.m.new_images === 1 && w.m.review.some((x) => /新しい画像 1 枚/.test(x)), JSON.stringify(w.m && { c: w.m.counts, rv: w.m.review }));
  const imgKey = 'shitsugi_v1/img/law/shitsugi/hojin/01/fig.gif';
  check('画像を成果物に置く（content_type image/gif）', w.m && w.m.files[imgKey] && w.m.files[imgKey].content_type === 'image/gif');
  r = await run(['apply'], { CASES_APPROVED: '1' }, w.out);
  check('承認で反映 → 画像が R2 に・レコードの画像の text は空', r.code === 0 && readR2(imgKey) && readR2(imgKey).toString() === 'GIF89a-fake-image' && readR2J('shitsugi_v1/cases_hojin.json')['hojin/01/03'].images[0].text === null, r.out.slice(-800));

  console.log('\n# 5b. 画像が取れなかった回を反映しても、翌週また取りに行く（欠けたままにならない）');
  site['/law/shitsugi/hojin/01.htm'] = site['/law/shitsugi/hojin/01.htm'].replace('</body>', '<a href="/law/shitsugi/hojin/01/04.htm">事例4</a></body>');
  site['/law/shitsugi/hojin/01/04.htm'] = shCase({ title: '圧縮記帳', q: '圧縮記帳の計算を教えてください。'.repeat(3), a: '図のとおりです。'.repeat(3), kankei: '法人税法第42条第1項', img: '/law/shitsugi/hojin/01/fig2.gif' });
  w = await week('20261027', { apply: false });   // fig2.gif は偽のサイトに無い（404）
  check('画像が取れない → 見直す対象（翌週また取りに行く）・画像は成果物に無い', w.m && w.m.images_failed === 1 && w.m.review.some((x) => /取れなかった/.test(x)) && !w.m.files['shitsugi_v1/img/law/shitsugi/hojin/01/fig2.gif'], JSON.stringify(w.m && { rv: w.m.review, f: Object.keys(w.m.files) }));
  r = await run(['apply'], { CASES_APPROVED: '1' }, w.out);
  check('　→ 承認で反映（事例は入る・画像は R2 に無い）', r.code === 0 && readR2J('shitsugi_v1/cases_hojin.json')['hojin/01/04'] && !readR2('shitsugi_v1/img/law/shitsugi/hojin/01/fig2.gif'), r.out.slice(-500));
  site['/law/shitsugi/hojin/01/fig2.gif'] = 'GIF89a-fake-image-2';
  w = await week('20261028', { apply: false });
  check('翌週: 本番のレコードに載っていても R2 に無い画像は取りに行く', w.m && w.m.images_fetched === 1 && w.m.files['shitsugi_v1/img/law/shitsugi/hojin/01/fig2.gif'] && !w.m.review.some((x) => /新しい画像/.test(x)), JSON.stringify(w.m && { rv: w.m.review, f: Object.keys(w.m.files), m: w.m.images_fetched }));
  r = await run(['apply'], {}, w.out);
  check('　→ 画像だけの回は見直す対象なしで自動反映・R2 に画像が入る', r.code === 0 && readR2('shitsugi_v1/img/law/shitsugi/hojin/01/fig2.gif') && readR2('shitsugi_v1/img/law/shitsugi/hojin/01/fig2.gif').toString() === 'GIF89a-fake-image-2', r.out.slice(-500));

  console.log('\n# 6. 画像の文字起こしは本番から引き継ぐ（同じパス）');
  const ch = readR2J('shitsugi_v1/cases_hojin.json');
  ch['hojin/01/03'].images[0].text = '償却費＝取得価額×償却率';
  ch['hojin/01/03'].images[0].kind = 'formula';
  putR2('shitsugi_v1/cases_hojin.json', ch);
  w = await week('20261101');
  check('本番の文字起こし（手で入れたもの）を消さない＝何もしない回', w.m && w.m.nothing_to_do, JSON.stringify(w.m && { f: Object.keys(w.m.files), c: w.m.counts }));

  console.log('\n# 6b. 国税庁が同じ URL のまま画像を差し替えた → 退避付きで差し替え・文字起こしは引き継がない・戻せる');
  site['/law/shitsugi/hojin/01/fig.gif'] = 'GIF89a-fake-image-REPLACED';
  w = await week('20261104', { apply: false });
  const fk = w.m && w.m.files[imgKey];
  check('中身が変わった画像を成果物に置く（書く前の hash つき）・見直す対象', w.m && w.m.images_changed === 1 && fk && fk.sha_before && w.m.review.some((x) => /差し替えた画像 1 枚/.test(x)) && !w.m.review.some((x) => /新しい画像/.test(x)), JSON.stringify(w.m && { f: w.m.files, rv: w.m.review }));
  check('　→ その画像の文字起こしは引き継がない（レコードの text・kind が空になる）', w.m && w.m.files['shitsugi_v1/cases_hojin.json'] && (() => { const c = JSON.parse(fs.readFileSync(path.join(w.out, 'build', w.m.files['shitsugi_v1/cases_hojin.json'].local), 'utf8')); return c['hojin/01/03'].images[0].text === null && c['hojin/01/03'].images[0].kind === null; })());
  r = await run(['apply'], { CASES_APPROVED: '1' }, w.out);
  check('　→ 承認で反映: R2 の画像が新しい中身に・本番の文字起こしが空に', r.code === 0 && readR2(imgKey).toString() === 'GIF89a-fake-image-REPLACED' && readR2J('shitsugi_v1/cases_hojin.json')['hojin/01/03'].images[0].text === null, r.out.slice(-600));
  r = await run(['restore', 'run-20261104'], {}, w.out);
  check('　→ restore で前の画像と文字起こしに戻る', r.code === 0 && readR2(imgKey).toString() === 'GIF89a-fake-image' && readR2J('shitsugi_v1/cases_hojin.json')['hojin/01/03'].images[0].text === '償却費＝取得価額×償却率', r.out.slice(-600));
  site['/law/shitsugi/hojin/01/fig.gif'] = 'GIF89a-fake-image';

  console.log('\n# 7. 裁決が 1 件消える: 見直す対象（消える）・条文リンクとベクトルも消える');
  site['/service/MP/03/0101000000.html'] = saMp([{ no: '141', nn: '01', title: '役員給与の額が過大であるとした事例', point: '過大な役員給与の判断。', body: '法人税法第34条第2項に規定する不相当に高額な部分の金額は損金の額に算入されない。'.repeat(2) }]);
  w = await week('20261108', { apply: false });
  check('裁決 1 件が消える → 見直す対象', w.m && w.m.counts['裁決'].removed === 1 && w.m.review.some((x) => /裁決が 1 件消える/.test(x)), JSON.stringify(w.m && { c: w.m.counts, rv: w.m.review }));
  check('消える裁決のベクトル（要旨＋節）を消す', w.m && w.m.vectors.delete >= 2, JSON.stringify(w.m && w.m.vectors));
  const before7 = fs.readdirSync(R2DIR).length;
  r = await run(['apply'], { CASES_APPROVED: '1' }, w.out);
  check('反映 → 裁決の索引から消え、ベクトルも無い', r.code === 0 && !readR2J('saiketsu_v1/index.json')['141-02'] && !vecDb()[md5('saiketsu:141-02#abst')], r.out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 5).join('\n'));
  void before7;
  r = await run(['restore', 'run-20261108'], {}, w.out);
  check('restore で戻る（裁決・ベクトルが戻る）', r.code === 0 && readR2J('saiketsu_v1/index.json')['141-02'] && vecDb()[md5('saiketsu:141-02#abst')], r.out.slice(-600));

  console.log('\n# 8. 止める: 下見の後に新しい取り直し・件数が 1 割超減る');
  site['/service/MP/03/0101000000.html'] = saMp([
    { no: '141', nn: '01', title: '役員給与の額が過大であるとした事例', point: '過大な役員給与の判断。', body: '法人税法第34条第2項に規定する不相当に高額な部分の金額は損金の額に算入されない。'.repeat(2) },
    { no: '141', nn: '02', title: '収益の計上時期を誤ったとした事例', point: '収益計上の時期。', body: '法人税法第22条第2項に規定する収益の額は引渡しの日に計上すべきである（改）。'.repeat(2) },
  ]);
  const w8 = await week('20261115', { apply: false });
  await run(['crawl'], { CASES_STAMP: '20261116', UPDATE_RUN_ID: 'run-20261116' }, path.join(TMP, 'out-newer'));
  r = await run(['apply'], { CASES_APPROVED: '1' }, w8.out);
  check('下見の後に新しい取り直しがある → 古い下見は反映しない', r.code === 1 && /新しい取り直しがある/.test(r.out), r.out.slice(-400));
  delete site['/law/shitsugi/hojin/01/02.htm'];
  delete site['/law/shitsugi/hojin/01/03.htm'];
  w = await week('20261122', { apply: false, env: { CASES_GONE_MIN: '100', CASES_DROP_MIN: '0' } });
  check('事例が 3 → 1（1 割超減る）→ 止める', w.m && !w.m.ok_to_apply && w.m.blockers.some((x) => /質疑応答事例の件数が 1 割超減った/.test(x)), JSON.stringify(w.m && w.m.blockers) + (w.b ? w.b.out.slice(-600) : ''));

  console.log('\n# 9. 同じ日に流し直す: 今回取れなかったページの写しは残さない');
  resetSite();
  emptyProd();
  w = await week('20261201', { approve: true });
  check('（準備）初回を反映', w.a && w.a.code === 0, w.a && w.a.out.slice(-400));
  const o9 = path.join(TMP, 'out-20261202a');
  await run(['crawl'], { CASES_STAMP: '20261202', UPDATE_RUN_ID: 'run-20261202a' }, o9);   // 同じ日の 1 回目（02 はまだある）
  check('（準備）同じ日の 1 回目の写しには 02 がある', fs.existsSync(path.join(o9, 'work', 'shitsugi', 'all_shitsugi_20261202', 'law', 'shitsugi', 'hojin', '01', '02.htm')));
  site['/law/shitsugi/hojin/01.htm'] = site['/law/shitsugi/hojin/01.htm'].replace('<a href="/law/shitsugi/hojin/01/02.htm">事例2</a>', '');
  delete site['/law/shitsugi/hojin/01/02.htm'];
  const o9b = path.join(TMP, 'out-20261202b');
  const c9 = await run(['crawl'], { CASES_STAMP: '20261202', UPDATE_RUN_ID: 'run-20261202b' }, o9b);
  const snap9 = path.join(o9b, 'work', 'shitsugi', 'all_shitsugi_20261202', 'law', 'shitsugi', 'hojin', '01');
  check('同じ日の 2 回目: 戻した写しにあった消えたページ（02）は今回の写しに無い・01 はある', c9.code === 0 && fs.existsSync(path.join(snap9, '01.htm')) && !fs.existsSync(path.join(snap9, '02.htm')), c9.out.slice(-600));
  const b9 = await run(['build'], { UPDATE_RUN_ID: 'run-20261202b' }, o9b);
  const m9 = JSON.parse(fs.readFileSync(path.join(o9b, 'build', 'manifest.json'), 'utf8'));
  check('　→ 下見でも事例 02 は消える（台帳とそろう）', b9.code === 0 && m9.counts['質疑応答事例'].removed === 1 && m9.records['質疑応答事例'].removed.includes('hojin/01/02'), JSON.stringify(m9.counts));

  console.log('\n# 10. 最後の 1 件が消えたチャンクに、後で事例が戻る');
  resetSite();
  site['/service/MP/03/0101000000.html'] = saMp([
    { no: '141', nn: '01', title: '役員給与の額が過大であるとした事例', point: '過大な役員給与の判断。', body: '法人税法第34条第2項に規定する不相当に高額な部分の金額は損金の額に算入されない。'.repeat(2) },
    { no: '142', nn: '01', title: '寄附金の損金不算入とした事例', point: '寄附金の判断。', body: '法人税法第37条第1項に規定する寄附金の額は損金の額に算入されない。'.repeat(2) },
  ]);
  site['/service/JP/142/01/index.html'] = saJp({ no: '142', title: '寄附金事件 裁決事例集No.142', facts: '請求人は取引先に金銭を贈与した。'.repeat(5), judge: '寄附金に当たると判断する。'.repeat(5) });
  w = await week('20261206', { approve: true });
  check('（準備）142 号の裁決が入る', w.a && w.a.code === 0 && readR2J('saiketsu_v1/cases_142.json')['142-01'], w.a && w.a.out.slice(-400));
  site['/service/MP/03/0101000000.html'] = saMp([{ no: '141', nn: '01', title: '役員給与の額が過大であるとした事例', point: '過大な役員給与の判断。', body: '法人税法第34条第2項に規定する不相当に高額な部分の金額は損金の額に算入されない。'.repeat(2) }]);
  w = await week('20261213', { approve: true });
  check('142 号の最後の 1 件が消える → チャンクは {}・索引から外れる', w.a && w.a.code === 0 && JSON.stringify(readR2J('saiketsu_v1/cases_142.json')) === '{}' && !readR2J('saiketsu_v1/index.json')['142-01'], w.a && w.a.out.slice(-400));
  site['/service/MP/03/0101000000.html'] = saMp([
    { no: '141', nn: '01', title: '役員給与の額が過大であるとした事例', point: '過大な役員給与の判断。', body: '法人税法第34条第2項に規定する不相当に高額な部分の金額は損金の額に算入されない。'.repeat(2) },
    { no: '142', nn: '01', title: '寄附金の損金不算入とした事例', point: '寄附金の判断。', body: '法人税法第37条第1項に規定する寄附金の額は損金の額に算入されない。'.repeat(2) },
  ]);
  w = await week('20261220', { approve: true });
  check('同じチャンクに戻る → 本番の実物（{}）を書く前として控え、反映できる', w.m && w.m.files['saiketsu_v1/cases_142.json'] && w.m.files['saiketsu_v1/cases_142.json'].sha_before && w.a && w.a.code === 0 && readR2J('saiketsu_v1/cases_142.json')['142-01'], (w.a && w.a.out.slice(-500)) + JSON.stringify(w.m && w.m.files['saiketsu_v1/cases_142.json']));

  console.log('\n# 11. 通達のチャンクが読めない → 下見を止める（条文リンクを消す下見を作らない）');
  fs.rmSync(rk('tsutatsu_chunks_vT/340AC0000000034.json'), { force: true });
  w = await week('20261227', { apply: false });
  check('通達のチャンクが欠けている → build が落ちる（成果物なし）', w.b && w.b.code === 1 && !w.m && /通達 tsutatsu_chunks_vT\/340AC0000000034\.json が無い/.test(w.b.out), w.b && w.b.out.slice(-500));

  console.log('\n# 12. 下見の途中・下見の後に戻しが入る → その下見は使わない（読んだ本番と今の本番が食い違う）');
  putR2('tsutatsu_chunks_vT/340AC0000000034.json', { 22: [{ src: 'html', no: '2-1-1', cap: '（収益）' }] });
  const restoreCmd = `"${process.execPath}" "${RUN}" restore run-20261220`;
  w = await week('20261228', { apply: false, env: { CASES_TEST_MID_BUILD: restoreCmd } });
  check('下見の途中に戻しが入る → build が落ちる（成果物なし）・戻しは済んでいる', w.b && w.b.code === 1 && !w.m && /下見の途中で反映か戻しが入った/.test(w.b.out) && JSON.stringify(readR2J('saiketsu_v1/cases_142.json')) === '{}', w.b && w.b.out.slice(-800));
  w = await week('20261229', { apply: false });
  check('（準備）流し直した下見は通る（142 号を戻す）', w.m && w.m.ok_to_apply && w.m.gen_sha_before, JSON.stringify(w.m && w.m.blockers));
  r = await run(['restore', 'run-20261220'], {}, w.out);   // 同じ回の戻しをもう一度（本番は変わらないが、世代は進む）
  r = await run(['apply'], { CASES_APPROVED: '1' }, w.out);
  check('下見の後に戻しが入る → 反映しない（書かずに止める）', r.code !== 0 && /この下見の後に別の反映か戻しが入った/.test(r.out) && JSON.stringify(readR2J('saiketsu_v1/cases_142.json')) === '{}' && !readR2J('update_state/cases_apply_inprogress.json'), r.out.slice(-600));

  console.log('\n# 13. 裁決の本文のページだけ取れない（要旨は取れた）→ 本文と節のベクトルは本番のまま・見直す対象');
  const jp01 = site['/service/JP/141/01/index.html'];
  delete site['/service/JP/141/01/index.html'];
  const secIds = Object.keys(vecDb()).filter((id) => vecDb()[id].namespace === '_saiketsu' && vecDb()[id].metadata && vecDb()[id].metadata.sid === '141-01');
  w = await week('20261230', { apply: false });
  check('本文があった裁決の本文を消さない（ファイルもベクトルも変わらない）・見直す対象', w.m && w.m.review.some((x) => /本文（全文）があった裁決 1 件.*141-01/.test(x)) && !w.m.files['saiketsu_v1/cases_141.json'] && w.m.vectors.delete === 0, JSON.stringify(w.m && { f: Object.keys(w.m.files), v: w.m.vectors, rv: w.m.review }) + (w.b ? w.b.out.slice(-600) : ''));
  check('　（準備）141-01 には節のベクトルがある', secIds.length >= 1, secIds.join(','));
  site['/service/JP/141/01/index.html'] = jp01;

  console.log('\n# 14. 反映・戻しが下見の途中で始まる／条文リンクの元の通達が変わる → その下見は使わない');
  const nodeW = (key, obj) => `"${process.execPath}" -e "const p=require('path'),f=p.join(process.env.R2_FAKE_DIR,...'${key}'.split('/'));require('fs').mkdirSync(p.dirname(f),{recursive:true});require('fs').writeFileSync(f,Buffer.from('${Buffer.from(JSON.stringify(obj)).toString('base64')}','base64'))"`;
  w = await week('20261231', { apply: false, env: { CASES_TEST_MID_BUILD: nodeW('update_state/cases_apply_inprogress.json', { run_id: 'x', token: 't', kind: 'restore', phase: 'restore' }) } });
  check('下見の途中で事例・裁決の戻しが始まった（印が現れた。世代はまだ進んでいない）→ build が落ちる', w.b && w.b.code === 1 && !w.m && /下見の途中で反映か戻しが始まった/.test(w.b.out), w.b && w.b.out.slice(-500));
  fs.rmSync(rk('update_state/cases_apply_inprogress.json'), { force: true });
  w = await week('20270101', { apply: false, env: { CASES_TEST_MID_BUILD: nodeW('update_state/tsutatsu_apply_gen.json', { run_id: 't1' }) } });
  check('下見の途中で通達の反映が入った（通達の世代が進んだ）→ build が落ちる', w.b && w.b.code === 1 && !w.m && /tsutatsu_apply_gen\.json が変わった/.test(w.b.out), w.b && w.b.out.slice(-500));
  w = await week('20270102', { apply: false });
  check('（準備）下見に通達の版と世代を残す', w.m && w.m.deps && w.m.deps.tsutatsu && w.m.deps.tsutatsu.prefix === 'tsutatsu_chunks_vT' && w.m.deps.tsutatsu.gen_sha, JSON.stringify(w.m && w.m.deps));
  putR2('update_state/tsutatsu_apply_gen.json', { run_id: 't2' });
  r = await run(['apply'], { CASES_APPROVED: '1' }, w.out);
  check('下見の後に通達の反映が入った → 反映しない（何も書かない・印を残さない）', r.code !== 0 && /下見の後に通達の反映か戻しが入った/.test(r.out) && !readR2J('update_state/cases_apply_inprogress.json'), r.out.slice(-500));
  putR2('update_state/tsutatsu_apply_inprogress.json', { run_id: 't3', token: 'x', kind: 'apply', phase: 'writing' });
  w = await week('20270103', { apply: false });
  check('通達の反映中の印が残っている → 下見は止める（exit 3）', w.b && w.b.code === 3 && w.m && w.m.blockers.some((x) => /通達の反映（run t3・writing）が途中で止まっている/.test(x)), JSON.stringify(w.m && w.m.blockers));
  fs.rmSync(rk('update_state/tsutatsu_apply_inprogress.json'), { force: true });

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
