// 14: beppyo_inputs.jsonl を bge-m3 で埋め込み namespace "_beppyo" に登録。
// 別表を「1別表＝1ベクトル(別表名+caption+先頭行)」で検索可能にする。通達の 16_embed_reverse と同じ要領。
// Blue-Green: 新namespace への追加のみ。既存ベクトル(law-embeddings-v2 / tsutatsu他namespace)は不変。
//
//   node scripts/rebuild/14_embed_beppyo.cjs --dry   # 件数確認
//   node scripts/rebuild/14_embed_beppyo.cjs          # 実行（ステージング相手）

const fs = require('fs');
const SITE = require('../site_config.cjs');
const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;   // 秘密はリポジトリに書かない（環境変数だけ）
if (!KEY && !process.argv.includes('--dry')) { console.error('BYPASS_KEY を環境変数で渡してください'); process.exit(1); }
const IN = `${SITE.localDataRoot}/rebuild_output/beppyo_inputs.jsonl`;
const BATCH = 20;

(async () => {
  const dry = process.argv.includes('--dry');
  const targets = fs.readFileSync(IN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(`埋め込み対象: ${targets.length}本 → namespace "_beppyo"  (${WORKER})`);
  if (dry) { console.log('例:', JSON.stringify(targets[0]).slice(0, 240)); console.log('★ DRY-RUN'); return; }

  let ok = 0, ng = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    try {
      const res = await fetch(`${WORKER}/api/admin/embed-tsutatsu`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ items: batch }),
      });
      const j = await res.json();
      if (res.ok && j.upserted) ok += j.upserted; else { ng += batch.length; if (ng <= 60) console.log('\n NG', res.status, JSON.stringify(j).slice(0, 140)); }
    } catch (e) { ng += batch.length; if (ng <= 60) console.log('\n ERR', e.message); }
    process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length}  登録${ok} 失敗${ng}`);
  }
  console.log(`\n完了: ${ok}登録 / ${ng}失敗  (namespace _beppyo)`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
