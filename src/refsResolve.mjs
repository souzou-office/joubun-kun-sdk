// refs（参照関係）の補完。抽出（scripts/rebuild/lib/refs_extract.cjs）・画面（src/App.jsx）・
// 条文ページ（worker/lawpages.js）で同じものを使う。依存なし・純関数。
//
// 何をするか:
//   lawtext は「民事訴訟法第百三十三条第一項中…同条第三項中…」の「同条第三項」を、民訴法への参照（法令 ID あり）として
//   拾うが、条番号を持たない（第 3 項だけ）。画面はこれまで「条番号のない他法令参照」を捨てていたので、
//   準用・読み替えの条文（借地借家法 61 条など）でリンクがごっそり抜けていた。
//   ここでは、同じ項（号・副号）の中で直前に出た同じ法令の条番号を引き継がせる。「同項」は項番号も引き継ぐ。
//   自法令の「前項」「同項」は触らない（画面が今の条に落とす既存の扱いのまま）。

const KANJI = { '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
export function kanjiToNumber(str) {
  let result = 0, temp = 0;
  for (const ch of String(str || '')) {
    if (ch === '千') { temp = (temp || 1) * 1000; result += temp; temp = 0; }
    else if (ch === '百') { temp = (temp || 1) * 100; result += temp; temp = 0; }
    else if (ch === '十') { temp = (temp || 1) * 10; result += temp; temp = 0; }
    else if (KANJI[ch] !== undefined) temp = temp * 10 + KANJI[ch];
    else if (/[0-9]/.test(ch)) temp = temp * 10 + Number(ch);
  }
  return result + temp;
}

const norm = (v) => (v == null ? '' : String(v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const sortKey = (r) => [num(r.paragraph), num(r.item), num(r.subitem), num(r.subsubitem), r.sentence_index == null ? -1 : num(r.sentence_index), num(r.start)];
function cmpKey(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }
const sameContainer = (a, b) => norm(a.paragraph) === norm(b.paragraph) && norm(a.item) === norm(b.item)
  && norm(a.subitem) === norm(b.subitem) && norm(a.subsubitem) === norm(b.subsubitem);

// 条番号を引き継ぐ対象: 他法令への参照で、条も別表も無く、文字が「同条」「同項」「第N項」「第N号」で始まるもの
export function needsCarry(r, selfLawId) {
  if (!r || typeof r !== 'object' || r.type === 'varref') return false;
  if (r.target_article || r.target_appdx) return false;
  if (!r.target_law_id || (selfLawId && r.target_law_id === selfLawId)) return false;
  return /^(同条|同項|第[一二三四五六七八九十百千〇0-9]+[項号])/.test(String(r.text || ''));
}

// refs（1 条分の配列）を写して、条番号のない他法令参照に直前の条番号を入れて返す。元の配列は変えない
export function fillRelativeRefs(refs, selfLawId) {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const out = refs.map((r) => (r && typeof r === 'object' ? { ...r } : r));
  const order = out.map((_, i) => i).filter((i) => out[i] && typeof out[i] === 'object')
    .sort((a, b) => cmpKey(sortKey(out[a]), sortKey(out[b])) || a - b);
  for (let k = 0; k < order.length; k++) {
    const r = out[order[k]];
    if (!needsCarry(r, selfLawId)) continue;
    for (let j = k - 1; j >= 0; j--) {
      const p = out[order[j]];
      if (!sameContainer(p, r)) break;   // 引き継ぐのは同じ項（号）の中だけ
      // 略称（varref）と「」内の読み替え文言（quoted）は文脈にしない（「同条」は鉤括弧の外の流れを受ける）
      if (p.type === 'varref' || p.quoted || p.target_law_id !== r.target_law_id) continue;
      // 同じ法令の「前条」「次条」（条番号が解決されていない）を越えて引き継がない（「同条」はその前条を受けるので）
      if (!p.target_article && /^(前|次|前々)条/.test(String(p.text || ''))) break;
      if (!p.target_article) continue;
      r.target_article = p.target_article;
      // 「同項」は項も引き継ぐ。号だけ（「第一項第四号及び第五号ロ」の「第五号ロ」）も直前の項を受ける
      const t = String(r.text || '');
      if (!r.target_paragraph && p.target_paragraph && (/^同項/.test(t) || (r.target_item && /^第[一二三四五六七八九十百千〇0-9]+号/.test(t)))) r.target_paragraph = p.target_paragraph;
      r.carried = true;
      break;
    }
  }
  return out;
}
