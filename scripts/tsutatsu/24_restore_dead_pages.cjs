// 24: NTA から消えたページの通達を R2 v2 から拾い直して v3 チャンクに戻す。
//
//   NTA は削除したページに HTTP 200 でエラーページを返す。01_crawl 側は検知するように
//   したが、既に消えたページの本文はもう取れない。前回ビルド(v2)には中身が残っているので、
//   そこから条・番号・見出し・URL を引き継ぐ。gone:true を付けて「原本は消えている」印にする。
//
//   戻すのは「URLごと v3 に存在しない html 通達」だけ。ページが生きているのに番号が
//   消えたもの（v2 の誤帰属の解消を含む）は戻さない — 戻すと直した誤りが復活する。
//
//   実行: TSU_VER=v3 node scripts/tsutatsu/24_restore_dead_pages.cjs [--write]
const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');
// 比べる相手（前回ビルド＝本番が読んでいる版）。v4 を作るときは v3（既定）。
const TSU_PREV = process.env.TSU_PREV || 'v3';
const REPO = path.join(__dirname, '..', '..');
// 書き込み先の版は必ず指定する（既定を置くと本番 v3 のローカル写しを書き換える）
const TSU_VER = process.env.TSU_VER;
if (!TSU_VER || TSU_VER === TSU_PREV) { console.error(`TSU_VER（新しい版。例 v4）を TSU_PREV=${TSU_PREV} と別に指定してください`); process.exit(1); }
const DIR = path.join(REPO, `tsutatsu_chunks_${TSU_VER}`);
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

(async () => {
  if (!fs.existsSync(DIR)) throw new Error(`${DIR} がありません。先に 08_build_chunks を流してください`);
  // v3 に出ている URL の集合と、条ごとの中身
  const v3 = {};
  const v3urls = new Set();
  const v3keys = new Set();   // lawId:jou:番号（URL違いの重複を作らないため）
  const norm = (x) => String(x || '').replace(/[−–—―ー－]/g, '-').replace(/\s/g, '').trim();
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
    const lawId = path.basename(f, '.json');
    v3[lawId] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const [jou, arr] of Object.entries(v3[lawId])) for (const t of arr) {
      if (t.url) v3urls.add(t.url);
      v3keys.add(`${lawId}:${jou}:${norm(t.no || t.title)}`);
    }
  }

  const add = [];
  let dup = 0;
  for (const k of await listKeys(`tsutatsu_chunks_${TSU_PREV}/`)) {
    const lawId = path.basename(k, '.json'); if (lawId === 'index') continue;
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/${encodeURIComponent(k)}`, { headers: H });
    if (!r.ok) continue;
    const d = await r.json();
    for (const [jou, arr] of Object.entries(d)) {
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        if (t.src !== 'html' || !t.url) continue;
        if (v3urls.has(t.url)) continue;              // ページは生きている → 触らない
        // 同じ条に同じ番号が既にある（＝内容は別URLに移って生きている）なら足さない
        if (v3keys.has(`${lawId}:${jou}:${norm(t.no || t.title)}`)) { dup++; continue; }
        add.push({ lawId, jou, ref: { ...t, gone: true } });
      }
    }
  }
  const urls = new Set(add.map((a) => a.ref.url));
  console.log(`v3 に存在しない URL の html 通達: ${add.length}本 / ${urls.size}ページ`);
  console.log(`  （同じ条に同じ番号が既にある＝移転先で生きているため足さなかった: ${dup}本）`);
  for (const u of urls) console.log('  ' + u);
  for (const a of add) console.log(`  ${a.lawId}:${a.jou}  no=${a.ref.no || a.ref.title}`);

  if (!process.argv.includes('--write')) { console.log('\n（--write を付けると書き戻します）'); return; }
  const touched = new Set();
  for (const a of add) {
    v3[a.lawId] = v3[a.lawId] || {};
    (v3[a.lawId][a.jou] = v3[a.lawId][a.jou] || []).push(a.ref);
    touched.add(a.lawId);
  }
  for (const lawId of touched) fs.writeFileSync(path.join(DIR, `${lawId}.json`), JSON.stringify(v3[lawId]), 'utf8');
  // index.json の articles/refs を数え直す
  const idxFile = path.join(DIR, 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  for (const lawId of Object.keys(v3)) {
    if (!idx.laws[lawId]) idx.laws[lawId] = { articles: 0, refs: 0 };
    idx.laws[lawId].articles = Object.keys(v3[lawId]).length;
    idx.laws[lawId].refs = Object.values(v3[lawId]).reduce((s, l) => s + l.length, 0);
  }
  idx.restored_dead_pages = { rule: 'NTAから消えたページ(HTTP200のエラーページ)の通達をR2 v2から復元。gone:true', total: add.length, pages: urls.size };
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2), 'utf8');
  console.log(`\n書き戻し: ${touched.size}法令 / ${add.length}本`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
