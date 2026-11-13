#!/usr/bin/env node
// Claude API による検査。
//   方向A: 候補が受け皿として正しいか (correct / wrong / ambiguous + 理由)
//   方向B: 条文本文から委任表現を独立に全列挙
// キーは .dev.vars の CLAUDE_API_KEY (または環境変数) を使う。
// 実行: node 04_ai_audit.cjs [--only-a|--only-b]
// 出力: rebuild_output/delegations/audit_result.json (逐次追記・再開可能)
'use strict';
const fs = require('fs');
const path = require('path');
const { DELEG_DIR } = require('./lib.cjs');
const SITE = require('../site_config.cjs');

const MODEL = 'claude-sonnet-5';
const OPUS = 'claude-opus-5';
const CONCURRENCY = 6;

function apiKey() {
  if (process.env.CLAUDE_API_KEY) return process.env.CLAUDE_API_KEY.trim();
  const dv = fs.readFileSync(`${SITE.localDataRoot}/.dev.vars`, 'utf-8');
  const m = dv.match(/^CLAUDE_API_KEY=(.+)$/m);
  if (!m) throw new Error('CLAUDE_API_KEY not found');
  return m[1].trim();
}
const KEY = apiKey();

async function callClaude(model, system, user, maxTokens = 1024) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model, max_tokens: maxTokens, system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = 2000 * (attempt + 1) ** 2;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      const textBlock = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { text: textBlock, usage: j.usage };
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const SYSTEM_A = `あなたは日本法の法制執務に精通した審査官です。
「親法令の委任表現」と「子法令の条文」のペアを審査し、子条文がその委任表現の受け皿(委任を受けて具体的内容を定める規定)として正しいかを判定してください。

判定基準:
- correct: 子条文が、まさにこの委任表現を受けて内容を定めている
- wrong: 別の委任の受け皿である、単なる引用・言及にすぎない、手続規定にすぎない等
- ambiguous: 親条文に同種の委任が複数あり原文からどれの受け皿か特定できない、包括委任の一部である等

出力は次のJSONのみ: {"verdict":"correct|wrong|ambiguous","reason":"1〜2文の理由"}`;

const SYSTEM_B = `あなたは日本法の法制執務に精通した審査官です。
与えられた条文本文に含まれる「下位法令への委任表現」をすべて列挙してください。

対象: 政令・省令(財務省令、主務省令等を含む)・内閣府令・委員会規則・規則・告示・命令に「定め」を委ねる表現すべて。
例: 「政令で定める」「政令の定めるところにより」「別に政令で定める」「財務省令で定めるところにより」「規則で定める」「政令に委任する」等。
旧仮名の「勅令ヲ以テ定ム」等も対象。
同一文に複数あればすべて別々に数える。「当該政令」等の照応表現も、それが委任として機能していれば含める。
引用元法令名の一部(「○○法施行令」等の固有名詞)は含めない。

厳守事項:
- expr と quote は本文からの正確な部分文字列 (一字一句そのまま) にすること。要約・言い換え・存在しない表現の創作は禁止
- 登場順に、同じ表現でも出現ごとに1件ずつ、機械的に全件列挙すること (長い条文でも省略しない)

出力は次のJSON配列のみ: [{"expr":"本文から抜き出した表現(例: 政令で定める)","kind":"政令|省令|財務省令|主務省令|内閣府令|委員会規則|規則|告示|命令","quote":"直前の文脈を含む20字程度の正確な引用"}]
1件も無ければ []`;

const IROHA = 'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセスン';
function irohaLabel(subitem) {
  if (!subitem) return '';
  const parts = String(subitem).split('/');
  let s = IROHA[parseInt(parts[0], 10) - 1] || parts[0];
  if (parts[1]) s += `(${parts[1]})`;
  return ` ${s}`;
}

function promptA(it) {
  return `# 親法令: ${it.parent_law_title} ${it.parent_pos.title}${it.parent_pos.paragraph ? ` 第${it.parent_pos.paragraph}項` : ''}${it.parent_pos.item ? ` 第${it.parent_pos.item.replace(/_/g, 'の')}号` : ''}${irohaLabel(it.parent_pos.subitem)}
## 委任表現: 「${it.expr}」(種別: ${it.kind})
## 委任表現の前後 (≪≫ が審査対象の委任表現。同じ文に類似の委任が複数あっても ≪≫ の1つだけを審査すること):
${it.delegation_context}
## 親条文の該当文:
${it.parent_sentence || '(取得不可)'}

# 候補の子法令条文: ${it.candidate.law_title} ${it.candidate.article_title}${it.candidate.paragraph ? ` 第${it.candidate.paragraph}項` : ''}${it.candidate.item ? ` 第${it.candidate.item.replace(/_/g, 'の')}号` : ''}${irohaLabel(it.candidate.subitem)}
## 子条文の本文:
${it.candidate.sentence}

この子条文は、上の委任表現の受け皿として正しいですか。JSONで答えてください。`;
}

function promptB(it) {
  return `# ${it.parent_law_title} ${it.article_title}
## 条文本文:
${it.full_text}

この条文に含まれる下位法令への委任表現をすべて列挙してください。JSON配列で答えてください。`;
}

async function runPool(items, fn) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { error: String(e).slice(0, 200) }; }
      done++;
      if (done % 20 === 0) console.log(`  ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const evalSet = JSON.parse(fs.readFileSync(path.join(DELEG_DIR, 'eval_set.json'), 'utf-8'));
  const outFile = path.join(DELEG_DIR, 'audit_result.json');
  const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf-8')) : {};
  const result = { a: prev.a || {}, b: prev.b || {}, usage: prev.usage || { in: 0, out: 0 } };
  const save = () => fs.writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf-8');

  if (!args.includes('--only-b')) {
    const todo = evalSet.direction_a.filter(it => !result.a[it.id]);
    console.log(`Direction A: ${todo.length} to audit (of ${evalSet.direction_a.length})`);
    const res = await runPool(todo, async it => {
      const r = await callClaude(MODEL, SYSTEM_A, promptA(it), 1024);
      const v = parseJson(r.text);
      result.usage.in += r.usage?.input_tokens || 0;
      result.usage.out += r.usage?.output_tokens || 0;
      return { verdict: v?.verdict || 'parse_error', reason: v?.reason || r.text.slice(0, 200) };
    });
    todo.forEach((it, i) => { result.a[it.id] = res[i]; });
    save();
  }

  if (!args.includes('--only-a')) {
    const todo = evalSet.direction_b.filter(it => !result.b[it.id]);
    console.log(`Direction B: ${todo.length} to audit (of ${evalSet.direction_b.length})`);
    const res = await runPool(todo, async it => {
      const r = await callClaude(MODEL, SYSTEM_B, promptB(it), 2048);
      const v = parseJson(r.text);
      result.usage.in += r.usage?.input_tokens || 0;
      result.usage.out += r.usage?.output_tokens || 0;
      return { found: Array.isArray(v) ? v : null, raw: Array.isArray(v) ? undefined : r.text.slice(0, 300) };
    });
    todo.forEach((it, i) => { result.b[it.id] = res[i]; });
    save();
  }

  // 失敗パターンの言語化 (Opus)。wrong / ambiguous のみ。
  const failures = evalSet.direction_a
    .filter(it => ['wrong', 'ambiguous'].includes(result.a[it.id]?.verdict))
    .map(it => ({ id: it.id, status: it.status, kind: it.kind, expr: it.expr,
      pattern: it.candidate.matched_pattern, strength: it.candidate.strength,
      parent: `${it.parent_law_title}${it.parent_pos.title}`, child: `${it.candidate.law_title}${it.candidate.article_title}`,
      verdict: result.a[it.id].verdict, reason: result.a[it.id].reason }));
  if (failures.length && !args.includes('--skip-opus')) {
    console.log(`Generalizing ${failures.length} failure patterns with Opus...`);
    const r = await callClaude(OPUS,
      'あなたはルールベースの法令参照リンカーの失敗分析者です。個別事例ではなく一般化された失敗パターンと、どのルールをどう直せば防げるかを出力してください。',
      `以下はルールベース委任リンカーの誤り事例です。一般化した失敗パターンごとにまとめ、修正すべきルールを提案してください。\n\n${JSON.stringify(failures, null, 1).slice(0, 30000)}\n\n出力: JSON配列 [{"pattern":"失敗パターンの一般化","count":件数,"rule_fix":"直すべきルールと直し方"}]`,
      16384);
    result.failure_patterns = parseJson(r.text) || r.text;
    result.usage.in += r.usage?.input_tokens || 0;
    result.usage.out += r.usage?.output_tokens || 0;
    save();
  }
  console.log('usage:', JSON.stringify(result.usage));
  console.log('done ->', outFile);
}

main().catch(e => { console.error(e); process.exit(1); });
