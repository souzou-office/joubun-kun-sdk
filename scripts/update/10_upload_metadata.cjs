// Phase 5: フッター表示用のデータ取得日時メタデータをR2にアップロード
//
// 使用方法:
//   node scripts/update/10_upload_metadata.cjs
//
// 入力:
//   scripts/update/state/sync_state.json (Phase 1 で生成)
//
// 出力:
//   R2 上の data_metadata.json (joubun-kun-data バケット)
//     {
//       "fetched_at": "2026-05-08T09:07:18.115Z",
//       "total_count": 8967,
//       "uploaded_at": "2026-05-19T..."
//     }
//
// 用途:
//   フロントが /api/metadata 経由で読み取り、フッターに「YYYY/M/D 時点」と表示する。
//
// 前提:
//   wrangler CLI がインストール済み・R2 へのアクセス権限が設定済み。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STATE_PATH = path.join(__dirname, 'state', 'sync_state.json');
const TMP_PATH = path.join(__dirname, 'state', '_data_metadata_tmp.json');
const R2_BUCKET = 'joubun-kun-data';
const R2_KEY = 'data_metadata.json';

function main() {
  if (!fs.existsSync(STATE_PATH)) {
    console.error(`❌ ${STATE_PATH} が見つかりません。先に 01_fetch_law_list.cjs を実行してください。`);
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  if (!state.fetched_at) {
    console.error('❌ sync_state.json に fetched_at がありません');
    process.exit(1);
  }

  const metadata = {
    fetched_at: state.fetched_at,
    total_count: state.total_count || Object.keys(state.laws || {}).length,
    uploaded_at: new Date().toISOString(),
  };

  fs.writeFileSync(TMP_PATH, JSON.stringify(metadata, null, 2));
  console.log('📝 metadata:', metadata);

  console.log(`⬆️  R2 (${R2_BUCKET}/${R2_KEY}) にアップロード...`);
  try {
    execSync(
      `npx wrangler r2 object put ${R2_BUCKET}/${R2_KEY} --file "${TMP_PATH}" --content-type application/json --remote`,
      { stdio: 'inherit' }
    );
    console.log('✅ アップロード完了');
  } catch (err) {
    console.error('❌ wrangler でのアップロードに失敗:', err.message);
    process.exit(1);
  } finally {
    if (fs.existsSync(TMP_PATH)) fs.unlinkSync(TMP_PATH);
  }
}

main();
