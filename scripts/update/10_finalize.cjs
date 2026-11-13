// Phase 4: 台帳と日付メタを更新し、報告（state/report.md）を書く。apply の最後に動かす。
//
//   node scripts/update/10_finalize.cjs [--report-only]
//
// - 台帳: state/sync_state.next.json → R2 update_state/sync_state.json（apply が通ったときだけ昇格）
// - 日付メタ: R2 data_metadata.json { fetched_at, total_count, uploaded_at, run_id }（画面の「○月○日時点」）
// - 報告: state/report.md（GitHub Actions の Job Summary にも出す）
const fs = require('fs');
const { CONFIG, statePath, readJson, writeJson, log, runId, isReviewLaw, reviewCaptionKinds } = require('./lib/common.cjs');
const { R2 } = require('./lib/r2.cjs');

function buildReport(manifest, extra = {}) {
  const t = manifest.totals || {};
  const lines = [];
  lines.push(`# 法令データ更新 ${manifest.run_id || ''}`.trim());
  lines.push('');
  lines.push(`- モード: ${manifest.mode}　対象法令: ${t.laws}　R2 prefix: ${manifest.articles_prefix}`);
  lines.push(`- ファイル: 上書き ${t.put} / 削除 ${t.delete} / 変更なし ${t.unchanged_files}`);
  lines.push(`- ベクトル: upsert ${t.vec_upsert} / delete ${t.vec_delete}`);
  lines.push(`- 宙に浮く紐付け: この更新で新たに ${t.dangling}（もとから浮いていた ${t.dangling_preexisting || 0} は見直し不要）　条番号の振り直し疑い: ${t.renumber}`);
  if (extra.refs) lines.push(`- 参照関係: refs ${extra.refs.refs_old}→${extra.refs.refs_new}、被参照 +${extra.refs.rev_added} −${extra.refs.rev_removed}`);
  lines.push(`- 判定: ${manifest.ok_to_apply ? '反映可' : '**止めた（blockers あり）**'}`);
  if (manifest.blockers && manifest.blockers.length) {
    lines.push(''); lines.push('## 止めた理由');
    for (const b of manifest.blockers) lines.push(`- ${b.kind}: ${JSON.stringify(b).slice(0, 300)}`);
  }
  if (manifest.repealed && manifest.repealed.length) {
    lines.push(''); lines.push(`## 廃止された法令（${manifest.repealed.length}。e-Gov で廃止を確かめ、条文ファイルとベクトルを退避してから消す）`);
    const info = new Map((manifest.repealed_info || []).map((r) => [r.law_id, r]));
    for (const id of manifest.repealed.slice(0, 50)) { const r = info.get(id) || {}; lines.push(`- ${id}${r.law_title ? ` ${r.law_title}` : ''}${r.repeal_date ? `（${r.repeal_date} ${r.repeal_status || ''}）` : ''}`); }
  }
  if (manifest.repeal_skipped && manifest.repeal_skipped.length) {
    lines.push(''); lines.push(`## 台帳に無いが消さなかった法令（${manifest.repeal_skipped.length}。e-Gov で廃止と確かめられなかった）`);
    for (const r of manifest.repeal_skipped.slice(0, 50)) lines.push(`- ${r.law_id}${r.law_title ? ` ${r.law_title}` : ''}: ${r.reason}`);
  }
  const laws = Object.entries(manifest.laws || {});
  const flagged = laws.filter(([, e]) => isReviewLaw(e));   // 委任先だけの見出しの変化は出さない（委任先の週次がやり直す）
  if (flagged.length) {
    lines.push(''); lines.push(`## 見直す対象（${flagged.length} 法令）`);
    lines.push('| 法令 | 条数 | 一致率 | 振り直し | 宙に浮く紐付け | 見出し変化 |');
    lines.push('|---|---|---|---|---|---|');
    for (const [id, e] of flagged.slice(0, 200)) {
      const d = Object.entries(e.dangling || {}).map(([k, v]) => `${k}:${v.length}（${v.slice(0, 5).join(',')}${v.length > 5 ? '…' : ''}）`).join(' ');
      const c = reviewCaptionKinds(e).map((k) => `${k}:${e.caption_changed[k].length}`).join(' ');
      lines.push(`| ${e.law_title || id} \`${id}\` | ${e.articles_old}→${e.articles_new} | ${e.title_similarity} | ${e.renumber ? '疑い' : ''} | ${d} | ${c} |`);
    }
  }
  // 改正前から無い条番号を指していた紐付け（削除済み条への判例・事例など）はこの更新で壊れるものではないので、件数（上の「もとから浮いていた」）だけ出す
  // 一覧は長いので畳む（Issue で見るのは上の「止めた理由」「見直す対象」）
  lines.push(''); lines.push(`<details><summary>変わった法令（${laws.length}）</summary>`); lines.push('');
  lines.push('| 法令 | 上書き | 削除 | 条数 | ベクトル upsert/delete |');
  lines.push('|---|---|---|---|---|');
  for (const [id, e] of laws.slice(0, 300)) lines.push(`| ${e.law_title || ''} \`${id}\`${e.is_new ? '（新規）' : ''} | ${e.put.length} | ${e.delete.length} | ${e.articles_old}→${e.articles_new} | ${e.vectors.upsert}/${e.vectors.delete_count} |`);
  if (laws.length > 300) lines.push(`（ほか ${laws.length - 300} 法令）`);
  lines.push(''); lines.push('</details>');
  return lines.join('\n') + '\n';
}

async function main() {
  const reportOnly = process.argv.includes('--report-only');
  const manifest = readJson(statePath('manifest.json'));
  const refsLog = readJson(statePath('apply_refs_log.json'), null);
  const md = buildReport(manifest, { refs: refsLog });
  fs.writeFileSync(statePath('report.md'), md, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  log(md.split('\n').slice(0, 12).join('\n'));
  if (reportOnly) return;

  const r2 = new R2();
  const next = readJson(statePath('sync_state.next.json'), null);
  if (!next) { log('sync_state.next.json が無いので台帳は更新しない'); return; }
  const rid = manifest.run_id || runId();
  // 台帳と日付メタも退避（restore_backup.cjs が一緒に戻す）
  const prevLedger = await r2.get(CONFIG.ledgerKey);
  if (prevLedger) await r2.put(`${CONFIG.backupPrefix}/${rid}/${CONFIG.ledgerKey}`, prevLedger);
  const prevMeta = await r2.get(CONFIG.metadataKey);
  if (prevMeta) await r2.put(`${CONFIG.backupPrefix}/${rid}/${CONFIG.metadataKey}`, prevMeta);
  const ledger = { ...next, promoted_at: new Date().toISOString(), run_id: rid };
  await r2.put(CONFIG.ledgerKey, ledger);
  const meta = { fetched_at: next.fetched_at, total_count: next.total_count, uploaded_at: new Date().toISOString(), run_id: rid };
  await r2.put(CONFIG.metadataKey, meta);
  writeJson(statePath('sync_state.json'), ledger, true);   // ローカルの台帳も合わせる（Actions では artifact に残る）
  // 廃止で消した法令の控えを外す（07・08・09 が通った後。ここまで来なければ残り、次の 05 が消し直す）
  // 外す前に、どの回が退避したか（run_ids）をこの回の退避の一覧 repeal_runs.json に残す（消し直しをまたいだ法令を戻すとき、どの回も戻すかを restore_backup.cjs が出せるように）
  const prevRuns = await r2.getJson(`${CONFIG.backupPrefix}/${rid}/repeal_runs.json`);   // 10 の流し直し: 前に書いた分（もう控えを外した法令）を残して合わせる
  const runsOf = { ...((prevRuns && prevRuns.laws) || {}) };
  for (const id of manifest.repealed || []) {
    const pj = await r2.getJson(`${CONFIG.repealPendingPrefix}/${id}.json`);
    if (pj) runsOf[id] = [...new Set([...(runsOf[id] || []), ...(Array.isArray(pj.run_ids) ? pj.run_ids : [pj.run_id].filter(Boolean))])];
  }
  if (Object.keys(runsOf).length) await r2.put(`${CONFIG.backupPrefix}/${rid}/repeal_runs.json`, { run_id: rid, laws: runsOf });
  // 消した廃止法令の一覧（条文ページが消した法令の URL に「廃止されました」と e-Gov へのリンクを出す・worker/lawpages.js の REPEALED_KEY）。題名・廃止日だけ
  if ((manifest.repealed || []).length) {
    // 上書きの前に今の一覧を退避する（台帳と同じ置き方。restore_backup.cjs が一緒に戻す）
    const prevList = await r2.get(CONFIG.repealedListKey);
    if (prevList) await r2.put(`${CONFIG.backupPrefix}/${rid}/${CONFIG.repealedListKey}`, prevList);
    const cur = prevList ? JSON.parse(prevList.toString('utf8')) : {};
    const listed = cur.laws && typeof cur.laws === 'object' ? cur.laws : {};
    const info = new Map((manifest.repealed_info || []).map((r) => [r.law_id, r]));
    for (const id of manifest.repealed) {
      const r = info.get(id) || {};
      listed[id] = { law_title: r.law_title || (listed[id] && listed[id].law_title) || null, repeal_date: r.repeal_date || (listed[id] && listed[id].repeal_date) || null,
        repeal_status: r.repeal_status || (listed[id] && listed[id].repeal_status) || null, removed_at: new Date().toISOString(), run_id: rid };
    }
    await r2.put(CONFIG.repealedListKey, { updated_at: new Date().toISOString(), laws: listed });
  }
  for (const id of manifest.repealed || []) await r2.delete(`${CONFIG.repealPendingPrefix}/${id}.json`);
  log(`台帳を昇格: ${CONFIG.ledgerKey}（${Object.keys(next.laws).length} 件, fetched_at=${next.fetched_at}）、${CONFIG.metadataKey} 更新${r2.dryRun ? '（dry-run）' : ''}`);
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
