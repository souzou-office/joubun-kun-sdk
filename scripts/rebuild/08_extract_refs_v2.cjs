#!/usr/bin/env node
/**
 * 法令XMLから参照関係を抽出する v2
 *
 * 旧版との違い:
 *   - lawtext の analysis 出力 (pointerEnvByEL, declarations, variableReferences) をフル活用
 *   - external 参照を target_law_id まで解決 (lawnum_to_lawid.json 経由)
 *   - 略称参照 (令、法 等)、APPDX、TableStruct、Item、Paragraph 単独、前項、同条、本条 すべて拾う
 *   - SAME/HERE/PREV/NEXT relPos の文脈解決を lawtext に委ねる
 *
 * Usage:
 *   node 08_extract_refs_v2.cjs [output_file]
 *
 * 出力: rebuild_output/refs_v2.json (デフォルト)
 *
 * 環境前提:
 *   - rebuild_output/fetched_laws/*.json が存在
 *   - rebuild_output/lawnum_to_lawid.json が存在 (build_lawnum_map.cjs で生成)
 */

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const SITE = require('../site_config.cjs');

// Worker 子スレッドでのみ lawtext をロード
let lawtext;
let workerLawnumMap;
let workerLawnameMap;  // 法令名 → { lawId, lawNum }
if (!isMainThread) {
  lawtext = require('lawtext');
}

const FETCHED_DIR = `${SITE.localDataRoot}/rebuild_output/fetched_laws`;
const LAWNUM_MAP_FILE = `${SITE.localDataRoot}/rebuild_output/lawnum_to_lawid.json`;
const DEFAULT_OUTPUT = `${SITE.localDataRoot}/rebuild_output/refs_v2.json`;

// =========================================================
// Worker side
// =========================================================
const { processLawXML: _processLawXML, buildLawnameMap } = require('./lib/refs_extract.cjs');
// 抽出本体は lib/refs_extract.cjs に移した（週次更新と共用）。ここでは lawtext を渡すだけ
async function processLawXML(xml, lawId, lawnumMap, lawnameToLawid) {
  return _processLawXML(lawtext, xml, lawId, lawnumMap, lawnameToLawid);
}

if (!isMainThread) {
  (async () => {
    try {
      const { xmlPath, lawId } = workerData;
      // workerData ではなく自前でファイルロード(serialize 回避)
      if (!workerLawnumMap) {
        workerLawnumMap = JSON.parse(fs.readFileSync(LAWNUM_MAP_FILE, 'utf-8')).map;
        // 法令名 → { lawId, lawNum } 逆引きを構築
        workerLawnameMap = buildLawnameMap(workerLawnumMap);
      }
      const xml = fs.readFileSync(xmlPath, 'utf-8');
      const refs = await processLawXML(xml, lawId, workerLawnumMap, workerLawnameMap);
      parentPort.postMessage({ refs, error: null });
    } catch (e) {
      parentPort.postMessage({ refs: {}, error: e.message });
    }
  })().catch(e => {
    parentPort.postMessage({ refs: {}, error: `uncaught: ${e.message}` });
  });
}

// =========================================================
// Main side
// =========================================================
async function main() {
  const args = process.argv.slice(2);
  const outputFile = args[0] || DEFAULT_OUTPUT;

  if (!fs.existsSync(LAWNUM_MAP_FILE)) {
    console.error(`lawnum_to_lawid.json not found. Run build_lawnum_map.cjs first.`);
    process.exit(1);
  }
  const lawnumMap = JSON.parse(fs.readFileSync(LAWNUM_MAP_FILE, 'utf-8')).map;
  console.log(`Loaded lawnumMap: ${Object.keys(lawnumMap).length} entries`);

  if (!fs.existsSync(FETCHED_DIR)) {
    console.error(`Directory not found: ${FETCHED_DIR}`);
    process.exit(1);
  }

  console.log(`Collecting target XMLs from ${FETCHED_DIR}...`);
  const fetchedFiles = fs.readdirSync(FETCHED_DIR).filter(f => f.endsWith('.json'));
  const xmlFiles = [];
  for (const f of fetchedFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(FETCHED_DIR, f), 'utf-8'));
      const xmlPath = data._source?.xml_path;
      if (!xmlPath || !fs.existsSync(xmlPath)) continue;
      xmlFiles.push(xmlPath);
    } catch (e) {}
  }
  xmlFiles.sort();
  console.log(`Target XML files: ${xmlFiles.length}`);

  // Resume support
  let allRefs = {};
  const processedLawIds = new Set();
  if (fs.existsSync(outputFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      allRefs = existing.refs || {};
      for (const articleId of Object.keys(allRefs)) {
        const lid = articleId.split('_Art')[0];
        processedLawIds.add(lid);
      }
      console.log(`Resuming: already processed ${processedLawIds.size} law_ids`);
    } catch (e) {
      console.warn(`Failed to load existing ${outputFile}: ${e.message}`);
    }
  }
  function getLawIdFromFilename(filename) {
    const m = filename.match(/^([^_]+)/);
    return m ? m[1] : null;
  }
  const remainingFiles = xmlFiles.filter(f => {
    const lid = getLawIdFromFilename(path.basename(f));
    return lid && !processedLawIds.has(lid);
  });
  console.log(`Remaining to process: ${remainingFiles.length}`);

  const stats = {
    totalLaws: processedLawIds.size,
    articlesWithRefs: 0,
    totalRefs: 0,
    errors: 0
  };
  for (const arr of Object.values(allRefs)) {
    stats.articlesWithRefs++;
    stats.totalRefs += arr.length;
  }

  const startTime = Date.now();
  const HARD_TIMEOUT_MS = 60000;

  function saveProgress() {
    const output = {
      version: '3.0',
      generated: new Date().toISOString(),
      stats,
      refs: allRefs
    };
    fs.writeFileSync(outputFile, JSON.stringify(output), 'utf-8');
  }

  function processInWorker(xmlPath, lawId) {
    return new Promise((resolve) => {
      const w = new Worker(__filename, { workerData: { xmlPath, lawId } });
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        w.terminate().catch(() => {});
        resolve({ refs: {}, error: `hard_timeout_${HARD_TIMEOUT_MS}ms` });
      }, HARD_TIMEOUT_MS);
      w.on('message', (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(msg);
        w.terminate().catch(() => {});
      });
      w.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ refs: {}, error: `worker_error: ${e.message}` });
      });
      w.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ refs: {}, error: `worker_exit_${code}` });
      });
    });
  }

  for (let i = 0; i < remainingFiles.length; i++) {
    const xmlPath = remainingFiles[i];
    const xmlFile = path.basename(xmlPath);
    const lawId = getLawIdFromFilename(xmlFile);
    if (!lawId) continue;

    if ((i + 1) % 100 === 0 || i === 0 || i === remainingFiles.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = ((i + 1) / parseFloat(elapsed)).toFixed(1);
      const eta = ((remainingFiles.length - i - 1) / parseFloat(rate)).toFixed(0);
      console.log(`[${elapsed}s] ${i + 1}/${remainingFiles.length} (${rate}/s, eta=${eta}s): ${lawId}`);
    }

    const { refs, error } = await processInWorker(xmlPath, lawId);
    if (error) {
      stats.errors++;
      if (stats.errors <= 30) console.warn(`  Error: ${xmlFile}: ${error}`);
    } else {
      stats.totalLaws++;
      for (const [articleId, arr] of Object.entries(refs)) {
        allRefs[articleId] = arr;
        stats.articlesWithRefs++;
        stats.totalRefs += arr.length;
      }
    }

    if ((i + 1) % 500 === 0) {
      saveProgress();
      console.log(`  [saved: ${stats.totalLaws} laws, ${stats.totalRefs} refs]`);
    }
  }

  saveProgress();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n=== Statistics ===');
  console.log(`Total time: ${totalTime}s`);
  console.log(`Total laws processed: ${stats.totalLaws}`);
  console.log(`Articles with refs: ${stats.articlesWithRefs}`);
  console.log(`Total refs: ${stats.totalRefs}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`\nOutput: ${outputFile}`);
}

if (isMainThread) {
  main().catch(e => { console.error(e); process.exit(1); });
}
