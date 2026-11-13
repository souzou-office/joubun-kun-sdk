// 通達の週次更新 段 3b: 下見（段 3a の build/）を本番に反映する・戻す（docs/tsutatsu_hanrei_weekly.md）。
//
//   node scripts/tsutatsu/weekly/run.cjs apply              TSU_WEEKLY_OUT/build/ の成果物を反映する
//   node scripts/tsutatsu/weekly/run.cjs restore <run_id>   その回の反映を戻す（退避は R2 update_state/tsutatsu_backup/<run_id>/）
//
// 反映・戻しの本体は scripts/update/lib/delta_apply.cjs（質疑応答事例・裁決と共用）。ここは通達に固有の決まりだけ:
//   - 書いてよいのは本番の通達（wrangler.toml の TSUTATSU_CHUNKS_PREFIX）の法令ファイルと index.json とページの見出し pages.json。法令ファイルが変わるなら index.json も
//   - index.json は最後に書き、戻すときは最初に戻す（新しい法令のファイルが先に在るように）
//   - 下見より新しい取り直し（update_state/tsutatsu/current.json の世代）があれば書かない
//   - 状態の控え: vec_state.json と build_state.json（浮きの数と、反映した PDF の中身の hash。次の下見の比べる元）
//
// 見直す対象がある回（初回を含む）は、オーナーの Issue への「反映」コメントからだけ（ワークフローが TSU_APPROVED=1 を渡す）。
// 書く経路は Actions の Update tsutatsu data だけ（手元で本番に書かない）。R2_FAKE_DIR と VECTORIZE_FAKE_FILE が両方あるときは確かめ用に動く。
//
// ログには件数・法令 ID・ベクトルの id だけを出す（利用者の入力は扱わない）。
'use strict';
const fs = require('fs');
const path = require('path');
const { makeApplier, sameVector } = require('../../update/lib/delta_apply.cjs');
const { prodPrefix, VEC_STATE_KEY, BUILD_STATE_KEY, APPLY_LOCK_KEY: LOCK_KEY, META_LIMIT, VEC_INDEX } = require('./build.cjs');

const OUT = () => path.resolve(process.env.TSU_WEEKLY_OUT || path.join(__dirname, 'state'));
const BACKUP_PREFIX = 'update_state/tsutatsu_backup';
const CURRENT_KEY = 'update_state/tsutatsu/current.json';   // 取り直しの今の基準（run.cjs）

const applier = makeApplier({
  label: 'Update tsutatsu data',
  envPrefix: 'TSU',
  dir: () => path.join(OUT(), 'build'),
  lockKey: LOCK_KEY,
  backupPrefix: BACKUP_PREFIX,
  mutKey: 'update_state/tsutatsu/vec_mutation.json',
  markId: 'tsu-weekly-mark',
  vecIndex: VEC_INDEX,
  idRe: /^[0-9a-f]{32}$/,   // 21 と同じ md5
  metaLimit: META_LIMIT,
  vecStateKey: VEC_STATE_KEY,
  prodPrefix,
  keyLabel: '本番の通達のファイル',
  allowedKey: (k, PROD) => k.startsWith(`${PROD}/`) && /^[^/]+\/[0-9A-Za-z_]+\.json$/.test(k),
  checkFile: (k, o) => {
    if (k.endsWith('/index.json') ? !(o && o.laws && typeof o.laws === 'object') : !(o && typeof o === 'object' && !Array.isArray(o))) throw new Error(`成果物の形が違う: ${k}。書かずに止める`);
  },
  isIndexKey: (k) => k.endsWith('/index.json'),
  checkSet: (keys, PROD) => {
    // ページの見出し（pages.json・build.cjs の 6b）は法令の一覧と別に変わる
    if (keys.some((k) => k !== `${PROD}/index.json` && k !== `${PROD}/pages.json`) && !keys.includes(`${PROD}/index.json`)) throw new Error('法令ファイルが変わるのに index.json が成果物に無い。書かずに止める');
  },
  freshCheck: async (r2, m) => {
    const cur = await r2.getJson(CURRENT_KEY);
    if (m.baseline_gen && (!cur || cur.gen !== m.baseline_gen)) throw new Error(`この下見（写し ${m.baseline_gen}）の後に新しい取り直しがある（今の基準 ${cur ? cur.gen : 'なし'}）。古い下見は反映しない。新しい回の Issue か自動の反映を使う。何も書いていない`);
  },
  extraStates: (m, B, rid) => {
    let pdfHashes;
    try { pdfHashes = JSON.parse(fs.readFileSync(path.join(B, 'pdf_hashes.json'), 'utf8')); } catch { throw new Error('pdf_hashes.json が無い・読めない。書かずに止める'); }
    if (!pdfHashes || typeof pdfHashes !== 'object' || Array.isArray(pdfHashes)) throw new Error('pdf_hashes.json の形が違う。書かずに止める');
    // build_state: 浮きの数と読めない PDF の数（次の下見の「前回より 50 本超増えた」）と、反映した PDF の中身の hash（次の下見の「中身が変わった PDF」の比べる元）
    const st = { run_id: rid, stamp: m.stamp, orphans: m.orphans, pdf_hashes: pdfHashes, applied_at: new Date().toISOString() };
    if (Number.isFinite(m.pdf_unreadable)) st.pdf_unreadable = m.pdf_unreadable;
    const body = JSON.stringify(st);
    return [{ key: BUILD_STATE_KEY, body, sha_before: m.build_state_sha_before }];
  },
});

module.exports = { apply: applier.apply, restore: applier.restore, sameVector, LOCK_KEY, BACKUP_PREFIX };
