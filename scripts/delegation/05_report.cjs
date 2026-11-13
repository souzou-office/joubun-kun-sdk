#!/usr/bin/env node
// 集計: precision (方向A) / recall (方向B) / status分布 / 取りこぼし実例
// 実行: node 05_report.cjs <parent_law_id>...
'use strict';
const fs = require('fs');
const path = require('path');
const { DELEG_DIR } = require('./lib.cjs');

function main() {
  const parents = process.argv.slice(2);
  const evalSet = JSON.parse(fs.readFileSync(path.join(DELEG_DIR, 'eval_set.json'), 'utf-8'));
  const audit = JSON.parse(fs.readFileSync(path.join(DELEG_DIR, 'audit_result.json'), 'utf-8'));

  // ---- status 分布 ----
  console.log('=== status 分布 (本則のみ) ===');
  const totals = {};
  for (const pid of parents) {
    const linked = JSON.parse(fs.readFileSync(path.join(DELEG_DIR, `linked_${pid}.json`), 'utf-8'));
    console.log(`${linked.parent_law_title}: ${JSON.stringify(linked.status_counts)}`);
    for (const [k, v] of Object.entries(linked.status_counts)) totals[k] = (totals[k] || 0) + v;
  }
  console.log('合計:', JSON.stringify(totals));

  // ---- 方向A: precision ----
  console.log('\n=== 方向A precision ===');
  const byStatus = {};
  for (const it of evalSet.direction_a) {
    const v = audit.a[it.id]?.verdict;
    if (!v) continue;
    const s = `${it.status}/${it.candidate.strength}`;
    byStatus[s] = byStatus[s] || { correct: 0, wrong: 0, ambiguous: 0, parse_error: 0, total: 0 };
    byStatus[s][v] = (byStatus[s][v] || 0) + 1;
    byStatus[s].total++;
  }
  let allCorrect = 0, allTotal = 0;
  for (const [s, o] of Object.entries(byStatus)) {
    const p = (o.correct / o.total * 100).toFixed(1);
    console.log(`${s}: ${o.correct}/${o.total} correct (${p}%)  wrong=${o.wrong} ambiguous=${o.ambiguous} parse_error=${o.parse_error}`);
    allCorrect += o.correct; allTotal += o.total;
  }
  console.log(`全体: ${allCorrect}/${allTotal} (${(allCorrect / allTotal * 100).toFixed(1)}%)`);

  // confirmed の誤り全件
  console.log('\n=== confirmed なのに wrong/ambiguous (全件) ===');
  for (const it of evalSet.direction_a) {
    const v = audit.a[it.id];
    if (it.status === 'confirmed' && v && v.verdict !== 'correct') {
      console.log(`- [${it.id}] ${it.parent_law_title}${it.parent_pos.title} 「${it.expr}」 → ${it.candidate.law_title}${it.candidate.article_title}: ${v.verdict}`);
      console.log(`    理由: ${v.reason}`);
    }
  }

  // ---- 方向B: recall ----
  console.log('\n=== 方向B recall ===');
  const rawCache = {};
  const raw = pid => rawCache[pid] || (rawCache[pid] = JSON.parse(fs.readFileSync(path.join(DELEG_DIR, `raw_${pid}.json`), 'utf-8')));
  let toolTotal = 0, aiTotal = 0, aiFabricated = 0, matchedTotal = 0, aiOnlyList = [], toolOnlyList = [];
  for (const it of evalSet.direction_b) {
    const found = audit.b[it.id]?.found;
    if (!found) continue;
    const ft = it.full_text || '';
    const toolDelegs = raw(it.parent_law_id).delegations.filter(d => d.provision === 'main' && d.article === it.article);
    const toolUsed = new Set();
    const aiOnly = [];
    // ハルシネーション除去: expr か quote が本文に実在する項目のみ採用。
    // 同一 expr の重複列挙は本文中の出現回数までに制限。
    const exprCount = {};
    const verified = found.filter(f => {
      if (!f.expr) return false;
      const inText = ft.includes(f.expr) || (f.quote && ft.includes(f.quote));
      if (!inText) { aiFabricated++; return false; }
      const occ = ft.split(f.expr).length - 1 || 1;
      exprCount[f.expr] = (exprCount[f.expr] || 0) + 1;
      if (exprCount[f.expr] > occ) { aiFabricated++; return false; }
      return true;
    });
    for (const f of verified) {
      let hit = -1;
      for (let i = 0; i < toolDelegs.length; i++) {
        if (toolUsed.has(i)) continue;
        const t = toolDelegs[i];
        if (t.expr.includes(f.expr) || f.expr.includes(t.expr) ||
            (f.quote && (f.quote.includes(t.expr) || t.context.includes(f.quote.slice(-10))))) { hit = i; break; }
      }
      if (hit >= 0) { toolUsed.add(hit); matchedTotal++; }
      else aiOnly.push(f);
    }
    toolTotal += toolDelegs.length;
    aiTotal += verified.length;
    for (const f of aiOnly) aiOnlyList.push({ law: it.parent_law_title, article: it.article_title, ...f });
    toolDelegs.forEach((t, i) => { if (!toolUsed.has(i)) toolOnlyList.push({ law: it.parent_law_title, article: it.article_title, expr: t.expr, context: t.context }); });
  }
  console.log(`ツール列挙: ${toolTotal} / AI列挙(実在検証後): ${aiTotal} (幻覚・重複除外 ${aiFabricated})`);
  console.log(`一致: ${matchedTotal}`);
  console.log(`AIだけが見つけた (ツール取りこぼし・実在確認済み): ${aiOnlyList.length}`);
  console.log(`ツールだけが見つけた (AI見落とし側・recallには影響しない): ${toolOnlyList.length}`);
  const recall = (matchedTotal + aiOnlyList.length) ? (matchedTotal / (matchedTotal + aiOnlyList.length) * 100).toFixed(1) : 'n/a';
  console.log(`recall = ツール一致 / (一致 + AIのみ実在) = ${recall}%`);

  console.log('\n=== 取りこぼし実例 (AIのみ検出・全件) ===');
  for (const x of aiOnlyList) console.log(`- ${x.law}${x.article} [${x.kind}] 「${x.expr}」 quote: ${x.quote || ''}`);
  console.log('\n=== ツールのみ検出 (先頭20件) ===');
  for (const x of toolOnlyList.slice(0, 20)) console.log(`- ${x.law}${x.article} 「${x.expr}」 …${(x.context || '').slice(0, 40)}…`);

  if (audit.failure_patterns) {
    console.log('\n=== 失敗パターン一般化 (Opus) ===');
    console.log(typeof audit.failure_patterns === 'string' ? audit.failure_patterns : JSON.stringify(audit.failure_patterns, null, 1));
  }
}

main();
