// 13: 未割当（浮き）通達に、帰属する条をLLMで割り当てる（ビルド時1回）。
// 候補=仲間引用(主)∪番号(検証群)∪自引用∪ベクトル → LLMは閉じた候補から選ぶ or null（条番号の創作不可）。
// 二段構え: ①ページ単位でまとめてSonnet割当 → ②低確信(low)/nullだけOpusで再判定（効くところだけ高級モデル）。
// ベンチ(12)で候補リコール93%・精度~90%・null安全 を確認済み。07が assignments を住所として取り込む。
//
//   node scripts/tsutatsu/13_assign.cjs --pages 15   # 先頭15ページで試走
//   node scripts/tsutatsu/13_assign.cjs --dry         # 対象数のみ
//   node scripts/tsutatsu/13_assign.cjs               # 全件

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');
const STATE = path.join(__dirname, 'state');
const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;   // 平文の既定値は置かない（鍵は取り替え済み。環境変数で渡す）
if (!KEY) { console.error('環境変数 BYPASS_KEY を設定してください'); process.exit(1); }

const HOJIN = '340AC0000000034', SHOTOKU = '340AC0000000033', SOZOKU = '325AC0000000073',
  SHOHI = '363AC0000000108', TSUSOKU = '337AC0000000066', CHOSYU = '334AC0000000147', SOCHI = '332AC0000000026';
// 【2026-09-02 追加】地図の外にいた861本のための法令。パーサでは読めているのに
//   ベース法令マップに無いせいで条に紐づかず浮いていた（税理士法96・不服審査189・
//   審査請求116・酒税85・揮発油169 等）。法令IDは src/lawIds.js から引いた。
const ZEIRISHI = '326AC1000000237', SAKE = '328AC0000000006', SAKEKUMIAI = '328AC0000000007',
  KIHATSU = '332AC0000000055', KOKUKI = '347AC0000000007', TABAKO = '359AC0000000072',
  SEKIYUGASU = '340AC0000000156', SEKIYUSEKITAN = '353AC0000000025', DENGEN = '349AC0000000079';
const BASE = {
  'kihon/hojin': HOJIN, 'kobetsu/hojin': HOJIN,
  // 不服審査（国税庁）・審査請求（審判所）はいずれも国税通則法第8章（不服審査）の解釈
  'kihon/igi': TSUSOKU, 'kihon/shinsaseikyu': TSUSOKU,
  'kihon/zeirishi': ZEIRISHI, 'kobetsu/zeirishi': ZEIRISHI,
  'kihon/sake': SAKE, 'kihon/kihatsu': KIHATSU, 'kihon/kokuki': KOKUKI,
  'kihon/tabako': TABAKO, 'kihon/sekiyugasu': SEKIYUGASU,
  'kihon/sekiyusekitan': SEKIYUSEKITAN, 'kihon/dengenkaihatsu': DENGEN,
  'kihon/shotoku': SHOTOKU, 'kobetsu/shotoku': SHOTOKU,
  'kihon/sisan': SOZOKU, 'kobetsu/sozoku': SOZOKU,
  'kihon/shohi': SHOHI, 'kihon/tsusoku': TSUSOKU,
  'kihon/chosyu': CHOSYU, 'kobetsu/chosyu': CHOSYU,
  'kobetsu/zeimuchosa': TSUSOKU, 'kobetsu/kansetsu': SHOHI,
};
const LAW_NAME = {
  [ZEIRISHI]: '税理士法', [SAKE]: '酒税法', [SAKEKUMIAI]: '酒税の保全及び酒類業組合等に関する法律',
  [KIHATSU]: '揮発油税法', [KOKUKI]: '航空機燃料税法', [TABAKO]: 'たばこ税法',
  [SEKIYUGASU]: '石油ガス税法', [SEKIYUSEKITAN]: '石油石炭税法', [DENGEN]: '電源開発促進税法',
  [HOJIN]: '法人税法', [SHOTOKU]: '所得税法', [SOZOKU]: '相続税法',
  [SHOHI]: '消費税法', [TSUSOKU]: '国税通則法', [CHOSYU]: '国税徴収法', [SOCHI]: '租税特別措置法',
  '342AC0000000023': '印紙税法', '403AC0000000069': '地価税法', '410AC0000000025': '電子帳簿保存法',
};
const PREFIX_OK = new Set(['kobetsu/shotoku', 'kobetsu/hojin', 'kobetsu/sozoku', 'kihon/shotoku']);
// 各法の「一般的な持ち場」(益金損金・計上時期・圧縮記帳・評価 等)。本文に条が無い個別通達でもここから選べるよう常に候補に入れる。
const ANCHORS = {
  [HOJIN]: ['22', '22の2', '42', '61の8', '2', '25', '33', '34', '37', '55', '31', '50', '52'],
  [SHOTOKU]: ['36', '37', '45', '51', '57', '2', '9', '28', '35', '34', '40'],
  [SOZOKU]: ['22', '11の2', '1の3', '1の4', '19', '21の11', '21の15', '66', '64'],
  [SHOHI]: ['2', '4', '6', '28', '30', '37', '9', '14', '60'],
  [TSUSOKU]: ['65', '66', '68', '15', '23', '70',
    '75', '77', '80', '84', '87', '92', '96', '97', '99', '104', '105', '109', '115'],  // 第8章 不服審査
  [CHOSYU]: ['39', '47', '62', '75', '76', '151', '153'],
  '342AC0000000023': ['2', '3', '4', '5', '7', '8'],
  // 各法の「持ち場」＝総則・定義・課税物件・納税義務・手続の中核条
  [ZEIRISHI]: ['2', '3', '33の2', '41', '45', '46', '52', '1'],                    // 税理士業務・書面添付・懲戒
  [SAKE]: ['2', '3', '6', '7', '9', '10', '22', '28', '43'],                       // 定義・免許・税率・みなし製造
  [KIHATSU]: ['3', '6', '8', '9', '10', '13', '16'],
  [KOKUKI]: ['3', '4', '9', '11', '13'],
  [TABAKO]: ['3', '8', '10', '11', '12', '17'],
  [SEKIYUGASU]: ['3', '6', '9', '11', '16'],
  [SEKIYUSEKITAN]: ['3', '4', '8', '10', '12'],
  [DENGEN]: ['2', '3', '5', '7', '9'],
  '403AC0000000069': ['2', '5', '6', '7', '17'],
  '410AC0000000025': ['4', '5', '7', '8'],
};
// 見出し(caption)から自法令の条を拾う（「法第22条」「第42条関係」「(第45条の2)」等）。クロス法令(措置法名等)は別ロジック。
function captionArts(caption) {
  const out = [];
  const t = Z2H(caption || '');
  let m; const re = /(?:法)?第\s*(\d+)\s*条(?:の\s*(\d+))?/g;
  while ((m = re.exec(t))) out.push(`${m[1]}${m[2] ? 'の' + m[2] : ''}`);
  return out;
}

const KD = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanji2num(s) {
  if (!s) return null; let n = 0, cur = 0;
  for (const ch of s) {
    if (ch === '千') { n += (cur || 1) * 1000; cur = 0; }
    else if (ch === '百') { n += (cur || 1) * 100; cur = 0; }
    else if (ch === '十') { n += (cur || 1) * 10; cur = 0; }
    else if (ch in KD) cur = KD[ch]; else return null;
  }
  return n + cur;
}
function artTitle2key(title) {
  const m = (title || '').match(/^第([〇一二三四五六七八九十百千]+)条(?:の([〇一二三四五六七八九十百千]+))?/);
  if (!m) return null;
  const a = kanji2num(m[1]); if (!a) return null;
  return `${a}${m[2] ? 'の' + kanji2num(m[2]) : ''}`;
}
const artStr = (c) => `${c.article}${c.branch ? 'の' + c.branch : ''}`;
const Z2H = (s) => String(s).replace(/[０-９]/g, (d) => '０１２３４５６７８９'.indexOf(d));
// LLMの条回答を候補キー形式に正規化（"第16条"/"16条"/"１６"→"16"、"第37条の14"→"37の14"）
function normArt(s) {
  if (s == null) return null;
  let t = Z2H(s).replace(/[第\s]/g, '').replace(/条/g, '');
  t = t.trim();
  return /^\d+(の\d+)?$/.test(t) ? t : null;
}
function prefixCandidate(no) {
  const m = String(no || '').match(/^(\d+(?:の\d+)?)-\d+(?:の\d+)?$/);
  return m ? m[1] : null;
}
function latestStamp() {
  const f = fs.readdirSync(STATE).filter((x) => /^tsutatsu_items_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}
async function callChat(system, user, model, maxTokens) {
  const res = await fetch(`${WORKER}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ system, model, maxTokens, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return { text: j.content?.[0]?.text || '', jpy: j._cost?.jpy || 0 };
}
async function vectorTop(lawId, queryText, limit) {
  try {
    const res = await fetch(`${WORKER}/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify({ queries: [queryText.slice(0, 240)], originalQuery: queryText.slice(0, 240), topN: 50 }),
    });
    if (!res.ok) return [];
    const j = await res.json(); const out = [];
    for (const r of j.results || []) {
      if (r.law?.law_id !== lawId) continue;
      const key = artTitle2key(r.article?.title);
      if (key && !out.some((o) => o.key === key)) out.push({ key, cap: r.article?.caption || '' });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}
const parseJsonLoose = (t) => { const m = t.match(/\[[\s\S]*\]|\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };

// ページ内の全対象通達に対する共有候補プールを構築（仲間引用∪番号∪自引用∪ベクトル）
async function buildPool(lawId, circular, pageItems, targets, vecN = 20) {
  const pool = new Set(); const capByKey = {};
  // 仲間引用＝ページ全通達の base-law 引用（最強シグナル87%）
  for (const it of pageItems) (it.citations || []).filter((c) => c.kind === '法').forEach((c) => pool.add(artStr(c)));
  // 番号プレフィックス（検証済み群のみ）
  if (PREFIX_OK.has(circular)) for (const t of targets) { const p = prefixCandidate(t.tsutatsu_no); if (p) pool.add(p); }
  // 見出し(caption)に書かれた条（「法第22条」「(第45条の2)」等。本文に無くても見出しにある型を救済）
  for (const t of targets) captionArts(t.caption).forEach((a) => pool.add(a));
  // 各法の一般的な持ち場（益金損金=22、圧縮記帳=42 等）を常に候補に（本文に条が無い個別通達でもLLMが選べる）
  (ANCHORS[lawId] || []).forEach((a) => pool.add(a));
  // ベクトル（対象ごとtopN・重複排除）。所属見出し(節タイトル)も検索クエリに。
  const vecs = await Promise.all(targets.map((t) => vectorTop(lawId, `${(t.home && t.home.label) || ''} ${t.caption || ''} ${t.body || ''}`, vecN)));
  for (const v of vecs) for (const x of v) { pool.add(x.key); if (x.cap) capByKey[x.key] = x.cap; }
  return { candidates: [...pool].sort((a, b) => (parseInt(a) - parseInt(b)) || a.localeCompare(b)), capByKey };
}

function pagePrompt(lawName, label, targets, candidates, capByKey) {
  const candLines = candidates.map((c) => `  第${c}条${capByKey[c] ? ` ${capByKey[c]}` : ''}`).join('\n');
  const tLines = targets.map((t, i) => `[${i + 1}] 番号 ${t.tsutatsu_no} / 見出し「${t.caption || 'なし'}」\n    本文: ${(t.body || '').slice(0, 550)}`).join('\n');
  return `【ベース法令】${lawName}　【所属見出し】${label || '不明'}

【このページの通達を、それぞれ「帰属する条」に割り当てよ】
${tLines}

【候補となる条（この中からのみ選ぶ）】
${candLines || '  （なし）'}

【ルール】
- 各通達が「${lawName}のどの条を解釈・補足するものか（本来の持ち場）」を候補から1つ選ぶ。
- 最も具体的に該当する条を優先。具体的な条が候補に無ければ、内容に合う一般条でよい
  （例: 益金・損金・収益費用の計上時期の話＝第22条、補助金で取得した資産の圧縮記帳＝第42条、財産の評価＝相続22条）。
- 見出しに条が書いてあれば(例「(第45条の2)」)それを最優先。本文が他法令を引くのは関連参照のことが多い。
- どの条にも本当に当てはまらない時だけ null。「内容が一般的な計算・経理の話」なら第22条等の一般条に寄せてよい。
- article は条番号のみ（例: 8 / 16 / 37の14 / 22）。「第」「条」は付けない。
次のJSON配列のみ（no は入力の通達番号をそのまま、入力した全通達分を出力）：
[{"no":"${targets[0]?.tsutatsu_no}","article":"16","conf":"high"}, ...]`;
}

function itemPrompt(lawName, it, mates, candidates, capByKey) {
  const mateLines = mates.map((m) => `  ${m.tsutatsu_no}「${m.caption || 'なし'}」${(m.citations || []).filter((c) => c.kind === '法').length ? ' …第' + (m.citations || []).filter((c) => c.kind === '法').map(artStr).join('・第') + '条引用' : ''}`).join('\n');
  const candLines = candidates.map((c) => `  第${c}条${capByKey[c] ? ` ${capByKey[c]}` : ''}`).join('\n');
  return `【ベース法令】${lawName}
【判定対象】所属見出し: ${it.home?.label || '不明'} / 番号 ${it.tsutatsu_no} / 見出し「${it.caption || 'なし'}」
本文: ${(it.body || '').slice(0, 700)}
【同ページの仲間（最強ヒント）】
${mateLines || '  なし'}
【候補（この中からのみ）】
${candLines}
この通達の本来の帰属条を候補から1つ選べ。確信なければnull。article は条番号のみ（例 16 や 37の14、「第」「条」不要）。JSONのみ:{"article":"16","conf":"high"}`;
}

function parseArgs() {
  const a = process.argv.slice(2);
  return { pages: a.includes('--pages') ? +a[a.indexOf('--pages') + 1] : Infinity, dry: a.includes('--dry'), targets: a.includes('--targets') ? a[a.indexOf('--targets') + 1] : null };
}

async function main() {
  const { pages: pageLimit, dry, targets: targetsFile } = parseArgs();
  const stamp = latestStamp();
  const items = fs.readFileSync(path.join(STATE, `tsutatsu_items_${stamp}.ndjson`), 'utf8')
    .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const pageItems = {};
  for (const it of items) (pageItems[it.source_path] = pageItems[it.source_path] || []).push(it);

  // 既存割当を読み込み、まだ浮いてる(未割当)分だけを対象にする（07で処理される分は除外）
  const asgFile = path.join(STATE, `tsutatsu_assignments_${stamp}.json`);
  const existing = fs.existsSync(asgFile) ? JSON.parse(fs.readFileSync(asgFile, 'utf8')) : {};
  // --targets 指定時: 15が出した未割当キー(sp#no→lawId)だけを正確に対象にする（07の全ロジックと整合）。
  const targetMap = targetsFile ? new Map(JSON.parse(fs.readFileSync(targetsFile, 'utf8')).map((k) => [`${k.sp}#${k.no}`, k.lawId])) : null;
  const pageTargets = {};
  for (const it of items) {
    if (targetMap) {
      const lid = targetMap.get(`${it.source_path}#${it.tsutatsu_no}`);
      if (!lid) continue;
      it._lawId = lid;
      (pageTargets[it.source_path] = pageTargets[it.source_path] || []).push(it);
      continue;
    }
    if (/renketsu/.test(it.circular_path || '')) continue;
    if (!BASE[it.circular_path]) continue;
    if (/\/sochiho\//.test(it.source_path || '')) continue;       // 措置法個別＝07が処理
    if (/sonota\/700525/.test(it.source_path || '')) continue;    // 耐用年数＝07が処理
    const h = it.home || {};
    if (h.kind === 'jou' || h.kind === 'go') continue;
    if (/hyoka/.test((it.circular_path || '') + (it.source_path || ''))) continue;
    if ((it.citations || []).some((c) => ['法', '令', '規', '規則', '措置法'].includes(c.kind))) continue; // 07が引用(法/令/規/措置法)で処理
    const body = (it.body || '').trim();
    if (/^削除|^（[^（）]*(?:削除|廃止)[^（）]*）\s*$/.test(body) || body.length < 20) continue; // 削除/空(見出し行ゴミ)
    if (existing[`${it.source_path}#${it.tsutatsu_no}`]) continue; // 既に割当済み＝スキップ（残りだけ）
    it._lawId = BASE[it.circular_path];
    (pageTargets[it.source_path] = pageTargets[it.source_path] || []).push(it);
  }
  let pageKeys = Object.keys(pageTargets);
  const totalTargets = pageKeys.reduce((s, k) => s + pageTargets[k].length, 0);
  console.log(`割当対象: ${totalTargets}件 / ${pageKeys.length}ページ`);
  if (dry) { console.log('（dry-run）'); return; }
  if (pageLimit !== Infinity) pageKeys = pageKeys.slice(0, pageLimit);

  const sysB = 'あなたは日本の税法・税務通達の専門家。指示されたJSON配列のみを返す。';
  const sysI = 'あなたは日本の税法・税務通達の専門家。指示されたJSONのみを返す。';
  const assignments = { ...existing }; const conf = {}; // 既存にマージ（残りだけ追記）
  let jpy1 = 0, jpy2 = 0, assigned = 0;
  const lowOrNull = []; // pass2(Opus)へ
  const audit = [['source_path', 'no', 'circular', 'law', 'article', 'conf', 'pass']];

  // ===== Pass1: ページまとめ Sonnet =====
  for (let i = 0; i < pageKeys.length; i += 8) {
    await Promise.all(pageKeys.slice(i, i + 8).map(async (sp) => {
      const targets = pageTargets[sp];
      const lawId = targets[0]._lawId || BASE[targets[0].circular_path];
      const { candidates, capByKey } = await buildPool(lawId, targets[0].circular_path, pageItems[sp] || [], targets);
      if (!candidates.length) { for (const t of targets) lowOrNull.push({ it: t, lawId, sp }); return; }
      try {
        const r = await callChat(sysB, pagePrompt(LAW_NAME[lawId], targets[0].home?.label, targets, candidates, capByKey), 'sonnet', 4000);
        jpy1 += r.jpy;
        const arr = parseJsonLoose(r.text) || [];
        const byNo = {}; for (const e of arr) if (e && e.no != null) byNo[String(e.no)] = e;
        for (const t of targets) {
          const e = byNo[String(t.tsutatsu_no)];
          const art = normArt(e && e.article);
          if (art && candidates.includes(art)) { // Sonnetが候補から選べた → 採用(高低問わず)
            const cf = e.conf === 'high' ? 'high' : 'low';
            assignments[`${sp}#${t.tsutatsu_no}`] = { law_id: lawId, article: art, by: 'sonnet', conf: cf }; assigned++;
            audit.push([sp, t.tsutatsu_no, t.circular_path, LAW_NAME[lawId], art, cf, 'sonnet']);
          } else { lowOrNull.push({ it: t, lawId, sp }); } // 候補から選べず → null(レビュー行き)
        }
      } catch { for (const t of targets) lowOrNull.push({ it: t, lawId, sp }); }
    }));
    process.stdout.write(`\r  Pass1(Sonnet) ${Math.min(i + 8, pageKeys.length)}/${pageKeys.length}ページ  high割当${assigned}`);
  }

  // ===== Pass2: --opus 指定時のみ null を Opus で再判定（既定はSonnetのみ）=====
  const useOpus = process.argv.includes('--opus');
  if (useOpus) console.log(`\n  Pass2(Opus)対象: ${lowOrNull.length}件`);
  for (let i = 0; useOpus && i < lowOrNull.length; i += 6) {
    await Promise.all(lowOrNull.slice(i, i + 6).map(async ({ it, lawId, sp }) => {
      const mates = (pageItems[sp] || []).filter((x) => x !== it).slice(0, 10);
      const { candidates, capByKey } = await buildPool(lawId, it.circular_path, pageItems[sp] || [], [it], 20); // Opus再判定は候補広め(recall↑)
      if (!candidates.length) { audit.push([sp, it.tsutatsu_no, it.circular_path, LAW_NAME[lawId], 'NULL', '', 'opus']); return; }
      try {
        const r = await callChat(sysI, itemPrompt(LAW_NAME[lawId], it, mates, candidates, capByKey), 'opus', 200);
        jpy2 += r.jpy;
        const o = parseJsonLoose(r.text) || {};
        const art = normArt(o.article);
        if (art && candidates.includes(art)) {
          assignments[`${sp}#${it.tsutatsu_no}`] = { law_id: lawId, article: art, by: 'opus' }; assigned++;
          audit.push([sp, it.tsutatsu_no, it.circular_path, LAW_NAME[lawId], art, o.conf || '', 'opus']);
        } else audit.push([sp, it.tsutatsu_no, it.circular_path, LAW_NAME[lawId], 'NULL', o.conf || '', 'opus']);
      } catch { audit.push([sp, it.tsutatsu_no, it.circular_path, LAW_NAME[lawId], 'ERR', '', 'opus']); }
    }));
    process.stdout.write(`\r  Pass2(Opus) ${Math.min(i + 6, lowOrNull.length)}/${lowOrNull.length}`);
  }

  const outFile = path.join(STATE, `tsutatsu_assignments_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(assignments, null, 0), 'utf8');
  fs.writeFileSync(path.join(STATE, `tsutatsu_assignments_${stamp}.csv`), '﻿' + audit.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'), 'utf8');
  const nulled = (pageKeys.reduce((s, k) => s + pageTargets[k].length, 0)) - assigned;
  console.log(`\n\n=== 完了 ===`);
  console.log(`割当: ${assigned} / null(レビュー行き): ${nulled}  (対象 ${pageKeys.reduce((s, k) => s + pageTargets[k].length, 0)})`);
  console.log(`コスト: Pass1(Sonnet) ≒${jpy1.toFixed(0)}円 + Pass2(Opus) ≒${jpy2.toFixed(0)}円 = ≒${(jpy1 + jpy2).toFixed(0)}円`);
  console.log(`出力: ${outFile}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
