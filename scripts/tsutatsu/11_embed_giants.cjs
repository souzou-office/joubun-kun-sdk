// 11: 巨大条文（通達>THRESHOLD本）の通達を bge-m3 で埋め込み、Vectorize(tsutatsu-embeddings-v1)へ登録。
// 埋め込み&upsert は worker の /api/admin/embed-tsutatsu 経由（env.AI + env.TSUTATSU_VEC を使うため）。
// 更新時もこれを再実行すればOK（同一idはupsertで上書き）。
//
//   node scripts/tsutatsu/11_embed_giants.cjs            # staging へ登録
//   node scripts/tsutatsu/11_embed_giants.cjs --dry      # 対象だけ表示

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');
const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(REPO, 'tsutatsu_chunks_v1');
const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;   // 平文の既定値は置かない（鍵は取り替え済み。環境変数で渡す）
if (!KEY) { console.error('環境変数 BYPASS_KEY を設定してください'); process.exit(1); }
const THRESHOLD = 70;
const BATCH = 20;
const DRY = process.argv.includes('--dry');

(async () => {
  const items = [];
  const byArticle = {};
  for (const f of fs.readdirSync(SRC)) {
    if (f === 'index.json' || !f.endsWith('.json')) continue;
    const lawId = f.replace('.json', '');
    const d = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
    for (const jou in d) {
      const list = d[jou];
      if (list.length <= THRESHOLD) continue;
      byArticle[`${lawId}:${jou}`] = list.length;
      for (const t of list) {
        const no = t.no || t.title || '';
        if (!no) continue;
        // 各通達の「見出し＋本文全文」を埋め込む。bge-m3の上限(8192tok)に余裕（通達の本文は最大~2300字）。
        // 4000はチャンク側の本文上限と同じ安全弁（実際にここまで届く通達は無い）。
        const text = (`${t.cap || ''} ${(t.body || '').slice(0, 4000)}`).trim() || String(no);
        // id は 64 バイト上限があるので md5（32文字）に。マッピングは metadata.no で行う。
        const id = crypto.createHash('md5').update(`${lawId}:${jou}:${no}`).digest('hex');
        items.push({ id, ns: `${lawId}:${jou}`, no: String(no), text });
      }
    }
  }
  const seen = new Set();
  const uniq = items.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  console.log('対象の巨大条文:');
  Object.entries(byArticle).forEach(([k, n]) => console.log(`   ${k}  (${n}本)`));
  console.log(`埋め込み対象 通達: ${uniq.length}本 / バッチ${BATCH}`);
  if (DRY) { console.log('★ DRY-RUN（登録しません）'); return; }

  let ok = 0, ng = 0;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    try {
      const res = await fetch(`${WORKER}/api/admin/embed-tsutatsu`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ items: batch }),
      });
      const j = await res.json();
      if (res.ok && j.upserted) ok += j.upserted;
      else { ng += batch.length; console.log('\n  NG', res.status, JSON.stringify(j).slice(0, 160)); }
    } catch (e) { ng += batch.length; console.log('\n  ERR', e.message); }
    process.stdout.write(`\r  進捗: ${ok} 登録 / ${ng} 失敗  (${Math.min(i + BATCH, uniq.length)}/${uniq.length})`);
  }
  console.log(`\n完了: ${ok} 登録 / ${ng} 失敗`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
