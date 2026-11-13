// 共通ユーティリティ: 漢数字パース / ポインタ文字列解析 / 法令走査 / 委任種別
'use strict';
const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');

// 置き場は環境変数 DELEG_REBUILD_DIR で差し替えられる（check_link_patterns.cjs が固定データで ¥0 検査するため）
const REBUILD = process.env.DELEG_REBUILD_DIR || `${SITE.localDataRoot}/rebuild_output`;
const FETCHED_DIR = path.join(REBUILD, 'fetched_laws');
const DELEG_DIR = path.join(REBUILD, 'delegations');

// ---------------- 漢数字 ----------------
const KD = { '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
function kanjiToInt(s) {
  if (!s) return null;
  let n = 0, cur = 0, any = false;
  for (const ch of s) {
    if (ch === '千') { n += (cur || 1) * 1000; cur = 0; any = true; }
    else if (ch === '百') { n += (cur || 1) * 100; cur = 0; any = true; }
    else if (ch === '十') { n += (cur || 1) * 10; cur = 0; any = true; }
    else if (KD[ch] != null) { cur = KD[ch]; any = true; }
    else return null;
  }
  return any ? n + cur : null;
}

const KNUM = '[〇一二三四五六七八九十百千]+';

// ポインタ文字列 (例: 「第二条第十号」「第六十六条の四第一項」) から条・項・号を抽出
// 「第X号から第Y号まで」の範囲は item_range として返す
function parsePointerText(text) {
  const out = { article: null, paragraph: null, item: null, item_range: null };
  if (!text) return out;
  const artRe = new RegExp(`第(${KNUM})条((?:の${KNUM})*)`, 'g');
  const m = artRe.exec(text);
  if (m) {
    let a = String(kanjiToInt(m[1]));
    if (m[2]) {
      for (const sub of m[2].split('の').filter(Boolean)) a += '_' + kanjiToInt(sub);
    }
    out.article = a;
  }
  const paraRe = new RegExp(`第(${KNUM})項`, 'g');
  const pm = paraRe.exec(text);
  if (pm) out.paragraph = String(kanjiToInt(pm[1]));
  // 号 (枝番対応)。範囲「第X号から第Y号まで」を検出
  const itemRe = new RegExp(`第(${KNUM})号((?:の${KNUM})*)`, 'g');
  const items = [];
  let im;
  while ((im = itemRe.exec(text)) !== null) {
    let it = String(kanjiToInt(im[1]));
    if (im[2]) for (const sub of im[2].split('の').filter(Boolean)) it += '_' + kanjiToInt(sub);
    items.push({ v: it, idx: im.index, len: im[0].length });
  }
  if (items.length === 1) out.item = items[0].v;
  else if (items.length >= 2) {
    const between = text.substring(items[0].idx + items[0].len, items[1].idx);
    if (/から/.test(between) && /まで/.test(text.substring(items[1].idx))) {
      out.item_range = [items[0].v, items[1].v];
    } else {
      out.item = items[0].v; // 併記は先頭を採用し ambiguous 扱いにしない (稀)
      out.item_range = items.map(x => x.v);
    }
  }
  return out;
}

// "66_4" 形式の番号を数値配列に
function numKey(numStr) {
  return String(numStr || '').split('_').map(x => parseInt(x, 10) || 0);
}
function cmpNum(a, b) {
  const A = numKey(a), B = numKey(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// item が範囲 [lo, hi] に入るか (主番号で比較)
function itemInRange(item, range) {
  if (!item || !range) return false;
  return cmpNum(item, range[0]) >= 0 && cmpNum(item, range[1]) <= 0;
}

// ---------------- 委任種別 ----------------
// 長いものから先にマッチさせる
const KIND_CORE =
  '(?:[一-龠]{2,10}委員会規則|人事院規則|会計検査院規則|最高裁判所規則|内閣府令|内閣官房令|デジタル庁令|復興庁令|防災庁令|[一-龠]{1,6}省令|政令|勅令|規則|命令|告示)';

// 「当該」「同」等の指示語プレフィクスを剥がす
function normalizeKindToken(tok) {
  return tok.replace(/^(?:当該|同|その|各|前項の|前条の)/, '');
}

function kindBucket(tok) {
  const t = normalizeKindToken(tok);
  if (/政令$/.test(t) || t === '勅令') return '政令';
  if (t === '内閣府令' || t === '内閣官房令') return '内閣府令';
  if (t === '財務省令' || t === '大蔵省令') return '財務省令';
  if (t === '主務省令') return '主務省令';
  if (/省令$/.test(t)) return '省令';
  if (/委員会規則$/.test(t) || t === '人事院規則' || t === '会計検査院規則' || t === '最高裁判所規則') return '委員会規則';
  if (t === '規則') return '規則';
  if (t === '告示') return '告示';
  if (t === '命令' || t === '主務命令') return '命令';
  if (t === 'デジタル庁令' || t === '復興庁令' || t === '防災庁令') return '内閣府令'; // 庁令は府令バケツに寄せる（防災庁令は 2026-11-02 の防災庁設置法の施行から。災害対策基本法などの「内閣府令で定める」が置き換わった）
  return t;
}

// 委任表現の正規表現 (現代文 + 旧カナ + 大臣告示)
// グループ: 1=修飾(別に等) 2=種別トークン 3=挿入括弧 4=動詞部
const DELEG_RE = new RegExp(
  `(別に|別段の定めがある場合を除き、?)?` +
  `((?:当該|同)?${KIND_CORE}(?:[・、]${KIND_CORE})*(?:又は${KIND_CORE})?)` +
  `(（[^（）]{1,60}）)?` +
  `(で(?:別段の)?定める|の定めるところ|に委任|をもつて定める|をもって定める|で、定める)`,
  'g'
);
// 旧カナ (商法等): 「勅令ヲ以テ定ム」「命令ノ定ムル所ニ依リ」
const DELEG_RE_KANA = new RegExp(
  `(別ニ)?((?:政令|勅令|命令|省令|規則|告示))(（[^（）]{1,60}）)?(ヲ以テ|ノ定ムル所ニ依リ|ニ委任)`,
  'g'
);
// 大臣告示: 「財務大臣が告示する割合」「厚生労働大臣が定める基準」
const DELEG_RE_KOKUJI = new RegExp(
  `()([一-龠]{2,8}大臣|[一-龠]{2,6}庁長官)()(が告示する|の告示で定める|が定める)`,
  'g'
);

// 文中の委任表現を列挙
function findDelegations(text) {
  const out = [];
  for (const [re, fixedKind] of [[DELEG_RE, null], [DELEG_RE_KANA, null], [DELEG_RE_KOKUJI, '告示']]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const kindsRaw = m[2];
      let kind = fixedKind;
      if (!kind) {
        const firstKind = kindsRaw.match(new RegExp(KIND_CORE));
        kind = kindBucket(firstKind ? firstKind[0] : kindsRaw);
      }
      // 「省令」単独で前が「主務」等に切れていないか確認済 (KIND_CORE が長優先)
      const start = m.index + (m[1] ? m[1].length : 0);
      // 直前が「に規定する」「の規定により」等なら、それは他条の委任への言及 (受け皿側の引用) であって
      // この文自身の委任ではないので抽出しない (施行令の受け皿文が自分の委任として二重計上されるのを防ぐ)
      const before = text.substring(Math.max(0, m.index - 10), m.index);
      if (/(に規定する|の規定により|の規定に基づく|の規定による)$/.test(before)) continue;
      out.push({
        expr: kindsRaw + (m[3] || '') + m[4],
        offset: [start, m.index + m[0].length],
        kind,
        kind_raw: normalizeKindToken(kindsRaw),
        joint: /[・、]|又は/.test(kindsRaw),
      });
    }
  }
  out.sort((a, b) => a.offset[0] - b.offset[0]);
  return out;
}

// ---------------- 法令走査 ----------------
function loadLaw(lawId) {
  return JSON.parse(fs.readFileSync(path.join(FETCHED_DIR, lawId + '.json'), 'utf-8'));
}

// articles 配列の本則/附則境界を検出 (XML文書順: 本則→附則。番号の逆行/重複で境界)
function markProvisions(articles) {
  let suppl = false, prev = null;
  const seen = new Set();
  return articles.map(a => {
    if (a.type !== 'article') return { ...a, provision: 'appdx' };
    const n = a.number;
    if (!suppl && prev !== null && n != null && (seen.has(n) || cmpNum(n, prev) <= 0)) suppl = true;
    if (n != null) { seen.add(n); prev = n; }
    return { ...a, provision: suppl ? 'suppl' : 'main' };
  });
}

// 全センテンスを {article, paragraph, item, subitem, sidx, text, provision} で列挙
function* walkSentences(law) {
  const arts = markProvisions(law.articles || []);
  for (const a of arts) {
    if (a.type !== 'article') continue;
    for (const p of a.paragraphs || []) {
      for (let si = 0; si < (p.sentences || []).length; si++) {
        yield { article: a.number, articleTitle: a.title, caption: a.caption || null, provision: a.provision, paragraph: p.num, item: null, subitem: null, sidx: si, text: p.sentences[si].text };
      }
      yield* walkItems(a, p, p.items || [], null);
    }
  }
}
function* walkItems(a, p, items, parentPath) {
  for (const it of items) {
    const itemNum = parentPath ? parentPath.item : it.item_num;
    const subPath = parentPath ? [...parentPath.subs, it.subitem_num || it.item_num] : null;
    for (let si = 0; si < (it.sentences || []).length; si++) {
      yield {
        article: a.number, articleTitle: a.title, caption: a.caption || null, provision: a.provision,
        paragraph: p.num, item: itemNum, subitem: subPath ? subPath.join('/') : null, sidx: si,
        text: it.sentences[si].text,
      };
    }
    if (it.sub_items && it.sub_items.length) {
      yield* walkItems(a, p, it.sub_items, { item: itemNum, subs: subPath || [] });
    }
  }
}

// 法令の種別 (law_num 文字列から。ただし題名が内閣府令ならそれを優先:
// 省庁再編で旧大蔵省令等から内閣府令に改題された法令は law_num が旧省令のままのため)
function lawKindOf(law) {
  if (/内閣府令$/.test(law.law_title || '')) return '内閣府令';
  const n = law.law_num || '';
  if (/政令/.test(n)) return '政令';
  if (/勅令/.test(n)) return '政令';
  if (/内閣府令|総理府令/.test(n)) return '内閣府令';
  if (/財務省令|大蔵省令/.test(n)) return '財務省令';
  if (/省令/.test(n)) return '省令';
  if (/規則/.test(n)) return '委員会規則・規則';
  if (/法律/.test(n)) return '法律';
  return law.law_type || 'その他';
}

// 委任種別バケツ → 受け皿になり得る子法令種別
function kindAccepts(delegKind, childKind) {
  switch (delegKind) {
    case '政令': return childKind === '政令';
    case '内閣府令': return childKind === '内閣府令';
    case '財務省令': return childKind === '財務省令';
    case '主務省令': return childKind === '省令' || childKind === '財務省令' || childKind === '内閣府令';
    case '省令': return childKind === '省令' || childKind === '財務省令';
    case '委員会規則': case '規則': return childKind === '委員会規則・規則';
    case '命令': return childKind !== '法律';
    case '告示': return false; // 告示は法令DBに無い
    default: return false;
  }
}

// 括弧をスキップして実効的な後続テキストを得る (ネスト対応)
function skipParens(text, from) {
  let i = from, depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '（' || ch === '(') depth++;
    else if (ch === '）' || ch === ')') { depth--; i++; if (depth <= 0 && (text[i] !== '（' && text[i] !== '(')) break; continue; }
    else if (depth === 0) break;
    i++;
  }
  return i;
}

// 括弧内を除去したテキストを返す (offset 対応不要な用途向け)
function stripParens(text) {
  let out = '', depth = 0;
  for (const ch of text) {
    if (ch === '（' || ch === '(') depth++;
    else if (ch === '）' || ch === ')') { if (depth > 0) depth--; continue; }
    else if (depth === 0) out += ch;
  }
  return out;
}

// ---------------- 法令単位の受け皿（2026-09-22） ----------------
// 「必要な事項は、政令で定める。」のような包括委任は受け皿の条が無い。親法令に専属の施行令・施行規則
// （題名が「{親の題名}施行令」「{親の題名}施行規則」で 1 本に決まるもの）があれば、条ではなく法令へのリンクにする。
// 題名 → law_id は src/lawIds.js（8,963 本の静的表）。検査用に DELEG_LAW_TITLES_JSON（{題名: law_id} の JSON）で差し替えられる
let _titleIndex = null;
function lawTitleIndex() {
  if (_titleIndex) return _titleIndex;
  _titleIndex = new Map();
  if (process.env.DELEG_LAW_TITLES_JSON) {
    for (const [t, id] of Object.entries(JSON.parse(fs.readFileSync(process.env.DELEG_LAW_TITLES_JSON, 'utf8')))) _titleIndex.set(t, String(id));
    return _titleIndex;
  }
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'lawIds.js'), 'utf8');
  for (const m of src.matchAll(/"([^"]+)":"([0-9A-Za-z]+)"/g)) _titleIndex.set(m[1], m[2]);
  return _titleIndex;
}
// 委任種別に対応する専属の子法令。無ければ null。政令 → 施行令、省令系（省令・財務省令・主務省令・内閣府令・命令）→ 施行規則。
// 子法令の種別（法令番号から。kindAccepts と同じ判定）が委任種別に合わないときも null（「内閣府令で定める」に法務省令の施行規則を当てない）。
// 子の本文（FETCHED_DIR）が読めないときも null（種別を確かめられないので付けない）
const _childKindCache = new Map();
function dedicatedChildLaw(parentTitle, delegKind) {
  if (!parentTitle) return null;
  const suffix = delegKind === '政令' ? '施行令'
    : (delegKind === '省令' || delegKind === '財務省令' || delegKind === '主務省令' || delegKind === '内閣府令' || delegKind === '命令') ? '施行規則'
      : null;
  if (!suffix) return null;
  const title = parentTitle + suffix;
  const id = lawTitleIndex().get(title);
  if (!id) return null;
  if (!_childKindCache.has(id)) {
    let kind = null;
    try { kind = lawKindOf(loadLaw(id)); } catch { kind = null; }
    _childKindCache.set(id, kind);
  }
  const childKind = _childKindCache.get(id);
  if (!childKind || !kindAccepts(delegKind, childKind)) return null;
  return { law_id: id, law_title: title };
}

module.exports = {
  REBUILD, FETCHED_DIR, DELEG_DIR,
  lawTitleIndex, dedicatedChildLaw,
  kanjiToInt, KNUM, parsePointerText, cmpNum, itemInRange,
  KIND_CORE, kindBucket, normalizeKindToken, findDelegations,
  loadLaw, markProvisions, walkSentences, lawKindOf, kindAccepts,
  skipParens, stripParens,
};
