// 通達の週次 段 3b（apply.cjs）の確かめ。¥0・国税庁にも Cloudflare にも要求を出さない。
//
//   node scripts/tsutatsu/weekly/check_apply.cjs
//
// 偽の本番（R2_FAKE_DIR・VECTORIZE_FAKE_FILE）に build（段 3a）の成果物を反映し、戻す。
// 反映の後にもう一度下見すると「何もしない回」になること（本番と状態の控えが揃う）、戻すと元の本番に戻ること、
// 見直す対象・止めた回・古い下見・下見の後の本番の変化・成果物の欠け・作業中の印・途中で落ちた反映、を見る。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const H = require('./test_stubs/harness.cjs');
const { TMP, R2DIR, VECFILE, PROD, HOJIN, SOZOKU, NTA, RUN, baseItems, putProd, putVectors, runBuild, snapshotR2 } = H;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).slice(0, 2000)}` : ''}`); }
}
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const rk = (k) => path.join(R2DIR, ...k.split('/'));
const readR2 = (k) => (fs.existsSync(rk(k)) ? fs.readFileSync(rk(k)) : null);
const putR2 = (k, body) => { fs.mkdirSync(path.dirname(rk(k)), { recursive: true }); fs.writeFileSync(rk(k), typeof body === 'string' ? body : JSON.stringify(body)); };
const LOCK = 'update_state/tsutatsu_apply_inprogress.json';
const VSTATE = 'update_state/tsutatsu/vec_state.json';
const BSTATE = 'update_state/tsutatsu/build_state.json';
const vecDb = () => JSON.parse(fs.readFileSync(VECFILE, 'utf8'));
const setGen = (gen) => putR2('update_state/tsutatsu/current.json', { run_id: 'x', gen, stamp: H.STAMP, parts: [] });

function run(cmd, dir, { env = {}, args = [] } = {}) {
  const base = { ...process.env };
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GITHUB_ACTIONS', 'TSU_APPROVED']) delete base[k];
  const e = { ...base, TSU_WEEKLY_OUT: dir, R2_FAKE_DIR: R2DIR, VECTORIZE_FAKE_FILE: VECFILE, TSU_PROD_PREFIX: PROD, TSU_VEC_PACE_MS: '0', TSU_VEC_POLL_MS: '0', ...env };
  for (const [k, v] of Object.entries(env)) if (v === null) delete e[k];
  const r = spawnSync(process.execPath, [RUN, cmd, ...args], { env: e, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
// 本番を元の姿（baseItems をそのまま作ったもの）に戻す
async function reset({ state = true } = {}) {
  fs.rmSync(path.join(R2DIR, 'update_state'), { recursive: true, force: true });
  const items = baseItems();
  const { links } = putProd(items);
  await putVectors(links, items, { state });
  setGen('g1');
}
// 退避（tsutatsu_backup）を除いた R2 と、Vectorize の中身（id 順）。戻した後に「反映前と同じ」かを比べる
function prodView() {
  // 書き込みの印（vec_mutation.json）と世代（tsutatsu_apply_gen.json）は反映・戻しのたびに書くので比べない
  const r2 = snapshotR2().split('\n').slice(0, -1).filter((l) => !l.includes(`${path.sep}tsutatsu_backup${path.sep}`) && !l.includes('vec_mutation.json') && !l.includes('tsutatsu_apply_gen.json'));
  const db = vecDb();
  // 処理の印のベクトル（tsu-weekly-mark）も反映・戻しのたびに書くので比べない
  return r2.join('\n') + '\n' + JSON.stringify(Object.keys(db).filter((k) => k !== 'tsu-weekly-mark').sort().map((k) => [k, db[k].namespace, db[k].metadata, db[k].values]));
}
// 本文が 1 本変わり、1 本増える（見直す対象なし）
function weekA() {
  const it = baseItems();
  it[1].body = '資産の販売に係る収益の額は、原則として、その引渡しの日の属する事業年度の益金の額に算入する（改正）。';
  it.push({ ...it[0], tsutatsu_no: '22-3', caption: '（新設）', body: '新しく設けられた取扱い。内国法人の収益の計上時期について次による。' });
  return it;
}
// 1 本消え、紐付け先が 1 本変わる（見直す対象あり: 1 本だけの条から消える）
function weekB() {
  const it = weekA();
  it.splice(2, 1);   // 34-1 を消す
  it.find((o) => o.tsutatsu_no === '3-1').home = `${SOZOKU}:3の2`;
  return it;
}

async function main() {
  console.log('\n# 1. 見直す対象の無い回: 反映 → もう一度下見すると何もしない → 戻すと元の本番');
  await reset();
  const orig = prodView();
  const origHojin = readR2(`${PROD}/${HOJIN}.json`);
  const origState = readR2(VSTATE);
  let b = runBuild(weekA(), { gen: 'g1' });
  check('下見: 通る・見直す対象なし', b.code === 0 && b.m && b.m.ok_to_apply && !b.m.needs_review && !b.m.nothing_to_do, JSON.stringify(b.m && { bl: b.m.blockers, rv: b.m.review }));
  let r = run('apply', b.dir);
  check('反映: 終了コード 0（承認なしで流れる）', r.code === 0, r.out);
  check('法令ファイルと index.json が下見の中身になる', readR2(`${PROD}/${HOJIN}.json`).equals(fs.readFileSync(path.join(b.B, 'files', `${HOJIN}.json`))) && readR2(`${PROD}/index.json`).equals(fs.readFileSync(path.join(b.B, 'files', 'index.json'))));
  check('状態の控え（vec_state）が次の控えになる・build_state に浮きの数と PDF の hash', readR2(VSTATE).equals(fs.readFileSync(path.join(b.B, 'vec_state_next.json'))) && JSON.parse(readR2(BSTATE)).orphans === b.m.orphans && JSON.parse(readR2(BSTATE)).pdf_hashes[H.PDF_A] === `h:${H.PDF_A}`);
  const db1 = vecDb();
  const id223 = md5(`rev|${NTA}/kihon/hojin/01.htm|22-3`), id222 = md5(`rev|${NTA}/kihon/hojin/01.htm|22-2`);
  check('新しいベクトルが入り、本文が変わったものは入れ替わる（namespace 付き）', db1[id223] && db1[id223].namespace === '_reverse' && db1[id222] && b.vectors.find((v) => v.id === id222).values[0] === db1[id222].values[0]);
  check('作業中の印が残らない・退避がある', !readR2(LOCK) && readR2('update_state/tsutatsu_backup/run-1/_manifest.json'));
  let b2 = runBuild(weekA(), { gen: 'g1' });
  const b1b = runBuild(weekA(), { gen: 'g1', pdfChanged: [H.PDF_A] });
  check('反映の後は、前回の取り直しとの差があっても、反映したときの PDF の hash と同じなら変わっていない', b1b.m && !b1b.m.pdfs_changed.length, JSON.stringify(b1b.m && b1b.m.pdfs_changed));
  check('反映の後にもう一度下見すると何もしない回（本番と控えが揃う）', b2.code === 0 && b2.m && b2.m.nothing_to_do, JSON.stringify(b2.m && { f: Object.keys(b2.m.files), v: b2.m.vectors, rv: b2.m.review }));
  r = run('restore', b.dir, { args: ['run-1'] });
  check('戻す: 終了コード 0', r.code === 0, r.out);
  check('法令ファイル・状態の控えが元に戻り、build_state は消える（元は無かった）', readR2(`${PROD}/${HOJIN}.json`).equals(origHojin) && readR2(VSTATE).equals(origState) && !readR2(BSTATE));
  const db2 = vecDb();
  check('足したベクトルは消え、入れ替えたものは元の値に戻る', !db2[id223] && db2[id222] && JSON.stringify(db2[id222].values) !== JSON.stringify(b.vectors.find((v) => v.id === id222).values));
  check('作業中の印が残らない', !readR2(LOCK));
  check('本番（退避を除く R2・Vectorize）が反映前と同じ', prodView() === orig);
  b2 = runBuild(weekA(), { gen: 'g1' });
  check('戻した後の下見は最初と同じ変化を出す', b2.m && b2.m.changed_laws.join() === b.m.changed_laws.join() && b2.m.vectors.upsert === b.m.vectors.upsert, JSON.stringify(b2.m && b2.m.vectors));

  console.log('\n# 2. 見直す対象がある回: 承認が要る。metadata の差し替えと削除も戻せる');
  await reset();
  b = runBuild(weekB(), { gen: 'g1', runId: 'run-2' });
  check('下見: 見直す対象あり・metadata 1・削除 1', b.m && b.m.needs_review && b.m.vectors.meta_update === 1 && b.m.vectors.delete === 1, JSON.stringify(b.m && b.m.vectors));
  let before = snapshotR2();
  r = run('apply', b.dir);
  check('承認なし → 反映しない（何も書かない）', r.code === 1 && /反映」コメントからしか/.test(r.out) && snapshotR2() === before, r.out.slice(-400));
  const id31 = md5(`rev|${NTA}/kihon/sisan/sozoku2/01.htm|3-1`), id341 = md5(`rev|${NTA}/kihon/hojin/01.htm|34-1`);
  const old31 = vecDb()[id31], old341 = vecDb()[id341];
  r = run('apply', b.dir, { env: { TSU_APPROVED: '1' } });
  check('TSU_APPROVED=1 → 反映する', r.code === 0, r.out);
  let db = vecDb();
  check('metadata だけ差し替え（値は元のまま）・消えた通達のベクトルは消える', db[id31] && JSON.stringify(db[id31].values) === JSON.stringify(old31.values) && db[id31].metadata.homes !== old31.metadata.homes && !db[id341], JSON.stringify(db[id31] && db[id31].metadata));
  r = run('restore', b.dir, { args: ['run-2'] });
  db = vecDb();
  check('戻す: metadata と消したベクトルが元に戻る', r.code === 0 && db[id31] && db[id31].metadata.homes === old31.metadata.homes && db[id341] && JSON.stringify(db[id341].values) === JSON.stringify(old341.values), r.out.slice(-400));

  console.log('\n# 3. 反映しない回');
  await reset();
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-3' });
  setGen('g2');
  before = snapshotR2();
  r = run('apply', b.dir);
  check('下見の後に新しい取り直しがある → 古い下見は反映しない（何も書かない）', r.code === 1 && /新しい取り直しがある/.test(r.out) && snapshotR2() === before && !readR2(LOCK), r.out.slice(-400));
  setGen('g1');
  const hj = JSON.parse(readR2(`${PROD}/${HOJIN}.json`)); hj['99'] = []; putR2(`${PROD}/${HOJIN}.json`, hj);
  before = snapshotR2();
  r = run('apply', b.dir);
  check('下見の後に本番の法令ファイルが変わった → 書かない', r.code === 1 && /下見の後に .*変わった/.test(r.out) && snapshotR2() === before && !readR2(LOCK), r.out.slice(-400));
  await reset();
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-3' });
  const vf = path.join(b.B, 'vectors.ndjson');
  const vlines = fs.readFileSync(vf, 'utf8');
  fs.writeFileSync(vf, vlines.split('\n').slice(1).join('\n'));
  before = snapshotR2();
  r = run('apply', b.dir);
  check('成果物のベクトルが 1 本欠けている → 書かない', r.code === 1 && /vectors\.ndjson が .* 本（manifest では/.test(r.out) && snapshotR2() === before, r.out.slice(-400));
  fs.writeFileSync(vf, vlines);
  const mf = path.join(b.B, 'manifest.json');
  const mj = JSON.parse(fs.readFileSync(mf, 'utf8'));
  fs.writeFileSync(mf, JSON.stringify({ ...mj, ok_to_apply: false, blockers: ['（確かめ用）'] }));
  r = run('apply', b.dir, { env: { TSU_APPROVED: '1' } });
  check('止めた回 → 承認があっても反映しない', r.code === 1 && /止めた理由があるので反映しない/.test(r.out) && snapshotR2() === before, r.out.slice(-400));
  fs.writeFileSync(mf, JSON.stringify({ ...mj, files: { 'hanrei_v1/index.json': mj.files[`${PROD}/index.json`], ...mj.files } }));
  r = run('apply', b.dir);
  check('書き先が本番の通達以外 → 書かない', r.code === 1 && /書き先が本番の通達のファイルでない/.test(r.out) && snapshotR2() === before, r.out.slice(-400));
  fs.writeFileSync(mf, JSON.stringify(mj));
  r = run('apply', b.dir, { env: { VECTORIZE_FAKE_FILE: null } });
  check('Actions の外（偽の R2・Vectorize が揃っていない）→ 動かない', r.code === 1 && /Actions の Update tsutatsu data からしか/.test(r.out) && snapshotR2() === before, r.out.slice(-400));
  const nb = runBuild(baseItems(), { gen: 'g1', runId: 'run-3n' });
  r = run('apply', nb.dir);
  check('何もしない回 → 書かない', nb.m && nb.m.nothing_to_do && r.code === 0 && /反映するものが無い/.test(r.out) && snapshotR2() === before, r.out.slice(-300));

  console.log('\n# 3b. 今の索引にあるはずのベクトルが取れない・索引の処理が追いつかない → 書かない');
  await reset();
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-3b' });
  check('下見のベクトルに why（new／text）が付く', b.vectors.length && b.vectors.every((v) => v.why === 'new' || v.why === 'text') && b.vectors.find((v) => v.id === md5(`rev|${NTA}/kihon/hojin/01.htm|22-2`)).why === 'text');
  const dbm = vecDb();
  const gone222 = md5(`rev|${NTA}/kihon/hojin/01.htm|22-2`);
  delete dbm[gone222];
  fs.writeFileSync(VECFILE, JSON.stringify(dbm));
  before = snapshotR2();
  r = run('apply', b.dir);
  check('本文が変わるはずの既存ベクトルが索引に無い → 退避できないので何も書かない・印を残さない', r.code === 1 && /今の索引にあるはずのベクトルが取れない/.test(r.out) && r.out.includes(gone222) && snapshotR2() === before && !readR2(LOCK), r.out.slice(-400));
  const MUT = 'update_state/tsutatsu/vec_mutation.json';
  const { Vectorize } = require('../../update/lib/vectorize.cjs');
  const fv = new Vectorize({ fakeFile: VECFILE, index: 'tsutatsu-embeddings-v1' });
  const pendingN = () => (fs.existsSync(`${VECFILE}.pending.json`) ? JSON.parse(fs.readFileSync(`${VECFILE}.pending.json`, 'utf8')).length : 0);
  const markSeq = () => { const m = vecDb()['tsu-weekly-mark']; return m && m.metadata.seq; };
  await reset();
  // 書き込みの無い索引: 前の反映の印は昔に処理済み（その後は何も書かれていない）→ 待たずに流れる
  fs.rmSync(`${VECFILE}.pending.json`, { force: true });
  await fv.upsert([{ id: 'tsu-weekly-mark', namespace: '_weekly_mark', values: new Array(1024).fill(1 / 32), metadata: { seq: 1000, run_id: 'old', kind: 'apply' } }]);
  putR2(MUT, { seq: 1000, run_id: 'old', kind: 'apply' });
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-3c' });
  r = run('apply', b.dir, { env: { TSU_VEC_WAIT_MS: '0' } });
  check('書き込みの無い索引（前の印は昔に処理済み）でも待たずに反映する・印のベクトルと控えを書く', r.code === 0 && !readR2(LOCK) && JSON.parse(readR2(MUT)).run_id === 'run-3c' && markSeq() === JSON.parse(readR2(MUT)).seq && vecDb()['tsu-weekly-mark'].namespace === '_weekly_mark', r.out.slice(-400));
  // 処理が遅れている索引: 書いた後の読み戻しは待ちきれず飛ばす（反映は終える）。次の戻しは、印のベクトルまで処理されるまで何もしない
  await reset();
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-3d' });
  r = run('apply', b.dir, { env: { VECTORIZE_FAKE_LAG: '1', TSU_VEC_WAIT_MS: '0' } });
  check('処理が遅れている索引: 反映は終え、ベクトルの読み戻しは飛ばしたと書く（印は外す）・書き込みは処理待ち', r.code === 0 && /ベクトルの読み戻しは飛ばした/.test(r.out) && !readR2(LOCK) && pendingN() >= 2, r.out.slice(-400));
  const restoreBlocked = (label) => {
    const before2 = snapshotR2();
    const rr = run('restore', b.dir, { args: ['run-3d'], env: { TSU_VEC_WAIT_MS: '0' } });
    check(label, rr.code === 1 && /処理し終えない/.test(rr.out) && snapshotR2() === before2 && !readR2(LOCK), rr.out.slice(-400));
  };
  restoreBlocked('　→ 何も処理されていない間の戻しは、何も書かない・印を残さない');
  fv._fakeProcessPending(pendingN() - 1);   // 分けて送った書き込みのうち、最後（印のベクトル）の手前まで処理された
  restoreBlocked('　→ 途中のバッチまで処理されても、最後の印のベクトルが処理されるまでは戻さない');
  fv._fakeProcessPending();
  await fv.upsert([{ id: 'other-writer', namespace: '_hanrei', values: new Array(1024).fill(1 / 32), metadata: { x: 1 } }]);   // 直後に別の書き込み（判例の週次など）が入り、その後は静か
  r = run('restore', b.dir, { args: ['run-3d'], env: { TSU_VEC_WAIT_MS: '0' } });
  check('　→ 全部処理され、直後に別の書き込みが入った後で静かになっても戻せる', r.code === 0 && !readR2(LOCK), r.out.slice(-400));

  console.log('\n# 4. 途中で落ちた反映');
  await reset();
  const origAll = prodView();
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-4' });
  r = run('apply', b.dir, { env: { TSU_TEST_FAIL_APPLY_AT: 'vectors' } });
  const lk = readR2(LOCK) && JSON.parse(readR2(LOCK));
  check('ファイルを書いた後に落ちた → 印が writing で残る', r.code === 1 && lk && lk.phase === 'writing' && lk.run_id === 'run-4', r.out.slice(-300));
  const bl = runBuild(weekA(), { gen: 'g1', runId: 'run-5' });
  check('印が残っている間の下見は止める（戻し方を書く）', bl.code === 3 && bl.m.blockers.some((x) => /restore_run_id=run-4/.test(x)), JSON.stringify(bl.m && bl.m.blockers));
  const b5 = runBuild(weekA(), { gen: 'g1', runId: 'run-5' });
  r = run('apply', b5.dir);
  check('印が残っている間は別の回の反映もしない', r.code === 1 && /止めた理由があるので|作業中の印がある/.test(r.out), r.out.slice(-300));
  r = run('restore', b.dir, { args: ['run-4'] });
  check('restore で書く前の姿に戻り、印が外れる', r.code === 0 && !readR2(LOCK) && readR2(`${PROD}/${HOJIN}.json`).equals(origHojin), r.out.slice(-400));
  check('本番（退避を除く R2・Vectorize）が反映前と同じ', prodView() === origAll);
  await reset();
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-4v' });
  r = run('apply', b.dir, { env: { TSU_TEST_FAIL_APPLY_AT: 'verify' } });
  const lkv = readR2(LOCK) && JSON.parse(readR2(LOCK));
  check('全部書いた後の読み戻しで止まった → 印を残す（次の下見・反映を止める）', r.code === 1 && lkv && lkv.phase === 'writing' && lkv.run_id === 'run-4v', r.out.slice(-300));
  r = run('restore', b.dir, { args: ['run-4v'] });
  check('　→ restore で元の本番に戻り、印が外れる', r.code === 0 && !readR2(LOCK) && prodView() === origAll, r.out.slice(-300));
  await reset();
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-6' });
  before = snapshotR2();
  r = run('apply', b.dir, { env: { TSU_TEST_KILL_APPLY_AT: 'backup' } });
  const lk6 = readR2(LOCK) && JSON.parse(readR2(LOCK));
  check('退避の途中で落ちた → 印は backup のまま・本番は書いていない', r.code === 137 && lk6 && lk6.phase === 'backup' && readR2(`${PROD}/${HOJIN}.json`).equals(origHojin), r.out.slice(-300));
  r = run('restore', b.dir, { args: ['run-6'] });
  check('restore は印だけ外す', r.code === 0 && /印だけ外した/.test(r.out) && !readR2(LOCK), r.out.slice(-300));

  console.log('\n# 5. 戻すのを止める: 反映の後に本番が変わった');
  await reset();
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-7' });
  r = run('apply', b.dir);
  const after7 = JSON.parse(readR2(`${PROD}/${HOJIN}.json`)); after7['98'] = []; putR2(`${PROD}/${HOJIN}.json`, after7);
  before = snapshotR2();
  r = run('restore', b.dir, { args: ['run-7'] });
  check('この回の後に変わったファイルがある → 何も書かない・印を残さない', r.code === 1 && /この回の後に変わったファイル/.test(r.out) && snapshotR2() === before && !readR2(LOCK), r.out.slice(-400));

  console.log('\n# 5b. 戻すのを止める: 本番の版（プレフィックス）を切り替えた後');
  await reset();
  b = runBuild(weekA(), { gen: 'g1', runId: 'run-7b' });
  r = run('apply', b.dir);
  before = snapshotR2();
  r = run('restore', b.dir, { args: ['run-7b'], env: { TSU_PROD_PREFIX: 'tsutatsu_chunks_vNEXT' } });
  check('今の本番の版が反映したときと違う → 何も書かない（R2・Vectorize とも）・印を残さない', r.code === 1 && /版を切り替えた後は戻さない/.test(r.out) && snapshotR2() === before && !readR2(LOCK), r.out.slice(-400));
  r = run('restore', b.dir, { args: ['run-7b'] });
  check('　→ 同じ版なら戻せる', r.code === 0 && !readR2(LOCK), r.out.slice(-300));

  console.log('\n# 6. 初回（vec_state が無い）: 承認で反映すると控えができ、次の下見は初回でなくなる');
  await reset({ state: false });
  b = runBuild(baseItems(), { gen: 'g1', runId: 'run-8' });
  check('初回の下見は見直す対象', b.m && b.m.first_run && b.m.needs_review && !b.m.nothing_to_do);
  r = run('apply', b.dir, { env: { TSU_APPROVED: '1' } });
  check('反映で vec_state ができる', r.code === 0 && readR2(VSTATE), r.out.slice(-300));
  b2 = runBuild(baseItems(), { gen: 'g1', runId: 'run-9' });
  check('次の下見は初回でなく、何もしない回', b2.m && !b2.m.first_run && b2.m.nothing_to_do, JSON.stringify(b2.m && { rv: b2.m.review, v: b2.m.vectors }));

  console.log('\n# 9. ページの見出し（pages.json）だけが変わる回');
  await reset();
  const PAGES = {
    'kihon/hojin/01.htm': '<title>第1款 益金の額｜国税庁</title>',
    'kihon/sisan/sozoku2/01.htm': '<title>〔みなし相続財産〕｜国税庁</title>',
    'kihon/chosyu/01.htm': '<title>第47条関係 差押えの要件｜国税庁</title><a href="../../kobetsu/hojin/a.pdf">別紙</a>',
  };
  const pagesKey = `${PROD}/pages.json`;
  const indexBefore = readR2(`${PROD}/index.json`);
  before = prodView();
  b = runBuild(baseItems(), { gen: 'g1', runId: 'run-p1', pages: PAGES });
  check('下見: 初めて書く pages.json だけ・見直す対象', b.m && Object.keys(b.m.files).join() === pagesKey && b.m.needs_review, JSON.stringify(b.m && { f: Object.keys(b.m.files), rv: b.m.review }));
  r = run('apply', b.dir);
  check('承認が無ければ書かない', r.code !== 0 && !readR2(pagesKey), r.out.slice(-300));
  r = run('apply', b.dir, { env: { TSU_APPROVED: '1' } });
  check('承認があれば pages.json だけを書く（index.json は変わらない）', r.code === 0 && readR2(pagesKey) && readR2(pagesKey).equals(fs.readFileSync(path.join(b.B, 'files', 'pages.json'))) && readR2(`${PROD}/index.json`).equals(indexBefore), r.out.slice(-400));
  b2 = runBuild(baseItems(), { gen: 'g1', runId: 'run-p2', pages: PAGES });
  check('反映の後の下見は何もしない回', b2.m && b2.m.nothing_to_do && b2.m.pages.state === 'same', JSON.stringify(b2.m && { f: Object.keys(b2.m.files), p: b2.m.pages }));
  r = run('restore', b.dir, { args: ['run-p1'] });
  check('戻すと pages.json が無い元の本番に戻る', r.code === 0 && !readR2(pagesKey) && prodView() === before, r.out.slice(-400));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
