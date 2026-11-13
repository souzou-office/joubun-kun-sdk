// 質疑応答事例の表示用データを R2(joubun-kun-data) の新パス shitsugi_v1/ へアップロード。
// Blue-Green: shitsugi_v1/ のみに書き出す。既存パスは一切触らない。
//
//   node scripts/shitsugi/07_build_upload_r2.cjs --build        # ローカル構築のみ
//   node scripts/shitsugi/07_build_upload_r2.cjs --dry          # アップロード対象の確認
//   node scripts/shitsugi/07_build_upload_r2.cjs                # 構築＋R2アップロード（--remote）
//   node scripts/shitsugi/07_build_upload_r2.cjs --json-only    # チャンクJSONのみ再アップロード（vision反映後用）
//
// レイアウト:
//   shitsugi_v1/index.json            # sid → {cat, title, chunk}
//   shitsugi_v1/cases_<catkey>.json   # カテゴリ別チャンク（sid → 事例フル: 本文・アンカー・image_texts込み）
//   shitsugi_v1/img/<元パス>          # 画像（表示用）

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');
const BUCKET = 'joubun-kun-data';
const PREFIX = 'shitsugi_v1';

function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter((x) => /^shitsugi_items_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

const dry = process.argv.includes('--dry');
const buildOnly = process.argv.includes('--build');
const jsonOnly = process.argv.includes('--json-only');

const stamp = latestStamp();
if (!stamp) throw new Error('shitsugi_items がありません');
const items = fs
  .readFileSync(path.join(STATE_DIR, `shitsugi_items_${stamp}.ndjson`), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const imgTextsFile = path.join(STATE_DIR, `image_texts_${stamp}.json`);
const imgTexts = fs.existsSync(imgTextsFile) ? JSON.parse(fs.readFileSync(imgTextsFile, 'utf8')) : {};
const imgRoot = path.join(REPO_ROOT, `shitsugi_images_${stamp}`);
const outRoot = path.join(REPO_ROOT, 'shitsugi_r2_v1');

// カテゴリ → チャンクキー（ファイル名用ASCII）
function catKey(id) {
  return id.split('/')[0]; // shotoku/gensen/juto/sozoku/hyoka/hojin/shohi/inshi/sake/hotei
}

// 構築
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });
const index = {};
const chunks = {};
const seen = new Set();
let imgCount = 0;
for (const it of items) {
  if (seen.has(it.id)) continue;
  seen.add(it.id);
  if (!it.shokai || !it.kaito) continue;
  const ck = catKey(it.id);
  if (!chunks[ck]) chunks[ck] = {};
  const images = (it.images || []).map((im) => {
    const srcPath = new URL(im.src, it.url).pathname;
    return { path: srcPath, alt: im.alt, section: im.section, text: (imgTexts[srcPath] || {}).text || null, kind: (imgTexts[srcPath] || {}).kind || null };
  });
  imgCount += images.length;
  chunks[ck][it.id] = {
    id: it.id, url: it.url, category: it.category, title: it.title,
    shokai: it.shokai, kaito: it.kaito,
    kankei_raw: it.kankei_raw, anchors: it.anchors, tsutatsu_refs: it.tsutatsu_refs,
    images, related: it.related, as_of: it.as_of,
  };
  index[it.id] = { cat: it.category, title: it.title, chunk: `cases_${ck}.json` };
}
for (const [ck, obj] of Object.entries(chunks)) {
  fs.writeFileSync(path.join(outRoot, `cases_${ck}.json`), JSON.stringify(obj), 'utf8');
}
fs.writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(index), 'utf8');
console.log(`構築完了: ${Object.keys(index).length} 事例 / ${Object.keys(chunks).length} チャンク / 画像参照 ${imgCount}`);
for (const [ck, obj] of Object.entries(chunks)) {
  const size = fs.statSync(path.join(outRoot, `cases_${ck}.json`)).size;
  console.log(`  cases_${ck}.json  ${Object.keys(obj).length}件  ${(size / 1024).toFixed(0)}KB`);
}
if (buildOnly) process.exit(0);

// アップロード対象: チャンク＋index＋画像
const uploads = [];
for (const f of fs.readdirSync(outRoot)) uploads.push({ local: path.join(outRoot, f), key: `${PREFIX}/${f}`, ct: 'application/json' });
if (!jsonOnly && fs.existsSync(imgRoot)) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = path.relative(imgRoot, p).split(path.sep).join('/');
        const ext = path.extname(e.name).toLowerCase();
        const ct = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/gif';
        uploads.push({ local: p, key: `${PREFIX}/img/${rel}`, ct });
      }
    }
  };
  walk(imgRoot);
}
console.log(`アップロード対象: ${uploads.length} ファイル → ${BUCKET}/${PREFIX}/ (--remote)`);
if (dry) { console.log('★ DRY-RUN'); process.exit(0); }

let ok = 0, ng = 0;
for (const u of uploads) {
  try {
    execSync(
      `npx wrangler r2 object put "${BUCKET}/${u.key}" --file="${u.local}" --content-type="${u.ct}" --remote`,
      { stdio: 'pipe', cwd: REPO_ROOT }
    );
    ok++;
  } catch (e) {
    ng++;
    console.log(`NG ${u.key}: ${String(e.message).slice(0, 120)}`);
  }
  if ((ok + ng) % 25 === 0) console.log(`  ${ok + ng}/${uploads.length}`);
}
console.log(`完了: ${ok} / 失敗 ${ng}`);
