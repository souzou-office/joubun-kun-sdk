// scripts/rebuild/09_split_refs.cjs
//
// refs.json から reverse_refs を計算 + law_id 単位に分割 + チャンク化
//
// 入力:
//   {localDataRoot}\rebuild_output\refs.json
//
// 出力:
//   {localDataRoot}\rebuild_output\refs_chunks_v3\
//     refs_index.json              # law_id → chunk番号
//     refs_chunk_NNN.json          # 約 1MB 単位
//     ★ 旧 refs_chunks/ と完全互換のフォーマット
//
// 各 refs_chunk_NNN.json の構造:
//   {
//     "<law_id>": {
//       "refs": { "<law_id>_Art<N>": [{type, target, text, ...}] },
//       "reverse_refs": { "<law_id>_Art<M>": ["<law_id>_Art<N>", ...] }
//     },
//     ...
//   }

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');

const REFS_FILE = `${SITE.localDataRoot}/rebuild_output/refs.json`;
const OUTPUT_DIR = `${SITE.localDataRoot}/rebuild_output/refs_chunks_v3`;
const TARGET_CHUNK_SIZE = 1 * 1024 * 1024; // 1MB

async function main() {
    if (!fs.existsSync(REFS_FILE)) {
        console.error(`ERROR: ${REFS_FILE} not found`);
        console.error('まず 08_extract_refs.cjs を実行してください');
        process.exit(1);
    }

    console.log('Loading refs.json...');
    const refsData = JSON.parse(fs.readFileSync(REFS_FILE, 'utf-8'));
    const allRefs = refsData.refs || {};
    console.log(`  Total article refs: ${Object.keys(allRefs).length}`);
    console.log(`  Total refs in stats: ${refsData.stats?.totalRefs || '?'}`);

    // ----------------------------------------------------------------
    // [1] reverse_refs を計算
    // ----------------------------------------------------------------
    console.log('\nComputing reverse_refs...');
    const reverseRefs = {};
    let totalReverseRefs = 0;
    for (const [fromArticleId, refsList] of Object.entries(allRefs)) {
        for (const ref of refsList) {
            const target = ref.target;
            if (!target) continue;
            if (!reverseRefs[target]) reverseRefs[target] = [];
            // 重複防止
            if (!reverseRefs[target].includes(fromArticleId)) {
                reverseRefs[target].push(fromArticleId);
                totalReverseRefs++;
            }
        }
    }
    console.log(`  Articles referenced: ${Object.keys(reverseRefs).length}`);
    console.log(`  Total reverse refs: ${totalReverseRefs}`);

    // ----------------------------------------------------------------
    // [2] law_id 単位にグループ化
    // ----------------------------------------------------------------
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

    // ----------------------------------------------------------------
    // [3] 1MB単位のチャンクに分割
    // ----------------------------------------------------------------
    console.log('\nSplitting into chunks (target 1MB each)...');

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const refsIndex = {}; // law_id → chunk番号
    let currentChunk = {};
    let currentChunkNum = 0;
    let currentChunkSize = 0;

    // law_id を sorted で安定化
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

        // 既にチャンクが大きくて、これを追加すると 1MB 超えるなら flush
        if (currentChunkSize > 0 && currentChunkSize + itemSize > TARGET_CHUNK_SIZE) {
            flushChunk();
        }

        currentChunk[lawId] = lawData;
        currentChunkSize += itemSize;
        refsIndex[lawId] = currentChunkNum;
    }
    flushChunk(); // 残り

    // ----------------------------------------------------------------
    // [4] refs_index.json 書き出し
    // ----------------------------------------------------------------
    const indexPath = path.join(OUTPUT_DIR, 'refs_index.json');
    fs.writeFileSync(indexPath, JSON.stringify(refsIndex), 'utf-8');
    console.log(`\nIndex: ${indexPath} (${Object.keys(refsIndex).length} laws)`);

    // ----------------------------------------------------------------
    // [5] 集計サマリー
    // ----------------------------------------------------------------
    const summary = {
        generated: new Date().toISOString(),
        source: REFS_FILE,
        total_laws: byLawId.size,
        total_chunks: currentChunkNum,
        total_refs: refsData.stats?.totalRefs || 0,
        total_reverse_refs: totalReverseRefs,
    };
    const summaryPath = path.join(OUTPUT_DIR, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

    console.log('\n=== 完了 ===');
    console.log(`  法令数:        ${summary.total_laws}`);
    console.log(`  チャンク数:    ${summary.total_chunks}`);
    console.log(`  refs 数:       ${summary.total_refs}`);
    console.log(`  reverse_refs:  ${summary.total_reverse_refs}`);
    console.log(`  出力先:        ${OUTPUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
