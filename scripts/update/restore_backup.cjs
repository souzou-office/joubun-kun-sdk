// 反映を戻す。backup_updates/{run_id}/ に退避した中身を元のキーに書き戻し、その回で新規に PUT したものを消す。
//
//   node scripts/update/restore_backup.cjs {run_id} [--dry-run] [--no-vectors]
//
// 戻るもの:
//   - 条文ファイル（上書き前の中身に戻し、その回で新規に作ったファイルは消す）
//   - 参照関係のチャンクと索引
//   - 台帳 update_state/sync_state.json と data_metadata.json（次の週次で同じ法令がもう一度「変更」として出る）
//   - Vectorize（上書き前のベクトルを upsert し直し、その回で新規に入れた ID は消す）。--no-vectors で飛ばせる
// 所要時間は数分（再ベクトル化はしない。退避したベクトルをそのまま戻す）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG, log } = require('./lib/common.cjs');
const { R2 } = require('./lib/r2.cjs');
const { Vectorize } = require('./lib/vectorize.cjs');

async function main() {
  const rid = process.argv[2];
  if (!rid || rid.startsWith('--')) { console.error('usage: restore_backup.cjs {run_id} [--dry-run] [--no-vectors]'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run') || CONFIG.dryRun;
  const r2 = new R2({ dryRun });
  const base = `${CONFIG.backupPrefix}/${rid}/`;
  const man = await r2.getJson(`${base}manifest.json`);
  if (!man) { console.error(`退避の一覧が見つかりません: ${base}manifest.json`); process.exit(1); }
  const objs = await r2.list(base);
  const skip = new Set([`${base}manifest.json`, `${base}vectors_old.ndjson`, `${base}vectors_new_ids.json`, `${base}repeal_runs.json`]);
  let restored = 0, removed = 0;
  for (const o of objs) {
    if (skip.has(o.key)) continue;
    const orig = o.key.slice(base.length);
    const buf = await r2.get(o.key);
    await r2.put(orig, buf);
    restored++;
  }
  for (const [lawId, e] of Object.entries(man.laws || {})) {
    for (const f of e.put || []) if (!(e.backed_up || []).includes(f)) { await r2.delete(`${man.prefix}/${lawId}/${f}`); removed++; }
  }
  // この回が置いた（引き継いだ）廃止の控え（消している途中の印）は外す（戻したのに次の 05 が消し直さないように）。
  // 消し直しをまたいだ法令は、控えの run_ids の回を全部戻さないと、前の回が消したファイルは戻らない（ログに出す）
  // 終わった回（10 が控えを外した）は、退避の一覧 repeal_runs.json に残した回を見る
  const done = await r2.getJson(`${base}repeal_runs.json`);
  for (const [id, runs] of Object.entries((done && done.laws) || {})) {
    const others = (runs || []).filter((x) => x && x !== rid);
    if (others.length) log(`  ${id} は ${others.join('・')} の回でも消している。全部戻すなら restore_backup.cjs をその回にも流す`);
  }
  for (const o of await r2.list(`${CONFIG.repealPendingPrefix}/`)) {
    const pj = await r2.getJson(o.key);
    const runs = pj ? (Array.isArray(pj.run_ids) ? pj.run_ids : [pj.run_id]) : [];
    if (!runs.includes(rid)) continue;
    await r2.delete(o.key); removed++;
    const others = runs.filter((x) => x && x !== rid);
    if (others.length) log(`  ${pj.law_id} は ${others.join('・')} の回でも消している。全部戻すなら restore_backup.cjs をその回にも流す`);
  }
  log(`R2: 戻した ${restored} 件、新規分の削除 ${removed} 件${dryRun ? '（dry-run）' : ''}`);

  if (!process.argv.includes('--no-vectors')) {
    const oldNd = await r2.get(`${base}vectors_old.ndjson`);
    const newIds = await r2.getJson(`${base}vectors_new_ids.json`);
    if (oldNd || newIds) {
      const vz = new Vectorize({ dryRun, index: (newIds && newIds.index) || undefined });
      const oldVecs = oldNd ? oldNd.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
      if (oldVecs.length) await vz.upsert(oldVecs);
      const toDelete = (newIds && newIds.new_ids) || [];
      if (toDelete.length) await vz.deleteByIds(toDelete);
      log(`Vectorize: 戻した ${oldVecs.length} 件、新規分の削除 ${toDelete.length} 件${dryRun ? '（dry-run）' : ''}`);
    } else {
      log('Vectorize: この回の退避が無い（古い形式の退避）。元の本文で 06→08 を流し直してください');
    }
  }
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
