// 租税条約の週次更新: 下見（build/）を退避付きで本番（R2 treaty/v1・Vectorize の _treaty）に書く・戻す。
//
//   node scripts/treaty/weekly/run.cjs apply              TREATY_WEEKLY_OUT/build/ の成果物を反映する
//   node scripts/treaty/weekly/run.cjs restore <run_id>   その回の反映を戻す（退避は R2 update_state/treaty_backup/<run_id>/）
//
// 反映・戻しの本体は scripts/update/lib/delta_apply.cjs（通達・事例・別表・委任先と共用）。ここは租税条約に固有の決まりだけ:
//   - 書いてよいのは treaty/v1/index.json と treaty/v1/{slug}.json だけ。index.json は最後に書き、戻すときは最初に戻す
//   - 状態の控え（update_state/treaty/state.json。PDF の ETag / Last-Modified と中身の hash）は書いた後に置く
//
// 見直す対象がある回（初回・条文が変わった国がある回を含む）は、オーナーの Issue への「反映」コメントからだけ（ワークフローが TREATY_APPROVED=1 を渡す）。
// 書く経路は Actions の Update treaties だけ。R2_FAKE_DIR と VECTORIZE_FAKE_FILE が両方あるときは確かめ用に動く。
'use strict';
const fs = require('fs');
const path = require('path');
const { makeApplier } = require('../../update/lib/delta_apply.cjs');
const { PREFIX, STATE_KEY, VEC_STATE_KEY, APPLY_LOCK_KEY, META_LIMIT, VEC_INDEX } = require('./build.cjs');

const OUT = () => path.resolve(process.env.TREATY_WEEKLY_OUT || path.join(__dirname, 'state'));

const applier = makeApplier({
  label: 'Update treaties',
  envPrefix: 'TREATY',
  dir: () => path.join(OUT(), 'build'),
  lockKey: APPLY_LOCK_KEY,
  backupPrefix: 'update_state/treaty_backup',
  mutKey: 'update_state/treaty/vec_mutation.json',
  markId: 'treaty-weekly-mark',
  vecIndex: VEC_INDEX,
  idRe: /^tr_[0-9a-f]{8}_\d+$/,   // 04 と同じ
  metaLimit: META_LIMIT,
  vecStateKey: VEC_STATE_KEY,
  prodPrefix: null,                // 版は無い（今の場所に退避付きで上書き）
  keyLabel: '租税条約のファイル（treaty/v1/index.json・{slug}.json）',
  allowedKey: (k) => new RegExp(`^${PREFIX}/(index|[0-9a-f]{8})\\.json$`).test(k),
  checkFile: (k, o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`成果物の形が違う: ${k}。書かずに止める`);
    if (k.endsWith('/index.json') ? !Array.isArray(o.countries) : !Array.isArray(o.articles)) throw new Error(`成果物の形が違う: ${k}。書かずに止める`);
  },
  isIndexKey: (k) => k === `${PREFIX}/index.json`,
  extraStates: (m, B) => {
    let body;
    try { body = fs.readFileSync(path.join(B, 'state_next.json')); JSON.parse(body.toString('utf8')); } catch { throw new Error('state_next.json が無い・読めない。書かずに止める'); }
    return [{ key: STATE_KEY, body, sha_before: m.state_sha_before }];
  },
});

module.exports = { apply: applier.apply, restore: applier.restore, LOCK_KEY: APPLY_LOCK_KEY };
