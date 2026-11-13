// 国税庁 法令解釈通達クローラ（日付スナップショット + 差分対応）
//
// 使い方:
//   node scripts/tsutatsu/01_crawl.cjs                  # 全通達をクロール（本番）
//   node scripts/tsutatsu/01_crawl.cjs --only hojin     # /law/tsutatsu/.../hojin/ 配下だけ（検証用）
//   node scripts/tsutatsu/01_crawl.cjs --max 40         # 最大40ページで打ち切り（検証用）
//
// 出力:
//   all_tsutatsu_YYYYMMDD/<path>                       生HTMLスナップショット（リポジトリ直下）
//   scripts/tsutatsu/state/manifest_YYYYMMDD.ndjson    ページ単位の記録（追記=クラッシュ耐性/レジューム）
//   scripts/tsutatsu/state/crawl_ledger.json           url -> {content_hash,last_modified,etag,...} 台帳（差分用）
//
// 差分・更新:
//   - ページ本文を正規化して SHA-256（content_hash）を取る。ナビ揺れの誤検知を抑える。
//   - 再クロール時は前回台帳の ETag / Last-Modified で If-None-Match / If-Modified-Since を送り、
//     304（未変更）はダウンロードをスキップ＝礼儀正しく省コスト。
//   - 304 のページは前回スナップショットの写しを今回のスナップショットにコピーし、そこからリンクと PDF を辿る
//     （2026-09-24。以前は 304 のページの下を辿らず、台帳があると全件取り直しができなかった）。
//     写しが無いか台帳の content_hash と合わないときは、条件なしで取り直す。
//   - 台帳の content_hash 比較で added / modified / removed を 02_detect_changes.cjs が出す。
//     （法令パイプラインの sync_state 方式と同じ思想。revision_id の代わりが content_hash）
//
// データ取得方針: robots.txt で /law/tsutatsu/ は許可。利用規約（公共データ利用規約1.0）で複製可（商用含む）。
//   礼儀として 1req/秒・UA明示・逐次取得・PDFは辿らずリンクのみ記録。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');

// TSU_CRAWL_BASE は手元の確かめ用（check_crawl_304.cjs が偽の国税庁を立てる）。本番では付けない
const BASE = (process.env.TSU_CRAWL_BASE || 'https://www.nta.go.jp').replace(/\/$/, '');
const HOST = new URL(BASE).host;
const SCOPE_PREFIX = '/law/tsutatsu/';

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');

const SLEEP_MS = Number(process.env.TSU_CRAWL_SLEEP_MS || 1000);       // 礼儀正しく 1req/秒（確かめ用のみ短くする）
const MAX_RETRIES = 5;
const RETRY_BASE_MS = Number(process.env.TSU_CRAWL_RETRY_BASE_MS || 1000);   // 取り直しの待ちの基準（確かめ用のみ短くする）
const USER_AGENT =
  `joubun-kun-tsutatsu-crawler/1.0 (+https://joubun-kun.pages.dev; contact: ${SITE.crawlerContact})`;

// 種URL（目次）。ここから /law/tsutatsu/ 配下を再帰的に辿る。
// 個別通達(kobetsu)・措置法通達は menu.htm 経由で発見される。
const SEEDS = [
  '/law/tsutatsu/menu.htm',
  '/law/tsutatsu/kihon/shotoku/01.htm',        // 所得税
  '/law/tsutatsu/kihon/sisan/sozoku2/01.htm',  // 相続税
  '/law/tsutatsu/kihon/sisan/hyoka_new/01.htm',// 財産評価
  '/law/tsutatsu/kihon/hojin/01.htm',          // 法人税
  '/law/tsutatsu/kihon/renketsu/01.htm',       // 連結納税
  '/law/tsutatsu/kihon/shohi/01.htm',          // 消費税
  '/law/tsutatsu/kihon/inshi/mokuji.htm',      // 印紙税
  '/law/tsutatsu/kihon/kihatsu/01.htm',        // 揮発油税
  '/law/tsutatsu/kihon/sekiyugasu/01.htm',     // 石油ガス税
  '/law/tsutatsu/kihon/kokuki/01.htm',         // 航空機燃料税
  '/law/tsutatsu/kihon/dengenkaihatsu/01.htm', // 電源開発促進税
  '/law/tsutatsu/kihon/sekiyusekitan/01.htm',  // 石油石炭税
  '/law/tsutatsu/kihon/tabako/01.htm',         // たばこ税
  '/law/tsutatsu/kihon/kanko/01.htm',          // 国際観光旅客税
  '/law/tsutatsu/kihon/sake/01.htm',           // 酒税
  '/law/tsutatsu/kihon/tsusoku/00.htm',        // 国税通則法
  '/law/tsutatsu/kihon/chosyu/index.htm',      // 国税徴収法
  '/law/tsutatsu/kihon/tainoshobun/index.htm', // 滞納処分調整
  '/law/tsutatsu/kihon/igi/01.htm',            // 不服審査(国税庁)
  '/law/tsutatsu/kihon/shinsaseikyu/00.htm',   // 不服審査(審判所)
  '/law/tsutatsu/kihon/zeirishi/01.htm',       // 税理士法
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
    if (!url.pathname.startsWith(SCOPE_PREFIX)) return false;
    if (!/\.html?$/i.test(url.pathname)) return false; // HTMLのみ。PDF等は辿らない
    if (onlyFilter && !url.pathname.includes(`/${onlyFilter}/`)) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeForHash(html) {
  // 生HTMLから script/style/コメント/タグを除去し本文を正規化。改正検知用のハッシュ対象。
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
  // 1. Content-Type ヘッダ
  if (contentType) {
    const m = contentType.match(/charset=([\w-]+)/i);
    if (m) return m[1];
  }
  // 2. HTML 内の meta（先頭4KBを latin1 として走査）
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  let m = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (m) return m[1];
  m = head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i);
  if (m) return m[1];
  // 3. nta.go.jp は概ね Shift_JIS
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

// NTA が「ページが見つからない」ときに HTTP 200 で返すエラーページ。
// これを通常のコンテンツとして扱うと取得済みの通達が静かに消える。
function isNtaErrorPage(html) {
  if (!html) return false;
  const t = extractTitle(html) || '';
  if (/指定されたページを表示できませんでした/.test(t)) return true;
  return /指定されたページを表示できませんでした/.test(html) && html.length < 20000;
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

function localPathForUrl(url, snapshotDir) {
  const u = new URL(url, BASE);
  const rel = u.pathname.replace(SCOPE_PREFIX, ''); // kihon/hojin/09/09_02_03.htm
  return path.join(snapshotDir, rel.split('/').join(path.sep));
}

// 304 のときに引き継ぐ前回の写し。台帳の local_path → 今回より前のスナップショット（新しい順）の同じパス。
//   台帳の content_hash と合わない写し（古い版しか残っていない等）は使わない。
function prevSnapshotDirs(stamp) {
  return fs.readdirSync(REPO_ROOT)
    .filter((d) => /^all_tsutatsu_\d{8}$/.test(d) && d < `all_tsutatsu_${stamp}`)
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
      const wait = RETRY_BASE_MS * Math.pow(2, attempt);
      console.log(`  retry ${attempt + 1}/${MAX_RETRIES} after ${wait}ms: ${e.message}`);
      await sleep(wait);
    }
  }
  throw new Error(`Failed after ${MAX_RETRIES} retries: ${url}`);
}

async function main() {
  const opts = parseArgs();
  const stamp = opts.snapshot || todayStamp();
  const snapshotDir = path.join(REPO_ROOT, `all_tsutatsu_${stamp}`);
  const manifestFile = path.join(STATE_DIR, `manifest_${stamp}.ndjson`);
  const ledgerFile = path.join(STATE_DIR, 'crawl_ledger.json');

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: true });

  const prevLedger = fs.existsSync(ledgerFile)
    ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    : {};
  const prevDirs = prevSnapshotDirs(stamp);

  // 同日スナップショットのレジューム（途中で落ちても再開できる）
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
        // 保存済みHTML（UTF-8）からリンクを再抽出し、未取得分のフロンティアを復元
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

  // フロンティア初期化（SEED + レジュームで復元したリンク、visited は除外）
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
  let errorPages = 0;   // HTTP 200 で返ってくる NTA のエラーページ
  const errorStream = fs.createWriteStream(path.join(STATE_DIR, 'crawl_error_pages.ndjson'), { flags: 'a' });

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
    let pdfLinks = [];
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
        // 写しが無い／台帳と合わない → 条件なしで取り直す（304 のまま進むと下を辿れない）
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
      // 【2026-09-03】NTA は消えたページに HTTP 200 でエラーページを返す。
      //   これを本文として保存すると、前回まで取れていた通達が静かに消える
      //   （v3 で 5ページ・11本がこれで落ちた）。エラーページなら
      //   スナップショットを上書きせず、台帳も前回の hash を保つ。
      if (isNtaErrorPage(html)) {
        errorPages++;
        const prev = prevLedger[url] || {};
        hash = prev.content_hash || null;
        lastMod = prev.last_modified || null;
        etag = prev.etag || null;
        title = prev.title || null;
        newLedger[url] = { ...prev, content_hash: hash, last_modified: lastMod, etag, title,
          error_page_at: new Date().toISOString() };
        fetched++;
        errorStream.write(JSON.stringify({ url, reason: 'nta_error_page_http200', fetched_at: new Date().toISOString() }) + '\n');
        await sleep(SLEEP_MS);
        continue;
      }
      hash = sha256(normalizeForHash(html));
      lastMod = res.last_modified;
      etag = res.etag;
      title = extractTitle(html);

      // 変更判定（ログ用）
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
    pdfLinks = extractHrefs(html, url, /\.pdf$/i);
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
        pdf_links: pdfLinks,
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

  // 台帳更新（部分クロール=only/max時は前回分とマージ、全件時は置き換え）。旧版は .bak に退避。
  const partial = opts.only || opts.max !== Infinity;
  const mergedLedger = partial ? { ...prevLedger, ...newLedger } : newLedger;
  if (fs.existsSync(ledgerFile)) fs.copyFileSync(ledgerFile, ledgerFile + '.bak');
  fs.writeFileSync(ledgerFile, JSON.stringify(mergedLedger, null, 2), 'utf8');

  console.log('');
  errorStream.end();
  console.log(`完了: ${fetched} ページ取得 / 304スキップ ${skipped304} / 新規 ${added} / 変更 ${changed}`);
  if (refetched304) console.log(`  304 だが前回の写しが無い／台帳と合わず取り直した: ${refetched304} 件`);
  if (errorPages) console.log(`  NTAのエラーページ(HTTP200): ${errorPages} 件 — 前回の内容を保持しました（state/crawl_error_pages.ndjson）`);
  console.log(`スナップショット: ${snapshotDir}`);
  console.log(`マニフェスト: ${manifestFile}`);
  console.log(`台帳: ${ledgerFile}`);
  if (fetched >= opts.max) console.log(`※ --max ${opts.max} で打ち切り（フロンティア残 ${queue.length}）`);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
