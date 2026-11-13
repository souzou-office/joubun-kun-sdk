// 一回限りの分析: revision_id に埋め込まれた改正日が R2 構築日より新しい法令を抽出
//
// e-Gov の law_revision_id フォーマット:
//   {law_id}_{YYYYMMDD}_{seq}
// 例: 105DF0000000337_18721109_000000000000000
//
// R2 構築日 (cutoff) より新しい revision_id を持ち、かつ R2 にも存在する法令 = 改正候補

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');

const STATE_FILE = path.join(__dirname, 'state', 'sync_state.json');
const R2_BACKUP_DIR = `${SITE.localDataRoot}/r2_backup_20260313`;
const CUTOFF = process.argv[2] || '20251001';  // YYYYMMDD (引数で上書き可)

function loadR2LawIds() {
  const map = JSON.parse(fs.readFileSync(path.join(R2_BACKUP_DIR, 'law_chunk_map.json'), 'utf8'));
  const lawIdsJsSrc = fs.readFileSync(`${SITE.localDataRoot}/src/lawIds.js`, 'utf8');
  const objSrc = lawIdsJsSrc.replace(/^export const ALL_LAW_IDS\s*=\s*/, '').replace(/;\s*$/, '').trim();
  const lawIdsFromJs = new Set(Object.values(JSON.parse(objSrc)));
  return new Set([...Object.keys(map), ...lawIdsFromJs]);
}

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
const inR2 = (id, r2Set) => {
  for (const v of normalizeVariants(id)) if (r2Set.has(v)) return true;
  return false;
};

function extractRevisionDate(revisionId) {
  if (!revisionId) return null;
  // {law_id}_{YYYYMMDD}_{seq}
  const m = revisionId.match(/_(\d{8})_/);
  return m ? m[1] : null;
}

function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const r2Ids = loadR2LawIds();

  console.log(`R2 構築日 (cutoff): ${CUTOFF}`);
  console.log(`e-Gov 法令数: ${Object.keys(state.laws).length}`);
  console.log(`R2 法令数:    ${r2Ids.size}`);
  console.log('');

  // R2 にも存在する法令で、revision_date > cutoff のもの (改正候補)
  const recentlyAmended = [];
  let noRevisionDate = 0;
  let inR2Count = 0;

  for (const [lawId, info] of Object.entries(state.laws)) {
    if (!inR2(lawId, r2Ids)) continue;
    inR2Count++;
    const revDate = extractRevisionDate(info.law_revision_id);
    if (!revDate) {
      noRevisionDate++;
      continue;
    }
    if (revDate > CUTOFF) {
      recentlyAmended.push({
        law_id: lawId,
        law_title: info.law_title,
        revision_date: revDate,
        amendment_promulgate_date: info.amendment_promulgate_date,
      });
    }
  }

  console.log(`R2 とマッチした法令: ${inR2Count}`);
  console.log(`revision_id 抽出失敗: ${noRevisionDate}`);
  console.log(`改正候補 (revision_date > ${CUTOFF}): ${recentlyAmended.length}`);
  console.log('');

  // 改正日別ヒストグラム
  const monthHist = {};
  for (const r of recentlyAmended) {
    const ym = r.revision_date.slice(0, 6);
    monthHist[ym] = (monthHist[ym] || 0) + 1;
  }
  console.log('改正候補の改正日 (年月別):');
  for (const ym of Object.keys(monthHist).sort()) {
    console.log(`  ${ym.slice(0, 4)}-${ym.slice(4, 6)}: ${monthHist[ym]}`);
  }
  console.log('');

  recentlyAmended.sort((a, b) => b.revision_date.localeCompare(a.revision_date));
  console.log('改正候補 (新しい順, 上位15件):');
  for (const r of recentlyAmended.slice(0, 15)) {
    const d = `${r.revision_date.slice(0,4)}-${r.revision_date.slice(4,6)}-${r.revision_date.slice(6,8)}`;
    console.log(`  ${d}  ${r.law_id}  ${r.law_title}`);
  }

  const outFile = path.join(__dirname, 'state', 'amendment_candidates.json');
  fs.writeFileSync(outFile, JSON.stringify({
    cutoff: CUTOFF,
    analyzed_at: new Date().toISOString(),
    count: recentlyAmended.length,
    candidates: recentlyAmended,
  }, null, 2), 'utf8');
  console.log(`\n出力: ${outFile}`);
}

main();
