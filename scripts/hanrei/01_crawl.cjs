// 裁判所 裁判例検索 (courts.go.jp) クローラ
//
// 使い方:
//   node scripts/hanrei/01_crawl.cjs --mode list                      # 6コレクション全期間の一覧スイープ
//   node scripts/hanrei/01_crawl.cjs --mode list --collection rodo \
//        --from-gengo 昭和 --from-year 45 --to-gengo 昭和 --to-year 47 # 検証用の小スライス
//   node scripts/hanrei/01_crawl.cjs --mode detail [--resume] [--max N]
//   node scripts/hanrei/01_crawl.cjs --mode pdf    [--resume] [--max N]
//
// 出力（データ契約）:
//   hanrei_raw/list/{collection}/{slice}_{offset}.html   一覧スナップショット
//   hanrei_raw/detail/{id}_{N}.html                      詳細スナップショット
//   hanrei_raw/pdf/{id}.pdf, hanrei_raw/pdf/point_{id}.pdf
//   scripts/hanrei/state/inventory.ndjson                一覧行 1行=1JSON（追記式・読む側で id+detailN 重複排除）
//   scripts/hanrei/state/crawl_ledger.json               url -> {content_hash,...} 台帳（差分・レジュームの真実源）
//
// 方針: 1リクエスト1秒スリープ・UA明示・リトライ最大5回(指数バックオフ)。
// スナップショットは日付なしの安定パス hanrei_raw/（68k件×10GBを複製しないため。差分は台帳のhashで検知）。
// 進捗ログは 件数/URL/経過時間 のみ（ユーザー由来情報は書かない）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
// HANREI_DATA_ROOT: 週次更新（scripts/hanrei/weekly）が自分の作業フォルダを使うときだけ指定する。
//   未指定なら従来どおり hanrei_raw/ と scripts/hanrei/state/（全件クロールの手元データを上書きしない）
const DATA_ROOT = process.env.HANREI_DATA_ROOT ? path.resolve(process.env.HANREI_DATA_ROOT) : null;
const STATE_DIR = DATA_ROOT ? path.join(DATA_ROOT, 'state') : path.join(__dirname, 'state');
const RAW_DIR = path.join(DATA_ROOT || REPO_ROOT, 'hanrei_raw');
const LIST_DIR = path.join(RAW_DIR, 'list');
const DETAIL_DIR = path.join(RAW_DIR, 'detail');
const PDF_DIR = path.join(RAW_DIR, 'pdf');
const LEDGER_FILE = path.join(STATE_DIR, 'crawl_ledger.json');
const INVENTORY_FILE = path.join(STATE_DIR, 'inventory.ndjson');

// HANREI_CRAWL_BASE / HANREI_CRAWL_SLEEP_MS は手元の確かめ用（weekly/check_weekly.cjs が偽の裁判所を立てる）。本番では付けない
const BASE = (process.env.HANREI_CRAWL_BASE || 'https://www.courts.go.jp').replace(/\/$/, '');
const SLEEP_MS = Number(process.env.HANREI_CRAWL_SLEEP_MS || 1000);
const RETRY_BASE_MS = Number(process.env.HANREI_CRAWL_RETRY_BASE_MS || 1000);   // 確かめ用のみ短くする
const MAX_RETRIES = 5;
const USER_AGENT =
  `joubun-kun-hanrei-crawler/1.0 (+https://joubun-kun.com; contact: ${SITE.crawlerContact})`;

// 1クエリ2000件上限。安全マージンを取って1990以上なら月単位に細分する
const SUBDIVIDE_THRESHOLD = 1990;
const HARD_CAP = 2000;

// (検索ページ番号 n, courtCaseType ct)。ct はURLエンコード済み文字列としてそのまま連結する
const COLLECTIONS = {
  saikosai: { n: 2, ct: '1' }, // 最高裁判例
  kosai: { n: 3, ct: '2' }, // 高裁判例
  sokuho: { n: 4, ct: '3' }, // 下級裁裁判例（速報）
  gyosei: { n: 5, ct: '4' }, // 行政事件裁判例
  rodo: { n: 6, ct: '5' }, // 労働事件裁判例
  chizai: { n: 7, ct: '6%207' }, // 知的財産裁判例（6と7）
};

// 元号（enc はURLエンコード済み）。和暦→ISO: 昭和N=1925+N, 平成N=1988+N, 令和N=2018+N
const GENGO_LIST = [
  { name: '昭和', code: 'S', enc: '%E6%98%AD%E5%92%8C', maxYear: 64 },
  { name: '平成', code: 'H', enc: '%E5%B9%B3%E6%88%90', maxYear: 31 },
  { name: '令和', code: 'R', enc: '%E4%BB%A4%E5%92%8C', maxYear: 8 },
];

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeHtmlForHash(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBytes(bytes) {
  // courts.go.jp は UTF-8
  return new TextDecoder('utf-8').decode(bytes);
}

function fmtElapsed(startMs) {
  const s = Math.round((Date.now() - startMs) / 1000);
  const m = Math.floor(s / 60);
  return `${m}分${s % 60}秒`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    mode: null,
    collection: null,
    fromGengo: null,
    fromYear: null,
    toGengo: null,
    toYear: null,
    max: Infinity,
    resume: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--mode') opts.mode = args[++i];
    else if (a === '--collection') opts.collection = args[++i];
    else if (a === '--from-gengo') opts.fromGengo = args[++i];
    else if (a === '--from-year') opts.fromYear = parseInt(args[++i], 10);
    else if (a === '--to-gengo') opts.toGengo = args[++i];
    else if (a === '--to-year') opts.toYear = parseInt(args[++i], 10);
    else if (a === '--max') opts.max = parseInt(args[++i], 10);
    else if (a === '--resume') opts.resume = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(1);
    }
  }
  if (!['list', 'detail', 'pdf'].includes(opts.mode)) {
    console.error('使い方: node scripts/hanrei/01_crawl.cjs --mode list|detail|pdf [--collection NAME] [--from-gengo 元号 --from-year N] [--to-gengo 元号 --to-year N] [--max N] [--resume]');
    process.exit(1);
  }
  if (opts.collection && !COLLECTIONS[opts.collection]) {
    console.error(`不明なコレクション: ${opts.collection}（有効: ${Object.keys(COLLECTIONS).join(' ')}）`);
    process.exit(1);
  }
  return opts;
}

// ------------------------------------------------------------------- ledger

let ledger = {};

function loadLedger() {
  if (fs.existsSync(LEDGER_FILE)) {
    ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  }
}

function saveLedger() {
  const tmp = LEDGER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 1), 'utf8');
  fs.renameSync(tmp, LEDGER_FILE);
}

function recordLedger(url, entry) {
  ledger[url] = { ...entry, fetched_at: new Date().toISOString() };
  saveLedger(); // 都度書き出し（Ctrl-C安全）
}

// -------------------------------------------------------------------- fetch

class BudgetStop extends Error {}

const stats = { requests: 0, startMs: Date.now() };
let budget = Infinity;

async function politeFetch(url, { binary = false, allow404 = false } = {}) {
  if (stats.requests >= budget) throw new BudgetStop(`--max ${budget} に到達`);
  const headers = { 'User-Agent': USER_AGENT };
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 404 && allow404) {
        stats.requests++;
        logProgress();
        await sleep(SLEEP_MS);
        return { status: 404 };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      stats.requests++;
      logProgress();
      await sleep(SLEEP_MS);
      return {
        status: res.status,
        bytes: new Uint8Array(ab),
        content_type: res.headers.get('content-type'),
        last_modified: res.headers.get('last-modified'),
        etag: res.headers.get('etag'),
      };
    } catch (e) {
      lastErr = e;
      const wait = RETRY_BASE_MS * Math.pow(2, attempt);
      console.log(`  retry ${attempt + 1}/${MAX_RETRIES} after ${wait}ms: ${e.message} (${url})`);
      await sleep(wait);
    }
  }
  throw new Error(`Failed after ${MAX_RETRIES} retries: ${url}: ${lastErr && lastErr.message}`);
}

function logProgress() {
  if (stats.requests % 100 === 0) {
    console.log(`[進捗] ${stats.requests} リクエスト完了 / 経過 ${fmtElapsed(stats.startMs)}`);
  }
}

// -------------------------------------------------------- list row parsing
// scratchpad/parse_rows.py の忠実な移植（13行固定位置テンプレ・551行で検証済み）

function stripTagsLine(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 原審欄「裁判所名(+支部) 事件番号」の分解。
// 末尾トークンが元号始まり（例: 令和5(ネ)2730, 令和5特(わ)497）か数字のみ（例: 0）なら事件番号。
// 「福岡高等裁判所 那覇支部 平成7(行コ)1」のような支部付きは裁判所名側に残す。
function splitGensin(g) {
  if (!g) return { court: '', caseNo: '' };
  const m = /^(.*?)\s+((?:明治|大正|昭和|平成|令和)\S*|\d+)$/.exec(g);
  if (m) return { court: m[1].trim(), caseNo: m[2] };
  return { court: g, caseNo: '' };
}

// 一覧HTMLから結果行を抽出する。
// 戻り値: [{ links: [{id, detailN}], caseNo, title, date, court, branch, courtDetail,
//            kind, kekka, gensinCourt, gensinCaseNo, bunya }]
// 1結果行に複数の detail リンクが付くことがある（例: 下級裁裁判例＋行政事件裁判例）。
function parseListRows(html) {
  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let trM;
  while ((trM = trRe.exec(html)) !== null) {
    const tr = trM[1];
    const linkRe = /(\d+)\/detail(\d)\/index\.html/g;
    const seen = new Set();
    const links = [];
    let lm;
    while ((lm = linkRe.exec(tr)) !== null) {
      const key = `${lm[1]}_${lm[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ id: lm[1], detailN: parseInt(lm[2], 10) });
    }
    if (links.length === 0) continue;

    const tdM = /<td[^>]*>([\s\S]*?)<\/td>/.exec(tr);
    if (!tdM) continue;
    const ps = [];
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/g;
    let pm;
    while ((pm = pRe.exec(tdM[1])) !== null) ps.push(pm[1]);
    if (ps.length < 2) {
      console.log(`WARN: 想定外の行構造（<p>不足）id=${links[0].id}`);
      continue;
    }
    const p0 = ps[0].split('\n').map(stripTagsLine);
    const p1 = ps[1].split('\n').map(stripTagsLine);
    if (p1.length !== 13) {
      console.log(`WARN: 想定外のp1行数 ${p1.length} id=${links[0].id}`);
      continue;
    }
    const gensin = splitGensin(p1[10]);
    rows.push({
      links,
      caseNo: p0[1] || '',
      title: p0[2] || '',
      date: p1[1],
      court: p1[2],
      branch: p1[3],
      courtDetail: p1[4],
      kind: p1[5] || p1[7], // 知財高裁行は idx7
      kekka: p1[6] || p1[8], // 知財高裁行は idx8
      gensinCourt: gensin.court,
      gensinCaseNo: gensin.caseNo,
      bunya: p1[11],
    });
  }
  return rows;
}

// 総件数。「N件中 M～L件を表示」を読む。0件は「該当する裁判例がありませんでした」
// （ヘルプ文中の「…」括弧書きは除外）。判定不能は null。
function readListTotal(html) {
  const m = /([0-9,]+)件中\s*[0-9,]+\s*～/.exec(html);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  if (/(?<!「)該当する裁判例がありませんでした/.test(html)) return 0;
  return null;
}

// ---------------------------------------------------------------- list mode

function listUrl(coll, gengo, year, month, offset) {
  const c = COLLECTIONS[coll];
  const m1 = month || 1;
  const m2 = month || 12;
  let u =
    `${BASE}/hanrei/search${c.n}/index.html?courtCaseType=${c.ct}&query1=&query2=` +
    `&filter%5BjudgeDateMode%5D=2` +
    `&filter%5BjudgeGengoFrom%5D=${gengo.enc}&filter%5BjudgeYearFrom%5D=${year}` +
    `&filter%5BjudgeMonthFrom%5D=${m1}&filter%5BjudgeDayFrom%5D=1` +
    `&filter%5BjudgeGengoTo%5D=${gengo.enc}&filter%5BjudgeYearTo%5D=${year}` +
    `&filter%5BjudgeMonthTo%5D=${m2}&filter%5BjudgeDayTo%5D=31`;
  if (offset) u += `&offset=${offset}`;
  return u;
}

function sliceName(gengo, year, month) {
  return month ? `${gengo.code}${pad2(year)}M${pad2(month)}` : `${gengo.code}${pad2(year)}`;
}

function appendInventory(resultRows, collection, sliceKey) {
  let out = '';
  let n = 0;
  for (const r of resultRows) {
    for (const link of r.links) {
      out +=
        JSON.stringify({
          id: link.id,
          detailN: link.detailN,
          collection,
          caseNo: r.caseNo,
          title: r.title,
          date: r.date,
          court: r.court,
          branch: r.branch,
          courtDetail: r.courtDetail,
          kind: r.kind,
          kekka: r.kekka,
          gensinCourt: r.gensinCourt,
          gensinCaseNo: r.gensinCaseNo,
          bunya: r.bunya,
          sliceKey,
        }) + '\n';
      n++;
    }
  }
  if (out) fs.appendFileSync(INVENTORY_FILE, out, 'utf8');
  return n;
}

async function crawlSlice(opts, coll, gengo, year, month) {
  const slice = sliceName(gengo, year, month);
  const sliceKey = `${coll}_${slice}`;
  const collDir = path.join(LIST_DIR, coll);
  fs.mkdirSync(collDir, { recursive: true });

  // 先頭ページ（offset=0）で総件数を読む
  const url0 = listUrl(coll, gengo, year, month, 0);
  const file0 = path.join(collDir, `${slice}_0.html`);
  let total = null;
  let html0 = null;

  const led0 = ledger[url0];
  if (opts.resume && led0 && led0.status === 'ok' && typeof led0.total === 'number' && fs.existsSync(file0)) {
    total = led0.total; // 取得済み（行は追記済み or 細分済み）
  } else {
    let res;
    try {
      res = await politeFetch(url0);
    } catch (e) {
      if (e instanceof BudgetStop) throw e;
      console.log(`FAIL list ${sliceKey} offset=0: ${e.message}`);
      recordLedger(url0, { status: 'error', error: e.message });
      return;
    }
    html0 = decodeBytes(res.bytes);
    fs.writeFileSync(file0, html0, 'utf8');
    total = readListTotal(html0);
    if (total === null) {
      console.log(`WARN: 件数を読めないページ ${url0}`);
      recordLedger(url0, { status: 'error', error: 'total_unreadable' });
      return;
    }
  }

  const subdivide = !month && total >= SUBDIVIDE_THRESHOLD;

  if (html0 !== null) {
    // 新規取得時のみ: 行追記（細分するスライスの行は月側で拾うため追記しない）→台帳
    let rowCount = 0;
    if (!subdivide && total > 0) {
      const rows = parseListRows(html0);
      rowCount = appendInventory(rows, coll, sliceKey);
    }
    recordLedger(url0, {
      status: 'ok',
      content_hash: sha256(normalizeHtmlForHash(html0)),
      last_modified: null,
      etag: null,
      total,
      rows: rowCount,
    });
  }

  if (total === 0) return;
  console.log(`[list] ${sliceKey}: ${total}件${subdivide ? '（>=1990のため月単位に細分）' : ''}`);

  if (subdivide) {
    for (let m = 1; m <= 12; m++) {
      await crawlSlice(opts, coll, gengo, year, m);
    }
    return;
  }
  if (month && total >= SUBDIVIDE_THRESHOLD) {
    console.log(`WARN: 月スライス ${sliceKey} が ${total}件（2000件上限で取りこぼしの可能性）`);
  }

  const capped = Math.min(total, HARD_CAP);
  for (let off = 30; off < capped; off += 30) {
    const url = listUrl(coll, gengo, year, month, off);
    const file = path.join(collDir, `${slice}_${off}.html`);
    if (opts.resume && ledger[url] && ledger[url].status === 'ok' && fs.existsSync(file)) continue;
    let res;
    try {
      res = await politeFetch(url);
    } catch (e) {
      if (e instanceof BudgetStop) throw e;
      console.log(`FAIL list ${sliceKey} offset=${off}: ${e.message}`);
      recordLedger(url, { status: 'error', error: e.message });
      continue;
    }
    const html = decodeBytes(res.bytes);
    fs.writeFileSync(file, html, 'utf8');
    const rows = parseListRows(html);
    const n = appendInventory(rows, coll, sliceKey);
    recordLedger(url, {
      status: 'ok',
      content_hash: sha256(normalizeHtmlForHash(html)),
      last_modified: null,
      etag: null,
      rows: n,
    });
  }
}

function buildYearSpan(opts) {
  const span = [];
  for (const g of GENGO_LIST) {
    for (let y = 1; y <= g.maxYear; y++) span.push({ gengo: g, year: y });
  }
  const idx = (name, year, fallback) => {
    if (!name) return fallback;
    const i = span.findIndex((s) => s.gengo.name === name && s.year === year);
    if (i < 0) {
      console.error(`不正な期間指定: ${name}${year}`);
      process.exit(1);
    }
    return i;
  };
  const from = idx(opts.fromGengo, opts.fromYear, 0);
  const to = idx(opts.toGengo, opts.toYear, span.length - 1);
  return span.slice(from, to + 1);
}

async function runList(opts) {
  const colls = opts.collection ? [opts.collection] : Object.keys(COLLECTIONS);
  const span = buildYearSpan(opts);
  console.log(`一覧スイープ: ${colls.join(',')} × ${span[0].gengo.name}${span[0].year}〜${span[span.length - 1].gengo.name}${span[span.length - 1].year}（${span.length}年）`);
  for (const coll of colls) {
    for (const s of span) {
      await crawlSlice(opts, coll, s.gengo, s.year, null);
    }
  }
}

// ----------------------------------------------------------- inventory read

function readInventory() {
  if (!fs.existsSync(INVENTORY_FILE)) {
    console.error(`inventory がありません: ${INVENTORY_FILE}（先に --mode list を実行）`);
    process.exit(1);
  }
  const out = [];
  for (const line of fs.readFileSync(INVENTORY_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 壊れた行はスキップ */
    }
  }
  return out;
}

// -------------------------------------------------------------- detail mode

async function runDetail(opts) {
  fs.mkdirSync(DETAIL_DIR, { recursive: true });
  const inv = readInventory();
  const targets = new Map(); // "id_N" -> {id, detailN}
  for (const r of inv) {
    const key = `${r.id}_${r.detailN}`;
    if (!targets.has(key)) targets.set(key, { id: r.id, detailN: r.detailN });
  }
  console.log(`詳細ページ対象: ${targets.size} 件（inventory ${inv.length} 行）`);
  let done = 0;
  let skipped = 0;
  try {
    await detailLoop();
  } finally {
    console.log(`詳細ページ: 取得 ${done} / スキップ ${skipped} / 対象 ${targets.size}`);
  }

  async function detailLoop() {
    for (const { id, detailN } of targets.values()) {
      const url = `${BASE}/hanrei/${id}/detail${detailN}/index.html`;
      const file = path.join(DETAIL_DIR, `${id}_${detailN}.html`);
      const led = ledger[url];
      if (opts.resume && led && (led.status === 'ok' && fs.existsSync(file) || led.status === '404')) {
        skipped++;
        continue;
      }
      let res;
      try {
        res = await politeFetch(url, { allow404: true });
      } catch (e) {
        if (e instanceof BudgetStop) throw e;
        console.log(`FAIL detail ${id}_${detailN}: ${e.message}`);
        recordLedger(url, { status: 'error', error: e.message });
        continue;
      }
      if (res.status === 404) {
        console.log(`404 detail ${id}_${detailN}`);
        recordLedger(url, { status: '404' });
        continue;
      }
      const html = decodeBytes(res.bytes);
      fs.writeFileSync(file, html, 'utf8');
      recordLedger(url, {
        status: 'ok',
        content_hash: sha256(normalizeHtmlForHash(html)),
        last_modified: res.last_modified,
        etag: res.etag,
      });
      done++;
    }
  }
}

// ----------------------------------------------------------------- pdf mode

async function fetchPdf(opts, url, file, label) {
  const led = ledger[url];
  if (opts.resume && led && (led.status === 'ok' && fs.existsSync(file) || led.status === '404')) {
    return 'skipped';
  }
  let res;
  try {
    res = await politeFetch(url, { binary: true, allow404: true });
  } catch (e) {
    if (e instanceof BudgetStop) throw e;
    console.log(`FAIL pdf ${label}: ${e.message}`);
    recordLedger(url, { status: 'error', error: e.message });
    return 'error';
  }
  if (res.status === 404) {
    console.log(`404 pdf ${label}`);
    recordLedger(url, { status: '404' });
    return '404';
  }
  fs.writeFileSync(file, Buffer.from(res.bytes));
  recordLedger(url, {
    status: 'ok',
    content_hash: sha256(Buffer.from(res.bytes)),
    last_modified: res.last_modified,
    etag: res.etag,
    size: res.bytes.length,
  });
  return 'ok';
}

async function runPdf(opts) {
  fs.mkdirSync(PDF_DIR, { recursive: true });
  const inv = readInventory();
  const ids = [];
  const seen = new Set();
  for (const r of inv) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      ids.push(r.id);
    }
  }
  console.log(`全文PDF対象: ${ids.length} 件`);
  const counts = { ok: 0, skipped: 0, 404: 0, error: 0 };
  try {
    for (const id of ids) {
      const url = `${BASE}/assets/hanrei/hanrei-pdf-${id}.pdf`;
      const file = path.join(PDF_DIR, `${id}.pdf`);
      counts[await fetchPdf(opts, url, file, id)]++;
    }
  } finally {
    console.log(`全文PDF: 取得 ${counts.ok} / スキップ ${counts.skipped} / 404 ${counts['404']} / 失敗 ${counts.error}`);
  }

  // 知財 detail8 の「要旨」別PDF: 取得済み詳細HTMLから hanrei-point_pdf-{id}.pdf 参照を走査
  const pointIds = [];
  const pointSeen = new Set();
  if (fs.existsSync(DETAIL_DIR)) {
    for (const f of fs.readdirSync(DETAIL_DIR)) {
      if (!f.endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(DETAIL_DIR, f), 'utf8');
      const re = /hanrei-point_pdf-(\d+)\.pdf/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        if (!pointSeen.has(m[1])) {
          pointSeen.add(m[1]);
          pointIds.push(m[1]);
        }
      }
    }
  }
  console.log(`要旨PDF対象（詳細HTML走査）: ${pointIds.length} 件`);
  const pc = { ok: 0, skipped: 0, 404: 0, error: 0 };
  try {
    for (const id of pointIds) {
      const url = `${BASE}/assets/hanrei/hanrei-point_pdf-${id}.pdf`;
      const file = path.join(PDF_DIR, `point_${id}.pdf`);
      pc[await fetchPdf(opts, url, file, `point_${id}`)]++;
    }
  } finally {
    console.log(`要旨PDF: 取得 ${pc.ok} / スキップ ${pc.skipped} / 404 ${pc['404']} / 失敗 ${pc.error}`);
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs();
  budget = opts.max;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });
  loadLedger();

  process.on('SIGINT', () => {
    console.log('\n中断（SIGINT）: 台帳を保存して終了します');
    try {
      saveLedger();
    } catch {
      /* noop */
    }
    process.exit(130);
  });

  try {
    if (opts.mode === 'list') await runList(opts);
    else if (opts.mode === 'detail') await runDetail(opts);
    else if (opts.mode === 'pdf') await runPdf(opts);
  } catch (e) {
    if (e instanceof BudgetStop) {
      console.log(`打ち切り: ${e.message}（--resume で続きから再開可能）`);
    } else {
      throw e;
    }
  }
  saveLedger();
  console.log(`完了: ${stats.requests} リクエスト / 経過 ${fmtElapsed(stats.startMs)}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FAIL:', e);
    try {
      saveLedger();
    } catch {
      /* noop */
    }
    process.exit(1);
  });
}

module.exports = { parseListRows, splitGensin, readListTotal, sliceName, listUrl };
