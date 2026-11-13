#!/usr/bin/env node
// refs 逆引きで 01 の委任表現に子法令の受け皿候補を紐付ける (本体)。
// 前提: 00_index_refs.cjs 実行済み / 01 で raw_{parent}.json 生成済み
// 実行: node 02_link_by_reverse.cjs <parent_law_id> [<parent_law_id>...]
// 出力: rebuild_output/delegations/linked_{parent}.json
'use strict';
const fs = require('fs');
const path = require('path');
const {
  DELEG_DIR, KIND_CORE, KNUM, kanjiToInt, kindBucket, parsePointerText, itemInRange,
  loadLaw, walkSentences, lawKindOf, kindAccepts, skipParens, stripParens, dedicatedChildLaw,
} = require('./lib.cjs');

const REV = path.join(DELEG_DIR, 'reverse_index');

// 略称 (「法」等) の直後に続く条ポインタを文テキストから直接読む。
// refs の隣接レコードに頼らない: lawtext は「法第六十六条の四」の「第六十六条の四」を
// 子法令内部の条として解決しようとし、該当条が無いとレコードごと落とすため。
const PTR_AFTER_ABBREV_RE = new RegExp(
  `^(第${KNUM}条(?:の${KNUM})*` +
  `(?:第${KNUM}項)?` +
  `(?:第${KNUM}号(?:の${KNUM})*)?` +
  // イロハ細分 (「第九号の二イに規定する…」)。後続が助詞等の場合のみ消費 (語頭カタカナとの誤結合防止)
  `([イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセスン](?=[にのがはをまか、（]))?` +
  `(?:から第${KNUM}(?:条(?:の${KNUM})*|項|号(?:の${KNUM})*)まで)?)`
);
const IROHA = 'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセスン';
// 併記の続き。「又は第三百二条第一項」（条から）、「及び第三項」「、第二項及び第四項」「第四項から第六項まで」（項だけ。条は直前を引き継ぐ）、
// 「及び第七号」（号だけ。条・項は直前を引き継ぐ）。接続詞は 又は/及び/若しくは/並びに。「、」は項・号だけの続きにしか使わない
// （「、第○条」は別の文節の可能性がある）。2026-09-22: 会社法施行規則 116 条 六「法第四百四十条第一項及び第三項」で実測
const EXTRA_PTR_RE = new RegExp(
  `^(又は|及び|若しくは|並びに|、)(` +
  `第${KNUM}条(?:の${KNUM})*(?:第${KNUM}項)?(?:第${KNUM}号(?:の${KNUM})*)?` +          // 条から
  `|第${KNUM}項(?:から第${KNUM}項まで)?(?:第${KNUM}号(?:の${KNUM})*)?` +               // 項だけ（範囲つき）
  `|第${KNUM}号(?:の${KNUM})*(?:[${IROHA}](?=[にのがはをまか、及又若並（]|$))?(?:から第${KNUM}号(?:の${KNUM})*まで)?` +   // 号だけ（範囲つき）
  `)`
);
// 併記の続きを、直前の引用（条・項）を引き継いだ引用の配列にする。項の範囲は 1 つずつに展開（30 項まで）
function expandExtraPointer(text, base) {
  const out = [];
  const pr = text.match(new RegExp(`^第(${KNUM})項(?:から第(${KNUM})項まで)?(?:第(${KNUM})号((?:の${KNUM})*))?$`));
  if (pr) {
    const a = kanjiToInt(pr[1]), b = pr[2] ? kanjiToInt(pr[2]) : a;
    if (a == null || b == null || b < a || b - a > 30) return out;
    for (let n = a; n <= b; n++) {
      const c = { article: base.article, paragraph: String(n), item: null, item_range: null };
      if (pr[3] && n === b) { c.item = String(kanjiToInt(pr[3])); if (pr[4]) for (const sub of pr[4].split('の').filter(Boolean)) c.item += '_' + kanjiToInt(sub); }
      out.push(c);
    }
    return out;
  }
  const ir = text.match(new RegExp(`^第(${KNUM})号((?:の${KNUM})*)([${IROHA}])?(?:から第(${KNUM})号((?:の${KNUM})*)まで)?$`));
  if (ir) {
    let it = String(kanjiToInt(ir[1]));
    if (ir[2]) for (const sub of ir[2].split('の').filter(Boolean)) it += '_' + kanjiToInt(sub);
    const c = { article: base.article, paragraph: base.paragraph, item: it, item_range: null };
    if (ir[3]) c.subitem = String(IROHA.indexOf(ir[3]) + 1);
    if (ir[4]) { let hi = String(kanjiToInt(ir[4])); if (ir[5]) for (const sub of ir[5].split('の').filter(Boolean)) hi += '_' + kanjiToInt(sub); c.item = null; c.item_range = [it, hi]; }
    out.push(c);
    return out;
  }
  const c = parsePointerText(text);   // 条から
  if (c.article) out.push(c);
  return out;
}

// ---- 受け皿パターン (強シグナル) ----
// 「…で定める○○は、」と定義の主語になっていることまで要求する。
// 単なる言及 (他法令が「…に規定する政令で定める○○を…」と引くケース) と区別するため。
const SUBJ = `([^。（]{0,30}?)(?:とは、|は、)`;
// 条ポインタの直後に「第N項」「第N号」や見出し括弧（例:（生命保険料控除））が挟まる条文が実在し
// （所得税法施行令208の6条・航空法施行規則5の2条で実測）、^アンカー直結だと本物の受け皿を落とす。
// 任意マッチの読み飛ばしを先頭に置く。全て optional なので既存の一致は変わらず、confirmed が増える方向のみ。
// 「第三百九十六条第一項後段の規定により」の「後段」「前段」「本文」「ただし書」も読み飛ばす（2026-09-22。会社法施行規則 110 条で実測）
const SKIP = `(?:第${KNUM}項)?(?:第${KNUM}号(?:の${KNUM})*)?(?:前段|後段|本文|ただし書)?(?:（[^）]{0,50}）)?`;
const STRONG_PATTERNS = [
  { name: 'に規定するKINDで定める…は', re: new RegExp(`^${SKIP}に規定する(?:[^。]{0,40}?)?(${KIND_CORE})(?:で(?:別段の)?定める|の定める)${SUBJ}`) },
  { name: 'の規定によりKINDで定める…は', re: new RegExp(`^${SKIP}の規定(?:により|に基づき|による)(?:[^。]{0,40}?)?(${KIND_CORE})(?:で定める|の定める)${SUBJ}`) },
  { name: 'のKINDで定める…は', re: new RegExp(`^${SKIP}の(${KIND_CORE})で定める${SUBJ}`) },
  { name: 'の委任に基づき', re: new RegExp(`^${SKIP}の(?:規定による)?委任に基づ[きく]`) },
  { name: 'に規定する…で定める…は(種別語なし)', re: new RegExp(`^${SKIP}に規定する[^。]{0,40}?で定める${SUBJ}`) },
  // 技術的読替えの受け皿（2026-09-22。全法令の weak の分布で 200 件超）: 「法第N条第N項の規定による技術的読替えは、次の表のとおりとする。」
  // 親の「必要な技術的読替えは、政令で定める。」に対応する。表の中身（読み替える字句）は要らず、この柱書だけで受け皿と分かる
  { name: '技術的読替えは、次の表のとおり', re: new RegExp(`^${SKIP}(?:の規定(?:による|により)|において)(?:必要な)?技術的(?:な)?読替えは、次の表のとおりとする`) },
  // 会社法施行規則・会社計算規則の受け皿定型: 「法第N条の規定による○○については、この条(款/節)の定めるところによる」
  // 「法第三百一条第一項…の規定により交付すべき株主総会参考書類に記載すべき事項は、次款の定めるところによる」（65 条）・
  // 「法第三百九十六条第一項後段の規定により法務省令で定める事項については、この条の定めるところによる」（110 条）も同じ型
  { name: 'については、この条の定めるところ', re: new RegExp(`^${SKIP}の規定(?:による|により)[^。]{0,60}?(?:については|は)、(?:この|次の?|前の?)(?:条|款|節|章|規則|省令|項)の定めるところによる`) },
];

// ---- 列挙型の受け皿 (2026-09-22) ----
// 会社法施行規則 116 条のように、柱書が「次に掲げる規定に規定する法務省令で定めるべき事項は、当該各号に定める事項とする。」で、
// 各号が「法第四百四十条第一項」と引用だけを書く型。号の文には引用の後ろに何も無いので上の受け皿パターンに掛からず、
// 会社法 440 条 1 項などの委任が全部「無し」になっていた（実測: 会社法で「法務省令で定める」がある条の半分以上）。
// 号の文が引用（＋括弧）だけなら、同じ項の柱書（号の無い最初の文）を受け皿パターンで判定する。
// 柱書の目的語（「事項」等）は総称なので、親の後続語との名詞照合は掛けない（号が規定を特定しているので位置で決まる）。
const ENUM_ITEM_TAIL_RE = /^(?:の規定)?[。]?$/;   // 引用の後ろに残ってよいもの
const ENUM_LEAD_PATTERNS = [
  { name: '列挙型: 次に掲げる規定に規定するKINDで定める…は', re: new RegExp(`^(?:次|次の各号|以下)に掲げる(?:法の)?規定(?:に規定する|の規定による|の規定により|の)(?:[^。]{0,40}?)?(${KIND_CORE})(?:で(?:別段の)?定める(?:べき)?|の定める)${SUBJ}`) },
  { name: '列挙型: 次に掲げる規定の委任に基づき', re: new RegExp(`^(?:次|次の各号|以下)に掲げる(?:法の)?規定の(?:規定による)?委任に基づ[きく]`) },
  // 手続型（2026-09-22）: 「次に掲げる規定に規定する事項を電磁的方法により提供しようとする者は、法務省令で定めるところにより、あらかじめ、…承諾を得なければならない。」
  // （会社法施行令 1 条。号は「法第五十九条第四項」）。政令が列挙した規定の手続そのものを書く型で、親側は「政令で定めるところにより」。
  // 柱書に別の種別語（政令の中の「法務省令で定める」＝再委任）があっても受け皿の種別とは読まない（種別語を取らない）。
  // 親の後続語が「ところにより」の委任にだけ当てる（tokoro）
  { name: '列挙型: 次に掲げる規定により…する者は（手続型）', tokoro: true, re: new RegExp(`^(?:次|次の各号|以下)に掲げる(?:法の)?規定(?:に規定する|により|の規定により|の規定による)[^。]{0,80}?(?:者|もの|とき|場合)は、`) },
];
// 同じ条・項の柱書（号の無い最初の文）
function findLead(sentIndex, artNum, sent) {
  for (const s of sentIndex.get(artNum) || []) {
    if (s.provision === sent.provision && s.paragraph === sent.paragraph && s.item === null && s.sidx === 0) return s;
  }
  return null;
}

// 受け皿の目的語 (「…で定める○○は、」の○○) を取り出す
function receptacleNoun(w) {
  const m = w.match(/(?:で|の)定める([^。（]{0,30}?)(?:とは、|は、)/);
  if (m) return m[1];
  const m2 = w.match(/(?:で|の)定める([^。、（は]{1,20})/);
  return m2 ? m2[1] : null;
}

function commonPrefixLen(a, b) {
  if (!a || !b) return 0;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// 子法令の文を特定する: ref のオフセットで自己検証しながら探す
function locateSentence(sentIndex, artNum, ref, extraCheck) {
  const key = artNum;
  const list = sentIndex.get(key) || [];
  const hits = [];
  for (const s of list) {
    if (ref.paragraph != null && s.paragraph !== ref.paragraph) continue;
    if (ref.item != null && s.item !== ref.item) continue;
    if (ref.item == null && s.item !== null) continue;
    if (s.text.substring(ref.start, ref.end) !== ref.text) continue;
    if (extraCheck && !extraCheck(s)) continue;
    hits.push(s);
  }
  // 本則優先
  hits.sort((a, b) => (a.provision === 'main' ? 0 : 1) - (b.provision === 'main' ? 0 : 1));
  return hits[0] || null;
}

// 引用が文頭にあるか（号の文が「法第四百四十条第一項」で始まる）
function citeStart0(sent, ref) { return ref.start === 0; }

// 子法令のロード/センテンス索引は全件展開時に使い回すため LRU キャッシュ
const _lawCache = new Map();
const _idxCache = new Map();
function _cached(cache, key, make, max = 400) {
  if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
  const v = make();
  cache.set(key, v);
  if (cache.size > max) cache.delete(cache.keys().next().value);
  return v;
}
function getLaw(id) {
  return _cached(_lawCache, id, () => { try { return loadLaw(id); } catch { return null; } });
}
function getSentIndex(id) {
  return _cached(_idxCache, id, () => {
    const law = getLaw(id);
    const idx = new Map();
    if (law) for (const s of walkSentences(law)) {
      if (!idx.has(s.article)) idx.set(s.article, []);
      idx.get(s.article).push(s);
    }
    return idx;
  }, 200);
}

function linkParent(parentId, opts = {}) {
  const raw = opts.raw || JSON.parse(fs.readFileSync(path.join(DELEG_DIR, `raw_${parentId}.json`), 'utf-8'));
  const revFile = path.join(REV, `${parentId}.json`);
  const revEntries = fs.existsSync(revFile) ? JSON.parse(fs.readFileSync(revFile, 'utf-8')) : [];

  // 本則の委任のみ紐付け対象 (附則は refs のキーが本則と衝突するため今回は対象外)
  const delegations = raw.delegations.map((d, di) => ({ ...d, _di: di, candidates: [] }));
  const mainDelegs = delegations.filter(d => d.provision === 'main');
  // article → delegations
  const byArt = new Map();
  for (const d of mainDelegs) {
    if (!byArt.has(d.article)) byArt.set(d.article, []);
    byArt.get(d.article).push(d);
  }

  // 逆引きエントリをソース法令別に
  const bySrcLaw = new Map();
  for (const e of revEntries) {
    if (!bySrcLaw.has(e.src)) bySrcLaw.set(e.src, []);
    bySrcLaw.get(e.src).push(e);
  }

  const stats = { citing_laws: 0, citing_refs: 0, merged_varrefs: 0, located: 0, unlocatable: 0, strong: 0, enum_lead: 0, weak_sig: 0, skipped_lawlevel: 0 };

  for (const [src, entries] of bySrcLaw) {
    const childLaw = getLaw(src);
    if (!childLaw) continue;
    const childKind = lawKindOf(childLaw);
    if (childKind === '法律' || childKind === 'その他') continue; // 受け皿は命令系のみ
    stats.citing_laws++;

    // 子法令のセンテンス索引 (article number → sentences)
    const sentIndex = getSentIndex(src);

    for (const e of entries) {
      const ref = e.ref;
      const artNum = e.key.substring(e.key.indexOf('_Art') + 4);
      stats.citing_refs++;

      // --- 子法令側の文を特定 (ref のオフセットで自己検証) ---
      const sent = locateSentence(sentIndex, artNum, ref, null);
      if (!sent) { stats.unlocatable++; continue; }

      // --- 引用の条・項・号とスパンを確定 ---
      let citation, spanEnd, citeText, refType;
      if (ref.type === 'varref') {
        // 略称直後のポインタを文テキストから直接パース
        const after = sent.text.substring(ref.end, ref.end + 60);
        const pm = after.match(PTR_AFTER_ABBREV_RE);
        if (!pm) { stats.skipped_lawlevel++; continue; } // 「法の規定」等の法令レベル言及
        citation = parsePointerText(pm[1]);
        if (pm[2]) citation.subitem = String(IROHA.indexOf(pm[2]) + 1);
        spanEnd = ref.end + pm[1].length;
        citeText = ref.text + pm[1];
        refType = 'varref';
        stats.merged_varrefs++;
      } else {
        citation = parsePointerText(ref.text);
        if (!citation.article && ref.target_article) citation.article = ref.target_article;
        if (!citation.paragraph && ref.target_paragraph) citation.paragraph = ref.target_paragraph;
        if (!citation.item && ref.target_item) citation.item = ref.target_item;
        if (!citation.article) { stats.skipped_lawlevel++; continue; }
        spanEnd = ref.end;
        citeText = ref.text;
        refType = 'external';
      }
      stats.located++;

      // 併記「法第三百一条第一項又は第三百二条第一項の規定により…」は、続く条ポインタも同じ法令の引用として拾い、
      // 受け皿パターンは最後のポインタの後ろで見る（2026-09-22。会社法施行規則 65 条で実測）
      const citations = [citation];
      for (let k = 0; k < 6; k++) {
        const em = sent.text.substring(spanEnd, spanEnd + 60).match(EXTRA_PTR_RE);
        if (!em) break;
        if (em[1] === '、' && /^第[〇一二三四五六七八九十百千]+条/.test(em[2])) break;   // 「、第○条」は別の文節の可能性があるので拾わない（項・号だけの続きに限る）
        const extras = expandExtraPointer(em[2], citations[citations.length - 1]);
        if (!extras.length) break;
        citations.push(...extras);
        spanEnd += em[0].length;
        stats.extra_ptrs = (stats.extra_ptrs || 0) + 1;
      }
      // 引用先の条に委任表現が無ければ用なし
      if (!citations.some((c) => byArt.has(c.article))) continue;

      // --- 受け皿パターン照合 ---
      const afterStart = skipParens(sent.text, spanEnd);
      const windowRaw = sent.text.substring(afterStart, afterStart + 120);
      const w = stripParens(windowRaw);
      let strength = 'weak', patName = null, recKindTok = null, enumLead = null, tokoroOnly = false;
      for (const p of STRONG_PATTERNS) {
        const m = w.match(p.re);
        if (m) { strength = 'strong'; patName = p.name; recKindTok = m[1] || null; break; }
      }
      // 列挙型: 号が引用だけなら柱書で判定する
      if (strength === 'weak' && sent.item != null && citeStart0(sent, ref) && ENUM_ITEM_TAIL_RE.test(w)) {
        const lead = findLead(sentIndex, artNum, sent);
        const lw = lead ? stripParens(lead.text) : '';
        for (const p of ENUM_LEAD_PATTERNS) {
          const m = lw.match(p.re);
          if (m) { strength = 'strong'; patName = p.name; recKindTok = m[1] || null; enumLead = lead; tokoroOnly = !!p.tokoro; stats.enum_lead++; break; }
        }
      }

      // 体系フィルタ: 受け皿は親専属の下位法令に限る。
      //  - 短い汎用略称 (「法」「令」等) で親を引いている = 子が親専属である証拠。
      //    「法人税法」等のフルネーム略称宣言も varref になるため、それは専属の証拠にしない
      //  - または子法令の題名が親法令名を含む (「法人税法施行令」等)
      const SHORT_ABBREVS = new Set(['法', '法律', '令', '政令', '規則', '省令', '規程', '新法', '旧法', '新令', '旧令']);
      //  - 2026-09-22: 題名が親法令名を丸ごと含まなくても、親の題名から末尾の「法」を除いた芯（3 文字以上）を含めば専属とみなす
      //    （「金融商品取引法」→「金融商品取引業等に関する内閣府令」、「保険業法」→「保険業法施行規則」）。
      //    受け皿の文型に完全に合っているのに、この判定だけで weak に落ちていたものが全法令で 1,000 件超あった
      const titleCore = String(raw.law_title || '').replace(/(に関する)?法律?$/, '');
      const dedicated = (refType === 'varref' && SHORT_ABBREVS.has(ref.abbreviation)) ||
        childLaw.law_title.includes(raw.law_title) ||
        (titleCore.length >= 3 && childLaw.law_title.includes(titleCore));
      const crossSystem = !dedicated;
      // 受け皿規定の主語は文頭に来る (「法第N条…に規定する…で定める○○は、」)。
      // 文中間・括弧内の引用への誤発火は単なる言及。
      const citeStart = ref.start;
      const before = sent.text.substring(0, citeStart);
      // 準用先の受け皿（2026-09-22）: 「第十二条（…）において読み替えて準用する法第四十九条第二項に規定する内閣府令で定める者は、…」。
      // 引用の前が「自法令の条 において（読み替えて）準用する」だけなら、準用の文脈での受け皿として扱う（via_junyo）。
      // 全法令で 2,000 件超がこの型で、「準用」の字だけで落としていた
      const beforePlain = stripParens(before);
      // 準用しているのが自法令の条（「第十二条において準用する法第…」）でも親法令の条（「法第十条第一項において準用する法第五十九条第二項に規定する…」
      // ＝親法令の中での準用を子法令が受ける型。全法令の weak の分布で一番多い）でも受ける。親の条には略称「法」「同法」等が付く
      const JUNYO_PREFIX_RE = new RegExp(`^(?:(?:法|同法|新法|旧法|法律|令|同令|規則)?第${KNUM}条(?:の${KNUM})*(?:第${KNUM}項)?(?:第${KNUM}号(?:の${KNUM})*)?(?:、|及び|又は|並びに|若しくは)?)+(?:の規定)?において(?:読み替えて)?(?:準用する|適用する場合における|準用する場合における)$`);
      const viaJunyo = beforePlain.length > 0 && JUNYO_PREFIX_RE.test(beforePlain);
      // 準用・読替え規定は受け皿ではない (適用ルール)。
      // ただし括弧書きの「（…において準用する場合を含む。）」は準用規定ではないので括弧内は無視する。準用先の受け皿は引用より後ろだけで見る
      const junyoText = viaJunyo ? stripParens(sent.text.substring(citeStart)) : stripParens(sent.text);
      const junyo = /準用する|読み替え/.test(junyoText) || (enumLead ? /準用する|読み替え/.test(stripParens(enumLead.text)) : false);
      // 引用の前が略称 1 語（「法第六条第一項の政令で定める…」のポインタ側。略称の VarRef とは別の ref になる）か
      // 親法令の題名だけ（「がん登録等の推進に関する法律（以下「法」という。）第二条第一項の政令で定める疾病は、」）なら文頭扱い
      // （2026-09-22。全法令の head 25,562 件のうち引用の前が「法」で終わるものが 23,117 件・「）」で終わるものが 1,064 件）
      const headOk = citeStart === 0 || viaJunyo ||
        SHORT_ABBREVS.has(beforePlain) || beforePlain === '同法' || beforePlain === '同令' ||
        (!!raw.law_title && beforePlain === raw.law_title) ||
        (/[、。]$/.test(before) && before.length <= 30 && !/定め/.test(before));
      const parenDepth = (before.match(/（/g) || []).length - (before.match(/）/g) || []).length;
      // weak に落ちた理由を候補に残す（次に直す型を分布で見るため。2026-09-22）
      const weakReasons = [];
      if (!patName) weakReasons.push('no_pattern');
      if (patName && crossSystem) weakReasons.push('cross_system');
      if (patName && junyo) weakReasons.push('junyo');
      if (patName && !headOk) weakReasons.push('head');
      if (patName && parenDepth > 0) weakReasons.push('paren');
      if (strength === 'strong' && (crossSystem || junyo || !headOk || parenDepth > 0)) strength = 'weak';
      if (viaJunyo) stats.via_junyo = (stats.via_junyo || 0) + 1;

      const recKind = recKindTok ? kindBucket(recKindTok) : null;
      // 列挙型は柱書の目的語（「署名又は記名押印に代わる措置」など）を、同じ項に委任が複数あるときの絞り込みにだけ使う
      // （下の「名詞整合の必須化」では使わない。柱書の目的語が「事項」のような総称でも weak に落とさないため）
      const noun = enumLead ? receptacleNoun(stripParens(enumLead.text)) : (recKindTok || patName ? receptacleNoun(w) : null);
      if (strength === 'strong') stats.strong++; else stats.weak_sig++;

      // --- 委任表現とのマッチング（併記なら引用ごとに） ---
      for (const citation of citations) {
      const targetDelegs = byArt.get(citation.article);
      if (!targetDelegs) continue;
      let matched = targetDelegs.filter(d => {
        if (tokoroOnly && !/^ところにより/.test(d.trailing || '')) return false;   // 手続型の柱書は「…で定めるところにより」の委任だけ受ける
        if (citation.paragraph != null && d.paragraph !== citation.paragraph) return false;
        if (citation.item != null) {
          if (d.item !== citation.item) return false;
        } else if (citation.item_range) {
          if (!itemInRange(d.item, citation.item_range)) return false;
        }
        // 引用がイロハ細分まで指定している場合は細分も一致させる (「第九号の二イ」→ イ内の委任のみ)
        if (citation.subitem != null) {
          if (!d.subitem || String(d.subitem).split('/')[0] !== citation.subitem) return false;
        }
        return true;
      });
      // 種別の整合: 子法令の種別と委任種別の両方が整合していること。
      // 受け皿側で種別語が取れていればそれとも矛盾しないこと
      // (受け皿文中の別の「財務省令で定める」等に騙されて政令に省令委任を割り当てない)
      const kindCompat = (dk, rk) => dk === rk ||
        (dk === '省令' && (rk === '財務省令' || rk === '主務省令')) ||
        (rk === '省令' && (dk === '財務省令' || dk === '主務省令'));
      // 省名まで照合: 「厚生労働省令で定める」の受け皿に農林水産省令が付く誤り
      // (動物用医薬品の読替え委任等) を防ぐ。「主務省令」等の非特定は対象外
      // 省庁再編の旧省名 → 現省名。表に無い旧省 (逓信・内務等) は null = 判定しない
      // (旧省名の番号を持つ現役省令への正当な紐付けをブロックしないため)
      const MIN_ALIAS = {
        '大蔵': '財務', '通商産業': '経済産業', '商工': '経済産業',
        '運輸': '国土交通', '建設': '国土交通', '鉄道': '国土交通',
        '厚生': '厚生労働', '労働': '厚生労働',
        '文部': '文部科学', '自治': '総務', '郵政': '総務', '司法': '法務',
        '農林': '農林水産',
      };
      const MIN_KNOWN = new Set(['総務', '法務', '外務', '財務', '文部科学', '厚生労働', '農林水産', '経済産業', '国土交通', '環境', '防衛']);
      const ministryOf = (tok) => {
        // 「その他厚生労働省令」の切れ端 (「他厚生労働省令」) が kind_raw に残ることがあるため先頭の他を剥がす
        const s = String(tok || '').replace(/^(?:その)?他の?/, '');
        // 法令番号形式 (「平成十八年法務省令第十二号」) は「年」の後ろから、
        // 種別トークン形式 (「法務省令」) は先頭から取る (年号の巻き込み防止)
        const m = s.match(/年([一-龠]{2,6})省令/) || s.match(/^([一-龠]{2,6})省令/);
        if (!m) return null;
        const name = MIN_ALIAS[m[1]] || m[1];
        return MIN_KNOWN.has(name) ? name : null;
      };
      const childMinistry = ministryOf(childLaw.law_num);
      const recMinistry = ministryOf(recKindTok);
      const kindOkOf = d => {
        if (!kindAccepts(d.kind, childKind)) return false;
        if (recKind && !kindCompat(d.kind, recKind)) return false;
        const dm = ministryOf(d.kind_raw);
        if (dm && childMinistry && dm !== childMinistry) return false;
        if (dm && recMinistry && dm !== recMinistry) return false;
        return true;
      };
      const kindMatched = matched.filter(kindOkOf);
      const kindMismatch = kindMatched.length === 0 && matched.length > 0;
      if (kindMatched.length) matched = kindMatched;
      if (!matched.length) continue;

      // 目的語の突き合わせ (「…で定める○○は」の○○ vs 親の「…で定める」の後続語)。
      // 決定的な場合のみ絞る: 先頭一致4文字以上かつ唯一の最良。
      // 緩い一致 (「取得」2文字等) での誤断定は confirmed の嘘になるため許さない。
      const cpOf = d => {
        const t1 = d.trailing || '';
        const t2 = t1.replace(/^（[^）]*）/, '');
        return Math.max(commonPrefixLen(noun, t1), commonPrefixLen(noun, t2));
      };
      let assigned = matched;
      if (noun && matched.length > 1) {
        // 名詞全体が親の後続語の先頭と一致 (短い名詞ならそれで決定的)、または4文字以上一致
        const need = Math.max(2, Math.min(4, noun.length));
        const scored = matched.map(d => ({ d, cp: cpOf(d) })).sort((a, b) => b.cp - a.cp);
        if (scored[0].cp >= need && (scored.length < 2 || scored[0].cp > scored[1].cp)) {
          assigned = [scored[0].d];
        }
      }
      // 名詞整合の必須化: 受け皿の目的語が取れているのに委任の後続語と1文字も
      // 一致しない場合は受け皿と断定しない (同じ項の兄弟委任の受け皿である可能性)。
      // 位置的に候補1件でも噛み合わない組は strong にせず weak に落とす。
      // 後続語が空/句点のみ (「…は、政令で定める。」型の包括委任) は判定不能なので対象外。
      let effStrength = strength;
      // 「事項」「方法」「場合」「基準」も「もの」「こと」と同じ総称（受け皿側が「…で定める事項は」と書くのが定型で、
      // 親の後続語と一致しなくても矛盾ではない）。親の後続語が「ところにより」（「法務省令で定めるところにより」）のときも
      // 名詞ではないので判定不能扱いにする（2026-09-22。それまでこの型が全部 weak に落ちていた: 会社法 396 条 → 施行規則 110 条 など）
      const GENERIC_NOUN = /^(もの|こと|事項|方法|場合|基準|ところ)/;
      if (strength === 'strong' && noun && !enumLead && !GENERIC_NOUN.test(noun)) {
        // 判定不能な後続語: 空/句点のみ (包括委任) と「もの」「こと」(汎用の受け皿語。
        // 受け皿側が「…法人は」等の実名詞に言い換えるのが正当なので矛盾とみなさない)
        const judgeableOf = d => {
          const t = (d.trailing || '').replace(/^[。、）]/, '');
          return t.length >= 2 && !GENERIC_NOUN.test(t);
        };
        const judgeable = assigned.filter(judgeableOf);
        const compatible = judgeable.filter(d => cpOf(d) > 0);
        if (judgeable.length === assigned.length && assigned.length > 0 && compatible.length === 0) {
          effStrength = 'weak'; // 全候補と名詞が矛盾 → 断定しない
          weakReasons.push('noun');
        } else if (compatible.length > 0 && compatible.length < judgeable.length) {
          assigned = assigned.filter(d => !judgeableOf(d) || cpOf(d) > 0);
        }
      }

      const cand = {
        law_id: src,
        law_title: childLaw.law_title,
        law_kind: childKind,
        article: artNum,
        article_title: sent.articleTitle,
        paragraph: sent.paragraph,
        item: sent.item,
        subitem: sent.subitem,
        provision: sent.provision,
        ref_type: refType,
        cite_text: citeText,
        strength: effStrength,
        cross_system: crossSystem,
        junyo,
        via_junyo: viaJunyo,
        weak_reasons: effStrength === 'weak' ? weakReasons : [],
        matched_pattern: patName,
        rec_kind: recKind,
        kind_ok: !kindMismatch && kindAccepts((recKind || matched[0].kind), childKind),
        kind_mismatch: kindMismatch,
        noun,
        assigned_count: assigned.length,
        snippet: sent.text.substring(0, 300),
      };
      for (const d of assigned) {
        const nounCp = noun ? commonPrefixLen(noun, d.trailing) : 0;
        d.candidates.push({ ...cand, noun_cp: nounCp });
      }
      }   // citations
    }
  }

  // ---- status 判定 ----
  for (const d of delegations) {
    if (d.provision !== 'main') { d.status = 'out_of_scope'; d.status_note = d.provision; continue; }
    const strongOk = d.candidates.filter(c => c.strength === 'strong' && c.kind_ok && !c.kind_mismatch && c.provision === 'main');
    const weakAny = d.candidates.filter(c => !(c.strength === 'strong' && c.kind_ok && !c.kind_mismatch && c.provision === 'main'));
    if (strongOk.length) {
      // 直接の受け皿があれば、準用先の受け皿は数に入れない（confirmed が multiple に落ちないように。候補としては残す）
      const primary = strongOk.filter(c => !c.via_junyo);
      const decide = primary.length ? primary : strongOk;
      const arts = new Set(decide.map(c => c.law_id + '_' + c.article));
      const ambiguous = decide.some(c => c.assigned_count > 1);
      d.status = (arts.size === 1 && !ambiguous) ? 'confirmed' : 'multiple';
    } else if (weakAny.length) {
      d.status = 'weak';
    } else {
      d.status = 'none';
    }
    // 条が決まらないもの（weak / none）の機械的な受け皿（2026-09-22）:
    //  - 告示への委任は受け皿が法令 DB に無い → 'kokuji'（表示だけ。リンク無し）
    //  - 親法令に専属の施行令・施行規則が 1 本に決まる → 'law_level'（条ではなく法令へのリンク。包括委任「必要な事項は政令で定める」など）
    //  weak の候補（単なる言及）はそのまま残す。confirmed / multiple は触らない
    if (d.status === 'weak' || d.status === 'none') {
      if (d.kind === '告示') {
        d.status = 'kokuji';
      } else {
        const child = dedicatedChildLaw(raw.law_title, d.kind);
        if (child) { d.status = 'law_level'; d.law_level = child; }
      }
    }
  }

  const out = {
    parent_law_id: parentId,
    parent_law_title: raw.law_title,
    stats,
    status_counts: countBy(delegations.filter(d => d.provision === 'main'), d => d.status),
    delegations: delegations.map(d => ({
      parent_article: d.article,
      parent_article_title: d.article_title,
      parent_paragraph: d.paragraph,
      parent_item: d.item,
      parent_subitem: d.subitem,
      provision: d.provision,
      expr: d.expr,
      offset: d.offset,
      kind: d.kind,
      kind_raw: d.kind_raw,
      trailing: d.trailing,
      context: d.context,
      status: d.status,
      law_level: d.law_level || null,
      candidates: dedupeCands(d.candidates),
    })),
  };
  if (!opts.noWrite) {
    const outFile = path.join(DELEG_DIR, `linked_${parentId}.json`);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 1), 'utf-8');
  }
  if (!opts.quiet) {
    console.log(`${parentId} ${raw.law_title}: main=${out.delegations.filter(x => x.provision === 'main').length}`,
      JSON.stringify(out.status_counts), JSON.stringify(stats));
  }
  return out;
}

function countBy(arr, fn) {
  const o = {};
  for (const x of arr) { const k = fn(x); o[k] = (o[k] || 0) + 1; }
  return o;
}

// 同一 (law, article, paragraph, item, strength) の候補は1つに
function dedupeCands(cands) {
  const seen = new Set();
  const out = [];
  for (const c of cands) {
    const k = [c.law_id, c.article, c.paragraph, c.item, c.subitem, c.strength].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function main() {
  const ids = process.argv.slice(2);
  if (!ids.length) { console.error('Usage: node 02_link_by_reverse.cjs <parent_law_id>...'); process.exit(1); }
  for (const id of ids) linkParent(id);
}

if (require.main === module) main();
module.exports = { linkParent };
