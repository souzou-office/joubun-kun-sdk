// R2 の条文ファイル（{ARTICLES_PREFIX}/{law_id}/_index.json と条ごとのファイル。scripts/rebuild/lib/split.py の出力）から、
// PC の fetched_laws/{law_id}.json（egov_parser の出力。委任先の 01・02 が読む）と同じ形を組み立てる。
//
// 条ごとのファイルは同じ題名の条（本則の第一条と附則の第一条など）を 1 本にまとめているので、元の並びは戻らない。
// 01・02 が並びに頼るのは本則と附則の境目（lib.cjs の markProvisions: 条番号が戻ったところから附則）だけなので、
// 本則の条（structure.suppl の無い条）を _index.json の files の順（＝元の文書での初出の順）に並べ、その後に附則の条、最後に別表などを置く。
// これで markProvisions は元と同じ境目を引き、子法令の「条番号 → 文」の索引（02 の getSentIndex）も本則 → 附則の順になる。
'use strict';

function isSuppl(a) { return !!(a && a.structure && a.structure.suppl); }

// 附則の条は、目次（_index.json の toc。split.py の build_toc が文書順に作る）の附則のまとまりの順（制定時の附則 → 改正法の附則の順）に並べる。
// files の順（題名の初出の順）のままだと、本則の第一条と同じファイルにある改正法の附則第一条が、制定時の附則（労働基準法の第百二十二条〜など、
// 本則から番号が続くもの）より前に来て、markProvisions がそこから附則とみなし、PC（文書順）では本則として紐付けていた制定時の附則の条が落ちる
// （2026-09-28。委任先の週次の初回の下見で労働基準法 第百三十三条・第百三十九条・第百四十一条などの紐付けが消えた）
const supplKey = (a) => String((a && a.structure && a.structure.amend_law_num) || '');
function orderSuppl(index, suppl) {
  const rank = new Map();
  for (const t of (index && index.toc) || []) {
    if (!t || t.kind !== 'suppl') continue;
    const m = String(t.title || '').match(/^附則（(.+)）$/);
    const key = m ? m[1] : '';
    if (!rank.has(key)) rank.set(key, rank.size);
  }
  if (!rank.size) return suppl;
  const last = rank.size;
  return suppl.map((a, i) => ({ a, i, r: rank.has(supplKey(a)) ? rank.get(supplKey(a)) : last }))
    .sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.a);   // まとまりの中は files の順（番号順）のまま
}

// index: _index.json、files: [ファイルの中身（{ law_id, law_title, law_num, law_type, articles }）]（index.files と同じ順）
function assembleLaw(index, files) {
  const main = [], suppl = [], rest = [];
  for (const f of files) {
    for (const a of (f && f.articles) || []) {
      if (a.type === 'article' && !isSuppl(a)) main.push(a);
      else if (a.type === 'article') suppl.push(a);
      else rest.push(a);
    }
  }
  return { law_id: index.law_id, law_title: index.law_title || '', law_num: index.law_num || '', law_type: index.law_type || '', articles: [...main, ...orderSuppl(index, suppl), ...rest] };
}

// 1 法令を R2 から組み立てる。_index.json が無ければ null。載っているファイルが欠けていれば throw（黙って欠けた法令で紐付けない）
async function fetchLaw(r2, prefix, lawId) {
  const index = await r2.getJson(`${prefix}/${lawId}/_index.json`);
  if (!index) return null;
  const files = [];
  for (const f of index.files || []) {
    const d = await r2.getJson(`${prefix}/${lawId}/${f.filename}`);
    if (!d || !Array.isArray(d.articles)) throw new Error(`${prefix}/${lawId}/${f.filename} が無い・形が違う（_index.json には載っている）`);
    files.push(d);
  }
  return assembleLaw(index, files);
}

// 並べて取る（R2 の S3 API。同時 n 本）
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

module.exports = { assembleLaw, fetchLaw, pool, isSuppl };
