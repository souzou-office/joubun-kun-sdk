// 参照関係（refs_chunks）の差分更新。
//
//   node scripts/update/09_refs.cjs extract   変わった法令の XML から refs を抽出 → state/refs/{law_id}.json（prepare 側・R2 に書かない）
//   node scripts/update/09_refs.cjs patch [--rebuild-reverse]   R2 の refs チャンクに差し込む（apply 側）。退避してから PUT。OLD_REFS_PREFIX が REFS_PREFIX と違えば reverse_refs を全法令から作り直す
//   --refs-only   refs だけ作り直す（run.cjs refs）。manifest は見ない: extract は state/xml にある全法令、patch は state/refs にある全法令を対象にし、
//                 退避 ID は今回の実行 ID（UPDATE_RUN_ID）
//
// patch の考え方:
//   - その法令の refs（参照している側）はまるごと差し替える
//   - reverse_refs（参照されている側）は法令をまたぐので、旧 refs の行き先から自分を消し、新 refs の行き先に自分を足す
//     （行き先の法令が別のチャンクにあればそのチャンクも読んで書く）
//   - 新しい法令は末尾のチャンクに入れ、refs_index.json も更新する
// lawtext は npm の lawtext（0.2.x）。NODE_PATH かカレントの node_modules から読む
const fs = require('fs');
const path = require('path');
const { CONFIG, statePath, readJson, writeJson, log, ensureDir, runId } = require('./lib/common.cjs');
const { R2 } = require('./lib/r2.cjs');
const { processLawXML, buildLawnameMap } = require('../rebuild/lib/refs_extract.cjs');

function computeTarget(ref) {
  if (!ref.target_law_id || !ref.target_article) return null;
  return `${ref.target_law_id}_Art${ref.target_article}`;
}

async function extract() {
  let lawtext = null;   // 抽出する法令があるときだけ読む（廃止で消す法令だけの回は要らない）
  const refsOnly = process.argv.includes('--refs-only');
  const manifest = refsOnly ? null : readJson(statePath('manifest.json'));   // refs だけの作り直しは manifest を見ない
  const listing = readJson(statePath('sync_state.next.json'), null) || readJson(statePath('sync_state.json'));
  const lawnumMap = {};
  for (const [lawId, e] of Object.entries(listing.laws || {})) if (e.law_num) lawnumMap[e.law_num] = { lawId, lawTitle: e.law_title };
  const lawnameMap = buildLawnameMap(lawnumMap);
  const outDir = ensureDir(statePath('refs'));
  const lawIds = manifest ? Object.keys(manifest.laws)
    : fs.readdirSync(statePath('xml')).filter((f) => f.endsWith('.xml')).map((f) => f.slice(0, -4)).sort();   // refs だけの作り直し: 取ってきた XML 全部
  log(`refs 抽出: ${lawIds.length} 法令${manifest ? '' : '（--refs-only: state/xml の全法令）'}`);
  const failed = [];
  let n = 0;
  for (const lawId of lawIds) {
    // 廃止で消す法令（05_diff.cjs の is_repeal）は、参照している側を空にする（patch が「参照されている」一覧からも外す）
    if (manifest && manifest.laws[lawId] && manifest.laws[lawId].is_repeal) { writeJson(path.join(outDir, `${lawId}.json`), {}); n++; continue; }
    const xmlPath = statePath('xml', `${lawId}.xml`);
    if (!fs.existsSync(xmlPath)) { failed.push({ law_id: lawId, error: 'xml なし' }); continue; }
    try {
      const xml = fs.readFileSync(xmlPath, 'utf8');
      if (!lawtext) lawtext = require('lawtext');
      const refs = await Promise.race([
        processLawXML(lawtext, xml, lawId, lawnumMap, lawnameMap),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 120s')), 120000)),
      ]);
      for (const list of Object.values(refs)) for (const r of list) { const t = computeTarget(r); if (t) r.target = t; }
      writeJson(path.join(outDir, `${lawId}.json`), refs);
    } catch (e) {
      failed.push({ law_id: lawId, error: e.message });
    }
    n++;
    if (n % 25 === 0) log(`  ${n}/${lawIds.length}`);
  }
  // 抽出に失敗した法令（lawtext が落ちる化学物質名など）は、新プレフィックスへの全件再構築なら今の refs を写して失わないようにする
  const copied = [];
  if (failed.length && CONFIG.oldRefsPrefix !== CONFIG.refsPrefix) {
    const r2 = new R2();
    const OP = CONFIG.oldRefsPrefix;
    const oldIndex = (await r2.getJson(`${OP}/refs_index.json`)) || {};
    const oldChunks = new Map();
    for (const f of failed) {
      const num = oldIndex[f.law_id];
      if (num === undefined) continue;
      if (!oldChunks.has(num)) oldChunks.set(num, (await r2.getJson(`${OP}/refs_chunk_${String(num).padStart(3, '0')}.json`)) || {});
      const law = oldChunks.get(num)[f.law_id];
      if (!law || !law.refs) continue;
      writeJson(path.join(outDir, `${f.law_id}.json`), law.refs);
      f.copied_from = OP;
      copied.push(f.law_id);
    }
    if (copied.length) log(`  抽出に失敗した ${copied.length} 法令は ${OP} の refs を写した`);
  }
  writeJson(statePath('refs_extract_log.json'), { extracted_at: new Date().toISOString(), laws: lawIds.length, failed, copied_from_old: copied }, true);
  log(`完了: ${lawIds.length - failed.length} 件, 失敗 ${failed.length}（うち旧 refs を写した ${copied.length}）`);
  if (failed.length) log('失敗:', failed.slice(0, 10));
}

async function patch() {
  const force = process.argv.includes('--force');
  const refsOnly = process.argv.includes('--refs-only');
  // refs だけの作り直し（run.cjs refs）は manifest を見ない。対象は state/refs にある全法令、退避 ID は今回の実行 ID
  const manifest = refsOnly ? { laws: null, ok_to_apply: true, run_id: runId() } : readJson(statePath('manifest.json'));
  if (!manifest.ok_to_apply && !force) { console.error('manifest に blockers があります（--force で流せる）'); process.exit(2); }
  const r2 = new R2();
  const rid = manifest.run_id || runId();
  const P = CONFIG.refsPrefix;
  const index = (await r2.getJson(`${P}/refs_index.json`)) || {};
  const chunks = new Map();   // num → object
  const dirty = new Set();
  const chunkKey = (num) => `${P}/refs_chunk_${String(num).padStart(3, '0')}.json`;
  const loadChunk = async (num) => { if (!chunks.has(num)) chunks.set(num, (await r2.getJson(chunkKey(num))) || {}); return chunks.get(num); };
  const lastChunkNum = Object.values(index).reduce((m, v) => Math.max(m, v), -1);
  let newLawChunk = lastChunkNum < 0 ? 0 : lastChunkNum;
  // 新しい法令を足すチャンクは 1MB を超えたら次の番号へ（全件再構築で空の索引から作るときも 1MB 刻みになる）
  const TARGET_CHUNK_SIZE = 1 * 1024 * 1024;
  const chunkSize = new Map();   // num → 概算バイト数（読み込み時に計算）
  const sizeOf = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8');
  const nextNewLawChunk = async () => {
    for (;;) {
      const chunk = await loadChunk(newLawChunk);
      if (!chunkSize.has(newLawChunk)) chunkSize.set(newLawChunk, sizeOf(chunk));
      if (chunkSize.get(newLawChunk) < TARGET_CHUNK_SIZE) return newLawChunk;
      newLawChunk++;
    }
  };

  const refsDir = statePath('refs');
  const lawIds = (manifest.laws ? Object.keys(manifest.laws) : fs.readdirSync(refsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort())
    .filter((id) => fs.existsSync(path.join(refsDir, `${id}.json`)));
  log(`refs 反映: ${lawIds.length} 法令（index ${Object.keys(index).length} 法令, 最終チャンク ${lastChunkNum}）`);

  const ensureLaw = async (lawId) => {
    let num = index[lawId];
    if (num === undefined) { num = await nextNewLawChunk(); index[lawId] = num; dirty.add('index'); }
    const chunk = await loadChunk(num);
    if (!chunk[lawId]) chunk[lawId] = { refs: {}, reverse_refs: {} };
    return { num, chunk, law: chunk[lawId] };
  };
  const revEdit = async (targetArticleId, sourceArticleId, add) => {
    const targetLaw = targetArticleId.split('_Art')[0];
    if (index[targetLaw] === undefined) return;   // 参照先の法令が索引に無ければ何もしない（新法の相互参照は次回以降）
    const { num, law } = await ensureLaw(targetLaw);
    const list = law.reverse_refs[targetArticleId] || [];
    const has = list.includes(sourceArticleId);
    if (add && !has) { law.reverse_refs[targetArticleId] = [...list, sourceArticleId]; dirty.add(num); }
    if (!add && has) { const nl = list.filter((x) => x !== sourceArticleId); if (nl.length) law.reverse_refs[targetArticleId] = nl; else delete law.reverse_refs[targetArticleId]; dirty.add(num); }
  };

  const stats = { laws: 0, refs_old: 0, refs_new: 0, rev_added: 0, rev_removed: 0 };
  for (const lawId of lawIds) {
    const newRefs = readJson(path.join(refsDir, `${lawId}.json`));
    const { num, law } = await ensureLaw(lawId);
    const oldRefs = law.refs || {};
    // 旧・新の (source article → target) の組
    const pairs = (refsObj) => { const s = new Set(); for (const [art, list] of Object.entries(refsObj)) for (const r of list) if (r.target) s.add(`${art}|${r.target}`); return s; };
    const oldPairs = pairs(oldRefs), newPairs = pairs(newRefs);
    for (const p of oldPairs) if (!newPairs.has(p)) { const [src, tgt] = p.split('|'); await revEdit(tgt, src, false); stats.rev_removed++; }
    for (const p of newPairs) if (!oldPairs.has(p)) { const [src, tgt] = p.split('|'); await revEdit(tgt, src, true); stats.rev_added++; }
    stats.refs_old += Object.values(oldRefs).reduce((s, a) => s + a.length, 0);
    stats.refs_new += Object.values(newRefs).reduce((s, a) => s + a.length, 0);
    law.refs = newRefs;
    dirty.add(num);
    chunkSize.set(num, (chunkSize.get(num) || 0) + sizeOf(newRefs));
    stats.laws++;
  }

  // 全件再構築（新しい refs プレフィックス）では、差分方式だと「まだ索引に無い法令への参照」の reverse_refs が落ちる
  // （revEdit は参照先の法令が索引に無ければ何もしない）。索引の全法令の refs から reverse_refs を作り直す
  const rebuildReverse = process.argv.includes('--rebuild-reverse') || CONFIG.oldRefsPrefix !== CONFIG.refsPrefix;
  if (rebuildReverse) {
    for (const num of new Set(Object.values(index))) await loadChunk(num);
    for (const chunk of chunks.values()) for (const law of Object.values(chunk)) law.reverse_refs = {};
    let added = 0, skipped = 0;
    for (const chunk of chunks.values()) {
      for (const law of Object.values(chunk)) {
        for (const [srcArticleId, list] of Object.entries(law.refs || {})) {
          for (const r of list) {
            if (!r.target) continue;
            const targetLaw = r.target.split('_Art')[0];
            const tnum = index[targetLaw];
            const tlaw = tnum === undefined ? null : chunks.get(tnum)[targetLaw];
            if (!tlaw) { skipped++; continue; }
            const cur = tlaw.reverse_refs[r.target] || (tlaw.reverse_refs[r.target] = []);
            if (!cur.includes(srcArticleId)) { cur.push(srcArticleId); added++; }
          }
        }
      }
    }
    for (const num of chunks.keys()) dirty.add(num);
    stats.reverse_rebuilt = added;
    stats.reverse_skipped_missing_law = skipped;
    log(`reverse_refs を作り直した: ${added} 件（参照先の法令が索引に無いもの ${skipped} 件、チャンク ${chunks.size}）`);
  }

  // 退避 → 書き込み
  for (const d of dirty) {
    if (d === 'index') {
      const old = await r2.get(`${P}/refs_index.json`); if (old) await r2.put(`${CONFIG.backupPrefix}/${rid}/${P}/refs_index.json`, old);
      await r2.put(`${P}/refs_index.json`, index);
    } else {
      const old = await r2.get(chunkKey(d)); if (old) await r2.put(`${CONFIG.backupPrefix}/${rid}/${chunkKey(d)}`, old);
      await r2.put(chunkKey(d), chunks.get(d));
    }
  }
  writeJson(statePath('apply_refs_log.json'), { finished_at: new Date().toISOString(), ...stats, chunks_written: [...dirty].filter((x) => x !== 'index').length, index_written: dirty.has('index'), dryRun: r2.dryRun }, true);
  log(`完了: laws=${stats.laws} refs ${stats.refs_old}→${stats.refs_new}, reverse +${stats.rev_added} -${stats.rev_removed}, chunks=${[...dirty].filter((x) => x !== 'index').length}${r2.dryRun ? '（dry-run）' : ''}`);
}

const mode = process.argv[2];
(mode === 'extract' ? extract() : mode === 'patch' ? patch() : Promise.reject(new Error('usage: 09_refs.cjs extract|patch')))
  .catch((e) => { console.error('FAIL:', e); process.exit(1); });
