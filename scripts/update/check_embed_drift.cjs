// 埋め込みのずれ検査: 今の Workers AI（bge-m3）の出力が、Vectorize に入っているベクトルと同じ空間か。
//
//   node scripts/update/check_embed_drift.cjs [--law 325AC1000000197] [--n 20] [--gate]
//
// 背景: 索引（law-embeddings-v2）は 2026-05 にローカルの bge-m3（CLS pooling）で作った。2026-09-02 には Workers AI の出力と
// cosine 1.0000 で一致していたが、09-13 には 0.91〜0.92 に落ちていた（docs/benchmarks/tax_ab/EMBED_SELFMATCH_20260913.md）。
// ずれた埋め込みで新しい項のベクトルを作ると、索引の中で新旧のベクトルが別の空間になる。
//
// やること: 指定した法令の項（R2 の本文から ID と本文を作る）を n 本取り、Vectorize から今の values を取り、
// 同じ本文を Workers AI で 既定 / pooling=cls / pooling=mean の 3 通りで埋め込んで cosine を出す。
// 出力: state/embed_drift.json { ok, pooling（一致した設定）, stats }。--gate のときは、AI_POOLING の設定で自己一致の最小値が
// 閾値（既定 0.98）未満なら終了コード 3（05_diff が blockers に入れる）。AI_FAKE=1 のときは検査を飛ばす（ok=true, skipped）。
const { CONFIG, statePath, writeJson, log } = require('./lib/common.cjs');
const { R2 } = require('./lib/r2.cjs');
const { Vectorize } = require('./lib/vectorize.cjs');
const { Embedder, cosine } = require('./lib/ai.cjs');
const { paragraphRecords } = require('./lib/vectors.cjs');

const THRESHOLD = Number(process.env.EMBED_DRIFT_THRESHOLD || 0.98);

async function main() {
  const args = process.argv.slice(2);
  const lawId = args.includes('--law') ? args[args.indexOf('--law') + 1] : (process.env.EMBED_CHECK_LAW || '325AC1000000197');
  const n = args.includes('--n') ? Number(args[args.indexOf('--n') + 1]) : 20;
  const gate = args.includes('--gate');
  if (process.env.AI_FAKE === '1') {
    writeJson(statePath('embed_drift.json'), { checked_at: new Date().toISOString(), ok: true, skipped: 'AI_FAKE' }, true);
    log('embed drift: AI_FAKE のため検査を飛ばす');
    return;
  }
  const r2 = new R2();
  const prefix = CONFIG.oldArticlesPrefix;
  const list = await r2.list(`${prefix}/${lawId}/`);
  const files = {};
  for (const o of list) {
    const name = o.key.slice(`${prefix}/${lawId}/`.length);
    if (!name || name === '_index.json' || name.includes('/')) continue;
    const j = await r2.getJson(o.key);
    if (j) files[name] = j;
    if (Object.keys(files).length >= 40) break;
  }
  // 短い項と長い項の両方を見る（Workers AI が長い入力を黙って切っていれば、長い項だけ索引と合わなくなる）
  const all = paragraphRecords(lawId, files).filter((r) => r.text.length >= 40);
  const short = all.filter((r) => r.text.length <= 1500).slice(0, Math.ceil(n / 2));
  const long = [...all].sort((a, b) => b.text.length - a.text.length).filter((r) => !short.includes(r)).slice(0, Math.floor(n / 2));
  const recs = [...short, ...long];
  if (!recs.length) throw new Error(`本文が取れない: ${prefix}/${lawId}/`);
  const vz = new Vectorize();
  const stored = new Map((await vz.getByIds(recs.map((r) => r.id))).filter((v) => Array.isArray(v.values)).map((v) => [v.id, v.values]));
  const pairs = recs.filter((r) => stored.has(r.id));
  if (pairs.length < Math.min(5, recs.length)) throw new Error(`Vectorize に入っている ID が少ない（${pairs.length}/${recs.length}）。法令を変えて試す: --law`);
  const lens = pairs.map((r) => r.text.length).sort((a, b) => a - b);
  log(`埋め込みのずれ検査: ${lawId} ${pairs.length} 項（索引 ${vz.index}、本文の長さ ${lens[0]}〜${lens[lens.length - 1]} 文字）`);

  const variants = [['default', null], ['cls', 'cls'], ['mean', 'mean']];
  const stats = {};
  for (const [name, pooling] of variants) {
    try {
      const emb = new Embedder({ pooling });
      const vecs = await emb.embed(pairs.map((r) => r.text));
      const cos = vecs.map((v, i) => cosine(v, stored.get(pairs[i].id)));
      const sorted = [...cos].sort((a, b) => a - b);
      const longCos = cos.filter((_, i) => pairs[i].text.length > 1500);
      stats[name] = { min: +sorted[0].toFixed(4), median: +sorted[Math.floor(sorted.length / 2)].toFixed(4), max: +sorted[sorted.length - 1].toFixed(4), n: cos.length,
        long_min: longCos.length ? +Math.min(...longCos).toFixed(4) : null, long_n: longCos.length,
        worst: cos.map((c, i) => ({ c: +c.toFixed(4), len: pairs[i].text.length, id: pairs[i].id })).sort((a, b) => a.c - b.c).slice(0, 3) };
      log(`  pooling=${name}: min ${stats[name].min} median ${stats[name].median} max ${stats[name].max}（1500 文字超 ${longCos.length} 本の最小 ${stats[name].long_min}）`);
    } catch (e) {
      stats[name] = { error: e.message.slice(0, 200) };
      log(`  pooling=${name}: エラー ${e.message.slice(0, 120)}`);
    }
  }
  const configured = process.env.AI_POOLING || 'default';
  const matching = variants.map(([name]) => name).filter((name) => stats[name] && stats[name].min >= THRESHOLD);
  const ok = !!(stats[configured] && stats[configured].min >= THRESHOLD);
  const out = { checked_at: new Date().toISOString(), law_id: lawId, index: vz.index, n: pairs.length, threshold: THRESHOLD, configured_pooling: configured, ok, matching_poolings: matching, stats };
  writeJson(statePath('embed_drift.json'), out, true);
  if (ok) log(`OK: 今の設定（pooling=${configured}）で索引と一致（最小 ${stats[configured].min}）`);
  else if (matching.length) log(`NG: 今の設定（pooling=${configured}）は索引とずれている。一致する設定: ${matching.join(', ')} → AI_POOLING と Worker の AI_POOLING をそれに合わせる`);
  else log(`NG: どの pooling でも索引と一致しない（最小 ${Object.values(stats).map((s) => s.min).filter((x) => x != null).join(' / ')}）。索引を作り直すか、埋め込みをローカルに戻す判断が要る`);
  if (gate && !ok) process.exit(3);
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
