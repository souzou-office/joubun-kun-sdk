#!/usr/bin/env node
/**
 * 全 XML を走査して LawNum → law_id のマップを作る。
 * 出力: rebuild_output/lawnum_to_lawid.json
 *
 * lawtext の external 参照は lawNum で来るので、これを law_id に解決するための索引。
 */

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');

const FETCHED_DIR = `${SITE.localDataRoot}/rebuild_output/fetched_laws`;
const OUTPUT = `${SITE.localDataRoot}/rebuild_output/lawnum_to_lawid.json`;

function extractLawNum(xml) {
  // <LawNum>...</LawNum>
  const m = xml.match(/<LawNum>([\s\S]*?)<\/LawNum>/);
  if (!m) return null;
  return m[1].trim();
}

function extractLawTitle(xml) {
  const m = xml.match(/<LawTitle[^>]*>([\s\S]*?)<\/LawTitle>/);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').trim();
}

function main() {
  const files = fs.readdirSync(FETCHED_DIR).filter(f => f.endsWith('.json'));
  console.log(`Scanning ${files.length} laws...`);

  const lawnumToLawid = {};
  const collisions = [];
  let processed = 0;
  let noLawNum = 0;

  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(FETCHED_DIR, f), 'utf-8'));
      const xmlPath = meta._source?.xml_path;
      if (!xmlPath || !fs.existsSync(xmlPath)) continue;

      const lawId = f.replace(/\.json$/, '');
      const xml = fs.readFileSync(xmlPath, 'utf-8');
      const lawNum = extractLawNum(xml);
      const lawTitle = extractLawTitle(xml);

      if (!lawNum) {
        noLawNum++;
        continue;
      }

      if (lawnumToLawid[lawNum]) {
        collisions.push({ lawNum, existing: lawnumToLawid[lawNum], duplicate: { lawId, lawTitle } });
      } else {
        lawnumToLawid[lawNum] = { lawId, lawTitle };
      }

      processed++;
      if (processed % 1000 === 0) console.log(`  ${processed}/${files.length}...`);
    } catch (e) {
      console.warn(`  Failed: ${f}: ${e.message}`);
    }
  }

  console.log(`Processed: ${processed}`);
  console.log(`No LawNum: ${noLawNum}`);
  console.log(`Collisions: ${collisions.length}`);
  console.log(`Unique lawNums: ${Object.keys(lawnumToLawid).length}`);

  if (collisions.length > 0 && collisions.length <= 30) {
    console.log('Collisions:');
    for (const c of collisions) console.log('  ', JSON.stringify(c));
  } else if (collisions.length > 30) {
    console.log('First 10 collisions:');
    for (const c of collisions.slice(0, 10)) console.log('  ', JSON.stringify(c));
  }

  fs.writeFileSync(OUTPUT, JSON.stringify({
    generated: new Date().toISOString(),
    stats: { processed, noLawNum, collisions: collisions.length, unique: Object.keys(lawnumToLawid).length },
    map: lawnumToLawid,
    collisions
  }, null, 2), 'utf-8');

  console.log(`\nOutput: ${OUTPUT}`);
}

main();
