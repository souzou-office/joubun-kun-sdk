// 判例の逆引きの 301 件目以降（hanrei_v2/links_more/。2026-10-18 のオーナーの依頼「条文ページで全部見られるように」）
//   hanrei_v2/links/{法令ID}.json は今までどおり条ごとに上位 300 件（07 と同じ並び: 裁判所のランク → 判決日 → id の降順）。
//   300 件を超える条だけ、残りを hanrei_v2/links_more/{法令ID}/{条キー（「の」は「_」）}.json = { total, items } に置く（items は 301 件目からの続き）。
//   全件の作り直し（relink_hanrei.cjs）・判例の週次（weekly/run.cjs）・条番号の無い判例（nonum_cases.cjs）は、上位 300 件から押し出された判例を
//   ここに移す（捨てない）。条文ページは /law/{法令ID}/{条}/hanrei/{N} で 300 件ずつ出す（worker/lawpages.js）。
'use strict';

const LINKS_TOP = 300;
const MORE_PREFIX = 'hanrei_v2/links_more';
const moreKey = (lawId, art) => `${MORE_PREFIX}/${lawId}/${String(art).replace(/の/g, '_')}.json`;

/**
 * 今の上位（cur.items）・続き（more.items）・足す item を合わせて並べ直し、上位 300 件と続きに分ける
 * @param {{total:number, items:object[]}} cur links の条のエントリ
 * @param {object[]} moreItems links_more の items（無ければ []）
 * @param {object[]} add 足す item（同じ id が既にあれば足さない）
 * @param {(v:object)=>{r:number,d:string}} sortKey 裁判所のランクと判決日（ISO）
 * @returns {{ total:number, items:object[], more:object[], added:number }}
 */
function mergeTop(cur, moreItems, add, sortKey) {
  const have = new Set([...(cur.items || []), ...(moreItems || [])].map((x) => String(x.id)));
  const fresh = [];
  for (const x of add || []) { const k = String(x.id); if (!have.has(k)) { have.add(k); fresh.push(x); } }
  const all = [...(cur.items || []), ...(moreItems || []), ...fresh].map((v) => ({ v, ...sortKey(v) }));
  all.sort((a, b) => (b.r - a.r) || String(b.d).localeCompare(String(a.d)) || (parseInt(b.v.id, 10) - parseInt(a.v.id, 10)));
  const vs = all.map((x) => x.v);
  return { total: (cur.total || 0) + fresh.length, items: vs.slice(0, LINKS_TOP), more: vs.slice(LINKS_TOP), added: fresh.length };
}

module.exports = { LINKS_TOP, MORE_PREFIX, moreKey, mergeTop };
