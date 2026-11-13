// 法令 XML から参照関係（refs）を抽出する本体。lawtext の analysis 出力を使う。
// 08_extract_refs_v2.cjs（全件再構築）と scripts/update/09_refs.cjs（週次更新）の両方がここを使う。
// 出力の形（refs のフィールド）は R2 の refs_chunks_v4 とフロント（App.jsx の renderTextWithRefsLinks）が前提にしているので変えない。
//
//   const { processLawXML, buildLawnameMap } = require('./lib/refs_extract.cjs');
//   const refs = await processLawXML(lawtext, xml, lawId, lawnumMap, lawnameMap);
//     → { "{lawId}_Art{num}": [ { text, paragraph, item?, subitem?, sentence_index, start, end, type, target_law_id, target_article, ... } ] }
//   lawnumMap: { "昭和二十五年法律第百九十七号": { lawId, lawTitle } }
// 共用の補完（src/refsResolve.mjs。画面・条文ページと同じもの）。Node 22.12 以降は require() で ESM を読める
const { fillRelativeRefs, kanjiToNumber } = require('../../../src/refsResolve.mjs');

// ===== 「」内の条文参照は lawtext の文解析（$sentenceChildren ＋ ポインタ検出）で切り分ける =====
// lawtext は鉤括弧（__Parentheses type="square"）の中のポインタ検出を意図的に飛ばす（読み替え後の文言は別の法令に差し込まれる
// 文字列だから）。ここでは鉤括弧の中身だけを同じ文解析にかけて、法令名・法令番号・条・項・号・「及び」「から…まで」・「同条」
// 「この法律」を lawtext に切り分けてもらい、どの法令かの判断だけをこちらでする（正規表現で自前に切ると「及び同項並びに民事訴訟法」
// を法令名に取り込むような穴が出る。2026-09-22 の作り直し）。
// トークナイザは lawtext の内部モジュール（ESM）を動的 import して作る。processLawXML が最初に一度だけ読む
let _quotedTokenizerPromise = null;
async function loadQuotedTokenizer() {
  if (_quotedTokenizerPromise) return _quotedTokenizerPromise;
  _quotedTokenizerPromise = (async () => {
    const { pathToFileURL } = require('url');
    const path = require('path');
    const mainPath = require.resolve('lawtext');                       // …/dist/src/main.js
    const base = pathToFileURL(path.dirname(mainPath) + path.sep);
    const sc = await import(new URL('parser/cst/rules/$sentenceChildren.js', base));
    const { initialEnv } = await import(new URL('parser/cst/env.js', base));
    const { $inlineWithPointerRanges, pointerRangesCandidateChars } = await import(new URL('analyzer/textParser/rules/$pointerRanges.js', base));
    const stopChars = [...new Set(pointerRangesCandidateChars)].join('');
    const options = {
      reParenthesesInlineTextChars: sc.makeReParenthesesInlineTextChars(stopChars),
      reOutsideParenthesesTextChars: sc.makeReOutsideParenthesesTextChars(stopChars),
      rePeriodSentenceTextChars: sc.makeRePeriodSentenceTextChars(stopChars),
      inlineTokenRule: $inlineWithPointerRanges,
      appdxPointers: [],
    };
    // 文字列 → 要素の配列（__Text / __Parentheses / ____PointerRanges …。位置は文字列の先頭からのオフセット）。解析できなければ null
    return (text) => {
      if (!text) return [];
      const r = sc.default.match(0, text, initialEnv({ options, baseOffset: 0 }));
      return r.ok && r.nextOffset === text.length ? r.value.value : null;
    };
  })();
  return _quotedTokenizerPromise;
}

const KNUM = '[一二三四五六七八九十百千〇]+';
// ポインタの断片の名前 → 番号。「第七十条の六の二」→ "70_6_2"、「第三項」→ "3"、「第二号」→ "2"
function fragmentNum(name) {
  const m = String(name || '').match(new RegExp(`^第(${KNUM})(?:条|項|号)((?:の${KNUM})*)$`));
  if (!m) return null;
  const subs = (m[2].match(new RegExp(`の${KNUM}`, 'g')) || []).map((x) => kanjiToNumber(x.slice(1)));
  return [kanjiToNumber(m[1]), ...subs].join('_');
}

// 法令名で law_id を引く（「非訟事件手続法」「借地借家法」など。略称は引かない）。名前の末尾まで一致する候補だけを、
// 先頭を削りながら最長一致で探す（「改正後の借地借家法」→ 借地借家法）。途中で切った「民法の一部を改正する法律」→「民法」のような
// 解決はしない（知らない改正法名を、その中に含まれる別の法令に落とさない）
function resolveLawName(name, lawnameToLawid) {
  if (!name || !lawnameToLawid) return null;
  for (let start = 0; start < name.length; start++) {
    const cand = name.substring(start);
    if (lawnameToLawid[cand]) return { name: cand, ...lawnameToLawid[cand] };
  }
  return null;
}

// 略称宣言（lawtext の declarations。「法」「令」「新法」「準用通則法」など → law_id）で引く。名前の末尾まで一致する候補だけを、
// 先頭を削りながら探すが、略称の直前が漢字なら引かない（「同法」「架空法」「通則法」の「法」を電波法にしない）。
// 「する法」「、法」「法」（先頭）は引く
const isKanji = (ch) => /[一-龥々〆]/.test(ch || '');
function resolveAbbrev(name, abbrevs) {
  if (!name || !abbrevs) return null;
  for (let start = 0; start < name.length; start++) {
    const cand = name.substring(start);
    if (abbrevs[cand] && abbrevs[cand].lawId && (start === 0 || !isKanji(name[start - 1]))) {
      return { name: cand, lawId: abbrevs[cand].lawId, lawTitle: abbrevs[cand].lawTitle || null };
    }
  }
  return null;
}

// 「」（読み替え後の文言など）の中の条文参照を拾う。tokenize は loadQuotedTokenizer() が返す関数（lawtext の文解析）。
//   - 法令名付き（「借地借家法第四十一条」「非訟事件手続法（平成二十三年法律第五十一号）第二十一条第五項」）はその法令。
//     略称付き（「法第三十八条の九」「新法第二百六十条」）はその法令の略称宣言（abbrevs）で引く。宣言が無ければ出さない
//   - 「同法第N条」は同じ鉤括弧の中で直前に明示した法令（無ければ読み替えの相手）。「この法律」「本法」は読み替えの相手
//   - 裸の「第N条」は、同じ文で鉤括弧より前に出た直近の参照の法令（読み替えの相手＝準用元。自法令の条なら自法令）。無ければ自法令。
//     lawtext が 1 つの並び（____PointerRanges。「第五条第一項及び同項」「第百三十三条の四第一項、第二項及び第七項」）にまとめた
//     ものは同じ法令で、条の無い「第二項」は同じ並びの直前の条を受ける
//   - 「同条第N項」「同項」は同じ鉤括弧の中の直前の条を受ける（無ければ出さない）。「前項」「次条」は出さない
//   - 「附則第N条」は本則の条に落とさず出さない。知らない法令名が付いていれば出さず、続く「同条」「同法」も次に法令が決まるまで出さない
//   - 既に lawtext が拾った参照と重なる位置は出さない（文脈の更新には使う）
function extractQuotedRefs(sentenceText, existingRefs, lawId, lawnumMap, lawnameToLawid, abbrevs = {}, tokenize = null) {
  const out = [];
  const text = String(sentenceText || '');
  if (!text.includes('「') || !tokenize) return out;
  const overlapExisting = (s, e) => existingRefs.find((r) => r.start < e && s < r.end) || null;
  const overlapsOut = (s, e) => out.some((r) => r.start < e && s < r.end);
  const LAW_SUFFIX_RE = /(法律|法|令|規則|規程|条例)$/;
  const REL_RE = /(同|本|この)(法律|法|令|規則|規程|条例)$/;
  const quoteRe = /「[^「」]*」/g;
  let q;
  while ((q = quoteRe.exec(text)) !== null) {
    const qs = q.index;
    const inner = q[0].slice(1, -1);
    const base = qs + 1;   // inner のオフセット → 文のオフセット
    // 鉤括弧より前の直近の参照（自法令の条も含む。varref は法令名そのものなので含める）の法令が読み替えの相手
    let ctx = null;
    for (const r of existingRefs) if (r.end <= qs && r.target_law_id && (!ctx || r.end > ctx.end)) ctx = r;
    const ctxLaw = ctx && ctx.target_law_id !== lawId ? { lawId: ctx.target_law_id, lawTitle: ctx.target_law_name || null } : { lawId, lawTitle: null };
    // 読み替え後の文言が別の法令に置かれるとき、その中の「法」「令」はその法令の略称であって自法令の宣言ではない。宣言は相手が自法令のときだけ使う
    const abbrevsHere = ctxLaw.lawId === lawId ? abbrevs : {};

    const tree = tokenize(inner);
    if (!tree) continue;
    // 木を位置順の単位に平らにする: text / lawnum（（法令番号）の丸括弧）/ range（1 つの ____PointerRange。gid は ____PointerRanges の並びの番号）
    const units = [];
    let gid = 0;
    const walk = (els) => {
      for (const el of els) {
        if (typeof el === 'string' || !el.range) continue;
        const [s0, e0] = el.range;
        if (el.tag === '__Text') units.push({ kind: 'text', s: s0, e: e0 });
        else if (el.tag === '__Parentheses') {
          const content = (el.children || []).find((c) => c && c.tag === '__PContent');
          const kids = content ? content.children.filter((c) => typeof c !== 'string') : [];
          if (el.attr && el.attr.type === 'round' && kids.length === 1 && kids[0].tag === '____LawNum') units.push({ kind: 'lawnum', s: s0, e: e0, num: inner.slice(kids[0].range[0], kids[0].range[1]) });
          else if (content) walk(content.children);
        } else if (el.tag === '____PointerRanges') {
          const g = ++gid;
          for (const c of el.children || []) {
            if (typeof c === 'string' || !c.range) continue;
            if (c.tag !== '____PointerRange') { if (c.tag === '__Text') units.push({ kind: 'text', s: c.range[0], e: c.range[1], connector: true }); else walk([c]); continue; }
            const pointers = [];
            const nested = [];
            for (const p of c.children || []) {
              if (typeof p === 'string' || !p.range) continue;
              if (p.tag === '____Pointer') pointers.push({ s: p.range[0], e: p.range[1], frags: (p.children || []).filter((f) => f && f.tag === '____PF').map((f) => ({ ...f.attr })) });
              else if (p.tag === '__Parentheses') nested.push(p);
            }
            units.push({ kind: 'range', gid: g, s: c.range[0], e: c.range[1], pointers });
            walk(nested);
          }
        } else if (el.children) walk(el.children);
      }
    };
    walk(tree);
    units.sort((x, y) => x.s - y.s || x.e - y.e);

    let last = null;          // 同じ鉤括弧の中の直前の参照（「同条」「同項」「条の無い第N項」が受ける）
    let quoteLaw = ctxLaw;    // 同じ鉤括弧の中で明示された法令（「同法」が受ける）。null は「解決できない法令名の後」
    let groupLaw = null;      // 今の並び（____PointerRanges）の法令
    let groupId = null;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.kind !== 'range') continue;
      // --- この並びの法令を決める（並びの最初の range だけ。続きは同じ法令）
      let law = null;
      let textStart = u.s;   // 表示する文字の始まり（法令名を含める）
      const lawFrag0 = u.pointers[0] && u.pointers[0].frags.find((f) => f.targetType === 'Law');
      if (u.gid === groupId && !lawFrag0) {
        law = groupLaw;
      } else if (u.gid === groupId && lawFrag0) {
        // 並びの途中の「同法第六条」「この法律第六条」: 明示された法令／読み替えの相手に切り替える（以後の並びもその法令）
        if (lawFrag0.relPos === 'HERE') law = ctxLaw;
        else if (lawFrag0.relPos === 'SAME') { if (!quoteLaw) { last = null; groupLaw = null; continue; } law = quoteLaw; }
        else { last = null; groupLaw = null; continue; }
        groupLaw = law;
      } else {
        groupId = u.gid; groupLaw = null;
        const lawFrag = u.pointers[0] && u.pointers[0].frags.find((f) => f.targetType === 'Law');
        const prev = units[i - 1];
        const prevText = prev && prev.kind === 'text' ? inner.slice(prev.s, prev.e) : '';
        if (lawFrag) {
          // 「この法律第六条」「同法第二百三十一条の三」: lawtext が Law の断片として切っている
          if (lawFrag.relPos === 'HERE') law = ctxLaw;
          else if (lawFrag.relPos === 'SAME') { if (!quoteLaw) { last = null; continue; } law = quoteLaw; }
          else { last = null; continue; }
        } else if (prev && prev.kind === 'lawnum') {
          // 「法令名（法令番号）第N条」: 法令番号で決める。表示は法令名の始まりから（題名の表に無ければ末尾の漢字の連なり）
          const e2 = lawnumMap[prev.num];
          if (!e2) { last = null; quoteLaw = null; continue; }
          law = { lawId: e2.lawId, lawTitle: e2.lawTitle };
          const before = units[i - 2] && units[i - 2].kind === 'text' ? inner.slice(units[i - 2].s, units[i - 2].e) : '';
          const byName = resolveLawName(before, lawnameToLawid);
          const tail = before.match(/[一-龥々〆〇ァ-ヶー]+$/);
          textStart = byName ? units[i - 2].s + (before.length - byName.name.length) : (tail ? units[i - 2].s + (before.length - tail[0].length) : prev.s);
          quoteLaw = law;
        } else if (prevText && LAW_SUFFIX_RE.test(prevText)) {
          // 直前の文字が法令名で終わる: 題名 → 相対（同法・この法律・本法） → 略称宣言 → 出さない
          const byName = resolveLawName(prevText, lawnameToLawid);
          const rel = byName ? null : prevText.match(REL_RE);
          const byAbbrev = byName || rel ? null : resolveAbbrev(prevText, abbrevsHere);
          if (byName) { law = { lawId: byName.lawId, lawTitle: byName.name }; textStart = prev.s + (prevText.length - byName.name.length); quoteLaw = law; }
          else if (rel && rel[1] === '同') { if (!quoteLaw) { last = null; continue; } law = quoteLaw; textStart = prev.s + prevText.length - rel[0].length; }
          else if (rel) { law = ctxLaw; textStart = prev.s + prevText.length - rel[0].length; }
          else if (byAbbrev) { law = { lawId: byAbbrev.lawId, lawTitle: byAbbrev.lawTitle || byAbbrev.name }; textStart = prev.s + (prevText.length - byAbbrev.name.length); quoteLaw = law; }
          else { last = null; quoteLaw = null; continue; }   // 知らない法令名（「架空法」「民法の一部を改正する法律」「通則法」）: 出さない。続く「同条」「同法」も次に法令が決まるまで受けない
        } else if (u.pointers[0] && u.pointers[0].frags.some((f) => f.relPos === 'SAME' && (f.targetType === 'Article' || f.targetType === 'Paragraph'))) {
          // 法令の明示が無い「同条第二項」「同項」で並びが始まる（間に並びの語以外の文言が挟まって並びが分かれた）: 直前の参照と同じ法令
          if (!last) continue;
          law = { lawId: last.target_law_id, lawTitle: last.target_law_name || null };
        } else {
          law = ctxLaw;   // 裸の第N条: 読み替えの相手
        }
        groupLaw = law;
      }
      if (!law) continue;
      // --- range の中のポインタ（「第五条から第七条まで」は 2 つ）を参照にする
      for (const p of u.pointers) {
        const frags = p.frags;
        if (frags.some((f) => f.targetType === 'SupplProvision')) { last = null; continue; }   // 附則の条は本則に落とさない
        if (frags.some((f) => f.relPos === 'PREV' || f.relPos === 'NEXT')) { last = null; continue; }   // 前項・次条は出さない。続く「同条」も受けない（同条は前条を受けるので）
        const artF = frags.find((f) => f.targetType === 'Article');
        const paraF = frags.find((f) => f.targetType === 'Paragraph');
        const itemF = frags.find((f) => f.targetType === 'Item');
        let article = null, para = null, item = null, carried = false;
        if (artF && artF.relPos === 'NAMED') article = fragmentNum(artF.name);
        else if (artF && artF.relPos === 'SAME') { if (!last || last.target_law_id !== law.lawId) { last = null; continue; } article = last.target_article; carried = true; }
        if (paraF && paraF.relPos === 'NAMED') para = fragmentNum(paraF.name);
        else if (paraF && paraF.relPos === 'SAME') { if (!last || last.target_law_id !== law.lawId) { last = null; continue; } article = article || last.target_article; para = last.target_paragraph || null; carried = true; }
        if (itemF && itemF.relPos === 'NAMED') item = fragmentNum(itemF.name);
        if (!article) {
          // 条の無い「第二項」「第三号」: 同じ並びの直前の条を受ける（「第百三十三条の四第一項、第二項及び第七項」）。
          // 号だけ（「第一項第四号及び第五号ロ」の「第五号ロ」）なら項も受ける
          if (!last || last.target_law_id !== law.lawId || u.gid !== (last._gid ?? u.gid)) continue;
          article = last.target_article; carried = true;
          if (!para && item && last.target_paragraph) para = last.target_paragraph;
        }
        if (!article) continue;
        const s = base + (p === u.pointers[0] ? Math.min(textStart, p.s) : p.s), e = base + p.e;
        const ex = overlapExisting(s, e);
        if (ex) {
          // lawtext が既に拾っている参照と重なる: 出さないが、文脈はその参照で更新する
          if (ex.target_law_id && ex.type !== 'varref') {
            last = { type: ex.target_law_id === lawId ? 'internal' : 'external', target_law_id: ex.target_law_id, target_law_name: ex.target_law_name, target_article: ex.target_article, target_paragraph: ex.target_paragraph, _gid: u.gid };
            if (ex.target_law_id !== lawId || ex.target_article) quoteLaw = { lawId: ex.target_law_id, lawTitle: ex.target_law_name || null };
          }
          continue;
        }
        if (overlapsOut(s, e)) continue;
        const ref = { text: text.slice(s, e), start: s, end: e, type: law.lawId === lawId ? 'internal' : 'external', target_law_id: law.lawId, quoted: true };
        if (law.lawId !== lawId && law.lawTitle) ref.target_law_name = law.lawTitle;
        ref.target_article = article;
        if (para) ref.target_paragraph = para;
        if (item) ref.target_item = item;
        if (carried) ref.carried = true;
        out.push(ref);
        last = { ...ref, _gid: u.gid };
      }
    }
  }
  return out;
}

function collectText(el) {
  if (!el) return '';
  if (typeof el === 'string') return el;
  if (el.children) {
    let t = '';
    for (const c of el.children) t += collectText(c);
    return t;
  }
  return '';
}

function findSourceLocation(parentELs) {
  let article = null, paragraph = null, item = null, subitem = null, subsubitem = null, appdx = null;
  for (const p of parentELs || []) {
    if (p.tag === 'Article') article = p.attr?.Num;
    else if (p.tag === 'Paragraph') paragraph = p.attr?.Num;
    else if (p.tag === 'Item') item = p.attr?.Num;
    else if (p.tag === 'Subitem1') subitem = p.attr?.Num;
    else if (p.tag === 'Subitem2') subsubitem = p.attr?.Num;
    else if (p.tag === 'AppdxTable' || p.tag === 'AppdxNote' || p.tag === 'AppdxStyle' ||
             p.tag === 'AppdxFig' || p.tag === 'AppdxFormat' || p.tag === 'Appdx') {
      appdx = p.attr?.Title || p.attr?.Num || '別表';
    }
  }
  return { article, paragraph, item, subitem, subsubitem, appdx };
}

function resolveTarget(pe, sourceLawId, lawnumMap) {
  if (!pe || !pe.located) return null;

  if (pe.located.type === 'internal') {
    const frags = pe.located.fragments || [];
    const target = { type: 'internal', target_law_id: sourceLawId };

    for (const f of frags) {
      const containers = f.containers || [];
      for (const c of containers) {
        if (c.el?.tag === 'Article' && c.el.attr?.Num) target.target_article = c.el.attr.Num;
        if (c.el?.tag === 'Paragraph' && c.el.attr?.Num) target.target_paragraph = c.el.attr.Num;
        if (c.el?.tag === 'Item' && c.el.attr?.Num) target.target_item = c.el.attr.Num;
      }
      const ta = f.fragment?.attr || {};
      if (ta.targetType === 'APPDX' || ta.targetType === 'TableStruct') {
        target.target_appdx = ta.name || '別表';
      }
    }

    const firstFrag = frags[0]?.fragment;
    if (firstFrag?.attr?.relPos) target.relPos = firstFrag.attr.relPos;

    return target;
  }

  if (pe.located.type === 'external') {
    const lawRef = pe.located.lawRef;
    const lawNum = lawRef?.attr?.lawNum;
    const suggested = lawRef?.attr?.suggestedLawTitle;
    const entry = lawNum ? lawnumMap[lawNum] : null;

    const target = {
      type: 'external',
      target_law_id: entry?.lawId || null,
      target_law_name: entry?.lawTitle || suggested,
      target_law_num: lawNum,
    };

    return pointerTargetFromPFs(pe.pointer, target);
  }

  return null;
}

// ポインタの断片（____PF）を順に
function pointerPFs(el, acc = []) {
  if (!el || typeof el !== 'object') return acc;
  if (el.tag === '____PF') acc.push(el);
  for (const c of el.children || []) pointerPFs(c, acc);
  return acc;
}

// ポインタの断片（____PF）から条・項・号・別表を target に書く
function pointerTargetFromPFs(pointerEl, target) {
  for (const pf of pointerPFs(pointerEl)) {
    const a = pf.attr || {};
    if (a.targetType === 'Article' && a.num) target.target_article = a.num;
    if (a.targetType === 'Paragraph' && a.num) target.target_paragraph = a.num;
    if (a.targetType === 'Item' && a.num) target.target_item = a.num;
    if (a.targetType === 'APPDX') target.target_appdx = a.name || '別表';
    if (a.targetType === 'TableStruct') target.target_appdx = a.name || '同表';
  }
  return target;
}

// 「令」の宣言（以下「令」という。）が本文に無い施行規則・施行規程で、「令」を同じ名前の施行令として読む相手を返す（無ければ null）。
// 2026-10-12: 地方公務員等共済組合法施行規則は 2026-10-01 の改正で宣言のあった第二条の二が削除され、e-Gov の本文から宣言が消えた。
// lawtext は宣言の無い「令第二条」を自法令の第二条と読むので、施行令への参照が全部消え、自分の条への誤ったリンクになっていた。
// 宣言が 1 つでもある法令（「令」を別の意味で決めている法令を含む）は今までどおり lawtext に任せる。
// 「」の中（読み替えの文言。他の法令の「令」のことがある。措置法施行規則の消費税法施行規則の読み替えで実測）と表の中には使わない
function impliedReiLaw(lawId, declMap, lawnumMap, lawnameToLawid) {
  if (Object.values(declMap).some((d) => d && d.name === '令')) return null;
  const self = Object.values(lawnumMap || {}).find((e) => e && e.lawId === lawId);
  const m = self && self.lawTitle && self.lawTitle.match(/^(.+)施行(?:規則|規程)$/);
  if (!m) return null;
  const title = `${m[1]}施行令`;
  const entry = lawnameToLawid && lawnameToLawid[title];
  return entry && entry.lawId && entry.lawId !== lawId ? { lawId: entry.lawId, lawTitle: title, lawNum: entry.lawNum || null } : null;
}

// 文の要素の木から、ポインタ（____Pointer）→ それを含む並び（____PointerRanges。「第二条第一項第七号及び第四十二条第一項第十一号」）
// の対応を作る。並びの中の丸括弧の中の並びは別の並びとして数える
function pointerRangesIndex(rootEl, map = new Map()) {
  const visit = (el, ranges) => {
    if (!el || typeof el !== 'object') return;
    if (el.tag === '____PointerRanges') ranges = el;
    else if (el.tag === '__Parentheses') ranges = null;
    if (el.tag === '____Pointer' && ranges) { map.set(el, ranges); return; }
    for (const c of el.children || []) visit(c, ranges);
  };
  visit(rootEl, null);
  return map;
}

// ポインタが「令第○条…」の並びに入っているか。並びの始まりの直前が「令」で、その前が漢字・カタカナでない（「政令」「施行令」
// 「同令」は除く）ときだけ。「前項」「次条」「この条」（relPos が PREV・NEXT・HERE）は lawtext の読みのまま。並びの中の「同条」は令の条。
// 「令附則第四条」も宣言があるときの lawtext と同じに出す（target_article は本則と同じ番号になる。今の refs 全体と同じ扱い）。返すのは並びの要素か null
// 表の中（読替表など）の文か。別の法令の「令」を引くことがあるので令の読み替えをしない（子ども手当の施行規則の旧児童手当法施行令の読替表で実測）
const inTableSentence = (pe) => ((pe.sentenceEnv && pe.sentenceEnv.parentELs) || []).some((p) => /^Table/.test(p.tag || ''));

function reiPointerRanges(pe, rangesOf) {
  const R = rangesOf.get(pe.pointer);
  const text = pe.sentenceEnv && pe.sentenceEnv._text;
  const s = R && R.range && R.range[0];
  if (!R || !text || !Number.isInteger(s) || s < 1 || text[s - 1] !== '令') return null;
  if (/[一-龥々〆ァ-ヶー]/.test(text[s - 2] || '')) return null;
  const pfs = pointerPFs(pe.pointer);
  if (pfs[0] && pfs[0].attr && ['PREV', 'NEXT', 'HERE'].includes(pfs[0].attr.relPos)) return null;
  return R;
}

async function processLawXML(lawtext, xml, lawId, lawnumMap, lawnameToLawid) {
  const result = await lawtext.run({
    input: { xml },
    outtypes: ['json'],
    analyze: true,
    controlel: true
  });

  const a = result.analysis;

  // 略称名 → 法令名で law_id を引くための fallback
  // (lawtext が LawNum なしの宣言を Keyword 扱いにする場合の救済)
  const SHORT_LAW_ABBREVS = new Set(['法', '法律', '令', '政令', '規則', '省令', '規程', '条例']);

  // declarations 索引化
  const declMap = {};
  for (const d of a.declarations.values()) {
    const id = d.attr.declarationID;
    const value = d.attr.value ? JSON.parse(d.attr.value) : {};
    let declType = d.attr.type;
    let lawNum = value.text || null;
    let target_law_id = lawNum ? (lawnumMap[lawNum]?.lawId || null) : null;
    let target_law_name = lawNum ? (lawnumMap[lawNum]?.lawTitle || null) : null;

    // Keyword だが略称名が法令略語の場合、直前テキストから法令名を解決
    if (declType === 'Keyword' && SHORT_LAW_ABBREVS.has(d.attr.name)) {
      const r = value.sentenceTextRange;
      if (r && r.start && r.end && r.start.sentenceIndex === r.end.sentenceIndex) {
        const se = a.sentenceEnvs[r.start.sentenceIndex];
        if (se && se._text) {
          const precText = se._text.substring(r.start.textOffset, r.end.textOffset);
          // 直前の「（」（略称定義の開きカッコ）の位置を見つける (最後に出現するもの)
          const lastParenIdx = Math.max(precText.lastIndexOf('（'), precText.lastIndexOf('('));
          const beforeParen = (lastParenIdx >= 0 ? precText.substring(0, lastParenIdx) : precText).trim();
          // beforeParen の末尾から、法令名として登録されている最長一致を探す
          let cleaned = null;
          let entry = null;
          // 末尾の法令略字（法律/法/令/規則/規程/条例/政令/省令）の位置を全部試す
          const suffixRe = /(法律|政令|省令|法|令|規則|規程|条例)/g;
          const matches = [];
          let mm;
          while ((mm = suffixRe.exec(beforeParen)) !== null) matches.push(mm.index + mm[0].length);
          // 最長一致を優先 (末尾から候補を構築)
          for (let i = matches.length - 1; i >= 0; i--) {
            const endPos = matches[i];
            // start を 0 から末尾まで全部試して最長一致を探す
            for (let start = 0; start < endPos; start++) {
              const cand = beforeParen.substring(start, endPos);
              if (lawnameToLawid[cand]) {
                cleaned = cand;
                entry = lawnameToLawid[cand];
                break;
              }
            }
            if (entry) break;
          }
          if (entry) {
            declType = 'LawTitle';
            target_law_id = entry.lawId;
            target_law_name = cleaned;
            lawNum = entry.lawNum || null;
          }
        }
      }
    }

    declMap[id] = {
      name: d.attr.name,
      type: declType,
      lawNum,
      target_law_id,
      target_law_name
    };
  }

  const refsByArticle = {};
  function pushRef(articleId, ref) {
    if (!articleId) return;
    if (!refsByArticle[articleId]) refsByArticle[articleId] = [];
    refsByArticle[articleId].push(ref);
  }

  // 各 sentenceEnv の container 内での局所 index を pre-compute
  // (XML の Sentence Num 属性は Column 構造で複数 Sentence が同 Num になるため代用)
  const sentenceLocalIndex = new Map(); // sentenceEnv.el → 0-based index
  const _containerCounters = new Map();
  for (const se of a.sentenceEnvs) {
    if (!se.parentELs) continue;
    const { article, paragraph, item, subitem, subsubitem } = findSourceLocation(se.parentELs);
    const ckey = `${article || ''}_${paragraph || ''}_${item || ''}_${subitem || ''}_${subsubitem || ''}`;
    const count = _containerCounters.get(ckey) || 0;
    sentenceLocalIndex.set(se.el, count);
    _containerCounters.set(ckey, count + 1);
  }

  // 「令」の宣言が無い施行規則・施行規程の「令第○条」は同じ名前の施行令（impliedReiLaw）
  const reiLaw = impliedReiLaw(lawId, declMap, lawnumMap, lawnameToLawid);
  const reiVarrefDone = new Set();
  const rangesOf = new Map();
  if (reiLaw) for (const se of a.sentenceEnvs) if (se.el) pointerRangesIndex(se.el, rangesOf);
  let prevRei = { articleId: null, state: null };
  const sameRanges = new Map();   // 「同条」で始まって令の条と決めた並び → 'same'

  // Pointer 系
  for (const pe of a.pointerEnvByEL.values()) {
    const parentELs = pe.sentenceEnv?.parentELs;
    if (!parentELs) continue;
    const { article, paragraph, item, subitem, subsubitem, appdx } = findSourceLocation(parentELs);
    const sentence_index = sentenceLocalIndex.has(pe.sentenceEnv.el)
      ? sentenceLocalIndex.get(pe.sentenceEnv.el)
      : null;
    const key = article || appdx;
    if (!key) continue;
    const articleId = `${lawId}_Art${key}`;

    const text = collectText(pe.pointer);
    const range = pe.pointer.range;
    // 令の並びか。並びの外でも、同じ条の直前のポインタが令の条なら「同条第二項」「同項」（relPos SAME）は令の条（宣言があるときの lawtext と同じ）
    //   「同表」（表を指すもの）・「同法」「同令」（法令を指すもの）は引き継がない。「同条」で始まった並びの続き（「同条第二項第一号及び第二号」の「第二号」）も令の条
    let rei = null;
    const pfs = reiLaw ? pointerPFs(pe.pointer) : [];
    const f0 = (pfs[0] && pfs[0].attr) || {};
    const isTable = pfs.some((f) => f.attr && (f.attr.targetType === 'TableStruct' || f.attr.targetType === 'APPDX'));
    const namesLaw = pfs.some((f) => f.attr && f.attr.targetType === 'Law');   // 「同法第二十五条」「同令第三条」は令にしない
    if (reiLaw && !namesLaw && !inTableSentence(pe) && (!pe.located || pe.located.type === 'internal')) {   // 表の中は「同条」の引き継ぎも含めて読まない
      rei = reiPointerRanges(pe, rangesOf);
      const R = rangesOf.get(pe.pointer);
      if (!rei && R && sameRanges.has(R) && !['PREV', 'NEXT', 'HERE'].includes(f0.relPos)) rei = sameRanges.get(R);
      if (!rei && f0.relPos === 'SAME' && !isTable && prevRei.articleId === articleId && prevRei.state) {
        rei = 'same';
        if (R) sameRanges.set(R, rei);
      }
    }
    if (reiLaw && !isTable) prevRei = { articleId, state: namesLaw ? null : rei };
    const target = rei
      ? pointerTargetFromPFs(pe.pointer, { type: 'external', target_law_id: reiLaw.lawId, target_law_name: reiLaw.lawTitle, target_law_num: reiLaw.lawNum })
      : resolveTarget(pe, lawId, lawnumMap);
    if (!target) continue;
    if (rei && rei !== 'same' && !reiVarrefDone.has(rei)) {
      // 「令」の文字そのもの（宣言があるときに lawtext が出す varref と同じ形）
      reiVarrefDone.add(rei);
      const hs = rei.range[0];
      const v = { text: '令', paragraph };
      if (item != null) v.item = item;
      if (subitem != null) v.subitem = subitem;
      if (subsubitem != null) v.subsubitem = subsubitem;
      if (sentence_index != null) v.sentence_index = sentence_index;
      Object.assign(v, { start: hs - 1, end: hs, type: 'varref', abbreviation: '令', target_law_id: reiLaw.lawId, target_law_name: reiLaw.lawTitle, target_law_num: reiLaw.lawNum });
      pushRef(articleId, v);
    }

    const out = { text, paragraph };
    if (item != null) out.item = item;
    if (subitem != null) out.subitem = subitem;
    if (subsubitem != null) out.subsubitem = subsubitem;
    if (sentence_index != null) out.sentence_index = sentence_index;
    out.start = range?.[0];
    out.end = range?.[1];
    Object.assign(out, target);
    pushRef(articleId, out);
  }

  // VarRef (略称使用)
  for (const vr of a.variableReferences) {
    const refRange = vr.attr.refSentenceTextRange ? JSON.parse(vr.attr.refSentenceTextRange) : null;
    if (!refRange) continue;
    const sIdx = refRange.start.sentenceIndex;
    const se = a.sentenceEnvs[sIdx];
    if (!se) continue;
    const { article, paragraph, item, subitem, subsubitem, appdx } = findSourceLocation(se.parentELs);
    const sentence_index = sentenceLocalIndex.has(se.el) ? sentenceLocalIndex.get(se.el) : null;
    const key = article || appdx;
    if (!key) continue;
    const articleId = `${lawId}_Art${key}`;

    const declId = vr.attr.declarationID;
    const decl = declMap[declId];
    if (!decl || decl.type !== 'LawTitle') continue;

    const out = {
      text: collectText(vr),
      paragraph,
    };
    if (item != null) out.item = item;
    if (subitem != null) out.subitem = subitem;
    if (subsubitem != null) out.subsubitem = subsubitem;
    if (sentence_index != null) out.sentence_index = sentence_index;
    out.start = refRange.start.textOffset;
    out.end = refRange.end.textOffset;
    out.type = 'varref';
    out.abbreviation = vr.attr.refName;
    out.target_law_id = decl.target_law_id;
    out.target_law_name = decl.target_law_name || decl.name;
    out.target_law_num = decl.lawNum;
    pushRef(articleId, out);
  }

  // 略称宣言（「以下「法」という。」「以下「新法」という。」）: 略称 → 法令。「」の中の「法第N条」を引くのに使う。
  // 宣言には適用範囲（scope: 文の番号の範囲。「この条において」なら条の中だけ）があるので、文ごとに、その文を範囲に含む宣言だけを使う。
  // 同じ略称が複数あれば、範囲の始まりが後のもの（内側）を優先
  const abbrevDecls = [];
  for (const d of a.declarations.values()) {
    const dm = declMap[d.attr.declarationID];
    if (!dm || dm.type !== 'LawTitle' || !dm.target_law_id || !dm.name) continue;
    let scope = [];
    try { scope = d.attr.scope ? JSON.parse(d.attr.scope) : []; } catch (e) { scope = []; }
    const ranges = (Array.isArray(scope) ? scope : []).map((r) => [r?.start?.sentenceIndex, r?.end?.sentenceIndex]).filter(([s0, e0]) => Number.isInteger(s0) && Number.isInteger(e0));
    abbrevDecls.push({ name: dm.name, lawId: dm.target_law_id, lawTitle: dm.target_law_name || null, ranges });
  }
  const tokenize = await loadQuotedTokenizer();
  const abbrevsFor = (sentenceIdx) => {
    const out = {}; const startOf = {};
    for (const d of abbrevDecls) {
      for (const [s0, e0] of d.ranges) {
        if (sentenceIdx < s0 || sentenceIdx > e0) continue;
        if (out[d.name] && startOf[d.name] > s0) continue;
        out[d.name] = { lawId: d.lawId, lawTitle: d.lawTitle }; startOf[d.name] = s0;
      }
    }
    return out;
  };

  // 「」の中の条文参照（lawtext が引用文として拾わないもの）。文ごとに、その文で既に拾った参照（略称 varref 含む。鉤括弧の前の
  // 直近の他法令参照を読み替えの相手にする）の位置を避けて足す。VarRef の登録より後に回す
  for (const se of a.sentenceEnvs) {
    if (!se.parentELs || !se._text || !se._text.includes('「')) continue;
    const { article, paragraph, item, subitem, subsubitem, appdx } = findSourceLocation(se.parentELs);
    const key = article || appdx;
    if (!key) continue;
    const articleId = `${lawId}_Art${key}`;
    const sentence_index = sentenceLocalIndex.has(se.el) ? sentenceLocalIndex.get(se.el) : null;
    const same = (r) => r.paragraph === paragraph && (r.item ?? null) === (item ?? null) && (r.subitem ?? null) === (subitem ?? null)
      && (r.subsubitem ?? null) === (subsubitem ?? null) && (r.sentence_index ?? null) === (sentence_index ?? null);
    const existing = (refsByArticle[articleId] || []).filter(same);
    for (const q of extractQuotedRefs(se._text, existing, lawId, lawnumMap, lawnameToLawid, abbrevsFor(se.index), tokenize)) {
      const out = { text: q.text, paragraph };
      if (item != null) out.item = item;
      if (subitem != null) out.subitem = subitem;
      if (subsubitem != null) out.subsubitem = subsubitem;
      if (sentence_index != null) out.sentence_index = sentence_index;
      out.start = q.start;
      out.end = q.end;
      Object.assign(out, q, out);   // 位置情報は out のまま、残り（type・target_*・quoted）を q から
      pushRef(articleId, out);
    }
  }

  // 他法令の「同条第N項」「第N項」に直前の条番号を引き継がせる（画面・条文ページと同じ src/refsResolve.mjs）
  for (const articleId of Object.keys(refsByArticle)) refsByArticle[articleId] = fillRelativeRefs(refsByArticle[articleId], lawId);
  return refsByArticle;
}

// 法令名 → { lawId, lawNum } の逆引き（略称「法」「令」の解決に使う）
function buildLawnameMap(lawnumMap) {
  const out = {};
  for (const [lawNum, info] of Object.entries(lawnumMap || {})) {
    if (info && info.lawTitle) out[info.lawTitle] = { lawId: info.lawId, lawNum };
  }
  return out;
}

module.exports = { processLawXML, buildLawnameMap, collectText, findSourceLocation, resolveTarget, extractQuotedRefs, resolveLawName, resolveAbbrev, loadQuotedTokenizer, fragmentNum };
