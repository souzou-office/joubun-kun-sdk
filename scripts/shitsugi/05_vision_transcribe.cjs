// 質疑応答事例の本文画像を Claude vision でテキスト化（取り込み時1回きり）
//   計算式 → テキストの数式
//   図解   → 2〜3文の状況説明
//
//   node scripts/shitsugi/05_vision_transcribe.cjs --dry    # 対象数のみ
//   node scripts/shitsugi/05_vision_transcribe.cjs
//
// 入力: shitsugi_items_YYYYMMDD.ndjson + shitsugi_images_YYYYMMDD/
// 出力: scripts/shitsugi/state/image_texts_YYYYMMDD.json  （src → {text, kind}）
// レジューム: 出力ファイルに既にある src はスキップ。

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');

function readDevVar(name) {
  const txt = fs.readFileSync(path.join(REPO_ROOT, '.dev.vars'), 'utf8');
  const line = txt.split('\n').find((l) => l.replace(/^\s+/, '').startsWith(name + '='));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : null;
}
const CLAUDE_API_KEY = readDevVar('CLAUDE_API_KEY');

function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter((x) => /^shitsugi_items_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

const MEDIA = { '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const SYS =
  '国税庁の質疑応答事例に含まれる図・計算式画像を、視覚障害者向け読み上げにも使える正確なテキストに変換します。\n'
  + '・計算式なら: 数式をテキストで正確に書き起こす（分数は「A ÷ B」、括弧はそのまま）。数値・単位を一切変えない。\n'
  + '・図解（配置図・関係図・フロー図）なら: 2〜3文で構造を客観的に説明する。\n'
  + '・表なら: 行×列をテキスト表に書き起こす。\n'
  + '・推測や解説は加えない。画像にある情報だけを書く。\n'
  + '最初の行に必ず種別（計算式/図解/表）だけを書き、2行目以降に内容を書く。';

async function transcribe(imgPath, context) {
  const ext = path.extname(imgPath).toLowerCase();
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: SYS,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: MEDIA[ext] || 'image/gif', data: b64 } },
          { type: 'text', text: `事例タイトル: ${context.title}\n画像のalt: ${context.alt || '(なし)'}\n掲載セクション: ${context.section === 'shokai' ? '照会要旨' : '回答要旨'}` },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  const kindM = text.match(/^(計算式|図解|表)/);
  return { kind: kindM ? kindM[1] : '図解', text };
}

async function main() {
  const dry = process.argv.includes('--dry');
  if (!dry && !CLAUDE_API_KEY) { console.error('CLAUDE_API_KEY が .dev.vars にありません'); process.exit(1); }
  const stamp = latestStamp();
  const items = fs
    .readFileSync(path.join(STATE_DIR, `shitsugi_items_${stamp}.ndjson`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const imgRoot = path.join(REPO_ROOT, `shitsugi_images_${stamp}`);
  const outFile = path.join(STATE_DIR, `image_texts_${stamp}.json`);
  const done = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};

  // src → コンテキスト（同一画像が複数事例から参照されることは稀だが最初の1件でよい）
  const targets = new Map();
  for (const it of items) {
    for (const im of it.images || []) {
      const srcPath = new URL(im.src, it.url).pathname;
      if (done[srcPath]) continue;
      if (!targets.has(srcPath)) targets.set(srcPath, { title: it.title, alt: im.alt, section: im.section });
    }
  }
  console.log(`vision変換対象: ${targets.size} 枚（変換済み ${Object.keys(done).length}）`);
  if (dry) return;

  let ok = 0, ng = 0, missing = 0;
  for (const [srcPath, ctx] of targets) {
    const local = path.join(imgRoot, srcPath.replace(/^\//, '').split('/').join(path.sep));
    if (!fs.existsSync(local)) { missing++; continue; }
    try {
      done[srcPath] = await transcribe(local, ctx);
      ok++;
    } catch (e) {
      ng++;
      console.log(`FAIL ${srcPath}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (ok % 20 === 0) fs.writeFileSync(outFile, JSON.stringify(done, null, 1), 'utf8');
    process.stdout.write(`\r  ${ok + ng}/${targets.size}  成功${ok} 失敗${ng} 画像なし${missing}`);
  }
  fs.writeFileSync(outFile, JSON.stringify(done, null, 1), 'utf8');
  console.log(`\n完了: 成功 ${ok} / 失敗 ${ng} / ローカル画像なし ${missing}`);
  console.log(`出力: ${outFile}`);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
