// 判例の引用の読み取りの直し（PR #332）を、R2 にある判決文に当てて lawRefs を足し引きする表を作る（¥0・LLM なし・書くのは --out だけ）
//
//   node scripts/lineage/parse_fix.cjs [--cases DIR | --cases-r2] [--out FILE] [--before-commit 6b1e1f9^] [--fulltext DIR]
//
// R2 の判例（hanrei_v1/cases）の lawRefs は #332 より前の読み取り。裁判所から全文を取り直さず、R2 にある判決文
// （セクションは 4,000 字で切れている）と参照法条に、直す前の読み取り（git の --before-commit の 03_parse.cjs）と
// 今の読み取り（scripts/hanrei/03_parse.cjs）を両方当てて比べる:
//   外す: 今の lawRefs にあり、同じ文で直す前は読めて今は読めないもの（外国の法令・略称の末尾一致「金商法 → 商法」・「条の一」など。
//         判決文の中でその引用を見つけて確かめられたものだけ。切れた先にしか無い引用は残す）
//   足す: 同じ文で今は読めて直す前は読めず、今の lawRefs に無いもの（〇 入りの条番号「七〇九条」など）
// 出力: { built, from_commit, counts, cases: { id: { add: [{lawId, law, art, before?}], remove: ["lawId|art"] } } }
// relink_hanrei.cjs build はこの表を当ててから付け直す（R2 lineage_v1/parse_fix.json にも置き、月に 1 回の作り直しでも使う）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const DATA = process.env.LINEAGE_DATA || path.join(REPO, 'lineage_data');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CASES = path.resolve(opt('--cases', path.join(DATA, 'hanrei_cases')));
const OUTF = path.resolve(opt('--out', path.join(DATA, 'out', 'parse_fix.json')));
const FROM = opt('--before-commit', '6b1e1f9^');
// 判決文の全文（--fulltext・既定 $LINEAGE_DATA/hanrei_raw/pdftext/{id}.json。02_extract_pdf_text.py の出力）がある判例は、切れたセクションの代わりに
// 全文に両方の読み取りを当てる（03_parse が lawRefs を作ったのと同じ元なので、足し引きを判決文の全部で確かめられる。2026-10-17 に切れた判例を取り直した）
const FULLTEXT = path.resolve(opt('--fulltext', path.join(DATA, 'hanrei_raw', 'pdftext')));
function fullTextOf(id, dir = FULLTEXT) {
  const f = path.join(dir, `${id}.json`);
  if (!/^\d{1,7}$/.test(String(id)) || !fs.existsSync(f)) return null;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && j.found !== false && typeof j.text === 'string' && j.text ? j.text : null; } catch { return null; }
}

function oldParser() {
  // 直す前の 03_parse.cjs を git から取り出し、このリポジトリの src/lawIds.js を読むように REPO_ROOT だけ差し替えて読み込む
  const src = execFileSync('git', ['show', `${FROM}:scripts/hanrei/03_parse.cjs`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 })
    .replace("const REPO_ROOT = path.join(__dirname, '..', '..');", `const REPO_ROOT = ${JSON.stringify(REPO)};`)
    .replace("require('./lib_common.cjs')", `require(${JSON.stringify(path.join(REPO, 'scripts', 'hanrei', 'lib_common.cjs'))})`);
  if (!src.includes(JSON.stringify(REPO))) throw new Error('直す前の 03_parse.cjs の REPO_ROOT を差し替えられない');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-pre332-'));
  const f = path.join(dir, '03_parse_pre.cjs');
  fs.writeFileSync(f, src);
  return require(f);
}

const arr = (v) => (Array.isArray(v) ? v : []);
function refsOf(parse, lex, rec) {
  const acc = { refs: new Map(), unresolved: new Map() };
  const text = fullTextOf(rec.id) || arr(rec.sections).map((s) => (s && s.text) || '').join('\n');
  if (text) parse.extractCitations(text, lex, acc);
  if (rec.sanshoRaw) parse.extractCitations(rec.sanshoRaw, lex, acc);
  return acc;
}

async function* iterCases() {
  if (args.includes('--cases-r2')) {
    const { R2 } = require('../update/lib/r2.cjs');
    const r2 = new R2();
    const keys = (await r2.list('hanrei_v1/cases_')).map((o) => o.key).filter((k) => /cases_\d{4}\.json$/.test(k)).sort();
    for (const k of keys) { const j = await r2.getJson(k); if (j) yield j; }
    return;
  }
  for (const f of fs.readdirSync(CASES).filter((x) => /^cases_\d{4}\.json$/.test(x)).sort()) yield JSON.parse(fs.readFileSync(path.join(CASES, f), 'utf8'));
}

async function main() {
  const NEW = require('../hanrei/03_parse.cjs');
  const OLD = oldParser();
  const lexN = NEW.buildLexicon(), lexO = OLD.buildLexicon();
  const out = {};
  const counts = { cases: 0, changed: 0, removed: 0, added: 0, removed_by_reason: {}, added_examples: [], removed_examples: [], fulltext: 0 };
  for await (const chunk of iterCases()) {
    for (const rec of Object.values(chunk)) {
      if (!rec || !rec.id) continue;
      counts.cases++;
      if (fullTextOf(rec.id)) counts.fulltext++;
      const o = refsOf(OLD, lexO, rec), n = refsOf(NEW, lexN, rec);
      const have = new Set(arr(rec.lawRefs).map((r) => `${r.lawId}|${r.art}`));
      const remove = [...o.refs.keys()].filter((k) => have.has(k) && !n.refs.has(k));
      const add = [...n.refs.values()].filter((e) => !o.refs.has(`${e.lawId}|${e.art}`) && !have.has(`${e.lawId}|${e.art}`) && e.lawId)
        .map((e) => ({ lawId: e.lawId, law: e.law, art: e.art, ...(e.before && e.before.length ? { before: e.before } : {}), ...(e.prior ? { prior: true, kaiseimae: true } : {}), ...(e.kyu ? { kyu: true } : {}) }));
      // 今の読み取りで未解決に移ったもの（「有限会社法」「米国特許法」など）。旧法の名前で拾えるものはこれで旧法の表に付く
      const oldU = new Set([...o.unresolved.keys()]);
      const unres = [...n.unresolved.values()].filter((u) => !oldU.has(`${u.name}|${u.art}`)).map((u) => ({ name: u.name, art: u.art, count: u.count || 1 }));
      // 印の直し（2026-10-17）: 今の lawRefs にもある引用で、今の読み取りが「改正前」「旧」（prior・kyu）や「…による改正前」（before）を読んだもの
      const byKey = new Map(arr(rec.lawRefs).map((r) => [`${r.lawId}|${r.art}`, r]));
      const mod = [];
      for (const [k, e] of n.refs) {
        const r = byKey.get(k);
        if (!r || remove.includes(k)) continue;
        const nb = arr(e.before).filter((b) => !arr(r.before).includes(b));
        const m = { ...(e.prior && !r.prior ? { prior: true } : {}), ...(e.kyu && !r.kyu ? { kyu: true } : {}), ...(e.kaiseimae && !r.kaiseimae ? { kaiseimae: true } : {}), ...(nb.length ? { before: nb } : {}) };
        if (Object.keys(m).length) mod.push({ k, ...m });
      }
      if (!remove.length && !add.length && !unres.length && !mod.length) continue;
      counts.modified = (counts.modified || 0) + mod.length;
      if (mod.some((m) => m.prior)) counts.prior_cases = (counts.prior_cases || 0) + 1;
      counts.prior_refs = (counts.prior_refs || 0) + mod.filter((m) => m.prior).length;
      counts.changed++;
      counts.removed += remove.length;
      counts.added += add.length;
      for (const k of remove) {
        // 理由: 今の読み取りで同じ条番号が別の名前（外国の法令・別の法令の略称）で未解決になった／同じ法令の別の条番号になった（条の一など）
        const [lid, art] = k.split('|');
        const law = (arr(rec.lawRefs).find((r) => `${r.lawId}|${r.art}` === k) || {}).law || '';
        const unres = [...n.unresolved.values()].some((u) => u.art === art && String(u.name).endsWith(law.slice(-2)));
        const sameLaw = [...n.refs.values()].some((e) => e.lawId === lid && e.art !== art && art.startsWith(e.art));
        const kataNo = [...n.refs.values()].some((e) => e.lawId === lid && e.art.startsWith(`${art}の`));
        const why = unres ? '外国の法令・別の法令の名前' : sameLaw ? '枝番の読み違い（条の一・項の番号など）'
          : kataNo ? '枝番の「ノ」の落ち（266条ノ3 を 266条と読んでいた）' : 'そのほか（略称の引き直しなど）';
        counts.removed_by_reason[why] = (counts.removed_by_reason[why] || 0) + 1;
        if (counts.removed_examples.length < 20) counts.removed_examples.push({ id: rec.id, ref: `${law}${art}`, why });
      }
      if (add.length && counts.added_examples.length < 20) counts.added_examples.push({ id: rec.id, add: add.map((a) => `${a.law}${a.art}`) });
      out[rec.id] = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}), ...(unres.length ? { unres } : {}), ...(mod.length ? { mod } : {}) };
      counts.unres_added = (counts.unres_added || 0) + unres.length;
    }
  }
  fs.mkdirSync(path.dirname(OUTF), { recursive: true });
  fs.writeFileSync(OUTF, JSON.stringify({ built: new Date().toISOString(), from_commit: FROM, counts, cases: out }));
  console.log(`判例 ${counts.cases} 件（全文を当てた ${counts.fulltext}）・足し引きのある判例 ${counts.changed}・外す ${counts.removed}（${Object.entries(counts.removed_by_reason).map(([k, v]) => `${k} ${v}`).join('・')}）・足す ${counts.added}`);
  console.log(`印の直し: ${counts.modified || 0}（改正前・旧の印 ${counts.prior_refs || 0} 引用・${counts.prior_cases || 0} 判例）`);
  console.log(`→ ${OUTF}`);
}

// relink_hanrei.cjs・週次から: 判例 1 件に足し引きを当てた lawRefs（表に無ければそのまま）
function applyFix(rec, fix) {
  const f = fix && fix[rec.id];
  if (!f) return rec;
  const rm = new Set(f.remove || []);
  const md = new Map((f.mod || []).map((m) => [m.k, m]));
  const refs = arr(rec.lawRefs).filter((r) => !rm.has(`${r.lawId}|${r.art}`)).map((r) => {
    const m = md.get(`${r.lawId}|${r.art}`);
    if (!m) return r;
    const { k, before, ...flags } = m;
    return { ...r, ...flags, ...(before ? { before: [...new Set([...arr(r.before), ...before])].sort() } : {}) };
  });
  const u = arr(rec.unresolvedRefs);
  const have = new Set(u.map((x) => `${x.name}|${x.art}`));
  return { ...rec, lawRefs: [...refs, ...(f.add || [])], unresolvedRefs: [...u, ...(f.unres || []).filter((x) => !have.has(`${x.name}|${x.art}`))] };
}

module.exports = { applyFix, fullTextOf };

if (require.main === module) main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
