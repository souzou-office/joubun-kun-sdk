// Phase 1 Step B: 最新の法令一覧を取得し、台帳（前回の改正 ID）と突き合わせて変更を検出する。
//
//   node scripts/update/02_detect_changes.cjs [--all] [--laws ID,ID,...]
//
// 台帳の読み順: R2 の update_state/sync_state.json（apply が成功したときだけ更新される）
//              → 無ければ scripts/update/state/sync_state.json（5 月の再構築時の基準台帳）
//
// 出力（scripts/update/state/）:
//   sync_state.next.json  今回取得した一覧（apply 成功後に 10_finalize が台帳へ昇格させる。ここでは台帳を書き換えない）
//   change_report.json    { detected_at, previous_fetched_at, summary, added[], modified[], removed[] }
//   --all のときは全法令を modified 扱いにする（全件再構築・包括チェック用）
//   --require-clean のときは、台帳（本番に反映済みの改正 ID）と e-Gov の一覧に差があれば止める（exit 2）。
//     refs だけ作り直す run.cjs refs 用: 取ってくる XML が本番の条文と同じ版であることの確認。--force なら警告して続ける
const fs = require('fs');
const { CONFIG, statePath, readJson, writeJson, log, ensureDir } = require('./lib/common.cjs');
const { fetchAllLaws } = require('./lib/egov_api.cjs');
const { R2 } = require('./lib/r2.cjs');

async function loadLedger() {
  try {
    const r2 = new R2();
    const led = await r2.getJson(CONFIG.ledgerKey);
    if (led && led.laws) { log(`台帳: R2 ${CONFIG.ledgerKey}（${Object.keys(led.laws).length} 件, fetched_at=${led.fetched_at}）`); return led; }
  } catch (e) { log(`台帳: R2 から読めない（${e.message}）。ローカルの台帳を使う`); }
  const local = statePath('sync_state.json');
  if (fs.existsSync(local)) {
    // リポジトリの sync_state.json は Git LFS 管理。LFS を取っていない木ではポインタの文字列なので JSON にならない
    const led = readJson(local, null);
    if (led && led.laws) { log(`台帳: ローカル ${local}（${Object.keys(led.laws).length} 件, fetched_at=${led.fetched_at}）`); return led; }
    log(`台帳: ローカル ${local} は読めない（LFS 未取得か壊れている）`);
  }
  return null;
}

function diff(prev, curr) {
  const added = [], modified = [], removed = [];
  let unchanged = 0;
  const prevLaws = (prev && prev.laws) || {}, currLaws = curr.laws || {};
  for (const [lawId, c] of Object.entries(currLaws)) {
    const p = prevLaws[lawId];
    if (!p) added.push(lawId);
    else if (p.law_revision_id !== c.law_revision_id) {
      modified.push({ law_id: lawId, law_title: c.law_title, old_revision_id: p.law_revision_id, new_revision_id: c.law_revision_id,
        old_amendment_date: p.amendment_promulgate_date, new_amendment_date: c.amendment_promulgate_date, enforcement_date: c.amendment_enforcement_date || null });
    } else unchanged++;
  }
  for (const lawId of Object.keys(prevLaws)) if (!currLaws[lawId]) removed.push(lawId);
  return { added, modified, removed, unchanged };
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const lawsArg = args.includes('--laws') ? args[args.indexOf('--laws') + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
  ensureDir(CONFIG.stateDir);

  const prev = await loadLedger();
  if (!prev && !all && !lawsArg) { console.error('台帳がありません。初回は --all（全件）か --laws（法令指定）で対象を決めてください'); process.exit(1); }

  log('e-Gov から最新の法令一覧を取得');
  const curr = await fetchAllLaws({ onPage: (p, off, total) => { if (p % 10 === 0) log(`  page ${p} offset=${off} / ${total}`); } });
  log(`  ${Object.keys(curr.laws).length} 件`);
  writeJson(statePath('sync_state.next.json'), curr, true);

  if (args.includes('--require-clean')) {
    const d = prev ? diff(prev, curr) : null;
    const n = d ? d.added.length + d.modified.length + d.removed.length : null;
    if (!prev || n) {
      const why = !prev ? '台帳が無い' : `台帳と e-Gov の一覧が ${n} 件違う（added=${d.added.length} modified=${d.modified.length} removed=${d.removed.length}）`;
      if (d) writeJson(statePath('change_report.pending.json'), { detected_at: curr.fetched_at, previous_fetched_at: prev.fetched_at, mode: 'require-clean', summary: { added: d.added.length, modified: d.modified.length, removed: d.removed.length, unchanged: d.unchanged }, added: d.added, modified: d.modified, removed: d.removed }, true);
      if (!args.includes('--force')) {
        console.error(`${why}。取ってくる XML が本番の条文と同じ版である保証が無いので止める。先に週次更新（mode=diff）を流して条文を最新にしてから refs を作り直す（--force で続けられるが、位置情報がずれる）`);
        process.exit(2);
      }
      log(`警告: ${why}（--force で続ける）`);
    } else {
      log('台帳と e-Gov の一覧は一致（本番の条文と同じ版の XML が取れる）');
    }
  }

  let result;
  if (all || lawsArg) {
    const ids = lawsArg || Object.keys(curr.laws);
    result = { added: [], modified: ids.filter((id) => curr.laws[id]).map((id) => ({ law_id: id, law_title: curr.laws[id].law_title, old_revision_id: prev && prev.laws[id] ? prev.laws[id].law_revision_id : null, new_revision_id: curr.laws[id].law_revision_id })), removed: [], unchanged: 0 };
    const unknown = (lawsArg || []).filter((id) => !curr.laws[id]);
    if (unknown.length) log(`  一覧に無い法令 ID（無視）: ${unknown.join(', ')}`);
  } else {
    result = diff(prev, curr);
  }
  const report = {
    detected_at: curr.fetched_at,
    previous_fetched_at: prev ? prev.fetched_at : null,
    mode: all ? 'all' : (lawsArg ? 'laws' : 'diff'),
    summary: { added: result.added.length, modified: result.modified.length, removed: result.removed.length, unchanged: result.unchanged },
    added: result.added,
    modified: result.modified,
    removed: result.removed,
  };
  writeJson(statePath('change_report.json'), report, true);
  log(`変更: added=${report.summary.added} modified=${report.summary.modified} removed=${report.summary.removed} unchanged=${report.summary.unchanged}`);
  log(`→ ${statePath('change_report.json')}`);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
