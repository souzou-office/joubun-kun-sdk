// 廃止された法令を R2・Vectorize から消す流れの確かめ（¥0・本番に触らない・e-Gov も呼ばない）。
//
//   node scripts/update/check_repeal.cjs
//
// 作り物の R2（R2_FAKE_DIR）・Vectorize（VECTORIZE_FAKE_FILE）・e-Gov の廃止の状態（EGOV_FAKE_STATUS_FILE）で
// 05_diff → 07_apply_r2 → 08_apply_vectorize → 09_refs（extract・patch）→ 11_verify → restore_backup を流し、
//   - 台帳に無く、e-Gov が廃止と答えた法令だけ、条文ファイル・ベクトル・参照を消す（退避してから）
//   - e-Gov に無い・読めない・廃止でないと答えた法令は消さない（e-Gov に無い施行期日の政令だけは消す・2026-11-11）
//   - 台帳にある法令は触らない
//   - 戻すと元どおり
// を見る。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repeal-check-'));
const R2D = path.join(TMP, 'r2'), STATE = path.join(TMP, 'state'), VEC = path.join(TMP, 'vec.json'), EGOV = path.join(TMP, 'egov.json');
const P = 'large_law_articles_v4', RP = 'refs_chunks_v5';
let ng = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok' : 'NG'}   ${m}`); if (!c) ng++; };
const put = (key, obj) => { const p = path.join(R2D, ...key.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const exists = (key) => fs.existsSync(path.join(R2D, ...key.split('/')));
const readR2 = (key) => JSON.parse(fs.readFileSync(path.join(R2D, ...key.split('/')), 'utf8'));
const env = { ...process.env, R2_FAKE_DIR: R2D, VECTORIZE_FAKE_FILE: VEC, EGOV_FAKE_STATUS_FILE: EGOV, UPDATE_STATE_DIR: STATE, AI_FAKE: '1', UPDATE_RUN_ID: 'check-repeal', EGOV_SLEEP_MS: '0',
  ARTICLES_PREFIX: P, OLD_ARTICLES_PREFIX: P, REFS_PREFIX: RP, OLD_REFS_PREFIX: RP, UPDATE_DRY_RUN: '' };
const run = (script, ...args) => execFileSync(process.execPath, [path.join(DIR, script), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const snapshot = (root) => { const out = {}; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(root, p)] = fs.readFileSync(p, 'utf8'); } }; walk(root); return out; };

// 法令: CUR（台帳にある）・REP（台帳に無い・e-Gov で廃止）・NONE（台帳に無い・e-Gov では廃止でない）・GONE（台帳に無い・e-Gov に無い）・FAIL（台帳に無い・e-Gov を読めない）
const CUR = '999AC0000000001', REP = '999AC0000000002', NONE = '999AC0000000003', GONE = '999AC0000000004', FAIL = '999AC0000000005';
const art = (lawId, title, text) => ({ law_id: lawId, law_title: `法${lawId.slice(-1)}`, articles: [{ type: 'article', number: '', title, caption: '', structure: {}, paragraphs: [{ num: 1, sentences: [{ text }], items: [] }], full_text: text }] });
for (const id of [CUR, REP, NONE, GONE, FAIL]) {
  put(`${P}/${id}/_index.json`, { law_id: id, law_title: `法${id.slice(-1)}`, files: [{ title: '第一条', filename: '第一条.json' }, { title: '第二条', filename: '第二条.json' }], toc: [] });
  put(`${P}/${id}/第一条.json`, art(id, '第一条', `法${id.slice(-1)}の第一条の本文`));
  put(`${P}/${id}/第二条.json`, art(id, '第二条', `法${id.slice(-1)}の第二条の本文`));
}
// 参照: REP → CUR、CUR → REP（今の法令から廃止された法令への参照は今の法令の側に残る）
put(`${RP}/refs_index.json`, { [CUR]: 0, [REP]: 0 });
put(`${RP}/refs_chunk_000.json`, {
  [CUR]: { refs: { [`${CUR}_Art1`]: [{ type: 'external', target_law_id: REP, target_article: '1', target: `${REP}_Art1` }] }, reverse_refs: { [`${CUR}_Art2`]: [`${REP}_Art1`] } },
  [REP]: { refs: { [`${REP}_Art1`]: [{ type: 'external', target_law_id: CUR, target_article: '2', target: `${CUR}_Art2` }] }, reverse_refs: { [`${REP}_Art1`]: [`${CUR}_Art1`] } },
});
put('update_state/sync_state.json', { fetched_at: '2026-11-01T00:00:00Z', laws: { [CUR]: { law_title: '法1', law_revision_id: 'r1' } } });
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(path.join(STATE, 'sync_state.next.json'), JSON.stringify({ fetched_at: '2026-11-08T00:00:00Z', laws: { [CUR]: { law_title: '法1', law_revision_id: 'r1' } } }));
fs.writeFileSync(path.join(STATE, 'change_report.json'), JSON.stringify({ added: [], modified: [], removed: [REP] }));
fs.writeFileSync(path.join(STATE, 'parse_log.json'), JSON.stringify({ success: [], failed: [] }));
fs.writeFileSync(EGOV, JSON.stringify({ [REP]: { repeal_status: 'Repeal', repeal_date: '2026-10-01', law_title: '法2' }, [NONE]: { repeal_status: 'None', law_title: '法3' }, [FAIL]: '__fail__' }));
// ベクトル: 05 と同じ作り方の ID で全法令ぶん入れておく
const { paragraphRecords } = require('./lib/vectors.cjs');
const vec = {};
for (const id of [CUR, REP, NONE, GONE, FAIL]) {
  const files = { '第一条.json': readR2(`${P}/${id}/第一条.json`), '第二条.json': readR2(`${P}/${id}/第二条.json`) };
  for (const r of paragraphRecords(id, files)) vec[r.id] = { values: [0.1, 0.2], metadata: { law_id: id } };
}
fs.writeFileSync(VEC, JSON.stringify(vec));
const vecOf = (id) => Object.entries(JSON.parse(fs.readFileSync(VEC, 'utf8'))).filter(([, v]) => v.metadata && v.metadata.law_id === id).length;
const r2Before = snapshot(R2D);
const vecBefore = fs.readFileSync(VEC, 'utf8');

console.log('1. 差分（05）: 消すのは e-Gov で廃止と確かめた法令だけ');
const out05 = run('05_diff.cjs');
const m = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
ok(JSON.stringify(m.repealed) === JSON.stringify([REP]), `廃止で消す法令は ${REP} だけ（${JSON.stringify(m.repealed)}）`);
const skipped = Object.fromEntries((m.repeal_skipped || []).map((r) => [r.law_id, r.reason]));
ok(/廃止でない/.test(skipped[NONE] || '') && /e-Gov に無い/.test(skipped[GONE] || '') && /読めない/.test(skipped[FAIL] || ''), 'e-Gov で廃止でない・e-Gov に無い・読めない法令は消さずに理由を残す');
const e = m.laws[REP] || {};
ok(e.is_repeal && e.put.length === 0 && e.delete.length === 3 && e.delete[0] === '_index.json' && e.vectors.delete_count === vecOf(REP), '廃止の法令は全ファイルを消す・ベクトルを全部消す・目次から');
ok(m.ok_to_apply && !m.needs_review && !m.laws[CUR] && !m.laws[NONE], '止めない・見直す対象にしない・ほかの法令は manifest に入れない');
ok(/廃止された法令 1 を消す/.test(out05), 'ログに消す法令を出す');

console.log('2. 反映（07・08・09）と検証（11）');
run('07_apply_r2.cjs'); run('08_apply_vectorize.cjs'); run('09_refs.cjs', 'extract'); run('09_refs.cjs', 'patch'); run('11_verify.cjs');
ok(!exists(`${P}/${REP}/_index.json`) && !exists(`${P}/${REP}/第一条.json`) && !exists(`${P}/${REP}/第二条.json`), '廃止の法令の条文ファイルを消した');
ok(exists(`${P}/${CUR}/_index.json`) && exists(`${P}/${NONE}/_index.json`) && exists(`${P}/${GONE}/_index.json`) && exists(`${P}/${FAIL}/_index.json`), 'ほかの法令のファイルは残す');
ok(exists(`backup_updates/check-repeal/${P}/${REP}/_index.json`) && exists(`backup_updates/check-repeal/${P}/${REP}/第一条.json`), '消す前に退避した');
ok(vecOf(REP) === 0 && vecOf(CUR) > 0 && vecOf(NONE) > 0, '廃止の法令のベクトルだけ消した');
const ch = readR2(`${RP}/refs_chunk_000.json`);
ok(JSON.stringify(ch[REP].refs) === '{}' && !ch[CUR].reverse_refs[`${CUR}_Art2`], '廃止の法令の参照を空にし、参照先の「参照されている」からも外した');
ok(ch[CUR].refs[`${CUR}_Art1`].length === 1, '今の法令から廃止の法令への参照は今の法令の側に残す');

console.log('3. 戻す（restore_backup）');
run('restore_backup.cjs', 'check-repeal');
const after = snapshot(R2D);
const same = Object.keys(r2Before).every((k) => after[k] === r2Before[k]);
ok(same, '条文ファイル・参照のチャンクが元どおり');
ok(JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(VEC, 'utf8'))).sort()) === JSON.stringify(Object.keys(JSON.parse(vecBefore)).sort()), 'ベクトルが元どおり');
ok(!fs.existsSync(path.join(R2D, 'update_state', 'repeal_pending')) || !fs.readdirSync(path.join(R2D, 'update_state', 'repeal_pending')).length, 'この回の「消している途中」の控えも外した');

console.log('3b. 消している途中で落ちても、次の差分（05）で消し直す');
{
  run('05_diff.cjs');
  const mm = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
  const vids = mm.laws[REP].vectors.delete;
  // 07 が控えを置き、目次と第一条を消したところで落ちた（ベクトル・参照は手つかず）
  put(`update_state/repeal_pending/${REP}.json`, { law_id: REP, run_id: 'crashed-run', law_title: '法2', repeal_status: 'Repeal', files: mm.laws[REP].delete, vector_ids: vids });
  fs.rmSync(path.join(R2D, P, REP, '_index.json')); fs.rmSync(path.join(R2D, P, REP, '第一条.json'));
  run('05_diff.cjs');
  const mr = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
  const er = mr.laws[REP] || {};
  ok(er.is_repeal && er.repeal_resume && JSON.stringify(er.delete) === JSON.stringify(['第二条.json']) && JSON.stringify(er.vectors.delete) === JSON.stringify(vids), '控えから拾い直し、残りのファイルと控えのベクトルを消す対象にする');
  put('update_state/repealed_laws.json', { laws: { OLD1: { law_title: '前からの法', repeal_date: '2026-01-01' } } });
  run('07_apply_r2.cjs');
  const pm = readR2(`update_state/repeal_pending/${REP}.json`);
  ok(JSON.stringify(pm.run_ids) === JSON.stringify(['crashed-run', 'check-repeal']) && pm.files.length === 3 && JSON.stringify(pm.vector_ids) === JSON.stringify(vids), '消し直しの回は前の控えを引き継ぐ（退避した回を全部残す）');
  run('08_apply_vectorize.cjs'); run('09_refs.cjs', 'extract'); run('09_refs.cjs', 'patch'); run('10_finalize.cjs'); run('11_verify.cjs');
  ok(!exists(`${P}/${REP}/第二条.json`) && vecOf(REP) === 0 && JSON.stringify(readR2(`${RP}/refs_chunk_000.json`)[REP].refs) === '{}', '消し直して、ファイル・ベクトル・参照が全部消えた');
  ok(!exists(`update_state/repeal_pending/${REP}.json`), '最後まで通ったら控えを外す（10）');
  const rl = readR2('update_state/repealed_laws.json');
  ok(rl.laws && rl.laws[REP] && rl.laws[REP].law_title === '法2' && rl.laws[REP].repeal_status === 'Repeal' && rl.laws.OLD1 && rl.laws.OLD1.law_title === '前からの法', '消した廃止法令の一覧（題名・廃止日）に足す・前からある分は残す（10）');
  ok(JSON.stringify(readR2('backup_updates/check-repeal/update_state/repealed_laws.json')) === JSON.stringify({ laws: { OLD1: { law_title: '前からの法', repeal_date: '2026-01-01' } } }), '一覧を書き換える前に今の一覧を退避する（10）');
  // 消し直しをまたいで戻す: 前の回（crashed-run）が消した分と、消し直した回が消した分を、それぞれの回の退避から戻す
  const p1 = path.join(R2D, P, REP);
  put(`backup_updates/crashed-run/manifest.json`, { run_id: 'crashed-run', prefix: P, laws: { [REP]: { backed_up: ['_index.json', '第一条.json'], deleted: ['_index.json', '第一条.json'], put: [] } } });
  put(`backup_updates/crashed-run/${P}/${REP}/_index.json`, r2Before[path.join(P, REP, '_index.json')]);
  put(`backup_updates/crashed-run/${P}/${REP}/第一条.json`, r2Before[path.join(P, REP, '第一条.json')]);
  ok(JSON.stringify((readR2('backup_updates/check-repeal/repeal_runs.json').laws || {})[REP]) === JSON.stringify(['crashed-run', 'check-repeal']), '控えを外す前に、退避した回をこの回の退避の一覧に残す（10）');
  run('10_finalize.cjs');   // 10 の流し直し（控えはもう外れている）でも、前に残した回は消えない
  ok(JSON.stringify((readR2('backup_updates/check-repeal/repeal_runs.json').laws || {})[REP]) === JSON.stringify(['crashed-run', 'check-repeal']), '10 を流し直しても、前に残した退避した回は消えない');
  const outR = run('restore_backup.cjs', 'check-repeal', '--no-vectors');
  ok(outR.includes(`${REP} は crashed-run の回でも消している`) && !exists(`update_state/repeal_pending/${REP}.json`), '終わった回を戻すと、ほかに戻す回を出す（控えは作り直さない）');
  run('restore_backup.cjs', 'crashed-run', '--no-vectors');
  ok(['_index.json', '第一条.json', '第二条.json'].every((f) => fs.existsSync(path.join(p1, f)) && fs.readFileSync(path.join(p1, f), 'utf8') === r2Before[path.join(P, REP, f)]), '消し直しをまたいでも、両方の回を戻せば条文ファイルが全部元どおり');
  // 次の確かめのために元に戻す
  for (const [k, t] of Object.entries(r2Before)) { const p = path.join(R2D, k); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); }
  fs.writeFileSync(VEC, vecBefore);
}

console.log('4. 上限・全件の作り直し・壊れたファイル');
{
  fs.writeFileSync(EGOV, JSON.stringify({ [REP]: { repeal_status: 'Repeal' }, [NONE]: { repeal_status: 'Expire' } }));
  execFileSync(process.execPath, [path.join(DIR, '05_diff.cjs')], { env: { ...env, UPDATE_MAX_REPEALED_LAWS: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const m2 = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
  ok(!m2.ok_to_apply && m2.blockers.some((b) => b.kind === 'too_many_repealed'), '消す法令が上限を超えたら止める');
  execFileSync(process.execPath, [path.join(DIR, '05_diff.cjs')], { env: { ...env, ARTICLES_PREFIX: 'large_law_articles_v9' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const m3 = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
  ok(!(m3.repealed || []).length, '新しいプレフィックスへの全件の作り直しでは消さない');
  // 条文ファイルが JSON として読めない法令は消さない（ベクトルの ID が分からず、ファイルだけ消すとベクトルが残る）
  fs.writeFileSync(EGOV, JSON.stringify({ [REP]: { repeal_status: 'Repeal' } }));
  const f2 = path.join(R2D, P, REP, '第二条.json');
  const keep2 = fs.readFileSync(f2, 'utf8');
  fs.writeFileSync(f2, '{ 壊れた');
  run('05_diff.cjs');
  const m4 = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
  const sk4 = (m4.repeal_skipped || []).find((r) => r.law_id === REP);
  ok(!(m4.repealed || []).length && !m4.laws[REP] && sk4 && /JSON として読めない/.test(sk4.reason), '条文ファイルが壊れている法令は消さずに理由を残す');
  fs.writeFileSync(f2, keep2);
  // 目次に載った条文ファイルが R2 に無い法令も消さない（そのファイルのベクトルが残るのに目次が消えて次の回に拾えない）
  fs.rmSync(f2);
  run('05_diff.cjs');
  const m5 = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
  const sk5 = (m5.repeal_skipped || []).find((r) => r.law_id === REP);
  ok(!(m5.repealed || []).length && !m5.laws[REP] && sk5 && /目次に載った条文ファイルが R2 に無い/.test(sk5.reason), '目次に載った条文ファイルが欠けている法令は消さずに理由を残す');
  fs.writeFileSync(f2, keep2);
  const fi = path.join(R2D, P, REP, '_index.json');
  const keepI = fs.readFileSync(fi, 'utf8');
  fs.writeFileSync(fi, '{ 壊れた');
  run('05_diff.cjs');
  const m6 = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
  ok(!(m6.repealed || []).length && /目次（_index.json）が読めない/.test(((m6.repeal_skipped || []).find((r) => r.law_id === REP) || {}).reason || ''), '目次が読めない法令は消さずに理由を残す');
  fs.writeFileSync(fi, keepI);
}

console.log('5. e-Gov に無い施行期日の政令（2026-11-11 オーナー: 消す）');
{
  fs.writeFileSync(EGOV, JSON.stringify({ [REP]: { repeal_status: 'Repeal' } }));
  const gi = path.join(R2D, P, GONE, '_index.json');
  const keepG = fs.readFileSync(gi, 'utf8');
  const setTitle = (t) => fs.writeFileSync(gi, JSON.stringify({ ...JSON.parse(keepG), law_title: t }));
  setTitle('物品の額を定める政令');
  run('05_diff.cjs');
  const a = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
  ok(!(a.repealed || []).includes(GONE) && /e-Gov に無い/.test(((a.repeal_skipped || []).find((r) => r.law_id === GONE) || {}).reason || ''), 'e-Gov に無い法令でも、施行期日の政令でなければ消さない');
  for (const t of ['二酸化炭素の貯留事業に関する法律の施行期日を定める政令', '国家公務員法等の一部を改正する法律附則第四条第一項の政令で定める日等を定める政令']) {
    setTitle(t);
    run('05_diff.cjs');
    const b = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
    const g = b.laws[GONE] || {};
    ok((b.repealed || []).includes(GONE) && g.is_repeal && g.repeal_status === 'NotInEgov' && g.law_title === t && g.delete.length === 3 && g.vectors.delete_count === vecOf(GONE) && b.ok_to_apply,
      `e-Gov に無い施行期日の政令は消す（全ファイル・ベクトル・状態 NotInEgov）: ${t.slice(-20)}`);
  }
  fs.writeFileSync(gi, keepG);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(ng ? `\n${ng} 件 NG` : '\nすべて ok');
process.exit(ng ? 1 : 0);
