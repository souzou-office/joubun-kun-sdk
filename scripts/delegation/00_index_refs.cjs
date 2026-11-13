#!/usr/bin/env node
// refs_v2.json (506MB) を一度だけ走査して以下に分割する:
//   delegations/refs_by_source/{law_id}.json   … ソース法令別の refs
//   delegations/reverse_index/{target_law_id}.json … target_law_id 別の逆引き (external + varref)
// 以降の工程 (02) と全件展開はこのインデックスだけを読む。
// 実行: node --max-old-space-size=14000 00_index_refs.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const { REBUILD, DELEG_DIR } = require('./lib.cjs');

const IN = path.join(REBUILD, 'refs_v2.json');
const BY_SRC = path.join(DELEG_DIR, 'refs_by_source');
const REV = path.join(DELEG_DIR, 'reverse_index');

fs.mkdirSync(BY_SRC, { recursive: true });
fs.mkdirSync(REV, { recursive: true });

console.time('read+parse');
const j = JSON.parse(fs.readFileSync(IN, 'utf-8'));
console.timeEnd('read+parse');
const refs = j.refs || j;

// ソース法令別にグループ化 (配列は参照共有なので低コスト)
const bySrc = new Map();
for (const key of Object.keys(refs)) {
  const at = key.indexOf('_Art');
  if (at < 0) continue;
  const src = key.substring(0, at);
  let g = bySrc.get(src);
  if (!g) { g = {}; bySrc.set(src, g); }
  g[key] = refs[key];
}
console.log('source laws:', bySrc.size);

// 書き出し + 逆引き構築
const rev = new Map();
let written = 0, revEntries = 0;
for (const [src, obj] of bySrc) {
  fs.writeFileSync(path.join(BY_SRC, src + '.json'), JSON.stringify(obj));
  written++;
  for (const [key, arr] of Object.entries(obj)) {
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      if ((r.type === 'external' || r.type === 'varref') && r.target_law_id && r.target_law_id !== src) {
        let list = rev.get(r.target_law_id);
        if (!list) { list = []; rev.set(r.target_law_id, list); }
        list.push({ src, key, i, ref: r });
        revEntries++;
      }
    }
  }
  if (written % 1000 === 0) console.log('  written', written);
}
console.log('reverse index targets:', rev.size, 'entries:', revEntries);

for (const [t, list] of rev) {
  fs.writeFileSync(path.join(REV, t + '.json'), JSON.stringify(list));
}
console.log('done');
