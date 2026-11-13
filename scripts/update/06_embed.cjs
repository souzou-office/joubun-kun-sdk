// Phase 2: 作り直す項のベクトルを Workers AI（bge-m3）で作る。
//
//   node scripts/update/06_embed.cjs [--resume]
//
// 入力: state/embed_inputs.jsonl（05 の出力）
// 出力: state/vectors.ndjson  各行 { id, values, metadata }（Vectorize upsert 形式）
// 費用の目安: bge-m3 は 100 万トークンあたり約 $0.01。週の変更 1 万項 × 300 トークンで 3 円程度
const fs = require('fs');
const readline = require('readline');
const { statePath, writeJson, log } = require('./lib/common.cjs');
const { Embedder } = require('./lib/ai.cjs');

async function main() {
  const resume = process.argv.includes('--resume');
  const inFile = statePath('embed_inputs.jsonl'), outFile = statePath('vectors.ndjson');
  if (!fs.existsSync(inFile)) { log('embed_inputs.jsonl がありません（05_diff を先に）'); process.exit(1); }
  const done = new Set();
  if (resume && fs.existsSync(outFile)) {
    for await (const line of readline.createInterface({ input: fs.createReadStream(outFile) })) { if (line.trim()) try { done.add(JSON.parse(line).id); } catch { /* skip */ } }
    log(`resume: ${done.size} 件済み`);
  }
  const recs = [];
  for await (const line of readline.createInterface({ input: fs.createReadStream(inFile) })) { if (!line.trim()) continue; const r = JSON.parse(line); if (!done.has(r.id)) recs.push(r); }
  log(`埋め込み: ${recs.length} 項`);
  const emb = new Embedder();
  const out = fs.createWriteStream(outFile, { flags: resume ? 'a' : 'w' });
  const CHUNK = 500;
  let chars = 0;
  for (let i = 0; i < recs.length; i += CHUNK) {
    const batch = recs.slice(i, i + CHUNK);
    const vecs = await emb.embed(batch.map((r) => r.text));
    batch.forEach((r, j) => { chars += r.text.length; out.write(JSON.stringify({ id: r.id, values: vecs[j], metadata: r.metadata }) + '\n'); });
    log(`  ${Math.min(i + CHUNK, recs.length)}/${recs.length}`);
  }
  await new Promise((r) => out.end(r));
  writeJson(statePath('embed_log.json'), { embedded_at: new Date().toISOString(), count: recs.length, chars, api_calls: emb.calls, fake: emb.fake }, true);
  log(`完了: ${recs.length} 件 → ${outFile}`);
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
