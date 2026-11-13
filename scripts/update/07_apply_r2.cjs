// Phase 3: R2 に反映する（退避 → 上書き → 削除）。承認後の apply でだけ動かす。
//
//   node scripts/update/07_apply_r2.cjs [--force] [--concurrency 16]   並列数は法令 ×8 ファイルに分ける（UPDATE_CONCURRENCY でも指定可）
//
// 入力: state/manifest.json、state/out/、state/old/
// 手順（法令ごと）:
//   1. 上書き・削除される今のファイルを backup_updates/{run_id}/{prefix}/{law_id}/ に退避（state/old から PUT）
//   2. 新ファイルを PUT（_index.json は最後。途中で落ちても目次だけ古いままで済む）
//   3. 消えたファイルを DELETE
// 出力: state/apply_r2_log.json、R2 の backup_updates/{run_id}/manifest.json（戻すときの一覧）
// 戻し方: node scripts/update/restore_backup.cjs {run_id}
const fs = require('fs');
const path = require('path');
const { CONFIG, statePath, readJson, writeJson, log, runId } = require('./lib/common.cjs');
const { R2 } = require('./lib/r2.cjs');

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const concurrency = args.includes('--concurrency') ? Number(args[args.indexOf('--concurrency') + 1]) : Number(process.env.UPDATE_CONCURRENCY || 16);
  const manifest = readJson(statePath('manifest.json'));
  if (!manifest.ok_to_apply && !force) { console.error('manifest に blockers があります。内容を確認し、流すなら --force'); console.error(JSON.stringify(manifest.blockers, null, 2)); process.exit(2); }
  const r2 = new R2();
  const rid = manifest.run_id || runId();
  const prefix = manifest.articles_prefix || CONFIG.articlesPrefix;
  log(`R2 反映 run_id=${rid} prefix=${prefix} dryRun=${r2.dryRun} laws=${Object.keys(manifest.laws).length}`);

  const backupIndex = { run_id: rid, created_at: new Date().toISOString(), prefix, laws: {} };
  const logOut = { run_id: rid, started_at: new Date().toISOString(), laws: {}, errors: [] };
  // 法令をまたいで並列に書く（1 法令のファイル数は少ないので、法令ごとに逐次だと並列が効かない。
  // run #10 の apply は逐次で 286,878 ファイルに 3 時間以上かかった）。法令の中では _index.json を最後に書く順序を守る
  const entries = Object.entries(manifest.laws);
  const lawPar = Math.max(1, Math.floor(concurrency / 8)), filePar = Math.min(8, concurrency);
  let n = 0;
  await R2.pmap(entries, lawPar, async ([lawId, e]) => {
    const lawPrefix = `${prefix}/${lawId}/`;
    const outDir = statePath('out', lawId), oldDir = statePath('old', lawId);
    const backedUp = [];
    try {
      // 0. 廃止で消す法令は、消す前に控え（ファイル名・ベクトルの ID）を置く。途中で落ちて目次が消えても、次の 05 がこれで拾い直す。10 が外す
      // 消し直し（前の回が落ちた）のときは前の控えを引き継ぐ: 退避した回（run_ids）を全部残し、ファイル名・ベクトルの ID は合わせる（戻すときは run_ids の回を全部戻す）
      if (e.is_repeal) {
        const pk = `${CONFIG.repealPendingPrefix}/${lawId}.json`;
        const prevP = (await r2.getJson(pk)) || null;
        const prevRuns = prevP ? (Array.isArray(prevP.run_ids) ? prevP.run_ids : [prevP.run_id].filter(Boolean)) : [];
        const uniq = (a) => [...new Set(a)];
        await r2.put(pk, { law_id: lawId, run_id: rid, run_ids: uniq([...prevRuns, rid]), law_title: e.law_title || (prevP && prevP.law_title) || null,
          repeal_status: e.repeal_status || (prevP && prevP.repeal_status) || null, repeal_date: e.repeal_date || (prevP && prevP.repeal_date) || null,
          files: uniq([...((prevP && prevP.files) || []), ...e.delete]), vector_ids: uniq([...((prevP && prevP.vector_ids) || []), ...((e.vectors && e.vectors.delete) || [])]),
          created_at: (prevP && prevP.created_at) || new Date().toISOString() });
      }
      // 1. 退避（state/old に写しが無ければ R2 から取る。artifact を小さくするため old/ は持ち回らない）
      const toBackup = e.is_new ? [] : [...e.put, ...e.delete];
      await R2.pmap(toBackup, filePar, async (f) => {
        const local = path.join(oldDir, f);
        const buf = fs.existsSync(local) ? fs.readFileSync(local) : await r2.get(lawPrefix + f);
        if (!buf) return;   // 今 R2 に無い＝新規ファイル
        await r2.put(`${CONFIG.backupPrefix}/${rid}/${lawPrefix}${f}`, buf);
        backedUp.push(f);
      });
      // 2. 上書き（_index.json は最後）
      const puts = e.put.filter((f) => f !== '_index.json');
      await R2.pmap(puts, filePar, async (f) => r2.put(lawPrefix + f, fs.readFileSync(path.join(outDir, f))));
      if (e.put.includes('_index.json')) await r2.put(lawPrefix + '_index.json', fs.readFileSync(path.join(outDir, '_index.json')));
      // 3. 削除
      await R2.pmap(e.delete, filePar, async (f) => r2.delete(lawPrefix + f));
      backupIndex.laws[lawId] = { backed_up: backedUp, deleted: e.delete, put: e.put };
      logOut.laws[lawId] = { put: e.put.length, delete: e.delete.length, backed_up: backedUp.length };
    } catch (err) {
      logOut.errors.push({ law_id: lawId, error: err.message });
      log(`  ERROR ${lawId}: ${err.message}`);
    }
    n++;
    if (n % 200 === 0) log(`  ${n}/${entries.length}`);
  });
  await r2.put(`${CONFIG.backupPrefix}/${rid}/manifest.json`, backupIndex);
  logOut.finished_at = new Date().toISOString();
  logOut.writes = r2.writes.length;
  writeJson(statePath('apply_r2_log.json'), logOut, true);
  log(`完了: writes=${r2.writes.length} errors=${logOut.errors.length}${r2.dryRun ? '（dry-run: 実際には書いていない）' : ''}`);
  if (logOut.errors.length) process.exit(1);
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
