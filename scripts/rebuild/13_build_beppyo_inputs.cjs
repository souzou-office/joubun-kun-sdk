// 13: 別表を「通達と同型」の1ベクトルにするための埋め込み入力を生成する。
//
// 背景:
//   従来の別表ベクトルは2種:
//     - paragraph単位(3,633本): 全行を連結→6000字truncate = 薄まる/巨大別表は頭しか残らない
//     - item(行)単位(15万本): 各行が「費用/旅費」等の一般語に当たって本則条文を押しのける洪水ノイズ
//   どちらも「別表＝1個の主題」を表せていない。
//
//   別表は本来「条文から参照されて行き着く」もの(別表第一による…)。通達と同じ構造。
//   なので通達(_reverse)と完全に同型に作り直す:
//     通達: 見出し＋本文頭1文 → ホーム条文(homes)
//     別表: 別表名(caption)＋先頭行 → 参照元の条文(homes, captionの「（第○条関係）」から抽出)
//
//   1別表＝1ベクトル(計~3,633本)。洪水も希釈も起きない。税/非税の区別も不要(全部公平に1本)。
//
// 入力:  rebuild_output/large_law_articles_v3/{law_id}/別表*.json
// 出力:  rebuild_output/beppyo_inputs.jsonl
//          各行 { id, ns:"_beppyo", text, metadata:{ law_id, law_title, article_title, cap, snip, homes } }
//        text = 法令名 + 別表名 + caption + 先頭数行 (判別用に短く濃く保つ)
//        homes = caption内「（第○条…関係）」から抽出した参照元条文 [{l,a,n}]
//
//   node scripts/rebuild/13_build_beppyo_inputs.cjs
//   node scripts/rebuild/13_build_beppyo_inputs.cjs --law-id 342AC0000000035   # 1法令だけ

const fs = require('fs');
const path = require('path');
const { beppyoEntry } = require('./lib/beppyo.cjs');   // 別表のベクトルの作り方（週次 scripts/beppyo/weekly と共用）
const SITE = require('../site_config.cjs');

const BASE = `${SITE.localDataRoot}/rebuild_output/large_law_articles_v3`;
const OUT = `${SITE.localDataRoot}/rebuild_output/beppyo_inputs.jsonl`;

function* iterBeppyoFiles(lawIdFilter) {
  for (const d of fs.readdirSync(BASE)) {
    if (lawIdFilter && d !== lawIdFilter) continue;
    const dir = path.join(BASE, d);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files; try { files = fs.readdirSync(dir).filter((f) => /^別表.*\.json$/.test(f)); } catch { continue; }
    for (const f of files) yield path.join(dir, f);
  }
}

function main() {
  const lawIdArg = (() => { const i = process.argv.indexOf('--law-id'); return i >= 0 ? process.argv[i + 1] : null; })();
  let out = fs.createWriteStream(OUT, { encoding: 'utf8' });
  let nFiles = 0, nVec = 0, nHomes = 0, nNoCap = 0, nRescued = 0;
  const sample = [];

  // B: refs_v2逆引きで作った「別表→参照元条文」マップ（13b出力）。captionに条文が書いてない別表を補完。
  const REFS_HOMES_FILE = `${SITE.localDataRoot}/rebuild_output/beppyo_homes_from_refs.json`;
  let refsHomesMap = {};
  try { refsHomesMap = JSON.parse(fs.readFileSync(REFS_HOMES_FILE, 'utf8')); console.log(`refs homes読込: ${Object.keys(refsHomesMap).length}別表分`); }
  catch { console.log('refs homes無し（13b未実行）。captionのみで継続。'); }

  for (const fp of iterBeppyoFiles(lawIdArg)) {
    nFiles++;
    let data; try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    const lawId = data.law_id || '';
    const lawTitle = data.law_title || '';
    for (const art of (data.articles || [])) {
      if (!String(art.title || '').startsWith('別表')) continue;
      if (!(art.caption || '').trim()) nNoCap++;
      const e = beppyoEntry(lawId, lawTitle, art, refsHomesMap);
      if (!e) continue;
      if (e._homes) nHomes++;
      if (!e._capHomes && e._homes) nRescued++; // captionでは取れず refs で救えた別表
      const entry = { id: e.id, ns: e.ns, text: e.text, metadata: e.metadata };
      out.write(JSON.stringify(entry, { }, 0) + '\n');
      nVec++;
      if (sample.length < 6) sample.push({ t: e.text.slice(0, 90), homes: JSON.parse(e.metadata.homes).map((h) => h.a) });
    }
  }
  out.end();
  console.log(`別表ファイル: ${nFiles}`);
  console.log(`生成ベクトル: ${nVec}`);
  console.log(`  homes(参照元条文)付き別表: ${nHomes} (${(nHomes / nVec * 100).toFixed(1)}%)`);
  console.log(`    うち refs_v2逆引きで救済(captionに条文なし): ${nRescued}`);
  console.log(`  caption無し: ${nNoCap}`);
  console.log(`出力: ${OUT}`);
  console.log('\n--- sample ---');
  for (const s of sample) console.log(' ', s.homes.join(',').padEnd(18), s.t);
}

main();
