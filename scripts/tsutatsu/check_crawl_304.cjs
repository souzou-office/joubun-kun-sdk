// 01_crawl / 04_fetch_pdfs の 304 引き継ぎの確かめ（¥0・国税庁に要求を出さない）
//
//   node scripts/tsutatsu/check_crawl_304.cjs
//
// 手元に偽の国税庁（ETag を見て 304 を返す）を立て、一時フォルダに 01・04 を写して流す。
//   1 回目: 台帳なしで全件取得
//   2 回目: 全部 304 → 前回の写しがコピーされ、下のページと PDF まで辿れること
//   3 回目: 1 ページだけ変更・直前の写しを 1 つ壊す → 変更は取り直し、壊れた写しはそれより前の合う写しから引き継ぐ
//   4 回目: 写しを全部壊す → 条件なしで取り直すこと

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const P = '/law/tsutatsu/kihon/hojin/';
const pages = {
  [`${P}01.htm`]: '<html><head><title>法人税基本通達 目次</title></head><body><a href="02.htm">第1章</a> <a href="/law/tsutatsu/kihon/hojin/a.pdf">別表</a></body></html>',
  [`${P}02.htm`]: '<html><head><title>第1章</title></head><body><a href="03.htm">1-1-1</a></body></html>',
  [`${P}03.htm`]: '<html><head><title>1-1-1</title></head><body>本文 その1</body></html>',
  [`${P}a.pdf`]: '%PDF-1.4 fake pdf body',
};
const etagOf = (b) => `"${crypto.createHash('md5').update(b).digest('hex')}"`;
const hits = {};

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const body = pages[u];
  hits[u] = hits[u] || { c200: 0, c304: 0 };
  if (body === undefined) { res.writeHead(404); res.end(); return; }
  const et = etagOf(body);
  if (req.headers['if-none-match'] === et) { hits[u].c304++; res.writeHead(304, { ETag: et }); res.end(); return; }
  hits[u].c200++;
  const type = u.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type, ETag: et });
  res.end(body);
});

let ok = true;
function check(cond, msg) { console.log(`${cond ? 'OK ' : 'NG '} ${msg}`); if (!cond) ok = false; }

function run(root, script, args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, 'scripts', 'tsutatsu', script), ...args], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl304-'));
  fs.mkdirSync(path.join(root, 'scripts', 'tsutatsu'), { recursive: true });
  for (const f of ['01_crawl.cjs', '04_fetch_pdfs.cjs']) fs.copyFileSync(path.join(__dirname, f), path.join(root, 'scripts', 'tsutatsu', f));
  require('../site_config.cjs').copyInto(path.join(root, 'scripts'));   // 01・04 が読む（クローラの連絡先）
  const env = { TSU_CRAWL_BASE: base, TSU_CRAWL_SLEEP_MS: '0' };
  const snap = (stamp, rel) => path.join(root, `all_tsutatsu_${stamp}`, 'kihon', 'hojin', rel);
  const manifest = (stamp) => fs.readFileSync(path.join(root, 'scripts', 'tsutatsu', 'state', `manifest_${stamp}.ndjson`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reset = () => { for (const k of Object.keys(hits)) delete hits[k]; };
  const crawl = async (stamp) => {
    const a = await run(root, '01_crawl.cjs', ['--only', 'hojin', '--snapshot', stamp], env);
    const b = await run(root, '04_fetch_pdfs.cjs', ['--snapshot', stamp], env);
    if (a.code || b.code) { console.log(a.out, b.out); }
    return { a, b };
  };

  // 1 回目
  await crawl('20260101');
  check(['01.htm', '02.htm', '03.htm', 'a.pdf'].every((f) => fs.existsSync(snap('20260101', f))), '1回目: 3ページと PDF を保存');

  // 2 回目（全部 304）
  reset();
  await crawl('20260108');
  check(['01.htm', '02.htm', '03.htm'].every((f) => hits[`${P}${f}`] && hits[`${P}${f}`].c304 === 1 && hits[`${P}${f}`].c200 === 0), '2回目: 3ページとも 304（本文は取り直していない）');
  check(['01.htm', '02.htm', '03.htm', 'a.pdf'].every((f) => fs.existsSync(snap('20260108', f))), '2回目: 304 でも下のページと PDF が今回のスナップショットにある');
  check(fs.readFileSync(snap('20260108', '03.htm'), 'utf8') === pages[`${P}03.htm`], '2回目: 引き継いだ写しの中身が前回と同じ');
  const m2 = manifest('20260108');
  check(m2.length === 3 && m2.every((r) => r.local_path && r.local_path.startsWith('all_tsutatsu_20260108/')), '2回目: マニフェストに 3 ページとも今回の local_path');
  check(m2.some((r) => (r.pdf_links || []).some((u) => u.endsWith('/a.pdf'))), '2回目: 304 のページからも PDF リンクを拾う（04 の入力）');
  check(hits[`${P}a.pdf`] && hits[`${P}a.pdf`].c304 === 1 && hits[`${P}a.pdf`].c200 === 0, '2回目: PDF も 304');

  // 3 回目: 03 を変更・02 の前回の写しを壊す
  pages[`${P}03.htm`] = pages[`${P}03.htm`].replace('その1', 'その2（改正）');
  fs.writeFileSync(snap('20260108', '02.htm'), '壊れた写し', 'utf8');
  reset();
  const r3 = await crawl('20260115');
  check(hits[`${P}03.htm`].c200 === 1, '3回目: 変更されたページは取り直す');
  check(fs.readFileSync(snap('20260115', '03.htm'), 'utf8').includes('その2'), '3回目: 変更後の本文を保存');
  check(hits[`${P}02.htm`].c304 === 1 && hits[`${P}02.htm`].c200 === 0, '3回目: 直前の写しが壊れていても、それより前の合う写しから引き継ぐ');
  check(fs.readFileSync(snap('20260115', '02.htm'), 'utf8') === pages[`${P}02.htm`], '3回目: 壊れた写しを引き継いでいない');
  check(!/取り直した/.test(r3.a.out), '3回目: 取り直しは 0 件');
  check(fs.existsSync(snap('20260115', 'a.pdf')), '3回目: PDF も今回のスナップショットにある');

  // 4 回目: 02 の写しを全部壊す・PDF の写しを全部消す → 条件なしで取り直す
  for (const st of ['20260101', '20260108', '20260115']) fs.writeFileSync(snap(st, '02.htm'), '壊れた写し', 'utf8');
  for (const st of ['20260101', '20260108', '20260115']) fs.rmSync(snap(st, 'a.pdf'), { force: true });
  reset();
  const r4 = await crawl('20260122');
  check(hits[`${P}02.htm`].c304 === 1 && hits[`${P}02.htm`].c200 === 1, '4回目: 合う写しが無いページは条件なしで取り直す');
  check(fs.readFileSync(snap('20260122', '02.htm'), 'utf8') === pages[`${P}02.htm`], '4回目: 取り直した本文を保存');
  check(fs.existsSync(snap('20260122', '03.htm')), '4回目: 取り直したページの下も辿る');
  check(/取り直した: 1 件/.test(r4.a.out), '4回目: 取り直した件数をログに出す');
  check(hits[`${P}a.pdf`].c200 === 1 && fs.existsSync(snap('20260122', 'a.pdf')), '4回目: 写しの無い PDF も取り直して保存');
  check(/取り直した: 1 件/.test(r4.b.out), '4回目: PDF の取り直し件数をログに出す');

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(ok ? '\nすべて OK' : '\nNG あり');
  process.exit(ok ? 0 : 1);
})();
