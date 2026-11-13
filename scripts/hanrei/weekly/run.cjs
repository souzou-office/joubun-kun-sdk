// 判例（hanrei_v1）の週次更新。docs/tsutatsu_hanrei_weekly.md の「段 1」。
//
//   node scripts/hanrei/weekly/run.cjs prepare   取得 → 差分 → パース → 審級の突合 → 埋め込み → 書く中身と報告を作る（R2・Vectorize に書かない）
//   node scripts/hanrei/weekly/run.cjs apply     prepare の成果物を反映する（退避してから R2 を上書き・Vectorize に upsert・既知の id を更新）
//   node scripts/hanrei/weekly/run.cjs restore <run_id>   apply を戻す（退避した R2 のファイルを書き戻し、足したベクトルを消して、上書きしたベクトルを戻す）
//
// やること（新しい判例を「足す」だけ。既存の判例の中身は、審級の上告審（appeals）を足す以外は変えない）:
//   1. 裁判所の一覧を直近 2 年分（今年と去年・6 コレクション）取る。掲載は裁判年月日から数か月遅れて出るため
//   2. 新しい id = 一覧の id − 既知の id（R2 update_state/hanrei_state.json。無ければ初回として R2 の cases から作る）
//   3. 新しい id だけ詳細ページと PDF を取り（01）、本文を抜き（02）、パースする（03）
//   4. 原審の引き当ては R2 の lookup/caseno と cases で行う（手元に全件を持たない。04 と同じ 3 点一致）
//   5. 06 と同じ文面・metadata で埋め込む（Workers AI の bge-m3。AI_POOLING は法令と同じ）
//   6. 上書きするファイル: cases_{NNNN}・lookup/caseno_*・lookup/date_*・links/{law_id}・court_names・index（07 と同じ形）
//      links は今の上位 300 件に新しい判例を混ぜて並べ直し、300 件で切る（全件から作り直すのと同じ結果）
//
// 環境変数:
//   HANREI_STATE_DIR   成果物の置き場（既定 scripts/hanrei/weekly/state。Actions では artifact にする）
//   HANREI_PYTHON      02 を流す python（既定 python3。pdfplumber が要る）
//   HANREI_MAX_NEW     1 週の新しい判例の上限（既定 500。超えたら止める）
//   HANREI_YEARS       一覧を見る年数（既定 2 = 今年と去年）
//   HANREI_TODAY       今日の日付（テスト用。YYYY-MM-DD）
//   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN、R2_FAKE_DIR・VECTORIZE_FAKE_FILE・AI_FAKE=1（scripts/update/lib と同じ）
//
// ログには件数・id・裁判所名・日付だけを出す（利用者の入力は扱わない）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { R2 } = require('../../update/lib/r2.cjs');
const { Vectorize } = require('../../update/lib/vectorize.cjs');
const { Embedder } = require('../../update/lib/ai.cjs');
const { courtKey, warekiToIso } = require('../lib_common.cjs');
const { eraYearTag, courtRank, isValidArtKey, artCompare } = require('../07_build_upload_r2.cjs');
const { caseToTargets } = require('../06_embed.cjs');
const CR = require('../../lineage/lib/currefs.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const STATE_DIR = path.resolve(process.env.HANREI_STATE_DIR || path.join(__dirname, 'state'));
const WORK_DIR = path.join(STATE_DIR, 'work');   // 01/02/03 の作業フォルダ（HANREI_DATA_ROOT）
const PREFIX = 'hanrei_v1';
// 条の系譜で今の条に付け直した逆引き（docs/lineage.md）。hanrei_v2/index.json がある（全件の作り直しを R2 に書いた）ときだけ、
// 新しい判例を付け直しの表（lineage_v1/tables/。月に 1 回作り直す）で引いて hanrei_v2 にも足す。hanrei_v1 は今までどおり書き続ける（戻せるように）
const V2 = 'hanrei_v2';
const TABLES = 'lineage_v1/tables';
const POLICY = 'lineage_v1/policy';   // 載せる条件の材料（旧法の受け皿の判定・判例ごとの Opus の判断。scripts/lineage/relink_hanrei.cjs build が置く）
const STATE_KEY = 'update_state/hanrei_state.json';
// 作業中の印（{ run_id, kind: 'apply' | 'restore' }）。apply・restore とも書き始める前に置き、全部終えたら消す。
// 残っていれば前回の反映か戻しが途中で落ちているので、prepare も apply も止まる（書きかけ・戻しかけを前提に次を進めない）。
// 同じ run の restore はやり直せる（印を引き継ぐ）
const LOCK_KEY = 'update_state/hanrei_apply_inprogress.json';
const BACKUP_PREFIX = 'update_state/hanrei_backup';
const VEC_INDEX = 'tsutatsu-embeddings-v1';
const VEC_NS = '_hanrei';
const LM = require('../../lineage/lib/links_more.cjs');
const LINKS_TOP = LM.LINKS_TOP;   // 07 と同じ
const MAX_NEW = Number(process.env.HANREI_MAX_NEW || 500);
const YEARS = Math.max(1, Number(process.env.HANREI_YEARS || 2));
const MAX_FAIL_RATIO = 0.1;
const EMBED_MIN_COS = 0.98;
const DIM = 1024;   // bge-m3

const log = (...a) => console.log(...a);
const sha = (buf) => (buf == null ? null : crypto.createHash('sha256').update(buf).digest('hex'));
const readJson = (p, fb) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fb);
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
const byNum = (a, b) => parseInt(a, 10) - parseInt(b, 10);
const runId = () => process.env.UPDATE_RUN_ID || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const chunkKey = (id) => `${PREFIX}/cases_${String(Math.floor(parseInt(id, 10) / 100)).padStart(4, '0')}.json`;

// ---------------------------------------------------------------- R2 の読み（prepare 中はキャッシュ。apply で「読んだ時と同じか」を確かめるため hash を残す）
function makeReader(r2) {
  const cache = new Map();   // key → { buf, json }
  return {
    async json(key) {
      if (!cache.has(key)) {
        const buf = await r2.get(key);
        cache.set(key, { buf, json: buf ? JSON.parse(buf.toString('utf8')) : null });
      }
      const e = cache.get(key);
      return e.json == null ? null : JSON.parse(JSON.stringify(e.json));   // 呼び出し側が書き換えても元を汚さない
    },
    hashOf(key) { return cache.has(key) ? sha(cache.get(key).buf) : undefined; },
  };
}

// ---------------------------------------------------------------- 既知の id
async function loadKnown(r2, report) {
  const buf = await r2.get(STATE_KEY);
  const st = buf ? JSON.parse(buf.toString('utf8')) : null;
  const stateSha = sha(buf);   // apply で「prepare の後に台帳が変わっていないか」を確かめる（無ければ null）
  if (st && Array.isArray(st.ids) && st.ids.length) return { state: st, first: false, stateSha };
  // 初回: R2 の cases_*.json の id から作る（読むだけ）。最初の反映はオーナーの確認を通す（needs_review）
  log('既知の id の台帳が無いので、R2 の cases から作る（初回）');
  const keys = (await r2.list(`${PREFIX}/cases_`)).map((o) => o.key).filter((k) => /cases_\d{4}\.json$/.test(k));
  const ids = [];
  await R2.pmap(keys, 8, async (k) => { const j = await r2.getJson(k); if (j) ids.push(...Object.keys(j)); });
  ids.sort(byNum);
  report.review.push(`初回: 既知の id の台帳（${STATE_KEY}）が無かったので、R2 の cases ${keys.length} ファイルから ${ids.length} 件を読んで作った。反映すると台帳も書く`);
  return { state: { ids, slices: {} }, first: true, stateSha };
}

// ---------------------------------------------------------------- 01/02/03 を作業フォルダで流す
function runNode(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, HANREI_DATA_ROOT: WORK_DIR, ...extraEnv } });
  if (r.status !== 0) throw new Error(`失敗: node ${args.join(' ')}（終了コード ${r.status}）`);
}
function runPython(args) {
  const py = process.env.HANREI_PYTHON || 'python3';
  const r = spawnSync(py, args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, HANREI_DATA_ROOT: WORK_DIR } });
  if (r.status !== 0) throw new Error(`失敗: ${py} ${args.join(' ')}（終了コード ${r.status}）`);
}
// NDJSON を読む。無いファイルは空（一覧が 0 件・全部取れなかった回。取得の失敗は台帳の status で別に止める）。
// 読めない行があれば、ファイル名と行番号を付けて止める（黙って飛ばすと取りこぼしが「更新なし」に見える）
function readNdjson(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    try { out.push(JSON.parse(l)); } catch { throw new Error(`${path.basename(p)} の ${i + 1} 行目が JSON として読めない（取得かパースの不具合）。止める`); }
  });
  return out;
}

function reiwaWindow() {
  const today = process.env.HANREI_TODAY ? new Date(`${process.env.HANREI_TODAY}T00:00:00+09:00`) : new Date(Date.now() + 9 * 3600 * 1000);
  const y = today.getUTCFullYear() - 2018;   // 令和
  return { from: Math.max(1, y - (YEARS - 1)), to: y };
}

// ---------------------------------------------------------------- 原審の引き当て（04 と同じ 3 点一致: 裁判所＋事件番号＋裁判年月日）
async function matchGensin(newCases, rd) {
  const byId = new Map(newCases.map((c) => [c.id, c]));
  // 新しい判例どうしの事件番号索引（04 の casenoIndex と同じ鍵）
  const localCaseno = new Map();
  for (const c of newCases) {
    if (!c.court || !c.caseNo) continue;
    const k = `${courtKey(c.court, c.branch)}|${c.caseNo}`;
    if (!localCaseno.has(k)) localCaseno.set(k, []);
    localCaseno.get(k).push(c.id);
  }
  const dateOf = async (id) => {
    if (byId.has(id)) return byId.get(id).dateIso;
    const ck = await rd.json(chunkKey(id));
    return ck && ck[id] ? ck[id].dateIso : undefined;
  };
  const matches = [];   // { child, parent }
  let ambiguous = 0;
  for (const c of newCases) {
    const g = c.gensin;
    if (!g || !(g.court || g.caseNo || g.dateJp || g.kekka)) continue;
    let matchedId = null;
    if (g.court && g.caseNo) {
      const key = `${courtKey(g.court)}|${g.caseNo}`;
      const tag = eraYearTag(g.caseNo) || 'other';
      const lk = await rd.json(`${PREFIX}/lookup/caseno_${tag}.json`);
      const cands = [...new Set([...((lk && lk[key]) || []), ...(localCaseno.get(key) || [])])].filter((x) => x !== c.id);
      if (cands.length) {
        if (g.dateJp) {
          const iso = warekiToIso(g.dateJp);
          const f = [];
          for (const x of cands) if ((await dateOf(x)) === iso) f.push(x);
          if (f.length === 1) matchedId = f[0];
          else if (f.length > 1) ambiguous++;
        } else ambiguous++;
      }
    }
    c.gensin = Object.assign(c.gensin, { matchedId });   // 07 と同じ（gensin があれば matchedId を必ず持つ）
    if (matchedId) matches.push({ child: c, parent: matchedId });
  }
  return { matches, ambiguous };
}

// ---------------------------------------------------------------- prepare
async function prepare() {
  const rid = runId();
  const report = { blockers: [], review: [], notes: [] };
  // 前回の成果物を消してから始める。HANREI_STATE_DIR の指定違いで別のフォルダを消さないよう、
  // 空か、前回の成果物（manifest.json か work/）があるフォルダだけ消す
  if (fs.existsSync(STATE_DIR)) {
    const names = fs.readdirSync(STATE_DIR);
    const looksLikeState = !names.length || names.includes('manifest.json') || names.includes('work');
    const rel = path.relative(STATE_DIR, REPO_ROOT);   // リポジトリが STATE_DIR の中（か同じ）なら '' か '..' で始まらない相対パスになる
    const containsRepo = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (!looksLikeState || containsRepo) {
      throw new Error(`HANREI_STATE_DIR（${STATE_DIR}）は週次の成果物の置き場に見えないので消さない。空のフォルダか既定の置き場を指定する`);
    }
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(WORK_DIR, 'state'), { recursive: true });
  const r2 = new R2();
  const rd = makeReader(r2);

  const lock = await r2.getJson(LOCK_KEY);
  if (lock) {
    const how = lock.kind === 'apply' && lock.phase === 'backup' ? '本番を書く前（退避の途中）で止まっている。本番は変わっていない。Actions の mode=restore・restore_run_id=' + lock.run_id + ' で印だけ外してから'
      : `途中で止まっている。Actions の mode=restore・restore_run_id=${lock.run_id} で${lock.kind === 'restore' ? '戻しをやり直して' : '戻して'}から`;
    report.blockers.push(`前回の${lock.kind === 'restore' ? '戻し' : '反映'}（run ${lock.run_id}、${lock.started_at} 開始）が${how}、prepare をやり直す（${LOCK_KEY} が残っている）`);
    const manifest = { run_id: rid, created_at: new Date().toISOString(), window: reiwaWindow(), first_run: false, known_count: 0, state_sha_before: null, new_ids: [], added_ids: [], failed_ids: [], files: {}, vector_count: 0, slice_counts: {},
      blockers: report.blockers, review: [], notes: [], ok_to_apply: false, needs_review: false, nothing_to_do: false };
    writeJson(path.join(STATE_DIR, 'manifest.json'), manifest);
    fs.writeFileSync(path.join(STATE_DIR, 'report.md'), renderReport(manifest));
    log(`prepare: ${report.blockers[0]}`);
    return manifest;
  }

  const { state: known, first, stateSha } = await loadKnown(r2, report);
  const knownSet = new Set(known.ids);
  log(`既知の判例: ${knownSet.size} 件`);

  // 1. 一覧（直近 YEARS 年）
  const win = reiwaWindow();
  log(`一覧: 令和${win.from}年〜令和${win.to}年（6 コレクション）`);
  runNode(['scripts/hanrei/01_crawl.cjs', '--mode', 'list', '--from-gengo', '令和', '--from-year', String(win.from), '--to-gengo', '令和', '--to-year', String(win.to)]);
  const invFile = path.join(WORK_DIR, 'state', 'inventory.ndjson');
  const inv = readNdjson(invFile);
  const ledger = readJson(path.join(WORK_DIR, 'state', 'crawl_ledger.json'), {});
  const listErrors = Object.entries(ledger).filter(([u, e]) => /\/hanrei\/search\d\//.test(u) && e.status !== 'ok');
  if (listErrors.length) report.blockers.push(`一覧ページが ${listErrors.length} 件取れなかった（件数が読めない・通信エラー）。取りこぼしの疑いがあるので止める`);
  // コレクション×年ごとの件数（月に細分したスライスは年にまとめる）。前回より減ったら見直す
  // 見る範囲のコレクション×年は 0 件でも数える（0 件に落ちたのを「減った」として拾うため）。範囲から外れた年は比べない
  const slices = {};
  for (const coll of ['saikosai', 'kosai', 'sokuho', 'gyosei', 'rodo', 'chizai']) for (let y = win.from; y <= win.to; y++) slices[`${coll}_R${String(y).padStart(2, '0')}`] = new Set();
  for (const r of inv) { const k = String(r.sliceKey || '').replace(/M\d{2}$/, ''); slices[k] = (slices[k] || new Set()).add(r.id); }
  const sliceCounts = Object.fromEntries(Object.entries(slices).map(([k, s]) => [k, s.size]));
  for (const [k, n] of Object.entries(known.slices || {})) {
    if (sliceCounts[k] !== undefined && sliceCounts[k] < n) report.review.push(`一覧の件数が前回より減った: ${k} ${n} → ${sliceCounts[k]}（裁判所が掲載を取り下げたか、一覧の読み取りの不具合）`);
  }

  // 2. 新しい id
  const invIds = [...new Set(inv.map((r) => String(r.id)))];
  const newIds = invIds.filter((id) => !knownSet.has(id)).sort(byNum);
  log(`一覧の判例 ${invIds.length} 件 / 新しい判例 ${newIds.length} 件`);
  if (newIds.length > MAX_NEW) report.blockers.push(`新しい判例が ${newIds.length} 件（上限 ${MAX_NEW}）。一覧の読み取りが壊れて全部が新しく見えている疑い`);

  const manifest = { run_id: rid, created_at: new Date().toISOString(), window: win, first_run: first, known_count: knownSet.size, state_sha_before: stateSha, new_ids: newIds, added_ids: [], failed_ids: [], files: {}, vector_count: 0, slice_counts: sliceCounts };
  const finish = () => {
    manifest.blockers = report.blockers; manifest.review = report.review; manifest.notes = report.notes;
    manifest.ok_to_apply = report.blockers.length === 0;
    manifest.needs_review = report.review.length > 0;
    // 何もしない回 = 足すものが無く、止めた理由も見直す対象も無い（止めた回・要確認の回は必ず Issue にする）
    manifest.nothing_to_do = manifest.added_ids.length === 0 && !first && !report.blockers.length && !report.review.length;
    writeJson(path.join(STATE_DIR, 'manifest.json'), manifest);
    fs.writeFileSync(path.join(STATE_DIR, 'report.md'), renderReport(manifest));
    log(`\nprepare 完了: 足す判例 ${manifest.added_ids.length} 件 / 取れなかった ${manifest.failed_ids.length} 件 / 書くファイル ${Object.keys(manifest.files).length} / ベクトル ${manifest.vector_count}`);
    log(`blockers: ${report.blockers.length} / 見直す対象: ${report.review.length}`);
    return manifest;
  };
  if (report.blockers.length || !newIds.length) {
    if (!newIds.length) report.notes.push('新しい判例は無かった');
    // 初回、または見直す対象（件数の減少など）がある回は、新しいものが無くても台帳だけ書く
    //   （「反映」で承認した件数を次回からの比べる基準にする。しないと毎週同じ確認が出る）
    if ((first || report.review.length) && !report.blockers.length) {
      manifest.state_next = { ids: [...knownSet].sort(byNum), slices: sliceCounts };
    }
    return finish();
  }

  // 3. 新しい id だけ詳細・PDF → 本文 → パース
  const newSet = new Set(newIds);
  fs.writeFileSync(invFile, inv.filter((r) => newSet.has(String(r.id))).map((r) => JSON.stringify(r)).join('\n') + '\n');
  runNode(['scripts/hanrei/01_crawl.cjs', '--mode', 'detail']);
  runNode(['scripts/hanrei/01_crawl.cjs', '--mode', 'pdf']);
  if (process.env.HANREI_SKIP_PDF_TEXT !== '1') runPython(['scripts/hanrei/02_extract_pdf_text.py']);
  runNode(['scripts/hanrei/03_parse.cjs']);
  const parsed = [];
  const parsedDir = path.join(WORK_DIR, 'hanrei_parsed');
  if (fs.existsSync(parsedDir)) for (const f of fs.readdirSync(parsedDir).filter((x) => /^cases_\d{3}\.ndjson$/.test(x)).sort()) parsed.push(...readNdjson(path.join(parsedDir, f)));
  const ledger2 = readJson(path.join(WORK_DIR, 'state', 'crawl_ledger.json'), {});
  const detailOk = new Set(Object.entries(ledger2).map(([u, e]) => { const m = u.match(/\/hanrei\/(\d+)\/detail\d\/index\.html$/); return m && e.status === 'ok' ? m[1] : null; }).filter(Boolean));
  // PDF: 404（裁判所が PDF を出していない）は本文なしで足す。通信エラー・本文を抜けなかったものは、本文・セクション・
  //   本文由来の条文リンクが欠けたまま既知になってしまうので、今回は足さずに翌週もう一度試す
  const pdfStatus = new Map();
  for (const [u, e] of Object.entries(ledger2)) { const m = u.match(/\/hanrei-pdf-(\d+)\.pdf$/); if (m) pdfStatus.set(m[1], e.status); }
  const skipText = process.env.HANREI_SKIP_PDF_TEXT === '1';   // 確かめ用（pdfplumber の無い環境）。本番では付けない
  const pdfProblem = (c) => {
    const st = pdfStatus.get(String(c.id));
    if (st === '404') return null;
    if (st !== 'ok') return 'PDF が取れなかった';
    if (!skipText && !(c.pdf && c.pdf.found)) return 'PDF の本文を抜けなかった';
    return null;
  };
  // 詳細ページが取れて、事件名か事件番号があり、PDF に問題の無いものだけ足す。それ以外は足さない（既知にしないので翌週もう一度試す）
  const pdfFailed = [];
  const good = parsed.filter((c) => {
    if (!(newSet.has(String(c.id)) && detailOk.has(String(c.id)) && (c.title || c.caseNo) && c.court)) return false;
    const why = pdfProblem(c);
    if (why) { pdfFailed.push(`${c.id}（${why}）`); return false; }
    return true;
  });
  if (pdfFailed.length) report.notes.push(`PDF の問題で今回は足さない ${pdfFailed.length} 件（翌週もう一度試す）: ${pdfFailed.slice(0, 20).join(', ')}`);
  const goodSet = new Set(good.map((c) => String(c.id)));
  manifest.failed_ids = newIds.filter((id) => !goodSet.has(id));
  if (manifest.failed_ids.length / newIds.length > MAX_FAIL_RATIO && manifest.failed_ids.length >= 3) {
    report.blockers.push(`新しい判例 ${newIds.length} 件のうち ${manifest.failed_ids.length} 件の詳細ページか PDF が取れなかった・読めなかった（1 割超）。取得かパースの不具合の疑い`);
  } else if (manifest.failed_ids.length) {
    report.notes.push(`詳細ページか PDF が取れなかった ${manifest.failed_ids.length} 件は今回足さない（翌週もう一度試す）: ${manifest.failed_ids.slice(0, 20).join(', ')}`);
  }
  const noPdf = good.filter((c) => pdfStatus.get(String(c.id)) === '404').length;
  if (noPdf) report.notes.push(`裁判所が PDF を出していない判例 ${noPdf} 件（要旨・一覧の項目だけで足す）`);
  if (report.blockers.length) return finish();
  if (!good.length) {   // 新しい判例が全部取れなかった: 何も書かない（既知にもしないので翌週もう一度試す）
    if (first || report.review.length) manifest.state_next = { ids: [...knownSet].sort(byNum), slices: sliceCounts };
    return finish();
  }
  good.sort((a, b) => byNum(a.id, b.id));

  // 4. 原審の引き当て
  const { matches, ambiguous } = await matchGensin(good, rd);
  log(`原審の引き当て: ${matches.length} 件（曖昧で見送り ${ambiguous} 件）`);

  // 5. 書く中身（07 と同じ形）
  const files = new Map();   // key → json（書き込む後の姿）
  const load = async (key, fallback) => { if (!files.has(key)) { const j = await rd.json(key); files.set(key, j == null ? fallback : j); } return files.get(key); };
  const goodById = new Map(good.map((c) => [String(c.id), c]));
  const appealsOf = new Map();   // parentId → [appeal]
  for (const { child, parent } of matches) {
    if (!appealsOf.has(parent)) appealsOf.set(parent, []);
    appealsOf.get(parent).push({ id: child.id, court: [child.court, child.branch].filter(Boolean).join(' ') || null, dateJp: child.dateJp || null, kekka: child.kekka || null });
  }
  const urlOf = (c) => `https://www.courts.go.jp/hanrei/${c.id}/detail${(c.detailNs || [])[0] || 2}/index.html`;
  // 5a. cases
  for (const c of good) {
    const ck = await load(chunkKey(c.id), {});
    if (ck[c.id]) { report.blockers.push(`新しいはずの判例 ${c.id} が既に ${chunkKey(c.id)} にある（既知の id の台帳と R2 が食い違っている）`); continue; }
    const rec = { ...c };
    const dn = Array.isArray(rec.detailNs) && rec.detailNs.length ? rec.detailNs[0] : null;
    rec.url = `https://www.courts.go.jp/hanrei/${rec.id}/detail${dn != null ? dn : '2'}/index.html`;
    ck[c.id] = rec;
  }
  for (const [pid, apps] of appealsOf) {
    const ck = await load(chunkKey(pid), {});
    const rec = ck[pid];
    if (!rec) { report.blockers.push(`原審 ${pid} が ${chunkKey(pid)} に無い（lookup と cases が食い違っている）`); continue; }
    const before = JSON.stringify({ ...rec, appeals: undefined });
    const merged = new Map((rec.appeals || []).map((a) => [String(a.id), a]));
    for (const a of apps) merged.set(String(a.id), a);
    rec.appeals = [...merged.values()].sort((a, b) => byNum(a.id, b.id));
    if (JSON.stringify({ ...rec, appeals: undefined }) !== before) report.blockers.push(`原審 ${pid} の appeals 以外の欄が変わった（足すだけのはず）`);
  }
  if (report.blockers.length) return finish();
  // 5b. lookup
  for (const c of good) {
    if (c.court && c.caseNo) {
      const obj = await load(`${PREFIX}/lookup/caseno_${eraYearTag(c.caseNo) || 'other'}.json`, {});
      const k = `${courtKey(c.court, c.branch)}|${c.caseNo}`;
      obj[k] = [...new Set([...(obj[k] || []), c.id])].sort(byNum);
    }
    if (c.court && c.dateIso && /^\d{4}-/.test(c.dateIso)) {
      const obj = await load(`${PREFIX}/lookup/date_${c.dateIso.slice(0, 4)}.json`, {});
      const k = `${courtKey(c.court)}|${c.dateIso}`;
      obj[k] = [...new Set([...(obj[k] || []), c.id])].sort(byNum);
    }
  }
  // 5c. 条文 → 判例の逆引きは、条の系譜で付け直した hanrei_v2 だけに書く（2026-10-18 のオーナーの決定。v1 の紐付け hanrei_v1/links は付け方が違うので
  //     戻し先にせず、もう書かない。判例の本体 cases・lookup・court_names・index・ベクトルは今どおり hanrei_v1 の場所で共用）
  const sortKey = (v) => ({ r: courtRank(v.court), d: (goodById.get(String(v.id)) || {}).dateIso || warekiToIso(v.dateJp) || '' });
  if (!(await rd.json(`${V2}/index.json`))) { report.blockers.push(`${V2}/index.json が無い（条文 → 判例の逆引きは hanrei_v2 にしか書かない。条の系譜の全件の作り直しを先に R2 に書く）`); return finish(); }
  await relinkNew(good, rd, load, files, report, sortKey, [...appealsOf.keys()]);
  if (report.blockers.length) return finish();
  // 5d. court_names・index
  const names = await load(`${PREFIX}/court_names.json`, []);
  const nameSet = new Set(names);
  for (const c of good) { const k = courtKey(c.court); if (k) nameSet.add(k); }
  files.set(`${PREFIX}/court_names.json`, [...nameSet].sort());
  if ([...nameSet].length === names.length) files.delete(`${PREFIX}/court_names.json`);

  // 6. 埋め込み
  const stats = { byType: {}, yoshiCases: 0, emptySections: 0, shortSections: 0, homesTrimmed: 0, metaOverAfterTrim: 0 };
  const targets = [];
  for (const c of good) targets.push(...caseToTargets(c, VEC_NS, stats));
  if (stats.metaOverAfterTrim) report.blockers.push(`metadata が 10KiB を超えるベクトルが ${stats.metaOverAfterTrim} 本（06 の契約違反）`);
  const emb = new Embedder();
  const vec = new Vectorize({ index: VEC_INDEX });
  await embedDriftCheck(knownSet, rd, emb, vec, report);
  if (report.blockers.length) return finish();
  const values = await emb.embed(targets.map((t) => t.text));
  const vecFile = path.join(STATE_DIR, 'vectors.ndjson');
  fs.writeFileSync(vecFile, targets.map((t, i) => JSON.stringify({ id: t.id, namespace: VEC_NS, values: values[i], metadata: t.metadata })).join('\n') + (targets.length ? '\n' : ''));
  manifest.vector_count = targets.length;

  const index = await load(`${PREFIX}/index.json`, { cases: 0, laws: [], vectors: 0 });
  index.cases = (index.cases || 0) + good.length;
  // laws: 判例が引いている法令（v1 の紐付けを書かなくなったので、新しい判例の lawRefs から足す）
  index.laws = [...new Set([...(index.laws || []), ...good.flatMap((c) => (c.lawRefs || []).map((r) => r && r.lawId).filter((x) => x && /^[0-9A-Za-z_]+$/.test(x)))])].sort();
  index.vectors = (index.vectors || 0) + targets.length;
  index.updatedAt = new Date().toISOString();

  // 7. 成果物（書く後の姿と、読んだ時の hash）
  const outDir = path.join(STATE_DIR, 'files');
  for (const [key, json] of files) {
    const local = path.join(outDir, ...key.split('/'));
    writeJson(local, json);
    manifest.files[key] = { sha_before: rd.hashOf(key) ?? null, local: path.relative(STATE_DIR, local).split(path.sep).join('/') };
  }
  manifest.added_ids = good.map((c) => String(c.id));
  manifest.added = good.map((c) => ({ id: c.id, court: [c.court, c.branch].filter(Boolean).join(' '), date: c.dateJp, caseNo: c.caseNo, title: c.title }));
  manifest.appeals = matches.map((m) => ({ child: m.child.id, parent: m.parent }));
  manifest.state_next = { ids: [...new Set([...knownSet, ...manifest.added_ids])].sort(byNum), slices: sliceCounts };
  return finish();
}

// 新しい判例の引用を付け直しの表で今の条に付け直し、hanrei_v2 の currefs・links・index に足す（07 と同じ並べ方・上位 300 件）
async function relinkNew(good, rd, load, files, report, sortKey, appealParents = []) {
  const tIndex = await rd.json(`${TABLES}/index.json`);
  if (!tIndex || typeof tIndex !== 'object') { report.blockers.push(`${V2} はあるのに付け直しの表（${TABLES}/index.json）が読めない。新しい判例を付け直せないので止める`); return; }
  const need = new Set();
  for (const c of good) for (const r of c.lawRefs || []) if (r && tIndex[r.lawId]) { need.add(r.lawId); if (tIndex[r.lawId].old) need.add(tIndex[r.lawId].old); }
  const oldNames = new Map();
  for (const [id, e] of Object.entries(tIndex)) for (const n of (e && e.names) || []) { oldNames.set(n, id); }
  for (const c of good) for (const u of c.unresolvedRefs || []) if (u && oldNames.has(u.name)) need.add(oldNames.get(u.name));
  const tables = new Map();
  for (const id of need) {
    const t = await rd.json(`${TABLES}/${id}.json`);
    if (!t) { report.blockers.push(`付け直しの表 ${TABLES}/${id}.json が読めない（索引には載っている）`); return; }
    tables.set(id, t);
  }
  const table = (id) => tables.get(id) || null;
  const readOldName = CR.makeOldNameReader(require('../03_parse.cjs'));   // 「旧民法」など「旧」を付けて引いた条
  // 条文ページに載せる条件（2026-10-16・CR.decideShow）: 旧法の条は受け皿の判定（lineage_v1/policy/old_to_current.json）で
  // 確かなものだけ。新しい判例には判例ごとの Opus の判断がまだ無いので、載せられない引用は hide の印を付けて currefs に残す（docs/lineage.md「週次」）
  const oldMap = await rd.json(`${POLICY}/old_to_current.json`);
  if (!oldMap || typeof oldMap !== 'object') { report.blockers.push(`${V2} はあるのに旧法の受け皿の判定（${POLICY}/old_to_current.json）が読めない。載せる条件を当てられないので止める`); return; }
  const policy = { old: oldMap, judge: null };
  const shardKey = (id) => `${V2}/currefs_${String(Math.floor(parseInt(id, 10) / 100)).padStart(4, '0')}.json`;
  const per = new Map();   // lawId → art → [item]
  const counts = {};
  const hidden = {};
  const NONUM = require('../../lineage/nonum_cases.cjs');
  let nonumQueued = 0, fulltexts = 0;
  for (const c of good) {
    // 判決文の全文（作業フォルダの 02 の出力）: hanrei_v2/fulltext/ に置き（検索の区切りとは別。docs/lineage.md「判決文の全文」）、本文から読むものは全文で読む
    const ftp = path.join(WORK_DIR, 'hanrei_raw', 'pdftext', `${c.id}.json`);
    const ft = readJson(ftp, null);
    if (ft && typeof ft.text === 'string' && ft.text && ft.found !== false) {
      files.set(`${V2}/fulltext/${c.id}.json`, { id: String(c.id), pages: ft.pages, chars: ft.chars, text: ft.text, source: `https://www.courts.go.jp/assets/hanrei/hanrei-pdf-${c.id}.pdf`, pdf_sha256: null, fetched_at: new Date().toISOString() });
      fulltexts++;
    }
    const cT = ft && ft.text ? { ...c, sections: [{ text: ft.text }] } : c;
    // 引用を 1 つも読めず、判決文に「法令名＋第○条」の形も無い判例は、判断した条を AI で決める待ち行列へ（nonum_cases.cjs が判例の週次の後に流す）
    const textAll = (ft && ft.text) || (c.sections || []).map((x) => (x && x.text) || '').join('\n');
    if (NONUM.isNoNumCase(c, textAll)) {
      const nq = await load(NONUM.QUEUE, { v: 1, items: {} });
      nq.items = nq.items || {};
      if (!nq.items[String(c.id)]) { nq.items[String(c.id)] = { added: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) }; nonumQueued++; }
    }
    const closingOnly = CR.makeClosingOnly(cT);   // 判決の結びの決まり文句の中でだけ引いた条は載せない（2026-10-17）
    const stockOnly = CR.makeStockOnly(cT);       // 刑訴法411条の決まった言い回しだけの引用も載せない（2026-10-17）
    const cur = CR.curRefsOf(c, table, oldNames, null, readOldName(c))   // 新しい判例の lawRefs は 03_parse が before（…による改正前）を持つ
      .map((x) => CR.decideShow(c.id, x, table, policy, closingOnly, stockOnly));
    const sh = await load(shardKey(c.id), {});
    if (sh[c.id]) { report.blockers.push(`新しいはずの判例 ${c.id} の付け直しが既に ${shardKey(c.id)} にある`); return; }
    sh[c.id] = cur;
    const placed = new Map();   // 同じ判例が同じ今の条に何本で行き着いても 1 件
    for (const x of cur) {
      counts[x.how] = (counts[x.how] || 0) + 1;
      if (x.hide) hidden[x.hide] = (hidden[x.hide] || 0) + 1;
      for (const it of CR.linkItemsOf(c, x, table)) { const k = `${it.lawId}|${it.art}`; if (!placed.has(k) || (!it.v.via && placed.get(k).v.via)) placed.set(k, it); }
    }
    for (const it of placed.values()) {
      if (!per.has(it.lawId)) per.set(it.lawId, new Map());
      const m = per.get(it.lawId);
      if (!m.has(it.art)) m.set(it.art, { items: [] });
      m.get(it.art).items.push(it.v);
    }
  }
  let linksMoved = 0;
  for (const [lawId, m] of per) {
    const obj = await load(`${V2}/links/${lawId}.json`, {});
    for (const [art, box] of m) {
      const cur = obj[art] || { total: 0, items: [] };
      const items = cur.items || [];
      // 上位 300 件から押し出された判例は、301 件目からの続き（hanrei_v2/links_more/）に移す（2026-10-18。捨てない）。続きは 300 件を超えるときだけ読む
      const needMore = (cur.total || 0) > items.length || items.length + box.items.length > LINKS_TOP;
      const more = needMore ? await load(LM.moreKey(lawId, art), { total: 0, items: [] }) : null;
      const next = LM.mergeTop({ total: cur.total || 0, items }, (more && more.items) || [], box.items, sortKey);
      obj[art] = { total: next.total, items: next.items, ...(cur.other && cur.other.total ? { other: cur.other } : {}) };
      if (more) { more.total = next.total; more.items = next.more; }
      const top = new Set(next.items.map((x) => String(x.id)));
      linksMoved += items.filter((x) => !top.has(String(x.id))).length;   // 上位から続きに移した判例
    }
    const sorted = {};
    for (const k of Object.keys(obj).sort(artCompare)) sorted[k] = obj[k];
    files.set(`${V2}/links/${lawId}.json`, sorted);
  }
  // 上告審（最高裁）が新しく付いた原審の判決: hanrei_v2 の links にある item の上告審の結果の印（appeal）を付け直す（2026-10-18。月に 1 回を待たない）
  let appealMarked = 0;
  for (const pid of appealParents) {
    const rec = (await load(chunkKey(pid), {}))[pid];
    if (!rec) continue;
    const ap = CR.linkItem(rec, null, null).appeal || null;
    const peek = async (k) => (files.has(k) ? files.get(k) : await rd.json(k));   // 読むだけ（変えたときだけ files に入れる）
    const cr = ((await peek(shardKey(pid))) || {})[pid] || [];
    const dests = new Set(cr.flatMap((x) => (Array.isArray(x.show) ? x.show : []).map((d) => `${d.lawId}|${d.art}`)));
    for (const k of dests) {
      const [lawId, art] = k.split('|');
      const lk = `${V2}/links/${lawId}.json`;
      const obj = await peek(lk);
      let it = obj && obj[art] && Array.isArray(obj[art].items) ? obj[art].items.find((x) => String(x.id) === String(pid)) : null;
      let fk = lk, fobj = obj;
      if (!it && obj && obj[art] && (obj[art].total || 0) > LINKS_TOP) {   // 301 件目からの続き（links_more）にある判例
        fk = LM.moreKey(lawId, art);
        fobj = await peek(fk);
        it = fobj && Array.isArray(fobj.items) ? fobj.items.find((x) => String(x.id) === String(pid)) : null;
      }
      if (!it) continue;
      if (JSON.stringify(it.appeal || null) === JSON.stringify(ap)) continue;
      if (ap) it.appeal = ap; else delete it.appeal;
      files.set(fk, fobj);
      appealMarked++;
    }
  }
  if (appealMarked) report.notes.push(`hanrei_v2 の上告審の結果の印を付け直した item: ${appealMarked}`);
  const idx = await load(`${V2}/index.json`, {});
  idx.cases = (idx.cases || 0) + good.length;
  idx.laws = [...new Set([...(idx.laws || []), ...per.keys()])].sort();
  idx.updatedAt = new Date().toISOString();
  report.notes.push(`条の系譜で付け直した逆引き（${V2}）にも足す: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join('・') || '引用なし'}${Object.keys(hidden).length ? `（載せない: ${Object.entries(hidden).map(([k, n]) => `${k} ${n}`).join('・')}）` : ''}・全文 ${fulltexts} 件・判断した条を AI で決める待ち行列に ${nonumQueued} 件・上位 300 件から続き（links_more）に移した ${linksMoved} 件`);
}

// 埋め込みのずれ: 既知の判例の中から最新の数件を 06 と同じ文面で埋め込み直し、索引の値と比べる
async function embedDriftCheck(knownSet, rd, emb, vec, report) {
  const ids = [...knownSet].sort(byNum).slice(-40).reverse();
  const samples = [];
  for (const id of ids) {
    if (samples.length >= 5) break;
    const ck = await rd.json(chunkKey(id));
    const rec = ck && ck[id];
    if (!rec) continue;
    const ts = caseToTargets(rec, VEC_NS, { byType: {}, yoshiCases: 0, emptySections: 0, shortSections: 0, homesTrimmed: 0, metaOverAfterTrim: 0 });
    if (ts.length) samples.push(ts[0]);
  }
  if (!samples.length) { report.review.push('埋め込みのずれを確かめられなかった（比べる判例が見つからない）'); return; }
  const stored = new Map((await vec.getByIds(samples.map((s) => s.id))).map((v) => [v.id, v.values]));
  const fresh = await emb.embed(samples.map((s) => s.text));
  // 比べられたものは全部確かめる（次元・有限値・ノルム）。閾値未満か値が不正なものが 1 件でもあれば止める。件数不足は別に見直す対象
  const cos = [], bad = [];
  let compared = 0;
  samples.forEach((s, i) => {
    const a = stored.get(s.id); const b = fresh[i];
    if (!a) return;
    compared++;
    const ok = Array.isArray(a) && Array.isArray(b) && a.length === DIM && b.length === DIM && a.every(Number.isFinite) && b.every(Number.isFinite);
    let d = 0, na = 0, nb = 0;
    if (ok) for (let j = 0; j < DIM; j++) { d += a[j] * b[j]; na += a[j] * a[j]; nb += b[j] * b[j]; }
    const c = ok && na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : NaN;
    if (!Number.isFinite(c)) bad.push(`${s.id}（次元・値が不正）`);
    else { cos.push(c); if (c < EMBED_MIN_COS) bad.push(`${s.id}（cosine ${c.toFixed(4)}）`); }
  });
  if (cos.length) report.notes.push(`埋め込みの自己一致: ${cos.map((c) => c.toFixed(4)).join(' / ')}`);
  if (bad.length) report.blockers.push(`埋め込みのずれ: 既存の判例を埋め込み直した値と索引の値が合わない（${bad.join(', ')}。${EMBED_MIN_COS} 未満か不正）。Workers AI の出力が変わった疑い`);
  if (compared < 3) report.review.push(`埋め込みのずれを ${compared} 件しか確かめられなかった（索引に無い）`);
}

function renderReport(m) {
  const L = [];
  L.push(`# 判例の週次更新（run ${m.run_id}）`, '');
  L.push(`- 一覧: 令和${m.window.from}年〜令和${m.window.to}年 / 既知 ${m.known_count} 件${m.first_run ? '（初回。R2 の cases から作った）' : ''}`);
  L.push(`- 新しい判例: ${m.new_ids.length} 件 → 足す ${m.added_ids.length} 件 / 取れなかった ${m.failed_ids.length} 件`);
  L.push(`- 書くファイル: ${Object.keys(m.files).length} / ベクトル: ${m.vector_count} 本（${VEC_INDEX} の ${VEC_NS}）`);
  if (m.appeals && m.appeals.length) L.push(`- 原審に上告審を足す: ${m.appeals.length} 件`);
  L.push('');
  if (m.blockers.length) { L.push('## 止めた理由', ''); for (const b of m.blockers) L.push(`- ${b}`); L.push(''); }
  if (m.review.length) { L.push('## 見直す対象', ''); for (const b of m.review) L.push(`- ${b}`); L.push(''); }
  if (m.notes.length) { L.push('## メモ', ''); for (const b of m.notes) L.push(`- ${b}`); L.push(''); }
  if (m.added && m.added.length) {
    L.push('## 足す判例', '', '| id | 裁判所 | 裁判年月日 | 事件番号 | 事件名 |', '|---|---|---|---|---|');
    for (const a of m.added.slice(0, 100)) L.push(`| ${a.id} | ${a.court || ''} | ${a.date || ''} | ${a.caseNo || ''} | ${String(a.title || '').replace(/\|/g, '｜').slice(0, 40)} |`);
    if (m.added.length > 100) L.push(`| … | ほか ${m.added.length - 100} 件 | | | |`);
    L.push('');
  }
  L.push('## ファイル', '');
  for (const k of Object.keys(m.files).sort()) L.push(`- ${k}${m.files[k].sha_before ? '' : '（新規）'}`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- 書く経路を 1 本にする
// apply・restore は Actions（.github/workflows/update_hanrei.yml。concurrency: update-hanrei で 1 本ずつ流れる）からしか動かさない。
// 手元から動かせると Actions と同時に書けてしまい、印の引き継ぎ（同じ回の restore のやり直し）で動いている処理から奪える。
// 確かめ用（R2 と Vectorize の両方が偽物）と dry-run だけは手元で動かせる。片方だけ偽物だと、もう片方の本番に書けてしまうので拒む
function assertWriteContext(what) {
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.UPDATE_DRY_RUN === '1') return;
  if (process.env.R2_FAKE_DIR && process.env.VECTORIZE_FAKE_FILE) return;
  throw new Error(`${what} は Actions の Update hanrei data からしか動かさない（同時に書かないように 1 本ずつ流すため）。戻すときは mode=restore・restore_run_id で実行する`);
}

// ---------------------------------------------------------------- 作業中の印（排他）
// R2 の「無いときだけ書く」で取る（Actions・手元の実行が同時でも、取れるのは 1 つだけ）。解放は自分の token のときだけ
async function acquireLock(r2, rid, kind, { takeoverSameRun = false } = {}) {
  const token = crypto.randomBytes(12).toString('hex');
  // phase: apply は 'backup'（退避中・本番はまだ書いていない）→ 'writing'（本番を書き始めた）。restore は 'restore'
  const body = JSON.stringify({ run_id: rid, kind, token, phase: kind === 'apply' ? 'backup' : 'restore', started_at: new Date().toISOString() });
  // 念のため先に読む（条件付き書き込みが効かない環境でも、既にある他人の印を上書きしない）
  const pre = await r2.getJson(LOCK_KEY);
  if (pre && !(takeoverSameRun && pre.run_id === rid)) throw new Error(`作業中の印がある（run ${pre.run_id}・${pre.kind}・${pre.started_at} 開始）。別の反映か戻しが動いているか、途中で落ちている。何も書いていない`);
  if (!pre && await r2.putIfAbsent(LOCK_KEY, body)) return { token, fresh: true };
  const cur = await r2.getJson(LOCK_KEY);
  if (cur && cur.token === token) return { token, fresh: true };   // 書けたのに応答が落ちて再試行が 412 になった
  // 同じ回の途中で落ちた反映・戻しを、同じ restore でやり直す。書く経路は Actions だけで 1 本ずつ流れる（assertWriteContext）ので、
  // この時点で同じ回の処理が別に動いていることは無い（印が残っているのは落ちたから）
  if (cur && takeoverSameRun && cur.run_id === rid) {
    await r2.put(LOCK_KEY, body);
    return { token, fresh: false };
  }
  throw new Error(`作業中の印がある（run ${cur && cur.run_id}・${cur && cur.kind}・${cur && cur.started_at} 開始）。別の反映か戻しが動いているか、途中で落ちている。何も書いていない`);
}
async function releaseLock(r2, token) {
  const cur = await r2.getJson(LOCK_KEY);
  if (cur && cur.token === token) await r2.delete(LOCK_KEY);
}

// ---------------------------------------------------------------- apply
// prepare の成果物を厳しく読む（欠け・壊れ・件数違いのまま本番に書かない）
function loadArtifacts(m) {
  for (const [k, f] of Object.entries(m.files || {})) {
    const p = path.join(STATE_DIR, f.local || '');
    if (!f.local || !fs.existsSync(p)) throw new Error(`成果物が欠けている: ${k}（${f.local}）。書かずに止める`);
    try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new Error(`成果物が壊れている: ${k}（JSON として読めない）。書かずに止める`); }
  }
  const p = path.join(STATE_DIR, 'vectors.ndjson');
  const expect = Number(m.vector_count || 0);
  const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()) : [];
  if (expect && !fs.existsSync(p)) throw new Error(`vectors.ndjson が無い（manifest では ${expect} 本）。書かずに止める`);
  const added = new Set((m.added_ids || []).map(String));
  const ids = new Set();
  const out = lines.map((l, i) => {
    let v;
    try { v = JSON.parse(l); } catch { throw new Error(`vectors.ndjson の ${i + 1} 行目が読めない。書かずに止める`); }
    const bad = (why) => new Error(`vectors.ndjson の ${i + 1} 行目（${v && v.id}）: ${why}。書かずに止める`);
    if (!v || typeof v.id !== 'string' || !/^\d+-(y|s\d+)$/.test(v.id)) throw bad('id の形が違う');
    if (v.namespace !== VEC_NS) throw bad(`namespace が ${VEC_NS} でない`);
    if (!Array.isArray(v.values) || v.values.length !== DIM || v.values.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw bad(`values が ${DIM} 次元の数でない`);
    if (!v.metadata || typeof v.metadata !== 'object' || String(v.metadata.sid) !== v.id.split('-')[0]) throw bad('metadata.sid が id と合わない');
    if (!added.has(String(v.metadata.sid))) throw bad('足す判例に無い sid');
    if (ids.has(v.id)) throw bad('id が重複');
    ids.add(v.id);
    return v;
  });
  if (out.length !== expect) throw new Error(`vectors.ndjson が ${out.length} 本（manifest では ${expect} 本）。書かずに止める`);
  return out;
}
// ベクトルの比べ方: Vectorize は float32 で返すので hash では比べられない。metadata が同じで cosine がほぼ 1 なら同じとみなす
const stableJson = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}` : JSON.stringify(o));
function sameVector(a, b) {
  if (!a || !b) return !a && !b;
  if (stableJson(a.metadata || {}) !== stableJson(b.metadata || {})) return false;
  if (!Array.isArray(a.values) || !Array.isArray(b.values) || a.values.length !== b.values.length) return false;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.values.length; i++) { d += a.values[i] * b.values[i]; na += a.values[i] ** 2; nb += b.values[i] ** 2; }
  return d / Math.sqrt(na * nb) >= 0.9999;
}

async function apply() {
  assertWriteContext('apply');
  const m = readJson(path.join(STATE_DIR, 'manifest.json'), null);
  if (!m) throw new Error(`${STATE_DIR}/manifest.json がありません（prepare の成果物を置いてください）`);
  // 止めた回の成果物は途中まで（ファイル・ベクトル・台帳が作られていない）なので、強制反映の道は作らない。原因を直して prepare からやり直す
  if (!m.ok_to_apply) throw new Error(`blockers があるので反映しない（原因を直して prepare からやり直す）: ${(m.blockers || []).join(' / ')}`);
  // 見直す対象がある回（初回を含む）は、オーナーが Issue に「反映」とコメントしたときだけ（ワークフローがその経路でだけ HANREI_APPROVED=1 を渡す）
  if (m.needs_review && process.env.HANREI_APPROVED !== '1') throw new Error(`見直す対象がある回は、Issue の「反映」コメントからしか反映しない: ${(m.review || []).join(' / ')}`);
  const r2 = new R2();
  const vec = new Vectorize({ index: VEC_INDEX });
  const rid = m.run_id;
  const bk = `${BACKUP_PREFIX}/${rid}`;
  const keys = Object.keys(m.files);
  const vectors = loadArtifacts(m);
  if (!keys.length && !vectors.length && !m.state_next) { log('反映するものが無い'); return; }

  // 0. 作業中の印を取る（取れなければ別の反映・戻しが動いているか途中で落ちている）。書き始める前に落ちたら印を外す
  const { token } = await acquireLock(r2, rid, 'apply');
  let writing = false;
  try {
  // 1. prepare の後に R2 が変わっていないか（印を取った後に確かめる。変わっていたら書かずに止める）
  const current = new Map();
  for (const k of keys) {
    const buf = await r2.get(k);
    current.set(k, buf);
    if (sha(buf) !== m.files[k].sha_before) throw new Error(`prepare の後に ${k} が変わった（${m.files[k].sha_before ? 'hash が違う' : '無かったものがある'}）。書かずに止める。prepare からやり直す`);
  }
  const stateBuf = await r2.get(STATE_KEY);
  if (sha(stateBuf) !== (m.state_sha_before ?? null)) throw new Error(`prepare の後に台帳（${STATE_KEY}）が変わった（別の反映が先に入った）。書かずに止める。prepare からやり直す`);
  // 2. 退避（R2 のファイル・今の台帳・上書きするベクトル）。1 件でも失敗したら書き始めない
  const existingVecs = vectors.length ? await vec.getByIds(vectors.map((v) => v.id)) : [];
  // after: 書いた後の中身の hash。restore は「今の R2 がこの回の書いた直後のまま」のときだけ戻す（後の更新を消さない）
  const nextStateBody = m.state_next ? JSON.stringify({ ...m.state_next, updated_at: new Date().toISOString(), run_id: rid }) : null;
  const after = {};
  for (const k of keys) after[k] = sha(fs.readFileSync(path.join(STATE_DIR, m.files[k].local)));
  after[STATE_KEY] = nextStateBody ? sha(Buffer.from(nextStateBody)) : sha(stateBuf);
  const before = {};   // 書く前の hash（apply が途中で落ちたとき、まだ書いていないファイルはこちらのまま）
  for (const k of keys) before[k] = sha(current.get(k));
  before[STATE_KEY] = sha(stateBuf);
  const backupManifest = { run_id: rid, created_at: new Date().toISOString(), files: {}, before, after, state_existed: !!stateBuf, vectors_added: vectors.map((v) => v.id), vectors_overwritten: existingVecs.map((v) => v.id), namespace: VEC_NS, index: VEC_INDEX };
  for (const k of keys) {
    const buf = current.get(k);
    backupManifest.files[k] = !!buf;
    if (buf) await r2.put(`${bk}/files/${k}`, buf);
  }
  if (stateBuf) await r2.put(`${bk}/files/${STATE_KEY}`, stateBuf);
  await r2.put(`${bk}/vectors_before.json`, JSON.stringify(existingVecs.map((v) => ({ id: v.id, namespace: VEC_NS, values: v.values, metadata: v.metadata }))));
  await r2.put(`${bk}/vectors_after.json`, JSON.stringify(vectors));   // restore が「今のベクトルがこの回の書いた後のままか」を比べる
  if (process.env.HANREI_TEST_KILL_APPLY_AT === 'backup') process.exit(137);   // 確かめ用: 退避の途中で強制終了（catch も動かない）
  await r2.put(`${bk}/_manifest.json`, JSON.stringify(backupManifest));
  // 退避が読めることを確かめてから書く
  const chk = r2.dryRun ? backupManifest : await r2.getJson(`${bk}/_manifest.json`);
  if (!chk || chk.run_id !== rid) throw new Error('退避の読み戻しに失敗。書き始めない');
  log(`退避: ${keys.filter((k) => backupManifest.files[k]).length} ファイル・台帳・ベクトル ${existingVecs.length} 本 → ${bk}/`);

  // 3. 書く（印を 'writing' に → R2 のファイル → ベクトル → 台帳 → 印を外す。途中で落ちたら印が残り、次の prepare・apply は止まる）
  //   印が 'backup' のまま残っていれば本番は書いていない（restore で印だけ外せる）
  writing = true;
  await r2.put(LOCK_KEY, JSON.stringify({ ...(await r2.getJson(LOCK_KEY)), phase: 'writing', writing_at: new Date().toISOString() }));
  for (const k of keys) await r2.put(k, fs.readFileSync(path.join(STATE_DIR, m.files[k].local)));
  if (process.env.HANREI_TEST_FAIL_APPLY_AT === 'vectors') throw new Error('（確かめ用）ベクトルを入れる前に止めた');
  if (vectors.length) await vec.upsert(vectors);
  if (nextStateBody) await r2.put(STATE_KEY, nextStateBody);
  await releaseLock(r2, token);
  log(`反映: ファイル ${keys.length} / ベクトル ${vectors.length} / 台帳 ${m.state_next ? m.state_next.ids.length + ' 件' : 'そのまま'}`);

  // 4. 抜き取り検証
  for (const id of (m.added_ids || []).slice(0, 3)) {
    const ck = await r2.getJson(chunkKey(id));
    if (!ck || !ck[id]) throw new Error(`検証: ${id} が ${chunkKey(id)} に無い`);
  }
  if (vectors.length) {
    const got = await vec.getByIds(vectors.slice(0, 3).map((v) => v.id));
    if (!process.env.UPDATE_DRY_RUN && got.length < Math.min(3, vectors.length)) log(`※ 検証: 入れたベクトルがまだ取れない（${got.length}/${Math.min(3, vectors.length)}。Vectorize は反映に数秒〜数分かかることがある）`);
  }
  log(`戻すときは: Actions の Update hanrei data を mode=restore・restore_run_id=${rid} で実行（main のコードで動く）`);
  } catch (e) {
    if (!writing) await releaseLock(r2, token).catch(() => {});   // まだ何も書いていなければ印を外す（書き始めていたら残す）
    throw e;
  }
}

// ---------------------------------------------------------------- restore
async function restore(rid) {
  if (!rid) throw new Error('restore <run_id> を指定してください');
  assertWriteContext('restore');
  const r2 = new R2();
  const vec = new Vectorize({ index: VEC_INDEX });
  const bk = `${BACKUP_PREFIX}/${rid}`;
  const bm = await r2.getJson(`${bk}/_manifest.json`);
  if (!bm) {
    // 退避を作り終える前に落ちた apply（印が 'backup' のまま）: 本番は書いていないので、印だけ外す
    const lk = await r2.getJson(LOCK_KEY);
    if (lk && lk.run_id === rid && lk.kind === 'apply' && lk.phase === 'backup') {
      const again = await r2.getJson(LOCK_KEY);
      if (again && again.token === lk.token) await r2.delete(LOCK_KEY);
      log(`run ${rid} の apply は退避の途中（本番を書く前）で止まっていた。本番は変わっていないので、作業中の印だけ外した。prepare からやり直す`);
      return;
    }
    throw new Error(`${bk}/_manifest.json がありません`);
  }
  // 作業中の印を取る。同じ回の途中で落ちた反映・戻しの印なら引き継いでやり直す。別の回の印があれば止まる
  const { token, fresh } = await acquireLock(r2, rid, 'restore', { takeoverSameRun: true });
  let writing = false;
  try {
  // 今の R2 が、この回の書いた直後のままか（後で別の反映が入っていれば、戻すとその分まで消えるので止める）
  const now = new Map();
  const allKeys = [...Object.keys(bm.files), STATE_KEY];
  for (const k of allKeys) now.set(k, await r2.get(k));
  if (!bm.after || !bm.before) throw new Error('この退避には書く前・書いた後の hash が無いので、安全に戻せるか確かめられない。手で確かめて戻す');
  // 各ファイルが「この回の書いた後」か「書く前のまま（apply が途中で落ちた）」のどちらかなら戻してよい
  const changed = allKeys.filter((k) => { const h = sha(now.get(k)); return h !== (bm.after[k] ?? null) && h !== (bm.before[k] ?? null); });
  if (changed.length) throw new Error(`この回の後に変わったファイルがある（${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' ほか' : ''}）。後の反映を先に戻すか、手で確かめる。何も書いていない`);
  // ベクトルも同じく「この回の書いた後」か「書く前」のままか確かめる
  const vBefore = new Map(((await r2.getJson(`${bk}/vectors_before.json`)) || []).map((v) => [v.id, v]));
  const vAfterList = await r2.getJson(`${bk}/vectors_after.json`);
  if (bm.vectors_added.length && !Array.isArray(vAfterList)) throw new Error('この退避には書いたベクトルの控えが無いので、安全に戻せるか確かめられない。手で確かめて戻す');
  const vAfter = new Map((vAfterList || []).map((v) => [v.id, v]));
  const vNow = new Map((bm.vectors_added.length ? await vec.getByIds(bm.vectors_added) : []).map((v) => [v.id, v]));
  const vChanged = bm.vectors_added.filter((id) => !sameVector(vNow.get(id), vAfter.get(id)) && !sameVector(vNow.get(id), vBefore.get(id)));
  if (vChanged.length) throw new Error(`この回の後に変わったベクトルがある（${vChanged.slice(0, 5).join(', ')}${vChanged.length > 5 ? ' ほか' : ''}）。手で確かめる。何も書いていない`);
  // 戻す元（退避）を書き戻しの前に全部読んで確かめる（途中まで戻してから欠けに気付かないように）
  const vBeforeRaw = await r2.getJson(`${bk}/vectors_before.json`);
  if (!Array.isArray(vBeforeRaw)) throw new Error('退避に vectors_before.json が無い・読めない。何も書いていない');
  const overwritten = [...(bm.vectors_overwritten || [])].sort();
  if (JSON.stringify([...vBefore.keys()].sort()) !== JSON.stringify(overwritten)) throw new Error('退避のベクトル（vectors_before.json）が、上書きした id と合わない。何も書いていない');
  for (const v of vBefore.values()) {
    if (v.namespace !== VEC_NS || !Array.isArray(v.values) || v.values.length !== DIM || !v.values.every(Number.isFinite)) throw new Error(`退避のベクトル ${v.id} の形が不正。何も書いていない`);
  }
  const restoreBufs = new Map();
  for (const [k, existed] of Object.entries(bm.files)) {
    if (!existed) continue;
    const b = await r2.get(`${bk}/files/${k}`);
    if (sha(b) !== (bm.before[k] ?? null)) throw new Error(`退避の ${k} が欠けているか、書く前の hash と合わない。何も書いていない`);
    restoreBufs.set(k, b);
  }
  let stateRestore = null;
  if (bm.state_existed) {
    stateRestore = await r2.get(`${bk}/files/${STATE_KEY}`);
    if (sha(stateRestore) !== (bm.before[STATE_KEY] ?? null)) throw new Error('退避の台帳が欠けているか、書く前の hash と合わない。何も書いていない');
  }
  // 戻す直前の中身も控える（戻したのを戻せるように）
  // ここから書く（途中で落ちたら印が残り、次の prepare・apply は止まる。同じ restore でやり直せる）
  writing = true;
  const pre = `${bk}/pre_restore_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  for (const k of allKeys) if (now.get(k)) await r2.put(`${pre}/${k}`, now.get(k));
  await r2.put(`${pre}/vectors_current.json`, JSON.stringify([...vNow.values()].map((v) => ({ id: v.id, namespace: VEC_NS, values: v.values, metadata: v.metadata }))));
  log(`戻す前の中身（ファイル・ベクトル ${vNow.size} 本）を控えた: ${pre}/`);
  for (const [k, existed] of Object.entries(bm.files)) {
    if (existed) await r2.put(k, restoreBufs.get(k));
    else await r2.delete(k);
  }
  if (bm.state_existed) await r2.put(STATE_KEY, stateRestore);
  else await r2.delete(STATE_KEY);
  if (process.env.HANREI_TEST_FAIL_RESTORE_AT === 'vectors') throw new Error('（確かめ用）ベクトルを戻す前に止めた');
  // 消すのは、この回に新しく足したベクトルだけ。上書きした既存のベクトルは消さずに退避の値で上書きする
  // （消してから入れ直すと、その間に落ちたとき既存のベクトルが欠け、restore をやり直しても照合で止まってしまう）
  const overwrittenSet = new Set(bm.vectors_overwritten || []);
  const pureNew = bm.vectors_added.filter((id) => !overwrittenSet.has(id));
  if (pureNew.length) await vec.deleteByIds(pureNew);
  const before = [...vBefore.values()];
  if (before.length) await vec.upsert(before);
  await releaseLock(r2, token);   // 全部戻し終えたので印を外す
  log(`戻した: ファイル ${Object.keys(bm.files).length}・台帳・ベクトル 削除 ${pureNew.length} / 退避の値で上書き ${before.length}`);
  } catch (e) {
    if (!writing && fresh) await releaseLock(r2, token).catch(() => {});   // 照合で止めた・まだ書いていない・自分で新しく取った印なら外す
    throw e;
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'prepare') await prepare();
  else if (cmd === 'apply') await apply();
  else if (cmd === 'restore') await restore(arg);
  else { console.error('使い方: run.cjs prepare | apply | restore <run_id>'); process.exit(2); }
}

module.exports = { prepare, apply, restore, matchGensin, reiwaWindow, readNdjson };

if (require.main === module) main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
