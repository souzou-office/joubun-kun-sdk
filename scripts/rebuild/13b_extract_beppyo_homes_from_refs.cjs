// 13b: refs_v2.json（条文→別表の参照 約3.3万件）を逆引きして「別表→参照元条文(homes)」マップを作る。
//
// 背景: 13 は別表の caption「（第○条…関係）」から homes を取るが、これは 84.6% 止まり。
//   caption に条文番号が無い別表（耐用年数表など）や caption 無し別表は homes が欠ける。
//   だが条文側の本文には「…別表第一による」と書いてあり、それが refs_v2 に target_appdx として入っている。
//   それを逆引きして、別表側に書いてない分の親条文を埋める（B: homes補完）。
//
// 入力:  rebuild_output/refs_v2.json  (506MB, 1行JSON)
// 出力:  rebuild_output/beppyo_homes_from_refs.json
//          { "{lawId}|{canonicalAppdx}": [ {l, a}, ... ] }   ※ l=参照元法令ID, a=条文タイトル(漢数字)
//        13 が別表の (law_id, article_title) を同じ canonicalAppdx に正規化して引く。
//
//   node scripts/rebuild/13b_extract_beppyo_homes_from_refs.cjs

const fs = require('fs');
const SITE = require('../site_config.cjs');
const REFS = `${SITE.localDataRoot}/rebuild_output/refs_v2.json`;
const OUT = `${SITE.localDataRoot}/rebuild_output/beppyo_homes_from_refs.json`;

const { addAppdxHomes, finishAppdxHomes } = require('./lib/beppyo.cjs');   // 週次 scripts/beppyo/weekly と共用

(function main() {
  console.log('refs_v2.json 読込中（506MB）…');
  const data = JSON.parse(fs.readFileSync(REFS, 'utf8'));
  const refs = data.refs || {};
  const stats = {};
  const out = finishAppdxHomes(addAppdxHomes({}, refs, stats));
  const appdxRefs = stats.appdxRefs || 0, attached = stats.attached || 0, skippedSrc = stats.skippedSrc || 0;
  let beppyoCount = 0, homeCount = 0;
  for (const v of Object.values(out)) { beppyoCount++; homeCount += v.length; }
  fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
  console.log(`target_appdx付きref: ${appdxRefs}  別表へ紐付け成功: ${attached}`);
  console.log(`条文以外のソースでスキップ: ${skippedSrc}`);
  console.log(`生成: ${beppyoCount}別表に homes  (延べ${homeCount}条文)`);
  console.log(`出力: ${OUT}`);
})();
