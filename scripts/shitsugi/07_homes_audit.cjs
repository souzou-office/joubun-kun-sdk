// 07: Vectorize の _shitsugi / _saiketsu の homes が、9/1〜9/2 に100%化した
//     条文リンク（R2 article_links_v1）と一致しているかを突き合わせる（0円・読み取りのみ）。
//
//   /search の押し上げ（cloudflare-worker.js 1282行〜・1326行〜）は homes を読んでいるので、
//   homes が古いままなら押し上げは古い紐付けで動いている。
//
//   node scripts/shitsugi/07_homes_audit.cjs
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');
const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'tsutatsu', 'state');
const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}` };
const IDX = 'tsutatsu-embeddings-v1';

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
const r2 = async (k) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/${encodeURIComponent(k)}`, { headers: H });
  return r.ok ? r.json() : null;
};
async function getByIds(ids) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/vectorize/v2/indexes/${IDX}/get_by_ids`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      });
      const j = await r.json();
      if (j.success) return j.result || [];
      if (a === 4) throw new Error(JSON.stringify(j.errors).slice(0, 160));
    } catch (e) { if (a === 4) throw e; }
    await new Promise((s) => setTimeout(s, 1000 * 2 ** a));
  }
  return [];
}

(async () => {
  // 1) 新しい条文リンク（article_links_v1）→ 資料id → 条文集合
  const linksOf = { j: new Map(), s: new Map() };
  const srcOf = new Map();   // 資料id -> Set(出所 kankei/abstract/tsutatsu/body/llm)
  for (const k of await listKeys('article_links_v1/')) {
    const lawId = path.basename(k, '.json');
    if (lawId === '_cases') continue;
    const d = await r2(k); if (!d) continue;
    for (const [jou, hits] of Object.entries(d)) {
      for (const h of hits) {
        const m = linksOf[h.k]; if (!m) continue;
        if (!m.has(h.i)) m.set(h.i, new Set());
        m.get(h.i).add(`${lawId}:${jou}`);
        if (!srcOf.has(h.i)) srcOf.set(h.i, new Set());
        srcOf.get(h.i).add(h.s);
      }
    }
  }
  console.log(`article_links_v1: 事例 ${linksOf.j.size}件 / 裁決 ${linksOf.s.size}件 に条文リンクがある`);

  // 2) コーパス全件の id
  const shi = [], sai = [];
  for (const k of await listKeys('shitsugi_v1/cases_')) {
    const d = await r2(k); if (!d) continue;
    for (const sid of Object.keys(d)) shi.push(sid);
  }
  for (const k of await listKeys('saiketsu_v1/cases_')) {
    const d = await r2(k); if (!d) continue;
    for (const id of Object.keys(d)) sai.push(id);
  }
  console.log(`コーパス: 事例 ${shi.length}件 / 裁決 ${sai.length}件`);

  // 3) Vectorize から homes を取る（要旨ベクトルのみ。裁決の節ベクトルは別途）
  const vid = { j: (x) => crypto.createHash('md5').update(`shitsugi:${x}`).digest('hex'),
                s: (x) => crypto.createHash('md5').update(`saiketsu:${x}#abst`).digest('hex') };
  const report = {};
  for (const [kind, list] of [['j', shi], ['s', sai]]) {
    const idMap = new Map(list.map((x) => [vid[kind](x), x]));
    const ids = [...idMap.keys()];
    const backup = [];
    let done = 0;
    for (let i = 0; i < ids.length; i += 20) {
      for (const v of await getByIds(ids.slice(i, i + 20))) backup.push(v);
      done = Math.min(i + 20, ids.length);
      if (done % 400 === 0) process.stdout.write(`\r  ${kind}: ${done}/${ids.length}`);
    }
    console.log(`\r  ${kind}: ${done}/${ids.length} 取得 ${backup.length}本`);
    const bf = path.join(OUT, `vec_backup_${kind === 'j' ? 'shitsugi' : 'saiketsu'}.ndjson`);
    fs.writeFileSync(bf, backup.map((v) => JSON.stringify(v)).join('\n') + '\n');

    let empty = 0, fewer = 0, extra = 0, same = 0, missing = 0;
    const parse = (v) => { try { return JSON.parse((v.metadata || {}).homes || '[]'); } catch { return []; } };
    const got = new Map(backup.map((v) => [v.id, v]));
    for (const [id, src] of idMap) {
      const v = got.get(id);
      if (!v) { missing++; continue; }
      const old = new Set(parse(v).map((h) => `${h.l}:${h.a}`));   // 形は要確認
      const neu = linksOf[kind].get(src) || new Set();
      if (old.size === 0) { empty++; continue; }
      // 比較は条番号の表記が違うので件数だけ先に見る
      if (neu.size > old.size) fewer++;
      else if (neu.size < old.size) extra++;
      else same++;
    }
    report[kind] = { total: idMap.size, missing, empty, fewer, extra, same };
    console.log(`  → ベクトル無し ${missing} / homes空 ${empty} / 新リンクの方が多い ${fewer} / 少ない ${extra} / 同数 ${same}`);
    console.log(`  バックアップ: ${path.relative(REPO, bf)}`);
  }
  // homes の実物を1本表示（形式確認用）
  const sample = fs.readFileSync(path.join(OUT, 'vec_backup_shitsugi.ndjson'), 'utf8').split('\n')[0];
  try { const v = JSON.parse(sample); console.log('\nhomes の実物（事例1本）:', String((v.metadata || {}).homes).slice(0, 200)); } catch {}
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
