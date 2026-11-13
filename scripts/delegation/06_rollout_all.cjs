#!/usr/bin/env node
// 全法令展開: 逆引き対象になっている全親法令に 01→02 を適用 (AIは通さない)。
// 実行: node --max-old-space-size=8000 06_rollout_all.cjs
// 出力: rebuild_output/delegations/all/linked_{law_id}.json + rollout_summary.json
'use strict';
const fs = require('fs');
const path = require('path');
const { DELEG_DIR, FETCHED_DIR } = require('./lib.cjs');
const { extractLaw } = require('./01_extract_delegations.cjs');
const { linkParent } = require('./02_link_by_reverse.cjs');

const REV = path.join(DELEG_DIR, 'reverse_index');
const OUT = path.join(DELEG_DIR, 'all');
fs.mkdirSync(OUT, { recursive: true });

function main() {
  // 親候補 = fetched_laws にある全法令 (法律以外も政令→省令の多段委任があるため全件)
  const ids = fs.readdirSync(FETCHED_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  console.log('laws:', ids.length);

  const summary = { total_laws: 0, laws_with_delegations: 0, delegations_main: 0, status: {}, kind: {}, errors: [] };
  let i = 0;
  for (const id of ids) {
    i++;
    if (i % 500 === 0) console.log(`${i}/${ids.length} ...`);
    let raw;
    try { raw = extractLaw(id); } catch (e) { summary.errors.push({ id, step: '01', err: String(e).slice(0, 120) }); continue; }
    summary.total_laws++;
    const mainCount = raw.delegations.filter(d => d.provision === 'main').length;
    if (!mainCount) continue;
    summary.laws_with_delegations++;
    summary.delegations_main += mainCount;
    let linked;
    try {
      linked = linkParent(id, { raw, noWrite: true, quiet: true });
    } catch (e) { summary.errors.push({ id, step: '02', err: String(e).slice(0, 120) }); continue; }
    for (const [k, v] of Object.entries(linked.status_counts)) summary.status[k] = (summary.status[k] || 0) + v;
    for (const d of linked.delegations) if (d.provision === 'main') summary.kind[d.kind] = (summary.kind[d.kind] || 0) + 1;
    fs.writeFileSync(path.join(OUT, `linked_${id}.json`), JSON.stringify(linked));
  }
  fs.writeFileSync(path.join(DELEG_DIR, 'rollout_summary.json'), JSON.stringify(summary, null, 1), 'utf-8');
  console.log(JSON.stringify(summary.status));
  console.log('laws with delegations:', summary.laws_with_delegations, '/', summary.total_laws);
  console.log('errors:', summary.errors.length);
}

main();
