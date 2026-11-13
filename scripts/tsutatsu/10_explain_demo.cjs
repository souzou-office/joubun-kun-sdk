// 10_explain_demo.cjs — 通達を織り込んだ「説明文」をローカル生成し、アプリ用JSONに出力（本番ノータッチ）。
// 検索(Vectorize)は使わず条文を直接指定 → その条文の通達をローカルデータから読み込み →
// Claude(claude-sonnet-4-6)で説明文生成 → public/explain_demo.json に書き出し（?tsdemo でアプリが読む）。
//
// 実行: node scripts/tsutatsu/10_explain_demo.cjs

const fs = require('fs');
const path = require('path');
const STATE_DIR = path.join(__dirname, 'state');
const REPO_ROOT = path.join(__dirname, '..', '..');

function readDevVar(name) {
  const txt = fs.readFileSync(path.join(REPO_ROOT, '.dev.vars'), 'utf8');
  const line = txt.split('\n').find(l => l.replace(/^\s+/, '').startsWith(name + '='));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : null;
}
function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter(x => /^article_tsutatsu_links_\d{8}\.json$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}
function han(s) { return (s || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); }

const LAW_NAMES = {
  '340AC0000000034': '法人税法', '363AC0000000108': '消費税法', '332AC0000000026': '租税特別措置法',
  '340AC0000000033': '所得税法', '325AC0000000073': '相続税法', '334AC0000000147': '国税徴収法',
};
const CLAUDE_API_KEY = readDevVar('CLAUDE_API_KEY');

async function explain(query, lawTitle, articleTitle, refs, bodyMap) {
  const cands = refs.slice(0, 50).map(r => ({
    no: r.no || r.title || '', cap: r.cap || '', url: r.url, src: r.src, grp: r.grp,
    body: (r.src === 'html' ? (bodyMap[`${r.grp}|${r.no}`] || '') : ''),
  }));
  const candText = cands.map((c, i) => `${i + 1}. ${c.no}（${c.cap}）\n   ${(c.body || '').slice(0, 350) || '（本文略）'}`).join('\n');
  const sys = 'あなたは税理士向けの法令解説AI「条文くん」。利用者の質問に対し、指定条文を、関連する税務通達を踏まえて簡潔に解説する。\n'
    + '重要ルール：\n'
    + '・通達は羅列しない。質問に効く通達だけ（1〜3本）を地の文に自然に織り込み、その通達が具体的に何を定めているかを示す。\n'
    + '・候補のうち質問と無関係な通達は完全に無視する。\n'
    + '・マークダウンの見出し（#）や表は使わず、2〜4段落の地の文で書く。\n'
    + '・最後に、本文で引用した通達のみ改行して「📎 通達番号（見出し）」形式で列挙する。\n'
    + '・専門家向けに簡潔・正確に。条文番号・通達番号は正確に。';
  const user = `【質問】${query}\n\n【条文】${lawTitle} ${articleTitle}\n\n【この条文に紐づく税務通達の候補（番号・見出し・本文抜粋）】\n${candText}\n\n上記の候補から、質問に効く通達だけを使って解説してください。`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 900, system: sys, messages: [{ role: 'user', content: user }] }),
  });
  const j = await res.json();
  if (!res.ok) return { answer: 'API ERROR: ' + JSON.stringify(j).slice(0, 300), referenced: [] };
  const answer = (j.content || []).map(c => c.text).join('') || '(空応答)';
  // 📎 行から引用通達を抽出 → リンク付きで referenced に
  const referenced = [];
  for (const line of answer.split('\n')) {
    const m = line.match(/📎\s*([0-9０-９\-の]+)/);
    if (!m) continue;
    const no = han(m[1]);
    const c = cands.find(x => x.no === no);
    if (c && !referenced.find(x => x.no === c.no)) referenced.push({ src: c.src, no: c.no, cap: c.cap, url: c.url, grp: c.grp, body: c.body });
  }
  return { answer, referenced };
}

async function main() {
  if (!CLAUDE_API_KEY) { console.error('CLAUDE_API_KEY が .dev.vars にありません'); process.exit(1); }
  const stamp = latestStamp();
  const bodyMap = {};
  for (const line of fs.readFileSync(path.join(STATE_DIR, `tsutatsu_items_${stamp}.ndjson`), 'utf8').split('\n').filter(Boolean)) {
    try { const it = JSON.parse(line); bodyMap[`${it.circular_path}|${it.tsutatsu_no}`] = it.body; } catch {}
  }
  const chunks = {};
  const load = (lid) => (chunks[lid] || (chunks[lid] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tsutatsu_chunks_v1', `${lid}.json`), 'utf8'))));

  const demos = [
    { q: '役員給与を、業績が悪いので期の途中で下げたい。損金になる？', law: '340AC0000000034', key: '34', title: '第三十四条', caption: '役員給与の損金不算入' },
    { q: '定期同額給与って、毎月キッチリ同額じゃないとダメ？', law: '340AC0000000034', key: '34', title: '第三十四条', caption: '役員給与の損金不算入' },
    { q: '課税仕入れの仕入税額控除は、いつのタイミングで控除する？', law: '363AC0000000108', key: '30', title: '第三十条', caption: '仕入れに係る消費税額の控除' },
  ];

  const results = [];
  for (const d of demos) {
    const lawTitle = LAW_NAMES[d.law] || d.law;
    const refs = (load(d.law)[d.key] || []);
    process.stdout.write(`generating: ${d.q.slice(0, 18)}... (candidates ${refs.length})\n`);
    const { answer, referenced } = await explain(d.q, lawTitle, d.title, refs, bodyMap);
    results.push({ query: d.q, law_id: d.law, law_title: lawTitle, article_title: d.title, article_caption: d.caption, answer, referenced });
  }

  const pubDir = path.join(REPO_ROOT, 'public');
  if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });
  fs.writeFileSync(path.join(pubDir, 'explain_demo.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('書き出し: public/explain_demo.json (' + results.length + '件)');
}
main().catch(e => { console.error('FAIL', e); process.exit(1); });
