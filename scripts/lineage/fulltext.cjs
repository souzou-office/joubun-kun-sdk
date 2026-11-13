// 判決文の全文（裁判所の PDF から取り直したもの）を確かめて R2 に置く（¥0・LLM なし）。docs/lineage.md「判決文の全文」
//
//   node scripts/lineage/fulltext.cjs targets   取り直す判例の一覧（R2 の本文＝sections の合計が PDF の文字数 rec.pdf.chars の 8 割未満）を
//                                               $LINEAGE_DATA/state/inventory.ndjson に書く（引用のある判例を先に）。01_crawl.cjs --mode pdf がこれを読む
//   node scripts/lineage/fulltext.cjs check     取り直した全文（$LINEAGE_DATA/hanrei_raw/pdftext/{id}.json）の文字数・ページ数を R2 の記録（rec.pdf）と比べる
//   node scripts/lineage/fulltext.cjs upload [--dry]   全文を R2 hanrei_v2/fulltext/{id}.json に書く（中身が同じものは書かない・既にあるキーは退避してから）
//
// 取り方（PC で夜に流す。取得 約 5 時間・抽出は 8 本並べて約 40 分）:
//   HANREI_DATA_ROOT=$LINEAGE_DATA node scripts/hanrei/01_crawl.cjs --mode pdf --resume       # 1 秒に 1 件より遅く。台帳 $LINEAGE_DATA/state/crawl_ledger.json
//   HANREI_DATA_ROOT=$LINEAGE_DATA python -X utf8 scripts/hanrei/02_extract_pdf_text.py --shard i/8   # i = 0..7 を並べて
// 取った PDF と全文は $LINEAGE_DATA/hanrei_raw/（pdf/・pdftext/）に残す（最初に作った PC の hanrei_raw は失われた。二度と失わない）。
// 全文は検索のベクトル用の 4,000 字の区切り（hanrei_v1/cases の sections）とは別の置き場に持つ。区切りとベクトルは変えない。
// ログには件数と ID だけを出す。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..', '..');
const DATA = process.env.LINEAGE_DATA || path.join(REPO, 'lineage_data');
const args = process.argv.slice(2);
const mode = args[0] || 'check';
const flag = (n) => args.includes(n);
const CASES = path.join(DATA, 'hanrei_cases');
const PDFTEXT = path.join(DATA, 'hanrei_raw', 'pdftext');
const STATE = path.join(DATA, 'state');
const PREFIX = 'hanrei_v2/fulltext';
const RATIO = 0.8;

const arr = (v) => (Array.isArray(v) ? v : []);
const sectionChars = (r) => arr(r.sections).reduce((a, s) => a + ((s && s.text) || '').length, 0);

function* cases() {
  for (const f of fs.readdirSync(CASES).filter((x) => /^cases_\d{4}\.json$/.test(x)).sort()) {
    for (const r of Object.values(JSON.parse(fs.readFileSync(path.join(CASES, f), 'utf8')))) if (r && r.id) yield r;
  }
}
const truncated = (r) => r.pdf && r.pdf.chars > 0 && sectionChars(r) < RATIO * r.pdf.chars;

function targets() {
  const cited = [], uncited = [];
  let pages = 0;
  for (const r of cases()) if (truncated(r)) { (arr(r.lawRefs).length ? cited : uncited).push(String(r.id)); pages += r.pdf.pages || 0; }
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'inventory.ndjson'), [...cited, ...uncited].map((id) => JSON.stringify({ id })).join('\n') + '\n');
  fs.writeFileSync(path.join(STATE, 'refetch_targets.json'), JSON.stringify({ built: new Date().toISOString(), rule: `sections の合計 < ${RATIO} × pdf.chars`, cited, uncited }));
  console.log(`取り直す判例 ${cited.length + uncited.length}（引用あり ${cited.length}）・${pages} ページ（1 件平均 ${((pages) / Math.max(1, cited.length + uncited.length)).toFixed(1)}）`);
}

function readFull(id) {
  const f = path.join(PDFTEXT, `${id}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { broken: true }; }
}

function check() {
  const want = new Set(fs.existsSync(path.join(STATE, 'refetch_targets.json')) ? (() => { const t = JSON.parse(fs.readFileSync(path.join(STATE, 'refetch_targets.json'), 'utf8')); return [...t.cited, ...t.uncited]; })() : []);
  const c = { targets: want.size, have: 0, missing: 0, broken: 0, notFound: 0, same: 0, diff: 0 };
  const diffs = [];
  for (const r of cases()) {
    if (!want.has(String(r.id))) continue;
    const j = readFull(r.id);
    if (!j) { c.missing++; continue; }
    if (j.broken) { c.broken++; continue; }
    if (j.found === false) { c.notFound++; continue; }
    c.have++;
    if (j.chars === r.pdf.chars && j.pages === r.pdf.pages) c.same++;
    else { c.diff++; if (diffs.length < 20) diffs.push({ id: r.id, r2: r.pdf, now: { pages: j.pages, chars: j.chars } }); }
  }
  console.log(JSON.stringify({ ...c, diffs }, null, 1));
  return c;
}

async function upload() {
  const { R2 } = require('../update/lib/r2.cjs');
  const r2 = new R2();
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const ledger = fs.existsSync(path.join(STATE, 'crawl_ledger.json')) ? JSON.parse(fs.readFileSync(path.join(STATE, 'crawl_ledger.json'), 'utf8')) : {};
  // R2 の判例（hanrei_v1/cases の写し）にある判例の全文だけ（取り込まなかった判例の全文は置かない）
  const known = new Set();
  for (const r of cases()) known.add(String(r.id));
  const ids = fs.readdirSync(PDFTEXT).filter((f) => /^\d{1,7}\.json$/.test(f)).map((f) => f.slice(0, -5)).filter((id) => known.has(id));
  const existing = new Set((await r2.list(`${PREFIX}/`)).map((o) => o.key));
  const items = [];
  for (const id of ids) {
    const j = readFull(id);
    if (!j || j.broken || j.found === false || !j.text) continue;
    const led = ledger[`https://www.courts.go.jp/assets/hanrei/hanrei-pdf-${id}.pdf`] || {};
    const body = Buffer.from(JSON.stringify({ id, pages: j.pages, chars: j.chars, text: j.text,
      source: `https://www.courts.go.jp/assets/hanrei/hanrei-pdf-${id}.pdf`, pdf_sha256: led.content_hash || null, fetched_at: led.fetched_at || null }));
    items.push({ key: `${PREFIX}/${id}.json`, body });
  }
  let todo = items;
  if (existing.size) {
    todo = [];
    await R2.pmap(items, 8, async (x) => { if (!existing.has(x.key)) { todo.push(x); return; } const b = await r2.get(x.key); if (!b || sha(b) !== sha(x.body)) todo.push(x); });
  }
  const rid = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backup = `update_state/hanrei_v2_backup/fulltext-${rid}`;
  const over = todo.filter((x) => existing.has(x.key)).map((x) => x.key);
  console.log(`全文 ${items.length} 件・書く ${todo.length}（上書き ${over.length}・退避先 ${backup}）・合計 ${(todo.reduce((a, x) => a + x.body.length, 0) / 1e6).toFixed(0)} MB`);
  if (flag('--dry') || !todo.length) return;
  await R2.pmap(over, 8, async (k) => { const b = await r2.get(k); if (b) await r2.put(`${backup}/${k}`, b); });
  if (over.length) await r2.put(`${backup}/_manifest.json`, JSON.stringify({ run_id: rid, overwritten: over }));
  let n = 0;
  await R2.pmap(todo, 8, async (x) => { await r2.put(x.key, x.body); n++; if (n % 1000 === 0) console.log(`  ${n} 件`); });
  console.log(`書いた: ${n} 件`);
}

(mode === 'targets' ? Promise.resolve(targets()) : mode === 'upload' ? upload() : Promise.resolve(check()))
  .catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
