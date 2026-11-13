// Phase 1 Step C: 変更のあった法令の XML を e-Gov から取る。
//
//   node scripts/update/03_fetch_changed_laws.cjs [--resume] [--concurrency 4]
//
// 入力: state/change_report.json（added + modified）
// 出力: state/xml/{law_id}.xml、state/fetch_log.json
const fs = require('fs');
const path = require('path');
const { CONFIG, statePath, readJson, writeJson, log, ensureDir, sleep } = require('./lib/common.cjs');
const { fetchLawXml, SLEEP_MS } = require('./lib/egov_api.cjs');
const { R2 } = require('./lib/r2.cjs');

async function main() {
  const args = process.argv.slice(2);
  const resume = args.includes('--resume');
  const concurrency = args.includes('--concurrency') ? Number(args[args.indexOf('--concurrency') + 1]) : 4;
  const report = readJson(statePath('change_report.json'));
  const targets = [...report.added, ...report.modified.map((m) => m.law_id)];
  // law_id → 改正 ID（未施行の新法は law_id では 404 になるが、改正 ID なら本文が取れる。2026-09-21 の 508AC1000000078）
  const next = readJson(statePath('sync_state.next.json'), { laws: {} });
  const revisionOf = (lawId) => { const m = (report.modified || []).find((x) => x.law_id === lawId); return (m && m.new_revision_id) || ((next.laws || {})[lawId] || {}).law_revision_id || null; };
  const xmlDir = ensureDir(statePath('xml'));
  log(`XML 取得: ${targets.length} 法令（並列 ${concurrency}）`);

  const done = [], failed = [], viaRevision = [];
  let i = 0, t0 = Date.now();
  await R2.pmap(targets, concurrency, async (lawId) => {
    const out = path.join(xmlDir, `${lawId}.xml`);
    if (resume && fs.existsSync(out) && fs.statSync(out).size > 0) { done.push({ law_id: lawId, bytes: fs.statSync(out).size, cached: true }); return; }
    try {
      let xml;
      try { xml = await fetchLawXml(lawId); } catch (e) {
        const rev = /HTTP 404/.test(e.message) ? revisionOf(lawId) : null;
        if (!rev) throw e;
        xml = await fetchLawXml(rev);   // 改正 ID で取り直す（未施行の版）
        viaRevision.push(lawId);
      }
      fs.writeFileSync(out, xml, 'utf8');
      done.push({ law_id: lawId, bytes: Buffer.byteLength(xml) });
    } catch (e) {
      failed.push({ law_id: lawId, error: e.message });
    }
    i++;
    if (i % 50 === 0) log(`  ${i}/${targets.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
    await sleep(SLEEP_MS);
  });
  writeJson(statePath('fetch_log.json'), { fetched_at: new Date().toISOString(), done: done.length, failed, via_revision: viaRevision, bytes: done.reduce((s, d) => s + d.bytes, 0) }, true);
  log(`完了: ${done.length} 件, 失敗 ${failed.length} 件, ${(done.reduce((s, d) => s + d.bytes, 0) / 1e6).toFixed(1)} MB${viaRevision.length ? `（改正 ID で取得 ${viaRevision.length} 件: ${viaRevision.slice(0, 5).join(', ')}）` : ''}`);
  if (failed.length) { log('失敗:', failed.slice(0, 10)); }
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
