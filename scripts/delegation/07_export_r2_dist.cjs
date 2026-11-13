#!/usr/bin/env node
// 全件展開結果 (all/linked_*.json) を配信用にスリム化してチャンク分割する。
// 出力: rebuild_output/delegations/r2_dist/
//   index.json            … law_id → チャンク番号
//   chunk_NNN.json        … { law_id: { law_title, articles: { "66_4": [deleg...] } } }
// R2 プレフィックス delegations_v1/ にアップロードする想定 (既存パスには触らない)。
'use strict';
const fs = require('fs');
const path = require('path');
const { DELEG_DIR } = require('./lib.cjs');

const ALL = path.join(DELEG_DIR, 'all');
const DIST = path.join(DELEG_DIR, 'r2_dist');
const CHUNK_LIMIT = 2 * 1024 * 1024; // 2MB/チャンク

// 「66_4」→「第六十六条の四」
const KANJI_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function toKanji(n) {
  n = parseInt(n, 10);
  if (!n && n !== 0) return '';
  let s = '';
  if (n >= 1000) { s += (Math.floor(n / 1000) > 1 ? KANJI_DIGITS[Math.floor(n / 1000)] : '') + '千'; n %= 1000; }
  if (n >= 100) { s += (Math.floor(n / 100) > 1 ? KANJI_DIGITS[Math.floor(n / 100)] : '') + '百'; n %= 100; }
  if (n >= 10) { s += (Math.floor(n / 10) > 1 ? KANJI_DIGITS[Math.floor(n / 10)] : '') + '十'; n %= 10; }
  return s + (n ? KANJI_DIGITS[n] : '');
}
function artTitleOf(artNum) {
  const parts = String(artNum).split('_');
  let t = `第${toKanji(parts[0])}条`;
  for (const p of parts.slice(1)) t += `の${toKanji(p)}`;
  return t;
}

function slimLaw(linked) {
  const articles = {};
  let count = 0;
  for (const d of linked.delegations) {
    if (d.provision !== 'main') continue;
    // 直接の受け皿を先に、準用先の受け皿（via_junyo）を後に（画面・条文ページは先頭を出す）。
    // 条が複数に決まる委任は全部出す（条文ページは全部並べる。2026-09-22 まで 6 条で切っていた）。30 は暴走防止。
    // 検索（App.jsx・worker/select.js）が使うのは先頭 1 候補（複数候補を渡す設定でも先頭 2）だけなので、ここを増やしても検索には効かない
    const strong = d.candidates.filter(c => c.strength === 'strong' && c.provision === 'main' &&
      c.kind_ok !== false && !c.kind_mismatch).sort((a, b) => (a.via_junyo ? 1 : 0) - (b.via_junyo ? 1 : 0)).slice(0, 30);
    const weak = strong.length ? [] : d.candidates.filter(c => c.strength === 'weak' && c.provision === 'main').slice(0, 3);
    const cands = [...strong, ...weak].map(c => ({
      law_id: c.law_id,
      law_title: c.law_title,
      article: c.article,
      article_title: c.article_title || artTitleOf(c.article),
      paragraph: c.paragraph || null,
      item: c.item || null,
      strength: c.strength,
      via_junyo: c.via_junyo || false,
    }));
    const entry = {
      paragraph: d.parent_paragraph || null,
      item: d.parent_item || null,
      expr: d.expr,
      kind: d.kind,
      // 委任対象の後続語 (ラベル用「政令で定める特殊の関係…」)
      trailing: (d.trailing || '').slice(0, 14),
      status: d.status,
      candidates: cands,
    };
    if (d.law_level) entry.law_level = { law_id: d.law_level.law_id, law_title: d.law_level.law_title };
    (articles[d.parent_article] ??= []).push(entry);
    count++;
  }
  return { law_title: linked.parent_law_title, count, articles };
}

function main() {
  fs.mkdirSync(DIST, { recursive: true });
  const files = fs.readdirSync(ALL).filter(f => f.startsWith('linked_'));
  console.log('laws:', files.length);

  const index = {};
  let chunk = {}, chunkSize = 0, chunkNum = 0, totalDelegs = 0;
  const flush = () => {
    if (!Object.keys(chunk).length) return;
    fs.writeFileSync(path.join(DIST, `chunk_${String(chunkNum).padStart(3, '0')}.json`), JSON.stringify(chunk));
    chunkNum++;
    chunk = {}; chunkSize = 0;
  };

  for (const f of files.sort()) {
    const linked = JSON.parse(fs.readFileSync(path.join(ALL, f), 'utf-8'));
    const slim = slimLaw(linked);
    if (!slim.count) continue;
    totalDelegs += slim.count;
    const s = JSON.stringify(slim).length;
    if (chunkSize + s > CHUNK_LIMIT && chunkSize > 0) flush();
    chunk[linked.parent_law_id] = slim;
    chunkSize += s;
    index[linked.parent_law_id] = chunkNum;
  }
  flush();
  fs.writeFileSync(path.join(DIST, 'index.json'), JSON.stringify(index));
  console.log('chunks:', chunkNum, 'laws indexed:', Object.keys(index).length, 'delegations:', totalDelegs);
}

if (require.main === module) main();
module.exports = { slimLaw, artTitleOf, CHUNK_LIMIT };   // 週次（scripts/delegation/weekly）と共用
