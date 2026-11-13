// 法令の週次の「反映中の印」（R2 update_state/laws_apply_inprogress.json）を置く・外す。run.cjs の apply と refs が、書き始める前に置き、
// 全部の段が通ってから外す（途中で落ちたら残る）。別表・委任先の週次は、この印があれば法令の条文・refs が書きかけとみなして下見・反映をしない。
// 本番チェック（scripts/health/check_prod.cjs）も、残っていれば知らせる
//
//   node scripts/update/apply_mark.cjs set <mode>     印を置く（mode: apply / refs）
//   node scripts/update/apply_mark.cjs clear <mode>   印を外す
//
// 別表・委任先の反映が動いているときは、置いた印を戻して断る（下の DEPENDENT_LOCKS）。
// 別の mode の印が残っている（その反映が途中で落ちた）ときは、置くのも外すのも断る（例: apply が途中で落ちた後に refs を流して、
// refs の成功で apply の印を消さない）。同じ mode の流し直しは印を引き継ぎ（前の run_id を残す）、通れば外す
'use strict';
const { R2 } = require('./lib/r2.cjs');
const { log } = require('./lib/common.cjs');

const LAWS_APPLY_MARK = 'update_state/laws_apply_inprogress.json';
// 法令の条文・refs から作る週次（別表・委任先）の作業中の印。法令の反映はこれらの反映と同時には書かない。
// 相手は「自分の印を取ってから法令の印を見る」、法令は「自分の印を置いてから相手の印を見る」。どちらも先に自分の印を書いてから相手を読むので、
// 同時に始めても少なくとも片方が相手に気づいて止まる（両方止まることはあるが、両方書くことはない）
const DEPENDENT_LOCKS = ['update_state/beppyo_apply_inprogress.json', 'update_state/delegations_apply_inprogress.json'];
// これより古い相手の印は、落ちて残ったもの（相手の反映ジョブは 2 時間で打ち切られる）とみなして法令の反映を止めない（相手は自分の戻しで直す）
const DEPENDENT_STALE_MS = Number(process.env.LAWS_DEPENDENT_STALE_MS || 3 * 3600 * 1000);

async function setMark(r2, mode) {
  const cur = await r2.getJson(LAWS_APPLY_MARK);
  if (cur && cur.mode !== mode) throw new Error(`法令の週次の ${cur.mode}（run ${cur.run_id}・${cur.started_at} 開始）が途中で止まっている（${LAWS_APPLY_MARK}）。先にそれを流し直して終える。${mode} は流さない`);
  await r2.put(LAWS_APPLY_MARK, JSON.stringify({ run_id: process.env.UPDATE_RUN_ID || null, mode, started_at: new Date().toISOString(), ...(cur ? { resumed_from: cur.run_id } : {}) }));
  // 置いた後で、法令から作る週次の反映が動いていないかを見る。動いていれば、置いた印を元に戻して止まる
  for (const k of DEPENDENT_LOCKS) {
    const d = await r2.getJson(k);
    if (!d) continue;
    const age = Date.now() - Date.parse(d.started_at || 0);
    if (Number.isFinite(age) && age > DEPENDENT_STALE_MS) { log(`※ ${k} が残っている（run ${d.run_id}・${d.started_at} 開始）。古いので落ちて残ったものとみなし、法令の反映は止めない（その週次は自分の戻しで直す）`); continue; }
    if (cur) await r2.put(LAWS_APPLY_MARK, JSON.stringify(cur)); else await r2.delete(LAWS_APPLY_MARK);
    throw new Error(`法令から作る週次の反映（${k}・run ${d.run_id}・${d.started_at} 開始）が動いている。終わってから流し直す。${mode} は何も書いていない`);
  }
  log(`反映中の印を置いた: ${LAWS_APPLY_MARK}（${mode}${cur ? `・前の途中の回 ${cur.run_id} を引き継ぐ` : ''}）`);
}
async function clearMark(r2, mode) {
  const cur = await r2.getJson(LAWS_APPLY_MARK);
  if (!cur) { log('反映中の印は無い'); return; }
  if (cur.mode !== mode) throw new Error(`反映中の印は ${cur.mode}（run ${cur.run_id}）のもの。${mode} では外さない`);
  await r2.delete(LAWS_APPLY_MARK);
  log(`反映中の印を外した: ${LAWS_APPLY_MARK}（${mode}）`);
}

async function main() {
  const [cmd, mode] = process.argv.slice(2);
  if (!['apply', 'refs'].includes(mode) || !['set', 'clear'].includes(cmd)) { console.error('usage: apply_mark.cjs set|clear apply|refs'); process.exit(2); }
  const r2 = new R2();
  if (cmd === 'set') await setMark(r2, mode); else await clearMark(r2, mode);
}
if (require.main === module) main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
module.exports = { LAWS_APPLY_MARK, DEPENDENT_LOCKS, setMark, clearMark };
