// prepare の成果物（state/）を R2 に退避する／取り戻す。
//
//   node scripts/update/stash_state.cjs push [run_id]   state/ を tar.gz にして R2 の update_state/runs/{run_id}/state.tar.gz に置く
//   node scripts/update/stash_state.cjs pull <run_id>   その tar.gz を取って state/ に展開する
//
// 用途: 全件再構築（prepare 3〜4 時間 + apply 1〜2 時間）が GitHub Actions のジョブ上限（6 時間）に収まらないので、
// prepare と apply を別ジョブに分け、間を R2 で渡す。GitHub の artifact は容量に課金があるので使わない。
// 退避から外すもの: xml/（e-Gov から取り直せる）、old/（同じプレフィックスの週次でだけ使う退避用の写し。apply では 07 が
// 無ければ R2 から読む）、embed_inputs.jsonl（06 の入力。vectors.ndjson ができていれば要らない）。
// 本文（条文）は入るが、ユーザーの情報は一切含まない。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { CONFIG, STATE_DIR, log, runId } = require('./lib/common.cjs');
const { R2 } = require('./lib/r2.cjs');

const keyOf = (rid) => `update_state/runs/${rid}/state.tar.gz`;

async function push(rid) {
  const tmp = path.join(os.tmpdir(), `state-${rid}.tar.gz`);
  const excludes = ['--exclude=./xml', '--exclude=./old', '--exclude=./embed_inputs.jsonl'];
  const r = spawnSync('tar', ['-czf', tmp, '-C', STATE_DIR, ...excludes, '.'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar が失敗（exit ${r.status}）`);
  const buf = fs.readFileSync(tmp);
  const r2 = new R2();
  await r2.put(keyOf(rid), buf, 'application/gzip');
  log(`退避: ${keyOf(rid)}（${(buf.length / 1048576).toFixed(1)} MB${r2.dryRun ? '・dry-run' : ''}）`);
  fs.unlinkSync(tmp);
}

async function pull(rid) {
  const r2 = new R2();
  const buf = await r2.get(keyOf(rid));
  if (!buf) throw new Error(`退避が見つからない: ${keyOf(rid)}`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = path.join(os.tmpdir(), `state-${rid}.tar.gz`);
  fs.writeFileSync(tmp, buf);
  const r = spawnSync('tar', ['-xzf', tmp, '-C', STATE_DIR], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar が失敗（exit ${r.status}）`);
  fs.unlinkSync(tmp);
  const man = path.join(STATE_DIR, 'manifest.json');
  log(`取得: ${keyOf(rid)}（${(buf.length / 1048576).toFixed(1)} MB）→ ${STATE_DIR}${fs.existsSync(man) ? '（manifest.json あり）' : '（manifest.json が無い！）'}`);
  if (!fs.existsSync(man)) process.exit(1);
}

const [mode, arg] = process.argv.slice(2);
(async () => {
  if (mode === 'push') await push(arg || process.env.UPDATE_RUN_ID || runId());
  else if (mode === 'pull') { if (!arg) throw new Error('pull には run_id が要る'); await pull(arg); }
  else { console.error('usage: stash_state.cjs push [run_id] | pull <run_id>'); process.exit(1); }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
