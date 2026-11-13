#!/usr/bin/env node
// refs の補完（src/refsResolve.mjs）と「」内の条文参照の抽出（scripts/rebuild/lib/refs_extract.cjs の extractQuotedRefs）の
// 固定データでの確認。¥0・ネット不要。「」内の抽出は lawtext の文解析を使うので lawtext が要る（無ければその部分は SKIP）。
//
//   node scripts/check_refs_resolve.cjs
//
// 借地借家法 61 条（民訴法の秘匿制度を準用・読み替え）の文をそのまま使う。

const { fillRelativeRefs, kanjiToNumber } = require('../src/refsResolve.mjs');
const { extractQuotedRefs: extractQuotedRefsRaw, resolveLawName, resolveAbbrev, loadQuotedTokenizer, fragmentNum } = require('./rebuild/lib/refs_extract.cjs');

let fails = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) { fails++; if (detail !== undefined) console.log('      ', JSON.stringify(detail)); } }

const SELF = '403AC0000000090';   // 借地借家法
const MINSO = '408AC0000000109';  // 民事訴訟法
const HISHO = '423AC0000000051';  // 非訟事件手続法
const MINPO = '129AC0000000089';  // 民法
const DENPA = '325AC0000000131';  // 電波法

// ---- fillRelativeRefs: 他法令の「同条第N項」「第N項」「同項」に直前の条番号を引き継ぐ
{
  const ext = (o) => ({ paragraph: '1', sentence_index: 1, type: 'external', target_law_id: MINSO, target_law_name: '民事訴訟法', ...o });
  const refs = [
    ext({ text: '同法第百三十三条第一項', start: 9, end: 20, target_article: '133', target_paragraph: '1' }),
    ext({ text: '同条第三項', start: 122, end: 127, target_paragraph: '3' }),
    ext({ text: '同法第百三十三条の二第一項', start: 318, end: 331, target_article: '133_2', target_paragraph: '1' }),
    ext({ text: '同条第二項', start: 379, end: 384, target_paragraph: '2' }),
    ext({ text: '同項', start: 419, end: 421 }),
    ext({ text: '第百三十三条の四第一項', start: 93, end: 104, target_article: '133_4', target_paragraph: '1', quoted: true }),   // 「」内は文脈にしない
    { text: '第六項', paragraph: '1', sentence_index: 0, start: 55, end: 58, type: 'external', target_law_id: MINSO, target_paragraph: '6' },
    { text: '第百三十三条の二第五項', paragraph: '1', sentence_index: 0, start: 42, end: 53, type: 'external', target_law_id: MINSO, target_article: '133_2', target_paragraph: '5' },
    { text: '前項', paragraph: '2', sentence_index: 0, start: 0, end: 2, type: 'internal', target_law_id: SELF, target_paragraph: '1' },
    { text: '民事訴訟法', paragraph: '1', sentence_index: 0, start: 30, end: 35, type: 'varref', target_law_id: MINSO },
  ];
  const out = fillRelativeRefs(refs, SELF);
  const by = (t) => out.filter((r) => r.text === t);
  check('元の配列は変えない', refs[1].target_article === undefined && out !== refs);
  check('同条第三項 → 直前の 133 条（「」内の 133 条の 4 は飛ばす）', by('同条第三項')[0].target_article === '133' && by('同条第三項')[0].target_paragraph === '3', by('同条第三項')[0]);
  check('同条第二項 → 133 条の 2', by('同条第二項')[0].target_article === '133_2');
  check('同項 → 133 条の 2 第 2 項（項も引き継ぐ）', by('同項')[0].target_article === '133_2' && by('同項')[0].target_paragraph === '2', by('同項')[0]);
  check('第六項（別の文）→ 同じ文の 133 条の 2', by('第六項')[0].target_article === '133_2' && by('第六項')[0].target_paragraph === '6');
  check('自法令の前項は触らない', by('前項')[0].target_article === undefined);
  check('略称（varref）は触らない', by('民事訴訟法')[0].target_article === undefined);
  check('引き継いだ印', by('同項')[0].carried === true && by('第百三十三条の二第五項')[0].carried === undefined);
  check('空・不正入力', fillRelativeRefs(null, SELF).length === 0 && fillRelativeRefs([null, 1], SELF).length === 2);
  // 別の項の条番号は引き継がない
  const sep = fillRelativeRefs([
    ext({ text: '同法第十条', paragraph: '1', start: 0, end: 5, target_article: '10' }),
    ext({ text: '同条第二項', paragraph: '2', start: 0, end: 5, target_paragraph: '2' }),
  ], SELF);
  check('別の項からは引き継がない', sep[1].target_article === undefined);
  // 未解決の「前条」を越えて古い条番号を引き継がない（GPT レビュー 2026-09-22）
  const prevc = fillRelativeRefs([
    ext({ text: '同法第五条', start: 0, end: 5, target_article: '5' }),
    ext({ text: '前条第二項', start: 8, end: 13, target_paragraph: '2' }),
    ext({ text: '同条第三項', start: 16, end: 21, target_paragraph: '3' }),
  ], SELF);
  check('「第五条」「前条第二項」「同条第三項」の同条は第五条に付けない', prevc[2].target_article === undefined && prevc[1].target_article === undefined, prevc);
  // 号だけの参照は直前の条と項を受ける（GPT レビュー 2026-09-22）
  const itm = fillRelativeRefs([
    ext({ text: '同法第三百六十一条第一項第四号', start: 0, end: 15, target_article: '361', target_paragraph: '1', target_item: '4' }),
    ext({ text: '第五号ロ', start: 17, end: 21, target_item: '5' }),
  ], SELF);
  check('「第五号ロ」は 361 条 1 項 5 号', itm[1].target_article === '361' && itm[1].target_paragraph === '1' && itm[1].target_item === '5', itm[1]);
}

// ---- extractQuotedRefs: 「」の中の条文参照（lawtext の文解析で切り分ける。tokenize が要る）
function quotedTests(tokenize) {
  const extractQuotedRefs = (t, ex, id, ln, lm, ab) => extractQuotedRefsRaw(t, ex, id, ln, lm, ab || {}, tokenize);
  const lawnumMap = {
    '平成八年法律第百九号': { lawId: MINSO, lawTitle: '民事訴訟法' },
    '平成二十三年法律第五十一号': { lawId: HISHO, lawTitle: '非訟事件手続法' },
    '平成三年法律第九十号': { lawId: SELF, lawTitle: '借地借家法' },
  };
  const lawnameMap = { '民事訴訟法': { lawId: MINSO }, '非訟事件手続法': { lawId: HISHO }, '借地借家法': { lawId: SELF }, '民法': { lawId: MINPO } };
  const text = 'この場合において、同法第百三十三条第一項中「当事者」とあるのは「当事者又は利害関係参加人（非訟事件手続法（平成二十三年法律第五十一号）第二十一条第五項に規定する利害関係参加人をいう。第百三十三条の四第一項、第二項及び第七項において同じ。）」と、同条第三項中「訴訟記録等（訴訟記録又は第百三十二条の四第一項の処分の申立てに係る事件の記録をいう。以下この章において同じ。）」とあるのは「借地借家法第四十一条の事件の記録」と読み替える。';
  const existing = [
    { text: '同法第百三十三条第一項', start: text.indexOf('同法第百三十三条第一項'), end: text.indexOf('同法第百三十三条第一項') + 11, type: 'external', target_law_id: MINSO, target_law_name: '民事訴訟法', target_article: '133', target_paragraph: '1' },
    { text: '同条第三項', start: text.indexOf('同条第三項'), end: text.indexOf('同条第三項') + 5, type: 'external', target_law_id: MINSO, target_paragraph: '3' },
  ];
  const q = extractQuotedRefs(text, existing, SELF, lawnumMap, lawnameMap);
  const t = (s) => q.find((r) => r.text === s);
  check('6 件拾う（条の無い「第二項」「第七項」も同じ並びの直前の条を受ける）', q.length === 6, q.map((r) => r.text));
  check('「第百三十三条の四第一項、第二項及び第七項」→ 133 条の 4 の 1・2・7 項', q.filter((r) => r.target_article === '133_4').map((r) => r.target_paragraph).join(',') === '1,2,7' && q.filter((r) => r.target_article === '133_4').every((r) => r.target_law_id === MINSO), q);
  check('法令番号付き → 非訟事件手続法 21 条 5 項', t('非訟事件手続法（平成二十三年法律第五十一号）第二十一条第五項') && t('非訟事件手続法（平成二十三年法律第五十一号）第二十一条第五項').target_law_id === HISHO && t('非訟事件手続法（平成二十三年法律第五十一号）第二十一条第五項').target_article === '21' && t('非訟事件手続法（平成二十三年法律第五十一号）第二十一条第五項').target_paragraph === '5');
  check('裸の第N条 → 鉤括弧の前の直近の他法令（民訴法）', t('第百三十三条の四第一項').target_law_id === MINSO && t('第百三十三条の四第一項').target_article === '133_4' && t('第百三十三条の四第一項').type === 'external');
  check('2 つ目の鉤括弧の裸の第N条も民訴法', t('第百三十二条の四第一項').target_law_id === MINSO && t('第百三十二条の四第一項').target_article === '132_4');
  check('法令名付き（自法令）→ internal', t('借地借家法第四十一条').target_law_id === SELF && t('借地借家法第四十一条').type === 'internal' && t('借地借家法第四十一条').target_article === '41');
  check('位置は文のオフセット', q.every((r) => text.slice(r.start, r.end) === r.text));
  check('quoted の印', q.every((r) => r.quoted === true));
  // 他法令参照が無い文の裸の第N条は自法令
  const q2 = extractQuotedRefs('第十条中「第五条第一項」とあるのは「第六条第二項及び同条第三項」と読み替える。', [], SELF, lawnumMap, lawnameMap);
  check('文脈が無ければ自法令・同条は同じ鉤括弧の直前の条', q2.length === 3 && q2.every((r) => r.target_law_id === SELF) && q2[2].text === '同条第三項' && q2[2].target_article === '6' && q2[2].target_paragraph === '3', q2);
  // 「同条第N項」の後の「同項」は直前の項（GPT レビュー 2026-09-22）
  const q3 = extractQuotedRefs('「第六条第二項及び同条第三項並びに同項」', [], SELF, lawnumMap, lawnameMap);
  check('同条第三項の後の同項は第 3 項', q3.length === 3 && q3[2].text === '同項' && q3[2].target_article === '6' && q3[2].target_paragraph === '3', q3);
  // 2 文字の法令名（民法・商法）を法令名として引く。文脈や自法令に落とさない（GPT レビュー 2026-09-22）
  const q4 = extractQuotedRefs('この場合において、民事訴訟法第十条中「第五条」とあるのは「民法第五条及び同条第二項」と読み替える。', [{ start: 9, end: 17, type: 'external', target_law_id: MINSO, target_article: '10' }], SELF, lawnumMap, lawnameMap);
  check('「民法第五条」は民法（文脈の民訴法にも自法令にも落ちない）', q4.length === 3 && q4[1].text === '民法第五条' && q4[1].target_law_id === MINPO && q4[1].target_article === '5' && q4[2].target_law_id === MINPO && q4[2].target_paragraph === '2', q4);
  check('「第五条」（文脈あり）は民訴法', q4[0].text === '第五条' && q4[0].target_law_id === MINSO);
  const q5 = extractQuotedRefs('「の民法第五条」', [], SELF, lawnumMap, lawnameMap);
  check('前に付いた助詞は参照の文字から外す', q5.length === 1 && q5[0].text === '民法第五条' && q5[0].start === 2 && q5[0].target_law_id === MINPO, q5);
  const q6 = extractQuotedRefs('民事訴訟法第十条中「同法第五条」と読み替える。', [{ start: 0, end: 8, type: 'external', target_law_id: MINSO, target_article: '10' }], SELF, lawnumMap, lawnameMap);
  check('「同法第五条」は読み替えの相手（民訴法）', q6.length === 1 && q6[0].target_law_id === MINSO && q6[0].target_article === '5', q6);
  // 鉤括弧の中で明示した法令は、その後の「同法」「第N条」に引き継ぐ（GPT レビュー 2026-09-22）
  const q7 = extractQuotedRefs('「民法第五条、同法第六条及び第七条」', [], SELF, lawnumMap, lawnameMap);
  check('「民法第五条、同法第六条及び第七条」は全部民法', q7.length === 3 && q7.every((r) => r.target_law_id === MINPO) && q7[1].target_article === '6' && q7[2].target_article === '7', q7);
  const q8 = extractQuotedRefs('民事訴訟法第十条中「第三条」とあるのは「民法第五条、第六条」と、「第四条」とあるのは「第八条」と読み替える。', [{ start: 0, end: 8, type: 'external', target_law_id: MINSO, target_article: '10' }], SELF, lawnumMap, lawnameMap);
  const q9 = extractQuotedRefs('民事訴訟法第十条中「甲」とあるのは「民法第五条に規定する者をいう。第六条第一項及び第七条」と読み替える。', [{ start: 0, end: 8, type: 'external', target_law_id: MINSO, target_article: '10' }], SELF, lawnumMap, lawnameMap);
  check('並びの語で続いていない裸の第N条は読み替えの相手（民訴法）。その列挙の続きも同じ法令', q9.length === 3 && q9[0].target_law_id === MINPO && q9[1].target_law_id === MINSO && q9[1].target_article === '6' && q9[2].target_law_id === MINSO && q9[2].target_article === '7', q9);
  check('鉤括弧が変われば文脈は読み替えの相手（民訴法）に戻る', q8.length === 5 && q8[0].target_law_id === MINSO && q8[1].target_law_id === MINPO && q8[2].target_law_id === MINPO && q8[3].target_law_id === MINSO && q8[4].target_law_id === MINSO, q8);
  // 「及び同法第六条」の「及び」を法令名に取り込まない。解決できない明示参照の後の「同条」は前の条に付けない（GPT レビュー 2026-09-22）
  const q10 = extractQuotedRefs('「民法第五条及び同法第六条並びに同条第二項」', [], SELF, lawnumMap, lawnameMap);
  check('「民法第五条及び同法第六条並びに同条第二項」→ 民法 5・6・6 第 2 項', q10.length === 3 && q10.every((r) => r.target_law_id === MINPO) && q10[1].text === '同法第六条' && q10[1].target_article === '6' && q10[2].target_article === '6' && q10[2].target_paragraph === '2', q10);
  const q11 = extractQuotedRefs('「民法第五条及び架空法第六条並びに同条第二項」', [], SELF, lawnumMap, lawnameMap);
  check('解決できない「架空法第六条」の後の「同条第二項」は出さない', q11.length === 1 && q11[0].text === '民法第五条', q11);
  const q12 = extractQuotedRefs('「民法第五条並びに第六条」', [], SELF, lawnumMap, lawnameMap);
  check('「並びに」で続く裸の第N条も同じ法令', q12.length === 2 && q12.every((r) => r.target_law_id === MINPO) && q12[1].target_article === '6', q12);
  const q13 = extractQuotedRefs('「民法第五条及び架空法第六条並びに同法第七条」', [], SELF, lawnumMap, lawnameMap);
  check('解決できない「架空法」の後の「同法第七条」は出さない', q13.length === 1 && q13[0].text === '民法第五条', q13);
  const q15 = extractQuotedRefs('「民法第五条及び架空法第六条並びに第七条」', [], SELF, lawnumMap, lawnameMap);
  check('解決できない「架空法」の列挙の続き「並びに第七条」は出さない', q15.length === 1 && q15[0].text === '民法第五条', q15);
  const q16 = extractQuotedRefs('「民法第五条及び架空法第六条に規定する者をいう。第七条」', [], SELF, lawnumMap, lawnameMap);
  check('列挙が切れた後の「第七条」は読み替えの相手（無ければ自法令）に戻る', q16.length === 2 && q16[1].text === '第七条' && q16[1].target_law_id === SELF, q16);
  const q17 = extractQuotedRefs('民事訴訟法第十条中「甲」とあるのは「民法第五条に規定する者については、この法律第六条を適用する。」と読み替える。', [{ start: 0, end: 8, type: 'external', target_law_id: MINSO, target_article: '10' }], SELF, lawnumMap, lawnameMap);
  check('「この法律第六条」は直前に引用した民法ではなく読み替えの相手（民訴法）', q17.length === 2 && q17[0].target_law_id === MINPO && q17[1].text === 'この法律第六条' && q17[1].target_law_id === MINSO && q17[1].target_article === '6', q17);
  const q18 = extractQuotedRefs('「民法第五条及び本法第六条」', [], SELF, lawnumMap, lawnameMap);
  check('「本法第六条」は文脈が無ければ自法令', q18.length === 2 && q18[1].text === '本法第六条' && q18[1].target_law_id === SELF, q18);
  // 鉤括弧の前の直近の参照が自法令の条なら、その前に他法令があっても文脈は自法令（GPT レビュー 2026-09-22）
  const t19 = '民法第五条に規定する者については、第十条中「第六条」とあるのは「第七条」と読み替える。';
  const q19 = extractQuotedRefs(t19, [
    { start: 0, end: 5, type: 'external', target_law_id: MINPO, target_law_name: '民法', target_article: '5' },
    { start: t19.indexOf('第十条'), end: t19.indexOf('第十条') + 3, type: 'internal', target_law_id: SELF, target_article: '10' },
  ], SELF, lawnumMap, lawnameMap);
  check('直近の参照が自法令の第十条なら「第六条」「第七条」は自法令', q19.length === 2 && q19.every((r) => r.target_law_id === SELF && r.type === 'internal'), q19);
  // 略称（「法」＝親法令）付きの「法第N条」は略称宣言で引く。宣言が無ければ出さない（自法令に落とさない）（抜き取り検証 2026-09-22）
  const q20 = extractQuotedRefs('第九条第一項中「法第三十八条の九」とあるのは「法第三十八条の二十四第三項において準用する法第三十八条の九」と読み替える。', [{ start: 0, end: 6, type: 'internal', target_law_id: SELF, target_article: '9' }], SELF, lawnumMap, lawnameMap, { '法': { lawId: DENPA, lawTitle: '電波法' } });
  check('「法第三十八条の九」は略称宣言の電波法', q20.length === 3 && q20.every((r) => r.target_law_id === DENPA && r.type === 'external' && r.target_law_name === '電波法') && q20[0].text === '法第三十八条の九' && q20[1].target_article === '38_24' && q20[1].target_paragraph === '3', q20);
  const q21 = extractQuotedRefs('第九条第一項中「法第三十八条の九」とあるのは「第十条」と読み替える。', [{ start: 0, end: 6, type: 'internal', target_law_id: SELF, target_article: '9' }], SELF, lawnumMap, lawnameMap);
  check('略称宣言が無い「法第三十八条の九」は出さない（裸の「第十条」は自法令）', q21.length === 1 && q21[0].text === '第十条' && q21[0].target_law_id === SELF, q21);
  const q22 = extractQuotedRefs('「新法第二百六十条及び準用通則法第五条」', [], SELF, lawnumMap, lawnameMap, { '新法': { lawId: MINSO, lawTitle: '民事訴訟法' }, '準用通則法': { lawId: MINPO, lawTitle: '民法' } });
  check('複数文字の略称（新法・準用通則法）', q22.length === 2 && q22[0].target_law_id === MINSO && q22[1].target_law_id === MINPO && q22[1].text === '準用通則法第五条', q22);
  // 「法」の宣言があっても「同法」「架空法」「通則法」の「法」を電波法にしない（GPT レビュー 2026-09-22）
  const AB = { '法': { lawId: DENPA, lawTitle: '電波法' } };
  const q23 = extractQuotedRefs('「民法第五条及び同法第六条」', [], SELF, lawnumMap, lawnameMap, AB);
  check('「法」の宣言があっても「同法第六条」は民法', q23.length === 2 && q23[1].text === '同法第六条' && q23[1].target_law_id === MINPO, q23);
  check('「架空法第五条」「通則法第五条」は「法」に吸われず出さない', extractQuotedRefs('「架空法第五条及び通則法第六条」', [], SELF, lawnumMap, lawnameMap, AB).length === 0);
  const q24 = extractQuotedRefs('「において準用する法第五条、法第六条」', [], SELF, lawnumMap, lawnameMap, AB);
  check('「する法第五条」「、法第六条」は電波法（直前が漢字でない）', q24.length === 2 && q24.every((r) => r.target_law_id === DENPA) && q24[0].text === '法第五条' && q24[1].text === '法第六条', q24);
  check('resolveAbbrev の境界', resolveAbbrev('通則法', AB) === null && resolveAbbrev('及び法', AB).name === '法' && resolveAbbrev('法', AB).lawId === DENPA && resolveAbbrev('準用通則法', { '準用通則法': { lawId: MINPO } }).lawId === MINPO);
  // 法令名の前置き（「及び同項並びに」）を除いた位置で並べる（GPT レビュー 2026-09-22）
  const q25 = extractQuotedRefs('「民法第五条第一項及び同項並びに民事訴訟法第六条」', [], SELF, lawnumMap, lawnameMap);
  check('「民法第五条第一項及び同項並びに民事訴訟法第六条」の同項は民法 5 条 1 項', q25.length === 3 && q25[1].text === '同項' && q25[1].target_law_id === MINPO && q25[1].target_article === '5' && q25[1].target_paragraph === '1' && q25[2].text === '民事訴訟法第六条' && q25[2].target_law_id === MINSO, q25);
  const q27 = extractQuotedRefs('「民法第五条第一項及び同項並びに民事訴訟法（平成八年法律第百九号）第六条」', [], SELF, lawnumMap, lawnameMap);
  check('法令番号付きでも前置きを外す（同項は民法 5 条 1 項のまま残る）', q27.length === 3 && q27[1].text === '同項' && q27[1].target_law_id === MINPO && q27[1].target_paragraph === '1' && q27[2].text === '民事訴訟法（平成八年法律第百九号）第六条' && q27[2].target_law_id === MINSO, q27);
  const q26 = extractQuotedRefs('「民法第五条第一項及び同項並びに架空法第六条」', [], SELF, lawnumMap, lawnameMap);
  check('知らない法令名の前の同項は民法 5 条 1 項（架空法は出さない）', q26.length === 2 && q26[1].text === '同項' && q26[1].target_law_id === MINPO, q26);
  // 読み替えの相手が別法令なら、自法令の略称宣言は当てない（抜き取り検証 2026-09-22: 私学共済法施行規則 43 条）
  const t28 = '厚生年金保険法施行規則第四十四条第一項中「障害手当金（事業団」とあるのは、「障害手当金（法第七十八条の二十二に規定する一の期間に係るものに限り、かつ、事業団」とする。';
  const q28 = extractQuotedRefs(t28, [{ start: 0, end: 15, type: 'external', target_law_id: HISHO, target_law_name: '厚生年金保険法施行規則', target_article: '44', target_paragraph: '1' }], SELF, lawnumMap, lawnameMap, { '法': { lawId: DENPA, lawTitle: '電波法' } });
  check('相手が他法令の読み替えの中の「法第N条」に自法令の略称は当てない（出さない）', q28.length === 0, q28);
  // 「附則第N条」は本則の条に落とさない（抜き取り検証 2026-09-22）
  const q29 = extractQuotedRefs('「並びに法附則第二十条の三第四項において読み替えて適用する同条第二項の規定」', [], SELF, lawnumMap, lawnameMap, { '法': { lawId: DENPA, lawTitle: '電波法' } });
  check('「附則第二十条の三」は出さない（続く同条も出さない）', q29.length === 0, q29);
  const q14 = extractQuotedRefs('「第五条及び民法第六条第一項」', [], SELF, lawnumMap, lawnameMap);
  check('「第五条及び民法第六条」で第五条を落とさない（法令名に「第」を含めない）', q14.length === 2 && q14[0].text === '第五条' && q14[0].target_law_id === SELF && q14[1].text === '民法第六条第一項' && q14[1].target_law_id === MINPO && q14[1].target_article === '6', q14);
  // 知らない改正法名を、その中に含まれる別の法令（民法）に落とさない（GPT レビュー 2026-09-22）
  check('「民法の一部を改正する法律第五条」は出さない', extractQuotedRefs('「民法の一部を改正する法律第五条」', [], SELF, lawnumMap, lawnameMap).length === 0);
  check('resolveLawName は末尾まで一致する候補だけ', resolveLawName('民法の一部を改正する法律', lawnameMap) === null && resolveLawName('改正後の民法', lawnameMap).lawId === MINPO);
  // lawtext の切り分けで新たに扱えるもの
  const q31 = extractQuotedRefs('「第五条から第七条まで及び第九条第一項第二号ロ」', [], SELF, lawnumMap, lawnameMap);
  check('「第五条から第七条まで」は両端、「第九条第一項第二号ロ」は条・項・号', q31.length === 3 && q31[0].target_article === '5' && q31[1].target_article === '7' && q31[2].target_article === '9' && q31[2].target_paragraph === '1' && q31[2].target_item === '2', q31);
  const q32 = extractQuotedRefs('「前項の規定により読み替えて適用する第十条第一項」', [], SELF, lawnumMap, lawnameMap);
  check('「前項」は出さず「第十条第一項」だけ', q32.length === 1 && q32[0].text === '第十条第一項' && q32[0].target_article === '10', q32);
  const q33 = extractQuotedRefs('「民法第五条に規定する者及び第三条並びに同法第六条」', [], SELF, lawnumMap, lawnameMap);
  check('並びの途中の「同法第六条」は明示された民法（第三条は自法令）', q33.length === 3 && q33[1].target_law_id === SELF && q33[2].text === '同法第六条' && q33[2].target_law_id === MINPO, q33);
  const q36 = extractQuotedRefs('「民法第五条に規定する者については、同条第二項を適用する。」', [], SELF, lawnumMap, lawnameMap);
  check('並びが分かれても「同条第二項」は直前の民法 5 条を受ける', q36.length === 2 && q36[1].text === '同条第二項' && q36[1].target_law_id === MINPO && q36[1].target_article === '5' && q36[1].target_paragraph === '2', q36);
  const q35 = extractQuotedRefs('「第五条及び前条第二項並びに同条第三項」', [], SELF, lawnumMap, lawnameMap);
  check('「前条」を飛ばした後の「同条第三項」は第五条に付けない（GPT レビュー）', q35.length === 1 && q35[0].text === '第五条', q35);
  const q34 = extractQuotedRefs('「第三百六十一条第一項第四号及び第五号ロ」', [], SELF, lawnumMap, lawnameMap);
  check('号だけの「第五号ロ」は同じ並びの条と項を受ける', q34.length === 2 && q34[1].text === '第五号ロ' && q34[1].target_article === '361' && q34[1].target_paragraph === '1' && q34[1].target_item === '5', q34);
  check('fragmentNum', fragmentNum('第七十条の六の二') === '70_6_2' && fragmentNum('第三項') === '3' && fragmentNum('第二号') === '2' && fragmentNum('附則') === null);
  check('鉤括弧が無ければ何もしない', extractQuotedRefs('第五条の規定を準用する。', [], SELF, lawnumMap, lawnameMap).length === 0);
  check('知らない法令名が付いていれば出さない', extractQuotedRefs('「架空法第三条」', [], SELF, lawnumMap, lawnameMap).length === 0);
  check('既に拾った位置とは重ねない', extractQuotedRefs('「第五条」', [{ start: 1, end: 4 }], SELF, lawnumMap, lawnameMap).length === 0);
  // 既にある参照と重なるものは出さないが、文脈には使う（GPT レビュー 2026-09-22）
  const q30 = extractQuotedRefs('「民法第五条及び第六条」', [{ start: 1, end: 6, type: 'external', target_law_id: MINPO, target_law_name: '民法', target_article: '5' }], SELF, lawnumMap, lawnameMap);
  check('既にある「民法第五条」と重なっても、続く「第六条」は民法', q30.length === 1 && q30[0].text === '第六条' && q30[0].target_law_id === MINPO && q30[0].target_article === '6', q30);
  check('同条だけ（前に条が無い）は出さない', extractQuotedRefs('「同条第二項」', [], SELF, lawnumMap, lawnameMap).length === 0);
  check('resolveLawName は末尾からの最長一致', resolveLawName('改正後の借地借家法', lawnameMap).lawId === SELF && resolveLawName('架空法', lawnameMap) === null);
  check('kanjiToNumber', kanjiToNumber('百三十三') === 133 && kanjiToNumber('千二百') === 1200 && kanjiToNumber('二十一') === 21);
}


// ---- processLawXML 経由（lawtext が入っていれば。NODE_PATH で .tools/node_modules を指す）:
//      鉤括弧の前の法令文脈が略称（varref）だけのケースは、VarRef の登録より後に「」内を抽出しないと自法令に落ちる
(async () => {
  let lawtext = null;
  try { lawtext = require('lawtext'); } catch (e) { console.log('SKIP  「」内の抽出と processLawXML 経由（lawtext が無い。NODE_PATH に lawtext を入れると走る）'); }
  if (lawtext) {
    quotedTests(await loadQuotedTokenizer());
    const { processLawXML, buildLawnameMap } = require('./rebuild/lib/refs_extract.cjs');
    const xml = '<?xml version="1.0" encoding="UTF-8"?><Law Era="Reiwa" Lang="ja" LawType="Act" Num="1" Year="8"><LawNum>令和八年法律第一号</LawNum><LawBody><LawTitle>試験法</LawTitle><MainProvision>'
      + '<Article Num="1"><ArticleTitle>第一条</ArticleTitle><Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>民事訴訟法（平成八年法律第百九号。以下「民訴法」という。）の規定を準用する。</Sentence></ParagraphSentence></Paragraph></Article>'
      + '<Article Num="2"><ArticleTitle>第二条</ArticleTitle><Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>民訴法中「第五条」とあるのは「第六条第一項」と読み替える。</Sentence></ParagraphSentence></Paragraph></Article>'
      + '<Article Num="3"><ArticleTitle>第三条</ArticleTitle><Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>第一条中「甲」とあるのは「民訴法第七条に規定する乙」と読み替える。</Sentence></ParagraphSentence></Paragraph></Article>'
      + '<Article Num="4"><ArticleTitle>第四条</ArticleTitle><Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>電波法（昭和二十五年法律第百三十一号。以下この条において「法」という。）の規定を準用する。</Sentence></ParagraphSentence></Paragraph><Paragraph Num="2"><ParagraphNum>２</ParagraphNum><ParagraphSentence><Sentence>第一条中「甲」とあるのは「法第八条に規定する丙」と読み替える。</Sentence></ParagraphSentence></Paragraph></Article>'
      + '<Article Num="5"><ArticleTitle>第五条</ArticleTitle><Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>民法（明治二十九年法律第八十九号。以下「法」という。）の規定を準用する。</Sentence></ParagraphSentence></Paragraph><Paragraph Num="2"><ParagraphNum>２</ParagraphNum><ParagraphSentence><Sentence>第一条中「甲」とあるのは「法第九条に規定する丁」と読み替える。</Sentence></ParagraphSentence></Paragraph></Article>'
      + '</MainProvision></LawBody></Law>';
    const TEST = '508AC0000000001';
    const lawnumMap = { '平成八年法律第百九号': { lawId: MINSO, lawTitle: '民事訴訟法' }, '昭和二十五年法律第百三十一号': { lawId: DENPA, lawTitle: '電波法' }, '明治二十九年法律第八十九号': { lawId: MINPO, lawTitle: '民法' } };
    const refs = await processLawXML(lawtext, xml, TEST, lawnumMap, buildLawnameMap(lawnumMap));
    const a2 = refs[`${TEST}_Art2`] || [];
    const v = a2.find((r) => r.type === 'varref');
    const q = a2.filter((r) => r.quoted);
    check('略称「民訴法」が varref で拾われる', !!v && v.target_law_id === MINSO, a2);
    check('鉤括弧の前が略称だけでも「」内の第N条は民訴法（自法令に落ちない）', q.length === 2 && q.every((r) => r.target_law_id === MINSO && r.type === 'external') && q[1].target_article === '6' && q[1].target_paragraph === '1', q);
    const a3 = (refs[`${TEST}_Art3`] || []).filter((r) => r.quoted);
    check('「」内の略称付き「民訴法第七条」は宣言（declarations）で民訴法に引く', a3.length === 1 && a3[0].text === '民訴法第七条' && a3[0].target_law_id === MINSO && a3[0].target_article === '7', a3);
    // 同じ略称「法」でも、宣言の適用範囲（この条において＝第四条だけ／以下＝第五条から）で引き分ける
    const a4 = (refs[`${TEST}_Art4`] || []).filter((r) => r.quoted);
    const a5 = (refs[`${TEST}_Art5`] || []).filter((r) => r.quoted);
    check('第四条の「法第八条」は「この条において」の電波法', a4.length === 1 && a4[0].target_law_id === DENPA && a4[0].target_article === '8', a4);
    check('第五条の「法第九条」は民法（第四条の宣言は範囲外）', a5.length === 1 && a5[0].target_law_id === MINPO && a5[0].target_article === '9', a5);

    // 「令」の宣言が無い施行規則の「令第○条」は同じ名前の施行令（2026-10-12。地方公務員等共済組合法施行規則で宣言の条が削除された）
    const RULE = '508M60000000001', REI = '508CO0000000001';
    const art = (n, t, ps) => `<Article Num="${n}"><ArticleTitle>${t}</ArticleTitle>${ps.map((s, i) => `<Paragraph Num="${i + 1}"><ParagraphNum>${i ? '２' : ''}</ParagraphNum><ParagraphSentence><Sentence>${s}</Sentence></ParagraphSentence></Paragraph>`).join('')}</Article>`;
    const ruleXml = (decl) => '<?xml version="1.0" encoding="UTF-8"?><Law Era="Reiwa" Lang="ja" LawType="MinisterialOrdinance" Num="1" Year="8"><LawNum>令和八年総務省令第一号</LawNum><LawBody><LawTitle>試験法施行規則</LawTitle><MainProvision>'
      + art(1, '第一条', [decl ? '民法（明治二十九年法律第八十九号。以下「令」という。）の規定を準用する。' : 'この省令は、試験法の実施のための細則を定める。'])
      + art(2, '第二条', ['令第三条第一項第七号及び第四十二条第一項第十一号の総務省令で定める者は、次に掲げる者とする。'])
      + art(3, '第三条', ['令第五条第二項に規定する書類は、同条第三項の様式によるものとし、前条の書類とし、同条第二項の規定により提出する。'])
      + art(4, '第四条', ['政令第六条及び同法第七条の規定を準用する。この場合において、他規則第一条中「令第八条」とあるのは「第九条」と読み替える。'])
      + '<Article Num="5"><ArticleTitle>第五条</ArticleTitle><Paragraph Num="1"><ParagraphNum/><ParagraphSentence><Sentence>令第十条の規定の適用については、次の表のとおり読み替える。</Sentence></ParagraphSentence>'
      + '<TableStruct><Table><TableRow><TableColumn><Sentence>同条第二項</Sentence></TableColumn><TableColumn><Sentence>令第十一条</Sentence></TableColumn></TableRow></Table></TableStruct></Paragraph></Article>'
      + '</MainProvision></LawBody></Law>';
    const rmap = { '令和八年総務省令第一号': { lawId: RULE, lawTitle: '試験法施行規則' }, '令和八年政令第一号': { lawId: REI, lawTitle: '試験法施行令' }, '明治二十九年法律第八十九号': { lawId: MINPO, lawTitle: '民法' } };
    const rr = await processLawXML(lawtext, ruleXml(false), RULE, rmap, buildLawnameMap(rmap));
    const r2 = rr[`${RULE}_Art2`] || [];
    const toRei = (arr) => arr.filter((r) => r.target_law_id === REI && r.type === 'external');
    check('宣言の無い「令第三条…及び第四十二条…」は施行令の 3 条・42 条（並びの続きも）', toRei(r2).map((r) => r.target_article).join(',') === '3,42' && toRei(r2)[0].target_paragraph === '1' && toRei(r2)[0].target_item === '7', r2);
    check('「令」の文字は施行令への varref', r2.some((r) => r.type === 'varref' && r.text === '令' && r.target_law_id === REI && r.start === 0 && r.end === 1), r2);
    check('自法令の第三条への誤ったリンクにしない', !r2.some((r) => r.type === 'internal' && r.target_article === '3'), r2);
    const r3 = rr[`${RULE}_Art3`] || [];
    check('「前条」は自法令のまま', r3.some((r) => r.text === '前条' && r.type === 'internal' && r.target_law_id === RULE), r3);
    check('令の条のすぐ後の「同条第三項」は施行令', r3.some((r) => r.text === '同条第三項' && r.target_law_id === REI), r3);
    check('「前条」の後の「同条第二項」は自法令（前条を受ける）', r3.some((r) => r.text === '同条第二項' && r.target_law_id === RULE), r3);
    const r4 = rr[`${RULE}_Art4`] || [];
    check('「政令第六条」「同法第七条」「」内の「令第八条」は施行令にしない', toRei(r4).length === 0 && !r4.some((r) => r.type === 'varref' && r.target_law_id === REI), r4);
    const r5 = rr[`${RULE}_Art5`] || [];
    check('表の外の「令第十条」は施行令、表の中の「同条第二項」「令第十一条」は施行令にしない（GPT レビュー 2026-10-12）',
      toRei(r5).map((r) => r.target_article).join(',') === '10' && !r5.some((r) => r.target_law_id === REI && (r.text === '同条第二項' || r.target_article === '11')), r5);
    const rd = await processLawXML(lawtext, ruleXml(true), RULE, rmap, buildLawnameMap(rmap));
    check('「令」の宣言がある法令は宣言どおり（施行令に読み替えない）', toRei(rd[`${RULE}_Art2`] || []).length === 0 && (rd[`${RULE}_Art2`] || []).some((r) => r.target_law_id === MINPO), rd[`${RULE}_Art2`]);
  }
  console.log(fails ? `\n${fails} 件失敗` : '\nすべて通過');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
