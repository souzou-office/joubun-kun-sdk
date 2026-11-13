// 法令の週次の反映中の印（apply_mark.cjs）の確かめ（¥0・偽の R2）
//
//   node scripts/update/check_apply_mark.cjs
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-mark-'));
const MARK = path.join(TMP, 'update_state', 'laws_apply_inprogress.json');
let pass = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ''}`); } };
const run = (...args) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply_mark.cjs'), ...args], { env: { ...process.env, R2_FAKE_DIR: TMP, UPDATE_RUN_ID: `r-${args.join('-')}`, UPDATE_DRY_RUN: '' }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const mark = () => (fs.existsSync(MARK) ? JSON.parse(fs.readFileSync(MARK, 'utf8')) : null);

let r = run('set', 'apply');
check('apply が印を置く', r.code === 0 && mark() && mark().mode === 'apply', r.out);
r = run('set', 'refs');
check('apply が途中のまま refs を流す → 置かない（apply の印を上書きしない）', r.code !== 0 && /apply（run r-set-apply/.test(r.out) && mark().mode === 'apply', r.out);
r = run('clear', 'refs');
check('refs では apply の印を外さない', r.code !== 0 && mark() && mark().mode === 'apply', r.out);
r = run('set', 'apply');
check('apply の流し直しは印を引き継ぐ（前の回を残す）', r.code === 0 && mark().mode === 'apply' && mark().resumed_from === 'r-set-apply', r.out);
r = run('clear', 'apply');
check('apply が通れば印を外す', r.code === 0 && !mark(), r.out);
r = run('clear', 'refs');
check('印が無ければ外すのは何もしない', r.code === 0 && !mark(), r.out);
r = run('set', 'refs');
check('印が無ければ refs も置ける', r.code === 0 && mark().mode === 'refs', r.out);
run('clear', 'refs');
r = run('set', 'bogus');
check('知らない mode は断る', r.code === 2, r.out);

const put = (k, o) => { const f = path.join(TMP, ...k.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const del = (k) => fs.rmSync(path.join(TMP, ...k.split('/')), { force: true });
put('update_state/beppyo_apply_inprogress.json', { run_id: 'b1', started_at: new Date().toISOString() });
r = run('set', 'apply');
check('別表の反映が動いている → 法令の反映は印を置かずに止まる', r.code !== 0 && /beppyo_apply_inprogress\.json・run b1/.test(r.out) && !mark(), r.out);
put('update_state/laws_apply_inprogress.json', { run_id: 'old', mode: 'apply', started_at: 'x' });
r = run('set', 'apply');
check('　前の途中の印があるときは、その印に戻して止まる', r.code !== 0 && mark() && mark().run_id === 'old', r.out);
del('update_state/laws_apply_inprogress.json');
put('update_state/beppyo_apply_inprogress.json', { run_id: 'b0', started_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString() });
r = run('set', 'apply');
check('別表の印が古い（落ちて残ったもの）→ 法令の反映は止めない', r.code === 0 && mark() && mark().mode === 'apply', r.out);
run('clear', 'apply');
del('update_state/beppyo_apply_inprogress.json');
put('update_state/delegations_apply_inprogress.json', { run_id: 'd1', started_at: new Date().toISOString() });
r = run('set', 'refs');
check('委任先の反映が動いている → refs も止まる', r.code !== 0 && /delegations_apply_inprogress/.test(r.out) && !mark(), r.out);
del('update_state/delegations_apply_inprogress.json');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
