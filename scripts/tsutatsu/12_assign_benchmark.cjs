// 12: 帰属割当（LLM）の精度ベンチマーク。
// 正解既知（「第○条関係」見出しページ＝home.kind==='jou'）の通達から見出しを隠し、
// 候補条（自分の引用∪仲間の引用∪番号プレフィックス∪法令ベクトル上位）からLLMに帰属条を選ばせ、正解一致率を測る。
// → 節型/個別通達（正解が書かれていない4,000件）に同じ方式を使ってよいかの事前検証。
//
//   node scripts/tsutatsu/12_assign_benchmark.cjs --n 40        # 40件（easy/hard半々）
//   node scripts/tsutatsu/12_assign_benchmark.cjs --n 40 --dry  # プロンプト1件表示のみ

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');
const STATE = path.join(__dirname, 'state');
const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;   // 平文の既定値は置かない（鍵は取り替え済み。環境変数で渡す）
if (!KEY) { console.error('環境変数 BYPASS_KEY を設定してください'); process.exit(1); }

const LAWS = {
  'kihon/chosyu': { name: '国税徴収法', id: '334AC0000000147' },
  'kobetsu/chosyu': { name: '国税徴収法', id: '334AC0000000147' },
  'kihon/sisan': { name: '相続税法', id: '325AC0000000073' },
  'kihon/tsusoku': { name: '国税通則法', id: '337AC0000000066' },
  'kihon/shotoku': { name: '所得税法', id: '340AC0000000033' },
  'kobetsu/shotoku': { name: '所得税法', id: '340AC0000000033' },
};

function latestStamp() {
  const f = fs.readdirSync(STATE).filter((x) => /^tsutatsu_items_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}
const artStr = (c) => `${c.article}${c.branch ? 'の' + c.branch : ''}`;

// 漢数字の条タイトル（第百三十七条 / 第三十七条の十四）→ "137" / "37の14"
const KD = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanji2num(s) {
  if (!s) return null;
  let n = 0, cur = 0;
  for (const ch of s) {
    if (ch === '千') { n += (cur || 1) * 1000; cur = 0; }
    else if (ch === '百') { n += (cur || 1) * 100; cur = 0; }
    else if (ch === '十') { n += (cur || 1) * 10; cur = 0; }
    else if (ch in KD) cur = KD[ch];
    else return null;
  }
  return n + cur;
}
function artTitle2key(title) {
  const m = (title || '').match(/^第([〇一二三四五六七八九十百千]+)条(?:の([〇一二三四五六七八九十百千]+))?/);
  if (!m) return null;
  const a = kanji2num(m[1]);
  if (!a) return null;
  const b = m[2] ? kanji2num(m[2]) : null;
  return `${a}${b ? 'の' + b : ''}`;
}

// 通達番号プレフィックス→条候補（"37の14-15"→37の14 / "35-21"→35）。"9-2-31"(章-節型)は除外
function prefixCandidate(no) {
  const m = String(no || '').match(/^(\d+(?:の\d+)?)-\d+(?:の\d+)?$/);
  return m ? m[1] : null;
}

function parseArgs() {
  const a = process.argv.slice(2);
  return { n: +(a[a.indexOf('--n') + 1] || 40), dry: a.includes('--dry') };
}

async function callChat(system, user) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${WORKER}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify({ system, messages: [{ role: 'user', content: user }] }),
    });
    if (res.status === 429 || res.status >= 500) { // レートリミット・一時エラーはリトライ（誤答計上しない）
      if (i >= 5) throw new Error(`HTTP ${res.status}: リトライ上限`);
      await new Promise((r) => setTimeout(r, 15000 * (i + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const j = await res.json();
    return { text: j.content?.[0]?.text || '', jpy: j._cost?.jpy || 0 };
  }
}

// 法令側ベクトル検索 → ベース法令内の条候補（条番号・条見出し・順位を返す）
async function vectorCandidates(lawId, queryText, limit = 20) {
  try {
    const res = await fetch(`${WORKER}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify({ queries: [queryText.slice(0, 240)], originalQuery: queryText.slice(0, 240), topN: 50 }),
    });
    if (!res.ok) return [];
    const j = await res.json();
    const out = [];
    for (const r of j.results || []) {
      if (r.law?.law_id !== lawId) continue;
      const key = artTitle2key(r.article?.title);
      if (key && !out.some((o) => o.key === key)) out.push({ key, cap: r.article?.caption || '', rank: out.length + 1 });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

function buildPrompt(lawName, target, mates, candidates, capByKey) {
  const mateLines = mates.map((m) => {
    const cites = (m.citations || []).filter((c) => c.kind === '法').map(artStr);
    return `  ${m.tsutatsu_no}「${m.caption || '（見出しなし）'}」${cites.length ? ` …本文は第${cites.join('条・第')}条を引用` : ''}`;
  }).join('\n');
  const ownCites = (target.citations || []).filter((c) => c.kind === '法').map(artStr);
  const candLines = candidates.map((c) => `  第${c}条${capByKey[c] ? ` ${capByKey[c]}` : ''}`).join('\n');
  return `【ベース法令】${lawName}

【判定対象の通達】
番号: ${target.tsutatsu_no}
見出し: ${target.caption || '（なし）'}
本文: ${(target.body || '').slice(0, 700)}
${ownCites.length ? `本文中の${lawName}への引用: 第${ownCites.join('条・第')}条` : `本文中に${lawName}の条引用なし`}

【同じページに並んでいる通達（参考情報）】
${mateLines || '  （なし）'}

【候補となる条（この中からのみ選ぶ）】
${candLines}

【タスク】
判定対象の通達が「${lawName}のどの条を解釈・補足するために定められたものか」（帰属する条）を候補から1つ選んでください。
- 本文が他の条に言及していても、それは関連参照かもしれません。「この通達の本来の持ち場はどの条か」で判断。
- 通達番号の体系（例: 37の14-15 は第37条の14に属する連番）もヒントになります。
- 候補に該当が無い、または確信が持てない場合は、推測で選ばず必ず null。
回答は次のJSONのみ：
{"article": "条番号（例 8 や 70の4）または null", "reason": "30字以内"}`;
}

async function main() {
  const { n, dry } = parseArgs();
  const stamp = latestStamp();
  const lines = fs.readFileSync(path.join(STATE, `tsutatsu_items_${stamp}.ndjson`), 'utf8').split('\n').filter(Boolean);

  const pages = {};
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o.home || o.home.kind !== 'jou') continue;
    if (!LAWS[o.circular_path]) continue;
    (pages[o.source_path] = pages[o.source_path] || []).push(o);
  }

  const SOCHI = '332AC0000000026';
  const easy = [], hard = [];
  for (const items of Object.values(pages)) {
    if (items.length < 2) continue;
    for (const it of items) {
      const truth = it.home.jou;
      // 見出しが措置法を指すページは、正解法令＝措置法・正解引用も措置法kind（汚染回避）
      const truthLawId = it.home.law === 'sochi' ? SOCHI : LAWS[it.circular_path].id;
      const ownKind = it.home.law === 'sochi' ? '措置法' : '法';
      const own = (it.citations || []).filter((c) => c.kind === ownKind).map(artStr);
      const rec = { it, truth, truthLawId, mates: items.filter((x) => x !== it).slice(0, 8) };
      if (own.includes(truth)) easy.push(rec); else hard.push(rec);
    }
  }
  const shuf = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);

  // --recall: ベクトル上位20に正解が入ってる率だけ測る（LLM不使用・安い）。実運用に近いhard通達で。
  if (process.argv.includes('--recall')) {
    const rs = shuf(hard).slice(0, n);
    console.log(`リコール測定: ${rs.length}件（hard=本文が正解条を引用してない＝未割当に近い）`);
    let r20 = 0, full = 0, byNum = 0, bySib = 0, byVec = 0, tot = 0;
    for (let i = 0; i < rs.length; i += 8) {
      await Promise.all(rs.slice(i, i + 8).map(async ({ it, truth, truthLawId, mates }) => {
        tot++;
        const vec = await vectorCandidates(truthLawId, `${it.caption || ''} ${it.body || ''}`, 20);
        const vecHit = vec.some((v) => v.key === truth);
        if (vecHit) { r20++; byVec++; }
        // 構造シグナル
        const kind = it.home.law === 'sochi' ? '措置法' : '法';
        const sib = new Set();
        for (const m of mates) (m.citations || []).filter((c) => c.kind === kind).forEach((c) => sib.add(artStr(c)));
        const pfx = prefixCandidate(it.tsutatsu_no);
        if (pfx === truth) byNum++;
        if (sib.has(truth)) bySib++;
        const pool = new Set(vec.map((v) => v.key));
        sib.forEach((x) => pool.add(x));
        if (pfx) pool.add(pfx);
        (it.citations || []).filter((c) => c.kind === kind).forEach((c) => pool.add(artStr(c)));
        if (pool.has(truth)) full++;
      }));
      process.stdout.write(`\r  ${Math.min(i + 8, rs.length)}/${rs.length}`);
    }
    const p = (x) => `${x}/${tot} (${Math.round((x / tot) * 100)}%)`;
    console.log(`\n\n=== 候補リコール比較（正解既知hard・LLM不使用）===`);
    console.log(`ベクトルのみ:                 ${p(r20)}`);
    console.log(`全シグナル(番号∪仲間∪自引用∪ベクトル20): ${p(full)}  ← これがLLMの正解上限`);
    console.log(`--- 各シグナル単独の寄与 ---`);
    console.log(`  通達番号プレフィックスが正解: ${p(byNum)}`);
    console.log(`  仲間通達の引用に正解:         ${p(bySib)}`);
    console.log(`  ベクトル20に正解:             ${p(byVec)}`);
    return;
  }

  const nEasy = Math.floor(n / 2);
  const sample = [...shuf(easy).slice(0, nEasy), ...shuf(hard).slice(0, n - nEasy)];
  console.log(`ベンチ対象: ${sample.length}件 (easy=${nEasy} hard=${n - nEasy}) / 母集団 easy=${easy.length} hard=${hard.length}`);

  const system = 'あなたは日本の税法・税務通達の専門家。指示されたJSONのみを返す。';
  let ok = 0, ng = 0, nullAns = 0, poolMiss = 0, jpy = 0;
  const wrong = [];
  const strata = { easy: { ok: 0, all: 0 }, hard: { ok: 0, all: 0 } };

  for (let i = 0; i < sample.length; i += 5) {
    const batch = sample.slice(i, i + 5);
    await Promise.all(batch.map(async (rec, bi) => {
      const idx = i + bi;
      const isEasy = idx < nEasy;
      const { it, truth, mates } = rec;
      const law = LAWS[it.circular_path];

      // 候補プール: 自引用 ∪ 仲間引用 ∪ 番号プレフィックス ∪ ベクトル上位
      const pool = new Set();
      const capByKey = {};
      for (const m of [it, ...mates]) (m.citations || []).filter((c) => c.kind === '法').forEach((c) => pool.add(artStr(c)));
      const pfx = prefixCandidate(it.tsutatsu_no);
      if (pfx) pool.add(pfx);
      const vec = await vectorCandidates(law.id, `${it.caption || ''} ${it.body || ''}`);
      vec.forEach((v) => { pool.add(v.key); capByKey[v.key] = v.cap; });
      const candidates = [...pool].sort((a, b) => (parseInt(a) - parseInt(b)) || a.localeCompare(b));
      if (!candidates.includes(truth)) poolMiss++;

      const user = buildPrompt(law.name, it, mates, candidates, capByKey);
      if (dry && idx === 0) { console.log('--- PROMPT例 ---\n' + user.slice(0, 1800)); return; }
      if (dry) return;
      try {
        const r = await callChat(system, user);
        jpy += r.jpy;
        const m = r.text.match(/\{[\s\S]*\}/);
        const ans = m ? (JSON.parse(m[0]).article ?? null) : null;
        // 表記正規化: 「第35の3条」「35の3条」「第35条の3」→ "35の3"（比較キーと同形）
        const normAns = (a) => {
          if (a === null || a === undefined) return null;
          let t = String(a).replace(/[\s　]/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
          const km = t.match(/[〇一二三四五六七八九十百千]/) ? artTitle2key(t.startsWith('第') ? t : '第' + t) : null;
          if (km) return km;
          t = t.replace(/^第/, '').replace(/条(の)?/g, (mm, g1) => (g1 ? 'の' : ''));
          return /^\d+(の\d+)*$/.test(t) ? t : String(a);
        };
        const strat = isEasy ? strata.easy : strata.hard;
        strat.all++;
        if (ans !== null && normAns(ans) === truth) { ok++; strat.ok++; }
        else if (ans === null) { nullAns++; wrong.push({ no: it.tsutatsu_no, law: it.circular_path, truth, ans: 'null', inPool: candidates.includes(truth) }); }
        else { ng++; wrong.push({ no: it.tsutatsu_no, law: it.circular_path, truth, ans: String(ans), inPool: candidates.includes(truth) }); }
      } catch (e) { ng++; wrong.push({ no: it.tsutatsu_no, law: it.circular_path, truth, ans: 'ERR:' + e.message.slice(0, 40), inPool: true }); }
    }));
    if (!dry) process.stdout.write(`\r  進捗 ${Math.min(i + 5, sample.length)}/${sample.length}  正解${ok}`);
  }
  if (dry) return;
  const total = ok + ng + nullAns;
  console.log(`\n\n=== 結果 ===`);
  console.log(`正解: ${ok}/${total} (${Math.round((ok / total) * 100)}%)  誤答: ${ng}  null回答: ${nullAns}`);
  console.log(`  easy(本文が正解条を引用): ${strata.easy.ok}/${strata.easy.all}`);
  console.log(`  hard(引用が正解とズレ/なし): ${strata.hard.ok}/${strata.hard.all} ← 実際の未割当4,000件に近い条件`);
  console.log(`候補プールに正解が無かった: ${poolMiss}件`);
  console.log(`APIコスト: ≒${jpy.toFixed(1)}円`);
  if (wrong.length) {
    console.log(`\n--- 外した例（最大12件）---`);
    wrong.slice(0, 12).forEach((w) => console.log(`  ${w.law} ${w.no}: 正解=第${w.truth}条 回答=${w.ans} (プールに正解${w.inPool ? 'あり' : 'なし'})`));
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
