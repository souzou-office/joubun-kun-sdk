// 通達の週次更新 段 2: 国税庁の取り直しと変更の検出（docs/tsutatsu_hanrei_weekly.md）。本番のデータには書かない。
//
//   node scripts/tsutatsu/weekly/run.cjs crawl
//   node scripts/tsutatsu/weekly/run.cjs build   （段 3a。crawl の後。今回の写しから作り直して、本番と比べた「反映したら何が変わるか」を出す。書かない。build.cjs）
//   node scripts/tsutatsu/weekly/run.cjs apply   （段 3b。build の成果物を退避付きで本番に書く。Actions からだけ。apply.cjs）
//   node scripts/tsutatsu/weekly/run.cjs restore <run_id>   （段 3b。その回の反映を戻す。apply.cjs）
//
// 流れ:
//   1. 前回の写し（all_tsutatsu_{前回}/ の HTML・PDF と台帳 crawl_ledger.json・pdf_ledger.json）を R2 update_state/tsutatsu/ から戻す
//      （初回は無い。全件を取り直して、それを次からの基準にする）
//   2. 01_crawl（HTML）→ 04_fetch_pdfs（PDF）を今日（JST）のスナップショットで流す。台帳の ETag / Last-Modified で 304 を受け、
//      未変更は前回の写しを引き継ぐ（PR #163）
//   3. 前回の台帳と比べて、新しい・変わった・消えたページと PDF を報告する（report.md・summary.json）
//   4. 取得が健全なら（止める条件に掛からなければ）、今回の写しと台帳を R2 に置いて次の基準にする
//      （update_state/tsutatsu/snapshots/{run_id}/part-NNN に分割して置き、最後に current.json を書き換える。2 世代残す）
//
// 書くのは R2 の update_state/tsutatsu/ だけ（取得の写し）。tsutatsu_chunks_v4 とベクトルには触らない（反映は段 3）。
//
// 止める条件（基準を書き換えず、Issue で知らせる）:
//   - 01 / 04 が落ちた
//   - 種のページ（目次）が取れない
//   - 取れなかったページ・PDF が多い（10 件かつ 2% を超える）
//   - ページ数・PDF 数が前回の 8 割を切る、消えたページ・PDF が多い（20 件かつ 5% を超える）
//   - 初回で取れたページが少なすぎる（TSU_MIN_PAGES。既定 2,000）
//
// 環境変数:
//   TSU_WEEKLY_OUT   報告と作業フォルダの置き場（既定 scripts/tsutatsu/weekly/state/）。取得は毎回その下の work/ を空にしてから、
//                    01・04 を写して行う（リポジトリや PC にある all_tsutatsu_*・台帳・manifest は一切読まない。前回の分は R2 からだけ戻す）
//   TSU_STAMP        スナップショットの日付（既定は今日の JST。確かめ用）
//   TSU_ONLY         01 の --only（確かめ用）
//   TSU_PART_BYTES   R2 に置くときの 1 ファイルの大きさ（既定 100MiB）
//   TSU_MIN_PAGES    初回の最低ページ数（既定 2000）
//   TSU_FAIL_MIN / TSU_GONE_MIN  止める条件の件数の下限（既定 10 / 20。確かめ用に小さくする）
//   UPDATE_RUN_ID    回の印（Actions では run_id-attempt）
//   R2_FAKE_DIR      R2 の代わりにこのフォルダ（scripts/update/lib/r2.cjs）
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { R2 } = require('../../update/lib/r2.cjs');
const { makeSnapshotStore } = require('../../update/lib/snapshot_store.cjs');

const TSU_DIR = path.resolve(__dirname, '..');   // scripts/tsutatsu（01・04 の元）
const OUT = path.resolve(process.env.TSU_WEEKLY_OUT || path.join(__dirname, 'state'));
const WORK_ROOT = path.join(OUT, 'work');         // 取得の作業フォルダ（毎回空にする）
const STATE = path.join(WORK_ROOT, 'scripts', 'tsutatsu', 'state');
const PREFIX = 'update_state/tsutatsu';
const PART_BYTES = Number(process.env.TSU_PART_BYTES || 100 * 1024 * 1024);
const MIN_PAGES = Number(process.env.TSU_MIN_PAGES || 2000);
const FAIL_MIN = Number(process.env.TSU_FAIL_MIN || 10);   // 取れなかった件数の下限（これ以下なら割合を見ない）
const GONE_MIN = Number(process.env.TSU_GONE_MIN || 20);   // 消えた件数の下限
const SEED_PATHS = ['/law/tsutatsu/menu.htm'];   // これが取れない回は全体が崩れている（01 の SEEDS の先頭）

const log = (...a) => console.log(...a);
function jstStamp() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function runId() { return process.env.UPDATE_RUN_ID || `local-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`; }
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function readNdjson(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function runNode(script, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(WORK_ROOT, 'scripts', 'tsutatsu', script), ...args], { stdio: 'inherit', cwd: WORK_ROOT });
    // シグナルで落ちた（SIGKILL など）ときは code が null。0 のときだけ成功にする（null を「流さなかった」と取り違えない）
    p.on('close', (code, signal) => resolve(code === 0 ? 0 : (code == null ? `signal ${signal || '?'}` : code)));
    p.on('error', () => resolve(127));
  });
}

// ---------------------------------------------------------------- R2 の基準（前回の写し。scripts/update/lib/snapshot_store.cjs）
function store(r2) {
  return makeSnapshotStore({ r2, prefix: PREFIX, workRoot: WORK_ROOT, tmpRoot: OUT, partBytes: PART_BYTES, log });
}
const restoreBaseline = (r2) => store(r2).restore();
async function saveBaseline(r2, stamp, rid, prevCur, counts) {
  const rel = [`all_tsutatsu_${stamp}`, 'scripts/tsutatsu/state/crawl_ledger.json', 'scripts/tsutatsu/state/pdf_ledger.json',
    `scripts/tsutatsu/state/manifest_${stamp}.ndjson`, `scripts/tsutatsu/state/pdf_manifest_${stamp}.ndjson`];
  return store(r2).save({ stamp, rid, prevCur, counts, rel });
}

// ---------------------------------------------------------------- 比べる
function diffLedgers(prev, next) {
  const added = [], changed = [], gone = [];
  for (const [u, e] of Object.entries(next)) {
    const p = prev[u];
    if (!p) added.push({ url: u, title: e.title || null });
    else if (p.content_hash && e.content_hash && p.content_hash !== e.content_hash) changed.push({ url: u, title: e.title || p.title || null });
  }
  for (const [u, p] of Object.entries(prev)) if (!next[u]) gone.push({ url: u, title: p.title || null });
  const byUrl = (a, b) => (a.url < b.url ? -1 : 1);
  return { added: added.sort(byUrl), changed: changed.sort(byUrl), gone: gone.sort(byUrl) };
}

function renderReport(s) {
  const L = [`# 通達の取り直し ${s.stamp}（run ${s.run_id}）`, ''];
  L.push(s.first_run ? '- 初回: 前回の写しが無いので全件を取り直し、次からの基準にした（変更の一覧は出さない）' : `- 前回: ${s.prev_stamp}`);
  L.push(`- ページ: ${s.counts.pages} 件（取れなかった ${s.counts.page_errors}・国税庁のエラーページ ${s.counts.error_pages}）`);
  L.push(`- PDF: ${s.counts.pdfs} 件（取れなかった ${s.counts.pdf_errors}）`);
  if (!s.first_run) {
    L.push(`- 変わったもの: ページ 新しい ${s.html.added.length}・変わった ${s.html.changed.length}・消えた ${s.html.gone.length} / PDF 新しい ${s.pdf.added.length}・変わった ${s.pdf.changed.length}・消えた ${s.pdf.gone.length}`);
  }
  L.push(`- 基準の更新: ${s.saved ? 'した' : 'していない（止めた）'}`, '');
  if (s.blockers.length) { L.push('## 止めた理由', ''); for (const b of s.blockers) L.push(`- ${b}`); L.push(''); }
  const list = (h, arr) => {
    if (!arr.length) return;
    L.push(`## ${h}（${arr.length}）`, '');
    for (const x of arr.slice(0, 200)) L.push(`- ${x.title ? `${x.title} ` : ''}${x.url}`);
    if (arr.length > 200) L.push(`- ほか ${arr.length - 200} 件`);
    L.push('');
  };
  if (!s.first_run) {
    list('新しいページ', s.html.added); list('変わったページ', s.html.changed); list('消えたページ', s.html.gone);
    list('新しい PDF', s.pdf.added); list('変わった PDF', s.pdf.changed); list('消えた PDF', s.pdf.gone);
  }
  list('国税庁のエラーページ（前回の内容を残した）', s.error_pages);
  list('取れなかったページ・PDF', s.errors);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- crawl
// 今回の写し（all_tsutatsu_{stamp}）から、今回の manifest（01・04）に取れたものとして載っていないファイルを消す → 消した数（事例・裁決の run.cjs と同じ）
function pruneSnapshot(stamp, man) {
  const root = path.join(WORK_ROOT, `all_tsutatsu_${stamp}`);
  if (!fs.existsSync(root)) return 0;
  const keep = new Set(man.filter((r) => !r.error && r.local_path).map((r) => path.join(WORK_ROOT, r.local_path.split('/').join(path.sep))));
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!keep.has(p)) { fs.rmSync(p, { force: true }); n++; }
    }
  };
  walk(root);
  return n;
}

async function crawl() {
  const stamp = process.env.TSU_STAMP || jstStamp();
  const rid = runId();
  fs.mkdirSync(OUT, { recursive: true });
  // 作業フォルダを空にして 01・04 だけを写す（前回の写し・台帳は R2 からしか戻さない。初回は何も無い状態で全件を取る）
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  fs.mkdirSync(STATE, { recursive: true });
  for (const f of ['01_crawl.cjs', '04_fetch_pdfs.cjs']) fs.copyFileSync(path.join(TSU_DIR, f), path.join(WORK_ROOT, 'scripts', 'tsutatsu', f));
  require('../../site_config.cjs').copyInto(path.join(WORK_ROOT, 'scripts'));   // 01・04 が読む（クローラの連絡先）
  const r2 = new R2();

  const prevCur = await restoreBaseline(r2);
  const prevHtml = readJson(path.join(STATE, 'crawl_ledger.json'), {});
  const prevPdf = readJson(path.join(STATE, 'pdf_ledger.json'), {});
  // 今回の分だけ数えるため、追記型の記録は消してから流す（同じ日の manifest があると 01・04 はレジュームする。基準から戻った前回の日付の分は残す）
  fs.rmSync(path.join(STATE, 'crawl_error_pages.ndjson'), { force: true });
  if (prevCur && prevCur.stamp === stamp) {
    for (const f of [`manifest_${stamp}.ndjson`, `pdf_manifest_${stamp}.ndjson`]) fs.rmSync(path.join(STATE, f), { force: true });
  }

  const blockers = [];
  const a01 = ['--snapshot', stamp, ...(process.env.TSU_ONLY ? ['--only', process.env.TSU_ONLY] : [])];
  const c01 = await runNode('01_crawl.cjs', a01);
  if (c01 !== 0) blockers.push(`01_crawl が落ちた（exit ${c01}）`);
  const c04 = c01 === 0 ? await runNode('04_fetch_pdfs.cjs', ['--snapshot', stamp]) : null;
  if (c04 !== null && c04 !== 0) blockers.push(`04_fetch_pdfs が落ちた（exit ${c04}）`);

  // 同じ日に流し直すと、R2 から戻した写し（all_tsutatsu_{今日}）に前の回のファイルが残る。今回の manifest に取れたものとして載っていない
  // ファイル（消えたページ・PDF、今回取れなかったもの）を今回の写しから外す（残すと下見がそれを解析し、台帳と食い違う）
  if (c01 === 0) {
    const pruned = pruneSnapshot(stamp, [...readNdjson(path.join(STATE, `manifest_${stamp}.ndjson`)), ...readNdjson(path.join(STATE, `pdf_manifest_${stamp}.ndjson`))]);
    if (pruned) log(`今回取れなかったページ・PDF の写し ${pruned} 件を今回の写しから外した`);
  }

  const nextHtml = readJson(path.join(STATE, 'crawl_ledger.json'), {});
  const nextPdf = readJson(path.join(STATE, 'pdf_ledger.json'), {});
  const man = readNdjson(path.join(STATE, `manifest_${stamp}.ndjson`));
  const pman = readNdjson(path.join(STATE, `pdf_manifest_${stamp}.ndjson`));
  const pageErrors = man.filter((r) => r.error);
  const pdfErrors = pman.filter((r) => r.error);
  const errorPages = readNdjson(path.join(STATE, 'crawl_error_pages.ndjson')).map((r) => ({ url: r.url, title: (prevHtml[r.url] || {}).title || null }));
  const pages = Object.keys(nextHtml).length, pdfs = Object.keys(nextPdf).length;
  const counts = { pages, pdfs, page_errors: pageErrors.length, pdf_errors: pdfErrors.length, error_pages: errorPages.length };

  // 止める条件
  const okSeed = SEED_PATHS.every((p) => man.some((r) => !r.error && r.url && new URL(r.url).pathname === p));
  if (c01 === 0 && !process.env.TSU_ONLY && !okSeed) blockers.push(`種のページ（${SEED_PATHS.join('・')}）が取れていない`);
  const tooMany = (n, total) => n > FAIL_MIN && n > total * 0.02;
  if (tooMany(pageErrors.length, pages + pageErrors.length)) blockers.push(`取れなかったページが ${pageErrors.length} 件（2% 超）`);
  if (tooMany(pdfErrors.length, pdfs + pdfErrors.length)) blockers.push(`取れなかった PDF が ${pdfErrors.length} 件（2% 超）`);
  const html = diffLedgers(prevHtml, nextHtml), pdf = diffLedgers(prevPdf, nextPdf);
  if (prevCur) {
    const pPages = Object.keys(prevHtml).length, pPdfs = Object.keys(prevPdf).length;
    if (pages < pPages * 0.8) blockers.push(`ページ数が前回の 8 割を切った（${pPages} → ${pages}）`);
    if (pdfs < pPdfs * 0.8) blockers.push(`PDF 数が前回の 8 割を切った（${pPdfs} → ${pdfs}）`);
    const manyGone = (n, total) => n > GONE_MIN && n > total * 0.05;
    if (manyGone(html.gone.length, pPages)) blockers.push(`消えたページが ${html.gone.length} 件（5% 超。取得が途中で切れた疑い）`);
    if (manyGone(pdf.gone.length, pPdfs)) blockers.push(`消えた PDF が ${pdf.gone.length} 件（5% 超）`);
  } else if (pages < MIN_PAGES) blockers.push(`初回なのに取れたページが ${pages} 件（${MIN_PAGES} 件未満）`);

  let saved = false, gen = null;
  if (!blockers.length) {
    // 前回の写しは要らない（今回のスナップショットに 304 の分も写してある）。容量を空けてから固める
    if (prevCur && prevCur.stamp !== stamp) fs.rmSync(path.join(WORK_ROOT, `all_tsutatsu_${prevCur.stamp}`), { recursive: true, force: true });
    gen = (await saveBaseline(r2, stamp, rid, prevCur, counts)).gen;
    saved = true;
  }

  const summary = {
    run_id: rid, stamp, gen, first_run: !prevCur, prev_stamp: prevCur ? prevCur.stamp : null, saved, blockers, counts,
    html, pdf, error_pages: errorPages,
    errors: [...pageErrors, ...pdfErrors].map((r) => ({ url: r.url, title: r.error })),
    changed_total: html.added.length + html.changed.length + html.gone.length + pdf.added.length + pdf.changed.length + pdf.gone.length,
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'report.md'), renderReport(summary));
  log(`\n取り直し: ページ ${pages}・PDF ${pdfs} / 変わったもの ${summary.changed_total} / 止めた理由 ${blockers.length} / 基準の更新 ${saved ? 'した' : 'していない'}`);
  return summary;
}

// ---------------------------------------------------------------- build（段 3a。crawl の後に同じ作業フォルダで流す。書かない）
async function build() {
  const sum = readJson(path.join(OUT, 'summary.json'), null);
  if (!sum) throw new Error(`${OUT}/summary.json が無い（crawl の後に流す）`);
  if (!sum.saved) { log('crawl が基準を更新しなかった回なので build はしない'); return { skipped: true, blockers: [] }; }
  return require('./build.cjs').build({ out: OUT, stamp: sum.stamp, rid: sum.run_id, gen: sum.gen });
}

if (require.main === module) {
  const cmd = process.argv[2];
  const fn = { crawl, build, apply: () => require('./apply.cjs').apply(), restore: () => require('./apply.cjs').restore(process.argv[3]) }[cmd];
  if (!fn) { console.error('usage: node scripts/tsutatsu/weekly/run.cjs crawl | build | apply | restore <run_id>'); process.exit(2); }
  fn().then((s) => process.exit(s && s.blockers && s.blockers.length ? 3 : 0)).catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
}
module.exports = { diffLedgers, jstStamp };
