// 別表のベクトル（tsutatsu-embeddings-v1 の _beppyo と bpr_*）の作り方。PC の 13・13b・15 と週次（scripts/beppyo/weekly）で共用。
//   _beppyo: 1 別表＝1 ベクトル（法令名＋別表名＋caption＋先頭行）。homes は caption「（第○条関係）」と、refs の target_appdx の逆引き
//   bpr_{law_id}_b{番号}: 3 万字以上の大別表の行（見出し＋配下のイロハを 1 まとまり）。Worker の beppyoRowsNamespace と同じ namespace
// ここを変えると本番のベクトルの id・本文・metadata が変わる（週次は全部「変わった」として埋め込み直す）。変えたら scripts/beppyo/weekly/check_weekly.cjs を通す
'use strict';
const crypto = require('crypto');

const NS = '_beppyo';
const TEXT_MAX = 400;       // 判別用の濃い 1 ベクトル。全行（6000）は薄まるので短く
const MIN_CHARS = 30000;    // これ以上の別表だけ行ベクトルを作る（小別表は丸ごと送れるので不要）
const ROW_TEXT_MAX = 600;
const SECTION_MAX = 40;     // 上位見出し（一 不動産の登記 等）の前置き上限

// --- 数字パース (漢数字 + 全角/半角アラビア) → int ---
function kanjiToInt(s) {
  const d = { '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const u = { '十': 10, '百': 100, '千': 1000 };
  let total = 0, cur = 0, seen = false;
  for (const ch of s) {
    if (d[ch] != null) { cur = d[ch]; seen = true; }
    else if (u[ch] != null) { total += (cur || 1) * u[ch]; cur = 0; seen = true; }
  }
  return seen ? total + cur : null;
}
function parseNum(s) {
  if (s == null) return null;
  s = String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  return kanjiToInt(s);
}
// int → 漢数字 (条番号用, 〜9999)
function intToKanji(n) {
  n = parseInt(n, 10); if (!n) return '〇';
  const d = '〇一二三四五六七八九';
  const th = Math.floor(n / 1000), hu = Math.floor((n % 1000) / 100), te = Math.floor((n % 100) / 10), on = n % 10;
  let s = '';
  if (th) s += (th > 1 ? d[th] : '') + '千';
  if (hu) s += (hu > 1 ? d[hu] : '') + '百';
  if (te) s += (te > 1 ? d[te] : '') + '十';
  if (on) s += d[on];
  return s;
}

// caption「…（第四条、第五条関係）」「…（第五十六条、第五十六条の二関係）」→ [{l,a,n}]
// 範囲(第五条―第七条)は端点のみ拾う(v1割り切り)。
function homesFromCaption(cap, lawId, lawTitle) {
  if (!cap) return [];
  const out = [], seen = new Set();
  const re = /第\s*([0-9０-９一二三四五六七八九十百千]+)\s*条((?:[のノ]\s*[0-9０-９一二三四五六七八九十百千]+)*)/g;
  let m;
  while ((m = re.exec(cap)) !== null) {
    const n = parseNum(m[1]);
    if (!n) continue;
    let a = '第' + intToKanji(n) + '条';
    const branchPart = m[2] || '';
    const bms = branchPart.match(/[のノ]\s*([0-9０-９一二三四五六七八九十百千]+)/g) || [];
    for (const b of bms) {
      const bn = parseNum(b.replace(/[のノ\s]/g, ''));
      if (bn) a += 'の' + intToKanji(bn);
    }
    if (seen.has(a)) continue;
    seen.add(a);
    out.push({ l: lawId, a, n: lawTitle });
  }
  return out;
}

// 別表名 → 正規化キー。「別表第一」「別表一」「別表第１」→ "別表|1"、「別表第二の二」→ "別表|2.2"、「別表」→ "別表|"
// 別記/別図/様式 等（別表で始まらない appdx）は _beppyo 対象外なので null。
function canonicalAppdx(name) {
  if (!name) return null;
  name = String(name).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (!name.startsWith('別表')) return null;
  let rest = name.slice(2).replace(/^第/, '');
  const m = rest.match(/^([0-9一二三四五六七八九十百千]+)/);
  if (!m) return '別表|';
  let canon = '別表|' + parseNum(m[1]);
  rest = rest.slice(m[0].length);
  const bm = rest.match(/^[のノ]([0-9一二三四五六七八九十百千]+)/);
  if (bm) canon += '.' + parseNum(bm[1]);
  return canon;
}
// XML Num「9」→第九条、「9_2」→第九条の二
function numToTitle(num) {
  const parts = String(num).split('_');
  let t = '第' + intToKanji(parseInt(parts[0], 10)) + '条';
  for (let i = 1; i < parts.length; i++) t += 'の' + intToKanji(parseInt(parts[i], 10));
  return t;
}

// refs（{ "{lawId}_Art{num}": [ { target_law_id, target_appdx, ... } ] }）を逆引きして「別表 → 参照元条文」に足す。
//   map: { "{lawId}|{canonicalAppdx}": { "l|a": [l, a] } }（13b と同じ。条文ソースのみ・別表ソース _Art別表… は除外）
function addAppdxHomes(map, refs, stats = {}) {
  for (const [srcKey, arr] of Object.entries(refs || {})) {
    const m = srcKey.match(/^(.+)_Art(\d+(?:_\d+)*)$/);
    if (!m) { stats.skippedSrc = (stats.skippedSrc || 0) + 1; continue; }
    const srcLaw = m[1];
    const srcArt = numToTitle(m[2]);
    for (const r of arr || []) {
      if (!r || !r.target_appdx || !r.target_law_id) continue;
      stats.appdxRefs = (stats.appdxRefs || 0) + 1;
      const canon = canonicalAppdx(r.target_appdx);
      if (!canon) continue;
      const key = r.target_law_id + '|' + canon;
      (map[key] = map[key] || {})[srcLaw + '|' + srcArt] = [srcLaw, srcArt];
      stats.attached = (stats.attached || 0) + 1;
    }
  }
  return map;
}
// {l|a:[l,a]} を [{l,a}] へ（13b の出力の形）
function finishAppdxHomes(map) {
  const out = {};
  for (const [key, obj] of Object.entries(map)) out[key] = Object.values(obj).map(([l, a]) => ({ l, a }));
  return out;
}

function rowsText(art, maxRows) {
  const p0 = (art.paragraphs && art.paragraphs[0]) || {};
  const parts = [];
  for (const s of (p0.sentences || [])) if (s.text) parts.push(s.text);
  let rows = 0;
  for (const it of (p0.items || [])) {
    if (rows >= maxRows) break;
    if (it.item_title) parts.push(it.item_title);
    for (const s of (it.sentences || [])) if (s.text) parts.push(s.text);
    rows++;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// 1 別表 → _beppyo の 1 ベクトル（埋め込み前）。本文が空なら null。
//   refsHomesMap: finishAppdxHomes の出力（無ければ caption の homes だけ）
function beppyoEntry(lawId, lawTitle, art, refsHomesMap = {}) {
  const title = String(art.title || '');
  if (!title.startsWith('別表')) return null;
  const cap = (art.caption || '').trim();
  // homes は生caption の「（第○条…関係）」から抽出。埋め込みテキストには説明見出しだけ入れ、
  // 条番号の羅列（関係括弧）は外す（意味判別を薄めるため。例「非課税法人の表（第四条、第五条関係）」
  // →「非課税法人の表」。関係だけのcaptionは空になり law_title+別表名+先頭行で判別）。
  const capHomes = homesFromCaption(cap, lawId, lawTitle);
  // refs逆引きの homes をマージ（条文側に「別表第一による」と書いてある分。内部参照は n=自法令名、外部は worker が取得）
  const refsHomes = (refsHomesMap[`${lawId}|${canonicalAppdx(title)}`] || [])
    .map((h) => ({ l: h.l, a: h.a, n: h.l === lawId ? lawTitle : '' }));
  const homes = [];
  const seenH = new Set();
  for (const h of [...capHomes, ...refsHomes]) {
    const k = h.l + '|' + h.a;
    if (!h.a || seenH.has(k)) continue;
    seenH.add(k); homes.push(h);
  }
  const capClean = cap.replace(/（[^（）]*関係）/g, '').replace(/\s+/g, ' ').trim();
  const rows = rowsText(art, 3);
  const text = [lawTitle, title, capClean, rows].filter(Boolean).join(' ').slice(0, TEXT_MAX);
  if (!text.trim()) return null;
  const snip = (capClean || rows).slice(0, 120);
  const id = crypto.createHash('md5').update('bp|' + lawId + '|' + title).digest('hex');
  return {
    id, ns: NS, text,
    metadata: {
      law_id: lawId, law_title: lawTitle, article_title: title,
      cap: (capClean || cap).slice(0, 80), snip, homes: JSON.stringify(homes),
    },
    _capHomes: capHomes.length, _homes: homes.length,
  };
}

// 別表タイトル → namespace用の番号文字列（worker と同一ロジック）。「別表第一」→"1"、「別表二の二」→"2_2"、「別表」→""
function canonNum(title) {
  let name = String(title || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (!name.startsWith('別表')) return '';
  let rest = name.slice(2).replace(/^第/, '');
  const m = rest.match(/^([0-9一二三四五六七八九十百千]+)/);
  if (!m) return '';
  let n = '' + parseNum(m[1]);
  rest = rest.slice(m[0].length);
  const bm = rest.match(/^[のノ]([0-9一二三四五六七八九十百千]+)/);
  if (bm) n += '_' + parseNum(bm[1]);
  return n;
}
function nsOf(lawId, title) { return `bpr_${lawId}_b${canonNum(title)}`; }
const isBigTable = (art) => String(art.title || '').startsWith('別表') && (art.full_text || '').length >= MIN_CHARS;

// 行を「親見出し＋子(イロハ税率)」のグループ単位にまとめる（contextual chunking）。
// 例: 登録免許税別表第一は「（二）所有権の移転の登記」(税率なし) の下に「イ 相続…千分の四 / ハ その他…千分の二十」が
//   別itemで並ぶ。バラだと"所有権移転"の語と税率が別々の行に散り、検索でも答えでも噛み合わない。
//   そこで （N）見出し＋その配下のイロハを1チャンクに連結し、上位見出し(一 不動産の登記)も前置きする。
//   フラットな表(関税定率法の品目一覧 等)は各itemがそのまま1グループになる。
function buildRows(lawId, art) {
  const ns = nsOf(lawId, art.title);
  const out = [];
  let section = '';   // 直近の上位見出し（純漢数字タイトル）
  let group = null;   // { idx, parts:[] }
  let gi = 0, n = 0;
  const flush = () => {
    if (!group) return;
    const sec = section ? section.slice(0, SECTION_MAX) : '';
    const text = [sec, ...group.parts].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, ROW_TEXT_MAX);
    if (text) { gi++; out.push({ id: `${lawId}_${art.title}_g${gi}`, ns, text, metadata: { idx: group.idx, t: text } }); }
    group = null;
  };
  for (const p of (art.paragraphs || [])) {
    for (const it of (p.items || [])) {
      n++;
      const title = (it.item_title || '').trim();
      const body = (it.sentences || []).map((s) => s.text || '').join(' ').trim();
      const full = `${title} ${body}`.trim();
      if (!full) continue;
      if (/^[一二三四五六七八九十百]+$/.test(title)) { flush(); section = full; continue; } // 上位見出し
      if (/^[゠-ヿ]$/.test(title)) { // 単一カタカナ＝子(イロハ税率行)
        if (!group) group = { idx: n, parts: [] };
        group.parts.push(full);
      } else { flush(); group = { idx: n, parts: [full] }; } // （N）見出し or 独立行
    }
  }
  flush();
  return out;
}
// 行ベクトルの id（`${lawId}_${title}_g${n}`）→ namespace。id から戻せる（初回に Vectorize の一覧から拾うときに使う）
function rowIdParts(id) {
  const m = String(id).match(/^([0-9A-Za-z]+)_(別表.*)_g(\d+)$/);
  return m ? { lawId: m[1], title: m[2], g: Number(m[3]), ns: nsOf(m[1], m[2]) } : null;
}

module.exports = {
  NS, TEXT_MAX, MIN_CHARS, ROW_TEXT_MAX, SECTION_MAX,
  kanjiToInt, parseNum, intToKanji, homesFromCaption, canonicalAppdx, numToTitle,
  addAppdxHomes, finishAppdxHomes, rowsText, beppyoEntry, canonNum, nsOf, isBigTable, buildRows, rowIdParts,
};
