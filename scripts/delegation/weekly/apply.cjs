// 委任先の週次更新: 下見（build/）を退避付きで本番（DELEGATIONS_PREFIX の配信用チャンク）に書く・戻す。
//
//   node scripts/delegation/weekly/run.cjs apply              DELEG_WEEKLY_OUT/build/ の成果物を反映する
//   node scripts/delegation/weekly/run.cjs restore <run_id>   その回の反映を戻す（退避は R2 update_state/delegations_backup/<run_id>/）
//
// 反映・戻しの本体は scripts/update/lib/delta_apply.cjs（通達・事例・別表と共用）。ここは委任先に固有の決まりだけ:
//   - 書いてよいのは今の DELEGATIONS_PREFIX の index.json と chunk_NNN.json だけ。index.json は最後に書き、戻すときは最初に戻す
//     （新しい法令の委任がチャンクに先に在るように。Worker・条文ページは index → チャンクの順に読む）
//   - 下見の後に法令の週次が反映された（台帳が変わった）、refs が書き換わった（refs の一覧の印）、法令の週次の反映中の印がある、
//     wrangler.toml のプレフィックスが変わった、のどれかなら書かない
//   - 状態の控え（update_state/delegations/state.json）は書いた後に置く（次の回の「変わった法令」の比べる元）
//   - ベクトルは無い（delta_apply の決まりで空の状態の控えを置く）
//
// 見直す対象がある回（初回を含む）は、オーナーの Issue への「反映」コメントからだけ（ワークフローが DELEG_APPROVED=1 を渡す）。
// 書く経路は Actions の Update delegations だけ。R2_FAKE_DIR と VECTORIZE_FAKE_FILE が両方あるときは確かめ用に動く。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeApplier } = require('../../update/lib/delta_apply.cjs');
const { LAWS_APPLY_MARK } = require('../../update/apply_mark.cjs');
const { refsSignature } = require('../../beppyo/weekly/build.cjs');
const { STATE_KEY, VEC_STATE_KEY, APPLY_LOCK_KEY, LEDGER_KEY, prodPrefixes } = require('./build.cjs');

const OUT = () => path.resolve(process.env.DELEG_WEEKLY_OUT || path.join(__dirname, 'state'));
const sha = (b) => (b == null ? null : crypto.createHash('sha256').update(b).digest('hex'));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const applier = makeApplier({
  label: 'Update delegations',
  envPrefix: 'DELEG',
  dir: () => path.join(OUT(), 'build'),
  lockKey: APPLY_LOCK_KEY,
  backupPrefix: 'update_state/delegations_backup',
  mutKey: 'update_state/delegations/vec_mutation.json',
  markId: 'delegations-weekly-mark',
  vecIndex: 'tsutatsu-embeddings-v1',   // 使わない（ベクトルは書かない）
  idRe: /^$/,                           // ベクトルは無い
  metaLimit: 10 * 1024,
  vecStateKey: VEC_STATE_KEY,
  prodPrefix: () => prodPrefixes().deleg,
  keyLabel: '今の委任先の配信用ファイル（index.json・chunk_NNN.json）',
  allowedKey: (k, prod) => new RegExp(`^${esc(prod)}/(index|chunk_\\d{3,})\\.json$`).test(k),
  checkFile: (k, o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`成果物の形が違う: ${k}。書かずに止める`);
    if (!k.endsWith('/index.json')) for (const [id, v] of Object.entries(o)) if (!v || typeof v.articles !== 'object') throw new Error(`成果物の形が違う: ${k} の ${id}。書かずに止める`);
  },
  isIndexKey: (k) => k.endsWith('/index.json'),
  freshCheck: async (r2, m) => {
    const { refs, articles } = prodPrefixes();
    // 委任先のプレフィックスは delta_apply が見る（prodPrefix）。材料の条文・refs のプレフィックスもここで見る
    if (articles !== m.articles_prefix || refs !== m.refs_prefix) throw new Error(`下見の後に条文か refs のプレフィックスが変わった（${m.articles_prefix}・${m.refs_prefix} → ${articles}・${refs}）。古い下見は反映しない。取り直しからやり直す。何も書いていない`);
    // 自分の作業中の印を取った後に確かめる（法令の週次は印を置いてからこちらの印を見て止まるので、確かめた後に法令が書き始めることもない）
    const lawMark = await r2.getJson(LAWS_APPLY_MARK);
    if (lawMark) throw new Error(`法令の週次の反映（run ${lawMark.run_id}）が途中（${LAWS_APPLY_MARK} が残っている）。条文・refs が書きかけなので書かない。何も書いていない`);
    if (sha(await r2.get(LEDGER_KEY)) !== m.ledger_sha) throw new Error(`この下見の後に法令の週次が反映された（${LEDGER_KEY} が変わった）。古い下見は反映しない。取り直しからやり直す。何も書いていない`);
    if (sha(await r2.get(`${refs}/refs_index.json`)) !== m.refs_index_sha) throw new Error(`この下見の後に ${refs}/refs_index.json が変わった。古い下見は反映しない。取り直しからやり直す。何も書いていない`);
    if (!m.refs_sig || await refsSignature(r2, refs) !== m.refs_sig) throw new Error(`この下見の後に refs（${refs}）が書き換わった。紐付けが古い refs のまま。取り直しからやり直す。何も書いていない`);
  },
  extraStates: (m, B) => {
    let body;
    try { body = fs.readFileSync(path.join(B, 'state_next.json')); JSON.parse(body.toString('utf8')); } catch { throw new Error('state_next.json が無い・読めない。書かずに止める'); }
    return [{ key: STATE_KEY, body, sha_before: m.state_sha_before }];
  },
});

module.exports = { apply: applier.apply, restore: applier.restore, LOCK_KEY: APPLY_LOCK_KEY };
