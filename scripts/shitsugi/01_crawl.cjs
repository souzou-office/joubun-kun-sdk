// 国税庁 質疑応答事例クローラ（tsutatsu/01_crawl.cjs と同方式: 日付スナップショット + 差分対応）
//
// 使い方:
//   node scripts/shitsugi/01_crawl.cjs                  # 全事例をクロール
//   node scripts/shitsugi/01_crawl.cjs --only hojin     # 特定税目配下だけ（検証用）
//   node scripts/shitsugi/01_crawl.cjs --max 40         # 最大40ページで打ち切り（検証用）
//
// 出力:
//   all_shitsugi_YYYYMMDD/<path>                       生HTMLスナップショット（リポジトリ直下）
//   scripts/shitsugi/state/manifest_YYYYMMDD.ndjson    ページ単位の記録（追記=クラッシュ耐性/レジューム）
//   scripts/shitsugi/state/crawl_ledger.json           url -> {content_hash,...} 台帳（差分用）
//
// 質疑応答事例は /law/shitsugi/ 配下＋酒税のみ /taxes/sake/qa/ の2系統。
// 画像(計算式・図解GIF)は本文中の img src をマニフェストに記録し、04_fetch_images.cjs で取得する。
// データ取得方針: 利用規約（公共データ利用規約1.0）で複製可（商用含む）。礼儀として 1req/秒・UA明示・逐次取得。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');

// SHITSUGI_CRAWL_BASE は手元の確かめ用（偽のサイトを立てる）。本番では付けない
const BASE = (process.env.SHITSUGI_CRAWL_BASE || 'https://www.nta.go.jp').replace(/\/$/, '');
const HOST = new URL(BASE).host;
const SCOPE_PREFIXES = ['/law/shitsugi/', '/taxes/sake/qa/'];

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');

const SLEEP_MS = Number(process.env.SHITSUGI_CRAWL_SLEEP_MS || 1000);   // 礼儀正しく 1req/秒（確かめ用のみ短くする）
const MAX_RETRIES = 5;
const USER_AGENT =
  `joubun-kun-shitsugi-crawler/1.0 (+https://joubun-kun.com; contact: ${SITE.crawlerContact})`;

// 種URL（トップ＋税目10カテゴリ）
const SEEDS = [
  '/law/shitsugi/01.htm',
  '/law/shitsugi/shotoku/01.htm', // 所得税
  '/law/shitsugi/gensen/01.htm',  // 源泉徴収
  '/law/shitsugi/juto/01.htm',    // 譲渡所得
  '/law/shitsugi/sozoku/01.htm',  // 相続・贈与
  '/law/shitsugi/hyoka/01.htm',   // 資産の評価
  '/law/shitsugi/hojin/01.htm',   // 法人税
  '/law/shitsugi/shohi/01.htm',   // 消費税
  '/law/shitsugi/inshi/01.htm',   // 印紙税
  '/taxes/sake/qa/01.htm',        // 酒税関係
  '/law/shitsugi/hotei/01.htm',   // 法定調書
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { only: null, max: Infinity, snapshot: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only') opts.only = args[++i];
    else if (args[i] === '--max') opts.max = parseInt(args[++i], 10);
    else if (args[i] === '--snapshot') opts.snapshot = args[++i];
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function inScope(u, onlyFilter) {
  try {
    const url = new URL(u, BASE);
    if (url.host !== HOST) return false;
    if (!SCOPE_PREFIXES.some((p) => url.pathname.startsWith(p))) return false;
    if (!/\.html?$/i.test(url.pathname)) return false;
    if (onlyFilter && !url.pathname.includes(`/${onlyFilter}/`)) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeForHash(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function detectCharset(bytes, contentType) {
  if (contentType) {
    const m = contentType.match(/charset=([\w-]+)/i);
    if (m) return m[1];
  }
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  let m = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (m) return m[1];
  m = head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i);
  if (m) return m[1];
  return 'shift_jis';
}

function decodeBytes(bytes, charset) {
  let cs = (charset || 'shift_jis').toLowerCase();
  if (['shift-jis', 'sjis', 'x-sjis', 'windows-31j', 'ms932', 'cp932'].includes(cs)) cs = 'shift_jis';
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function extractHrefs(html, baseUrl, pattern) {
  const out = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (pattern && !pattern.test(m[1])) continue;
    try {
      out.add(new URL(m[1], baseUrl).toString().split('#')[0]);
    } catch {
      /* skip malformed */
    }
  }
  return [...out];
}

// 本文中の画像（計算式・図解）。ヘッダロゴ等のサイト共通画像は /common/ 配下なので除外。
function extractImgs(html, baseUrl) {
  const out = new Set();
  const re = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (/\/common\/|\/images\/nav|spacer|icon_/i.test(src)) continue;
    if (!/\.(gif|png|jpe?g)$/i.test(src)) continue;
    try {
      const u = new URL(src, baseUrl);
      if (u.host !== HOST) continue;
      if (!SCOPE_PREFIXES.some((p) => u.pathname.startsWith(p))) continue;
      out.add(u.toString());
    } catch {
      /* skip malformed */
    }
  }
  return [...out];
}

function localPathForUrl(url, snapshotDir) {
  const u = new URL(url, BASE);
  const rel = u.pathname.replace(/^\//, ''); // law/shitsugi/hojin/01/02.htm, taxes/sake/qa/01.htm
  return path.join(snapshotDir, rel.split('/').join(path.sep));
}

// 304 のときに引き継ぐ前回の写し（tsutatsu/01_crawl.cjs と同じ。2026-09-26）。台帳の local_path → 今回より前のスナップショット（新しい順）の同じパス。
//   台帳の content_hash と合わない写しは使わない。合う写しが無ければ条件なしで取り直す（304 のまま進むと下を辿れず、写しも欠ける）
function prevSnapshotDirs(stamp) {
  return fs.readdirSync(REPO_ROOT)
    .filter((d) => /^all_shitsugi_\d{8}$/.test(d) && d < `all_shitsugi_${stamp}`)
    .sort().reverse().map((d) => path.join(REPO_ROOT, d));
}
function findPrevCopy(url, prev, prevDirs) {
  const cands = [];
  if (prev && prev.local_path) cands.push(path.join(REPO_ROOT, prev.local_path.split('/').join(path.sep)));
  for (const d of prevDirs) cands.push(localPathForUrl(url, d));
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, 'utf8'); // スナップショットは UTF-8 で保存している
    if (prev && prev.content_hash && sha256(normalizeForHash(html)) === prev.content_hash) return { path: p, html };
  }
  return null;
}

async function fetchPage(url, conditional) {
  const headers = { 'User-Agent': USER_AGENT };
  if (conditional) {
    if (conditional.etag) headers['If-None-Match'] = conditional.etag;
    if (conditional.last_modified) headers['If-Modified-Since'] = conditional.last_modified;
  }
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 304) return { status: 304 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      return {
        status: res.status,
        bytes: new Uint8Array(ab),
        content_type: res.headers.get('content-type'),
        last_modified: res.headers.get('last-modified'),
        etag: res.headers.get('etag'),
      };
    } catch (e) {
      const wait = Number(process.env.SHITSUGI_CRAWL_RETRY_BASE_MS || 1000) * Math.pow(2, attempt);
      console.log(`  retry ${attempt + 1}/${MAX_RETRIES} after ${wait}ms: ${e.message}`);
      await sleep(wait);
    }
  }
  throw new Error(`Failed after ${MAX_RETRIES} retries: ${url}`);
}

async function main() {
  const opts = parseArgs();
  const stamp = opts.snapshot || todayStamp();
  const snapshotDir = path.join(REPO_ROOT, `all_shitsugi_${stamp}`);
  const manifestFile = path.join(STATE_DIR, `manifest_${stamp}.ndjson`);
  const ledgerFile = path.join(STATE_DIR, 'crawl_ledger.json');

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: true });

  const prevLedger = fs.existsSync(ledgerFile)
    ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    : {};
  const prevDirs = prevSnapshotDirs(stamp);

  const visited = new Set();
  const newLedger = {};
  const resumeLinks = new Set();
  if (fs.existsSync(manifestFile)) {
    for (const line of fs.readFileSync(manifestFile, 'utf8').split('\n').filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        visited.add(rec.url);
        if (rec.content_hash) {
          newLedger[rec.url] = {
            content_hash: rec.content_hash,
            last_modified: rec.last_modified,
            etag: rec.etag,
            fetched_at: rec.fetched_at,
            title: rec.title,
            local_path: rec.local_path || null,
          };
        }
        if (rec.local_path) {
          const abs = path.join(REPO_ROOT, rec.local_path.split('/').join(path.sep));
          if (fs.existsSync(abs)) {
            const saved = fs.readFileSync(abs, 'utf8');
            for (const link of extractHrefs(saved, rec.url)) {
              if (inScope(link, opts.only)) resumeLinks.add(link);
            }
          }
        }
      } catch {
        /* skip bad line */
      }
    }
    console.log(`レジューム: ${visited.size} ページ取得済み、フロンティア復元 ${resumeLinks.size}`);
  }

  const manifestStream = fs.createWriteStream(manifestFile, { flags: 'a' });

  const seedList = opts.only ? SEEDS.filter((s) => s.includes(`/${opts.only}/`)) : SEEDS;
  const queue = [];
  const queued = new Set();
  for (const u of [...seedList.map((s) => new URL(s, BASE).toString()), ...resumeLinks]) {
    if (!visited.has(u) && !queued.has(u)) {
      queue.push(u);
      queued.add(u);
    }
  }

  let fetched = 0;
  let skipped304 = 0;
  let refetched304 = 0; // 304 だが前回の写しが無い／合わないので取り直した
  let changed = 0;
  let added = 0;

  while (queue.length > 0 && fetched < opts.max) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const cond = prevLedger[url];
    const fail = (e) => {
      console.log(`FAIL ${url}: ${e.message}`);
      manifestStream.write(
        JSON.stringify({ url, error: e.message, fetched_at: new Date().toISOString() }) + '\n'
      );
    };
    let res;
    try {
      res = await fetchPage(url, cond);
    } catch (e) {
      fail(e);
      await sleep(SLEEP_MS);
      continue;
    }

    let hash;
    let lastMod = null;
    let etag = null;
    let title = null;
    let imgLinks = [];
    let savedPath = null;
    let sourceCharset = null;
    let html = null;
    let copyFrom = null;

    if (res.status === 304) {
      // 未変更：前回の写しを引き継ぎ、そこからリンクを辿る（再DLしない）
      const prev = prevLedger[url] || {};
      const copy = findPrevCopy(url, prev, prevDirs);
      if (copy) {
        skipped304++;
        html = copy.html;
        copyFrom = copy.path;
        hash = prev.content_hash;
        lastMod = prev.last_modified;
        etag = prev.etag;
        title = prev.title || extractTitle(html);
      } else {
        refetched304++;
        await sleep(SLEEP_MS);
        try {
          res = await fetchPage(url, null);
        } catch (e) {
          fail(e);
          await sleep(SLEEP_MS);
          continue;
        }
      }
    }

    if (html === null) {
      sourceCharset = detectCharset(res.bytes, res.content_type);
      html = decodeBytes(res.bytes, sourceCharset);
      hash = sha256(normalizeForHash(html));
      lastMod = res.last_modified;
      etag = res.etag;
      title = extractTitle(html);

      const prev = prevLedger[url];
      if (!prev) added++;
      else if (prev.content_hash !== hash) changed++;
    }

    // 生HTML保存（304 は前回の写しをそのまま今回のスナップショットへ）
    const local = localPathForUrl(url, snapshotDir);
    if (copyFrom !== local) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, html, 'utf8');
    }
    savedPath = path.relative(REPO_ROOT, local).split(path.sep).join('/');

    // リンク発掘（304 でも辿る）
    imgLinks = extractImgs(html, url);
    for (const link of extractHrefs(html, url)) {
      if (inScope(link, opts.only) && !visited.has(link) && !queued.has(link)) {
        queue.push(link);
        queued.add(link);
      }
    }

    fetched++;
    manifestStream.write(
      JSON.stringify({
        url,
        local_path: savedPath,
        http_status: res.status,
        content_hash: hash || null,
        last_modified: lastMod || null,
        etag: etag || null,
        title: title || null,
        source_charset: sourceCharset,
        img_links: imgLinks,
        fetched_at: new Date().toISOString(),
      }) + '\n'
    );
    newLedger[url] = {
      content_hash: hash || null,
      last_modified: lastMod || null,
      etag: etag || null,
      fetched_at: new Date().toISOString(),
      title: title || null,
      local_path: savedPath,
    };

    if (fetched % 25 === 0) {
      console.log(
        `  ${fetched} 取得 (queue ${queue.length}, 304:${skipped304}, 新規 ${added}, 変更 ${changed})`
      );
    }
    await sleep(SLEEP_MS);
  }

  manifestStream.end();

  const partial = opts.only || opts.max !== Infinity;
  const mergedLedger = partial ? { ...prevLedger, ...newLedger } : newLedger;
  if (fs.existsSync(ledgerFile)) fs.copyFileSync(ledgerFile, ledgerFile + '.bak');
  fs.writeFileSync(ledgerFile, JSON.stringify(mergedLedger, null, 2), 'utf8');

  console.log('');
  console.log(`完了: ${fetched} ページ取得 / 304スキップ ${skipped304} / 新規 ${added} / 変更 ${changed}`);
  if (refetched304) console.log(`  304 だが前回の写しが無い／台帳と合わず取り直した: ${refetched304} 件`);
  console.log(`スナップショット: ${snapshotDir}`);
  console.log(`マニフェスト: ${manifestFile}`);
  console.log(`台帳: ${ledgerFile}`);
  if (fetched >= opts.max) console.log(`※ --max ${opts.max} で打ち切り（フロンティア残 ${queue.length}）`);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
