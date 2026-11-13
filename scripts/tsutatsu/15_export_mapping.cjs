// 15: 全通達→条文の紐づけ一覧をExcel(CSV)出力。07と同じ判定ロジックで「紐づけ根拠」付き。
//   node scripts/tsutatsu/15_export_mapping.cjs   → リポジトリ直下に tsutatsu_全紐づけ一覧.csv
// 07_build_links.cjs の BASE/lawMapFor/resolve と整合させること（法令マップ変更時は両方直す）。

const fs = require('fs');
const path = require('path');
const STATE = path.join(__dirname, 'state');
const REPO = path.join(__dirname, '..', '..');

const HOJIN = { '法': '340AC0000000034', '令': '340CO0000000097', '規': '340M50000040012', '規則': '340M50000040012' };
const SHOTOKU = { '法': '340AC0000000033', '令': '340CO0000000096', '規': '340M50000040011', '規則': '340M50000040011' };
const SOZOKU = { '法': '325AC0000000073', '令': '325CO0000000071', '規': '325M50000040017', '規則': '325M50000040017' };
const SHOHI = { '法': '363AC0000000108', '令': '363CO0000000360', '規': '363M50000040053', '規則': '363M50000040053' };
const TSUSOKU = { '法': '337AC0000000066', '令': '337CO0000000135', '規': '337M50000040028', '規則': '337M50000040028' };
const CHOSYU = { '法': '334AC0000000147', '令': '334CO0000000329', '規': '337M50000040031', '規則': '337M50000040031' };
const SOCHI = '332AC0000000026';
const SOCHI_REI = '332CO0000000043';
const SOCHI_KISOKU = '332M50000040015';
const DENCHO = { '法': '410AC0000000025', '規': '410M50000040043', '規則': '410M50000040043' };
const CHIKA = { '法': '403AC0000000069', '令': '403CO0000000174', '規': '403M50000040031', '規則': '403M50000040031' };
const INSHI = { '法': '342AC0000000023', '令': '342CO0000000108', '規': '342M50000040019', '規則': '342M50000040019' };
const BASE = {
  'kihon/hojin': HOJIN, 'kobetsu/hojin': HOJIN, 'kihon/renketsu': HOJIN,
  'kihon/shotoku': SHOTOKU, 'kobetsu/shotoku': SHOTOKU,
  'kihon/sisan': SOZOKU, 'kobetsu/sozoku': SOZOKU, 'kobetsu/hyoka': SOZOKU,
  'kihon/shohi': SHOHI, 'kihon/tsusoku': TSUSOKU,
  'kihon/chosyu': CHOSYU, 'kobetsu/chosyu': CHOSYU,
  'kobetsu/zeimuchosa': TSUSOKU, 'kobetsu/kansetsu': SHOHI, 'kihon/inshi': INSHI,
};
const NM = {
  '340AC0000000034': '法人税法', '340CO0000000097': '法人税法施行令', '340M50000040012': '法人税法施行規則',
  '340AC0000000033': '所得税法', '340CO0000000096': '所得税法施行令', '340M50000040011': '所得税法施行規則',
  '325AC0000000073': '相続税法', '325CO0000000071': '相続税法施行令', '325M50000040017': '相続税法施行規則',
  '363AC0000000108': '消費税法', '363CO0000000360': '消費税法施行令', '363M50000040053': '消費税法施行規則',
  '337AC0000000066': '国税通則法', '337CO0000000135': '国税通則法施行令', '337M50000040028': '国税通則法施行規則',
  '334AC0000000147': '国税徴収法', '334CO0000000329': '国税徴収法施行令', '337M50000040031': '国税徴収法施行規則',
  '342AC0000000023': '印紙税法', '342CO0000000108': '印紙税法施行令', '342M50000040019': '印紙税法施行規則',
  '332AC0000000026': '租税特別措置法', '332CO0000000043': '租税特別措置法施行令', '332M50000040015': '租税特別措置法施行規則',
  '410AC0000000025': '電子帳簿保存法', '410M50000040043': '電子帳簿保存法施行規則',
  '403AC0000000069': '地価税法', '403CO0000000174': '地価税法施行令', '403M50000040031': '地価税法施行規則',
};
const lawMapFor = (it) => {
  const sp = it.source_path || '';
  if (/sonota\/980528/.test(sp)) return DENCHO;
  if (/sonota\/911218/.test(sp)) return CHIKA;
  if (/sonota\/700525/.test(sp)) return HOJIN;
  return BASE[it.circular_path];
};
const resolve = (b, c) => { if (c.kind === '措置法') return { law_id: SOCHI, article: c.article, branch: c.branch }; if (c.kind === '措置法令') return { law_id: SOCHI_REI, article: c.article, branch: c.branch }; if (c.kind === '措置法規則') return { law_id: SOCHI_KISOKU, article: c.article, branch: c.branch }; if (c.kind.endsWith('附則')) { const bk = c.kind.slice(0, -2); const lid = bk === '措置法' ? SOCHI : (b && b[bk]); return lid ? { law_id: lid, article: c.article, branch: null } : null; } if (!b) return null; const id = b[c.kind]; return id ? { law_id: id, article: c.article, branch: c.branch } : null; };
const ak = (r) => r.law_id + '|' + r.article + (r.branch ? 'の' + r.branch : '');
const prefixOf = (no) => { const m = String(no || '').match(/^(\d+(?:の\d+)*)-\d+(?:の\d+)*$/); return m ? m[1] : null; };
// 本文にベース法令をフル名称で引用（「法人税法施行令第51条」等）→ その条。規則→令→法（長い名称優先）。07と整合。
function fullCiteKey(b, body) {
  if (!b || !body) return null;
  for (const kind of ['規則', '令', '法']) {
    const lid = b[kind]; if (!lid || !NM[lid]) continue;
    const mm = body.match(new RegExp(NM[lid].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '第(\\d+)条((?:の\\d+)*)'));
    if (mm) return `${lid}:${mm[1]}${(mm[2] || '').replace(/\s*の\s*/g, 'の')}`;
  }
  return null;
}
// 07と整合：附則ページの内容＋純施行文＝住所を持たない構造的項目（ラベル=附則 と 施行文に限定）。
function isStructural(it) {
  const lab = (it.home || {}).label || '';
  if (/^附則/.test(lab)) return true;
  const body = (it.body || '').replace(/&emsp;|[\s　]/g, '');
  return /^(この|本)?(政令|省令|法律|改正|通達|告示)は[^。]{0,30}施行する。?$/.test(body);
}
// 07と整合：節→条マップ（消費税 非課税各節→第6条 / 印紙税 各節→第2条）。
function sectionKey(it) {
  const lab = (it.home || {}).label || ''; const no = String(it.tsutatsu_no || '');
  if (it.circular_path === 'kihon/shohi' && /関係/.test(lab) && /^6(?:\D|$)/.test(no)) return '363AC0000000108:6';
  if (it.circular_path === 'kihon/inshi') return '342AC0000000023:2';
  if (it.circular_path === 'kihon/shohi' && /国外事業者/.test(lab)) return '363AC0000000108:2';
  if (it.circular_path === 'kihon/hojin' && /資本金等の額及び資本等取引/.test(lab)) return '340AC0000000034:2';
  if (it.circular_path === 'kihon/hojin' && /外貨建資産等の換算/.test(lab)) return '340AC0000000034:61の8';
  return null;
}

function latestStamp() { const f = fs.readdirSync(STATE).filter((x) => /^tsutatsu_items_\d{8}\.ndjson$/.test(x)).sort(); return f[f.length - 1].match(/(\d{8})/)[1]; }

const stamp = latestStamp();
const A = fs.existsSync(path.join(STATE, `tsutatsu_assignments_${stamp}.json`)) ? JSON.parse(fs.readFileSync(path.join(STATE, `tsutatsu_assignments_${stamp}.json`), 'utf8')) : {};
const items = fs.readFileSync(path.join(STATE, `tsutatsu_items_${stamp}.ndjson`), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const rows = [];
for (const it of items) {
  if (/renketsu/.test(it.circular_path || '')) continue;
  const body = (it.body || '').trim();
  const refs = [...new Set((it.body || '').match(/(?:旧|新|現|同)?(?:[一-鿿]{2,8}法施行(?:令|規則)|[一-鿿]{2,8}法|措置法令|法|令|規則|規)(?:附則)?第\s*\d+\s*条(?:の\d+)*(?:第\s*\d+\s*項)?/g) || [])].slice(0, 8).join(' / ');
  const base = { no: it.tsutatsu_no, cap: it.caption || '', grp: it.circular_path, label: (it.home && it.home.label) || '', refs, body: (it.body || '').slice(0, 160).replace(/\s+/g, ' '), bodyFull: (it.body || '').replace(/\s+/g, ' ').trim(), url: it.source_url || '', sp: it.source_path || '' };
  if (/^削除|^（[^（）]*(?:削除|廃止)[^（）]*）\s*$/.test(body)) { rows.push({ ...base, law: '(削除/廃止)', jou: '', basis: '削除除外' }); continue; }
  if (isStructural(it)) { rows.push({ ...base, law: '(附則/見出し)', jou: '', basis: '構造除外' }); continue; }
  const h = it.home || {};
  // sochiho（措置法個別通達）は凡例上「法/令/規則」＝措置法ファミリー（ベース法に解決すると誤配）。
  let b = lawMapFor(it);
  if (/\/sochiho\//.test(it.source_path || '')) b = { '法': SOCHI, '令': SOCHI_REI, '規則': SOCHI_KISOKU, '規': SOCHI_KISOKU };
  if (/\/sochiho\//.test(it.source_path || '')) { let art = (h.kind === 'jou' && h.jou) ? h.jou : prefixOf(it.tsutatsu_no); if (!art) { const m = (it.source_path || '').match(/\/soti(\d+(?:_\d+)?)\//); if (m) art = m[1].replace(/_/g, 'の'); } if (art) { rows.push({ ...base, law: '租税特別措置法', jou: art, basis: '措置法個別' }); continue; } }
  const homeLawId = h.law === 'sochi' ? SOCHI : (b && b['法']);
  if (h.kind === 'jou' && homeLawId) { rows.push({ ...base, law: NM[homeLawId] || homeLawId, jou: h.jou, basis: '見出し' }); continue; }
  const cites = [...new Set((it.citations || []).map((c) => resolve(b, c)).filter(Boolean).map(ak))];
  if (cites.length) { for (const k of cites) { const [lid, j] = k.split('|'); rows.push({ ...base, law: NM[lid] || lid, jou: j, basis: '引用' }); } continue; }
  if (/hyoka/.test((it.circular_path || '') + (it.source_path || ''))) { rows.push({ ...base, law: '相続税法', jou: '22', basis: '財産評価' }); continue; }
  if (/sonota\/700525/.test(it.source_path || '')) { rows.push({ ...base, law: '法人税法施行令', jou: '56', basis: '耐用年数' }); continue; }
  if (h.kind === 'go' && b) { rows.push({ ...base, law: NM[b['法']], jou: '2', basis: '号' }); continue; }
  const fk = fullCiteKey(b, it.body);
  if (fk) { const [lid, j] = fk.split(':'); rows.push({ ...base, law: NM[lid] || lid, jou: j, basis: 'フル名称引用' }); continue; }
  const sk = sectionKey(it);
  if (sk) { const [lid, j] = sk.split(':'); rows.push({ ...base, law: NM[lid] || lid, jou: j, basis: '節マップ' }); continue; }
  if (/sonota\/911218/.test(it.source_path || '')) { const art = (String(it.tsutatsu_no).match(/^(\d+(?:の\d+)*)/) || [])[1]; if (art) { rows.push({ ...base, law: '地価税法', jou: art, basis: '地価税(番号)' }); continue; } }
  const a = A[`${it.source_path}#${it.tsutatsu_no}`];
  if (a) { rows.push({ ...base, law: NM[a.law_id] || a.law_id, jou: a.article, basis: 'LLM割当' }); continue; }
  if (!b) { rows.push({ ...base, law: '(ニッチ税)', jou: '', basis: '未対応' }); continue; }
  rows.push({ ...base, law: NM[b['法']] || '', jou: '(未割当)', basis: '未割当', lawId: b['法'] });
}
const jn = (s) => { const x = String(s).match(/(\d+)(?:の(\d+))?/); return x ? parseInt(x[1]) * 1000 + (x[2] ? +x[2] : 0) : 999999; };
const ord = { '見出し': 0, '引用': 1, '措置法個別': 1, 'フル名称引用': 1, '節マップ': 2, '地価税(番号)': 2, 'LLM割当': 2, '財産評価': 3, '耐用年数': 3, '号': 4, '未割当': 8, '未対応': 8, '構造除外': 9, '削除除外': 9 };
rows.sort((a, b) => (ord[a.basis] - ord[b.basis]) || a.law.localeCompare(b.law) || jn(a.jou) - jn(b.jou) || jn(a.no) - jn(b.no));
const q = (c) => '"' + String(c).replace(/"/g, '""') + '"';
const joucol = (j) => (!j ? '' : /^附則/.test(j) ? j.replace(/^附則/, '附則第') + '条' : '第' + j + '条'); // 附則19→「附則第19条」
const csv = [['紐づけ根拠', '法令', '条', '通達番号', '通達の見出し', '通達群']].concat(rows.map((r) => [r.basis, r.law, joucol(r.jou), r.no, r.cap, r.grp]));
fs.writeFileSync(path.join(REPO, 'tsutatsu_全紐づけ一覧.csv'), '﻿' + csv.map((r) => r.map(q).join(',')).join('\r\n'), 'utf8');
const byB = {}; for (const r of rows) byB[r.basis] = (byB[r.basis] || 0) + 1;
console.log(`tsutatsu_全紐づけ一覧.csv 出力（${rows.length}行）:`);
Object.entries(byB).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}\t${n}`));

// --orphan: 未割当だけのレビュー用CSV（本文先頭・所属節つき）
if (process.argv.includes('--orphan')) {
  const orphans = rows.filter((r) => r.basis === '未割当').sort((a, b) => a.grp.localeCompare(b.grp) || jn(a.no) - jn(b.no));
  const ocsv = [['通達群', '通達番号', '見出し', '所属(節/章)', '本文中の条文表現', '出典URL', '本文全文']].concat(orphans.map((r) => [r.grp, r.no, r.cap, r.label, r.refs || '(条の言及なし)', r.url, r.bodyFull || r.body]));
  const data = '﻿' + ocsv.map((r) => r.map(q).join(',')).join('\r\n');
  let outName = 'tsutatsu_未割当一覧.csv';
  try { fs.writeFileSync(path.join(REPO, outName), data, 'utf8'); }
  catch (e) { if (e.code === 'EBUSY' || e.code === 'EPERM') { outName = 'tsutatsu_未割当一覧_new.csv'; fs.writeFileSync(path.join(REPO, outName), data, 'utf8'); } else throw e; }
  console.log(`\n→ ${outName} 出力（未割当 ${orphans.length}本・本文全文つき）`);
  // 13_assign 用の未割当キー（source_path#no と ベース法ID）も出力。13が --targets で正確にこの集合だけ処理する。
  const okeys = orphans.filter((r) => r.sp && r.lawId).map((r) => ({ sp: r.sp, no: r.no, lawId: r.lawId }));
  fs.writeFileSync(path.join(STATE, `tsutatsu_orphan_keys_${stamp}.json`), JSON.stringify(okeys), 'utf8');
  console.log(`→ state/tsutatsu_orphan_keys_${stamp}.json（${okeys.length}本・13_assign --targets 用）`);
}
