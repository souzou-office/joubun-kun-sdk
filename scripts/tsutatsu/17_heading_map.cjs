// 17: 通達ページの見出しから「通達番号 → 帰属条」を作る。
//
//   既存の tsutatsu_chunks_v2 には取りこぼしがある（所得税基本通達は 36-2 と 36-20 が
//   あるのに 36-21 が無い等）。ページ側には
//     <strong>法第36条《収入金額》関係</strong>   ← ここから後の通達はこの条に属する
//     <strong>36−13</strong>　（本文）            ← 通達番号
//   という構造があるので、文書順に走査して番号→条を拾う。推測は一切しない。
//
//   採用前に既存地図と突き合わせて一致率を出す（--verify）。
//
//   node scripts/tsutatsu/17_heading_map.cjs --tree kihon/shotoku --law 340AC0000000033 --verify
const fs = require('fs');
const path = require('path');
// 比べる相手（前回ビルド＝本番が読んでいる版）。v4 を作るときは v3（既定）。
const TSU_PREV = process.env.TSU_PREV || 'v3';
const { execFileSync } = require('child_process');
const SITE = require('../site_config.cjs');

const BASE = 'https://www.nta.go.jp';
const UA = `joubun-kun-crawler/1.0 (+contact: ${SITE.crawlerContact})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSjis(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  try { return execFileSync('iconv', ['-f', 'SHIFT_JIS', '-t', 'UTF-8', '-c'], { input: buf, maxBuffer: 64 * 1024 * 1024 }).toString(); }
  catch { return buf.toString('utf8'); }
}

const normNo = (s) => String(s || '').replace(/[−–—―ー－]/g, '-').replace(/[０-９]/g, (d) => '０１２３４５６７８９'.indexOf(d)).replace(/\s/g, '').trim();

// <strong> の中身だけを文書順に取り出し、条見出しと通達番号を振り分ける
function parsePage(html) {
  const out = [];
  let cur = null;
  const re = /<strong[^>]*>([\s\S]*?)<\/strong>/g;
  let m;
  while ((m = re.exec(html))) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    // 「法第36条《収入金額》関係」「法第70条の6《…》関係」。令・規則の見出しは別扱いなので拾わない
    const h = t.match(/^法第(\d+(?:の\d+)*)条(?:[《（(][^》）)]*[》）)])?\s*関係$/);
    if (h) { cur = h[1]; continue; }
    if (/^(?:令|規則|措置法|措令)第/.test(t)) { cur = null; continue; }
    // 通達番号（「36−13」「70の6−13」「9−4−1」「181〜223共−6」）
    const n = t.match(/^(\d+(?:の\d+)*(?:[～~]\d+(?:の\d+)*)?(?:[(（]?共[)）]?)?(?:[－−-]\d+(?:の\d+)*)+)$/);
    if (n && cur) out.push({ no: normNo(n[1]), article: cur });
  }
  return out;
}

async function collectPages(tree, maxPages) {
  const seen = new Set(), queue = [`/law/tsutatsu/${tree}/01.htm`, `/law/tsutatsu/${tree}/mokuji.htm`];
  const pages = [];
  while (queue.length && pages.length < maxPages) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const html = await fetchSjis(BASE + p);
    await sleep(1000); // 1req/秒（01_crawl.cjs と同じ礼儀）
    if (!html) continue;
    pages.push({ path: p, html });
    for (const m of html.matchAll(/href="([^"]+\.htm)(?:#[^"]*)?"/g)) {
      let href = m[1];
      if (href.startsWith('./')) href = path.posix.join(path.posix.dirname(p), href.slice(2));
      else if (!href.startsWith('/')) href = path.posix.join(path.posix.dirname(p), href);
      if (href.startsWith(`/law/tsutatsu/${tree}/`) && !seen.has(href)) queue.push(href);
    }
    if (pages.length % 25 === 0) process.stderr.write(`\r  ${pages.length}ページ (残キュー ${queue.length})`);
  }
  process.stderr.write(`\r  ${pages.length}ページ取得\n`);
  return pages;
}

async function main() {
  const arg = (f) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : null);
  const tree = arg('--tree'), lawId = arg('--law');
  const maxPages = Number(arg('--max') || 500);
  const outFile = arg('--out');
  const pages = await collectPages(tree, maxPages);

  const map = new Map();
  for (const p of pages) for (const x of parsePage(p.html)) {
    if (!map.has(x.no)) map.set(x.no, new Set());
    map.get(x.no).add(x.article);
  }
  console.log(`${tree}: ${pages.length}ページ / 通達番号 ${map.size}件`);
  const multi = [...map.entries()].filter(([, v]) => v.size > 1);
  console.log(`  複数の条にまたがる番号 ${multi.length}件（採用しない）`);

  if (process.argv.includes('--verify')) {
    const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
    const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
    if (!TOKEN) throw new Error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）');
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/${encodeURIComponent(`tsutatsu_chunks_${TSU_PREV}/${lawId}.json`)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const d = r.ok ? await r.json() : {};
    const existing = new Map();
    for (const [jou, arr] of Object.entries(d)) {
      if (!Array.isArray(arr)) continue;
      for (const t of arr) { const n = normNo(t.no); if (n) { if (!existing.has(n)) existing.set(n, new Set()); existing.get(n).add(jou); } }
    }
    let agree = 0, disagree = 0, onlyNew = 0;
    const bad = [];
    for (const [no, arts] of map) {
      if (arts.size > 1) continue;
      const a = [...arts][0];
      const ex = existing.get(no);
      if (!ex) { onlyNew++; continue; }
      if (ex.has(a)) agree++; else { disagree++; if (bad.length < 8) bad.push(`${no}: 見出し=${a} / 既存地図=${[...ex].join(',')}`); }
    }
    const onlyOld = [...existing.keys()].filter((n) => !map.has(n)).length;
    console.log(`  既存地図と照合: 一致 ${agree} / 不一致 ${disagree} (${(100 * agree / (agree + disagree)).toFixed(1)}%一致)`);
    console.log(`  見出し側にだけある番号 ${onlyNew}件 ← これが取りこぼし / 既存側にだけある番号 ${onlyOld}件`);
    if (bad.length) { console.log('  不一致の例:'); bad.forEach((b) => console.log('    ' + b)); }
  }
  if (outFile) {
    const obj = {};
    for (const [no, arts] of map) if (arts.size === 1) obj[no] = [...arts][0];
    fs.writeFileSync(outFile, JSON.stringify({ law_id: lawId, tree, map: obj }, null, 1));
    console.log(`→ ${outFile}`);
  }
}

if (require.main === module) main();
module.exports = { parsePage, normNo };
