// 委任先（DELEGATIONS_PREFIX）の週次更新（docs/tsutatsu_hanrei_weekly.md の「委任先」）。
//
//   node scripts/delegation/weekly/run.cjs build              変わった法令の周りだけ紐付けをやり直して本番と比べる（反映の下見。書かない。build.cjs）
//   node scripts/delegation/weekly/run.cjs apply              下見を退避付きで本番に書く（Actions からだけ。apply.cjs）
//   node scripts/delegation/weekly/run.cjs restore <run_id>   その回の反映を戻す（apply.cjs）
//
// 取り直しは無い（材料は法令の週次が書いた R2 の条文と refs）。法令の週次（日曜 05:00 JST）の後に流す。
//
// 環境変数:
//   DELEG_WEEKLY_OUT  成果物と作業フォルダ（条文・逆引き）の置き場（既定 scripts/delegation/weekly/state/）
//   DELEG_ARTICLES_PREFIX / DELEG_REFS_PREFIX / DELEG_PREFIX  本番のプレフィックスの差し替え（確かめ用。既定は wrangler.toml）
//   DELEG_FULL=1  全法令をやり直す（初回と同じ）。DELEG_MAX_CHANGED / DELEG_ERR_MIN / DELEG_CONCURRENCY
//   UPDATE_RUN_ID     回の印（Actions では run_id-attempt）
//   R2_FAKE_DIR・VECTORIZE_FAKE_FILE  ¥0 で確かめる（scripts/delegation/weekly/check_weekly.cjs）
'use strict';
const path = require('path');

const OUT = path.resolve(process.env.DELEG_WEEKLY_OUT || path.join(__dirname, 'state'));
function runId() { return process.env.UPDATE_RUN_ID || `local-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`; }

async function main() {
  const cmd = process.argv[2];
  const fn = {
    build: () => require('./build.cjs').build({ out: OUT, rid: runId() }),
    apply: () => require('./apply.cjs').apply(),
    restore: () => require('./apply.cjs').restore(process.argv[3]),
  }[cmd];
  if (!fn) { console.error('usage: node scripts/delegation/weekly/run.cjs build | apply | restore <run_id>'); process.exit(2); }
  const r = await fn();
  process.exit(r && r.blockers && r.blockers.length ? 3 : 0);   // 止めた理由がある下見は 3（ワークフローが Issue を立てる。update_cases と同じ）
}
main().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
