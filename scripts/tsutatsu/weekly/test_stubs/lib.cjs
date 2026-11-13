// check_build.cjs 用の 03・07・08 の代わり（本物と同じ形のファイルを書く。紐付けの規則は簡単にしてある）。本番では使わない
//   items の各行に確かめ用の欄 home（"<law_id>:<条>"。無ければ機械では紐付かない＝浮き）を持たせる
'use strict';
const fs = require('fs');
const path = require('path');

const readNdjson = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// 07 と同じ形: links { "<law>:<条>": [ref] }、orphans [{source_path, source_url, no, caption, circular_path}]
function buildLinks(items, pdfItems, assignments) {
  const links = {}, orphans = [];
  const add = (key, ref) => { (links[key] = links[key] || []).push(ref); };
  for (const it of items) {
    const ref = { id: `h:${it.circular_path}:${it.tsutatsu_no}`, source: 'html', tsutatsu_no: it.tsutatsu_no, caption: it.caption, circular_path: it.circular_path, source_url: it.source_url, relation: 'home' };
    const a = assignments[`${it.source_path}#${it.tsutatsu_no}`];
    if (it.home) add(it.home, ref);
    else if (a) add(`${a.law_id}:${a.article}`, ref);
    else orphans.push({ source_path: it.source_path, source_url: it.source_url, no: it.tsutatsu_no, caption: it.caption, circular_path: it.circular_path });
  }
  for (const p of pdfItems) {
    const ref = { id: `p:${p.url}`, source: 'pdf', title: p.title, abolished: !!p.abolished, circular_path: p.circular_path, source_url: p.url, relation: 'home' };
    for (const k of p.recovered_arts || []) add(k, ref);
  }
  return { links, orphans };
}

// 08 と同じ形: {law_id}.json { "<条>": [ {src, grp, url, no, cap, body} | {src:'pdf', grp, url, title, ab} ] } と index.json
function buildChunks(links, items) {
  const body = {};
  for (const it of items) body[`${it.source_url}|${it.tsutatsu_no}`] = it;
  const byLaw = {};
  for (const [key, refs] of Object.entries(links)) {
    const i = key.indexOf(':');
    const law = key.slice(0, i), jou = key.slice(i + 1);
    const arr = refs.map((r) => (r.source === 'html'
      ? { src: 'html', grp: r.circular_path, url: r.source_url, no: r.tsutatsu_no, cap: r.caption || '', body: String((body[`${r.source_url}|${r.tsutatsu_no}`] || {}).body || '').slice(0, 4000) }
      : { src: 'pdf', grp: r.circular_path, url: r.source_url, title: r.title || '', ...(r.abolished ? { ab: 1 } : {}) }));
    (byLaw[law] = byLaw[law] || {})[jou] = arr;
  }
  const index = { generated_from: 'stub', laws: {} };
  for (const [law, arts] of Object.entries(byLaw)) index.laws[law] = { articles: Object.keys(arts).length, refs: Object.values(arts).reduce((s, a) => s + a.length, 0) };
  return { byLaw, index };
}

module.exports = { readNdjson, buildLinks, buildChunks };
