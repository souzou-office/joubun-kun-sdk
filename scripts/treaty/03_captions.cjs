// 03: 見出しのない条約条文に、本文からLLM（Haiku）で短い見出しを合成する。
// 別表の見出し合成と同方式。既に見出しがある条（MLI統合条文の一部等）はそのまま使う。
// 出力: state/treaty_articles_capped.json
//
//   node scripts/treaty/03_captions.cjs --dry   # 対象数と概算のみ
//   node scripts/treaty/03_captions.cjs

const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');
const STATE = path.join(__dirname, 'state');
const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;   // 秘密はリポジトリに書かない（環境変数だけ）
if (!KEY && !process.argv.includes('--dry')) { console.error('BYPASS_KEY を環境変数で渡してください'); process.exit(1); }
const BATCH = 20;

async function callChat(system, user, maxTokens) {
  const res = await fetch(`${WORKER}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ system, model: 'claude-haiku-4-5', maxTokens, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  return { text: j.content?.[0]?.text || '', jpy: j._cost?.jpy || 0 };
}

const SYSTEM = `租税条約・租税協定の条文に、日本の法令のような簡潔な条見出し（2〜12文字）を付ける作業です。
本文冒頭から内容を判定し、見出しだけを返してください。
- 一般的な用語を使う（例: 配当、利子、使用料、事業利得、恒久的施設、居住者、一般的定義、相互協議手続、情報の交換、無差別待遇、二重課税の除去、発効、終了）
- 本文が「削除」やごく短い場合は「（削除）」
- 出力は JSON 配列のみ: ["見出し1", "見出し2", ...]（入力と同数・同順）`;

(async () => {
  const dry = process.argv.includes('--dry');
  // 常に最新のパース結果を土台にし、前回の合成見出し（capped）を国×条番号でマージ。
  // （02を再実行して本文構造が変わっても、見出しの再課金をしない）
  const cappedPath = path.join(STATE, 'treaty_articles_capped.json');
  const data = JSON.parse(fs.readFileSync(path.join(STATE, 'treaty_articles.json'), 'utf8'));
  if (fs.existsSync(cappedPath)) {
    const prev = JSON.parse(fs.readFileSync(cappedPath, 'utf8'));
    const prevCap = new Map();
    for (const t of prev) for (const a of t.articles) if (a.cap) prevCap.set(`${t.country}#${a.no}`, a.cap);
    let merged = 0;
    for (const t of data) for (const a of t.articles) {
      if (!a.cap && a.no > 0 && prevCap.has(`${t.country}#${a.no}`)) { a.cap = prevCap.get(`${t.country}#${a.no}`); merged++; }
    }
    console.log(`前回の見出しをマージ: ${merged}条`);
  }

  const jobs = []; // {country, idx}
  for (const t of data) {
    t.articles.forEach((a, idx) => {
      if (a.no === 0) return;                    // 議定書等は固定見出し
      if (a.cap) return;                         // 既存見出し
      if ((a.body || '').replace(/\s/g, '').length < 10) { a.cap = '（削除）'; return; }
      jobs.push({ t, idx });
    });
  }
  console.log(`見出し合成対象: ${jobs.length}条（全${data.reduce((s, t) => s + t.articles.length, 0)}条中）`);
  if (dry) return;

  let jpy = 0, done = 0, fail = 0;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    const user = batch.map((j, k) => {
      const a = j.t.articles[j.idx];
      return `${k + 1}. 【${j.t.country} 第${a.no}条】${(a.body || '').slice(0, 260)}`;
    }).join('\n\n');
    try {
      const r = await callChat(SYSTEM, user + '\n\nJSON配列のみを出力:', 600);
      jpy += r.jpy;
      const m = r.text.match(/\[[\s\S]*\]/);
      const caps = JSON.parse(m ? m[0] : r.text);
      if (!Array.isArray(caps) || caps.length !== batch.length) throw new Error(`個数不一致 ${caps.length}/${batch.length}`);
      batch.forEach((j, k) => { j.t.articles[j.idx].cap = String(caps[k]).slice(0, 20); });
      done += batch.length;
    } catch (e) {
      // バッチで個数不一致等が出たら1条ずつフォールバック（LLMが結合/スキップした条を特定できないため）
      console.log(`\n NG batch@${i}: ${e.message} → 1条ずつ再試行`);
      for (const j of batch) {
        const a = j.t.articles[j.idx];
        try {
          const r1 = await callChat(SYSTEM, `1. 【${j.t.country} 第${a.no}条】${(a.body || '').slice(0, 260)}\n\nJSON配列のみを出力:`, 60);
          jpy += r1.jpy;
          const m1 = r1.text.match(/\[[\s\S]*\]/);
          const c1 = JSON.parse(m1 ? m1[0] : r1.text);
          a.cap = String(c1[0] || '').slice(0, 20);
          if (a.cap) done++; else fail++;
        } catch (e1) { fail++; }
      }
    }
    process.stdout.write(`\r  ${Math.min(i + BATCH, jobs.length)}/${jobs.length}  成功${done} 失敗${fail} 約${jpy.toFixed(1)}円`);
  }
  console.log();
  fs.writeFileSync(path.join(STATE, 'treaty_articles_capped.json'), JSON.stringify(data), 'utf8');
  console.log(`書き出し完了 (${jpy.toFixed(1)}円)`);
})();
