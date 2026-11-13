// 通達のページの見出し（URL → 見出し）を、取り込んだページ一式（all_tsutatsu_YYYYMMDD）から作る。読むだけ。2026-10-22。
//
// 通達のデータ（tsutatsu_chunks）は通達 1 本ずつの見出し（cap）だけを持ち、複数の通達をまとめる国税庁のページの見出し
// （例「〔居住者、非永住者及び非居住者（第3、4、5号関係）〕」「第7款 退職給与」）は 03_parse が条の判定に使うだけで残さない。
// 実務の人はページの見出しで通達を指すので、検索で通達を選ぶ Jev に添える（画面の通達の段と MCP の search_tsutatsu。
// A/B は PR #362 の会話・47 問で 上位 5 件の正解 78 → 86 本・MCP の上位 10 件 65 → 89 本）。
//
//   HTML: <title>（末尾の「｜国税庁」を外す）。無ければ <h1>
//   PDF : その PDF にリンクしている HTML のページの見出し（目次・一覧のページより、リンクの少ない本文のページを優先）＋リンクの文字
//
// 取り込みは UTF-8 に直して保存されている（<meta charset> は元の Shift_JIS のまま）ので、UTF-8 で読めればそれを使う。
// 週次の作り直し（scripts/tsutatsu/weekly/build.cjs）が {TSUTATSU_CHUNKS_PREFIX}/pages.json を作るのに使う。
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.nta.go.jp/law/tsutatsu/';

function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 元の文字コードで読む */ }
  const head = buf.slice(0, 3000).toString('latin1');
  const enc = /charset\s*=\s*["']?\s*euc-jp/i.test(head) ? 'euc-jp' : 'shift_jis';
  return new TextDecoder(enc).decode(buf);
}
const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// HTML 1 枚 → { title, pdfs: [{ url, text }] }
function readPage(html, url) {
  let title = clean((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]).replace(/\s*[｜|]\s*国税庁\s*$/, '').trim();
  if (!title) title = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
  const pdfs = [];
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+\.pdf)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { pdfs.push({ url: new URL(m[1], url).href, text: clean(m[2]).slice(0, 80) }); } catch { /* 読めない href は飛ばす */ }
  }
  return { title, pdfs };
}

/**
 * @param {string} root  all_tsutatsu_YYYYMMDD のフォルダ（中の kihon/… が https://www.nta.go.jp/law/tsutatsu/kihon/… に当たる）
 * @param {{ urls?: Set<string> }} [opt]  urls を渡すと、その URL の見出しだけを返す（通達のデータに出てくるページだけ）
 * @returns {Record<string, string>}  URL → 見出し（URL の順に並べる）
 */
function buildPageTitles(root, opt = {}) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.html?$/i.test(e.name)) files.push(p);
    }
  })(root);
  const titles = {};
  const pdfLinks = {};
  for (const f of files.sort()) {
    const url = BASE + path.relative(root, f).split(path.sep).join('/');
    const { title, pdfs } = readPage(decode(fs.readFileSync(f)), url);
    if (title) titles[url] = title;
    for (const p of pdfs) (pdfLinks[p.url] = pdfLinks[p.url] || []).push({ page: url, text: p.text });
  }
  const linkCount = {};
  for (const ls of Object.values(pdfLinks)) for (const l of ls) linkCount[l.page] = (linkCount[l.page] || 0) + 1;
  const isIndex = (u) => /目次|一覧/.test(titles[u] || '');
  for (const [pdf, ls] of Object.entries(pdfLinks)) {
    const best = ls.slice().sort((a, b) => (isIndex(a.page) - isIndex(b.page)) || (linkCount[a.page] - linkCount[b.page]) || (a.page < b.page ? -1 : 1))[0];
    const t = `${titles[best.page] || ''}${best.text ? `（${best.text}）` : ''}`.trim();
    if (t && !titles[pdf]) titles[pdf] = t;
  }
  const out = {};
  for (const u of Object.keys(titles).sort()) if (!opt.urls || opt.urls.has(u)) out[u] = titles[u];
  return out;
}

module.exports = { buildPageTitles, readPage, decode, BASE };

if (require.main === module) {
  const [root, outFile] = process.argv.slice(2);
  if (!root || !outFile) { console.error('使い方: node scripts/tsutatsu/page_titles.cjs <all_tsutatsu_YYYYMMDD> <出力.json>'); process.exit(2); }
  const t = buildPageTitles(root);
  fs.writeFileSync(outFile, JSON.stringify(t, null, 1));
  console.log(`見出し ${Object.keys(t).length} 件 → ${outFile}`);
}
