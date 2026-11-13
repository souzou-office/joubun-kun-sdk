// 裁判例パーサ共通ヘルパ（03_parse.cjs / 04_build_indexes.cjs / lib_list_rows.cjs で共用）
'use strict';

// 全角英数字→半角
function toHalf(s) {
  return String(s || '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 漢数字→整数（「三四」=位取りなし連記、「三十四」=位取り の両対応）
function jpNumToInt(s) {
  const t = toHalf(String(s || '').trim());
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  const D = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十百千]/.test(t)) {
    let out = '';
    for (const ch of t) {
      if (ch in D) out += D[ch];
      else if (/[0-9]/.test(ch)) out += ch;
      else return null;
    }
    return out ? parseInt(out, 10) : null;
  }
  // 位取り（千三百二十四 等）
  let total = 0, cur = 0;
  for (const ch of t) {
    if (ch in D) cur = cur * 10 + D[ch];
    else if (/[0-9]/.test(ch)) cur = cur * 10 + Number(ch);
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    else if (ch === '千') { total += (cur || 1) * 1000; cur = 0; }
    else return null;
  }
  return total + cur;
}

// 和暦→ISO日付（昭和N=1925+N, 平成N=1988+N, 令和N=2018+N）
const ERA_BASE = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };
function warekiToIso(s) {
  const m = toHalf(String(s || '')).match(/(明治|大正|昭和|平成|令和)(元|[0-9]+)年([0-9]+)月([0-9]+)日/);
  if (!m) return null;
  const y = ERA_BASE[m[1]] + (m[2] === '元' ? 1 : parseInt(m[2], 10));
  const mo = String(parseInt(m[3], 10)).padStart(2, '0');
  const d = String(parseInt(m[4], 10)).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

// 裁判所名の分解: 「最高裁判所第三小法廷」「東京高等裁判所 第５刑事部」「長野地方裁判所 松本支部」
function parseCourt(raw, extraBu) {
  const s = String(raw || '').replace(/[\s　]+/g, ' ').trim();
  if (!s) return { court: null, branch: null, courtDetail: null };
  const m = s.match(/^(.*?(?:最高裁判所|高等裁判所|地方裁判所|家庭裁判所|簡易裁判所|裁判所))/);
  const court = m ? m[1] : s;
  const rest = s.slice(court.length);
  const bm = rest.match(/([^\s　]*支部)/);
  const parts = [s];
  if (extraBu) parts.push(String(extraBu).trim());
  return { court, branch: bm ? bm[1] : null, courtDetail: parts.join(' ').trim() };
}

// caseno_index 用の裁判所キー（空白除去: 「福岡高等裁判所 宮崎支部」→「福岡高等裁判所宮崎支部」）
function courtKey(court, branch) {
  return `${court || ''}${branch || ''}`.replace(/[\s　]/g, '');
}

// date_index 用の裁判所種別
function classifyCourt(court) {
  const c = String(court || '');
  if (/最高裁判所/.test(c)) return '最高裁';
  if (/高等裁判所/.test(c)) return '高裁';
  if (/地方裁判所/.test(c)) return '地裁';
  if (/家庭裁判所/.test(c)) return '家裁';
  if (/簡易裁判所/.test(c)) return '簡裁';
  return null;
}

// detailN → コレクション名
const DETAILN_COLLECTION = { 2: 'saikosai', 3: 'kosai', 4: 'sokuho', 5: 'gyosei', 6: 'rodo', 7: 'chizai', 8: 'chizai' };

// HTMLエンティティの最小デコード
function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;|&emsp;|&ensp;|&thinsp;|&#8201;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

module.exports = {
  toHalf, jpNumToInt, warekiToIso, parseCourt, courtKey, classifyCourt,
  DETAILN_COLLECTION, decodeEntities,
};
