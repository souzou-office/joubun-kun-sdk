// 別表のベクトルの週次更新: 下見（build/）を退避付きで本番の Vectorize に書く・戻す。
//
//   node scripts/beppyo/weekly/run.cjs apply              BEPPYO_WEEKLY_OUT/build/ の成果物を反映する
//   node scripts/beppyo/weekly/run.cjs restore <run_id>   その回の反映を戻す（退避は R2 update_state/beppyo_backup/<run_id>/）
//
// 反映・戻しの本体は scripts/update/lib/delta_apply.cjs（通達・事例と共用）。ここは別表に固有の決まりだけ:
//   - R2 のファイルは書かない（ベクトルと状態の控えだけ）
//   - 下見の後に法令の週次が反映された（台帳 update_state/sync_state.json が変わった）か、refs が書き換わった（refs の一覧の印）なら書かない
//   - 本番の条文・refs のプレフィックス（wrangler.toml）が下見と違えば書かない
//
// 見直す対象がある回（初回を含む）は、オーナーの Issue への「反映」コメントからだけ（ワークフローが BEPPYO_APPROVED=1 を渡す）。
// 書く経路は Actions の Update beppyo vectors だけ。R2_FAKE_DIR と VECTORIZE_FAKE_FILE が両方あるときは確かめ用に動く。
'use strict';
const path = require('path');
const crypto = require('crypto');
const { makeApplier } = require('../../update/lib/delta_apply.cjs');
const { LAWS_APPLY_MARK } = require('../../update/apply_mark.cjs');
const { VEC_STATE_KEY, APPLY_LOCK_KEY, LEDGER_KEY, META_LIMIT, VEC_INDEX, prodPrefixes, prodKey, refsSignature } = require('./build.cjs');

const OUT = () => path.resolve(process.env.BEPPYO_WEEKLY_OUT || path.join(__dirname, 'state'));
const sha = (b) => (b == null ? null : crypto.createHash('sha256').update(b).digest('hex'));

const applier = makeApplier({
  label: 'Update beppyo vectors',
  envPrefix: 'BEPPYO',
  dir: () => path.join(OUT(), 'build'),
  lockKey: APPLY_LOCK_KEY,
  backupPrefix: 'update_state/beppyo_backup',
  mutKey: 'update_state/beppyo/vec_mutation.json',
  markId: 'beppyo-weekly-mark',
  vecIndex: VEC_INDEX,
  // _beppyo は md5（13 と同じ）。行は `${法令ID}_${別表名}_g${n}`（15 と同じ。別表名は日本語）
  idRe: /^(?:[0-9a-f]{32}|[0-9A-Za-z]+_別表[^\n]*_g\d+)$/,
  metaLimit: META_LIMIT,
  vecStateKey: VEC_STATE_KEY,
  prodPrefix: () => prodKey(prodPrefixes()),
  keyLabel: '（別表の週次は R2 のファイルを書かない）',
  allowedKey: () => false,
  checkFile: () => {},
  isIndexKey: () => false,
  freshCheck: async (r2, m) => {
    const { refs } = prodPrefixes();
    const lawMark = await r2.getJson(LAWS_APPLY_MARK);
    if (lawMark) throw new Error(`法令の週次の反映（run ${lawMark.run_id}）が途中（${LAWS_APPLY_MARK} が残っている）。条文・refs が書きかけなので書かない。何も書いていない`);
    if (sha(await r2.get(LEDGER_KEY)) !== m.ledger_sha) throw new Error(`この下見の後に法令の週次が反映された（${LEDGER_KEY} が変わった）。古い下見は反映しない。取り直しからやり直す。何も書いていない`);
    if (sha(await r2.get(`${refs}/refs_index.json`)) !== m.refs_index_sha) throw new Error(`この下見の後に ${refs}/refs_index.json が変わった。古い下見は反映しない。取り直しからやり直す。何も書いていない`);
    // refs_index.json はチャンクの中身だけの書き換え（refs だけの作り直し）では変わらないので、refs の一覧の印でも見る
    if (!m.refs_sig || await refsSignature(r2, refs) !== m.refs_sig) throw new Error(`この下見の後に refs（${refs}）が書き換わった。homes が古い refs のまま。取り直しからやり直す。何も書いていない`);
  },
});

module.exports = { apply: applier.apply, restore: applier.restore, LOCK_KEY: APPLY_LOCK_KEY };
