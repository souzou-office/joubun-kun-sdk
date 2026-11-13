#!/usr/bin/env node
/**
 * Prototype v2: lawtext の analysis 出力をフル活用して 1 法令の refs を抽出
 *
 * 設計:
 *   - pointerEnvByEL.values() を iterate (キー参照不要)
 *   - sentenceEnv.parentELs から source article + paragraph を特定
 *   - pointer.range で sentence 内オフセット
 *   - pe.located で target 解決済 (internal/external)
 *   - variableReferences で略称（令、法 等）を別途処理
 *
 * Usage:
 *   node 08_extract_refs_v2_proto.cjs <law_id>
 */

const fs = require('fs');
const path = require('path');
const lawtext = require('lawtext');
const SITE = require('../site_config.cjs');

const FETCHED_DIR = `${SITE.localDataRoot}/rebuild_output/fetched_laws`;
const LAWNUM_MAP_FILE = `${SITE.localDataRoot}/rebuild_output/lawnum_to_lawid.json`;

const lawnumMap = JSON.parse(fs.readFileSync(LAWNUM_MAP_FILE, 'utf-8')).map;

function resolveLawNumToId(lawNum) {
  return lawnumMap[lawNum]?.lawId || null;
}
function resolveLawNumToTitle(lawNum) {
  return lawnumMap[lawNum]?.lawTitle || null;
}

function findSourceArticleParagraphSentence(parentELs, sentenceEl) {
  let article = null, paragraph = null, item = null, subitem = null, subsubitem = null, appdx = null;
  const sentence = sentenceEl?.attr?.Num || null;
  for (const p of parentELs || []) {
    if (p.tag === 'Article') article = p.attr?.Num;
    else if (p.tag === 'Paragraph') paragraph = p.attr?.Num;
    else if (p.tag === 'Item') item = p.attr?.Num;
    else if (p.tag === 'Subitem1') subitem = p.attr?.Num;
    else if (p.tag === 'Subitem2') subsubitem = p.attr?.Num;
    else if (p.tag === 'AppdxTable' || p.tag === 'AppdxNote' || p.tag === 'AppdxStyle' || p.tag === 'AppdxFig' || p.tag === 'AppdxFormat' || p.tag === 'Appdx') {
      appdx = p.attr?.Num || 'main';
    }
  }
  return { article, paragraph, item, subitem, subsubitem, sentence, appdx };
}

function resolveTarget(pe, sourceLawId) {
  if (!pe || !pe.located) return null;

  if (pe.located.type === 'internal') {
    const frags = pe.located.fragments || [];
    const target = {
      type: 'internal',
      target_law_id: sourceLawId,
    };

    // fragments から target_article / target_paragraph / target_item を抜く
    for (const f of frags) {
      const containers = f.containers || [];
      for (const c of containers) {
        if (c.el?.tag === 'Article' && c.el.attr?.Num) target.target_article = c.el.attr.Num;
        if (c.el?.tag === 'Paragraph' && c.el.attr?.Num) target.target_paragraph = c.el.attr.Num;
        if (c.el?.tag === 'Item' && c.el.attr?.Num) target.target_item = c.el.attr.Num;
      }
      // targetType でも別表系を拾う
      const ta = f.fragment?.attr || {};
      if (ta.targetType === 'APPDX' || ta.targetType === 'TableStruct') {
        target.target_appdx = ta.name || '別表';
      }
    }

    // relPos を記録 (PREV/NEXT/SAME/HERE)
    const firstFrag = frags[0]?.fragment;
    if (firstFrag?.attr?.relPos) target.relPos = firstFrag.attr.relPos;

    return target;
  }

  if (pe.located.type === 'external') {
    const lawRef = pe.located.lawRef;
    const lawNum = lawRef?.attr?.lawNum;
    const suggested = lawRef?.attr?.suggestedLawTitle;
    const target_law_id = lawNum ? resolveLawNumToId(lawNum) : null;
    const resolvedTitle = lawNum ? resolveLawNumToTitle(lawNum) : null;

    const target = {
      type: 'external',
      target_law_id,
      target_law_name: resolvedTitle || suggested,
      target_law_num: lawNum,
    };

    // pointer 内の __PF を見て target_article 等を抜く
    function findPFs(el, acc = []) {
      if (!el || typeof el !== 'object') return acc;
      if (el.tag === '____PF') acc.push(el);
      if (el.children) for (const c of el.children) findPFs(c, acc);
      return acc;
    }
    const pfs = findPFs(pe.pointer);
    for (const pf of pfs) {
      const a = pf.attr || {};
      if (a.targetType === 'Article' && a.num) target.target_article = a.num;
      if (a.targetType === 'Paragraph' && a.num) target.target_paragraph = a.num;
      if (a.targetType === 'Item' && a.num) target.target_item = a.num;
      if (a.targetType === 'APPDX') target.target_appdx = a.name || '別表';
      if (a.targetType === 'TableStruct') target.target_appdx = a.name || '同表';
    }

    return target;
  }

  return null;
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

async function processLaw(lawId) {
  const metaPath = path.join(FETCHED_DIR, `${lawId}.json`);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const xmlPath = meta._source?.xml_path;
  const xml = fs.readFileSync(xmlPath, 'utf-8');

  const result = await lawtext.run({
    input: { xml },
    outtypes: ['json'],
    analyze: true,
    controlel: true
  });

  const a = result.analysis;

  const SHORT_LAW_ABBREVS = new Set(['法', '法律', '令', '政令', '規則', '省令', '規程', '条例']);
  // lawname → entry 逆引き
  const lawnameToLawid = {};
  for (const [num, info] of Object.entries(lawnumMap)) {
    if (info.lawTitle) lawnameToLawid[info.lawTitle] = { lawId: info.lawId, lawNum: num };
  }

  // declarations 索引化 (declarationID → resolved info)
  const declMap = {};
  for (const d of a.declarations.values()) {
    const id = d.attr.declarationID;
    const value = d.attr.value ? JSON.parse(d.attr.value) : {};
    let declType = d.attr.type;
    let lawNum = value.text || null;
    let target_law_id = lawNum ? resolveLawNumToId(lawNum) : null;
    let target_law_name = lawNum ? resolveLawNumToTitle(lawNum) : null;

    if (declType === 'Keyword' && SHORT_LAW_ABBREVS.has(d.attr.name)) {
      const r = value.sentenceTextRange;
      if (r && r.start && r.end && r.start.sentenceIndex === r.end.sentenceIndex) {
        const se = a.sentenceEnvs[r.start.sentenceIndex];
        if (se && se._text) {
          const precText = se._text.substring(r.start.textOffset, r.end.textOffset);
          const lastParenIdx = Math.max(precText.lastIndexOf('（'), precText.lastIndexOf('('));
          const beforeParen = (lastParenIdx >= 0 ? precText.substring(0, lastParenIdx) : precText).trim();
          let cleaned = null;
          let entry = null;
          const suffixRe = /(法律|政令|省令|法|令|規則|規程|条例)/g;
          const matches = [];
          let mm;
          while ((mm = suffixRe.exec(beforeParen)) !== null) matches.push(mm.index + mm[0].length);
          for (let i = matches.length - 1; i >= 0; i--) {
            const endPos = matches[i];
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

    declMap[id] = { name: d.attr.name, type: declType, lawNum, target_law_id, target_law_name };
  }

  const refsByArticle = {};

  function pushRef(articleId, ref) {
    if (!articleId) return;
    if (!refsByArticle[articleId]) refsByArticle[articleId] = [];
    refsByArticle[articleId].push(ref);
  }

  // ===== Pointer 系を pointerEnvByEL から処理 =====
  for (const pe of a.pointerEnvByEL.values()) {
    const parentELs = pe.sentenceEnv?.parentELs;
    if (!parentELs) continue;
    const { article, paragraph, sentence, appdx } = findSourceArticleParagraphSentence(parentELs, pe.sentenceEnv?.el);
    if (!article && !appdx) continue;
    const articleId = `${lawId}_Art${article || appdx}`;

    const text = collectText(pe.pointer);
    const range = pe.pointer.range; // [start, end] within sentence
    const target = resolveTarget(pe, lawId);
    if (!target) continue;

    pushRef(articleId, {
      text,
      paragraph,
      sentence,
      start: range?.[0],
      end: range?.[1],
      ...target
    });
  }

  // ===== variableReferences (略称使用箇所) =====
  for (const vr of a.variableReferences) {
    const refRange = vr.attr.refSentenceTextRange ? JSON.parse(vr.attr.refSentenceTextRange) : null;
    if (!refRange) continue;
    const sIdx = refRange.start.sentenceIndex;
    const se = a.sentenceEnvs[sIdx];
    if (!se) continue;
    const { article, paragraph, sentence, appdx } = findSourceArticleParagraphSentence(se.parentELs, se.el);
    if (!article && !appdx) continue;
    const articleId = `${lawId}_Art${article || appdx}`;

    const declId = vr.attr.declarationID;
    const decl = declMap[declId];
    if (!decl || decl.type !== 'LawTitle') continue;  // Keyword は skip

    pushRef(articleId, {
      text: collectText(vr),
      paragraph,
      sentence,
      start: refRange.start.textOffset,
      end: refRange.end.textOffset,
      type: 'varref',
      abbreviation: vr.attr.refName,
      target_law_id: decl.target_law_id,
      target_law_name: decl.target_law_name || decl.name,
      target_law_num: decl.lawNum
    });
  }

  return refsByArticle;
}

async function main() {
  const lawId = process.argv[2] || '344M50000040039';
  const refs = await processLaw(lawId);

  // 第九条 を表示
  const target = `${lawId}_Art9`;
  const list = refs[target] || [];
  console.log(`\n=== ${target} (${list.length} refs) ===`);
  for (const r of list) {
    const t = r.target_law_id ? `${r.target_law_id} ${r.target_article || ''}${r.target_paragraph ? '§' + r.target_paragraph : ''}${r.target_item ? '号' + r.target_item : ''}${r.target_appdx ? ' [' + r.target_appdx + ']' : ''}` : '(unresolved)';
    console.log(`  para ${r.paragraph} sent ${r.sentence} [${r.start}-${r.end}] "${r.text}" → ${r.type} ${t}`);
  }

  // 全体統計
  let total = 0;
  const byType = {};
  for (const arr of Object.values(refs)) {
    for (const r of arr) {
      total++;
      byType[r.type] = (byType[r.type] || 0) + 1;
    }
  }
  console.log(`\n=== Stats (${lawId}) ===`);
  console.log('total refs:', total);
  console.log('by type:', byType);

  const outFile = `${SITE.localDataRoot}/rebuild_output/proto_refs_${lawId}.json`;
  fs.writeFileSync(outFile, JSON.stringify(refs, null, 2), 'utf-8');
  console.log(`\nFull output: ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
