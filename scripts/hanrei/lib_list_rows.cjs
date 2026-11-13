// 一覧ページ（search{n}）の行パーサ — 検証済み Python 実装 parse_rows.py の忠実な JS 移植
//
// 一覧行の構造（551行で検証済み）:
//   各<tr>の最初の<td>に<p>が4個。2番目の<p>の中が13行の固定位置テンプレ:
//     idx1=裁判年月日, 2=裁判所名+法廷, 3=支部, 4=部, 5=裁判種別, 6=結果,
//     7=裁判種別(知財高裁行のみ), 8=結果(知財高裁行のみ),
//     10=原審裁判所+原審事件番号, 11=行政分野
//   1番目の<p>: idx1=事件番号, idx2=事件名
//
// parseListRows(html, {collection, sliceKey}) → inventory.ndjson 契約形式の行配列
'use strict';

const { parseCourt, DETAILN_COLLECTION } = require('./lib_common.cjs');

// Python: re.sub(r'\s+',' ',re.sub(r'(?s)<[^>]+>',' ',l)).strip()
function lineClean(l) {
  return l.replace(/<[^>]+>/g, ' ').replace(/[\s　]+/g, ' ').trim();
}

const GENSIN_CASENO_RE = /((?:明治|大正|昭和|平成|令和)[0-9０-９元]+[（(][^）)]*[）)][0-9０-９]+)\s*$/;

function parseListRows(html, opts = {}) {
  const rows = [];
  const warns = [];
  for (const trm of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tr = trm[1];
    const lk = tr.match(/(\d+)\/detail(\d)\/index\.html/);
    if (!lk) continue;
    const id = lk[1];
    const detailN = lk[2];
    const thm = tr.match(/<th[^>]*>([\s\S]*?)<\/th>/);
    const collLabel = thm ? lineClean(thm[1]).replace(/\s+/g, '') : '';
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (!tds.length) continue;
    const ps = [...tds[0].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((x) => x[1]);
    if (ps.length < 2) continue;
    const p0 = ps[0].split('\n').map(lineClean);
    const p1 = ps[1].split('\n').map(lineClean);
    if (p1.length !== 13) {
      warns.push(`unexpected p1 len id=${id} len=${p1.length}`);
      continue;
    }
    const gensinRaw = p1[10] || '';
    let gensinCourt = gensinRaw, gensinCaseNo = '';
    const gm = gensinRaw.match(GENSIN_CASENO_RE);
    if (gm) {
      gensinCaseNo = gm[1];
      gensinCourt = gensinRaw.slice(0, gm.index).trim();
    }
    const { court } = parseCourt(p1[2]);
    const courtDetail = [p1[2], p1[3], p1[4]].filter(Boolean).join(' ').trim();
    rows.push({
      id,
      detailN,
      collection: opts.collection || DETAILN_COLLECTION[detailN] || '',
      collLabel,                      // 一覧<th>の生ラベル（下級裁裁判例行政事件裁判例 等の複合も保持）
      caseNo: p0[1] || '',
      title: p0[2] || '',
      date: p1[1] || '',
      court: court || p1[2] || '',
      branch: p1[3] || '',
      courtDetail,
      kind: p1[5] || p1[7] || '',     // 知財高裁行は idx7
      kekka: p1[6] || p1[8] || '',    // 知財高裁行は idx8
      gensinCourt,
      gensinCaseNo,
      bunya: p1[11] || '',
      sliceKey: opts.sliceKey || '',
    });
  }
  return { rows, warns };
}

module.exports = { parseListRows, lineClean };
