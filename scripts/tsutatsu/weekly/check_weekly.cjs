// 通達の週次 段 2（scripts/tsutatsu/weekly/run.cjs crawl）の確かめ。¥0・国税庁に要求を出さない。
//
//   node scripts/tsutatsu/weekly/check_weekly.cjs
//
// 手元に偽の国税庁（ETag を見て 304 を返す）を立て、R2 は R2_FAKE_DIR。毎回まっさらな作業フォルダ（Actions の新しい runner と同じ）で流し、
// 前回の写しが R2 から戻って 304 で引き継がれること・変更の一覧・止める条件・基準の 2 世代・壊れた写しで止まることを見る。
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
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).slice(0, 1500)}` : ''}`); }
}

// ---------------------------------------------------------------- 偽の国税庁
const H = '/law/tsutatsu/kihon/hojin/';
let site = {};
function resetSite() {
  site = {
    '/law/tsutatsu/menu.htm': `<html><head><title>法令解釈通達</title></head><body><a href="${H}01.htm">法人税</a></body></html>`,
    [`${H}01.htm`]: `<html><head><title>法人税基本通達 目次</title></head><body><a href="02.htm">第1章</a> <a href="03.htm">第2章</a> <a href="04.htm">第3章</a> <a href="${H}a.pdf">別表</a> <a href="${H}b.pdf">様式</a></body></html>`,
    [`${H}02.htm`]: '<html><head><title>第1章 1-1-1</title></head><body>本文 その1</body></html>',
    [`${H}03.htm`]: '<html><head><title>第2章 2-1-1</title></head><body>本文 その2</body></html>',
    [`${H}04.htm`]: '<html><head><title>第3章 3-1-1</title></head><body>本文 その3</body></html>',
    [`${H}a.pdf`]: '%PDF-1.4 fake pdf a',
    [`${H}b.pdf`]: '%PDF-1.4 fake pdf b',
  };
}
let failPaths = new Set();
const etagOf = (b) => `"${crypto.createHash('md5').update(b).digest('hex')}"`;
let hits = {};
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  hits[u] = hits[u] || { c200: 0, c304: 0 };
  if (failPaths.has(u)) { res.writeHead(500); res.end(); return; }
  let body = site[u];
  // 01 の他の種（所得税・相続税…）は中身の無い目次として返す（取れればよい）
  if (body === undefined && /^\/law\/tsutatsu\/.+\.htm$/.test(u) && !u.startsWith(H)) body = '<html><head><title>目次</title></head><body></body></html>';
  if (body === undefined) { res.writeHead(404); res.end(); return; }
  const et = etagOf(body);
  if (req.headers['if-none-match'] === et) { hits[u].c304++; res.writeHead(304, { ETag: et }); res.end(); return; }
  hits[u].c200++;
  res.writeHead(200, { 'Content-Type': u.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8', ETag: et });
  res.end(body);
});

// ---------------------------------------------------------------- 流す
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tsu-weekly-'));
const R2DIR = path.join(TMP, 'r2');
let BASE = '';
// out: 報告と作業フォルダ（run.cjs が out/work を毎回空にする）。既定は回ごとにまっさら（Actions の新しい runner と同じ）
function run(stamp, extraEnv = {}, outDir = null) {
  const out = outDir || path.join(TMP, `out-${stamp}-${Math.random().toString(36).slice(2, 6)}`);
  const root = path.join(out, 'work');
  hits = {};
  return new Promise((resolve) => {
    const env = { ...process.env, TSU_WEEKLY_OUT: out, TSU_STAMP: stamp, TSU_CRAWL_BASE: BASE, TSU_CRAWL_SLEEP_MS: '0',
      TSU_CRAWL_RETRY_BASE_MS: '1', TSU_MIN_PAGES: '3', TSU_PART_BYTES: '600', R2_FAKE_DIR: R2DIR, UPDATE_RUN_ID: `run-${stamp}`, ...extraEnv };
    delete env.CLOUDFLARE_API_TOKEN; delete env.CLOUDFLARE_ACCOUNT_ID;
    const p = spawn(process.execPath, [RUN, 'crawl'], { env });
    let so = '';
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { so += d; });
    p.on('close', (code) => {
      const sum = fs.existsSync(path.join(out, 'summary.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')) : null;
      const report = fs.existsSync(path.join(out, 'report.md')) ? fs.readFileSync(path.join(out, 'report.md'), 'utf8') : '';
      resolve({ code, out: so, sum, report, root });
    });
  });
}
const current = () => { const f = path.join(R2DIR, 'update_state', 'tsutatsu', 'current.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const partExists = (key) => fs.existsSync(path.join(R2DIR, ...key.split('/')));
const urls = (arr) => arr.map((x) => new URL(x.url).pathname).sort().join(',');

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  resetSite();

  console.log('\n# 1 回目（初回。基準が無い。作業フォルダに古い取得結果が残っていても使わない）');
  const stale = path.join(TMP, 'out-stale');
  const staleState = path.join(stale, 'work', 'scripts', 'tsutatsu', 'state');
  fs.mkdirSync(path.join(stale, 'work', 'all_tsutatsu_20260901', 'kihon', 'hojin'), { recursive: true });
  fs.mkdirSync(staleState, { recursive: true });
  fs.writeFileSync(path.join(stale, 'work', 'all_tsutatsu_20260901', 'kihon', 'hojin', '02.htm'), '古い写し');
  fs.writeFileSync(path.join(staleState, 'crawl_ledger.json'), JSON.stringify({ [`${BASE}${H}02.htm`]: { content_hash: 'x', etag: etagOf(site[`${H}02.htm`]), local_path: 'all_tsutatsu_20260901/kihon/hojin/02.htm' } }));
  fs.writeFileSync(path.join(staleState, 'manifest_20260901.ndjson'), JSON.stringify({ url: `${BASE}${H}03.htm`, local_path: 'x', content_hash: 'x' }) + '\n');
  let r = await run('20260901', {}, stale);
  check('初回は手元の古い台帳・manifest を使わず全件を取った（304 なし・レジュームなし）', Object.values(hits).every((h) => h.c304 === 0) && hits[`${H}02.htm`] && hits[`${H}02.htm`].c200 === 1 && hits[`${H}03.htm`] && hits[`${H}03.htm`].c200 === 1, JSON.stringify(hits));
  check('終了コード 0', r.code === 0, r.out);
  check('初回として全件を取った（ページ 5 以上・PDF 2）', r.sum && r.sum.first_run && r.sum.counts.pages >= 5 && r.sum.counts.pdfs === 2, JSON.stringify(r.sum && r.sum.counts));
  check('基準を R2 に置いた（分割して複数の part）', r.sum && r.sum.saved && current() && current().parts.length > 1 && current().stamp === '20260901');
  check('初回は変更の一覧を出さない', /初回: 前回の写しが無いので/.test(r.report) && !/## 新しいページ/.test(r.report));
  const gen1 = current();

  console.log('\n# 2 回目（まっさらな作業フォルダ・ページを 1 つ変え、1 つ足し、1 つ消す・PDF を 1 つ変える）');
  site[`${H}03.htm`] = '<html><head><title>第2章 2-1-1</title></head><body>本文 その2（改正）</body></html>';
  site[`${H}01.htm`] = site[`${H}01.htm`].replace('<a href="04.htm">第3章</a>', '<a href="05.htm">第4章</a>');
  delete site[`${H}04.htm`];
  site[`${H}05.htm`] = '<html><head><title>第4章 4-1-1</title></head><body>本文 その4</body></html>';
  site[`${H}b.pdf`] = '%PDF-1.4 fake pdf b (改正)';
  r = await run('20260908');
  check('終了コード 0', r.code === 0, r.out);
  check('前回の写しを R2 から戻し、変わっていないページは 304 で引き継いだ', hits[`${H}02.htm`] && hits[`${H}02.htm`].c304 === 1 && hits[`${H}02.htm`].c200 === 0, JSON.stringify(hits));
  check('変わっていない PDF も 304', hits[`${H}a.pdf`] && hits[`${H}a.pdf`].c304 === 1 && hits[`${H}a.pdf`].c200 === 0);
  check('新しいページ', r.sum && urls(r.sum.html.added) === `${H}05.htm`, JSON.stringify(r.sum && r.sum.html));
  check('変わったページ（目次と本文）', r.sum && urls(r.sum.html.changed) === [`${H}01.htm`, `${H}03.htm`].sort().join(','));
  check('消えたページ', r.sum && urls(r.sum.html.gone) === `${H}04.htm`);
  check('変わった PDF', r.sum && urls(r.sum.pdf.changed) === `${H}b.pdf` && !r.sum.pdf.added.length && !r.sum.pdf.gone.length);
  check('報告に一覧が出る（題名つき）', /## 変わったページ（2）/.test(r.report) && /第2章 2-1-1/.test(r.report) && /## 消えたページ（1）/.test(r.report));
  check('基準を今回に切り替え、前回の分は戻し用に残す', current().stamp === '20260908' && current().previous && current().previous.run_id === gen1.run_id && gen1.parts.every((p) => partExists(p.key)));
  check('写しの中身: 304 で引き継いだページも今回のスナップショットに入っている', fs.existsSync(path.join(r.root, 'all_tsutatsu_20260908', 'kihon', 'hojin', '02.htm')));
  const gen2 = current();

  console.log('\n# 3 回目（変更なし）');
  r = await run('20260915');
  check('終了コード 0・変わったもの 0', r.code === 0 && r.sum && r.sum.changed_total === 0, r.out);
  check('全部 304（国税庁から本文を取り直さない）', Object.entries(hits).filter(([u]) => u.startsWith(H)).every(([, h]) => h.c200 === 0), JSON.stringify(hits));
  check('2 世代前（1 回目）の写しを消した・前回（2 回目）は残す', gen1.parts.every((p) => !partExists(p.key)) && gen2.parts.every((p) => partExists(p.key)) && current().stamp === '20260915');
  const gen3 = current();

  console.log('\n# 4 回目（取れないページが多い → 止める）');
  failPaths = new Set([`${H}02.htm`, `${H}03.htm`, `${H}05.htm`]);
  r = await run('20260922', { TSU_FAIL_MIN: '1', TSU_GONE_MIN: '1' });
  failPaths = new Set();
  check('止めた（終了コード 3）', r.code === 3, r.out.slice(-800));
  check('理由: 消えたページが多い／取れなかった', r.sum && r.sum.blockers.length > 0, JSON.stringify(r.sum && r.sum.blockers));
  check('基準は書き換えない', current().run_id === gen3.run_id);
  check('報告に「止めた理由」', /## 止めた理由/.test(r.report) && /基準の更新: していない/.test(r.report));

  console.log('\n# 5 回目（種のページ＝目次が取れない → 止める）');
  failPaths = new Set(['/law/tsutatsu/menu.htm']);
  r = await run('20260923');
  failPaths = new Set();
  check('止めた（種のページ）', r.code === 3 && r.sum && r.sum.blockers.some((b) => /種のページ/.test(b)), JSON.stringify(r.sum && r.sum.blockers));
  check('基準は書き換えない', current().run_id === gen3.run_id);

  console.log('\n# 5b 回目（04 がシグナルで落ちた＝メモリ不足の SIGKILL の代わり → 止める）');
  const killer = path.join(TMP, 'kill04.cjs');
  fs.writeFileSync(killer, "if (require('path').basename(process.argv[1] || '') === '04_fetch_pdfs.cjs') process.kill(process.pid, 'SIGKILL');\n");
  r = await run('20260924', { NODE_OPTIONS: `--require ${killer}` });
  check('止めた（04 が落ちた・シグナルを成功扱いしない）', r.code === 3 && r.sum && r.sum.blockers.some((b) => /04_fetch_pdfs が落ちた（exit signal SIGKILL）/.test(b)), JSON.stringify(r.sum && r.sum.blockers) + r.out.slice(-300));
  check('基準は書き換えない', current().run_id === gen3.run_id);

  console.log('\n# 6 回目（R2 の写しが壊れている → 取り直さずに落ちる）');
  const p0 = path.join(R2DIR, ...gen3.parts[0].key.split('/'));
  const saved = fs.readFileSync(p0);
  // 最後の 1 バイトを必ず別の値にする（'x' を書くと、元が 'x' のとき壊れず 1/256 で確かめが外れていた）
  fs.writeFileSync(p0, Buffer.concat([saved.subarray(0, saved.length - 1), Buffer.from([saved[saved.length - 1] ^ 0xff])]));
  r = await run('20260929');
  check('壊れた写しで落ちる（終了コード 1・国税庁に取りに行かない）', r.code === 1 && /壊れている/.test(r.out) && !Object.keys(hits).length, r.out.slice(-600));
  fs.writeFileSync(p0, saved);
  check('基準は書き換えない', current().run_id === gen3.run_id);

  console.log('\n# 7 回目（同じ日・同じ run_id でもう一度）');
  r = await run('20260915');
  check('同じ日でも流れる（前回と同じ日付のスナップショットに上書き）', r.code === 0 && r.sum && r.sum.changed_total === 0 && current().stamp === '20260915', r.out.slice(-800));
  const c7 = current();
  check('同じ run_id でも世代の置き場は別（今と前回の part が重ならない）', c7.run_id === gen3.run_id && c7.gen !== gen3.gen && c7.parts.every((p) => !gen3.parts.some((q) => q.key === p.key)));
  check('今の基準と前回（戻し用）の part が全部残っている', c7.parts.every((p) => partExists(p.key)) && c7.previous.parts.every((p) => partExists(p.key)));
  r = await run('20260915');
  const c8 = current();
  check('さらにもう一度: 今と前回は残し、2 世代前だけ消す', c8.parts.every((p) => partExists(p.key)) && c8.previous.parts.every((p) => partExists(p.key)) && c7.previous.parts.every((p) => !partExists(p.key)));

  console.log('\n# 7b 回目（同じ日にもう一度・その間にページが 1 つ消えた）');
  site[`${H}01.htm`] = site[`${H}01.htm`].replace('<a href="02.htm">第1章</a>', '');
  delete site[`${H}02.htm`];
  r = await run('20260915');
  check('戻した今日の写しに残っていた消えたページ（02）は、今回の写しから外す', r.code === 0 && !fs.existsSync(path.join(r.root, 'all_tsutatsu_20260915', 'kihon', 'hojin', '02.htm')) && fs.existsSync(path.join(r.root, 'all_tsutatsu_20260915', 'kihon', 'hojin', '03.htm')), r.out.slice(-600));
  check('　→ 台帳でも消えたページ', r.sum && urls(r.sum.html.gone) === `${H}02.htm`, JSON.stringify(r.sum && r.sum.html));

  console.log('\n# 小さな関数');
  const { jstStamp } = require(RUN);
  check('JST の日付（UTC 15:00 以降は翌日）', /^\d{8}$/.test(jstStamp()));

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
