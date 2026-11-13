// scripts/rebuild/09_split_refs_v2.cjs
//
// refs_v2.json から refs_chunks_v4/ を生成
//
// 旧版 09_split_refs.cjs との違い:
//   - 入力が refs_v2.json (richer schema)
//   - 互換のため target フィールド (= {target_law_id}_Art{target_article}) も追加生成
//   - reverse_refs は target で構築
//
// 入力: {localDataRoot}/rebuild_output/refs_v2.json
// 出力: {localDataRoot}/rebuild_output/refs_chunks_v4/

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');

const REFS_FILE = `${SITE.localDataRoot}/rebuild_output/refs_v2.json`;
const OUTPUT_DIR = `${SITE.localDataRoot}/rebuild_output/refs_chunks_v4`;
const TARGET_CHUNK_SIZE = 1 * 1024 * 1024;

function computeTargetArticleId(ref) {
  // 数値条 (Article) のみ target にする。 別表だけだと /api/articles のフォーマット
  // (law_id + Art + 数値) に乗らないので skip。
  if (!ref.target_law_id) return null;
  if (ref.target_article) {
    return `${ref.target_law_id}_Art${ref.target_article}`;
  }
  return null;
}

async function main() {
  if (!fs.existsSync(REFS_FILE)) {
    console.error(`ERROR: ${REFS_FILE} not found`);
    process.exit(1);
  }

  console.log('Loading refs_v2.json...');
  const refsData = JSON.parse(fs.readFileSync(REFS_FILE, 'utf-8'));
  const allRefs = refsData.refs || {};
  console.log(`  Article entries: ${Object.keys(allRefs).length}`);
  console.log(`  Total refs (stats): ${refsData.stats?.totalRefs || '?'}`);

  // [1] target を補完 + reverse_refs 計算
  console.log('\nNormalizing & computing reverse_refs...');
  const reverseRefs = {};
  let normalized = 0;
  let totalReverseRefs = 0;
  for (const [fromArticleId, refsList] of Object.entries(allRefs)) {
    for (const ref of refsList) {
      const tgt = computeTargetArticleId(ref);
      if (tgt) {
        ref.target = tgt;
        normalized++;
        if (!reverseRefs[tgt]) reverseRefs[tgt] = [];
        if (!reverseRefs[tgt].includes(fromArticleId)) {
          reverseRefs[tgt].push(fromArticleId);
          totalReverseRefs++;
        }
      }
    }
  }
  console.log(`  refs with target: ${normalized}`);
  console.log(`  articles referenced: ${Object.keys(reverseRefs).length}`);
  console.log(`  total reverse refs: ${totalReverseRefs}`);

  // [2] law_id 単位にグループ化
  console.log('\nGrouping by law_id...');
  const byLawId = new Map();
  function ensureLaw(lawId) {
    if (!byLawId.has(lawId)) {
      byLawId.set(lawId, { refs: {}, reverse_refs: {} });
    }
    return byLawId.get(lawId);
  }
  for (const [articleId, refs] of Object.entries(allRefs)) {
    const lawId = articleId.split('_Art')[0];
    ensureLaw(lawId).refs[articleId] = refs;
  }
  for (const [articleId, reverseList] of Object.entries(reverseRefs)) {
    const lawId = articleId.split('_Art')[0];
    ensureLaw(lawId).reverse_refs[articleId] = reverseList;
  }
  console.log(`  Total laws: ${byLawId.size}`);

  // [3] 1MB チャンク分割
  console.log('\nSplitting into chunks...');
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const refsIndex = {};
  let currentChunk = {};
  let currentChunkNum = 0;
  let currentChunkSize = 0;

  const sortedLawIds = [...byLawId.keys()].sort();

  function flushChunk() {
    if (Object.keys(currentChunk).length === 0) return;
    const chunkPath = path.join(OUTPUT_DIR, `refs_chunk_${String(currentChunkNum).padStart(3, '0')}.json`);
    fs.writeFileSync(chunkPath, JSON.stringify(currentChunk), 'utf-8');
    const actualSize = fs.statSync(chunkPath).size;
    console.log(`  chunk_${String(currentChunkNum).padStart(3, '0')}: ${Object.keys(currentChunk).length} laws, ${(actualSize / 1024).toFixed(0)} KB`);
    currentChunkNum++;
    currentChunk = {};
    currentChunkSize = 0;
  }

  for (const lawId of sortedLawIds) {
    const lawData = byLawId.get(lawId);
    const serialized = JSON.stringify(lawData);
    const itemSize = Buffer.byteLength(`"${lawId}":${serialized},`, 'utf-8');

    if (currentChunkSize > 0 && currentChunkSize + itemSize > TARGET_CHUNK_SIZE) {
      flushChunk();
    }

    currentChunk[lawId] = lawData;
    currentChunkSize += itemSize;
    refsIndex[lawId] = currentChunkNum;
  }
  flushChunk();

  // [4] index
  const indexPath = path.join(OUTPUT_DIR, 'refs_index.json');
  fs.writeFileSync(indexPath, JSON.stringify(refsIndex), 'utf-8');
  console.log(`\nIndex: ${indexPath} (${Object.keys(refsIndex).length} laws)`);

  // [5] summary
  const summary = {
    generated: new Date().toISOString(),
    source: REFS_FILE,
    schema_version: '4.0',
    total_laws: byLawId.size,
    total_chunks: currentChunkNum,
    total_refs: refsData.stats?.totalRefs || 0,
    total_reverse_refs: totalReverseRefs,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n=== 完了 ===');
  console.log(`  法令数: ${summary.total_laws}`);
  console.log(`  チャンク数: ${summary.total_chunks}`);
  console.log(`  refs: ${summary.total_refs}`);
  console.log(`  reverse_refs: ${summary.total_reverse_refs}`);
  console.log(`  出力先: ${OUTPUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
