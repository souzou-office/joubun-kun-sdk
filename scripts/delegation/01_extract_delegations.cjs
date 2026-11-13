#!/usr/bin/env node
// 親法令の本文から委任表現 (「政令で定める」等) を列挙する。前方向・位置特定のみ。
// 実行: node 01_extract_delegations.cjs <law_id> [<law_id>...]
// 出力: rebuild_output/delegations/raw_{law_id}.json
'use strict';
const fs = require('fs');
const path = require('path');
const { DELEG_DIR, loadLaw, walkSentences, findDelegations } = require('./lib.cjs');

function extractLaw(lawId) {
  const law = loadLaw(lawId);
  const delegations = [];
  for (const s of walkSentences(law)) {
    const hits = findDelegations(s.text);
    for (const h of hits) {
      delegations.push({
        article: s.article,
        article_title: s.articleTitle,
        caption: s.caption,
        provision: s.provision,
        paragraph: s.paragraph,
        item: s.item,
        subitem: s.subitem,
        sentence_idx: s.sidx,
        offset: h.offset,
        expr: h.expr,
        kind: h.kind,
        kind_raw: h.kind_raw,
        joint: h.joint,
        // 委任対象の後続語 (「政令で定める○○」の○○。突き合わせ用に20字)
        trailing: s.text.substring(h.offset[1], h.offset[1] + 20),
        context: s.text.substring(Math.max(0, h.offset[0] - 30), h.offset[1] + 30),
      });
    }
  }
  return {
    law_id: lawId,
    law_title: law.law_title,
    law_num: law.law_num,
    count: delegations.length,
    delegations,
  };
}

function main() {
  const ids = process.argv.slice(2);
  if (!ids.length) { console.error('Usage: node 01_extract_delegations.cjs <law_id>...'); process.exit(1); }
  fs.mkdirSync(DELEG_DIR, { recursive: true });
  for (const id of ids) {
    const out = extractLaw(id);
    const file = path.join(DELEG_DIR, `raw_${id}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf-8');
    const byKind = {};
    const byProv = {};
    for (const d of out.delegations) {
      byKind[d.kind] = (byKind[d.kind] || 0) + 1;
      byProv[d.provision] = (byProv[d.provision] || 0) + 1;
    }
    console.log(`${id} ${out.law_title}: ${out.count} delegations`, JSON.stringify(byKind), JSON.stringify(byProv));
  }
}

if (require.main === module) main();
module.exports = { extractLaw };
