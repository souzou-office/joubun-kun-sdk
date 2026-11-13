// 15: 大きい別表（>3万字）の「行」を、別表ごとの専用namespaceでTSUTATSU_VECに埋め込む。
//
// 用途（C: 巨大別表の行絞り込み）:
//   巨大別表（関税定率法48.9万字・登録免許税別表第一8.3万字 等）は丸ごとClaudeに送るとトークン爆発。
//   別表が選定されたら、その別表の行だけをベクトル検索して該当行n件だけ送るための行ベクトル。
//   law-embeddings-v2 の行ベクトル(15万本)は metadata index 不在で別表スコープに絞れない＆本番共有で触れない。
//   → 大別表だけ別namespaceに再埋め込み(Blue-Green)。namespace は別表ごとに分けてスコープを実現。
//
//   namespace = `bpr_{law_id}_b{canonNum}`  (ASCIIのみ・ハッシュ不要＝workerでも (law_id, article_title) から再現可)
//     例: 登録免許税法別表第一 → bpr_342AC0000000035_b1 、別表第二の二 → ..._b2_2
//
//   node scripts/rebuild/15_embed_beppyo_rows.cjs --only 342AC0000000035   # 1法令だけ（実証）
//   node scripts/rebuild/15_embed_beppyo_rows.cjs --dry                      # 対象数のみ
//   node scripts/rebuild/15_embed_beppyo_rows.cjs                            # 大別表すべて

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');
const BASE = `${SITE.localDataRoot}/rebuild_output/large_law_articles_v3`;
const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;   // 秘密はリポジトリに書かない（環境変数だけ）
if (!KEY && !process.argv.includes('--dry')) { console.error('BYPASS_KEY を環境変数で渡してください'); process.exit(1); }
const BATCH = 25;
// 行の作り方（MIN_CHARS 以上の別表・グループ化・id・namespace）は週次 scripts/beppyo/weekly と共用
const { isBigTable, buildRows, nsOf } = require('./lib/beppyo.cjs');

function* iterBig(onlyLawId) {
  for (const d of fs.readdirSync(BASE)) {
    if (onlyLawId && d !== onlyLawId) continue;
    const dir = path.join(BASE, d); let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files; try { files = fs.readdirSync(dir).filter((f) => /^別表.*\.json$/.test(f)); } catch { continue; }
    for (const f of files) {
      let data; try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      for (const art of (data.articles || [])) {
        if (!isBigTable(art)) continue;
        yield { lawId: data.law_id, lawTitle: data.law_title, art };
      }
    }
  }
}

(async () => {
  const dry = process.argv.includes('--dry');
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

  const all = [];
  let tables = 0;
  for (const { lawId, lawTitle, art } of iterBig(only)) {
    tables++;
    const rows = buildRows(lawId, art);
    all.push(...rows);
    if (dry) console.log(`  ${nsOf(lawId, art.title)}  ${lawTitle} ${art.title}  ${rows.length}行`);
  }
  console.log(`対象大別表: ${tables}  総行ベクトル: ${all.length}`);
  if (dry) { console.log('★ DRY-RUN'); return; }

  // 中断再開用: --skip N で先頭N件を飛ばす（item順は readdir 安定なので再現可。upsertは冪等）
  const skipIdx = process.argv.indexOf('--skip');
  const skip = skipIdx >= 0 ? parseInt(process.argv[skipIdx + 1], 10) || 0 : 0;

  let ok = 0, ng = 0;
  for (let i = skip; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    try {
      const res = await fetch(`${WORKER}/api/admin/embed-tsutatsu`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ items: batch }),
      });
      const j = await res.json();
      if (res.ok && j.upserted) ok += j.upserted; else { ng += batch.length; if (ng <= 60) console.log('\n NG', res.status, JSON.stringify(j).slice(0, 140)); }
    } catch (e) { ng += batch.length; if (ng <= 60) console.log('\n ERR', e.message); }
    process.stdout.write(`\r  ${Math.min(i + BATCH, all.length)}/${all.length}  登録${ok} 失敗${ng}`);
  }
  console.log(`\n完了: ${ok}登録 / ${ng}失敗`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
