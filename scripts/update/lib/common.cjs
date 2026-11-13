// 週次更新パイプラインの共通部品（パス・設定・ログ・再試行・条番号の変換）。
//
// 環境変数:
//   UPDATE_STATE_DIR        中間成果物の置き場（既定 scripts/update/state）
//   CLOUDFLARE_ACCOUNT_ID   Cloudflare アカウント ID（R2_ACCOUNT_ID でも可）
//   CLOUDFLARE_API_TOKEN    R2 読み書き・Vectorize・Workers AI の権限を持つトークン（R2_API_TOKEN でも可）
//   UPDATE_DRY_RUN=1        書き込み系（R2 PUT/DELETE・Vectorize upsert/delete）を実行せずログだけ出す
//   R2_FAKE_DIR             R2 の代わりにこのディレクトリを読み書きする（テスト・オフライン検証用）
//   VECTORIZE_FAKE_FILE     Vectorize の代わりにこの JSON ファイルを読み書きする
//   AI_FAKE=1               Workers AI を呼ばず決定的な疑似ベクトルを返す
//   ARTICLES_PREFIX         条文ファイルのプレフィックス（既定 large_law_articles_v4。2026-09-21 の全件再構築で v3 → v4）
//   REFS_PREFIX             参照関係のプレフィックス（既定 refs_chunks_v5）
//   OLD_REFS_PREFIX         全件再構築のとき、抽出に失敗した法令の refs を写してくる元（既定 REFS_PREFIX と同じ）
//   VECTORIZE_INDEX         Vectorize のインデックス名（既定 law-embeddings-v2）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STATE_DIR = process.env.UPDATE_STATE_DIR ? path.resolve(process.env.UPDATE_STATE_DIR) : path.join(REPO_ROOT, 'scripts', 'update', 'state');

const CONFIG = {
  repoRoot: REPO_ROOT,
  stateDir: STATE_DIR,
  bucket: process.env.R2_BUCKET || 'joubun-kun-data',
  articlesPrefix: process.env.ARTICLES_PREFIX || 'large_law_articles_v4',
  // 全件再構築で新しいプレフィックス（v4）を作るとき、ベクトルと本文の差分は今の本番（v3）と比べる。
  // 未指定なら articlesPrefix と同じ（＝いつもの週次）。
  oldArticlesPrefix: process.env.OLD_ARTICLES_PREFIX || process.env.ARTICLES_PREFIX || 'large_law_articles_v4',
  refsPrefix: process.env.REFS_PREFIX || 'refs_chunks_v5',
  // 全件再構築で refs の抽出に失敗した法令は、今の本番（v4）の refs を写す。未指定なら refsPrefix と同じ（＝週次では写さない）
  oldRefsPrefix: process.env.OLD_REFS_PREFIX || process.env.REFS_PREFIX || 'refs_chunks_v5',
  // 本番の通達（wrangler.toml の TSUTATSU_CHUNKS_PREFIX と同じ値。2026-09-24 に v4 へ切り替えた。05_diff の「宙に浮く紐付け」が読む）
  tsutatsuPrefix: process.env.TSUTATSU_CHUNKS_PREFIX || 'tsutatsu_chunks_v4',
  vectorizeIndex: process.env.VECTORIZE_INDEX || 'law-embeddings-v2',
  ledgerKey: 'update_state/sync_state.json',      // 改正 ID の台帳（R2 側の正）
  metadataKey: 'data_metadata.json',              // 画面の「○月○日時点」
  repealedListKey: 'update_state/repealed_laws.json',   // 消した廃止法令の一覧（題名・廃止日。条文ページの「廃止されました」に使う。10 が足す）
  repealPendingPrefix: 'update_state/repeal_pending',   // 廃止で消している途中の法令の控え（07 が消す前に置き、10 が外す。途中で落ちても 05 が拾い直す）
  backupPrefix: 'backup_updates',                 // 上書き前の退避先 backup_updates/{run_id}/...
  dryRun: process.env.UPDATE_DRY_RUN === '1',
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID || '',
  apiToken: process.env.CLOUDFLARE_API_TOKEN || process.env.R2_API_TOKEN || '',
  egovApiBase: 'https://laws.e-gov.go.jp/api/2',
  // 安全弁（05_diff で超えたら apply を止める）
  limits: {
    maxChangedLaws: Number(process.env.UPDATE_MAX_CHANGED_LAWS || 800),   // 週の変更法令数の上限
    maxArticleDropRatio: Number(process.env.UPDATE_MAX_DROP_RATIO || 0.3), // 1 法令の条数が 30% 超減ったら止める
    maxRepealedLaws: Number(process.env.UPDATE_MAX_REPEALED_LAWS || 60),  // 1 回に消す廃止法令の上限（初回は今までに残った 30 本ほど）
  },
};

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function statePath(...parts) { return path.join(STATE_DIR, ...parts); }
function readJson(p, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; }
}
function writeJson(p, obj, pretty = false) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj), 'utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, { tries = 5, baseMs = 500, label = '' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (e && e.noRetry) throw e;   // 再試行しても無駄なエラー（入力が大きすぎる等）
      if (i < tries - 1) {
        const wait = baseMs * 2 ** i;
        log(`  retry ${i + 1}/${tries} ${label} in ${wait}ms: ${e.message}`);
        await sleep(wait);
      }
    }
  }
  throw last;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function md5(str) { return crypto.createHash('md5').update(str, 'utf8').digest('hex'); }

function log(...a) { console.log(...a); }
function nowIso() { return new Date().toISOString(); }
function runId() { return process.env.UPDATE_RUN_ID || nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }

// ===== 条番号の表現（Worker と同じ規則） =====
function kanjiToNumber(str) {
  const k = { '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  let result = 0, temp = 0;
  for (const ch of String(str)) {
    if (ch === '千') { temp = (temp || 1) * 1000; result += temp; temp = 0; }
    else if (ch === '百') { temp = (temp || 1) * 100; result += temp; temp = 0; }
    else if (ch === '十') { temp = (temp || 1) * 10; result += temp; temp = 0; }
    else if (k[ch] !== undefined) temp = temp * 10 + k[ch];
  }
  return result + temp;
}
// 「第七十条の六の二」→ [70, 6, 2]。条でなければ null。
// 全角・半角の算用数字の条名（「第１２条の２」。国家公安委員会規則など）も受ける（worker/lawpages.js の titleToNums と同じ。2026-09-22）
const NUM_TOKEN = '(?:[一二三四五六七八九十百千〇]+|[0-9０-９]+)';
const TITLE_RE = new RegExp(`^第(${NUM_TOKEN})条((?:の${NUM_TOKEN})*)$`);
const tokenToNumber = (tok) => (/^[0-9０-９]+$/.test(tok) ? parseInt(tok.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)), 10) : kanjiToNumber(tok));
function titleToNums(title) {
  const m = String(title || '').match(TITLE_RE);
  if (!m) return null;
  const subs = (m[2].match(new RegExp(`の${NUM_TOKEN}`, 'g')) || []).map((x) => tokenToNumber(x.slice(1)));
  return [tokenToNumber(m[1]), ...subs];
}
// 通達・判例・事例の紐付けキー「70の6の2」／ refs のキー「Art70_6_2」
const titleToJou = (t) => { const n = titleToNums(t); return n ? n.join('の') : null; };
const titleToArt = (t) => { const n = titleToNums(t); return n ? 'Art' + n.join('_') : null; };

// ファイル名（lib/split.py の safe_filename と同じ対応表）
const INVALID = { '/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
function safeFilename(title) {
  let s = String(title == null ? '' : title);
  for (const [bad, good] of Object.entries(INVALID)) s = s.split(bad).join(good);
  s = s.replace(/[ .]+$/, '');
  // UTF-8 で 200 バイトに切る（lib/split.py と同じ規則）
  let cps = Array.from(s);
  while (Buffer.byteLength(cps.join(''), 'utf8') > MAX_FILENAME_BYTES) cps.pop();
  s = cps.join('').replace(/[ .]+$/, '');
  return s || '_unnamed';
}
const MAX_FILENAME_BYTES = 200;

// 法令の週次で「見直す対象」（書く前に止める）にする法令か（05 の manifest と 10 の報告で同じ判定）
//   止める: 条番号の振り直し疑い・この更新で新たに浮く紐付け・通達／判例／事例が付いた条の見出しの変化（条の中身がすり替わった疑い）
//   止めない: 委任先が付いた条の見出しの変化だけ。委任先の週次（update_delegations.yml）が条文の変わった法令の紐付けを
//     反映の後に毎回やり直し、委任が大きく減るなどは向こうの Issue（delegations-update）で知らせる（2026-10-11 まで毎週これだけで止まり、
//     中身は「財務省令への委任→主務省令への委任」のような言い回しだった）
function reviewCaptionKinds(e) { return Object.keys((e && e.caption_changed) || {}).filter((k) => k !== 'delegations'); }
function isReviewLaw(e) { return !!(e.renumber || Object.keys(e.dangling || {}).length || reviewCaptionKinds(e).length); }

module.exports = {
  CONFIG, STATE_DIR, REPO_ROOT, ensureDir, statePath, readJson, writeJson, sleep, retry, sha256, md5, log, nowIso, runId,
  kanjiToNumber, titleToNums, titleToJou, titleToArt, safeFilename, isReviewLaw, reviewCaptionKinds,
};
