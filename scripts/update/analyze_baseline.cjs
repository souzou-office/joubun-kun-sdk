// 一回限りの分析スクリプト:
// 取得済みの sync_state.json と R2 backup (r2_backup_20260313) を比較し、
// R2 反映以降にどのくらいの差分が溜まっているかを推定する。
//
// このスクリプトは Phase 1 パイプラインには含まれない (調査用)。
//
// 使用方法:
//   node scripts/update/analyze_baseline.cjs

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');

const STATE_FILE = path.join(__dirname, 'state', 'sync_state.json');
const R2_BACKUP_DIR = `${SITE.localDataRoot}/r2_backup_20260313`;
const BACKUP_DATE = '2026-03-13';  // バックアップ取得日 (これより新しい updated は差分候補)

function loadR2LawIds() {
  // 信頼ソースの選定:
  //   - r2_backup_20260313/law_chunk_map.json: 8,911 件 (large_law_articles_v2 が含まれていない)
  //   - src/lawIds.js (ALL_LAW_IDS):           8,878 件 (フロントエンド用、large 法令含む)
  //   - 両方の和集合がシステムが認識している法令の全体
  const mapPath = path.join(R2_BACKUP_DIR, 'law_chunk_map.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const lawIdsJsPath = `${SITE.localDataRoot}/src/lawIds.js`;
  const lawIdsJsSrc = fs.readFileSync(lawIdsJsPath, 'utf8');
  // export const ALL_LAW_IDS = {...}; を抽出
  const objSrc = lawIdsJsSrc.replace(/^export const ALL_LAW_IDS\s*=\s*/, '').replace(/;\s*$/, '').trim();
  const allLawIdsObj = JSON.parse(objSrc);
  const lawIdsFromJs = new Set(Object.values(allLawIdsObj));

  const fromMap = new Set(Object.keys(map));
  const union = new Set([...fromMap, ...lawIdsFromJs]);

  console.log(`  law_chunk_map.json: ${fromMap.size} 件`);
  console.log(`  src/lawIds.js:     ${lawIdsFromJs.size} 件`);
  console.log(`  和集合:            ${union.size} 件 (システム全体が認識)`);
  return union;
}

function main() {
  console.log('=== Baseline 分析 ===\n');

  console.log('sync_state.json 読み込み');
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const eGovLaws = state.laws;
  const eGovIds = new Set(Object.keys(eGovLaws));
  console.log(`  e-Gov 法令数: ${eGovIds.size}`);
  console.log(`  fetched_at: ${state.fetched_at}\n`);

  console.log('R2 backup 読み込み');
  const r2Ids = loadR2LawIds();
  console.log(`  R2 法令数: ${r2Ids.size}\n`);

  // ID 正規化: e-Gov v2 と R2 で AC/CO/IO 直後の桁 (位置5) が違うので両方を試す
  // 例: 503AC1000000057 (e-Gov) ⇔ 503AC0000000057 (R2)
  // 位置: 5 0 3 A C 1 0 0 0 0 0 0 0 5 7
  // index: 0 1 2 3 4 5 6 7 8 9 ...
  const normalizeVariants = (id) => {
    const variants = new Set([id]);
    if (id.length >= 6) {
      const ch = id[5];
      if (ch === '0' || ch === '1') {
        variants.add(id.slice(0, 5) + (ch === '0' ? '1' : '0') + id.slice(6));
      }
    }
    return variants;
  };
  const inR2WithVariants = (id) => {
    for (const v of normalizeVariants(id)) {
      if (r2Ids.has(v)) return true;
    }
    return false;
  };
  const inEGovWithVariants = (id) => {
    for (const v of normalizeVariants(id)) {
      if (eGovIds.has(v)) return true;
    }
    return false;
  };

  // 1. e-Gov にあって R2 にない (新規 or R2 から漏れた)
  const onlyInEGov = [];
  for (const id of eGovIds) {
    if (!inR2WithVariants(id)) onlyInEGov.push(id);
  }

  // 2. R2 にあって e-Gov にない (廃止 or 検索条件外)
  const onlyInR2 = [];
  for (const id of r2Ids) {
    if (!inEGovWithVariants(id)) onlyInR2.push(id);
  }

  // 3. 両方にある法令で updated が BACKUP_DATE より新しいもの (改正候補)
  const recentlyUpdated = [];
  const cutoff = new Date(BACKUP_DATE);
  for (const id of eGovIds) {
    if (!r2Ids.has(id)) continue;
    const law = eGovLaws[id];
    if (!law.updated) continue;
    const updatedAt = new Date(law.updated);
    if (updatedAt > cutoff) {
      recentlyUpdated.push({
        law_id: id,
        law_title: law.law_title,
        amendment_promulgate_date: law.amendment_promulgate_date,
        updated: law.updated,
      });
    }
  }

  // 4. updated を年単位で集計 (改正のペース把握)
  const yearHistogram = {};
  for (const id of eGovIds) {
    const law = eGovLaws[id];
    if (!law.updated) continue;
    const year = law.updated.slice(0, 4);
    yearHistogram[year] = (yearHistogram[year] || 0) + 1;
  }

  console.log('=== 結果 ===\n');
  console.log(`[1] e-Gov のみ (R2 未収録): ${onlyInEGov.length} 件`);
  console.log(`    例: ${onlyInEGov.slice(0, 5).map(id => `${id} (${eGovLaws[id].law_title})`).join('\n         ')}`);
  console.log('');

  console.log(`[2] R2 のみ (e-Gov 一覧外, 廃止候補): ${onlyInR2.length} 件`);
  console.log(`    例: ${onlyInR2.slice(0, 5).join(', ')}`);
  console.log('');

  console.log(`[3] R2 にも e-Gov にもあり、updated > ${BACKUP_DATE}: ${recentlyUpdated.length} 件 (改正候補)`);
  if (recentlyUpdated.length > 0) {
    recentlyUpdated.sort((a, b) => b.updated.localeCompare(a.updated));
    console.log(`    最新10件:`);
    for (const r of recentlyUpdated.slice(0, 10)) {
      console.log(`      ${r.updated.slice(0, 10)} ${r.law_id} ${r.law_title}`);
    }
  }
  console.log('');

  console.log('[4] updated 年別ヒストグラム (e-Gov 全件):');
  const years = Object.keys(yearHistogram).sort();
  for (const y of years) {
    const bar = '#'.repeat(Math.min(60, Math.floor(yearHistogram[y] / 50)));
    console.log(`    ${y}: ${String(yearHistogram[y]).padStart(5)} ${bar}`);
  }

  // 結果を保存
  const outFile = path.join(__dirname, 'state', 'baseline_analysis.json');
  fs.writeFileSync(outFile, JSON.stringify({
    analyzed_at: new Date().toISOString(),
    backup_date: BACKUP_DATE,
    counts: {
      egov_total: eGovIds.size,
      r2_total: r2Ids.size,
      only_in_egov: onlyInEGov.length,
      only_in_r2: onlyInR2.length,
      recently_updated: recentlyUpdated.length,
    },
    only_in_egov: onlyInEGov,
    only_in_r2: onlyInR2,
    recently_updated: recentlyUpdated,
    year_histogram: yearHistogram,
  }, null, 2), 'utf8');
  console.log(`\n出力: ${outFile}`);
}

main();
