// 質疑応答事例・裁決の週次更新: 下見（build/）を退避付きで本番に書く・戻す。
//
//   node scripts/cases/weekly/run.cjs apply              CASES_WEEKLY_OUT/build/ の成果物を反映する
//   node scripts/cases/weekly/run.cjs restore <run_id>   その回の反映を戻す（退避は R2 update_state/cases_backup/<run_id>/）
//
// 反映・戻しの本体は scripts/update/lib/delta_apply.cjs（通達と共用）。ここは事例・裁決に固有の決まりだけ:
//   - 書いてよいのは shitsugi_v1/（index.json・cases_*.json・img/ の画像）・saiketsu_v1/（index.json・cases_*.json）・article_links_v1/（法令ごと・_cases.json）
//   - 一覧（shitsugi_v1/index.json・saiketsu_v1/index.json・article_links_v1 の法令ごとのファイル）は最後に書き、戻すときは最初に戻す
//     （新しい事例のチャンク・_cases.json が先に在るように）
//   - 下見より新しい取り直し（update_state/cases/{shitsugi,saiketsu}/current.json の世代）があれば書かない
//
// 見直す対象がある回（初回を含む）は、オーナーの Issue への「反映」コメントからだけ（ワークフローが CASES_APPROVED=1 を渡す）。
// 書く経路は Actions の Update cases data だけ。R2_FAKE_DIR と VECTORIZE_FAKE_FILE が両方あるときは確かめ用に動く。
'use strict';
const path = require('path');
const crypto = require('crypto');
const { makeApplier, genKeyOf } = require('../../update/lib/delta_apply.cjs');
const { prodPrefix: tsuProdPrefix, APPLY_LOCK_KEY: TSU_LOCK_KEY } = require('../../tsutatsu/weekly/build.cjs');
const { VEC_STATE_KEY, APPLY_LOCK_KEY, META_LIMIT, VEC_INDEX, SH, SA, AL } = require('./build.cjs');

const OUT = () => path.resolve(process.env.CASES_WEEKLY_OUT || path.join(__dirname, 'state'));

const applier = makeApplier({
  label: 'Update cases data',
  envPrefix: 'CASES',
  dir: () => path.join(OUT(), 'build'),
  lockKey: APPLY_LOCK_KEY,
  backupPrefix: 'update_state/cases_backup',
  mutKey: 'update_state/cases/vec_mutation.json',
  markId: 'cases-weekly-mark',
  vecIndex: VEC_INDEX,
  idRe: /^[0-9a-f]{32}$/,   // 06_embed と同じ md5
  metaLimit: META_LIMIT,
  vecStateKey: VEC_STATE_KEY,
  prodPrefix: null,          // 事例・裁決・条文リンクに版は無い（今の場所に退避付きで上書き）
  keyLabel: '事例・裁決・条文リンクのファイル',
  allowedKey: (k) => new RegExp(`^${SH}/(index\\.json|cases_[a-z]+\\.json|img/(law/shitsugi|taxes/sake/qa)/[\\w/.-]+\\.(gif|png|jpe?g))$`).test(k)
    || new RegExp(`^${SA}/(index\\.json|cases_\\d+\\.json)$`).test(k)
    || new RegExp(`^${AL}/(_cases|[0-9A-Za-z_]+)\\.json$`).test(k),
  checkFile: (k, o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`成果物の形が違う: ${k}。書かずに止める`);
  },
  isIndexKey: (k) => k === `${SH}/index.json` || k === `${SA}/index.json` || (k.startsWith(`${AL}/`) && k !== `${AL}/_cases.json`),
  freshCheck: async (r2, m) => {
    for (const [name, gen] of Object.entries(m.baseline_gens || {})) {
      const cur = await r2.getJson(`update_state/cases/${name}/current.json`);
      if (!cur || cur.gen !== gen) throw new Error(`この下見（${name} の写し ${gen}）の後に新しい取り直しがある（今の基準 ${cur ? cur.gen : 'なし'}）。古い下見は反映しない。新しい回の Issue か自動の反映を使う。何も書いていない`);
    }
    // 条文リンクの元にした通達が、下見の後に変わっていないか（通達の版・反映・戻し）
    const dep = (m.deps || {}).tsutatsu;
    if (!dep) throw new Error('下見に通達の世代が残っていない（古い形の下見）。取り直しからやり直す。何も書いていない');
    if (tsuProdPrefix() !== dep.prefix) throw new Error(`下見の後に通達の版が変わった（${dep.prefix} → ${tsuProdPrefix()}）。条文リンクが古い通達のまま。取り直しからやり直す。何も書いていない`);
    const tlock = await r2.getJson(TSU_LOCK_KEY);
    if (tlock) throw new Error(`通達の反映か戻し（run ${tlock.run_id}）が動いているか途中で止まっている。終わってから取り直す。何も書いていない`);
    const g = await r2.get(genKeyOf(TSU_LOCK_KEY));
    const gs = g == null ? null : crypto.createHash('sha256').update(g).digest('hex');
    if (gs !== dep.gen_sha) throw new Error('下見の後に通達の反映か戻しが入った。条文リンクが古い通達のまま。取り直しからやり直す。何も書いていない');
  },
});

// 書いている間に通達の反映・戻しが入ったかを書いた後にも確かめる（通達側の書き込みは止められないので、入っていたら知らせる。
// 条文リンクは翌週の下見で今の通達から作り直されるので、それまで条文ページの事例・裁決の並びが 1 週古いだけで、壊れはしない）
async function apply() {
  const r = await applier.apply();
  if (r && r.run_id) {
    const fs = require('fs');
    const { R2 } = require('../../update/lib/r2.cjs');
    const m = JSON.parse(fs.readFileSync(path.join(OUT(), 'build', 'manifest.json'), 'utf8'));
    const g = await new R2().get(genKeyOf(TSU_LOCK_KEY));
    const gs = g == null ? null : crypto.createHash('sha256').update(g).digest('hex');
    if (gs !== m.deps.tsutatsu.gen_sha) console.log('※ 反映している間に通達の反映か戻しが入った。条文リンクは翌週の下見で今の通達から作り直される（それまでは 1 週古い）');
  }
  return r;
}

module.exports = { apply, restore: applier.restore, LOCK_KEY: APPLY_LOCK_KEY };
