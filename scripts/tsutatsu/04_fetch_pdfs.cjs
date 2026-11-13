// 通達の「内容PDF」をダウンロード（個別通達の発遣文書本文・別表など）。
// 改正(新旧対照表 kaisei) と 様式(/taxes/ の申請書) は除外。
// 表示は原本PDFリンクで行う方針なので、ここでのDLは「裏方の引用抽出＋差分」用。
//
// 使い方:
//   node scripts/tsutatsu/04_fetch_pdfs.cjs --list   # DL対象の件数・内訳だけ表示（取得しない）
//   node scripts/tsutatsu/04_fetch_pdfs.cjs --max 3  # 先頭3件だけ（検証）
//   node scripts/tsutatsu/04_fetch_pdfs.cjs          # 全件
//
// 入力:  scripts/tsutatsu/state/manifest_YYYYMMDD.ndjson の pdf_links
// 出力:
//   all_tsutatsu_YYYYMMDD/<path>.pdf                       生PDF（バイナリ）
//   scripts/tsutatsu/state/pdf_manifest_YYYYMMDD.ndjson    ページ単位記録（追記/レジューム）
//   scripts/tsutatsu/state/pdf_ledger.json                 差分台帳 (url -> hash/last_modified/etag/local_path)
//
// 304（未変更）の PDF は前回スナップショットの写しを今回のスナップショットにコピーする（2026-09-24。
//   以前は保存せず、台帳があると 05 が今回のスナップショットで PDF を見つけられなかった）。
//   写しが無いか台帳の content_hash と合わないときは、条件なしで取り直す。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');
// TSU_CRAWL_BASE / TSU_CRAWL_SLEEP_MS は手元の確かめ用（check_crawl_304.cjs）。本番では付けない
const BASE = (process.env.TSU_CRAWL_BASE || 'https://www.nta.go.jp').replace(/\/$/, '');
const SCOPE = '/law/tsutatsu/';
const SLEEP_MS = Number(process.env.TSU_CRAWL_SLEEP_MS || 1000);
const MAX_RETRIES = 5;
const RETRY_BASE_MS = Number(process.env.TSU_CRAWL_RETRY_BASE_MS || 1000);   // 取り直しの待ちの基準（確かめ用のみ短くする）
const UA = `joubun-kun-tsutatsu-crawler/1.0 (+https://joubun-kun.pages.dev; contact: ${SITE.crawlerContact})`;

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { snapshot: null, max: Infinity, list: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--snapshot') o.snapshot = a[++i];
    else if (a[i] === '--max') o.max = parseInt(a[++i], 10);
    else if (a[i] === '--list') o.list = true;
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function latestSnapshot() {
  const d = fs.readdirSync(REPO_ROOT).filter((x) => /^all_tsutatsu_\d{8}$/.test(x)).sort();
  return d.length ? d[d.length - 1].replace('all_tsutatsu_', '') : null;
}

// 内容PDF判定: /law/tsutatsu/ 配下の .pdf で、改正(kaisei)でないもの。様式は /taxes/ 配下なので除外される。
function isContentPdf(u) {
  if (!u.includes(SCOPE)) return false;
  if (/kaisei/i.test(u)) return false;
  if (/\/taxes\//.test(u)) return false;
  return /\.pdf(?:$|\?)/i.test(u);
}

function localPathForUrl(u, snapDir) {
  const url = new URL(u, BASE);
  const rel = url.pathname.replace(SCOPE, '');
  return path.join(snapDir, rel.split('/').join(path.sep));
}

// 304 のときに引き継ぐ前回の写し（台帳の local_path → 今回より前のスナップショットの同じパス。hash が合うものだけ）
function findPrevCopy(u, prev, stamp) {
  const cands = [];
  if (prev && prev.local_path) cands.push(path.join(REPO_ROOT, prev.local_path.split('/').join(path.sep)));
  const dirs = fs.readdirSync(REPO_ROOT)
    .filter((d) => /^all_tsutatsu_\d{8}$/.test(d) && d < `all_tsutatsu_${stamp}`).sort().reverse();
  for (const d of dirs) cands.push(localPathForUrl(u, path.join(REPO_ROOT, d)));
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    if (prev && prev.content_hash && crypto.createHash('sha256').update(buf).digest('hex') === prev.content_hash) return { path: p, buf };
  }
  return null;
}

async function fetchBin(url, cond) {
  const headers = { 'User-Agent': UA };
  if (cond) {
    if (cond.etag) headers['If-None-Match'] = cond.etag;
    if (cond.last_modified) headers['If-Modified-Since'] = cond.last_modified;
  }
  for (let a = 0; a < MAX_RETRIES; a++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 304) return { status: 304 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        buf,
        last_modified: res.headers.get('last-modified'),
        etag: res.headers.get('etag'),
      };
    } catch (e) {
      const w = RETRY_BASE_MS * Math.pow(2, a);
      console.log(`  retry ${a + 1}/${MAX_RETRIES} ${w}ms: ${e.message}`);
      await sleep(w);
    }
  }
  throw new Error(`Failed: ${url}`);
}

async function main() {
  const o = parseArgs();
  const stamp = o.snapshot || latestSnapshot();
  const snapDir = path.join(REPO_ROOT, `all_tsutatsu_${stamp}`);
  const manFile = path.join(STATE_DIR, `manifest_${stamp}.ndjson`);
  const pdfManFile = path.join(STATE_DIR, `pdf_manifest_${stamp}.ndjson`);
  const ledgerFile = path.join(STATE_DIR, 'pdf_ledger.json');

  // manifest の pdf_links から内容PDF URLを収集
  const urls = new Set();
  for (const line of fs.readFileSync(manFile, 'utf8').split('\n').filter(Boolean)) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    for (const p of r.pdf_links || []) if (isContentPdf(p)) urls.add(p.split('#')[0]);
  }
  const list = [...urls].sort();
  console.log(`内容PDF対象: ${list.length} 件`);

  if (o.list) {
    const g = {};
    for (const u of list) {
      const m = u.match(/\/law\/tsutatsu\/(?:kihon|kobetsu)\/([^/]+)/);
      const k = m ? m[1] : '(other)';
      g[k] = (g[k] || 0) + 1;
    }
    console.log('内訳(グループ別):', JSON.stringify(g));
    return;
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const prev = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
  const visited = new Set();
  const newLedger = {};
  if (fs.existsSync(pdfManFile)) {
    for (const line of fs.readFileSync(pdfManFile, 'utf8').split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        visited.add(r.url);
        if (r.content_hash) newLedger[r.url] = { content_hash: r.content_hash, last_modified: r.last_modified, etag: r.etag, fetched_at: r.fetched_at, local_path: r.local_path || null };
      } catch {}
    }
    console.log(`レジューム: ${visited.size} 件取得済み（スキップ）`);
  }

  const out = fs.createWriteStream(pdfManFile, { flags: 'a' });
  let done = 0, e304 = 0, errs = 0, re304 = 0;
  for (const url of list) {
    if (visited.has(url)) continue;
    if (done >= o.max) break;

    let res;
    try {
      res = await fetchBin(url, prev[url]);
    } catch (e) {
      errs++;
      out.write(JSON.stringify({ url, error: e.message, fetched_at: new Date().toISOString() }) + '\n');
      await sleep(SLEEP_MS);
      continue;
    }

    let hash, lm = null, et = null, saved = null, bytes = null;
    let buf = null, copyFrom = null;
    if (res.status === 304) {
      const p = prev[url] || {};
      const copy = findPrevCopy(url, p, stamp);
      if (copy) {
        e304++;
        buf = copy.buf; copyFrom = copy.path;
        hash = p.content_hash; lm = p.last_modified; et = p.etag;
      } else {
        // 写しが無い／台帳と合わない → 条件なしで取り直す
        re304++;
        await sleep(SLEEP_MS);
        try {
          res = await fetchBin(url, null);
        } catch (e) {
          errs++;
          out.write(JSON.stringify({ url, error: e.message, fetched_at: new Date().toISOString() }) + '\n');
          await sleep(SLEEP_MS);
          continue;
        }
      }
    }
    if (buf === null) {
      buf = res.buf;
      hash = crypto.createHash('sha256').update(buf).digest('hex');
      lm = res.last_modified; et = res.etag;
    }
    bytes = buf.length;
    const local = localPathForUrl(url, snapDir);
    if (copyFrom !== local) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, buf); // バイナリ保存（テキストデコードしない）
    }
    saved = path.relative(REPO_ROOT, local).split(path.sep).join('/');

    done++;
    out.write(JSON.stringify({ url, local_path: saved, http_status: res.status, content_hash: hash || null, last_modified: lm || null, etag: et || null, bytes, fetched_at: new Date().toISOString() }) + '\n');
    newLedger[url] = { content_hash: hash || null, last_modified: lm || null, etag: et || null, fetched_at: new Date().toISOString(), local_path: saved };
    if (done % 50 === 0) console.log(`  ${done}/${list.length} (304:${e304}, err:${errs})`);
    await sleep(SLEEP_MS);
  }
  out.end();

  const partial = o.max !== Infinity;
  const merged = partial ? Object.assign({}, prev, newLedger) : newLedger;
  if (fs.existsSync(ledgerFile)) fs.copyFileSync(ledgerFile, ledgerFile + '.bak');
  fs.writeFileSync(ledgerFile, JSON.stringify(merged, null, 2), 'utf8');

  console.log(`完了: ${done} DL / 304:${e304} / err:${errs}`);
  if (re304) console.log(`  304 だが前回の写しが無い／台帳と合わず取り直した: ${re304} 件`);
  console.log(`PDFマニフェスト: ${pdfManFile}`);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
