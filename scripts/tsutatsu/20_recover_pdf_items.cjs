// 20: PDF由来の通達を R2 v2 から復元する（R2読み取りのみ・0リクエスト対NTA・0円）。
//
//   なぜ再取得しなくてよいか: 07_build_links が pdfItems から使うのは
//   url / title / abolished / circular_path と、アンカー先だけ（07:266-273）。
//   R2 v2 のチャンクは PDF由来の各通達を { src:'pdf', url, title, ab, grp } で持ち、
//   **どの条にぶら下がるかはチャンクのキーそのもの**。よって前回ビルドが決めた
//   PDF→条 の紐付けをそのまま復元できる。snippet/本文は 07 では使わない。
//
//   限界: 同じURLで中身が改訂されたPDFは、この方法では検出できない。
//         それは pdf_ledger の etag/last_modified による定期更新の守備範囲。
//
//   node scripts/tsutatsu/20_recover_pdf_items.cjs [--write]
const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');
// 比べる相手（前回ビルド＝本番が読んでいる版）。v4 を作るときは v3（既定）。
const TSU_PREV = process.env.TSU_PREV || 'v3';
const STATE = path.join(__dirname, 'state');
const REPO = path.join(__dirname, '..', '..');
const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}` };

async function listKeys(prefix) {
  const out = []; let c = null;
  do {
    const u = new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects`);
    u.searchParams.set('prefix', prefix); u.searchParams.set('per_page', '1000');
    if (c) u.searchParams.set('cursor', c);
    const j = await (await fetch(u, { headers: H })).json();
    if (!j.success) break;
    out.push(...(j.result || []).map((x) => x.key)); c = (j.result_info || {}).cursor || null;
  } while (c);
  return out;
}

async function main() {
  const stamp = fs.readdirSync(STATE).filter((x) => /^tsutatsu_items_\d{8}\.ndjson$/.test(x)).sort().pop().match(/(\d{8})/)[1];
  // url -> { title, ab, grp, arts:Set("law_id:jou") }
  const byUrl = new Map();
  for (const k of await listKeys(`tsutatsu_chunks_${TSU_PREV}/`)) {
    const lawId = path.basename(k, '.json'); if (lawId === 'index') continue;
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/${encodeURIComponent(k)}`, { headers: H });
    if (!r.ok) continue;
    const d = await r.json();
    for (const [jou, arr] of Object.entries(d)) {
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        if (t.src !== 'pdf' || !t.url) continue;
        if (!byUrl.has(t.url)) byUrl.set(t.url, { title: t.title || '', ab: !!t.ab, grp: t.grp || '', arts: new Set() });
        const e = byUrl.get(t.url);
        if (t.title && !e.title) e.title = t.title;
        e.arts.add(`${lawId}:${jou}`);
      }
    }
  }
  console.log(`R2 v2 から復元したPDF: ${byUrl.size} 件 / 紐付け ${[...byUrl.values()].reduce((s, v) => s + v.arts.size, 0)} 本`);

  // 差分: 04_fetch_pdfs --list の対象URLと突き合わせる
  const manFile = path.join(STATE, `manifest_${stamp}.ndjson`);
  const listUrls = new Set();
  if (fs.existsSync(manFile)) {
    for (const l of fs.readFileSync(manFile, 'utf8').split('\n')) {
      if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
      for (const u of (o.pdf_links || [])) {
        if (/\/kaisei\//.test(u) || /\/taxes\//.test(u)) continue; // 04 と同じ除外
        listUrls.add(u);
      }
    }
  }
  const inBoth = [...listUrls].filter((u) => byUrl.has(u));
  const onlyList = [...listUrls].filter((u) => !byUrl.has(u));
  const onlyR2 = [...byUrl.keys()].filter((u) => !listUrls.has(u));
  console.log(`\n差分:`);
  console.log(`  (i)  v2にあり今回の一覧にもある     ${inBoth.length}件  ← 取得不要`);
  console.log(`  (ii) 一覧にあるが v2 に無い（新規） ${onlyList.length}件  ← ここだけ取得が要る`);
  console.log(`  (iii) v2にあるが一覧に無い          ${onlyR2.length}件  ← 国税庁側で消えた可能性。今回は残す`);
  if (onlyList.length) { console.log('\n  (ii) の例:'); onlyList.slice(0, 6).forEach((u) => console.log('    ' + u)); }
  if (onlyR2.length) { console.log('\n  (iii) の例:'); onlyR2.slice(0, 4).forEach((u) => console.log('    ' + u)); }

  // PDFのタイトルだけを別ファイルに落とす。今回の再抽出で様式名が本文断片に
  // 化けたものを 07 側で拾い直すため（--dump-titles は pdf_items を書き換えない）。
  if (process.argv.includes('--dump-titles')) {
    const t = {};
    for (const [url, v] of byUrl) if (v.title) t[url] = v.title;
    // ファイル名は 07 が読む名前のまま（中身は「前回ビルド＝TSU_PREV のタイトル」）
    fs.writeFileSync(path.join(STATE, 'pdf_titles_v2.json'), JSON.stringify(t));
    console.log(`\n→ state/pdf_titles_v2.json (${Object.keys(t).length}件)`);
  }

  if (process.argv.includes('--write')) {
    const out = [...byUrl.entries()].map(([url, v]) => ({
      url, title: v.title, abolished: v.ab, circular_path: v.grp,
      // 07 の citations は {kind,article} の相対参照（法令マップで解決する形）。
      // 復元分は既に条が確定しているので別フィールドで渡す。
      citations: [],
      recovered_arts: [...v.arts],
      recovered_from: `r2_${TSU_PREV}`,
    }));
    fs.writeFileSync(path.join(STATE, `pdf_items_${stamp}.ndjson`), out.map((o) => JSON.stringify(o)).join('\n') + '\n');
    fs.writeFileSync(path.join(STATE, `pdf_fetch_targets_${stamp}.json`), JSON.stringify(onlyList, null, 1));
    console.log(`\n→ state/pdf_items_${stamp}.ndjson (${out.length}件)`);
    console.log(`→ state/pdf_fetch_targets_${stamp}.json (${onlyList.length}件・未取得)`);
  }
}
if (require.main === module) main();
