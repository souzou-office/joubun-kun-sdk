#!/usr/bin/env node
// AI検査用データセット生成。
//   方向A (precision): 「親の委任表現」と「候補の子条文」のペア → 受け皿として正しいか
//   方向B (recall):    親条文の本文のみ (ツールの列挙結果は渡さない) → 独立に列挙させる
// 実行: node 03_build_eval_set.cjs <parent_law_id>...
// 出力: rebuild_output/delegations/eval_set.json
'use strict';
const fs = require('fs');
const path = require('path');
const { DELEG_DIR, loadLaw, walkSentences } = require('./lib.cjs');

// 再現性のための決定論的乱数 (LCG)
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function sample(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

const lawCache = new Map();
function law(id) {
  if (!lawCache.has(id)) lawCache.set(id, loadLaw(id));
  return lawCache.get(id);
}
const sentCache = new Map();
function sentencesOf(id) {
  if (!sentCache.has(id)) sentCache.set(id, [...walkSentences(law(id))]);
  return sentCache.get(id);
}
function findSentence(id, article, paragraph, item, subitem) {
  return sentencesOf(id).find(s => s.article === article && s.paragraph === paragraph &&
    (s.item || null) === (item || null) && (s.subitem || null) === (subitem || null) &&
    s.provision === 'main');
}

const IROHA = 'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセスン';
// subitem パス "1/2" → 「イ(2)」風のラベル
function subitemLabel(subitem) {
  if (!subitem) return '';
  const parts = String(subitem).split('/');
  let s = IROHA[parseInt(parts[0], 10) - 1] || parts[0];
  if (parts[1]) s += `(${parts[1]})`;
  return s;
}

// 方向A: 委任1件 × 候補1件 のペア
function buildA(parents) {
  const items = [];
  // 拡張監査 (多数の法令×少数サンプル) 用に環境変数で上書き可能
  const PER_STATUS = process.env.EVAL_PER_STATUS
    ? Object.fromEntries(process.env.EVAL_PER_STATUS.split(',').map(s => { const [k, v] = s.split(':'); return [k, parseInt(v, 10)]; }))
    : { confirmed: 24, multiple: 8, weak: 8 };
  for (const pid of parents) {
    const linked = JSON.parse(fs.readFileSync(path.join(DELEG_DIR, `linked_${pid}.json`), 'utf-8'));
    for (const [status, n] of Object.entries(PER_STATUS)) {
      const pool = linked.delegations.filter(d => d.provision === 'main' && d.status === status && d.candidates.length);
      for (const d of sample(pool, n)) {
        // status を決めた候補のみ検査する:
        // confirmed/multiple は strong 候補 (それが主張の本体)。
        // weak は weak 候補 (「関連条文」としての妥当性を測る)。
        // confirmed に weak の関連候補を混ぜると precision が汚染される。
        const repStrength = status === 'weak' ? 'weak' : 'strong';
        // 種別不整合フラグ付きの候補は status を決めていない (別扱いの再委任疑い) ので評価対象にしない
        const cands = d.candidates.filter(c => c.strength === repStrength &&
          (repStrength === 'weak' || (c.kind_ok !== false && !c.kind_mismatch)));
        for (const c of cands.slice(0, 2)) {
          const ps = findSentence(pid, d.parent_article, d.parent_paragraph, d.parent_item, d.parent_subitem);
          const cs = findSentence(c.law_id, c.article, c.paragraph, c.item, c.subitem);
          // 同一文に同種の委任表現が複数あるとき、どの出現を問うているかを ≪≫ で明示する
          // (これが無いとジャッジが隣の委任と取り違えて誤 wrong を出す)
          let markedContext = d.context;
          if (ps && Array.isArray(d.offset) && ps.text.slice(d.offset[0], d.offset[1]) === d.expr) {
            const [o0, o1] = d.offset;
            const s = Math.max(0, o0 - 40);
            markedContext = (s > 0 ? '…' : '') + ps.text.slice(s, o0) + '≪' + d.expr + '≫' +
              ps.text.slice(o1, o1 + 40) + (o1 + 40 < ps.text.length ? '…' : '');
          } else if (Array.isArray(d.offset)) {
            // 親文が特定できない場合も context 内の位置 (o0 - max(0, o0-30)) でマークする
            const rel = Math.min(30, d.offset[0]);
            if (d.context.slice(rel, rel + d.expr.length) === d.expr) {
              markedContext = d.context.slice(0, rel) + '≪' + d.expr + '≫' + d.context.slice(rel + d.expr.length);
            }
          }
          items.push({
            id: `A${items.length}`,
            parent_law_id: pid,
            parent_law_title: linked.parent_law_title,
            parent_pos: { article: d.parent_article, title: d.parent_article_title, paragraph: d.parent_paragraph, item: d.parent_item, subitem: d.parent_subitem || null },
            expr: d.expr,
            kind: d.kind,
            delegation_context: markedContext,
            parent_sentence: ps ? ps.text.slice(0, 600) : null,
            status: d.status,
            candidate: {
              law_id: c.law_id, law_title: c.law_title, article: c.article,
              article_title: c.article_title, paragraph: c.paragraph, item: c.item, subitem: c.subitem || null,
              strength: c.strength, matched_pattern: c.matched_pattern, ref_type: c.ref_type,
              cite_text: c.cite_text,
              sentence: cs ? cs.text.slice(0, 800) : c.snippet,
            },
            delegation_key: [d.parent_article, d.parent_paragraph, d.parent_item, d.parent_subitem, d.offset[0]].join(':'),
          });
        }
      }
    }
  }
  return items;
}

// 方向B: 親条文の本文まるごと (本則のみ)
function buildB(parents) {
  const items = [];
  const HIT_N = parseInt(process.env.EVAL_B_HIT || '8', 10);
  const SUSPECT_N = parseInt(process.env.EVAL_B_SUSPECT || '4', 10);
  for (const pid of parents) {
    const raw = JSON.parse(fs.readFileSync(path.join(DELEG_DIR, `raw_${pid}.json`), 'utf-8'));
    const l = law(pid);
    const arts = l.articles.filter(a => a.type === 'article');
    const hitArts = new Set(raw.delegations.filter(d => d.provision === 'main').map(d => d.article));
    // 本則の条だけ (最初の番号逆行まで)
    const { markProvisions } = require('./lib.cjs');
    const marked = markProvisions(arts).filter(a => a.provision === 'main');
    const withHit = marked.filter(a => hitArts.has(a.number) && (a.full_text || '').length < 6000);
    const suspicious = marked.filter(a => !hitArts.has(a.number) &&
      /(政令|省令|府令|規則|命令|告示)/.test(a.full_text || '') && /定め/.test(a.full_text || '') &&
      (a.full_text || '').length < 6000);
    for (const a of [...sample(withHit, HIT_N), ...sample(suspicious, SUSPECT_N)]) {
      items.push({
        id: `B${items.length}`,
        parent_law_id: pid,
        parent_law_title: raw.law_title,
        article: a.number,
        article_title: a.title,
        full_text: a.full_text,
        tool_count: raw.delegations.filter(d => d.provision === 'main' && d.article === a.number).length,
      });
    }
  }
  return items;
}

function main() {
  const parents = process.argv.slice(2);
  if (!parents.length) { console.error('Usage: node 03_build_eval_set.cjs <parent_law_id>...'); process.exit(1); }
  const a = buildA(parents);
  const b = buildB(parents);
  const out = { built_for: parents, direction_a: a, direction_b: b };
  fs.writeFileSync(path.join(DELEG_DIR, 'eval_set.json'), JSON.stringify(out, null, 1), 'utf-8');
  console.log(`direction A: ${a.length} pairs, direction B: ${b.length} articles`);
  const byStatus = {};
  for (const x of a) byStatus[x.status] = (byStatus[x.status] || 0) + 1;
  console.log('A by status:', JSON.stringify(byStatus));
}

main();
