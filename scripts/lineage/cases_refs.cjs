// 裁決・質疑応答事例の条文リンクを、引用ごとの「どの版の条か」付きで書き出す（読むだけ・測定用）
//
//   node scripts/lineage/cases_refs.cjs <R2 の写しのフォルダ> <出力 .ndjson>
//     写しのフォルダ: saiketsu_v1/cases_*.json・shitsugi_v1/cases_*.json・article_links_v1/*.json（本番 R2 の写し）
//
// 1 行 = 1 本の条文リンク（article_links_v1 にある、原文の引用から付いたもの）:
//   {k:'s'|'j', id, date, law_id, art, src, occ:[{before:[改正法], how}], scanned}
//   date: 裁決日／事例の「○年○月○日現在」（ISO）
//   occ: 本文の中のその条の引用ごとに、判断が使った版の手がかり
//     how: 'explicit'（法令名の直後の「（…法律第N号による改正前のもの）」・「…による改正前の○○法」）
//          'defined'（前に「（…改正前のもの。以下同じ。）」と定めた法令の、後の引用）
//          'abbr'（「以下『旧○○法』という」と定めた略称の引用）
//          'old'（「旧○○法」「改正前の○○法」で、どの改正の前か書いていない）
//          'current'（手がかり無し＝判断の日の版）
//          'shikorei'（「措置法施行令第26条」を今の抽出が「措置法」の第26条と読んだもの。版の問題ではなく読み取りの誤り）
//          'tailname'（「臨時措置法第14条」を通称「措置法」の末尾一致で租税特別措置法と読んだもの。同じく読み取りの誤り）
//   caption: 引用の直後の《見出し》（判断のときの条の見出し。系譜の答え合わせに使う）
//   scanned: 下の走査で、この条の引用を本文に見つけられたか（見つからなければ occ は空で、判断の日の版で引く）
//
// 条文リンクそのもの（どの条に付いているか）は今の実物（scripts/saiketsu/04_relink_from_r2.cjs の linkSaiketsu・
// 事例の関係法令欄の anchors）をそのまま使う。ここで足すのは「その引用がどの版か」だけ。
// 走査は scripts/shitsugi/03_parse.cjs の scanLawArticles と同じ進み方で、改正前の手がかりを拾うところだけ足している
// （本番に入れるときは 03_parse.cjs 側に before を残す形にする。docs/lineage.md の「裁決と質疑応答事例」）。
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const { linkSaiketsu } = require('../saiketsu/04_relink_from_r2.cjs');
const { loadLawIds } = require('../shitsugi/03_parse.cjs');

// 03_parse.cjs の名前の索引（buildNameIndex）は外に出していないので、同じファイルを読み込んで取り出す（測定用。写しは書かない）
function loadNameIndex(ALL) {
  const file = path.join(ROOT, 'scripts', 'shitsugi', '03_parse.cjs');
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.__buildNameIndex = buildNameIndex;\n', file);
  return m.exports.__buildNameIndex(ALL);
}

const KAN = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function jpNum(s) {
  s = String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '元') return 1;
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in KAN) cur = KAN[ch];
    else if (ch === '十' || ch === '百' || ch === '千') { total += (cur || 1) * { 十: 10, 百: 100, 千: 1000 }[ch]; cur = 0; }
    else return null;
  }
  return total + cur;
}
// 判例の 03_parse.cjs の beforeOf と同じ形（'平成23年法律第114号'）
const BEFORE_RE = /(明治|大正|昭和|平成|令和)([０-９0-9一二三四五六七八九十元]+)年(?:[０-９0-9一二三四五六七八九十]+月(?:[０-９0-9一二三四五六七八九十]+日)?)?法律第([０-９0-9一二三四五六七八九十百千]+)号(?:[^（）。]{0,40}?)による改正前/g;
function beforeOf(s) {
  const out = [];
  for (const m of String(s || '').matchAll(BEFORE_RE)) {
    const y = jpNum(m[2]), n = jpNum(m[3]);
    if (y && n) out.push(`${m[1]}${y}年法律第${n}号`);
  }
  return out;
}
const ERA = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };
function isoDate(s) {
  const m = String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).match(/(明治|大正|昭和|平成|令和)(\d+|元)年(\d+)月(\d+)日/);
  if (!m) return null;
  const y = ERA[m[1]] + (m[2] === '元' ? 1 : Number(m[2]));
  return `${y}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`;
}
// R2 の裁決の本文には「&#12298;」（《）のような文字参照が残っているものがあるので戻す
const normNum = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\(/g, '（').replace(/\)/g, '）');
// 文に分ける（「。」で切るが、括弧の中の「。」では切らない＝「（…改正前のもの。以下同じ。）」を 1 つの文に残す）
function sentences(text) {
  const out = []; let cur = '', depth = 0;
  for (const ch of text) {
    if (ch === '（') depth++;
    else if (ch === '）' && depth > 0) depth--;
    if (ch === '\n' || (ch === '。' && depth === 0)) { out.push(cur); cur = ''; if (ch === '\n') depth = 0; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
const flatten = (secs) => { let s = ''; for (const x of (secs || [])) s += '\n' + (x.head || '') + '\n' + (x.text || '') + flatten(x.children); return s; };

// 03_parse.cjs の LAW_ALIASES のうち、ほかの法令の名前の末尾にもなる短い通称
const SHORT_ALIASES = new Set(['措置法', '措法', '通則法']);

// 文書全体から「X法（…改正前のもの。以下「旧X法」という。）」の略称を拾う → 略称 → {law, acts}
function abbrDefs(text, idx) {
  const out = new Map();
  for (const m of text.matchAll(/([^\s、。「」（）]{2,40}?)（([^（）]*?改正前[^（）]*?)以下、?「([^」]{1,15})」という/g)) {
    const law = idx.findTail(m[1], null);
    const acts = beforeOf(m[2]);
    if (law && acts.length) out.set(m[3], { law, acts });
  }
  return out;
}

// 1 つの文書（裁決は要旨と本文・事例は関係法令欄）を走査して、法令 ID:条 → 引用ごとの手がかり
function scanDoc(text, idx, ALL) {
  const occ = new Map();
  const defs = new Map();   // law_id → acts（法令名の直後の「（…改正前のもの。以下同じ。）」）
  const defsArt = new Map();   // 'law_id:条' → acts（条の直後の「（…改正前のもの。以下同じ。）」）
  const abbr = abbrDefs(normNum(text), idx);
  const { map, findAt, findTail } = idx;
  for (const line of sentences(normNum(text))) {
    let seg = line.trim();
    if (!seg || !/第\d+(?:の\d+)*条/.test(seg)) {
      // 条番号の無い行にも「（…改正前のもの。以下同じ。）」の定めはある
      for (const m of seg.matchAll(/([^\s、。「」（）]{2,40}?)（([^（）]*?改正前[^（）]*?以下同じ[^（）]*?)）/g)) {
        const law = findTail(m[1], null); const acts = beforeOf(m[2]);
        if (law && acts.length) defs.set(map[law], acts);
      }
      continue;
    }
    // 改正前の括弧は印に置き換え（後で法令名に結び付ける）、ほかの法令番号の括弧は今の抽出と同じく落とす
    seg = seg.replace(/（([^）]*改正前[^）]*)）/g, (all, inner) => {
      const acts = beforeOf(inner);
      if (!acts.length) return all;
      return `〈B${acts.join('+')}${/以下同じ/.test(inner) ? '|I' : ''}〉`;
    }).replace(/（[^）]*(?:法律|政令|省令|勅令|府令|規則)第\d+号[^）]*）/g, '').replace(/《([^》]*)》/g, (all, c) => `〈C${c.replace(/[〈〉]/g, '')}〉`);
    let curLaw = null, curId = null, ctx = null, last = null, lastEnd = -1, lastKey = null;   // last: 直前に積んだ引用（「第65条（…改正前のもの）」の形）
    let i = 0;
    while (i < seg.length) {
      if (seg[i] === '〈' && seg[i + 1] === 'C') {   // 《見出し》（判断のときの条の見出し。答え合わせに使う）
        const e = seg.indexOf('〉', i);
        if (last && !last.caption && lastEnd === i) last.caption = seg.slice(i + 2, e);
        i = e + 1; continue;
      }
      if (seg[i] === '〈' && seg[i + 1] === 'B') {
        const e = seg.indexOf('〉', i);
        const body = seg.slice(i + 2, e);
        const [a, flag] = body.split('|');
        if (curLaw && last) {
          // 条の直後の括弧（「第41条の5（…改正前のもの。以下同じ。）」）は、その条だけの定め
          last.before = a.split('+'); last.how = 'explicit';
          if (flag === 'I') defsArt.set(lastKey, last.before);
        } else if (curLaw) {
          // 法令名の直後の括弧（「所得税法（…改正前のもの。以下同じ。）」）は、その法令の後の引用すべてに効く
          ctx = { before: a.split('+'), how: 'explicit' };
          if (flag === 'I') defs.set(curId, ctx.before);
        }
        i = e + 1; continue;
      }
      const tsu = seg.slice(i).match(/^[^、,，]{0,30}?通達/);
      if (tsu && !/第\d+(?:の\d+)*条/.test(tsu[0])) { curLaw = null; curId = null; i += tsu[0].length; continue; }
      if (seg.startsWith('附則', i)) { curLaw = null; curId = null; i += 2; continue; }
      const conj = seg.slice(i).match(/^(?:及び|並びに|又は|若しくは|、|,|，|・|かつ|ならびに)/);
      if (conj) { i += conj[0].length; continue; }
      const m = seg.slice(i).match(/^第?(\d+(?:の\d+)*)条((?:の\d+)*)((?:第\d+項)*(?:第\d+(?:の\d+)*号)*)/);
      if (m) {
        if (curLaw && curId) {
          const k = `${curId}:${m[1] + (m[2] || '')}`;
          if (!occ.has(k)) occ.set(k, []);
          last = { ...(ctx || (defsArt.has(k) ? { before: defsArt.get(k), how: 'defined' } : { before: [], how: 'current' })) };
          occ.get(k).push(last);
          lastEnd = i + m[0].length; lastKey = k;
        }
        i += m[0].length; continue;
      }
      const token = (seg.slice(i).match(/^(?!及び|並びに|又は|若しくは)[^、,，。\s〈]{2,60}?(?:条約|協定|法律|省令|政令|規則|規程|法|令)(?=第|、|,|，|。|\s|〈|$)/) || [])[0] || null;
      const hit = findAt(seg, i);
      const pre = seg.slice(Math.max(0, i - 40), i);
      if (!/^第?\d/.test(seg.slice(i))) last = null;
      if (hit && abbr.has(hit) && !(token && token.length > hit.length && token.startsWith(hit))) {
        // 「以下「措置法」という」と定めた略称が、今の法令の通称と同じ字のとき
        const ab = abbr.get(hit);
        curLaw = ab.law; curId = map[ab.law]; ctx = { before: ab.acts, how: 'abbr' };
        i += hit.length; continue;
      }
      if (hit) {
        curLaw = hit; curId = map[hit];
        const glue = token && token.length > hit.length && token.startsWith(hit);
        const rest = glue ? token.slice(hit.length) : '';
        const restIsOtherLaw = glue && !!findTail(rest, hit);
        i += (glue && !restIsOtherLaw) ? token.length : hit.length;
        if (/改正前の$/.test(pre)) ctx = beforeOf(pre).length ? { before: beforeOf(pre), how: 'explicit' } : { before: [], how: 'old' };
        else if (/旧$/.test(pre)) ctx = { before: [], how: 'old' };
        else if (/(改正後の|現行の|現行)$/.test(pre)) ctx = { before: [], how: 'current' };
        else if (defs.has(curId)) ctx = { before: defs.get(curId), how: 'defined' };
        else ctx = null;
        // 今の抽出は「措置法施行令」を既知の略称「措置法」＋残りとして丸ごと飲み込み、施行令の条を法律の条に付ける。その印
        //   「国税通則法施行令（以下「通則法施行令」という。）第6条」のように、略称の後ろが「施行令」で続くものも同じ
        if (/^施行(?:令|規則|規程)/.test(glue && !restIsOtherLaw ? rest : seg.slice(i))) ctx = { before: [], how: 'shikorei' };
        continue;
      }
      if (token) {
        const ab = abbr.get(token);
        const tail = ab ? ab.law : findTail(token, null);
        if (tail) {
          curLaw = tail; curId = map[tail];
          const prefix = token.slice(0, token.length - tail.length);
          if (ab) ctx = { before: ab.acts, how: 'abbr' };
          // 「臨時措置法」「…特別措置法」を通称「措置法」（租税特別措置法）の末尾一致で読んだもの。版の問題ではなく読み取りの誤り
          //   名前の一部とみるのは、通称の直前が漢字のとき（「請求人に通則法」の「に」は名前の一部ではない）。「改正前」「旧」「新」「現行」は除く
          else if (SHORT_ALIASES.has(tail) && /[一-龥々]$/.test(prefix) && !/(?:旧|新|現行|改正[前後])$/.test(prefix)) ctx = { before: [], how: 'tailname' };
          else if (/^旧|改正前/.test(token)) ctx = beforeOf(token).length ? { before: beforeOf(token), how: 'explicit' } : { before: [], how: 'old' };
          else if (defs.has(curId)) ctx = { before: defs.get(curId), how: 'defined' };
          else ctx = null;
        } else { curLaw = null; curId = null; ctx = null; }
        i += token.length; continue;
      }
      i++;
    }
  }
  return occ;
}

function main() {
  const [dir, outFile] = process.argv.slice(2);
  if (!dir || !outFile) { console.error('使い方: node scripts/lineage/cases_refs.cjs <R2 の写し> <出力 .ndjson>'); process.exit(1); }
  const ALL = loadLawIds();
  const idx = loadNameIndex(ALL);
  const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  // 今の本番の条文リンク（原文の引用から付いたものだけ。LLM の割当と通達の帰属条は今の条に対して付けたので対象外）
  const links = new Map();   // `${k}|${id}` → [{law_id, art, src}]
  const alDir = path.join(dir, 'article_links_v1');
  for (const f of fs.readdirSync(alDir)) {
    if (!f.endsWith('.json') || f === '_cases.json') continue;
    const lawId = f.slice(0, -5);
    for (const [art, arr] of Object.entries(rd(path.join(alDir, f)))) {
      for (const x of arr) {
        if (!['kankei', 'abstract', 'body'].includes(x.s)) continue;
        const key = `${x.k}|${x.i}`;
        if (!links.has(key)) links.set(key, []);
        links.get(key).push({ law_id: lawId, art, src: x.s });
      }
    }
  }
  const out = [];
  const st = { s: 0, j: 0, links: 0, scanned: 0, nodate: 0 };
  // 裁決
  const saDir = path.join(dir, 'saiketsu_v1');
  for (const f of fs.readdirSync(saDir).filter((x) => /^cases_.*\.json$/.test(x))) {
    for (const it of Object.values(rd(path.join(saDir, f)))) {
      if (!it || !it.id) continue;
      const ls = links.get(`s|${it.id}`);
      if (!ls) continue;
      st.s++;
      const date = isoDate(it.date) || isoDate((it.title || '').match(/(?:昭和|平成|令和)[0-9０-９元]+年[0-9０-９]+月[0-9０-９]+日裁決/)?.[0]);
      if (!date) st.nodate++;
      const occ = scanDoc(`${it.title || ''}\n${it.abstract || ''}\n${flatten(it.sections)}`, idx, ALL);
      // 今の抽出が付けるリンクと照らす（R2 の写しの欄の引用は src: kankei）
      const real = new Set(linkSaiketsu(it, ALL).found.map((r) => `${r.law_id}:${r.article}`));
      for (const l of ls) {
        const o = occ.get(`${l.law_id}:${l.art}`) || [];
        st.links++; if (o.length) st.scanned++;
        out.push({ k: 's', id: it.id, date, law_id: l.law_id, art: l.art, src: l.src, occ: o, scanned: o.length > 0, relinked: real.has(`${l.law_id}:${l.art}`) });
      }
    }
  }
  // 質疑応答事例（関係法令欄）
  const shDir = path.join(dir, 'shitsugi_v1');
  for (const f of fs.readdirSync(shDir).filter((x) => /^cases_.*\.json$/.test(x))) {
    for (const it of Object.values(rd(path.join(shDir, f)))) {
      if (!it || !it.id) continue;
      const ls = links.get(`j|${it.id}`);
      if (!ls) continue;
      st.j++;
      const date = isoDate(it.as_of);
      if (!date) st.nodate++;
      const occ = scanDoc((it.kankei_raw || []).join('\n'), idx, ALL);
      for (const l of ls) {
        const o = occ.get(`${l.law_id}:${l.art}`) || [];
        st.links++; if (o.length) st.scanned++;
        out.push({ k: 'j', id: it.id, date, law_id: l.law_id, art: l.art, src: l.src, occ: o, scanned: o.length > 0 });
      }
    }
  }
  fs.writeFileSync(outFile, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
  console.log(JSON.stringify(st));
}

if (require.main === module) main();
module.exports = { beforeOf, isoDate, jpNum, scanDoc, loadNameIndex };
