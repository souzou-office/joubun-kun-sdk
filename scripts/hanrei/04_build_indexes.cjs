// 裁判例3索引の生成: hanrei_parsed/cases_*.ndjson →
//   scripts/hanrei/state/indexes/caseno_index.json  { "{正規化裁判所名}|{事件番号}": [id,...] }
//   scripts/hanrei/state/indexes/date_index.json    { "{裁判所名(正式表記)}|{ISO日付}": [id,...] }
//   scripts/hanrei/state/indexes/shinkyu_links.json { id: { gensin:{court,caseNo,dateJp,matchedId|null}, appeals:[...] } }
//
//   node scripts/hanrei/04_build_indexes.cjs
//   node scripts/hanrei/04_build_indexes.cjs --src hanrei_parsed --out scripts/hanrei/state/indexes
//
// shinkyu_links の突合ルール:
//   ・gensin はメタデータがあれば常設。matchedId は
//     「裁判所名一致（空白除去キー）かつ（原審裁判年月日があれば日付も一致）」で一意に絞れた時のみ設定
//   ・曖昧（複数候補で日付なし・日付でも複数）は null のまま
//   ・appeals は他判例の原審欄からの逆引き（matchedId 成立分のみ。上告審の kekka を積む）
'use strict';

const fs = require('fs');
const path = require('path');
const { warekiToIso, courtKey, classifyCourt } = require('./lib_common.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');

function argVal(args, name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

function loadCases(srcDir) {
  const cases = [];
  if (!fs.existsSync(srcDir)) throw new Error(`入力がありません: ${srcDir}`);
  const files = fs.readdirSync(srcDir).filter((f) => /^cases_\d{3}\.ndjson$/.test(f)).sort();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(srcDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { cases.push(JSON.parse(line)); } catch { /* 壊れ行はスキップ */ }
    }
  }
  return { cases, files };
}

function buildIndexes(cases) {
  const byId = new Map(cases.map((c) => [c.id, c]));

  // --- caseno_index ---
  const casenoIndex = {};
  for (const c of cases) {
    if (!c.court || !c.caseNo) continue;
    const key = `${courtKey(c.court, c.branch)}|${c.caseNo}`;
    (casenoIndex[key] = casenoIndex[key] || []).push(c.id);
  }
  for (const k of Object.keys(casenoIndex)) {
    casenoIndex[k] = [...new Set(casenoIndex[k])].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  }

  // --- date_index ---
  // キーは審級ではなく「裁判所名（正式表記・空白除去、支部は含めない）」＋ISO日付。
  // これで「東京地判＋日付」を指定裁判所のキーで直接引ける＝同日の他裁判所の件数に左右されず
  // 取りこぼさない（worker の detectHanreiCourtHint/courtFromAdjacentAbbr の出力と一致する表記）。
  const dateIndex = {};
  for (const c of cases) {
    if (!c.court || !c.dateIso) continue;
    const key = `${courtKey(c.court)}|${c.dateIso}`;
    (dateIndex[key] = dateIndex[key] || []).push(c.id);
  }
  for (const k of Object.keys(dateIndex)) {
    dateIndex[k] = [...new Set(dateIndex[k])].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  }

  // --- shinkyu_links ---
  const links = {};
  let matchedCount = 0, ambiguous = 0;
  for (const c of cases) {
    const g = c.gensin;
    if (!g || !(g.court || g.caseNo || g.dateJp || g.kekka)) continue;
    let matchedId = null;
    if (g.court && g.caseNo) {
      const key = `${courtKey(g.court)}|${g.caseNo}`;
      let cands = (casenoIndex[key] || []).filter((x) => x !== c.id);
      if (cands.length) {
        // 3点一致（裁判所＋事件番号＋裁判年月日）のみリンク。日付が無ければ紐づけない
        // （事件番号は全国一意でないため、日付なしの1件一致は別裁判所の誤リンクを生む）。
        if (g.dateJp) {
          const iso = warekiToIso(g.dateJp);
          const f = cands.filter((x) => byId.get(x) && byId.get(x).dateIso === iso);
          if (f.length === 1) matchedId = f[0];
          else if (f.length > 1) ambiguous++; // 同一裁判所・同番号・同日が複数 → 曖昧
        } else {
          ambiguous++; // 原審裁判年月日なし → 3点そろわないので null のまま
        }
      }
    }
    if (matchedId) matchedCount++;
    links[c.id] = {
      gensin: { court: g.court || null, caseNo: g.caseNo || null, dateJp: g.dateJp || null, matchedId },
    };
  }
  // 逆引き appeals（matchedId 成立分のみ）
  for (const [childId, entry] of Object.entries(links)) {
    const pid = entry.gensin.matchedId;
    if (!pid) continue;
    const c = byId.get(childId);
    if (!links[pid]) links[pid] = { gensin: null };
    (links[pid].appeals = links[pid].appeals || []).push({
      id: childId,
      court: [c.court, c.branch].filter(Boolean).join(' ') || null,
      dateJp: c.dateJp || null,
      kekka: c.kekka || null,
    });
  }
  for (const e of Object.values(links)) {
    if (e.appeals) e.appeals.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  }

  return { casenoIndex, dateIndex, links, matchedCount, ambiguous };
}

function main() {
  const args = process.argv.slice(2);
  const srcDir = path.resolve(REPO_ROOT, argVal(args, '--src', 'hanrei_parsed'));
  const outDir = path.resolve(REPO_ROOT, argVal(args, '--out', path.join('scripts', 'hanrei', 'state', 'indexes')));

  const t0 = Date.now();
  const { cases, files } = loadCases(srcDir);
  const { casenoIndex, dateIndex, links, matchedCount, ambiguous } = buildIndexes(cases);

  // 出現する裁判所名の集合（正式表記・空白除去・支部含めない）。worker が略称照合テーブルに使う
  // （貪欲regexで市名を切り出す方式は「さいたま」欠けや前文巻き込みが起きるため、既知名で照合する）。
  const courtNames = [...new Set(cases.map((c) => courtKey(c.court)).filter(Boolean))].sort();

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'caseno_index.json'), JSON.stringify(casenoIndex));
  fs.writeFileSync(path.join(outDir, 'date_index.json'), JSON.stringify(dateIndex));
  fs.writeFileSync(path.join(outDir, 'shinkyu_links.json'), JSON.stringify(links));
  fs.writeFileSync(path.join(outDir, 'court_names.json'), JSON.stringify(courtNames));

  const withGensin = Object.values(links).filter((e) => e.gensin).length;
  const withAppeals = Object.values(links).filter((e) => e.appeals && e.appeals.length).length;
  console.log(`索引生成完了: ${cases.length}件 (${files.length}シャード, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`  caseno_index: ${Object.keys(casenoIndex).length}キー`);
  console.log(`  date_index:   ${Object.keys(dateIndex).length}キー`);
  console.log(`  shinkyu_links: ${Object.keys(links).length}件 (gensinあり ${withGensin} / matched ${matchedCount} / 曖昧null ${ambiguous} / appealsあり ${withAppeals})`);
  console.log(`出力: ${outDir}`);
}

module.exports = { buildIndexes, loadCases };

if (require.main === module) main();
