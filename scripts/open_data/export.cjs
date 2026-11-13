#!/usr/bin/env node
// 公開データの書き出し（docs/open_data.md の 2 章）。本番の R2 を**読むだけ**で、公開用のバケットに版ごとの JSONL（gzip）と MANIFEST を書く。
//
//   node scripts/open_data/export.cjs --out /tmp/open_data                 # 手元に作るだけ（公開用のバケットに書かない）
//   node scripts/open_data/export.cjs --out /tmp/open_data --upload        # 作って公開用のバケットに書く
//     [--release 2026-11-02]   版の名前（既定は今日の日付・日本時間）
//     [--only laws,articles]   作るデータを絞る（既定は全部）
//     [--limit-laws 20]        法令を先頭から N 本だけ（試し用。--upload とは一緒に使えない）
//     [--force-shrink]         前の版より件数が 5% 超減っても止めない（版の切り替えなどで正しく減ったとき）
//     [--prev DIR]             前の版の MANIFEST.json・laws.jsonl.gz・articles.jsonl.gz（release_hf.py --fetch-prev が置く）。台帳の改正 ID が前の版と同じ法令は
//                              R2 を読まずに前の版の行を使い回す（as_of だけ今の時点に書き換える）。MANIFEST の sha256・形の版・条文の置き場が合わなければ使わずに全部読む
//     [--full]                 --prev があっても全部読み直す（月に 1 回・前の版の行に紛れた誤りを戻すため）
//   node scripts/open_data/export.cjs --write-check         公開用のバケットに書けるかだけ確かめる（_write_check/ に小さなファイルを書き、読み直して消す。本番は読まない）
//
//   読む側（本番）: CLOUDFLARE_ACCOUNT_ID・CLOUDFLARE_API_TOKEN（週次と同じ）。R2_FAKE_DIR で手元のディレクトリを本番に見立てられる
//   書く側（公開）: OPEN_DATA_BUCKET（既定 joubun-kun-open）・OPEN_DATA_API_TOKEN（無ければ読む側と同じ）。OPEN_DATA_FAKE_DIR で手元のディレクトリを公開用のバケットに見立てられる
//
// 第 1 弾（e-Gov 由来）: laws・articles・refs・delegations・kokuji_gaps。
// 第 2 弾（2026-11-06）: links（条 → 通達・質疑応答事例・裁決・判例の紐付け。ID・題名・日付・原文の URL・付け方だけで、本文は入れない）。
//   本番のデータの形は変えない。元の項目は残し、公開用の項目（article_id・method・source_url・as_of など）を足すだけ。
//
// 安全のため:
//   - 書く先が本番のバケットと同じなら止める（本番に書かない）
//   - 目次（_index.json）か目次に載った条文ファイルが読めない・無い・形が違えば、書き出しをやめる（R2 の読み取りは中で再試行してから。
//     元から壊れていると分かっているものだけ OPEN_DATA_ALLOW_MISSING="{法令ID}/{ファイル名},…"（目次なら {法令ID}/_index.json）で通す）
//   - 前の版（latest.json が指す版）より件数が 5% 超減ったデータがあれば、公開用のバケットに書く前に止める。
//     latest.json や前の版の MANIFEST が読めない・壊れているときも止める（初回扱いにするのは latest.json が無いときだけ）
//   - 公開用のバケットへの書き込み（版のファイル・latest・古い版の整理）は、バケット全体の印 _export_lock.json を
//     「無いときだけ書く」で取ってから行う（違う版名で同時に流しても、書いている途中の版を消さない）。落ちて印が残ったら
//     --break-lock で外して流し直す（外す前に、ほかに書き出しが動いていないことを確かめる）
//   - 公開済みの版は上書きしない: 版名は latest より新しいものだけ（同じ日に流し直すなら --release 2026-11-02.2）。
//     書き始める前に releases/{版}/_writing.json を「無いときだけ書く」で置き、既にあれば止める（同時に流した・途中で落ちた版名は使わない）
//   - 版のファイルを全部書いてから MANIFEST.json、最後に latest.json を書き換え、_writing.json を消す（途中で落ちても latest は前の版のまま）
//   - 古い版は、書き終わった版（MANIFEST があり _writing が無い）を新しい順に KEEP（3）個だけ残す。latest が指す版は必ず残す。
//     途中で落ちた版は、今回の版より古ければ消す
// ¥0。LLM を呼ばない。利用者の入力・利用者のデータ（update_state/ の台帳以外）を読まない。ログには件数と法令 ID だけ出す。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { R2 } = require('../update/lib/r2.cjs');
const { CONFIG, titleToNums } = require('../update/lib/common.cjs');

const FORMAT_VERSION = 1;
// 法令と条の行の形の版。cleanArticle と exportLaws の法令の行の項目を変えたら上げる（上がると前の版の行を使い回さない）
const ROW_SHAPE = 1;
const RELEASE_RE = /^\d{4}-\d{2}-\d{2}(?:\.\d{1,2})?$/;
// 版名の新しさの比べ方（日付 → 同じ日の連番を数で。連番なしは 1 番目。2026-11-02 < 2026-11-02.2 < 2026-11-02.10 < 2026-11-03）。
// 文字のまま比べると .10 が .9 より古くなるので、公開してよいかの判定・残す版の順・途中で落ちた版を消すかの判定は全部これを使う
function compareRelease(a, b) {
  const p = (v) => { const m = String(v).match(/^(\d{4}-\d{2}-\d{2})(?:\.(\d{1,2}))?$/); return m ? [m[1], m[2] ? Number(m[2]) : 1] : [String(v), 0]; };
  const [da, na] = p(a), [db, nb] = p(b);
  return da < db ? -1 : da > db ? 1 : na - nb;
}
const KEEP = 3;
// 書き出すデータを書き換える週次の作業中の印（scripts/update/apply_mark.cjs・scripts/delegation/weekly/）
const INPROGRESS_KEYS = ['update_state/laws_apply_inprogress.json', 'update_state/delegations_apply_inprogress.json',
  'update_state/tsutatsu_apply_inprogress.json', 'update_state/cases_apply_inprogress.json', 'update_state/hanrei_apply_inprogress.json'];
// 元のデータの「世代」: 法令の週次の台帳・委任先の週次の控え・refs の目次。反映が終わると書き換わる。書き出しの前と後で比べ、
// 違えば書き出しの間に反映があった（前後のデータが混ざった）ので版にしない（GPT レビュー #415）
const GENERATION_KEYS = () => [CONFIG.ledgerKey, 'update_state/delegations/state.json', `${REFS_PREFIX}/refs_index.json`,
  `${TSU_PREFIX}/index.json`, `${CASES_PREFIX}/_cases.json`, 'hanrei_v2/index.json'];
async function sourceGeneration(src) {
  for (const k of INPROGRESS_KEYS) if (await src.get(k)) throw new Error(`${k} がある（週次の反映の途中）。反映が終わってから流す`);
  const h = crypto.createHash('sha256');
  for (const k of GENERATION_KEYS()) { const b = await src.get(k); h.update(`${k}\n`).update(b ? crypto.createHash('sha256').update(b).digest('hex') : 'none').update('\n'); }
  return h.digest('hex');
}
const SHRINK_LIMIT = 0.05;
const CONC = Number(process.env.OPEN_DATA_CONCURRENCY || 16);
const DATASETS = ['laws', 'articles', 'refs', 'delegations', 'kokuji_gaps', 'links'];
const LICENSE = 'CC-BY-4.0';
const ATTRIBUTION = '出典: e-Gov法令検索（デジタル庁）。条文くん（司法書士法人そうぞう）が加工 https://joubun-kun.com/';
const EGOV_LAW_URL = (lawId) => `https://laws.e-gov.go.jp/law/${lawId}`;
const PAGE_URL = (lawId, key) => `https://joubun-kun.com/law/${lawId}/${key}`;
// 本番が読むプレフィックス（wrangler.toml の vars。health/audit.cjs の tomlVar と同じ読み方。無ければ既定）
function tomlVar(name, fallback) {
  if (process.env[name]) return process.env[name];
  try {
    const toml = fs.readFileSync(path.join(__dirname, '..', '..', 'wrangler.toml'), 'utf8');
    const m = toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, 'm'));
    return m ? m[1] : fallback;
  } catch { return fallback; }
}
const ARTICLES_PREFIX = tomlVar('ARTICLES_PREFIX', 'large_law_articles_v4');
const REFS_PREFIX = tomlVar('REFS_PREFIX', 'refs_chunks_v5');
const DELEG_PREFIX = tomlVar('DELEGATIONS_PREFIX', 'delegations_v6');
const TSU_PREFIX = tomlVar('TSUTATSU_CHUNKS_PREFIX', 'tsutatsu_chunks_v4');
const HANREI_LINKS_PREFIX = tomlVar('HANREI_LINKS_PREFIX', 'hanrei_v2/links');
const CASES_PREFIX = 'article_links_v1';   // 質疑応答事例・裁決 → 条（worker/lawpages.js の getCases と同じ置き場）
const ALLOW_MISSING = new Set(String(process.env.OPEN_DATA_ALLOW_MISSING || '').split(',').map((x) => x.trim()).filter(Boolean));
const pad3 = (n) => String(n).padStart(3, '0');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const log = (...a) => console.log('[open-data]', ...a);

function parseArgs(argv) {
  const o = { out: null, upload: false, release: null, only: null, limitLaws: 0, forceShrink: false, breakLock: false, writeCheck: false, prev: null, full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--upload') o.upload = true;
    else if (a === '--release') o.release = argv[++i];
    else if (a === '--only') o.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit-laws') o.limitLaws = Number(argv[++i]) || 0;
    else if (a === '--force-shrink') o.forceShrink = true;
    else if (a === '--break-lock') o.breakLock = true;
    else if (a === '--write-check') o.writeCheck = true;
    else if (a === '--prev') o.prev = argv[++i];
    else if (a === '--full') o.full = true;
    else throw new Error(`知らない引数: ${a}`);
  }
  if (o.writeCheck) return o;
  if (!o.out) throw new Error('--out が要る');
  if (o.upload && o.limitLaws) throw new Error('--limit-laws は試し用なので --upload と一緒に使えない');
  if (o.release && !RELEASE_RE.test(o.release)) throw new Error('--release は YYYY-MM-DD（同じ日に 2 回目なら YYYY-MM-DD.2）');
  if (o.only) for (const d of o.only) if (!DATASETS.includes(d)) throw new Error(`知らないデータ: ${d}（${DATASETS.join(', ')}）`);
  return o;
}
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 並べて流す（full_audit.cjs の pool と同じ。1 つが落ちても残りは流し、最後に最初の失敗を投げる）
async function pool(items, n, fn) {
  let i = 0, err = null;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (e) { if (!err) err = e; } }
  });
  await Promise.all(workers);
  if (err) throw err;
}

// JSONL を gzip で書く。行数を数え、閉じたら sha256 とバイト数を返す
class JsonlGz {
  constructor(file) {
    this.file = file;
    this.records = 0;
    this.gz = zlib.createGzip({ level: 9 });
    this.out = fs.createWriteStream(file);
    this.done = new Promise((resolve, reject) => { this.out.on('finish', resolve); this.out.on('error', reject); this.gz.on('error', reject); });
    this.gz.pipe(this.out);
  }
  async write(obj) {
    this.records++;
    if (!this.gz.write(JSON.stringify(obj) + '\n')) await new Promise((r) => this.gz.once('drain', r));
  }
  async close() {
    this.gz.end();
    await this.done;
    const buf = fs.readFileSync(this.file);
    return { records: this.records, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }
}

// 条名 → 公開 ID。本則の「第N条（のM…）」だけに付ける（附則・別表・本則の一括は今は付けない。docs/open_data.md 5 章）
function articleIdOf(lawId, entry) {
  if (!entry || entry.type !== 'article') return null;
  if (entry.structure && entry.structure.suppl) return null;
  const nums = titleToNums(entry.title);
  return nums ? `${lawId}_Art${nums.join('_')}` : null;
}
function pageKeyOf(entry) {
  if (!entry) return null;
  if (entry.title === '本則' && !(entry.structure && entry.structure.suppl)) return 'main';
  const nums = titleToNums(entry.title);
  return nums && !(entry.structure && entry.structure.suppl) && entry.type === 'article' ? nums.join('-') : null;
}

function cleanArticle(lawId, entry, articleId, asOf) {
  const { embedding_text, ...rest } = entry;   // ベクトル化用の文（法令名・見出しをつないだもの）は公開しない。本文は full_text と paragraphs にある
  const suppl = !!(entry.structure && entry.structure.suppl);
  const key = pageKeyOf(entry);
  return {
    article_id: articleId,
    law_id: lawId,
    provision: suppl ? 'suppl' : 'main',
    ...rest,
    page_url: key ? PAGE_URL(lawId, key) : null,
    source_url: EGOV_LAW_URL(lawId),
    as_of: asOf,
    method: 'original',
  };
}

// 前の版（--prev）。MANIFEST の形の版・条文の置き場・sha256 が合うときだけ使う。合わなければ null（全部読む）
async function loadPrev(dir) {
  const why = (m) => { log(`前の版は使わない（${m}）。全部読む`); return null; };
  const mf = path.join(dir, 'MANIFEST.json'), lf = path.join(dir, 'laws.jsonl.gz'), af = path.join(dir, 'articles.jsonl.gz');
  if (![mf, lf, af].every((f) => fs.existsSync(f))) return why('ファイルが無い');
  let m; try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { return why('MANIFEST.json が読めない'); }
  if (!isObj(m) || m.format_version !== FORMAT_VERSION || m.partial) return why('形の版が違う・絞った版');
  if (!isObj(m.build) || m.build.articles_prefix !== ARTICLES_PREFIX) return why(`条文の置き場が違う（前 ${(m.build && m.build.articles_prefix) || '記録なし'}・今 ${ARTICLES_PREFIX}）`);
  if (m.build.row_shape !== ROW_SHAPE) return why(`行の形の版が違う（前 ${m.build.row_shape ?? '記録なし'}・今 ${ROW_SHAPE}）`);
  for (const [k, f] of [['laws', lf], ['articles', af]]) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (!isObj(m.files) || !isObj(m.files[k]) || m.files[k].sha256 !== sha) return why(`${k}.jsonl.gz の sha256 が MANIFEST と違う`);
  }
  if (!isObj(m.build.law_digests)) return why('法令ごとのファイルの指紋（build.law_digests）が無い');
  const laws = new Map();
  for (const line of zlib.gunzipSync(fs.readFileSync(lf)).toString('utf8').split('\n')) { if (line) { const o = JSON.parse(line); laws.set(o.law_id, o); } }
  log(`前の版 ${m.release} を使い回しに使う（法令 ${laws.size}）`);
  return { release: m.release, laws, articlesFile: af, digests: m.build.law_digests };
}
// 前の版の articles.jsonl.gz を頭から順に読み、法令 ID の順（書き出しと同じ並び）で 1 法令ずつ取り出す
class PrevArticles {
  constructor(file) {
    const rl = require('readline').createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    this.it = rl[Symbol.asyncIterator]();
    this.buf = null; this.done = false;
  }
  async peek() {
    while (this.buf === null && !this.done) { const r = await this.it.next(); if (r.done) this.done = true; else if (r.value) this.buf = JSON.parse(r.value); }
    return this.buf;
  }
  async take(lawId) {
    const out = [];
    for (let o = await this.peek(); o; o = await this.peek()) {
      if (o.law_id < lawId) { this.buf = null; continue; }   // 今は無い・読み直す法令の行は読み捨てる
      if (o.law_id !== lawId) break;
      out.push(o); this.buf = null;
    }
    return out;
  }
}

const inLedger = (ledger, id) => !!(ledger && isObj(ledger.laws) && ledger.laws[id]);

async function exportLaws({ src, outDir, want, limitLaws, ledger, asOf, files, prev = null }) {
  // 目次のある法令（条文ページと同じ範囲）。台帳の書誌を重ねる
  const keys = await src.list(`${ARTICLES_PREFIX}/`);
  const withIndex = new Set();
  for (const o of keys) {
    const rest = o.key.slice(ARTICLES_PREFIX.length + 1);
    const parts = rest.split('/');
    if (parts.length === 2 && parts[1] === '_index.json') withIndex.add(parts[0]);
  }
  // 法令ごとのファイルの指紋（目次と条文ファイルの名前・ETag・大きさから作る）。一覧はもう取ってあるので R2 を余分に読まない。
  // 前の版と指紋が同じ法令だけ使い回す（台帳の改正 ID が変わらないまま R2 のファイルが書き換わっても読み直す）
  const parts = new Map();
  for (const o of keys) {
    const rest = o.key.slice(ARTICLES_PREFIX.length + 1);
    const i = rest.indexOf('/');
    if (i <= 0) continue;
    const id = rest.slice(0, i);
    if (!parts.has(id)) parts.set(id, []);
    parts.get(id).push(`${rest.slice(i + 1)}|${o.etag || ''}|${o.size}${o.etag ? '' : `|${o.last_modified || ''}`}`);
  }
  const digests = {};
  for (const [id, arr] of parts) digests[id] = crypto.createHash('sha1').update(arr.sort().join('\n')).digest('hex').slice(0, 16);
  // 台帳に無い法令（廃止された法令など）は公開データに入れない。法令の週次は e-Gov で廃止と確かめた法令だけを R2 から消す（2026-11-07 から・確かめられなかった法令は残りうる）ので、目次だけでは現行かどうか分からない（2026-11-07 オーナー: 残しておく利点は無い）
  const all = [...withIndex].sort();
  const notInLedger = all.filter((id) => !inLedger(ledger, id));
  // 台帳が古い・壊れているのに大量に落とさないように、外すのが 100 本かつ 5% を超えたら止める（今は 30 本ほど）
  if (notInLedger.length > Math.max(100, all.length * 0.05)) throw new Error(`目次のある法令 ${all.length} のうち ${notInLedger.length} 本が台帳に無い（100 本かつ 5% 超）。台帳（${CONFIG.ledgerKey}）が古いか壊れていないか確かめる`);
  let lawIds = all.filter((id) => inLedger(ledger, id));
  if (limitLaws) lawIds = lawIds.slice(0, limitLaws);
  log(`目次のある法令 ${withIndex.size}・台帳に無いので外した法令 ${notInLedger.length}${limitLaws ? `（先頭 ${lawIds.length} 本だけ）` : ''}`);
  if (notInLedger.length) log(`台帳に無い法令（廃止など・公開データから外した） ${notInLedger.length}: ${notInLedger.join(' ')}`);

  const lawsW = want.has('laws') ? new JsonlGz(path.join(outDir, 'laws.jsonl.gz')) : null;
  const artsW = want.has('articles') ? new JsonlGz(path.join(outDir, 'articles.jsonl.gz')) : null;
  const titleOf = new Map();          // article_id → 見出し（告示の未収録箇所の一覧に使う）
  const lawTitle = new Map();
  const stats = { duplicateMainTitles: 0, unreadableFiles: 0, missingIndexFiles: 0, brokenIndex: 0, allowedMissing: 0, reusedLaws: 0, readLaws: 0 };
  const prevArts = prev && (want.has('articles') || want.has('kokuji_gaps')) ? new PrevArticles(prev.articlesFile) : null;
  const badFiles = [];

  // 並べて読み、法令の順に書く（版ごとに同じ順になる）
  const results = new Array(lawIds.length);
  let next = 0;
  const flush = async () => {
    while (next < results.length && results[next] !== undefined) {
      const r = results[next]; results[next] = null; next++;
      if (!r) continue;
      if (r.reuse) {
        // 前の版の行を使い回す。台帳から来る項目（改正 ID・施行の状態・改正日・略称・分野）と as_of は今のものにする
        if (lawsW) await lawsW.write(r.law);
        if (prevArts) {
          const rows = await prevArts.take(r.law.law_id);
          if (!rows.length && (r.law.main_article_count || r.law.article_count)) throw new Error(`前の版の articles に ${r.law.law_id} の行が無い（前の版のファイルの並びが違う）。--full で流し直す`);
          for (const a of rows) {
            a.as_of = asOf;
            if (a.article_id) titleOf.set(a.article_id, a.title);
            if (artsW) await artsW.write(a);
          }
        }
        continue;
      }
      if (lawsW) await lawsW.write(r.law);
      if (artsW) for (const a of r.articles) await artsW.write(a);
    }
  };
  let chain = Promise.resolve();
  await pool(lawIds, CONC, async (lawId, k) => {
    const led0 = (ledger.laws || {})[lawId] || {};
    const p = prev && prev.laws.get(lawId);
    // 使い回すのは、ファイルの指紋・改正 ID・施行の状態・改正の施行日が全部前の版と同じ法令だけ（施行日が来て未施行から施行済みに変わった法令・R2 のファイルが書き換わった法令は読み直す）
    const sameAs = (a, b) => (a || null) === (b || null);
    if (p && digests[lawId] && prev.digests[lawId] === digests[lawId] && led0.law_revision_id && p.law_revision_id === led0.law_revision_id && sameAs(p.revision_status, led0.revision_status) && sameAs(p.amendment_enforcement_date, led0.amendment_enforcement_date)) {
      stats.reusedLaws++;
      lawTitle.set(lawId, p.law_title || led0.law_title || '');
      results[k] = { reuse: true, law: { ...p, revision_status: led0.revision_status || p.revision_status || null, amendment_promulgate_date: led0.amendment_promulgate_date || null,
        amendment_enforcement_date: led0.amendment_enforcement_date || null, abbrev: led0.abbrev || null, category: led0.category || null, as_of: asOf } };
      chain = chain.then(flush); await chain; return;
    }
    stats.readLaws++;
    let idx;
    try { idx = await src.getJson(`${ARTICLES_PREFIX}/${lawId}/_index.json`); } catch (e) { idx = undefined; }
    if (!idx || !Array.isArray(idx.files)) {
      // 一覧にあった目次が読めない・無い・形が違う法令は、丸ごと欠けるので公開しない（元から壊れていると分かっているものだけ通す）
      const key = `${lawId}/_index.json`;
      if (ALLOW_MISSING.has(key)) stats.allowedMissing++;
      else { stats.brokenIndex++; badFiles.push(`${key}（${idx === undefined ? '読めない' : '無い・形が違う'}）`); }
      results[k] = null; chain = chain.then(flush); await chain; return;
    }
    const led = (ledger.laws || {})[lawId] || {};
    const title = idx.law_title || led.law_title || '';
    lawTitle.set(lawId, title);
    const articles = [];
    const seen = new Set();
    // 条文ファイルは laws だけのときも読む（本則の条の数と、未収録箇所の見出しに使う）
    for (const f of idx.files) {
      if (!f || typeof f.filename !== 'string') continue;
      let data;
      try { data = await src.getJson(`${ARTICLES_PREFIX}/${lawId}/${f.filename}`); } catch (e) { data = undefined; }
      if (!data || !Array.isArray(data.articles)) {
        const k = `${lawId}/${f.filename}`;
        if (ALLOW_MISSING.has(k)) { stats.allowedMissing++; continue; }
        stats[data === undefined ? 'unreadableFiles' : 'missingIndexFiles']++;
        badFiles.push(`${k}（${data === undefined ? '読めない' : '無い・形が違う'}）`);
        continue;
      }
      for (const entry of data.articles) {
        let id = articleIdOf(lawId, entry);
        if (id && seen.has(id)) { stats.duplicateMainTitles++; id = null; }   // 本則に同じ見出しが 2 つ（まれ）。ID は最初の 1 つだけに付ける
        if (id) { seen.add(id); titleOf.set(id, entry.title); }
        if (artsW) articles.push(cleanArticle(lawId, entry, id, asOf));
      }
    }
    const law = {
      law_id: lawId,
      law_title: title,
      law_num: idx.law_num || led.law_num || null,
      law_type: idx.law_type || led.law_type || null,
      law_revision_id: led.law_revision_id || (idx._source && idx._source.law_revision_id) || null,
      revision_status: led.revision_status || (idx._source && idx._source.revision_status) || null,
      amendment_promulgate_date: led.amendment_promulgate_date || null,
      amendment_enforcement_date: led.amendment_enforcement_date || null,
      abbrev: led.abbrev || null,
      category: led.category || null,
      article_count: idx.article_count != null ? idx.article_count : null,
      main_article_count: seen.size,
      toc: idx.toc || null,
      page_url: `https://joubun-kun.com/law/${lawId}`,
      source_url: EGOV_LAW_URL(lawId),
      as_of: asOf,
      method: 'original',
    };
    results[k] = { law, articles };
    chain = chain.then(flush);
    await chain;
  });
  await chain.then(flush);
  if (lawsW) files.laws = await lawsW.close();
  if (artsW) files.articles = await artsW.close();
  log(`法令 ${files.laws ? files.laws.records : '-'}・条 ${files.articles ? files.articles.records : '-'}（R2 から読んだ法令 ${stats.readLaws}・前の版から使い回した法令 ${stats.reusedLaws}・本則に同じ見出し ${stats.duplicateMainTitles}・壊れた目次 ${stats.brokenIndex}・読めないファイル ${stats.unreadableFiles}・形が違うファイル ${stats.missingIndexFiles}・通すと決めた欠け ${stats.allowedMissing}）`);
  // 目次に載った条文ファイルの欠けは、通信の不調でも元からの壊れでも、そのまま公開しない（欠けた条へ参照が残る）
  if (badFiles.length) throw new Error(`目次か目次に載った条文ファイルが ${badFiles.length} 件読めない・無い: ${badFiles.slice(0, 10).join('、')}${badFiles.length > 10 ? ' …' : ''}。元から壊れていると分かっているものは OPEN_DATA_ALLOW_MISSING に書く`);
  // 外した法令の ID は MANIFEST にも出す（e-Gov の法令 API で廃止かどうかを確かめられる。法令 ID は公開の情報）
  stats.notInLedger = notInLedger;
  return { lawIds: new Set(lawIds), titleOf, lawTitle, stats, digests };
}

async function exportRefs({ src, outDir, keep, current, asOf, files }) {
  const idx = await src.getJson(`${REFS_PREFIX}/refs_index.json`);
  if (!isObj(idx)) throw new Error(`${REFS_PREFIX}/refs_index.json が無い・形が違う`);
  const w = new JsonlGz(path.join(outDir, 'refs.jsonl.gz'));
  let skippedShape = 0, toNotCurrent = 0;
  for (const n of [...new Set(Object.values(idx))].sort((a, b) => a - b)) {
    const ch = await src.getJson(`${REFS_PREFIX}/refs_chunk_${pad3(n)}.json`);
    if (!ch) throw new Error(`refs_chunk_${pad3(n)}.json が無い（refs_index.json には載っている）`);
    for (const lawId of Object.keys(ch).sort()) {
      if (!keep(lawId)) continue;
      const law = ch[lawId];
      for (const [from, arr] of Object.entries((law && law.refs) || {})) {
        if (!Array.isArray(arr)) { skippedShape++; continue; }
        const fromIsArticle = /^.+_Art\d+(?:_\d+)*$/.test(from);
        for (const r of arr) {
          if (!isObj(r)) { skippedShape++; continue; }
          const toLaw = r.target_law_id || (r.type === 'internal' ? lawId : null);
          if (toLaw && !current(toLaw)) toNotCurrent++;   // 行き先が台帳に無い法令（廃止された法令など）。行は残して数だけ出す
          await w.write({
            from,
            from_article_id: fromIsArticle ? from : null,
            from_law_id: lawId,
            to_law_id: toLaw,
            to_article_id: toLaw && r.target_article ? `${toLaw}_Art${r.target_article}` : null,
            ...r,
            as_of: asOf,
            method: 'rule',
          });
        }
      }
    }
  }
  files.refs = await w.close();
  log(`参照 ${files.refs.records}（形が違って飛ばした ${skippedShape}・行き先が台帳に無い法令 ${toNotCurrent}）`);
  return { refs_to_not_in_ledger: toNotCurrent };
}

async function exportDelegations({ src, outDir, want, keep, titleOf, lawTitle, asOf, files }) {
  const idx = await src.getJson(`${DELEG_PREFIX}/index.json`);
  if (!isObj(idx)) throw new Error(`${DELEG_PREFIX}/index.json が無い・形が違う`);
  const dw = want.has('delegations') ? new JsonlGz(path.join(outDir, 'delegations.jsonl.gz')) : null;
  const kw = want.has('kokuji_gaps') ? new JsonlGz(path.join(outDir, 'kokuji_gaps.jsonl.gz')) : null;
  const gapSeen = new Set();
  let skippedShape = 0;
  for (const n of [...new Set(Object.values(idx))].sort((a, b) => a - b)) {
    const ch = await src.getJson(`${DELEG_PREFIX}/chunk_${pad3(n)}.json`);
    if (!ch) throw new Error(`chunk_${pad3(n)}.json が無い（index.json には載っている）`);
    for (const lawId of Object.keys(ch).sort()) {
      if (!keep(lawId)) continue;
      const law = ch[lawId];
      for (const [art, list] of Object.entries((law && law.articles) || {})) {
        if (!Array.isArray(list)) { skippedShape++; continue; }
        const fromId = `${lawId}_Art${art}`;
        for (const d of list) {
          if (!isObj(d)) { skippedShape++; continue; }
          const candidates = Array.isArray(d.candidates) ? d.candidates.map((c) => (isObj(c) ? { ...c, article_id: c.law_id && c.article ? `${c.law_id}_Art${c.article}` : null } : c)) : d.candidates;
          if (dw) await dw.write({ from_article_id: fromId, law_id: lawId, ...d, candidates, as_of: asOf, method: 'rule' });
          if (kw && d.status === 'kokuji') {
            // 未収録箇所の ID: 委任元の条・項・号・文言から作る（版をまたいで同じ委任には同じ ID。同じものが 2 つあれば #2…）
            const base = 'kg_' + crypto.createHash('sha1').update([fromId, d.paragraph, d.item, d.expr, d.trailing].map((x) => (x == null ? '' : String(x))).join('|')).digest('hex').slice(0, 12);
            let id = base, k = 2;
            while (gapSeen.has(id)) id = `${base}_${k++}`;
            gapSeen.add(id);
            const nums = art.split('_');
            await kw.write({
              gap_id: id,
              law_id: lawId,
              law_title: (law && law.law_title) || lawTitle.get(lawId) || '',
              from_article_id: fromId,
              article_title: titleOf.get(fromId) || null,
              paragraph: d.paragraph != null ? d.paragraph : null,
              item: d.item != null ? d.item : null,
              expr: d.expr || '',
              trailing: d.trailing || '',
              kind: d.kind || null,
              page_url: /^\d+(?:_\d+)*$/.test(art) ? PAGE_URL(lawId, nums.join('-')) : null,
              as_of: asOf,
              method: 'rule',
            });
          }
        }
      }
    }
  }
  if (dw) files.delegations = await dw.close();
  if (kw) files.kokuji_gaps = await kw.close();
  log(`委任 ${files.delegations ? files.delegations.records : '-'}・告示の未収録箇所 ${files.kokuji_gaps ? files.kokuji_gaps.records : '-'}（形が違って飛ばした ${skippedShape}）`);
}

// 条 → 通達・質疑応答事例・裁決・判例の紐付け（条文ページ・条 1 つの JSON と同じ置き場を読む）。1 行が「条 → 資料 1 件」。
// 本文（通達の本文・判決の要旨など）は入れない: 資料の ID・題名・日付・原文の URL と、どう付けたか（method）だけ。
// 条のキーは「70の6の2」の形（条文ページの numsToJou）→ article_id は {法令ID}_Art70_6_2。形の違うキーは飛ばして数える
const JOU_RE = /^\d+(?:の\d+)*$/;
const okUrl = (u, re) => (typeof u === 'string' && re.test(u) ? u : null);
const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);
function tsutatsuTitle(t) {
  const no = str(t.no), head = str(t.title) || str(t.cap);
  if (!no) return head;
  if (!head) return no;
  return /^[（(]/.test(head) ? `${no}${head}` : `${no} ${head}`;
}
// 並べて読み、ids の順に書く（exportLaws と同じ形。読む順がばらばらでも、版ごとに同じ並びになる）。read が投げたら、残りを読み終えてから最初の失敗を投げる
async function orderedEach(ids, n, read, write) {
  const res = new Array(ids.length);
  let next = 0, chain = Promise.resolve();
  const flush = async () => { while (next < res.length && res[next] !== undefined) { const r = res[next]; res[next] = null; next++; await write(r); } };
  await pool(ids, n, async (id, k) => { res[k] = await read(id); chain = chain.then(flush); await chain; });
  await chain.then(flush);
}
async function exportLinks({ src, outDir, keep, asOf, files }) {
  const w = new JsonlGz(path.join(outDir, 'links.jsonl.gz'));
  const stats = { tsutatsu: 0, shitsugi: 0, saiketsu: 0, hanrei: 0, badKey: 0, badShape: 0 };
  const base = (lawId, jou, kind) => { const nums = jou.split('の'); return { article_id: `${lawId}_Art${nums.join('_')}`, law_id: lawId, kind, page_url: PAGE_URL(lawId, nums.join('-')) }; };
  const lawsOf = async (prefix) => {
    const out = new Set();
    for (const o of await src.list(`${prefix}/`)) { const m = o.key.slice(prefix.length + 1).match(/^([0-9A-Za-z]+)\.json$/); if (m) out.add(m[1]); }
    return [...out].filter(keep).sort();
  };
  const writeRows = async (rows) => { for (const r of rows) await w.write(r); };
  // 通達（tsutatsu_chunks_v4/{法令ID}.json の { 条: [ref] }）。目次（index.json）が無いのは壊れているので止める
  log('紐付け: 通達を読む');
  const tidx = await src.getJson(`${TSU_PREFIX}/index.json`);
  if (!tidx || !isObj(tidx.laws)) throw new Error(`${TSU_PREFIX}/index.json が無い・形が違う`);
  await orderedEach(Object.keys(tidx.laws).filter(keep).sort(), CONC, async (lawId) => {
    const law = await src.getJson(`${TSU_PREFIX}/${lawId}.json`);
    if (!isObj(law)) throw new Error(`${TSU_PREFIX}/${lawId}.json が無い・形が違う（index.json には載っている）`);
    const rows = [];
    for (const jou of Object.keys(law)) {
      if (!JOU_RE.test(jou)) { stats.badKey++; continue; }
      for (const t of Array.isArray(law[jou]) ? law[jou] : []) {
        if (!isObj(t)) { stats.badShape++; continue; }
        rows.push({ ...base(lawId, jou, 'tsutatsu'), source_id: str(t.id), title: tsutatsuTitle(t), number: str(t.no), group: str(t.grp), format: str(t.src), abolished: !!t.ab, date: null,
          url: okUrl(t.url, /^https:\/\/www\.nta\.go\.jp\//), source: '国税庁', as_of: asOf, method: null });
        stats.tsutatsu++;
      }
    }
    return rows;
  }, writeRows);
  // 質疑応答事例・裁決（article_links_v1/{法令ID}.json の { 条: [{ i, k: j|s, s: 付け方, c: 確からしさ }] } と _cases.json の { i: { t, u, d } }）
  log(`紐付け: 通達 ${stats.tsutatsu}・質疑応答事例と裁決を読む`);
  const cases = await src.getJson(`${CASES_PREFIX}/_cases.json`);
  if (!isObj(cases)) throw new Error(`${CASES_PREFIX}/_cases.json が無い・形が違う`);
  await orderedEach(await lawsOf(CASES_PREFIX), CONC, async (lawId) => {
    const law = await src.getJson(`${CASES_PREFIX}/${lawId}.json`);
    if (!isObj(law)) throw new Error(`${CASES_PREFIX}/${lawId}.json が読めない・形が違う（一覧には載っている）`);
    const rows = [];
    for (const jou of Object.keys(law)) {
      if (!JOU_RE.test(jou)) { stats.badKey++; continue; }
      for (const h of Array.isArray(law[jou]) ? law[jou] : []) {
        const c = isObj(h) && isObj(cases[h.i]) ? cases[h.i] : null;
        if (!c || !['j', 's'].includes(h.k)) { stats.badShape++; continue; }
        const kind = h.k === 'j' ? 'shitsugi' : 'saiketsu';
        rows.push({ ...base(lawId, jou, kind), source_id: String(h.i), title: str(c.t), date: str(c.d),
          url: okUrl(c.u, /^https:\/\/www\.(nta|kfs)\.go\.jp\//), source: kind === 'shitsugi' ? '国税庁' : '国税不服審判所',
          as_of: asOf, method: h.s === 'llm' ? 'llm' : 'rule', confidence: Number.isFinite(Number(h.c)) ? Number(h.c) : null });
        stats[kind]++;
      }
    }
    return rows;
  }, writeRows);
  // 判例（hanrei_v2/links/{法令ID}.json の { 条: { total, items（上位 300 件） } }。300 件を超える条は 301 件目からの続きが links_more/{法令ID}/{条}.json）。
  // 条の系譜で今の条に付け直したもの: 判決文での引き方（via）・判決の後の改正などの注記（notes）・AI が付けた理由（judge）をそのまま添える
  log(`紐付け: 質疑応答事例 ${stats.shitsugi}・裁決 ${stats.saiketsu}・判例を読む`);
  await orderedEach(await lawsOf(HANREI_LINKS_PREFIX), CONC, async (lawId) => {
    const law = await src.getJson(`${HANREI_LINKS_PREFIX}/${lawId}.json`);
    if (!isObj(law)) throw new Error(`${HANREI_LINKS_PREFIX}/${lawId}.json が読めない・形が違う（一覧には載っている）`);
    const rows = [];
    for (const jou of Object.keys(law)) {
      if (!JOU_RE.test(jou)) { stats.badKey++; continue; }
      const e = law[jou];
      if (!isObj(e) || !Array.isArray(e.items)) { stats.badShape++; continue; }
      let items = e.items;
      // 300 件を超える条は 301 件目からの続きが links_more にある（scripts/lineage/lib/links_more.cjs）。上位と続きを合わせて全部にする。
      // 続きが無い・形が違う・合わせても total に届かないときは、黙って一部だけを出さずに止める（GPT レビュー #418）
      if (Number(e.total) > items.length) {
        const mk = `${HANREI_LINKS_PREFIX}_more/${lawId}/${jou.replace(/の/g, '_')}.json`;
        const more = await src.getJson(mk);
        if (!isObj(more) || !Array.isArray(more.items)) throw new Error(`${mk} が無い・形が違う（${HANREI_LINKS_PREFIX}/${lawId}.json の ${jou} は total ${e.total} 件・上位 ${items.length} 件）`);
        const seen = new Set();
        items = [...items, ...more.items].filter((h) => { const k = isObj(h) && h.id ? String(h.id) : null; if (!k || seen.has(k)) return !k; seen.add(k); return true; });
        if (seen.size < Number(e.total)) throw new Error(`${HANREI_LINKS_PREFIX}/${lawId}.json の ${jou}: 上位と続きを合わせて ${seen.size} 件で total ${e.total} 件に届かない`);
      }
      for (const h of items) {
        if (!isObj(h) || !h.id) { stats.badShape++; continue; }
        const j = isObj(h.judge) ? h.judge : null;
        rows.push({ ...base(lawId, jou, 'hanrei'), source_id: String(h.id), title: str(h.title), court: str(h.court), date: str(h.dateJp), case_number: str(h.caseNo), result: str(h.kekka),
          url: okUrl(h.url, /^https:\/\/www\.courts\.go\.jp\//), source: '裁判所', cited_as: isObj(h.via) ? h.via : null, notes: Array.isArray(h.notes) ? h.notes : [],
          as_of: asOf, method: j && (j.by === 'opus' || j.by === 'nonum') ? 'llm' : 'rule', ai_reason: j && typeof j.reason === 'string' ? j.reason : null });
        stats.hanrei++;
      }
    }
    return rows;
  }, writeRows);
  files.links = await w.close();
  log(`紐付け ${files.links.records}（通達 ${stats.tsutatsu}・質疑応答事例 ${stats.shitsugi}・裁決 ${stats.saiketsu}・判例 ${stats.hanrei}・形の違うキー ${stats.badKey}・形が違って飛ばした ${stats.badShape}）`);
  return stats;
}

// 前の版より 5% 超減ったデータ（版の切り替え以外で減るのは壊れている疑い）
function shrinkCheck(prev, files) {
  const bad = [];
  if (!prev || !prev.files) return bad;
  for (const [name, f] of Object.entries(files)) {
    const p = prev.files[name];
    if (!p || !p.records) continue;
    if (f.records < p.records * (1 - SHRINK_LIMIT)) bad.push(`${name}: ${p.records} → ${f.records}`);
  }
  return bad;
}

// 公開用のバケットに書けるか（鍵の権限）だけを確かめる。書くのは _write_check/{時刻}.txt（数十バイト）で、読み直してすぐ消す
async function writeCheck() {
  const destBucket = process.env.OPEN_DATA_BUCKET || 'joubun-kun-open';
  if (!process.env.OPEN_DATA_FAKE_DIR && destBucket === CONFIG.bucket) throw new Error(`書く先（${destBucket}）が本番のバケットと同じ。本番には書かない`);
  const dest = new R2({ bucket: destBucket, fakeDir: process.env.OPEN_DATA_FAKE_DIR || null, dryRun: false, token: process.env.OPEN_DATA_API_TOKEN || undefined });
  const key = `_write_check/${new Date().toISOString().replace(/[-:.]/g, '')}.txt`;
  const body = `joubun-kun open data write check ${new Date().toISOString()}\n`;
  await dest.put(key, body, 'text/plain; charset=utf-8');
  const buf = await dest.get(key);
  const back = buf ? buf.toString('utf8') : null;
  await dest.delete(key);
  if (back !== body) throw new Error(`書いたものと読み直したものが違う（${destBucket}/${key}）`);
  log(`書ける: ${destBucket} に書いて読み直し、消した（${key}・鍵は ${process.env.OPEN_DATA_API_TOKEN ? 'OPEN_DATA_API_TOKEN' : '読む側と同じトークン'}）`);
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.writeCheck) return writeCheck();
  const release = opt.release || jstToday();
  const want = new Set(opt.only || DATASETS);
  const outDir = path.join(path.resolve(opt.out), 'releases', release);
  fs.mkdirSync(outDir, { recursive: true });

  const src = new R2({ dryRun: true });   // 本番は読むだけ（dryRun で put/delete を物理的に止める）
  const destBucket = process.env.OPEN_DATA_BUCKET || 'joubun-kun-open';
  if (opt.upload && !process.env.OPEN_DATA_FAKE_DIR && destBucket === CONFIG.bucket) throw new Error(`書く先（${destBucket}）が本番のバケットと同じ。本番には書かない`);

  // 書き出すデータ（法令・条・参照関係・委任先）の週次が反映の途中なら書き出さない（途中の状態の版を作らない・2026-11-05 から毎週流すので）。
  // 始める前の世代を覚えておき、書き終わったら比べる
  const gen0 = await sourceGeneration(src);
  if (process.env.R2_FAKE_DIR && process.env.OPEN_DATA_TEST_TOUCH) fs.appendFileSync(path.join(process.env.R2_FAKE_DIR, process.env.OPEN_DATA_TEST_TOUCH), ' ');   // 確かめ用（作り物の R2 のときだけ）: 書き出しの途中で反映があったことにする
  const ledger = await src.getJson(CONFIG.ledgerKey);
  if (!ledger || !isObj(ledger.laws)) throw new Error(`${CONFIG.ledgerKey} が無い・壊れている`);
  const asOf = String(ledger.fetched_at || '').slice(0, 10) || null;
  log(`版 ${release}・法令の時点 ${asOf}・作るもの ${[...want].join(', ')}`);

  const files = {};
  const needArticles = want.has('laws') || want.has('articles') || want.has('kokuji_gaps');
  let ctx = { lawIds: new Set(), titleOf: new Map(), lawTitle: new Map(), stats: {}, digests: null };
  const prev = opt.prev && !opt.full && !opt.limitLaws ? await loadPrev(opt.prev) : null;
  if (opt.full) log('--full: 前の版を使わずに全部読む');
  if (needArticles) ctx = await exportLaws({ src, outDir, want, limitLaws: opt.limitLaws, ledger, asOf, files, prev });
  const limited = !!opt.limitLaws;
  // 参照・委任・紐付けも、公開する法令（台帳にある法令。--limit-laws なら書き出した法令）の分だけ
  const keep = limited ? (id) => ctx.lawIds.has(id) : (id) => inLedger(ledger, id);
  const refStats = want.has('refs') ? await exportRefs({ src, outDir, keep, current: (id) => inLedger(ledger, id), asOf, files }) : null;
  if (want.has('delegations') || want.has('kokuji_gaps')) await exportDelegations({ src, outDir, want, keep, titleOf: ctx.titleOf, lawTitle: ctx.lawTitle, asOf, files });
  const linkStats = want.has('links') ? await exportLinks({ src, outDir, keep, asOf, files }) : null;

  const manifest = {
    format_version: FORMAT_VERSION,
    release,
    generated_at: new Date().toISOString(),
    license: LICENSE,
    attribution: ATTRIBUTION,
    sources: {
      laws: { name: 'e-Gov法令検索（デジタル庁）', url: 'https://laws.e-gov.go.jp/', fetched_at: ledger.fetched_at || null, method: 'e-Gov 法令 API v2' },
      ...(want.has('links') ? {
        tsutatsu: { name: '国税庁（通達）', url: 'https://www.nta.go.jp/law/tsutatsu/' },
        shitsugi: { name: '国税庁（質疑応答事例）', url: 'https://www.nta.go.jp/law/shitsugi/' },
        saiketsu: { name: '国税不服審判所（公表裁決事例）', url: 'https://www.kfs.go.jp/' },
        hanrei: { name: '裁判所（裁判例検索）', url: 'https://www.courts.go.jp/' },
        lineage: { name: '名古屋大学「法令XMLデータ」（佐野智也・外山勝彦・増田知子、CC BY 4.0）', url: 'https://doi.org/10.18999/2014084', note: '判例の今の条への付け直しに使った改正の経過' },
      } : {}),
    },
    datasets: {
      laws: '法令 1 本 1 行（台帳の書誌＋目次）',
      articles: '条 1 件 1 行（条文ファイルの articles[] を 1 件ずつ。本則の条にだけ article_id）',
      refs: '参照 1 件 1 行（from → to_article_id。条文から決まったルールで抽出）',
      delegations: '委任 1 件 1 行（「政令で定める」等の受け皿。status: confirmed / multiple / weak / none / law_level / kokuji）',
      kokuji_gaps: '告示への委任で、受け皿の告示が条文くんにまだ入っていない箇所の一覧（告示の未収録箇所）',
      links: '条 → 通達・質疑応答事例・裁決・判例の紐付け 1 件 1 行（kind・資料の ID・題名・日付・原文の URL・method。本文は入れない。method: rule＝決まったルール（条文の引用の読み取りなど）・llm＝AI が付けた・null＝行ごとの区別が無い（通達は一部を AI が付けている）。判例は条の系譜で今の条に付け直した結果で、cited_as に判決文での引き方、notes に判決の後の改正などの注記）',
    },
    notes: { ...ctx.stats, ...(refStats || {}), ...(linkStats ? { links: linkStats } : {}) },
    // 次の版が使い回すかを決める印（条文の置き場が変わったら使い回さない）
    build: { articles_prefix: ARTICLES_PREFIX, row_shape: ROW_SHAPE, prev_release: prev ? prev.release : null, full: !prev, law_digests: ctx.digests },
    files,
    partial: limited || !!opt.only,
  };
  // 書き出しの間に反映があったら（世代が変わった・反映中の印が出た）版にしない。MANIFEST を書かないので、上げる側（release_hf.py）もこの版を拾わない
  if ((await sourceGeneration(src)) !== gen0) throw new Error('書き出しの間に元のデータが変わった（週次の反映があった）。この版は作らない。流し直す');
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  log(`手元に書いた: ${outDir}`);

  if (!opt.upload) return;
  if (manifest.partial) throw new Error('--only で絞った版は公開用のバケットに書かない');
  // 公開用のバケットの鍵は別に渡せる（OPEN_DATA_API_TOKEN。無ければ読む側と同じトークン。トークンに joubun-kun-open への書き込みの権限が要る）
  const dest = new R2({ bucket: destBucket, fakeDir: process.env.OPEN_DATA_FAKE_DIR || null, dryRun: false, token: process.env.OPEN_DATA_API_TOKEN || undefined });
  // バケット全体の印（違う版名で同時に流しても、書いている途中の版を消したり latest を取り合ったりしない）
  const LOCK = '_export_lock.json';
  if (opt.breakLock) { await dest.delete(LOCK); log('バケット全体の印を外した（--break-lock）'); }
  if (!(await dest.putIfAbsent(LOCK, JSON.stringify({ release, started_at: new Date().toISOString() })))) {
    let held = ''; try { const l = await dest.getJson(LOCK); held = l ? `（${l.release}・${l.started_at} から）` : ''; } catch { /* 印の中身は読めなくてもよい */ }
    throw new Error(`ほかの書き出しが公開用のバケットに書いている${held}。動いていないと確かめたら --break-lock で外して流し直す`);
  }
  try {
    await publish(dest, opt, release, outDir, files, manifest);
  } finally {
    await dest.delete(LOCK);
  }
}

async function publish(dest, opt, release, outDir, files, manifest) {
  // 前の版。latest.json が無いときだけ初回として扱う（読めない・壊れている・前の版の MANIFEST が無いときは止める）
  const latestBuf = await dest.get('latest.json');   // 無ければ null。通信の失敗は再試行の後に投げる
  let latest = null, prev = null;
  if (latestBuf) {
    try { latest = JSON.parse(latestBuf.toString('utf8')); } catch { throw new Error('latest.json が壊れている（JSON でない）'); }
    if (!latest || !RELEASE_RE.test(String(latest.release || ''))) throw new Error('latest.json に版の名前（release）が無い');
    prev = await dest.getJson(`releases/${latest.release}/MANIFEST.json`);
    if (!prev || !prev.files) throw new Error(`latest.json が指す版（${latest.release}）の MANIFEST が無い・壊れている`);
    if (!(compareRelease(release, latest.release) > 0)) throw new Error(`版の名前（${release}）は今の版（${latest.release}）より新しくする（公開済みの版は上書きしない。同じ日なら --release ${latest.release}.2 のように）`);
  }
  const shrunk = shrinkCheck(prev, files);
  if (shrunk.length && !opt.forceShrink) throw new Error(`前の版（${latest.release}）より 5% 超減った: ${shrunk.join('・')}。正しく減ったなら --force-shrink で流す`);

  // この版名を押さえる（途中で落ちた版名には書かない）
  const lockKey = `releases/${release}/_writing.json`;
  const got = await dest.putIfAbsent(lockKey, JSON.stringify({ started_at: new Date().toISOString() }));
  if (!got) throw new Error(`版 ${release} は途中で落ちた書き出しが使った（${lockKey} がある）。別の版名で流す（--release ${release}.2 など）`);
  for (const name of Object.keys(files)) {
    const file = `${name}.jsonl.gz`;
    await dest.put(`releases/${release}/${file}`, fs.readFileSync(path.join(outDir, file)), 'application/gzip');
    log(`書いた releases/${release}/${file}（${files[name].records} 件）`);
  }
  await dest.put(`releases/${release}/MANIFEST.json`, JSON.stringify(manifest, null, 2));
  await dest.put('latest.json', JSON.stringify({ release, format_version: FORMAT_VERSION, manifest: `releases/${release}/MANIFEST.json` }, null, 2));
  await dest.delete(lockKey);
  log(`latest.json → ${release}`);

  // 古い版を消す。書き終わった版を新しい順に KEEP 個（今の版＝latest を含む）。途中で落ちた版（_writing が残った版）は今回より古ければ消す
  // （バケット全体の印を持っているので、ほかに書いている途中の版は無い）
  const all = await dest.list('releases/');
  const byVer = new Map();
  for (const o of all) { const v = o.key.split('/')[1]; if (RELEASE_RE.test(v)) { if (!byVer.has(v)) byVer.set(v, []); byVer.get(v).push(o.key); } }
  const done = (v) => byVer.get(v).includes(`releases/${v}/MANIFEST.json`) && !byVer.get(v).includes(`releases/${v}/_writing.json`);
  const complete = [...byVer.keys()].filter(done).sort(compareRelease).reverse();
  const keep = new Set([release, ...complete.slice(0, KEEP)]);
  const drop = [...complete.filter((v) => !keep.has(v)), ...[...byVer.keys()].filter((v) => !done(v) && compareRelease(v, release) < 0)];
  for (const v of drop) {
    for (const k of byVer.get(v)) await dest.delete(k);
    log(`古い版を消した: ${v}${done(v) ? '' : '（途中で落ちた版）'}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[open-data] 失敗:', e && e.message ? e.message : e); process.exit(1); });
}
module.exports = { articleIdOf, pageKeyOf, shrinkCheck, parseArgs, RELEASE_RE, compareRelease };
