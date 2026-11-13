#!/usr/bin/env node
/**
 * 法令XMLから条文参照関係を抽出するスクリプト v2
 *
 * Lawtextライブラリを使用して精度の高い参照抽出を行う
 * 範囲参照（例: 「第453条から前条まで」）にも対応
 *
 * Usage:
 *   npm install lawtext
 *   node extract_refs_lawtext_v2.js <xml_dir> <output_file>
 *
 * Example:
 *   node extract_refs_lawtext_v2.js ./laws_xml ./refs.json
 */

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const SITE = require('../site_config.cjs');

// Worker (子スレッド) では lawtext のみロード → main では遅延読み込み
let lawtext;
if (!isMainThread) {
    lawtext = require('lawtext');
}

/**
 * __range属性をパースして[start, end]を返す
 */
function parseRange(rangeStr) {
    if (!rangeStr) return null;
    const match = rangeStr.match(/\[(\d+),(\d+)\]/);
    if (match) {
        return [parseInt(match[1]), parseInt(match[2])];
    }
    return null;
}

/**
 * JSON構造から____PointerRange要素と単独____Pointer要素を再帰的に抽出（範囲参照対応）
 */
function extractPointerRanges(obj, articleNum, paragraphNum, ranges = []) {
    if (!obj) return ranges;

    // ____PointerRange要素を見つけた（例: 「第453条から前条まで」）
    if (obj.tag === '____PointerRange') {
        const range = parsePointerRange(obj, articleNum);
        if (range) {
            range.fromArticle = articleNum;
            range.fromParagraph = paragraphNum;
            // 位置情報を追加
            const pos = parseRange(obj.attr?.__range);
            if (pos) {
                range.start = pos[0];
                range.end = pos[1];
            }
            ranges.push(range);
        }
        // PointerRange内は既に処理済みなので子要素はスキップ
        return ranges;
    }

    // 単独の____Pointer要素（____PointerRange外のもの）
    if (obj.tag === '____Pointer') {
        const pointer = parsePointer(obj);
        if (pointer) {
            pointer.fromArticle = articleNum;
            pointer.fromParagraph = paragraphNum;
            pointer.isRange = false;
            // 位置情報を追加
            const pos = parseRange(obj.attr?.__range);
            if (pos) {
                pointer.start = pos[0];
                pointer.end = pos[1];
            }
            ranges.push(pointer);
        }
    }

    // Article要素を見つけたら現在の条番号を更新
    let currentArticle = articleNum;
    if (obj.tag === 'Article' && obj.attr?.Num) {
        currentArticle = obj.attr.Num;
    }

    // Paragraph要素を見つけたら現在の項番号を更新
    let currentParagraph = paragraphNum;
    if (obj.tag === 'Paragraph' && obj.attr?.Num) {
        currentParagraph = obj.attr.Num;
    }

    // 子要素を再帰処理
    if (obj.children && Array.isArray(obj.children)) {
        for (const child of obj.children) {
            if (typeof child === 'object') {
                extractPointerRanges(child, currentArticle, currentParagraph, ranges);
            }
        }
    }

    return ranges;
}

/**
 * ____PointerRange要素をパースして範囲参照情報を取得
 * 例: 「第453条から前条まで」→ from: 453, to: PREV
 */
function parsePointerRange(rangeObj, currentArticleNum) {
    // ____PointerRange内の____Pointerを取得
    const pointers = [];
    function findPointers(obj) {
        if (!obj) return;
        if (obj.tag === '____Pointer') {
            const p = parsePointer(obj);
            if (p) pointers.push(p);
        }
        if (obj.children) {
            for (const c of obj.children) {
                if (typeof c === 'object') findPointers(c);
            }
        }
    }
    findPointers(rangeObj);

    if (pointers.length === 0) return null;

    // 最初のポインタ = from（範囲の開始）
    const from = pointers[0];
    // 2番目のポインタ = to（範囲の終了）あれば
    const to = pointers.length > 1 ? pointers[1] : null;

    // テキスト全体を取得
    let text = '';
    function collectText(obj) {
        if (typeof obj === 'string') {
            text += obj;
        } else if (obj && obj.children) {
            for (const c of obj.children) {
                collectText(c);
            }
        }
    }
    collectText(rangeObj);

    return {
        isRange: true,
        from: from,
        to: to,
        targetType: from.targetType,
        text: text.trim(),
        currentArticleNum: currentArticleNum
    };
}

/**
 * ____Pointer要素をパースして参照情報を取得
 */
function parsePointer(pointerObj) {
    const result = {
        targetType: null,
        targetNum: null,
        relPos: null,
        text: ''
    };

    // ____PF要素を探す（Pointer Fragment）
    function findPF(obj) {
        if (!obj) return;

        if (obj.tag === '____PF' && obj.attr) {
            const attr = obj.attr;

            // 条への参照
            if (attr.targetType === 'Article') {
                result.targetType = 'Article';
                result.targetNum = attr.num;
                result.relPos = attr.relPos;  // NAMED, PREV, NEXT など
            }
            // 項への参照
            else if (attr.targetType === 'Paragraph') {
                result.targetType = 'Paragraph';
                result.targetNum = attr.num;
                result.relPos = attr.relPos;
            }

            // テキストを取得
            if (obj.children) {
                for (const child of obj.children) {
                    if (typeof child === 'string') {
                        result.text += child;
                    }
                }
            }
        }

        if (obj.children && Array.isArray(obj.children)) {
            for (const child of obj.children) {
                if (typeof child === 'object') {
                    findPF(child);
                }
            }
        }
    }

    findPF(pointerObj);

    // 有効な参照のみ返す（相対参照も含む）
    if (result.targetType === 'Article') {
        // PREV/NEXTの場合はtargetNumがnullでもOK
        if (result.targetNum || result.relPos === 'PREV' || result.relPos === 'NEXT') {
            return result;
        }
    }

    return null;
}

/**
 * 範囲参照を展開して個別の参照リストを生成
 * 例: from=453, to=457 → [453, 454, 455, 456, 457]
 */
function expandRange(item, currentArticleNum) {
    if (!item.isRange) {
        // 単独参照
        let targetNum = item.targetNum;

        // 相対参照を解決
        if (item.relPos === 'PREV') {
            const num = parseInt(currentArticleNum);
            if (!isNaN(num)) {
                targetNum = String(num - 1);
            }
        } else if (item.relPos === 'NEXT') {
            const num = parseInt(currentArticleNum);
            if (!isNaN(num)) {
                targetNum = String(num + 1);
            }
        }

        return targetNum ? [targetNum] : [];
    }

    // 範囲参照
    const from = item.from;
    const to = item.to;

    // fromの条番号を取得
    let fromNum = parseInt(from.targetNum);
    if (isNaN(fromNum)) {
        if (from.relPos === 'PREV') {
            fromNum = parseInt(currentArticleNum) - 1;
        } else if (from.relPos === 'NEXT') {
            fromNum = parseInt(currentArticleNum) + 1;
        }
    }

    // toの条番号を取得
    let toNum = null;
    if (to) {
        toNum = parseInt(to.targetNum);
        if (isNaN(toNum)) {
            if (to.relPos === 'PREV') {
                toNum = parseInt(currentArticleNum) - 1;
            } else if (to.relPos === 'NEXT') {
                toNum = parseInt(currentArticleNum) + 1;
            }
        }
    }

    // 範囲を展開
    if (isNaN(fromNum)) return [];

    if (toNum === null || isNaN(toNum)) {
        // toがない場合はfromのみ
        return [String(fromNum)];
    }

    // fromからtoまでの範囲を生成
    const targets = [];
    const start = Math.min(fromNum, toNum);
    const end = Math.max(fromNum, toNum);

    // 範囲が大きすぎる場合は制限（100条以上の範囲は異常と判断）
    if (end - start > 100) {
        console.warn(`  Warning: Skipping too large range ${start}-${end}`);
        return [String(fromNum)];
    }

    for (let i = start; i <= end; i++) {
        targets.push(String(i));
    }

    return targets;
}

/**
 * XMLファイル名から法令IDを抽出
 */
function getLawIdFromFilename(filename) {
    const match = filename.match(/^([^_]+)/);
    return match ? match[1] : null;
}

/**
 * 1つの法令XMLを処理（タイムアウト付き）
 */
async function processLawXML(xmlPath, lawId, timeoutMs = 30000) {
    const xml = fs.readFileSync(xmlPath, 'utf-8');

    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    });

    const processPromise = (async () => {
        try {
            const result = await lawtext.run({
                input: { xml: xml },
                outtypes: ['json'],
                analyze: true,
                controlel: true
            });

            if (!result.json) {
                return { refs: {}, error: 'No JSON output' };
            }

            // ポインタ/範囲参照を抽出
            const items = extractPointerRanges(result.json, null, null);

            // 条ごとに参照をグループ化
            const refs = {};
            for (const item of items) {
                if (!item.fromArticle) continue;

                const articleId = `${lawId}_Art${item.fromArticle}`;
                if (!refs[articleId]) {
                    refs[articleId] = [];
                }

                // 範囲参照を展開
                const targetNums = expandRange(item, item.fromArticle);

                for (const targetNum of targetNums) {
                    const refEntry = {
                        type: 'internal',
                        target: `${lawId}_Art${targetNum}`,
                        text: item.text
                    };
                    // 位置情報があれば追加
                    if (item.start !== undefined && item.end !== undefined) {
                        refEntry.start = item.start;
                        refEntry.end = item.end;
                    }
                    // 項番号があれば追加
                    if (item.fromParagraph) {
                        refEntry.paragraph = item.fromParagraph;
                    }
                    refs[articleId].push(refEntry);
                }
            }

            // 重複除去
            for (const articleId in refs) {
                const seen = new Set();
                refs[articleId] = refs[articleId].filter(ref => {
                    if (seen.has(ref.target)) return false;
                    seen.add(ref.target);
                    return true;
                });

                if (refs[articleId].length === 0) {
                    delete refs[articleId];
                }
            }

            return { refs, error: null };

        } catch (e) {
            return { refs: {}, error: e.message };
        }
    })();

    try {
        return await Promise.race([processPromise, timeoutPromise]);
    } catch (e) {
        return { refs: {}, error: e.message };
    }
}

/**
 * メイン処理 (rebuild 版):
 *   fetched_laws/*.json から (law_id, xml_path) を読み取り、
 *   現行版 XML だけを対象に refs を抽出。
 *   既存 refs.json があれば resume。
 */
const FETCHED_DIR = `${SITE.localDataRoot}/rebuild_output/fetched_laws`;
const DEFAULT_OUTPUT = `${SITE.localDataRoot}/rebuild_output/refs.json`;

async function main() {
    const args = process.argv.slice(2);
    const outputFile = args[0] || DEFAULT_OUTPUT;

    if (!fs.existsSync(FETCHED_DIR)) {
        console.error(`Directory not found: ${FETCHED_DIR}`);
        console.error('まず 01_parse_xml.py を実行してください');
        process.exit(1);
    }

    console.log(`Collecting target XMLs from ${FETCHED_DIR}...`);
    const fetchedFiles = fs.readdirSync(FETCHED_DIR).filter(f => f.endsWith('.json'));
    const xmlFiles = [];
    for (const f of fetchedFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(FETCHED_DIR, f), 'utf-8'));
            const xmlPath = data._source?.xml_path;
            if (!xmlPath) {
                console.warn(`  No xml_path: ${f}`);
                continue;
            }
            if (!fs.existsSync(xmlPath)) {
                console.warn(`  XML not found: ${xmlPath}`);
                continue;
            }
            xmlFiles.push(xmlPath);
        } catch (e) {
            console.warn(`  Failed to read ${f}: ${e.message}`);
        }
    }
    xmlFiles.sort();
    console.log(`  Target XML files: ${xmlFiles.length}`);

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
    const remainingFiles = xmlFiles.filter(f => {
        const lid = getLawIdFromFilename(path.basename(f));
        return lid && !processedLawIds.has(lid);
    });
    console.log(`Remaining to process: ${remainingFiles.length}`);
    const skipExisting = xmlFiles.length - remainingFiles.length;
    if (skipExisting > 0) console.log(`Skipping ${skipExisting} already-done`);
    // 以後ループでは remainingFiles を使う
    var processFiles = remainingFiles;

    const stats = {
        totalLaws: processedLawIds.size,
        articlesWithRefs: 0,
        totalRefs: 0,
        errors: 0
    };
    // 既存の articles 数も集計
    for (const refsList of Object.values(allRefs)) {
        stats.articlesWithRefs++;
        stats.totalRefs += refsList.length;
    }

    const startTime = Date.now();

    function saveProgress() {
        const output = {
            version: '2.0',
            generated: new Date().toISOString(),
            stats: stats,
            refs: allRefs
        };
        fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');
    }

    // ハードタイムアウト用: worker_thread で 1 法令ずつ処理
    const HARD_TIMEOUT_MS = 60000;

    function processInWorker(xmlPath, lawId) {
        return new Promise((resolve) => {
            const worker = new Worker(__filename, { workerData: { xmlPath, lawId } });
            let settled = false;
            const t = setTimeout(() => {
                if (settled) return;
                settled = true;
                worker.terminate().catch(() => {});
                resolve({ refs: {}, error: `hard_timeout_${HARD_TIMEOUT_MS}ms` });
            }, HARD_TIMEOUT_MS);
            worker.on('message', (msg) => {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                resolve(msg);
                worker.terminate().catch(() => {});
            });
            worker.on('error', (e) => {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                resolve({ refs: {}, error: `worker_error: ${e.message}` });
            });
            worker.on('exit', (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                resolve({ refs: {}, error: `worker_exit_${code}` });
            });
        });
    }

    for (let i = 0; i < processFiles.length; i++) {
        const xmlPath = processFiles[i];
        const xmlFile = path.basename(xmlPath);
        const lawId = getLawIdFromFilename(xmlFile);

        if (!lawId) {
            console.warn(`Cannot extract law ID from: ${xmlFile}`);
            continue;
        }

        if ((i + 1) % 100 === 0 || i === 0 || i === processFiles.length - 1) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const rate = ((i + 1) / elapsed).toFixed(1);
            const eta = ((processFiles.length - i - 1) / parseFloat(rate)).toFixed(0);
            console.log(`[${elapsed}s] ${i + 1}/${processFiles.length} (${rate}/s, eta=${eta}s): ${lawId}`);
        }

        const { refs, error } = await processInWorker(xmlPath, lawId);

        if (error) {
            stats.errors++;
            if (stats.errors <= 30) {
                console.warn(`  Error: ${xmlFile}: ${error}`);
            }
        } else {
            stats.totalLaws++;

            for (const [articleId, articleRefs] of Object.entries(refs)) {
                allRefs[articleId] = articleRefs;
                stats.articlesWithRefs++;
                stats.totalRefs += articleRefs.length;
            }
        }

        if ((i + 1) % 500 === 0) {
            saveProgress();
            console.log(`  [Saved progress: ${stats.totalLaws} laws, ${stats.totalRefs} refs]`);
        }
    }

    const output = {
        version: '2.0',
        generated: new Date().toISOString(),
        stats: stats,
        refs: allRefs
    };

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n=== Statistics ===');
    console.log(`Total time: ${totalTime}s`);
    console.log(`Total laws processed: ${stats.totalLaws}`);
    console.log(`Articles with refs: ${stats.articlesWithRefs}`);
    console.log(`Total refs: ${stats.totalRefs}`);
    console.log(`Errors: ${stats.errors}`);
    console.log(`\nOutput: ${outputFile}`);
}

// ============================================================
// Worker entrypoint:
//   1 XML を処理して結果を返す。タイムアウトは親側で worker.terminate() による
// ============================================================
if (!isMainThread) {
    (async () => {
        const { xmlPath, lawId } = workerData;
        const { refs, error } = await processLawXML(xmlPath, lawId, 60000);
        parentPort.postMessage({ refs, error });
    })().catch(e => {
        parentPort.postMessage({ refs: {}, error: `worker_uncaught: ${e.message}` });
    });
} else {
    main().catch(console.error);
}
