// 質疑応答事例・裁決の 01_crawl の 304 引き継ぎの確かめ（¥0・国税庁・国税不服審判所に要求を出さない）
//
//   node scripts/cases/check_crawl_304.cjs
//
// scripts/tsutatsu/check_crawl_304.cjs と同じ。手元に偽のサイト（ETag を見て 304 を返す）を立て、一時フォルダに 01 を写して流す。
//   1 回目: 台帳なしで全件取得
//   2 回目: 全部 304 → 前回の写しがコピーされ、下のページまで辿れること
//   3 回目: 1 ページだけ変更・直前の写しを 1 つ壊す → 変更は取り直し、壊れた写しはそれより前の合う写しから引き継ぐ
//   4 回目: 写しを全部壊す → 条件なしで取り直すこと
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SOURCES = [
  { name: 'shitsugi', env: 'SHITSUGI', only: 'hojin', dir: ['law', 'shitsugi', 'hojin'], P: '/law/shitsugi/hojin/', img: true },
  { name: 'saiketsu', env: 'SAIKETSU', only: 'JP', dir: ['service', 'JP'], P: '/service/JP/', img: false },
];
const etagOf = (b) => `"${crypto.createHash('md5').update(b).digest('hex')}"`;

let ok = true;
function check(cond, msg) { console.log(`${cond ? 'OK ' : 'NG '} ${msg}`); if (!cond) ok = false; }
function run(root, name, args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, 'scripts', name, '01_crawl.cjs'), ...args], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function one(S) {
  console.log(`\n# ${S.name}`);
  const P = S.P;
  const pages = {
    [`${P}01.html`]: `<html><head><title>目次</title></head><body><a href="02.html">第1章</a>${S.img ? '<img src="/law/shitsugi/hojin/fig.gif">' : ''}</body></html>`,
    [`${P}02.html`]: '<html><head><title>第1章</title></head><body><a href="03.html">事例</a></body></html>',
    [`${P}03.html`]: '<html><head><title>事例</title></head><body>本文 その1</body></html>',
  };
  const hits = {};
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    const body = pages[u];
    hits[u] = hits[u] || { c200: 0, c304: 0 };
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    const et = etagOf(body);
    if (req.headers['if-none-match'] === et) { hits[u].c304++; res.writeHead(304, { ETag: et }); res.end(); return; }
    hits[u].c200++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: et });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `crawl304-${S.name}-`));
  fs.mkdirSync(path.join(root, 'scripts', S.name), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', S.name, '01_crawl.cjs'), path.join(root, 'scripts', S.name, '01_crawl.cjs'));
  require('../site_config.cjs').copyInto(path.join(root, 'scripts'));   // 01 が読む（クローラの連絡先）
  const env = { [`${S.env}_CRAWL_BASE`]: base, [`${S.env}_CRAWL_SLEEP_MS`]: '0', [`${S.env}_CRAWL_RETRY_BASE_MS`]: '1' };
  const snap = (stamp, rel) => path.join(root, `all_${S.name}_${stamp}`, ...S.dir, rel);
  const manifest = (stamp) => fs.readFileSync(path.join(root, 'scripts', S.name, 'state', `manifest_${stamp}.ndjson`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reset = () => { for (const k of Object.keys(hits)) delete hits[k]; };
  const crawl = async (stamp) => {
    // 種（目次）は 01 に固定なので、偽のサイトでは種が 404 になる。--only で絞り、偽の目次へは種の代わりに 01.html を先頭に置く
    const a = await run(root, S.name, ['--only', S.only, '--snapshot', stamp], env);
    if (a.code) console.log(a.out);
    return a;
  };
  // 種 URL（本物の目次）を偽のサイトにも置く: 01 の SEEDS のうち --only に合うものを 01.html への入口にする
  const seedSrc = fs.readFileSync(path.join(__dirname, '..', S.name, '01_crawl.cjs'), 'utf8');
  const seeds = [...seedSrc.matchAll(/'(\/[^']+\.html?)'/g)].map((m) => m[1]).filter((u) => u.includes(`/${S.only}/`));
  for (const sd of seeds) if (!pages[sd]) pages[sd] = `<html><head><title>種</title></head><body><a href="${P}01.html">目次</a></body></html>`;

  await crawl('20260101');
  check(['01.html', '02.html', '03.html'].every((f) => fs.existsSync(snap('20260101', f))), '1回目: 3ページを保存');

  reset();
  await crawl('20260108');
  check(['01.html', '02.html', '03.html'].every((f) => hits[`${P}${f}`] && hits[`${P}${f}`].c304 === 1 && hits[`${P}${f}`].c200 === 0), '2回目: 3ページとも 304（本文は取り直していない）');
  check(['01.html', '02.html', '03.html'].every((f) => fs.existsSync(snap('20260108', f))), '2回目: 304 でも下のページが今回のスナップショットにある');
  check(fs.readFileSync(snap('20260108', '03.html'), 'utf8') === pages[`${P}03.html`], '2回目: 引き継いだ写しの中身が前回と同じ');
  const m2 = manifest('20260108').filter((r) => ['01.html', '02.html', '03.html'].some((f) => r.url.endsWith(`${P}${f}`)));
  check(m2.length === 3 && m2.every((r) => r.local_path && r.local_path.startsWith(`all_${S.name}_20260108/`)), '2回目: マニフェストに 3 ページとも今回の local_path');
  if (S.img) check(m2.some((r) => (r.img_links || []).some((u) => u.endsWith('/fig.gif'))), '2回目: 304 のページからも画像のリンクを拾う');

  pages[`${P}03.html`] = pages[`${P}03.html`].replace('その1', 'その2（改正）');
  fs.writeFileSync(snap('20260108', '02.html'), '壊れた写し', 'utf8');
  reset();
  const r3 = await crawl('20260115');
  check(hits[`${P}03.html`].c200 === 1, '3回目: 変更されたページは取り直す');
  check(fs.readFileSync(snap('20260115', '03.html'), 'utf8').includes('その2'), '3回目: 変更後の本文を保存');
  check(hits[`${P}02.html`].c304 === 1 && hits[`${P}02.html`].c200 === 0, '3回目: 直前の写しが壊れていても、それより前の合う写しから引き継ぐ');
  check(fs.readFileSync(snap('20260115', '02.html'), 'utf8') === pages[`${P}02.html`], '3回目: 壊れた写しを引き継いでいない');
  check(!/取り直した/.test(r3.out), '3回目: 取り直しは 0 件');

  for (const st of ['20260101', '20260108', '20260115']) fs.writeFileSync(snap(st, '02.html'), '壊れた写し', 'utf8');
  reset();
  const r4 = await crawl('20260122');
  check(hits[`${P}02.html`].c304 === 1 && hits[`${P}02.html`].c200 === 1, '4回目: 合う写しが無いページは条件なしで取り直す');
  check(fs.readFileSync(snap('20260122', '02.html'), 'utf8') === pages[`${P}02.html`], '4回目: 取り直した本文を保存');
  check(fs.existsSync(snap('20260122', '03.html')), '4回目: 取り直したページの下も辿る');
  check(/取り直した: 1 件/.test(r4.out), '4回目: 取り直した件数をログに出す');

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}

(async () => {
  for (const S of SOURCES) await one(S);
  console.log(ok ? '\nすべて OK' : '\nNG あり');
  process.exit(ok ? 0 : 1);
})();
