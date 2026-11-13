// R2 バケット内の全キーをリストして出力するスクリプト
// 出力: scripts/update/state/r2_keys.json (key, size, last_modified の配列)
//
// 使用方法: node scripts/update/list_r2_keys.cjs

const fs = require('fs');
const path = require('path');

const ACCT = process.env.R2_ACCOUNT_ID;
const TOKEN = process.env.R2_API_TOKEN;
if (!ACCT || !TOKEN) {
  console.error('ERROR: 環境変数 R2_ACCOUNT_ID と R2_API_TOKEN を設定してください（旧ハードコードは廃止）');
  process.exit(1);
}
const BUCKET = 'joubun-kun-data';
const OUT_FILE = path.join(__dirname, 'state', 'r2_keys.json');
const PER_PAGE = 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function listOnce(cursor) {
  const params = new URLSearchParams({ per_page: String(PER_PAGE) });
  if (cursor) params.set('cursor', cursor);
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/${BUCKET}/objects?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const all = [];
  let cursor = null;
  let page = 0;
  while (true) {
    page++;
    process.stdout.write(`page ${page} (cursor=${cursor ? cursor.slice(0, 16) + '...' : 'null'})... `);
    const data = await listOnce(cursor);
    if (!data.success) throw new Error(JSON.stringify(data.errors));

    const items = data.result || [];
    console.log(`got ${items.length}`);
    for (const item of items) {
      all.push({ key: item.key, size: item.size, last_modified: item.last_modified });
    }

    // ページネーションのカーソル
    const nextCursor = data.result_info?.cursor || null;
    if (!nextCursor || items.length < PER_PAGE) break;
    cursor = nextCursor;
    await sleep(100);
  }

  // 集計
  const prefixSummary = {};
  let totalSize = 0;
  for (const it of all) {
    const prefix = it.key.split('/')[0];
    prefixSummary[prefix] = prefixSummary[prefix] || { count: 0, size: 0 };
    prefixSummary[prefix].count++;
    prefixSummary[prefix].size += it.size;
    totalSize += it.size;
  }

  console.log('\n=== サマリ ===');
  console.log(`総オブジェクト数: ${all.length}`);
  console.log(`総容量: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
  console.log('プレフィックス別:');
  for (const [prefix, s] of Object.entries(prefixSummary).sort((a, b) => b[1].size - a[1].size)) {
    console.log(`  ${prefix.padEnd(30)}: ${String(s.count).padStart(6)} files, ${(s.size / 1024 / 1024).toFixed(1)} MB`);
  }

  if (!fs.existsSync(path.dirname(OUT_FILE))) fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    listed_at: new Date().toISOString(),
    total: all.length,
    total_size: totalSize,
    by_prefix: prefixSummary,
    keys: all,
  }, null, 2), 'utf8');
  console.log(`\n出力: ${OUT_FILE}`);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
