// Phase 3: Vectorize に反映する（退避 → upsert → delete）。承認後の apply でだけ動かす。
//
//   node scripts/update/08_apply_vectorize.cjs [--force]
//
// 入力: state/vectors.ndjson（06 の出力）、state/manifest.json（削除する ID）
// 退避: 上書き・削除される ID の今のベクトル（values 込み）を Vectorize から取り、
//       backup_updates/{run_id}/vectors_old.ndjson と vectors_new_ids.json に置く（restore_backup.cjs が使う）
// 出力: state/apply_vectorize_log.json
const fs = require('fs');
const readline = require('readline');
const { CONFIG, statePath, readJson, writeJson, log, runId } = require('./lib/common.cjs');
const { Vectorize } = require('./lib/vectorize.cjs');
const { R2 } = require('./lib/r2.cjs');

async function main() {
  const force = process.argv.includes('--force');
  const manifest = readJson(statePath('manifest.json'));
  if (!manifest.ok_to_apply && !force) { console.error('manifest に blockers があります（--force で流せる）'); process.exit(2); }
  const vz = new Vectorize();
  const r2 = new R2();
  const rid = manifest.run_id || runId();

  const vecFile = statePath('vectors.ndjson');
  const upsertIds = [];
  if (fs.existsSync(vecFile)) for await (const line of readline.createInterface({ input: fs.createReadStream(vecFile) })) { if (line.trim()) upsertIds.push(JSON.parse(line).id); }
  const delIds = [];
  for (const e of Object.values(manifest.laws)) delIds.push(...(e.vectors.delete || []));

  // 1. 退避（今あるものだけ。無い ID は「新規」として記録）
  //    同じ run の退避がすでに R2 にあれば上書きしない（流し直しのとき、upsert 後の値で退避を潰すと戻せなくなる）
  const affected = [...new Set([...upsertIds, ...delIds])];
  const backupKey = `${CONFIG.backupPrefix}/${rid}/vectors_old.ndjson`;
  const existing = r2.dryRun || r2.fakeDir ? null : await r2.get(backupKey);
  let old = [];
  if (existing) {
    old = existing.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    log(`退避: すでにある ${backupKey}（${old.length} 件）をそのまま使う（流し直し）`);
  } else {
    old = affected.length ? await vz.getByIds(affected) : [];
    const oldNd = old.map((v) => JSON.stringify(v)).join('\n') + (old.length ? '\n' : '');
    fs.writeFileSync(statePath('vectors_old.ndjson'), oldNd, 'utf8');
    await r2.put(backupKey, oldNd, 'application/x-ndjson');
  }
  const oldIds = new Set(old.map((v) => v.id));
  const newOnly = upsertIds.filter((id) => !oldIds.has(id));
  await r2.put(`${CONFIG.backupPrefix}/${rid}/vectors_new_ids.json`, { run_id: rid, index: vz.index, new_ids: newOnly, deleted_ids: delIds });
  log(`退避: 既存 ${old.length} 件（新規 ${newOnly.length}、削除予定 ${delIds.length}）`);

  // 2. upsert
  let upserted = 0;
  if (fs.existsSync(vecFile)) {
    let batch = [];
    for await (const line of readline.createInterface({ input: fs.createReadStream(vecFile) })) {
      if (!line.trim()) continue;
      batch.push(JSON.parse(line));
      if (batch.length >= 1000) { await vz.upsert(batch); upserted += batch.length; batch = []; }
    }
    if (batch.length) { await vz.upsert(batch); upserted += batch.length; }
  }
  // 3. delete
  if (delIds.length) await vz.deleteByIds(delIds);
  writeJson(statePath('apply_vectorize_log.json'), { finished_at: new Date().toISOString(), upserted, deleted: delIds.length, backed_up: old.length, new_only: newOnly.length, ops: vz.ops, dryRun: vz.dryRun }, true);
  log(`完了: upsert=${upserted} delete=${delIds.length}${vz.dryRun ? '（dry-run）' : ''}`);
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
