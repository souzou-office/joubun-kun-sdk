// 22: vec_homes_update_v3 / vec_compat_check_v3 の id が Vectorize _reverse に実在するか
//     get_by_ids で確認する（読み取りのみ・書き込みは一切しない）。
//
//   21_gen_vec_input は「その通達番号が v2 チャンクのどこかにあるか」で新規/既存を判定して
//   いた。v2 チャンクにあることは _reverse に埋め込まれていることの証拠にならない
//   （16_embed_reverse は html 限定・本文20字以上・実行時点のコーパス）。実物に聞く。
//
//   node scripts/tsutatsu/22_check_reverse_ids.cjs <ndjson.gz> [...]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SITE = require('../site_config.cjs');
const REPO = path.join(__dirname, '..', '..');
const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const URL_ = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/vectorize/v2/indexes/tsutatsu-embeddings-v1/get_by_ids`;
// get_by_ids は1リクエスト20件まで（2026-09-24 に 100 で 400 エラー: max id count is 20）
const BATCH = parseInt(process.env.BATCH || '20', 10);

const readNd = (f) => (/\.gz$/.test(f) ? zlib.gunzipSync(fs.readFileSync(f)) : fs.readFileSync(f))
  .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function getByIds(ids) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      const j = await r.json();
      if (j.success) return j.result || [];
      if (a === 4) throw new Error(JSON.stringify(j.errors).slice(0, 200));
    } catch (e) { if (a === 4) throw e; }
    await new Promise((s) => setTimeout(s, 1000 * 2 ** a));
  }
  return [];
}

(async () => {
  for (const f of process.argv.slice(2)) {
    const rows = readNd(f);
    const found = new Set();
    for (let i = 0; i < rows.length; i += BATCH) {
      const ids = rows.slice(i, i + BATCH).map((r) => r.id);
      for (const v of await getByIds(ids)) found.add(v.id);
      process.stdout.write(`\r  ${path.basename(f)} ${Math.min(i + BATCH, rows.length)}/${rows.length} 実在${found.size}`);
    }
    const missing = rows.filter((r) => !found.has(r.id));
    console.log(`\n${path.basename(f)}: 全${rows.length} / 実在${found.size} / 未登録${missing.length}`);
    const out = path.join(REPO, 'scripts', 'tsutatsu', 'state', path.basename(f).replace(/\.ndjson(\.gz)?$/, '') + '_missing_ids.json');
    fs.writeFileSync(out, JSON.stringify(missing.map((r) => r.id), null, 0));
    const outE = out.replace(/_missing_ids\.json$/, '_existing_ids.json');
    fs.writeFileSync(outE, JSON.stringify([...found], null, 0));
    console.log(`  未登録id → ${path.relative(REPO, out)}`);
    console.log(`  実在id   → ${path.relative(REPO, outE)}`);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
