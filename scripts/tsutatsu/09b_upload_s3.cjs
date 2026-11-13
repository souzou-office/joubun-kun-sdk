// 09b: tsutatsu_chunks_v1/ を R2 へアップロード（S3互換API版）。
// この版の wrangler OAuth には R2 スコープが無く `wrangler r2 object put --remote` が 403 になるため、
// .env の R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY（=既存の正規アップロード手段）を使う。
// 既存データには触れない（新prefix tsutatsu_chunks_v1/ への put のみ = additive / Blue-Green = 安全）。
//
//   node scripts/tsutatsu/09b_upload_s3.cjs        # アップロード実行
//   node scripts/tsutatsu/09b_upload_s3.cjs --dry  # 上げる対象の確認のみ（put しない）

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const SITE = require('../site_config.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'tsutatsu_chunks_v1');
const ACCT = SITE.cfAccountId;
const BUCKET = 'joubun-kun-data';
const PREFIX = 'tsutatsu_chunks_v1';
const ENDPOINT = `https://${ACCT}.r2.cloudflarestorage.com`;
const DRY = process.argv.includes('--dry');

function loadDotenv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function main() {
  loadDotenv(path.join(REPO_ROOT, '.env'));
  const aki = process.env.R2_ACCESS_KEY_ID;
  const sak = process.env.R2_SECRET_ACCESS_KEY;
  if (!aki || !sak) {
    console.error('ERROR: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY が .env にありません');
    process.exit(1);
  }

  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.json')).sort();
  console.log(`対象: ${files.length} ファイル → r2://${BUCKET}/${PREFIX}/  (既存prefixには触れません)`);
  console.log(`Endpoint: ${ENDPOINT}`);
  if (DRY) {
    files.forEach((f) => console.log('  [dry] ' + PREFIX + '/' + f));
    console.log('★ DRY-RUN（put していません）');
    return;
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: ENDPOINT,
    credentials: { accessKeyId: aki, secretAccessKey: sak },
  });

  let ok = 0;
  let ng = 0;
  for (const f of files) {
    const key = `${PREFIX}/${f}`;
    try {
      const body = fs.readFileSync(path.join(SRC_DIR, f));
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
      ok++;
      console.log(`  OK  ${key} (${Math.round(body.length / 1024)}KB)`);
    } catch (e) {
      ng++;
      console.error(`  NG  ${key}: ${e.name || ''}: ${e.message || e}`);
    }
  }
  console.log(`完了: ${ok} OK / ${ng} NG`);
  if (ng) process.exit(2);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
