// 裁決事例の表示用データを R2(joubun-kun-data) の新パス saiketsu_v1/ へアップロード。
// Blue-Green: saiketsu_v1/ のみに書き出す。既存パスは一切触らない。
//
//   node scripts/saiketsu/07_build_upload_r2.cjs --build        # ローカル構築のみ
//   node scripts/saiketsu/07_build_upload_r2.cjs --dry          # アップロード対象の確認
//   node scripts/saiketsu/07_build_upload_r2.cjs                # 構築＋R2アップロード（--remote）
//   node scripts/saiketsu/07_build_upload_r2.cjs --json-only    # チャンクJSONのみ再アップロード
//
// レイアウト:
//   saiketsu_v1/index.json         # sid → {title, date, chunk}
//   saiketsu_v1/cases_{号}.json    # 号別チャンク（sid → 裁決フル: 要旨・セクション親子・law_refs）

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');
const BUCKET = 'joubun-kun-data';
const PREFIX = 'saiketsu_v1';

function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter((x) => /^saiketsu_items_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

const dry = process.argv.includes('--dry');
const buildOnly = process.argv.includes('--build');
const jsonOnly = process.argv.includes('--json-only');

const stamp = latestStamp();
if (!stamp) throw new Error('saiketsu_items がありません');
const items = fs
  .readFileSync(path.join(STATE_DIR, `saiketsu_items_${stamp}.ndjson`), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const outRoot = path.join(REPO_ROOT, 'saiketsu_r2_v1');
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

const index = {};
const chunks = {};
for (const it of items) {
  if (!it.abstract || it.abstract.length < 30) continue;
  const ck = it.no; // 号別チャンク
  if (!chunks[ck]) chunks[ck] = {};
  chunks[ck][it.id] = {
    id: it.id, title: it.title, abstract: it.abstract, date: it.date,
    topics: it.topics, tax_laws: it.tax_laws, law_refs: it.law_refs,
    sections: it.sections, url: it.url, has_full: it.has_full,
  };
  index[it.id] = { title: (it.title || '').slice(0, 80), date: it.date, chunk: `cases_${ck}.json` };
}
for (const [ck, obj] of Object.entries(chunks)) {
  fs.writeFileSync(path.join(outRoot, `cases_${ck}.json`), JSON.stringify(obj), 'utf8');
}
fs.writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(index), 'utf8');
const totalKB = Object.keys(chunks).reduce((s, ck) => s + fs.statSync(path.join(outRoot, `cases_${ck}.json`)).size, 0) / 1024;
console.log(`構築完了: ${Object.keys(index).length} 裁決 / ${Object.keys(chunks).length} チャンク / 計 ${(totalKB / 1024).toFixed(1)}MB`);
if (buildOnly) process.exit(0);

const uploads = fs.readdirSync(outRoot).map((f) => ({ local: path.join(outRoot, f), key: `${PREFIX}/${f}` }));
console.log(`アップロード対象: ${uploads.length} ファイル → ${BUCKET}/${PREFIX}/ (--remote)`);
if (dry) { console.log('★ DRY-RUN'); process.exit(0); }

let ok = 0, ng = 0;
for (const u of uploads) {
  try {
    execSync(`npx wrangler r2 object put "${BUCKET}/${u.key}" --file="${u.local}" --content-type="application/json" --remote`, { stdio: 'pipe', cwd: REPO_ROOT });
    ok++;
  } catch (e) { ng++; console.log(`NG ${u.key}`); }
  if ((ok + ng) % 20 === 0) console.log(`  ${ok + ng}/${uploads.length}`);
}
console.log(`完了: ${ok} / 失敗 ${ng}`);
