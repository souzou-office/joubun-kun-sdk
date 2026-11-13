// 質疑応答事例の本文画像（図解・計算式GIF）を取得
//
//   node scripts/shitsugi/04_fetch_images.cjs
//
// 入力: scripts/shitsugi/state/shitsugi_items_YYYYMMDD.ndjson （images[].src）
// 出力: shitsugi_images_YYYYMMDD/<path>  （リポジトリ直下。R2アップロード時はこのツリーをそのまま使う）
//
// 取得済みはスキップ（レジューム可）。礼儀として 1req/秒。

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');

const HOST = 'www.nta.go.jp';
const BASE = `https://${HOST}`;
const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');
const SLEEP_MS = 1000;
const MAX_RETRIES = 4;
const USER_AGENT =
  `joubun-kun-shitsugi-crawler/1.0 (+https://joubun-kun.com; contact: ${SITE.crawlerContact})`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter((x) => /^shitsugi_items_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

async function fetchBytes(url) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      const wait = 1000 * Math.pow(2, attempt);
      console.log(`  retry ${attempt + 1}/${MAX_RETRIES} after ${wait}ms: ${url} ${e.message}`);
      await sleep(wait);
    }
  }
  throw new Error(`Failed: ${url}`);
}

async function main() {
  const stamp = latestStamp();
  if (!stamp) throw new Error('shitsugi_items が見つかりません（03_parse を先に）');
  const items = fs
    .readFileSync(path.join(STATE_DIR, `shitsugi_items_${stamp}.ndjson`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const outRoot = path.join(REPO_ROOT, `shitsugi_images_${stamp}`);
  const urls = new Set();
  for (const it of items) for (const im of it.images || []) {
    try {
      urls.add(new URL(im.src, it.url).toString());
    } catch { /* skip */ }
  }
  console.log(`画像 ${urls.size} 件（事例 ${items.length} 件中）`);

  let done = 0, skipped = 0, failed = 0;
  for (const url of urls) {
    const u = new URL(url);
    const local = path.join(outRoot, u.pathname.replace(/^\//, '').split('/').join(path.sep));
    if (fs.existsSync(local) && fs.statSync(local).size > 0) { skipped++; continue; }
    try {
      const bytes = await fetchBytes(url);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, bytes);
      done++;
    } catch (e) {
      failed++;
      console.log(`FAIL ${url}`);
    }
    if ((done + failed) % 50 === 0) console.log(`  ${done + skipped + failed}/${urls.size}`);
    await sleep(SLEEP_MS);
  }
  console.log(`完了: 取得 ${done} / 既存スキップ ${skipped} / 失敗 ${failed}`);
  console.log(`出力: ${outRoot}`);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
