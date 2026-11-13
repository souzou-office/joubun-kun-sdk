// 09: tsutatsu_chunks_v1/ を R2(joubun-kun-data) の新ネームスペースへアップロード。
// Blue-Green: 新パス tsutatsu_chunks_v1/ のみに書き出す。既存 refs_chunks_v4 等は一切触らない。
//
// 実行:
//   node scripts/tsutatsu/09_upload_chunks.cjs --dry     # 実行コマンドの確認だけ（アップロードしない）
//   node scripts/tsutatsu/09_upload_chunks.cjs           # 本番R2へアップロード（--remote）
//   node scripts/tsutatsu/09_upload_chunks.cjs --local   # wrangler dev 用のローカルR2へ
//
// 前提: wrangler 認証済み。wrangler のバージョンで r2 object put の引数が違う場合は要調整。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TSU_VER = process.env.TSU_VER || 'v1';
const SRC = path.join(REPO_ROOT, `tsutatsu_chunks_${TSU_VER}`);
const BUCKET = 'joubun-kun-data';
const PREFIX = `tsutatsu_chunks_${TSU_VER}`;

// 既に本番/ベンチが読んでいる版を上書きしない。書いてよいのは新しい版だけ。
// 固定の一覧に加えて、wrangler*.toml の TSUTATSU_CHUNKS_PREFIX（本番・staging・bench が今読んでいる版）も止める。
const FROZEN = new Set(['v1', 'v2', 'v3']);
for (const f of fs.readdirSync(REPO_ROOT).filter((x) => /^wrangler.*\.toml$/.test(x))) {
  const m = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').match(/^\s*TSUTATSU_CHUNKS_PREFIX\s*=\s*"tsutatsu_chunks_(v\d+)"/m);
  if (m) FROZEN.add(m[1]);
}
if (FROZEN.has(TSU_VER) && !process.argv.includes('--i-really-mean-to-overwrite')) {
  console.error(`tsutatsu_chunks_${TSU_VER}/ は稼働中の版です。上書きしません（TSU_VER=v4 のように新しい版を指定してください）`);
  process.exit(1);
}

const dry = process.argv.includes('--dry');
const local = process.argv.includes('--local');
const scope = local ? '--local' : '--remote';

if (!fs.existsSync(SRC)) {
  console.error(`${SRC} が見つかりません。先に TSU_VER=${TSU_VER} node scripts/tsutatsu/08_build_chunks.cjs を実行してください`);
  process.exit(1);
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.json'));
console.log(`${files.length} ファイルを ${BUCKET}/${PREFIX}/ へ (${scope})`);

let ok = 0, fail = 0;
for (const f of files) {
  const localPath = path.join(SRC, f);
  const key = `${BUCKET}/${PREFIX}/${f}`;
  const cmd = `npx wrangler r2 object put "${key}" --file "${localPath}" --content-type application/json ${scope}`;
  if (dry) { console.log('  [dry] ' + cmd); continue; }
  try {
    execSync(cmd, { stdio: 'pipe' });
    ok++;
    console.log('  OK ' + f);
  } catch (e) {
    fail++;
    console.log('  NG ' + f + ': ' + (e.stderr ? e.stderr.toString().slice(0, 200) : e.message));
  }
}
if (!dry) console.log(`完了: ${ok} OK / ${fail} NG`);
