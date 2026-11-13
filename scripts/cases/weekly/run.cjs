// 質疑応答事例・裁決の週次更新（docs/tsutatsu_hanrei_weekly.md の「質疑応答事例・裁決」）。
//
//   node scripts/cases/weekly/run.cjs crawl              国税庁（事例）と国税不服審判所（裁決）を取り直す（本番のデータには書かない）
//   node scripts/cases/weekly/run.cjs build              今回の写しから作り直して本番と比べる（反映の下見。書かない。build.cjs）
//   node scripts/cases/weekly/run.cjs apply              下見を退避付きで本番に書く（Actions からだけ。apply.cjs）
//   node scripts/cases/weekly/run.cjs restore <run_id>   その回の反映を戻す（apply.cjs）
//
// crawl（通達の段 2 と同じ作り）:
//   1. 前回の写し（all_{事例,裁決}_{前回}/・台帳・manifest）を R2 update_state/cases/{shitsugi,saiketsu}/ から戻す（初回は無い）
//   2. 01_crawl を今日（JST）のスナップショットで流す。台帳の ETag / Last-Modified で 304 を受け、未変更は前回の写しを引き継ぐ
//      （事例は国税庁、裁決は国税不服審判所。宛先が別なので 2 つを並べて流す。どちらも 1 秒 1 件）
//   3. 前回の台帳と比べて、新しい・変わった・消えたページを報告する
//   4. 取得が健全なら（止める条件に掛からなければ）、今回の写しと台帳を R2 に置いて次の基準にする
//
// 止める条件（基準を書き換えず Issue）: 01 が落ちた、種のページが取れない、取れなかったページが 10 件かつ 2% を超える、
//   ページ数が前回の 8 割を切る、消えたページが 20 件かつ 5% を超える、初回に取れたページが少なすぎる（CASES_MIN_PAGES。既定 事例 1,500・裁決 1,500）
//
// 環境変数:
//   CASES_WEEKLY_OUT  報告と作業フォルダの置き場（既定 scripts/cases/weekly/state/）。取得は毎回その下の work/{source}/ を空にしてから行う
//   CASES_STAMP       スナップショットの日付（既定は今日の JST。確かめ用）
//   CASES_ONLY        01 の --only（確かめ用。"shitsugi:hojin,saiketsu:JP" の形）
//   CASES_PART_BYTES  R2 に置くときの 1 ファイルの大きさ（既定 100MiB）
//   CASES_MIN_PAGES / CASES_FAIL_MIN / CASES_GONE_MIN  止める条件の件数（確かめ用に小さくする）
//   UPDATE_RUN_ID     回の印（Actions では run_id-attempt）
//   R2_FAKE_DIR       R2 の代わりにこのフォルダ（scripts/update/lib/r2.cjs）
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { R2 } = require('../../update/lib/r2.cjs');
const { makeSnapshotStore } = require('../../update/lib/snapshot_store.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(process.env.CASES_WEEKLY_OUT || path.join(__dirname, 'state'));
const PART_BYTES = Number(process.env.CASES_PART_BYTES || 100 * 1024 * 1024);
const FAIL_MIN = Number(process.env.CASES_FAIL_MIN || 10);
const GONE_MIN = Number(process.env.CASES_GONE_MIN || 20);
// 取り直す 2 つ。seed: これが取れない回は全体が崩れている（01 の SEEDS の先頭）。minPages: 初回に取れていないとおかしいページ数
const SOURCES = [
  { name: 'shitsugi', label: '質疑応答事例', seed: '/law/shitsugi/01.htm', minPages: Number(process.env.CASES_MIN_PAGES || 1500) },
  { name: 'saiketsu', label: '裁決', seed: '/service/index.html', minPages: Number(process.env.CASES_MIN_PAGES || 1500) },
];

const log = (...a) => console.log(...a);
const workRoot = (name) => path.join(OUT, 'work', name);
const stateDir = (name) => path.join(workRoot(name), 'scripts', name, 'state');
function jstStamp() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, ''); }
function runId() { return process.env.UPDATE_RUN_ID || `local-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`; }
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function readNdjson(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function runNode(name, script, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(workRoot(name), 'scripts', name, script), ...args], { stdio: 'inherit', cwd: workRoot(name) });
    // シグナルで落ちた（SIGKILL など）ときは code が null。0 のときだけ成功にする
    p.on('close', (code, signal) => resolve(code === 0 ? 0 : (code == null ? `signal ${signal || '?'}` : code)));
    p.on('error', () => resolve(127));
  });
}
function store(r2, name) {
  return makeSnapshotStore({ r2, prefix: `update_state/cases/${name}`, workRoot: workRoot(name), tmpRoot: path.join(OUT, `tmp_${name}`), partBytes: PART_BYTES, log });
}
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
const onlyFor = (name) => {
  const m = (process.env.CASES_ONLY || '').split(',').map((x) => x.split(':')).find(([n]) => n === name);
  return m ? m[1] : null;
};

// 今回の写し（all_{name}_{stamp}/）から、今回の manifest に取れたページとして載っていないファイルを消す → 消した数
function pruneSnapshot(name, stamp, man) {
  const root = path.join(workRoot(name), `all_${name}_${stamp}`);
  if (!fs.existsSync(root)) return 0;
  const keep = new Set(man.filter((r) => !r.error && r.local_path).map((r) => path.join(workRoot(name), r.local_path.split('/').join(path.sep))));
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

// ---------------------------------------------------------------- crawl（1 つ分）
async function crawlOne(r2, S, stamp, rid) {
  fs.rmSync(workRoot(S.name), { recursive: true, force: true });
  fs.mkdirSync(stateDir(S.name), { recursive: true });
  // 01（取り直し）と 03（build で使う解析）と、03 が読む src/lawIds.js を作業フォルダに写す（リポジトリや PC の写し・台帳は読まない）
  for (const f of ['01_crawl.cjs', '03_parse.cjs']) fs.copyFileSync(path.join(REPO_ROOT, 'scripts', S.name, f), path.join(workRoot(S.name), 'scripts', S.name, f));
  require('../../site_config.cjs').copyInto(path.join(workRoot(S.name), 'scripts'));   // 01 が読む（クローラの連絡先）
  // 裁決の 03 は事例の 03 の scanLawArticles を使う（require('../shitsugi/03_parse.cjs')）
  if (S.name === 'saiketsu') {
    fs.mkdirSync(path.join(workRoot(S.name), 'scripts', 'shitsugi'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'shitsugi', '03_parse.cjs'), path.join(workRoot(S.name), 'scripts', 'shitsugi', '03_parse.cjs'));
  }
  fs.mkdirSync(path.join(workRoot(S.name), 'src'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'src', 'lawIds.js'), path.join(workRoot(S.name), 'src', 'lawIds.js'));
  const st = store(r2, S.name);
  const prevCur = await st.restore();
  const prev = readJson(path.join(stateDir(S.name), 'crawl_ledger.json'), {});
  // 今回の分だけ数えるため、同じ日の manifest があれば消してから流す（01 は同じ日の manifest があるとレジュームする）
  if (prevCur && prevCur.stamp === stamp) fs.rmSync(path.join(stateDir(S.name), `manifest_${stamp}.ndjson`), { force: true });

  const blockers = [];
  const only = onlyFor(S.name);
  const code = await runNode(S.name, '01_crawl.cjs', ['--snapshot', stamp, ...(only ? ['--only', only] : [])]);
  if (code !== 0) blockers.push(`${S.label}: 01_crawl が落ちた（exit ${code}）`);
  const next = readJson(path.join(stateDir(S.name), 'crawl_ledger.json'), {});
  const man = readNdjson(path.join(stateDir(S.name), `manifest_${stamp}.ndjson`));
  // 今回の写しには、今回取れたページ（manifest の local_path）だけを残す。同じ日に流し直すと、戻した前回の写し（同じ日付のフォルダ）に
  // 今回リンクから外れた・取れなかったページが残り、台帳では消えたのに下見では残る、とずれるため
  const pruned = pruneSnapshot(S.name, stamp, man);
  if (pruned) log(`${S.label}: 今回取れなかったページの写し ${pruned} 件を今回の写しから外した`);
  const errors = man.filter((r) => r.error);
  const pages = Object.keys(next).length;
  const okSeed = man.some((r) => !r.error && r.url && new URL(r.url).pathname === S.seed);
  if (code === 0 && !only && !okSeed) blockers.push(`${S.label}: 種のページ（${S.seed}）が取れていない`);
  if (errors.length > FAIL_MIN && errors.length > (pages + errors.length) * 0.02) blockers.push(`${S.label}: 取れなかったページが ${errors.length} 件（2% 超）`);
  const d = diffLedgers(prev, next);
  if (prevCur) {
    const p = Object.keys(prev).length;
    if (pages < p * 0.8) blockers.push(`${S.label}: ページ数が前回の 8 割を切った（${p} → ${pages}）`);
    if (d.gone.length > GONE_MIN && d.gone.length > p * 0.05) blockers.push(`${S.label}: 消えたページが ${d.gone.length} 件（5% 超。取得が途中で切れた疑い）`);
  } else if (pages < S.minPages) blockers.push(`${S.label}: 初回なのに取れたページが ${pages} 件（${S.minPages} 件未満）`);
  return { S, prevCur, blockers, counts: { pages, errors: errors.length }, diff: d, errors: errors.map((r) => ({ url: r.url, error: r.error })) };
}

async function crawl() {
  const stamp = process.env.CASES_STAMP || jstStamp();
  const rid = runId();
  fs.mkdirSync(OUT, { recursive: true });
  const r2 = new R2();
  // 宛先が別なので 2 つを並べて流す（どちらも 1 秒 1 件）
  const res = await Promise.all(SOURCES.map((S) => crawlOne(r2, S, stamp, rid).catch((e) => ({ S, prevCur: null, blockers: [`${S.label}: 取り直しが落ちた（${String(e && e.message || e).slice(0, 200)}）`], counts: {}, diff: { added: [], changed: [], gone: [] }, errors: [], crashed: true }))));
  const blockers = res.flatMap((r) => r.blockers);
  // どちらかが崩れた回は、どちらの基準も書き換えない（事例と裁決は条文の索引を共有するので、片方だけ進めない）
  const gens = {};
  let saved = false;
  if (!blockers.length) {
    for (const r of res) {
      const name = r.S.name;
      if (r.prevCur && r.prevCur.stamp !== stamp) fs.rmSync(path.join(workRoot(name), `all_${name}_${r.prevCur.stamp}`), { recursive: true, force: true });
      const rel = [`all_${name}_${stamp}`, `scripts/${name}/state/crawl_ledger.json`, `scripts/${name}/state/manifest_${stamp}.ndjson`];
      gens[name] = (await store(r2, name).save({ stamp, rid, prevCur: r.prevCur, counts: r.counts, rel })).gen;
    }
    saved = true;
  }
  const summary = {
    run_id: rid, stamp, saved, gens, blockers,
    first_run: res.some((r) => !r.prevCur),
    sources: Object.fromEntries(res.map((r) => [r.S.name, { label: r.S.label, first_run: !r.prevCur, prev_stamp: r.prevCur ? r.prevCur.stamp : null, counts: r.counts, diff: r.diff, errors: r.errors.slice(0, 50) }])),
    changed_total: res.reduce((s, r) => s + r.diff.added.length + r.diff.changed.length + r.diff.gone.length, 0),
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'report.md'), renderCrawlReport(summary));
  log(`\n取り直し: ${res.map((r) => `${r.S.label} ${r.counts.pages ?? '?'} ページ`).join('・')} / 変わったもの ${summary.changed_total} / 止めた理由 ${blockers.length} / 基準の更新 ${saved ? 'した' : 'していない'}`);
  return summary;
}

function renderCrawlReport(s) {
  const L = [`# 質疑応答事例・裁決の取り直し ${s.stamp}（run ${s.run_id}）`, ''];
  for (const [, v] of Object.entries(s.sources)) {
    L.push(`- ${v.label}: ${v.counts.pages ?? '?'} ページ（取れなかった ${v.counts.errors ?? '?'}）${v.first_run ? '（初回）' : `・前回 ${v.prev_stamp}`}。新しい ${v.diff.added.length}・変わった ${v.diff.changed.length}・消えた ${v.diff.gone.length}`);
  }
  L.push(`- 基準の更新: ${s.saved ? 'した' : 'していない'}`, '');
  if (s.blockers.length) { L.push('## 止めた理由', ''); for (const b of s.blockers) L.push(`- ${b}`); L.push(''); }
  for (const [, v] of Object.entries(s.sources)) {
    for (const [k, t] of [['added', '新しい'], ['changed', '変わった'], ['gone', '消えた']]) {
      const a = v.diff[k];
      if (!a.length) continue;
      L.push(`## ${v.label}: ${t}ページ（${a.length}）`, '');
      for (const x of a.slice(0, 100)) L.push(`- ${x.title || ''} ${x.url}`);
      if (a.length > 100) L.push(`- ほか ${a.length - 100} 件`);
      L.push('');
    }
  }
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- build（crawl の後。書かない）
async function build() {
  const sum = readJson(path.join(OUT, 'summary.json'), null);
  if (!sum) throw new Error(`${OUT}/summary.json が無い（crawl の後に流す）`);
  if (!sum.saved) { log('crawl が基準を更新しなかった回なので build はしない'); return { skipped: true, blockers: [] }; }
  return require('./build.cjs').build({ out: OUT, stamp: sum.stamp, rid: sum.run_id, gens: sum.gens });
}

if (require.main === module) {
  const cmd = process.argv[2];
  const fn = { crawl, build, apply: () => require('./apply.cjs').apply(), restore: () => require('./apply.cjs').restore(process.argv[3]) }[cmd];
  if (!fn) { console.error('usage: node scripts/cases/weekly/run.cjs crawl | build | apply | restore <run_id>'); process.exit(2); }
  fn().then((s) => process.exit(s && s.blockers && s.blockers.length ? 3 : 0)).catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
}
module.exports = { SOURCES, workRoot, stateDir, diffLedgers, jstStamp };
