// 租税条約（treaty/v1・_treaty）の週次更新（docs/tsutatsu_hanrei_weekly.md の「租税条約」）。
//
//   node scripts/treaty/weekly/run.cjs build              財務省の一覧と PDF を取り直し、変わった国だけ解析して本番と比べる（反映の下見。書かない。build.cjs・crawl.py）
//   node scripts/treaty/weekly/run.cjs apply              下見を退避付きで本番に書く（Actions からだけ。apply.cjs）
//   node scripts/treaty/weekly/run.cjs restore <run_id>   その回の反映を戻す（apply.cjs）
//
// 環境変数:
//   TREATY_WEEKLY_OUT  成果物と作業フォルダ（PDF）の置き場（既定 scripts/treaty/weekly/state/）
//   PYTHON             crawl.py を流す Python（既定 python3。beautifulsoup4・pymupdf が要る）
//   TREATY_LIST_URL・TREATY_SLEEP_MS  財務省の一覧の URL・PDF を取る間（確かめ用）
//   UPDATE_RUN_ID     回の印（Actions では run_id-attempt）
//   R2_FAKE_DIR・VECTORIZE_FAKE_FILE・AI_FAKE=1  ¥0 で確かめる（scripts/treaty/weekly/check_weekly.cjs）
'use strict';
const path = require('path');

const OUT = path.resolve(process.env.TREATY_WEEKLY_OUT || path.join(__dirname, 'state'));
function runId() { return process.env.UPDATE_RUN_ID || `local-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`; }

async function main() {
  const cmd = process.argv[2];
  const fn = {
    build: () => require('./build.cjs').build({ out: OUT, rid: runId() }),
    apply: () => require('./apply.cjs').apply(),
    restore: () => require('./apply.cjs').restore(process.argv[3]),
  }[cmd];
  if (!fn) { console.error('usage: node scripts/treaty/weekly/run.cjs build | apply | restore <run_id>'); process.exit(2); }
  const r = await fn();
  process.exit(r && r.blockers && r.blockers.length ? 3 : 0);   // 止めた理由がある下見は 3（ワークフローが Issue を立てる）
}
main().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
