// 週次更新の司令塔。GitHub Actions からも手元からもこれを呼ぶ。
//
//   node scripts/update/run.cjs prepare [--all] [--laws ID,ID] [--skip-embed] [--resume]
//       02 差分検出 → 03 XML 取得 → 04 パース → 05 R2 との差分・安全チェック → 06 埋め込み → 09 refs 抽出 → 報告
//       R2 には書かない（読むだけ）。結果は state/ に残る。
//   node scripts/update/run.cjs apply [--force]
//       07 R2 反映 → 08 Vectorize 反映 → 09 refs 反映 → 10 台帳・日付メタ → 11 検証
//       manifest.ok_to_apply が false なら --force なしでは動かない
//   node scripts/update/run.cjs check [--all]
//       prepare と同じだが埋め込みと refs 抽出を飛ばす（包括チェック用。全件比較して report.md を出す）
//   node scripts/update/run.cjs refs [--laws ID,ID] [--force]
//       refs（参照関係）だけ作り直す: 02 全件を対象に → 03 XML 取得 → 09 抽出 → 09 反映（reverse_refs も全法令から作り直す）
//       条文・ベクトル・台帳は触らない。抽出ロジックを変えたときに使う（退避は backup_updates/{run_id}/ に残る）
//       02 で台帳（本番に反映済みの版）と e-Gov の一覧が一致することを確かめ、違えば書く前に止める（先に mode=diff を流す）。
//       前の実行の state/xml・state/refs は消してから始め、manifest は見ない（09 --refs-only）
//
// 環境変数は lib/common.cjs の先頭を参照。UPDATE_DRY_RUN=1 なら apply も書かない。APPLY_SKIP=07,08 で apply の段を飛ばす。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CONFIG, log, runId } = require('./lib/common.cjs');

const here = __dirname;
function step(label, cmd, args, { allowFail = false } = {}) {
  log(`\n===== ${label} =====`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: CONFIG.repoRoot, env: { ...process.env, UPDATE_RUN_ID: process.env.UPDATE_RUN_ID } });
  if (r.status !== 0 && !allowFail) { console.error(`${label} が失敗（exit ${r.status}）`); process.exit(r.status || 1); }
  return r.status;
}
const node = (f, ...a) => ['node', [path.join(here, f), ...a]];
const py = (f, ...a) => [process.env.PYTHON || 'python3', [path.join(here, f), ...a]];

function main() {
  const [mode, ...args] = process.argv.slice(2);
  process.env.UPDATE_RUN_ID = process.env.UPDATE_RUN_ID || runId();
  log(`run_id=${process.env.UPDATE_RUN_ID} state=${CONFIG.stateDir} prefix=${CONFIG.articlesPrefix} dryRun=${CONFIG.dryRun}`);
  const has = (f) => args.includes(f);
  const val = (f) => (has(f) ? args[args.indexOf(f) + 1] : null);
  const lawsArgs = val('--laws') ? ['--laws', val('--laws')] : [];
  const allArgs = has('--all') ? ['--all'] : [];

  if (mode === 'prepare' || mode === 'check') {
    step('02 差分検出', ...node('02_detect_changes.cjs', ...allArgs, ...lawsArgs));
    step('03 XML 取得', ...node('03_fetch_changed_laws.cjs', ...(has('--resume') ? ['--resume'] : [])));
    step('04 パース', ...py('04_parse_split.py'));
    if (mode === 'prepare' && !has('--skip-embed')) step('04b 埋め込みのずれ検査', ...node('check_embed_drift.cjs'), { allowFail: true });   // 結果は 05 が blockers に入れる
    step('05 R2 との差分', ...node('05_diff.cjs'));
    if (mode === 'prepare' && !has('--skip-embed')) step('06 埋め込み', ...node('06_embed.cjs', ...(has('--resume') ? ['--resume'] : [])));
    if (mode === 'prepare') step('09 refs 抽出', ...node('09_refs.cjs', 'extract'));
    step('報告', ...node('10_finalize.cjs', '--report-only'));
    return;
  }
  if (mode === 'apply') {
    const force = has('--force') ? ['--force'] : [];
    // APPLY_SKIP=07,08 のように段を飛ばせる（すでに書き終えた段を繰り返さないため。全件再構築の流し直し用）
    const skip = new Set(String(process.env.APPLY_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean));
    const run = (num, label, cmd) => { if (skip.has(num)) log(`\n===== ${label} =====\n（APPLY_SKIP で飛ばす）`); else step(label, ...cmd); };
    // 書き始める前に反映中の印を置き、全部の段が通ってから外す（途中で落ちたら残る。別表・委任先の週次はこれを見て止まる）
    step('反映中の印を置く', ...node('apply_mark.cjs', 'set', 'apply'));
    run('07', '07 R2 反映', node('07_apply_r2.cjs', ...force));
    run('08', '08 Vectorize 反映', node('08_apply_vectorize.cjs', ...force));
    run('09', '09 refs 反映', node('09_refs.cjs', 'patch', ...force));
    run('10', '10 台帳・日付メタ', node('10_finalize.cjs'));
    run('11', '11 検証', node('11_verify.cjs'));
    step('反映中の印を外す', ...node('apply_mark.cjs', 'clear', 'apply'));
    return;
  }
  if (mode === 'refs') {
    // 前の実行の XML・refs を今回の対象に混ぜない。manifest は 09 --refs-only が見ない
    for (const d of ['xml', 'refs']) fs.rmSync(path.join(CONFIG.stateDir, d), { recursive: true, force: true });
    const force = has('--force') ? ['--force'] : [];
    step('02 対象の法令（全件・台帳と e-Gov の一覧が一致することを確認）', ...node('02_detect_changes.cjs', ...(lawsArgs.length ? lawsArgs : ['--all']), '--require-clean', ...force));
    step('03 XML 取得', ...node('03_fetch_changed_laws.cjs', ...(has('--resume') ? ['--resume'] : [])));
    step('09 refs 抽出', ...node('09_refs.cjs', 'extract', '--refs-only'));
    step('反映中の印を置く', ...node('apply_mark.cjs', 'set', 'refs'));
    step('09 refs 反映（reverse_refs も作り直す）', ...node('09_refs.cjs', 'patch', '--refs-only', '--rebuild-reverse'));
    step('反映中の印を外す', ...node('apply_mark.cjs', 'clear', 'refs'));
    return;
  }
  console.error('usage: run.cjs prepare|check|apply|refs [...]');
  process.exit(1);
}
main();
