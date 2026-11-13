// 版の地図（export_map.py の出力）で「判断の日の第 N 条 → 今の何条か」を引く（Node 側。週次の作り直しから使う想定）
//
//   const { resolveRef } = require('./map_resolve.cjs');
//   resolveRef(map, '37', '1996-04-11', ['平成8年法律第17号'])
//     → { cat: 'same' | 'relink' | 'split' | 'remove' | 'absent' | 'gap' | 'unknown_act', now: ['37'], at: '1996-03-31' }
//
// 決め方は eval_cases.py と同じ:
//   1. 明示の改正前（before）があれば、その改正の施行日の前日（判断の日より前なら）
//   2. 無ければ判断の日
//   3. その日にその番号の条が無ければ、直前にその番号の条があった日（経過措置で旧法を当てた・旧い番号のまま引いた）
//
//   node scripts/lineage/map_resolve.cjs <maps のフォルダ> <cases_refs.ndjson> [eval_cases_details.ndjson]
//     → 区分ごとの件数。eval_cases_details を渡すと、Python 側と結果が同じかを数える（¥0 の照らし合わせ）
'use strict';
const fs = require('fs');
const path = require('path');

function dayBefore(d) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

function resolveRef(map, num, date, before = []) {
  const k = String(num).replace(/の/g, '_');
  let d = date;
  if (before.length) {
    const b = before.find((x) => map.acts && map.acts[x]);
    if (!b) return { cat: 'unknown_act', now: [], at: d };
    const prev = dayBefore(map.acts[b]);
    if (prev < d) d = prev;
  }
  const seq = (map.nums && map.nums[k]) || [];
  let idx = -1;
  for (let i = 0; i < seq.length; i++) { if (seq[i][0] <= d) idx = i; else break; }
  while (idx >= 0 && seq[idx][1] === null) idx--;   // その日に無い → 直前にあった日
  if (idx < 0) return { cat: (map.placed || []).includes(k) ? 'gap' : 'absent', now: [], at: d };
  const now = seq[idx][1];
  if (!now.length) return { cat: 'remove', now, at: d };
  if (now.length === 1 && now[0] === k) return { cat: 'same', now, at: d };
  if (now.includes(k)) return { cat: 'split', now, at: d };
  return { cat: 'relink', now, at: d };
}

// 見出しが同じとみてよいか（eval_cases.py の cap_same と同じ）
const capNorm = (c) => String(c || '').replace(/[\s（）()「」、・等]/g, '');
function capSame(a, b) {
  a = capNorm(a); b = capNorm(b);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const bi = (s) => new Set(s.length > 1 ? [...Array(s.length - 1).keys()].map((i) => s.slice(i, i + 2)) : [s]);
  const A = bi(a), B = bi(b);
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size) >= 0.6;
}

// 1 本の条文リンク（cases_refs.cjs の行）→ 結果。引用のどれか 1 回でも今の同じ規定なら same
//   final: 'keep'（今のまま）| 'relink'（now の条へ付け直す・元の条は残す）| 'remove'（条文ページから外す）
function resolveLink(map, row, date) {
  const occ = row.occ && row.occ.length ? row.occ : [{ before: [], how: 'current' }];
  const res = occ.map((o) => {
    if (o.how === 'shikorei' || o.how === 'tailname') return { cat: 'misread', now: [] };
    if (o.how === 'old' && !(o.before || []).length) return { cat: 'old_unknown', now: [] };
    return resolveRef(map, row.art, date, o.before || []);
  });
  const r = res.find((x) => x.cat === 'same') || res[0];
  const capThen = (occ.find((o) => o.caption) || {}).caption || '';
  const k = String(row.art).replace(/の/g, '_');
  let final;
  if (['same', 'gap', 'absent', 'old_unknown', 'unknown_act'].includes(r.cat)) final = 'keep';
  else if (r.cat === 'misread') final = 'remove';
  else if (capThen && map.caps && capSame(capThen, map.caps[k])) final = 'keep';
  else final = r.now.length ? 'relink' : 'remove';
  return { ...r, final };
}

function main() {
  const [mapDir, refsFile, pyFile] = process.argv.slice(2);
  if (!mapDir || !refsFile) { console.error('使い方: node scripts/lineage/map_resolve.cjs <maps> <cases_refs.ndjson> [eval_cases_details.ndjson]'); process.exit(1); }
  const maps = {};
  for (const f of fs.readdirSync(mapDir)) if (f.endsWith('.json')) maps[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(mapDir, f), 'utf8'));
  const rows = fs.readFileSync(refsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const py = pyFile ? fs.readFileSync(pyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : null;
  const counts = {};
  let cmp = 0, agree = 0;
  const diffs = [];
  rows.forEach((r, i) => {
    const m = maps[r.law_id];
    const p = py ? py[i] : null;
    const date = p ? p.date : r.date;
    if (!m || !date) return;
    const res = resolveLink(m, r, date);
    counts[res.final] = (counts[res.final] || 0) + 1;
    if (p && !p.cat.startsWith('系譜') && !p.cat.startsWith('日付')) {
      cmp++;
      const ok = p.final === res.final && (res.final !== 'relink' || JSON.stringify((p.now || []).slice().sort()) === JSON.stringify(res.now.slice().sort()));
      if (ok) agree++; else if (diffs.length < 10) diffs.push({ id: r.id, law_id: r.law_id, art: r.art, py: [p.cat, p.final, p.now], js: [res.cat, res.final, res.now] });
    }
  });
  console.log(JSON.stringify({ counts, compared: cmp, agree, diffs }, null, 1));
}

if (require.main === module) main();
module.exports = { resolveRef, resolveLink, dayBefore, capSame };
