// 23: vec_homes_update_v3 のうち Vectorize _reverse に実在しない id を分類する。
//     22 が測った実在idを唯一の真実として使う（R2のv2チャンクに載っていることは
//     _reverse に埋め込まれていることの証拠にならない）。読み取りのみ。
//
//   node scripts/tsutatsu/23_reverse_missing_autopsy.cjs
const fs = require('fs');
const path = require('path');
// 比べる相手（前回ビルド＝本番が読んでいる版）。v4 を作るときは v3（既定）。
const TSU_PREV = process.env.TSU_PREV || 'v3';
// 調べる版（21 が出した vec_homes_update_{TSU_VER}）。v3 のときの調査を再現するなら TSU_PREV=v2 TSU_VER=v3
const TSU_VER = process.env.TSU_VER || 'v4';
const zlib = require('zlib');
const SITE = require('../site_config.cjs');
const REPO = path.join(__dirname, '..', '..');
const STATE = path.join(__dirname, 'state');
const DATA = path.join(REPO, 'docs', 'benchmarks', 'tax_ab', 'data');
const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}` };
const norm = (s) => String(s || '').replace(/[−–—―ー－]/g, '-').replace(/\s/g, '').trim();

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
  const rows = zlib.gunzipSync(fs.readFileSync(path.join(DATA, `vec_homes_update_${TSU_VER}.ndjson.gz`)))
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const missing = new Set(JSON.parse(fs.readFileSync(path.join(STATE, `vec_homes_update_${TSU_VER}_missing_ids.json`), 'utf8')));

  // v2 チャンクの (url|番号) → src の集合
  const v2Src = new Map();
  for (const k of await listKeys(`tsutatsu_chunks_${TSU_PREV}/`)) {
    const lawId = path.basename(k, '.json'); if (lawId === 'index') continue;
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/${encodeURIComponent(k)}`, { headers: H });
    if (!r.ok) continue;
    const d = await r.json();
    for (const arr of Object.values(d)) {
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        const kk = `${t.url || ''}|${norm(t.no || t.title)}`;
        if (!v2Src.has(kk)) v2Src.set(kk, new Set());
        v2Src.get(kk).add(t.src || 'html');
      }
    }
  }

  // 現コーパスの本文長
  const stamp = fs.readdirSync(STATE).filter((x) => /^tsutatsu_items_\d{8}\.ndjson$/.test(x)).sort().pop().match(/(\d{8})/)[1];
  const bodyLen = new Map();
  for (const l of fs.readFileSync(path.join(STATE, `tsutatsu_items_${stamp}.ndjson`), 'utf8').split('\n')) {
    if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    bodyLen.set(`${o.source_url}|${o.tsutatsu_no}`, (o.body || '').length);
  }

  const cls = { new_in_v3: [], pdf_only: [], html_in_v2: [] };
  for (const r of rows) {
    if (!missing.has(r.id)) continue;
    const kk = `${r.metadata.src}|${norm(r.metadata.no)}`;
    const srcs = v2Src.get(kk);
    if (!srcs) cls.new_in_v3.push(r);
    else if (!srcs.has('html')) cls.pdf_only.push(r);
    else cls.html_in_v2.push(r);
  }
  const show = (name, arr) => {
    console.log(`\n【${name}】${arr.length}本`);
    for (const r of arr.slice(0, 3)) {
      console.log(`  no=${r.metadata.no}  本文${bodyLen.get(`${r.metadata.src}|${r.metadata.no}`) ?? '?'}字`);
      console.log(`    ${r.metadata.src}`);
    }
  };
  console.log(`homes更新の全 ${rows.length}本 / _reverse に実在 ${rows.length - missing.size}本 / 未登録 ${missing.size}本`);
  show('v2チャンクに存在しない（v3で初めて拾った通達）', cls.new_in_v3);
  show('v2にあるがPDF由来のみ（16は html 限定なので元から対象外）', cls.pdf_only);
  show('v2にhtmlとして存在（本来 _reverse にあるべきだった）', cls.html_in_v2);

  // 942本（本当に既存）だけの homes 更新ファイル
  const existing = rows.filter((r) => !missing.has(r.id));
  const outF = path.join(DATA, `vec_homes_update_${TSU_VER}_existing.ndjson.gz`);
  fs.writeFileSync(outF, zlib.gzipSync(Buffer.from(existing.map((o) => JSON.stringify(o)).join('\n') + '\n')));
  console.log(`\nvec_homes_update_v3_existing.ndjson.gz  ${existing.length}本`);
  fs.writeFileSync(path.join(STATE, 'reverse_existing_ids.json'), JSON.stringify([...rows.filter((r) => !missing.has(r.id)).map((r) => r.id)]));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
