// Phase 5: 反映後の検証。R2 の中身が state/out と一致するか、Vectorize に ID が入ったか／消えたかを抜き取りで確認する。
//
//   node scripts/update/11_verify.cjs [--sample 30]
//
// 出力: state/verify.json。不一致があれば終了コード 1
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { CONFIG, statePath, readJson, writeJson, log, sha256 } = require('./lib/common.cjs');
const { R2 } = require('./lib/r2.cjs');
const { Vectorize } = require('./lib/vectorize.cjs');

async function main() {
  const sample = process.argv.includes('--sample') ? Number(process.argv[process.argv.indexOf('--sample') + 1]) : 30;
  const manifest = readJson(statePath('manifest.json'));
  const r2 = new R2();
  const prefix = manifest.articles_prefix || CONFIG.articlesPrefix;
  const lawIds = Object.keys(manifest.laws);
  const pick = lawIds.length <= sample ? lawIds : lawIds.filter((_, i) => i % Math.ceil(lawIds.length / sample) === 0).slice(0, sample);
  const mismatches = [], checked = [];
  for (const lawId of pick) {
    const e = manifest.laws[lawId];
    const files = ['_index.json', ...e.put.filter((f) => f !== '_index.json').slice(0, 3)];
    for (const f of files) {
      if (!e.put.includes(f)) continue;
      const local = fs.readFileSync(path.join(statePath('out', lawId), f));
      const remote = await r2.get(`${prefix}/${lawId}/${f}`);
      checked.push(`${lawId}/${f}`);
      if (!remote || sha256(remote) !== sha256(local)) mismatches.push({ kind: 'r2', key: `${prefix}/${lawId}/${f}`, remote: !!remote });
    }
    for (const f of e.delete.slice(0, 3)) {
      const remote = await r2.get(`${prefix}/${lawId}/${f}`);
      checked.push(`${lawId}/${f} (deleted)`);
      if (remote) mismatches.push({ kind: 'r2_not_deleted', key: `${prefix}/${lawId}/${f}` });
    }
  }
  // Vectorize
  const vz = new Vectorize();
  const upIds = [];
  const vecFile = statePath('vectors.ndjson');
  if (fs.existsSync(vecFile)) for await (const line of readline.createInterface({ input: fs.createReadStream(vecFile) })) { if (line.trim() && upIds.length < 200) upIds.push(JSON.parse(line).id); }
  const delIds = [];
  for (const e of Object.values(manifest.laws)) for (const id of e.vectors.delete || []) if (delIds.length < 100) delIds.push(id);
  const upPick = upIds.filter((_, i) => i % Math.max(1, Math.ceil(upIds.length / 40)) === 0);
  if (upPick.length) {
    const found = new Set((await vz.getByIds(upPick)).map((v) => v.id));
    for (const id of upPick) if (!found.has(id)) mismatches.push({ kind: 'vector_missing', id });
  }
  if (delIds.length) {
    const found = (await vz.getByIds(delIds.slice(0, 40))).map((v) => v.id);
    for (const id of found) mismatches.push({ kind: 'vector_not_deleted', id });
  }
  const out = { verified_at: new Date().toISOString(), laws_sampled: pick.length, files_checked: checked.length, vectors_checked: upPick.length + Math.min(delIds.length, 40), mismatches, dryRun: CONFIG.dryRun };
  writeJson(statePath('verify.json'), out, true);
  log(`検証: 法令 ${pick.length} / ファイル ${checked.length} / ベクトル ${out.vectors_checked} → 不一致 ${mismatches.length}`);
  if (mismatches.length && !CONFIG.dryRun) { log(JSON.stringify(mismatches.slice(0, 10), null, 2)); process.exit(1); }
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
