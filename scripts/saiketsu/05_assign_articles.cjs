// 05: 条文が1本も付かなかった裁決に、閉じた候補集合から条をLLMで割り当てる。
//     通達でやった scripts/tsutatsu/13_assign.cjs と同じ考え方（候補はコードで作り、
//     LLMは「その中から選ぶ or null」だけ。条番号の創作をさせない）。
//
//   候補プール = ①同じ論点の紐付け済み裁決が引いている条（最強シグナル）
//              ∪ ②要旨をベクトル検索して出た当該法令の条
//              ∪ ③その法の「持ち場」（益金損金22条 等・13_assign.cjs から流用）
//   いずれも tax_laws（裁決自身の法令レベル帰属）の法令に限定する。
//
//   node scripts/saiketsu/05_assign_articles.cjs --links F --control 60   # 対照実験のみ
//   node scripts/saiketsu/05_assign_articles.cjs --links F --out F2       # 本番割当
const fs = require('fs');
const path = require('path');
const { loadLawIds } = require('../shitsugi/03_parse.cjs');
const SITE = require('../site_config.cjs');

const WORKER = process.env.WORKER_URL || SITE.workerUrls.bench;
const KEY = process.env.BYPASS_KEY;   // 平文の既定値は置かない（鍵は取り替え済み。環境変数で渡す）
if (!KEY) { console.error('環境変数 BYPASS_KEY を設定してください'); process.exit(1); }
// --opus: 最後に残った少数の難物だけ上位モデルで詰める（13_assign.cjs の二段構えと同じ発想）
const MODEL = process.argv.includes('--opus') ? 'claude-opus-4-8' : 'claude-sonnet-4-5';

// 各法の「一般的な持ち場」。13_assign.cjs の ANCHORS をそのまま使う（同じ役割）
const ANCHORS = {
  '340AC0000000034': ['22', '22の2', '42', '61の8', '2', '25', '33', '34', '37', '55', '31', '50', '52'],
  '340AC0000000033': ['36', '37', '45', '51', '57', '2', '9', '28', '35', '34', '40', '27', '33', '64'],
  '325AC0000000073': ['22', '11の2', '1の3', '1の4', '19', '21の11', '21の15', '66', '64', '9'],
  '363AC0000000108': ['2', '4', '6', '28', '30', '37', '9', '14', '60'],
  // 通則法は加算税だけでなく調査手続も裁決の主要論点。質問検査権(74の2〜)と
  // 犯則調査(131〜。旧国税犯則取締法が2018年に移された章)を持ち場に加える。
  '337AC0000000066': ['65', '66', '68', '15', '23', '70', '75', '24', '26',
    '74の2', '74の9', '74の11', '131', '132', '135', '116', '117'],
  '334AC0000000147': ['39', '47', '62', '75', '76', '151', '153'],
  '332AC0000000026': ['31', '33', '35', '37', '36の2', '65の7', '66の6', '69の4', '70の7',
    '37の10', '37の11', '37の13', '41', '41の14', '31の2', '34の2', '35の2', '39'],
  // 【2026-09-02 追加】印紙税・酒税・登録免許税に持ち場が無く、残り20件がこの3分野に
  //   偏っていた。候補に法の一般条が入らないと、LLMは選びようがない。
  //   印紙税法・地価税法・電子帳簿保存法は 13_assign.cjs の値をそのまま使う。
  '342AC0000000023': ['2', '3', '4', '5', '7', '8', '9', '10', '11', '12'],   // 印紙税法
  '328AC0000000006': ['2', '3', '6', '7', '9', '10', '22', '28', '43'],       // 酒税法
  '342AC0000000035': ['2', '9', '10', '17', '31'],                            // 登録免許税法
  '403AC0000000069': ['2', '5', '6', '7', '17'],                              // 地価税法
  '410AC0000000025': ['4', '5', '7', '8'],                                    // 電子帳簿保存法
};

const KD = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanji2num(s) {
  if (!s) return null; let n = 0, cur = 0;
  for (const ch of s) {
    if (ch === '千') { n += (cur || 1) * 1000; cur = 0; }
    else if (ch === '百') { n += (cur || 1) * 100; cur = 0; }
    else if (ch === '十') { n += (cur || 1) * 10; cur = 0; }
    else if (ch in KD) cur = KD[ch]; else return null;
  }
  return n + cur;
}
function artTitle2key(title) {
  const m = (title || '').match(/^第([〇一二三四五六七八九十百千]+)条(?:の([〇一二三四五六七八九十百千]+))?/);
  if (!m) return null;
  const a = kanji2num(m[1]); if (!a) return null;
  return `${a}${m[2] ? 'の' + kanji2num(m[2]) : ''}`;
}
const Z2H = (s) => String(s).replace(/[０-９]/g, (d) => '０１２３４５６７８９'.indexOf(d));
function normArt(s) {
  if (s == null) return null;
  const t = Z2H(s).replace(/[第\s]/g, '').replace(/条/g, '').trim();
  return /^\d+(の\d+)?$/.test(t) ? t : null;
}

async function callChat(system, user, maxTokens) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${WORKER}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ system, model: MODEL, maxTokens, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const u = j.usage || {};
      return { text: j.content?.[0]?.text || '', inTok: u.input_tokens || 0, outTok: u.output_tokens || 0 };
    } catch (e) {
      if (attempt === 2) return { text: '', inTok: 0, outTok: 0, err: String(e) };
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function vectorArticles(queryText, lawIds, limit) {
  try {
    const res = await fetch(`${WORKER}/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify({ queries: [queryText.slice(0, 240)], originalQuery: queryText.slice(0, 240), topN: 50 }),
    });
    if (!res.ok) return [];
    const j = await res.json(); const out = [];
    for (const r of j.results || []) {
      const lid = r.law?.law_id;
      if (lawIds && !lawIds.has(lid)) continue;
      const key = artTitle2key(r.article?.title);
      if (!key) continue;
      const k = `${lid}:${key}`;
      if (!out.some((o) => o.k === k)) out.push({ k, cap: r.article?.caption || '', law: r.law?.law_title || '' });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

// LLMは候補の id をそのまま返さないことがある（「印紙税法施行令第26条:26」のように
// law_id の代わりに法令名を書く）。厳密一致だけで弾くと、候補に入っている正しい答えを
// 書式違いで捨てることになる（実際に印紙税6件がこれで落ちていた）。
// 末尾の条番号が一致し、かつ法令名が前半に含まれる候補が一意なら、その候補に解決する。
function resolveKey(raw, cand, lawNameById) {
  if (cand.includes(raw)) return raw;
  const i = raw.lastIndexOf(':');
  if (i < 0) return null;
  const art = raw.slice(i + 1).replace(/[第条\s]/g, '');
  const head = raw.slice(0, i);
  const hits = cand.filter((c) => {
    const [lid, a] = c.split(':');
    if (a !== art) return false;
    const nm = lawNameById[lid];
    return !!nm && (head.includes(nm) || head === lid);
  });
  return hits.length === 1 ? hits[0] : null;
}

const parseJsonLoose = (t) => { const m = t.match(/\[[\s\S]*\]|\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };

// 論点 → その論点の紐付け済み裁決が引いている条 のヒストグラム
function buildTopicIndex(links, meta) {
  const idx = new Map();
  for (const [id, refs] of Object.entries(links)) {
    for (const t of ((meta[id] || {}).topics || [])) {
      if (!idx.has(t)) idx.set(t, new Map());
      const m = idx.get(t);
      for (const r of refs) {
        const k = `${r.law_id}:${r.article}`;
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
  }
  return idx;
}

// tax_laws は法律しか持たない。対照実験で外した8件中5件は正解が施行令で、
// 候補に一度も入っていなかった（LLMの限界ではなく候補プールの穴）。
// 各税法の施行令・施行規則を law_id で引けるようにして候補に含める。
function expandLawIds(taxLaws, ALL, lawNameById) {
  const ids = new Set();
  for (const x of (taxLaws || [])) {
    if (!x.law_id) continue;
    ids.add(x.law_id);
    const base = x.law || lawNameById[x.law_id];
    if (!base) continue;
    for (const suffix of ['施行令', '施行規則']) {
      const id = ALL[base + suffix];
      if (id) ids.add(id);
    }
  }
  return ids;
}

async function buildPool(it, topicIdx, capByKey, ALL, lawNameById) {
  const lawIds = expandLawIds(it.tax_laws, ALL, lawNameById);
  const pool = new Map(); // key -> score
  for (const t of (it.topics || [])) {
    const m = topicIdx.get(t);
    if (!m) continue;
    // 論点の粒度がコーパスで違う。裁決の topics は細かい争点だが、事例の topics は
    // 「所得税」のような分野名で、そのまま重み3を掛けると「その分野で最も多く引かれる条」
    // が候補を埋め尽くし、ベクトルが拾った本命（措置法41条 等）を押し出す。
    // 散らばりが大きい論点は情報が薄いので、重みを下げて上位だけ採る。
    const broad = m.size > 40;
    const w = broad ? 1 : 3;
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, broad ? 15 : m.size);
    for (const [k, v] of entries) if (lawIds.has(k.split(':')[0])) pool.set(k, (pool.get(k) || 0) + v * w);
  }
  for (const lid of lawIds) for (const a of (ANCHORS[lid] || [])) {
    const k = `${lid}:${a}`;
    if (!pool.has(k)) pool.set(k, 1);
  }
  const q = `${it.title} ${it.abstract || ''}`;
  const vec = await vectorArticles(q, lawIds, 15);
  for (const v of vec) { pool.set(v.k, (pool.get(v.k) || 0) + 2); if (v.cap) capByKey[v.k] = v.cap; }
  // 争点が他法域に飛ぶ裁決がある（保険金の課税→相続税法3条、出資の払戻し→医療法50条）。
  // 法令を絞らないベクトル上位も少しだけ候補に入れる（重みは低く）。
  const free = await vectorArticles(q, null, 8);
  for (const v of free) { pool.set(v.k, (pool.get(v.k) || 0) + 1); if (v.cap) capByKey[v.k] = v.cap; }
  // 他法域の候補は重みが低いので、枠の奪い合いで真っ先に落ちる。実際に
  // 「都市緑地法運用指針→都市緑地法55条」など正しい答えが枠外に出て捨てられた。
  // 法令非限定のベクトル上位は枠に関係なく必ず残す。
  const protectedKeys = free.map((v) => v.k);
  const ranked = [...pool.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const top = ranked.slice(0, 60);
  for (const k of protectedKeys) if (!top.includes(k)) top.push(k);
  return top;
}

function buildPrompt(batch, lawName, capByKey, lawNameById) {
  const allCand = [...new Set(batch.flatMap((b) => b.cand))];
  const candLines = allCand.map((k) => {
    const [lid, a] = k.split(':');
    return `  ${lawNameById[lid] || lid}第${a}条${capByKey[k] ? `（${capByKey[k]}）` : ''}  [id=${k}]`;
  }).join('\n');
  const tLines = batch.map((b, i) => `[${i + 1}] 論点「${(b.it.topics || []).join('・') || 'なし'}」
    表題: ${b.it.title}
    要旨: ${(b.it.abstract || '').slice(0, 420)}`).join('\n');
  return `【国税不服審判所の裁決を、それぞれ「争点の根拠となった条文」に割り当てよ】

${tLines}

【候補となる条（この中からのみ選ぶ。id をそのまま返すこと）】
${candLines || '  （なし）'}

【ルール】
- その裁決が「どの条の解釈・適用を争ったのか」を候補から選ぶ。最大2つまで。
- 表題と要旨に書かれた争点そのものを見る。手続や加算税の話が主争点でなければ選ばない。
- 候補に本当に当てはまるものが無いときだけ articles を空配列にする。**候補外の条を作らない。**
- conf は high / low のどちらか。迷ったら low。
- articles には候補行の **[id=...] の中身だけ**を書く（例 "342AC0000000023:2"）。
  法令名・条見出し・説明を付けない。付けると解釈できず捨てられる。
次のJSON配列のみ（入力した全件分を、n は上の番号で出力）：
[{"n":1,"articles":["340AC0000000034:22"],"conf":"high"}, ...]`;
}

// 最終パス用。ここまで残っているのは「原文に条番号が一度も出てこない」ものだけなので、
// 明記された引用が見つかることは期待できない。候補の中で最も近い条を必ず選ばせる。
// 精度は落ちるので出所は llm・確信度も添えて、原文の引用より必ず下に並ぶようにする。
function finalPrompt(batch, capByKey, lawNameById) {
  const p = buildPrompt(batch, '', capByKey, lawNameById);
  return p.replace(
    '- 候補に本当に当てはまるものが無いときだけ articles を空配列にする。**候補外の条を作らない。**',
    `- これらは原文に条番号が一度も書かれていないものばかりで、明記された引用は存在しない。
  それでも「その事案がどの条の適用・解釈の問題か」は決まるので、候補から最も近い条を必ず1つ選ぶ。
  条番号が書かれていないことを理由に空配列にしない。**ただし候補外の条は作らない。**
- 争点が条文に落ちない性質のもの（信義誠実の原則、調査手続の適法性、免許事務の運用など）に
  限り articles を空配列にしてよい。その場合だけ理由が説明できるはずである。`);
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
  return { links: get('--links'), out: get('--out'), control: get('--control') ? +get('--control') : 0, limit: get('--limit') ? +get('--limit') : Infinity };
}

const FINAL = process.argv.includes('--final');

async function main() {
  const { links: linksFile, out: outFile, control, limit } = parseArgs();
  const ALL = loadLawIds();
  const lawNameById = {};
  for (const [k, v] of Object.entries(ALL)) if (!lawNameById[v]) lawNameById[v] = k;
  const data = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(process.env.META_FILE, 'utf8'))
    .reduce((m, x) => { m[x.id] = x; return m; }, {});
  const topicIdx = buildTopicIndex(data.links, meta);

  // 対照実験: 「本文が無いのに条が付いている」裁決を選び、要旨から条番号を伏せて
  //   同じ手順にかける。正解（実際のリンク）と突き合わせて的中率を出す。
  let targets;
  if (control) {
    const pool = Object.keys(data.links).filter((id) => {
      const m = meta[id];
      return m && (!m.secText || m.secText.length < 50) && (m.topics || []).length && (m.tax_laws || []).length;
    });
    const rng = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const r = rng(42);
    const picked = pool.sort().sort(() => r() - 0.5).slice(0, control);
    targets = picked.map((id) => {
      const m = meta[id];
      const mask = (s) => String(s || '').replace(/(?:同法|[^\s、。]{2,20}?(?:法律|省令|政令|規則|規程|法|令))?第\d+(?:の\d+)*条(?:の\d+)*/g, '〔条文〕');
      return { it: { id, title: mask(m.title), abstract: mask(m.abstract), topics: m.topics, tax_laws: m.tax_laws }, gold: data.links[id].map((r2) => `${r2.law_id}:${r2.article}`) };
    });
    console.log(`対照 ${targets.length}件（本文なし・条が付いている裁決。要旨の条番号は伏せた）`);
  } else {
    targets = data.unlinked.slice(0, limit).map((it) => ({ it, gold: null }));
    console.log(`割当対象 ${targets.length}件`);
  }

  const capByKey = {};
  for (let i = 0; i < targets.length; i += 6) {
    await Promise.all(targets.slice(i, i + 6).map(async (t) => { t.cand = await buildPool(t.it, topicIdx, capByKey, ALL, lawNameById); }));
  }
  if (control) {
    // 候補プールの天井。正解が候補に無ければLLMがどれだけ賢くても当たらない。
    const withGold = targets.filter((t) => t.gold.some((g) => t.cand.includes(g))).length;
    console.log(`  候補に正解が入っている ${withGold}/${targets.length} (${(100 * withGold / targets.length).toFixed(1)}%) ← 的中率の天井`);
  }
  const noCand = targets.filter((t) => !t.cand.length);
  console.log(`  候補が作れた ${targets.length - noCand.length}件 / 作れなかった ${noCand.length}件`);

  // 候補プールが近いもの同士でまとめる（法令＋先頭論点）
  const groups = new Map();
  for (const t of targets.filter((x) => x.cand.length)) {
    const g = `${(t.it.tax_laws || []).map((x) => x.law_id).join(',')}|${(t.it.topics || [])[0] || ''}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const batches = [];
  for (const arr of groups.values()) for (let i = 0; i < arr.length; i += 6) batches.push(arr.slice(i, i + 6));
  console.log(`  ${batches.length}バッチ`);

  let inTok = 0, outTok = 0, done = 0;
  const failures = [];
  const droppedLog = [];
  const results = {};
  for (let i = 0; i < batches.length; i += 4) {
    await Promise.all(batches.slice(i, i + 4).map(async (b) => {
      const p = FINAL ? finalPrompt(b, capByKey, lawNameById) : buildPrompt(b, '', capByKey, lawNameById);
      const r = await callChat('あなたは日本の税法の専門家。指示されたJSONのみを返す。', p, FINAL ? 1500 : 700);
      inTok += r.inTok; outTok += r.outTok;
      let arr = parseJsonLoose(r.text);
      // 1件だけのバッチだと配列でなく単一オブジェクトで返ることがある
      if (arr && !Array.isArray(arr) && typeof arr === 'object' && arr.articles) arr = [arr];
      if (!Array.isArray(arr)) {
        // 黙って捨てると「割り当てられなかった」と「呼び出しが失敗した」の区別がつかない。
        failures.push({ n: b.length, err: r.err || null, head: String(r.text || '').slice(0, 120) });
        return;
      }
      for (const a of arr) {
        const t = b[(a.n | 0) - 1];
        if (!t) continue;
        const valid = (a.articles || []).map((k) => resolveKey(String(k), t.cand, lawNameById)).filter(Boolean);
        const rejected = (a.articles || []).filter((k) => !resolveKey(String(k), t.cand, lawNameById));
        if (rejected.length) droppedLog.push({ id: t.it.id, rejected, poolHead: t.cand.slice(0, 6) });
        results[t.it.id] = { articles: valid, conf: a.conf || 'low', dropped: rejected.length };
      }
    }));
    done += Math.min(4, batches.length - i);
    process.stderr.write(`\r  ${done}/${batches.length}バッチ`);
  }
  const rate = process.argv.includes('--opus') ? [5, 25] : [3, 15];
  const jpy = (inTok / 1e6 * rate[0] + outTok / 1e6 * rate[1]) * 155;
  console.error('');
  console.log(`  トークン in ${inTok} / out ${outTok}  ≒ ¥${jpy.toFixed(0)}`);

  if (failures.length) {
    console.log(`  ⚠️ 応答が取れなかったバッチ ${failures.length}件（対象 ${failures.reduce((s2, f) => s2 + f.n, 0)}件）`);
    failures.slice(0, 3).forEach((f) => console.log(`     err=${f.err} head=${JSON.stringify(f.head)}`));
  }
  if (droppedLog.length && process.argv.includes('--why')) {
    console.log('  候補外として弾いた回答:');
    droppedLog.slice(0, 10).forEach((d2) => console.log(`     ${d2.id}  LLM=${d2.rejected.join(',')}  候補先頭=${d2.poolHead.join(',')}`));
  }
  const answered = Object.values(results).filter((r) => r.articles.length).length;
  const droppedTotal = Object.values(results).reduce((s, r) => s + r.dropped, 0);
  console.log(`  条を選べた ${answered}件 / null ${Object.keys(results).length - answered}件 / 候補外を弾いた ${droppedTotal}本`);

  if (control) {
    let hit = 0, hitTop = 0, n = 0, hi = 0, hiHit = 0;
    for (const t of targets) {
      const r = results[t.it.id];
      if (!r || !r.articles.length) continue;
      n++;
      const gold = new Set(t.gold);
      const ok = r.articles.some((a) => gold.has(a));
      if (ok) hit++;
      if (gold.has(r.articles[0])) hitTop++;
      if (r.conf === 'high') { hi++; if (ok) hiHit++; }
    }
    console.log(`\n=== 対照実験の結果 ===`);
    console.log(`  回答した ${n}件 / ${targets.length}件`);
    console.log(`  正解の条を1本でも当てた   ${hit}/${n} (${(100 * hit / n).toFixed(1)}%)`);
    console.log(`  第1候補が正解            ${hitTop}/${n} (${(100 * hitTop / n).toFixed(1)}%)`);
    console.log(`  conf=high に限ると        ${hiHit}/${hi} (${hi ? (100 * hiHit / hi).toFixed(1) : '-'}%)`);
    const miss = targets.filter((t) => results[t.it.id]?.articles.length && !results[t.it.id].articles.some((a) => new Set(t.gold).has(a))).slice(0, 8);
    console.log(`\n  外した例:`);
    for (const m of miss) {
      const nm = (k) => `${lawNameById[k.split(':')[0]] || ''}${k.split(':')[1]}条`;
      console.log(`   ${m.it.id} ${m.it.title.slice(0, 45)}`);
      console.log(`      LLM: ${results[m.it.id].articles.map(nm).join('・')}   正解: ${m.gold.map(nm).join('・')}`);
    }
  }
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), results }, null, 1)); console.log(`→ ${outFile}`); }
}

if (require.main === module) main();
