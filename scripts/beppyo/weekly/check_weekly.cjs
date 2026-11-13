// 別表のベクトルの週次更新の確かめ（¥0・Cloudflare に要求を出さない）
//
//   node scripts/beppyo/weekly/check_weekly.cjs
//
// 偽の R2（R2_FAKE_DIR）に条文（別表）・refs・台帳を置き、偽の Vectorize・偽の埋め込み（AI_FAKE=1）で build → apply → restore を流す。
// 別表のベクトルの作り方は実物（scripts/rebuild/lib/beppyo.cjs）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Bp = require('../../rebuild/lib/beppyo.cjs');

const RUN = path.join(__dirname, 'run.cjs');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).slice(0, 2500)}` : ''}`); }
}
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beppyo-weekly-'));
const R2DIR = path.join(TMP, 'r2');
const VECFILE = path.join(TMP, 'vec.json');
const rk = (k) => path.join(R2DIR, ...k.split('/'));
const readR2J = (k) => (fs.existsSync(rk(k)) ? JSON.parse(fs.readFileSync(rk(k), 'utf8')) : null);
const putR2 = (k, o) => { fs.mkdirSync(path.dirname(rk(k)), { recursive: true }); fs.writeFileSync(rk(k), typeof o === 'string' ? o : JSON.stringify(o)); };
const delR2 = (k) => fs.rmSync(rk(k), { force: true });
const vecDb = () => (fs.existsSync(VECFILE) ? JSON.parse(fs.readFileSync(VECFILE, 'utf8')) : {});

// ---------------------------------------------------------------- 偽の本番
const TOUROKU = '342AC0000000035', HOJIN = '340AC0000000034';
const row = (t, b) => ({ item_title: t, sentences: [{ text: b }] });
function bigTable(extra = '') {
  const items = [row('一', '不動産の登記'), row('（一）', '所有権の保存の登記'), row('イ', `相続 千分の四${extra}`), row('ロ', 'その他 千分の二十'), row('（二）', '地上権の設定の登記'), row('二', '船舶の登記'), row('（一）', '船舶の所有権の保存の登記')];
  return { type: 'appdx_table', title: '別表第一', caption: '課税範囲、課税標準及び税率の表（第二条、第九条関係）', full_text: 'x'.repeat(31000), paragraphs: [{ sentences: [{ text: '課税範囲' }], items }] };
}
const smallTable = () => ({ type: 'appdx_table', title: '別表第二', caption: '非課税の登記等の表（第四条関係）', full_text: 'short', paragraphs: [{ items: [row('一', '国'), row('二', '地方公共団体')] }] });
const hojinTable = () => ({ type: 'appdx_table', title: '別表第三の二', caption: '', full_text: 'short', paragraphs: [{ items: [row('', '耐用年数の表')] }] });
const lawFile = (lawId, title, arts) => ({ law_id: lawId, law_title: title, law_num: '', law_type: 'Act', articles: arts });
function setArticles({ big = bigTable(), small = true, hojin = true } = {}) {
  putR2(`arts/${TOUROKU}/別表第一.json`, lawFile(TOUROKU, '登録免許税法', [big]));
  if (small) putR2(`arts/${TOUROKU}/別表第二.json`, lawFile(TOUROKU, '登録免許税法', [smallTable()])); else delR2(`arts/${TOUROKU}/別表第二.json`);
  putR2(`arts/${TOUROKU}/第一条.json`, lawFile(TOUROKU, '登録免許税法', [{ title: '第一条', caption: '（趣旨）', paragraphs: [] }]));
  if (hojin) putR2(`arts/${HOJIN}/別表第三の二.json`, lawFile(HOJIN, '法人税法', [hojinTable()])); else delR2(`arts/${HOJIN}/別表第三の二.json`);
}
function setRefs(extra = {}) {
  putR2('refs/refs_index.json', { [HOJIN]: 0, [TOUROKU]: 1 });
  putR2('refs/refs_chunk_000.json', { [HOJIN]: { refs: { [`${HOJIN}_Art31`]: [{ target_law_id: HOJIN, target_appdx: '別表第三の二' }], ...(extra[HOJIN] || {}) }, reverse_refs: {} } });
  putR2('refs/refs_chunk_001.json', { [TOUROKU]: { refs: { [`${TOUROKU}_Art9`]: [{ target_law_id: TOUROKU, target_appdx: '別表第１' }], ...(extra[TOUROKU] || {}) }, reverse_refs: {} } });
}
let ledgerN = 0;
const bumpLedger = () => putR2('update_state/sync_state.json', { laws: {}, n: ++ledgerN });

// PC（13・15）で作った今の本番のベクトル: v3 のときの本文（少し古い）で作ったもの
async function pcProduction() {
  const { Embedder } = require('../../update/lib/ai.cjs');
  const emb = new Embedder({ fake: true });
  const db = {};
  const add = async (id, ns, text, metadata) => { const [v] = await emb.embed([text]); db[id] = { values: v, metadata, namespace: ns }; };
  const bigOld = bigTable();
  const e1 = Bp.beppyoEntry(TOUROKU, '登録免許税法', bigOld, {});   // PC の homes は古い refs（caption だけ）
  await add(e1.id, e1.ns, e1.text, e1.metadata);
  const e2 = Bp.beppyoEntry(TOUROKU, '登録免許税法', smallTable(), {});
  await add(e2.id, e2.ns, e2.text, e2.metadata);
  const rows = Bp.buildRows(TOUROKU, bigOld);
  for (const r of rows) await add(r.id, r.ns, r.text, r.metadata);
  // v3 のときは表が 1 行長かった（g5 まであった）→ 今は無い行
  await add(`${TOUROKU}_別表第一_g${rows.length + 1}`, Bp.nsOf(TOUROKU, '別表第一'), '古い行', { idx: 99, t: '古い行' });
  // 関係の無いベクトル（通達）は触らない
  db[md5('tsutatsu-x')] = { values: db[e1.id].values, metadata: { no: '1-1' }, namespace: '_reverse' };
  fs.writeFileSync(VECFILE, JSON.stringify(db));
  return { rows: rows.length, e1, e2 };
}

function run(args, env = {}, out = path.join(TMP, 'out')) {
  return new Promise((resolve) => {
    const e = { ...process.env, BEPPYO_WEEKLY_OUT: out, R2_FAKE_DIR: R2DIR, VECTORIZE_FAKE_FILE: VECFILE, AI_FAKE: '1',
      BEPPYO_ARTICLES_PREFIX: 'arts', BEPPYO_REFS_PREFIX: 'refs', BEPPYO_VEC_PACE_MS: '0', BEPPYO_VEC_POLL_MS: '0', ...env };
    for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GITHUB_ACTIONS', 'BEPPYO_APPROVED']) if (!(k in env)) delete e[k];
    const p = spawn(process.execPath, [RUN, ...args], { env: e });
    let so = '';
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { so += d; });
    p.on('close', (code) => resolve({ code, out: so }));
  });
}
async function week(n, { apply = true, approve = false, env = {} } = {}) {
  const out = path.join(TMP, `out-${n}`);
  const b = await run(['build'], { UPDATE_RUN_ID: `run-${n}`, ...env }, out);
  const mf = path.join(out, 'build', 'manifest.json');
  const m = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : null;
  const a = apply && m ? await run(['apply'], { ...(approve ? { BEPPYO_APPROVED: '1' } : {}), ...env }, out) : null;
  return { out, b, a, m };
}
const bpId = (lawId, title) => md5(`bp|${lawId}|${title}`);

async function main() {
  setArticles(); setRefs(); bumpLedger();
  const pc = await pcProduction();

  console.log('\n# 1. 初回（PC で作った今の本番がある）: 行は本文が同じなら埋め込み直さない・余った行は消す・_beppyo は全部埋め込み直す');
  let w = await week(1, { apply: false });
  check('build が通る', w.b.code === 0 && w.m, w.b.out.slice(-2000));
  check('初回は見直す対象', w.m && w.m.first_run && w.m.needs_review && w.m.ok_to_apply, JSON.stringify(w.m && { rv: w.m.review, bl: w.m.blockers }));
  check('_beppyo 3 本（PC にあった 2 本は why text・法人税法の別表は new）', w.m && w.m.counts.beppyo === 3 && w.m.vectors.upsert_text === 2 && w.m.vectors.upsert_new === 1, JSON.stringify(w.m && { c: w.m.counts, v: w.m.vectors }));
  check('大別表の行は本文が同じなので埋め込み直さない（upsert は _beppyo の 3 本だけ）・余った古い行 1 本を消す', w.m && w.m.vectors.upsert === 3 && w.m.vectors.delete === 1 && w.m.counts.rows === pc.rows, JSON.stringify(w.m && { c: w.m.counts, v: w.m.vectors }));
  let r = await run(['apply'], {}, w.out);
  check('承認なし → 反映しない', r.code !== 0 && /「反映」コメントからしか/.test(r.out), r.out.slice(-400));
  r = await run(['apply'], { BEPPYO_APPROVED: '1' }, w.out);
  const db1 = vecDb();
  const md1 = db1[bpId(TOUROKU, '別表第一')] && db1[bpId(TOUROKU, '別表第一')].metadata;
  check('承認で反映 → 状態の控えができる', r.code === 0 && readR2J('update_state/beppyo/vec_state.json'), r.out.slice(-800));
  check('別表第一の homes に refs の逆引き（第九条）と caption の条（第二条）', md1 && JSON.parse(md1.homes).map((h) => h.a).join() === '第二条,第九条', md1 && md1.homes);
  check('法人税法の別表（caption に条が無い）は refs から homes（第三十一条）', db1[bpId(HOJIN, '別表第三の二')] && /第三十一条/.test(db1[bpId(HOJIN, '別表第三の二')].metadata.homes));
  check('余った古い行は消えた・通達のベクトルは触らない', !db1[`${TOUROKU}_別表第一_g${pc.rows + 1}`] && db1[md5('tsutatsu-x')], Object.keys(db1).join(','));
  check('行の namespace は bpr_{法令ID}_b1', db1[`${TOUROKU}_別表第一_g1`] && db1[`${TOUROKU}_別表第一_g1`].namespace === `bpr_${TOUROKU}_b1`);

  console.log('\n# 2. 変わらない週 → 何もしない回');
  w = await week(2);
  check('何もしない回（nothing_to_do）', w.m && w.m.nothing_to_do && w.a && /反映するものが無い/.test(w.a.out), JSON.stringify(w.m && { v: w.m.vectors, rv: w.m.review }) + w.b.out.slice(-600));

  console.log('\n# 3. 法令の改正で大別表の行が 1 つ変わる → その行だけ埋め込み直す（見直す対象なし・自動で反映）');
  setArticles({ big: bigTable('（改）') }); bumpLedger();
  w = await week(3);
  check('行 1 本が why text・_beppyo は先頭 3 行に入るので本文が変わる', w.m && w.m.vectors.upsert_text === 2 && !w.m.needs_review, JSON.stringify(w.m && { v: w.m.vectors, rv: w.m.review }));
  check('自動で反映・行の本文（t）が新しい', w.a && w.a.code === 0 && /（改）/.test(vecDb()[`${TOUROKU}_別表第一_g1`].metadata.t), w.a && w.a.out.slice(-600));

  console.log('\n# 4. refs が変わる（別の条が別表第二を引くようになった）→ metadata だけ差し替える');
  setRefs({ [TOUROKU]: { [`${TOUROKU}_Art5_2`]: [{ target_law_id: TOUROKU, target_appdx: '別表第二' }] } });
  w = await week(4);
  check('metadata だけ 1 本（埋め込まない）', w.m && w.m.vectors.meta_update === 1 && w.m.vectors.upsert === 0, JSON.stringify(w.m && w.m.vectors));
  check('反映 → 別表第二の homes に第五条の二', w.a && w.a.code === 0 && /第五条の二/.test(vecDb()[bpId(TOUROKU, '別表第二')].metadata.homes), w.a && w.a.out.slice(-500));

  console.log('\n# 5. 別表が消える・大別表が 3 万字を切る → _beppyo と行を消す → restore で戻る');
  const small1 = { ...bigTable('（改）'), full_text: 'short' };
  setArticles({ big: small1, hojin: false }); bumpLedger();
  w = await week(5);
  const rowsBefore = Object.keys(vecDb()).filter((id) => Bp.rowIdParts(id)).length;
  check('法人税法の _beppyo 1 本と大別表の行を全部消す', w.m && w.m.vectors.delete === 1 + pc.rows, JSON.stringify(w.m && w.m.vectors));
  check('反映 → 行は 0・法人税法の _beppyo も無い', w.a && w.a.code === 0 && Object.keys(vecDb()).filter((id) => Bp.rowIdParts(id)).length === 0 && !vecDb()[bpId(HOJIN, '別表第三の二')], (w.a && w.a.out.slice(0, 1500)) + ` rowsBefore=${rowsBefore}`);
  r = await run(['restore', 'run-5'], {}, w.out);
  check('restore で戻る（行・_beppyo）', r.code === 0 && Object.keys(vecDb()).filter((id) => Bp.rowIdParts(id)).length === pc.rows && vecDb()[bpId(HOJIN, '別表第三の二')], r.out.slice(-600));
  setArticles({ big: bigTable('（改）') });

  console.log('\n# 6. 下見の後に法令の週次が反映された → 古い下見は反映しない');
  setArticles({ big: bigTable('（再改）') }); bumpLedger();
  w = await week(6, { apply: false });
  bumpLedger();
  r = await run(['apply'], {}, w.out);
  check('台帳が変わった → 書かずに止める', r.code !== 0 && /法令の週次が反映された/.test(r.out) && !/（再改）/.test(vecDb()[`${TOUROKU}_別表第一_g1`].metadata.t), r.out.slice(-500));
  w = await week(7);
  check('取り直した下見は反映できる', w.a && w.a.code === 0 && /（再改）/.test(vecDb()[`${TOUROKU}_別表第一_g1`].metadata.t), w.a && w.a.out.slice(-500));

  console.log('\n# 6b. 下見の後に refs だけ書き換わる（refs_index.json はそのまま）→ 古い下見は反映しない');
  setArticles({ big: bigTable('（再々改）') }); bumpLedger();
  w = await week('6b', { apply: false });
  const idxBefore = fs.readFileSync(rk('refs/refs_index.json'));
  setRefs({ [HOJIN]: { [`${HOJIN}_Art40`]: [{ target_law_id: HOJIN, target_appdx: '別表第三の二' }] } });
  check('（準備）refs_index.json は変わっていない', Buffer.compare(idxBefore, fs.readFileSync(rk('refs/refs_index.json'))) === 0);
  r = await run(['apply'], {}, w.out);
  check('refs のチャンクだけ変わった → 書かない', r.code !== 0 && /refs（refs）が書き換わった/.test(r.out) && !readR2J('update_state/beppyo_apply_inprogress.json'), r.out.slice(-500));
  setRefs(); setArticles({ big: bigTable('（再改）') }); bumpLedger();

  console.log('\n# 7. 止める: refs のチャンクが欠けている・別表が 1 割超減る');
  const saved = readR2J('refs/refs_chunk_001.json');
  delR2('refs/refs_chunk_001.json');
  w = await week(8, { apply: false });
  check('refs のチャンクが無い → build が落ちる（成果物なし）', w.b.code === 1 && !w.m && /refs_chunk_001\.json が無い/.test(w.b.out), w.b.out.slice(-500));
  putR2('refs/refs_chunk_001.json', saved);
  setArticles({ big: bigTable('（再改）'), small: false, hojin: false }); bumpLedger();
  w = await week(9, { apply: false, env: { BEPPYO_DROP_MIN: '0' } });
  check('_beppyo が 3 → 1 → 止める（exit 3）', w.b.code === 3 && w.m && !w.m.ok_to_apply && w.m.blockers.some((x) => /_beppyo）が 1 割超減った/.test(x)), JSON.stringify(w.m && w.m.blockers));
  setArticles({ big: bigTable('（再改）') }); bumpLedger();

  console.log('\n# 8. metadata の上限・長すぎる id');
  const many = {};
  for (let i = 1; i <= 400; i++) many[`${TOUROKU}_Art${i}_${i}`] = [{ target_law_id: TOUROKU, target_appdx: '別表第二' }];
  setRefs({ [TOUROKU]: many });
  putR2(`arts/${TOUROKU}/別表第四.json`, lawFile(TOUROKU, '登録免許税法', [{ ...bigTable(), title: '別表第四（第十条、第十一条、第十二条、第十三条関係）' }]));
  w = await week(10, { apply: false });
  const metaUp = w.m ? fs.readFileSync(path.join(w.out, 'build', 'meta_updates.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const bp2 = metaUp.find((v) => v.id === bpId(TOUROKU, '別表第二'));
  check('homes の多い別表は 10KiB に収めて止めない', w.m && w.m.ok_to_apply && w.m.notes.some((x) => /homes を \d+ 件削った/.test(x)) && bp2 && Buffer.byteLength(JSON.stringify(bp2.metadata)) <= 10240, JSON.stringify(w.m && { bl: w.m.blockers, n: w.m.notes }));
  check('id が 64 バイトを超える行は作らない（報告に出す）', w.m && w.m.notes.some((x) => /64 バイトを超える行/.test(x)), JSON.stringify(w.m && w.m.notes));

  console.log('\n# 9. 下見の途中に戻しが入る → その下見は使わない');
  setRefs(); delR2(`arts/${TOUROKU}/別表第四.json`);
  w = await week(11, { apply: false, env: { BEPPYO_TEST_MID_BUILD: `"${process.execPath}" "${RUN}" restore run-7` } });
  check('build が落ちる（成果物なし）・戻しは済んでいる', w.b.code === 1 && !w.m && /下見の途中で反映か戻しが入った/.test(w.b.out) && !/（再改）/.test(vecDb()[`${TOUROKU}_別表第一_g1`].metadata.t), w.b.out.slice(-800));

  const bump = `"${process.execPath}" -e "const p=require('path');require('fs').writeFileSync(p.join(process.env.R2_FAKE_DIR,'update_state','sync_state.json'),JSON.stringify({laws:{},n:'mid'}))"`;
  w = await week(12, { apply: false, env: { BEPPYO_TEST_MID_BUILD: bump } });
  check('下見の途中で法令の週次が反映された（台帳が変わった）→ build が落ちる', w.b.code === 1 && !w.m && /下見の途中で法令の週次が反映された/.test(w.b.out), w.b.out.slice(-600));

  console.log('\n# 10. 法令の週次の反映中・refs の法令の欠け');
  putR2('update_state/laws_apply_inprogress.json', { run_id: 'L1', mode: 'apply', started_at: 'x' });
  w = await week(13, { apply: false });
  check('法令の週次の反映中の印がある → 下見は止める（exit 3）', w.b.code === 3 && w.m && w.m.blockers.some((x) => /法令の週次の反映（run L1・apply・x 開始）が途中/.test(x)), JSON.stringify(w.m && w.m.blockers));
  delR2('update_state/laws_apply_inprogress.json');
  setArticles({ big: bigTable('（四改）') }); bumpLedger();
  w = await week(14, { apply: false });
  putR2('update_state/laws_apply_inprogress.json', { run_id: 'L2', mode: 'refs', started_at: 'y' });
  r = await run(['apply'], {}, w.out);
  check('下見の後に法令の週次の反映が始まった（印がある）→ 書かない', r.code !== 0 && /法令の週次の反映（run L2）が途中/.test(r.out), r.out.slice(-400));
  delR2('update_state/laws_apply_inprogress.json');
  const mark = `"${process.execPath}" -e "const p=require('path');require('fs').writeFileSync(p.join(process.env.R2_FAKE_DIR,'update_state','laws_apply_inprogress.json'),JSON.stringify({run_id:'L3'}))"`;
  w = await week(15, { apply: false, env: { BEPPYO_TEST_MID_BUILD: mark } });
  check('下見の途中で法令の週次の反映が始まった → build が落ちる', w.b.code === 1 && !w.m && /下見の途中で法令の週次の反映が始まった/.test(w.b.out), w.b.out.slice(-400));
  delR2('update_state/laws_apply_inprogress.json');
  const ch1 = readR2J('refs/refs_chunk_001.json');
  putR2('refs/refs_chunk_001.json', {});
  w = await week(16, { apply: false });
  check('refs_index.json が載せている法令がチャンクに無い → build が落ちる（homes を消す下見を作らない）', w.b.code === 1 && !w.m && /refs_index\.json が載せている法令の refs が無い/.test(w.b.out), w.b.out.slice(-400));
  putR2('refs/refs_chunk_001.json', { [TOUROKU]: { refs: {}, reverse_refs: {} } });
  w = await week(17, { apply: false });
  check('その法令の refs が空（{}）なのは正常 → 下見は通る', w.b.code === 0 && w.m && w.m.ok_to_apply, w.b.out.slice(-400));
  putR2('refs/refs_chunk_001.json', ch1);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
