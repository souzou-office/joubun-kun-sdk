// Phase 2: 新しい条文ファイルを R2 の今の中身と比べ、反映計画（manifest）と安全チェックの結果を作る。
//
//   node scripts/update/05_diff.cjs [--concurrency 16]
//
// 入力: state/out/{law_id}/*.json（04 の出力）、state/parse_log.json、state/change_report.json
// 出力: state/old/{law_id}/*.json     R2 にある今のファイル（退避とベクトル削除の計算に使う）
//       state/embed_inputs.jsonl      ベクトルを作り直す項（id, text, metadata）
//       state/manifest.json           法令ごとの put/delete、条数、振り直し判定、宙に浮く紐付け、ベクトルの upsert/delete、blockers
//
// 安全チェック（blockers。1 つでもあれば apply は --force なしでは動かない）:
//   - パース失敗が 1 件以上
//   - 変更法令数が UPDATE_MAX_CHANGED_LAWS（既定 800）を超える
//   - 1 法令の条数が 30% 超減った（UPDATE_MAX_DROP_RATIO）
//   - 新ファイルが 0 件の法令（本文が取れていない）
// 報告だけ（止めない）:
//   - 条番号の振り直しらしい法令（条タイトル集合の一致率 < 0.5）
//   - 通達・判例・事例・裁決・委任先が指す条が新しい条集合に無い（宙に浮く紐付け）
//   - 紐付いている条の見出しが変わった
const fs = require('fs');
const path = require('path');
const { CONFIG, statePath, readJson, writeJson, log, ensureDir, sha256, sleep, titleToNums, titleToJou, isReviewLaw } = require('./lib/common.cjs');
const DELEG_PREFIX = process.env.DELEGATIONS_PREFIX || 'delegations_v1';   // 委任先（wrangler.toml の vars と同じ値）
const { R2 } = require('./lib/r2.cjs');
const { paragraphRecords } = require('./lib/vectors.cjs');
const { fetchLawStatus, SLEEP_MS } = require('./lib/egov_api.cjs');
// 施行日を決めるだけの政令（e-Gov の法令 API が載せない種類。台帳に無く e-Gov にも無ければ消す）
const SEKOU_RE = /(?:施行期日|の政令で定める日(?:等)?)を定める政令$/;

function readDirJson(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) if (name.endsWith('.json')) out[name] = fs.readFileSync(path.join(dir, name));
  return out;
}
const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size && !B.size) return 1; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };

// 条タイトル → { jou: '70の6', caption } （本則優先）
function articleMap(files) {
  const m = new Map();
  for (const [name, buf] of Object.entries(files)) {
    if (name === '_index.json') continue;
    let data; try { data = JSON.parse(buf.toString('utf8')); } catch { continue; }
    for (const a of data.articles || []) {
      const jou = titleToJou(a.title);
      if (!jou) continue;
      const suppl = !!(a.structure && a.structure.suppl);
      if (!m.has(jou) || (m.get(jou).suppl && !suppl)) m.set(jou, { title: a.title, caption: a.caption || '', suppl });
    }
  }
  return m;
}

async function linkedKeys(r2, lawId) {
  // 通達・判例・事例/裁決・委任先 が、この法令のどの条（"70の6" 形式）に紐付いているか
  const out = { tsutatsu: [], hanrei: [], cases: [], delegations: [] };
  const [tsu, han, cases, delIdx] = await Promise.all([
    r2.getJson(`${CONFIG.tsutatsuPrefix}/${lawId}.json`).catch(() => null),
    r2.getJson(`hanrei_v2/links/${lawId}.json`).catch(() => null),   // 2026-10-18 から判例の紐付けは v2
    r2.getJson(`article_links_v1/${lawId}.json`).catch(() => null),
    r2.getJson(`${DELEG_PREFIX}/index.json`).catch(() => null),
  ]);
  if (tsu) out.tsutatsu = Object.keys(tsu);
  if (han) out.hanrei = Object.keys(han);
  if (cases) out.cases = Object.keys(cases);
  if (delIdx && delIdx[lawId] !== undefined) {
    const chunk = await r2.getJson(`${DELEG_PREFIX}/chunk_${String(delIdx[lawId]).padStart(3, '0')}.json`).catch(() => null);
    const arts = chunk && chunk[lawId] && chunk[lawId].articles;
    if (arts) out.delegations = Object.keys(arts).map((k) => k.replace(/_/g, 'の'));   // "66_4" → "66の4"
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const concurrency = args.includes('--concurrency') ? Number(args[args.indexOf('--concurrency') + 1]) : Number(process.env.UPDATE_CONCURRENCY || 16);
  const r2 = new R2();
  const parseLog = readJson(statePath('parse_log.json'), { success: [], failed: [] });
  const report = readJson(statePath('change_report.json'), { added: [], modified: [], removed: [] });
  const blockersPre = [];
  const outDir = statePath('out');
  // 対象は今回の change_report にある法令だけ（state/out には前回の残りがあり得る）
  const targets = new Set([...(report.added || []), ...(report.modified || []).map((m) => m.law_id)]);
  const lawIds = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((d) => targets.has(d) && fs.statSync(path.join(outDir, d)).isDirectory()).sort() : [];
  const missing = [...targets].filter((id) => !fs.existsSync(path.join(outDir, id)));
  if (missing.length) blockersPre.push({ kind: 'no_new_files', count: missing.length, sample: missing.slice(0, 5) });
  const prefix = CONFIG.articlesPrefix;
  const oldPrefix = CONFIG.oldArticlesPrefix;
  const samePrefix = prefix === oldPrefix;
  log(`差分計算: ${lawIds.length} 法令（R2 prefix=${prefix}${samePrefix ? '' : `、比較元=${oldPrefix}（新プレフィックスなので全ファイル PUT・削除なし）`}）`);

  const embedOut = fs.createWriteStream(statePath('embed_inputs.jsonl'), { flags: 'w' });
  const laws = {};
  const totals = { laws: lawIds.length, put: 0, delete: 0, unchanged_files: 0, vec_upsert: 0, vec_delete: 0, dangling: 0, dangling_preexisting: 0, renumber: 0 };
  const blockers = [...blockersPre];
  // 埋め込みのずれ（check_embed_drift.cjs の結果）。ずれたままベクトルを書くと索引の中で新旧が別の空間になるので止める
  const drift = readJson(statePath('embed_drift.json'), null);
  if (drift && drift.ok === false) blockers.push({ kind: 'embed_drift', configured_pooling: drift.configured_pooling, matching_poolings: drift.matching_poolings, stats: drift.stats });
  if (parseLog.failed && parseLog.failed.length) blockers.push({ kind: 'parse_failed', count: parseLog.failed.length, sample: parseLog.failed.slice(0, 5) });
  if (lawIds.length > CONFIG.limits.maxChangedLaws && report.mode !== 'all') blockers.push({ kind: 'too_many_laws', count: lawIds.length, limit: CONFIG.limits.maxChangedLaws });

  let n = 0;
  await R2.pmap(lawIds, Math.max(1, Math.floor(concurrency / 4)), async (lawId) => {
    const newFiles = readDirJson(path.join(outDir, lawId));
    const lawPrefix = `${oldPrefix}/${lawId}/`;
    const oldList = await r2.list(lawPrefix);
    const oldNames = oldList.map((o) => o.key.slice(lawPrefix.length)).filter((k) => k && !k.includes('/'));
    const oldDir = ensureDir(statePath('old', lawId));
    const oldFiles = {};
    await R2.pmap(oldNames, 4, async (name) => {
      const buf = await r2.get(lawPrefix + name);
      if (buf) { oldFiles[name] = buf; if (samePrefix) fs.writeFileSync(path.join(oldDir, name), buf); }   // 退避用の写しは同じプレフィックスのときだけ
    });

    const put = [], del = [];
    let unchanged = 0;
    for (const [name, buf] of Object.entries(newFiles)) {
      const old = oldFiles[name];
      if (!samePrefix || !old || sha256(old) !== sha256(buf)) put.push(name); else unchanged++;
    }
    if (samePrefix) for (const name of Object.keys(oldFiles)) if (!newFiles[name]) del.push(name);

    // 条の集合・見出し
    const oldArts = articleMap(oldFiles), newArts = articleMap(newFiles);
    const oldJou = [...oldArts.keys()], newJou = [...newArts.keys()];
    const sim = jaccard(oldJou, newJou);
    const renumber = oldJou.length >= 5 && newJou.length >= 5 && sim < 0.5;
    const dropRatio = oldJou.length ? (oldJou.length - newJou.length) / oldJou.length : 0;
    const newIndex = newFiles['_index.json'] ? JSON.parse(newFiles['_index.json'].toString('utf8')) : null;
    const oldIndex = oldFiles['_index.json'] ? JSON.parse(oldFiles['_index.json'].toString('utf8')) : null;

    // ベクトルの差分（ID と本文で比較。ファイル形式が変わっても本文が同じなら作り直さない）
    const toObj = (files) => { const o = {}; for (const [k, v] of Object.entries(files)) if (k !== '_index.json') { try { o[k] = JSON.parse(v.toString('utf8')); } catch { /* skip */ } } return o; };
    const oldRecs = new Map(paragraphRecords(lawId, toObj(oldFiles)).map((r) => [r.id, r]));
    const newRecs = paragraphRecords(lawId, toObj(newFiles));
    const upsert = [], vdel = [];
    const newIds = new Set(newRecs.map((r) => r.id));
    for (const r of newRecs) { const o = oldRecs.get(r.id); if (!o || o.text !== r.text) upsert.push(r); }
    for (const id of oldRecs.keys()) if (!newIds.has(id)) vdel.push(id);
    for (const r of upsert) embedOut.write(JSON.stringify(r) + '\n');

    // 紐付けの生存確認。「見直す対象」にするのは、この更新で条が消えて新たに浮く紐付けだけ
    // （改正前の条の集合にはあって、新しい集合に無い）。改正前から無い条番号を指す紐付け（削除済み条への判例・事例など）は
    // この更新で壊れるものではないので、参考として数えるだけで止めない（2026-09-27 の初回で 139 件・7 法令が全部これで止まった）
    const links = await linkedKeys(r2, lawId);
    const dangling = {}, danglingPre = {}, captionChanged = {};
    for (const [kind, keys] of Object.entries(links)) {
      const miss = keys.filter((k) => !newArts.has(k));
      const fresh = miss.filter((k) => oldArts.has(k)), pre = miss.filter((k) => !oldArts.has(k));
      if (fresh.length) dangling[kind] = fresh;
      if (pre.length) danglingPre[kind] = pre;
      const capc = keys.filter((k) => newArts.has(k) && oldArts.has(k) && oldArts.get(k).caption !== newArts.get(k).caption);
      if (capc.length) captionChanged[kind] = capc;
    }
    const danglingCount = Object.values(dangling).reduce((s, a) => s + a.length, 0);
    const danglingPreCount = Object.values(danglingPre).reduce((s, a) => s + a.length, 0);

    const entry = {
      law_title: (newIndex && newIndex.law_title) || (oldIndex && oldIndex.law_title) || '',
      is_new: oldNames.length === 0,
      old_files: oldNames.length, new_files: Object.keys(newFiles).length,
      put, delete: del, unchanged,
      articles_old: oldJou.length, articles_new: newJou.length, title_similarity: Number(sim.toFixed(3)), renumber,
      links_total: Object.fromEntries(Object.entries(links).map(([k, v]) => [k, v.length])),
      dangling, dangling_preexisting: danglingPre, caption_changed: captionChanged,
      vectors: { upsert: upsert.length, delete: vdel, delete_count: vdel.length },
      toc_entries: newIndex && newIndex.toc ? newIndex.toc.length : 0,
    };
    if (Object.keys(newFiles).length === 0) blockers.push({ kind: 'no_new_files', law_id: lawId });
    if (!entry.is_new && dropRatio > CONFIG.limits.maxArticleDropRatio && oldJou.length >= 10) blockers.push({ kind: 'article_drop', law_id: lawId, law_title: entry.law_title, old: oldJou.length, new: newJou.length });
    laws[lawId] = entry;
    totals.put += put.length; totals.delete += del.length; totals.unchanged_files += unchanged;
    totals.vec_upsert += upsert.length; totals.vec_delete += vdel.length; totals.dangling += danglingCount; totals.dangling_preexisting += danglingPreCount; if (renumber) totals.renumber++;
    n++;
    if (n % 25 === 0) log(`  ${n}/${lawIds.length}`);
  });
  await new Promise((r) => embedOut.end(r));

  // 廃止された法令: 条文ファイルとベクトルを消す（2026-11-07 オーナー: 現行法令だけでいい・版ごとの法令は e-Gov で調べられる）。
  // 対象は「R2 に目次がある・新しい台帳に無い」法令（今週の removed と、前から残っている分）のうち、e-Gov の法令 API が廃止（repeal_status が None 以外）と答えたものだけ。
  // e-Gov に無い・読めない・廃止でないと答えた法令は消さずに残し、manifest の repeal_skipped に出す。
  // 例外: e-Gov に無い法令のうち、題名が「…の施行期日を定める政令」「…の政令で定める日等を定める政令」のもの（施行日を決めるだけの 1 文の政令。
  // e-Gov の法令 API はこの種類を載せない）は、退避してから消す（repeal_status 'NotInEgov'・2026-11-11 オーナー: 現行法令だけにそろえる）消すファイルは 07 が退避してから消し、ベクトルは 08 が値ごと退避してから消す（restore_backup.cjs で戻せる）
  const repealed = [], repealSkipped = [];
  // 比べる台帳は 02 が今回 e-Gov から取った一覧（sync_state.next.json）だけ（リポジトリの古い基準台帳では比べない）
  const ledgerNext = readJson(statePath('sync_state.next.json'), null);
  if (samePrefix && ledgerNext && ledgerNext.laws && Object.keys(ledgerNext.laws).length) {
    const inR2 = new Set();
    for (const o of await r2.list(`${oldPrefix}/`)) {
      const rest = o.key.slice(oldPrefix.length + 1).split('/');
      if (rest.length === 2 && rest[1] === '_index.json') inR2.add(rest[0]);
    }
    // 前の反映で消している途中に落ちた法令（07 が置いた控え。目次がもう消えていることがある）は、控えのファイル名・ベクトルの ID で消し直す（e-Gov はもう確かめてある）
    const pending = new Map();
    for (const o of await r2.list(`${CONFIG.repealPendingPrefix}/`)) {
      const pj = await r2.getJson(o.key);
      if (pj && pj.law_id && !ledgerNext.laws[pj.law_id] && !laws[pj.law_id]) pending.set(pj.law_id, pj);
    }
    const cands = [...inR2].filter((id) => !ledgerNext.laws[id] && !laws[id] && !pending.has(id)).sort();
    if (pending.size) log(`前の反映で消している途中だった法令 ${pending.size}: ${[...pending.keys()].join(' ')}`);
    if (cands.length) log(`台帳に無いのに条文が残っている法令 ${cands.length}: e-Gov で廃止かを確かめる`);
    for (const pj of pending.values()) repealed.push({ law_id: pj.law_id, repeal_status: pj.repeal_status || null, repeal_date: pj.repeal_date || null, law_title: pj.law_title || null, pending: pj });
    for (const lawId of cands) {
      let st;
      if (cands.indexOf(lawId) > 0) await sleep(SLEEP_MS);   // e-Gov に間を空けて読む
      try { st = await fetchLawStatus(lawId); } catch (e) { repealSkipped.push({ law_id: lawId, reason: 'e-Gov を読めない' }); continue; }
      if (!st) {
        const idx = await r2.getJson(`${oldPrefix}/${lawId}/_index.json`).catch(() => null);
        const title = idx && typeof idx.law_title === 'string' ? idx.law_title : '';
        if (SEKOU_RE.test(title)) { repealed.push({ law_id: lawId, repeal_status: 'NotInEgov', repeal_date: null, law_title: title }); continue; }
        repealSkipped.push({ law_id: lawId, reason: 'e-Gov に無い', ...(title ? { law_title: title } : {}) }); continue;
      }
      if (!st.repeal_status || st.repeal_status === 'None') { repealSkipped.push({ law_id: lawId, reason: `e-Gov では廃止でない（${st.repeal_status || '不明'}）`, law_title: st.law_title }); continue; }
      repealed.push({ law_id: lawId, repeal_status: st.repeal_status, repeal_date: st.repeal_date, law_title: st.law_title });
    }
    if (repealed.length > CONFIG.limits.maxRepealedLaws) blockers.push({ kind: 'too_many_repealed', count: repealed.length, limit: CONFIG.limits.maxRepealedLaws });
    await R2.pmap(repealed, Math.max(1, Math.floor(concurrency / 4)), async (rp) => {
      const lawId = rp.law_id;
      const lawPrefix = `${oldPrefix}/${lawId}/`;
      const oldNames = (await r2.list(lawPrefix)).map((o) => o.key.slice(lawPrefix.length)).filter((k) => k && !k.includes('/'));
      if (rp.pending) {
        // 消している途中の法令: 残っているファイルと、控えのベクトルの ID を全部消す（退避は前の回に済んでいる。残っているファイルは 07 がもう一度退避する）
        const pj = rp.pending;
        laws[lawId] = {
          law_title: rp.law_title || '', is_new: false, is_repeal: true, repeal_resume: true, repeal_status: rp.repeal_status, repeal_date: rp.repeal_date,
          old_files: oldNames.length, new_files: 0, put: [], delete: oldNames.sort(), unchanged: 0,
          articles_old: 0, articles_new: 0, title_similarity: 0, renumber: false, links_total: {}, dangling: {}, dangling_preexisting: {}, caption_changed: {},
          vectors: { upsert: 0, delete: pj.vector_ids || [], delete_count: (pj.vector_ids || []).length }, toc_entries: 0,
        };
        totals.delete += oldNames.length; totals.vec_delete += (pj.vector_ids || []).length;
        return;
      }
      const oldDir = ensureDir(statePath('old', lawId));
      const oldFiles = {};
      await R2.pmap(oldNames, 4, async (name) => {
        const buf = await r2.get(lawPrefix + name);
        if (buf) { oldFiles[name] = buf; fs.writeFileSync(path.join(oldDir, name), buf); }
      });
      if (Object.keys(oldFiles).length !== oldNames.length) throw new Error(`${lawPrefix} のファイルが読めない（一覧 ${oldNames.length}・読めた ${Object.keys(oldFiles).length}）。消す前の退避ができないので止める`);
      // 条文ファイルが JSON として読めなければ、そのファイルのベクトルの ID が分からない。ファイルだけ消すとベクトルが残り、目次も消えて次の回にも拾えないので、この法令は消さない
      const parsed = {}, broken = [];
      for (const [k, v] of Object.entries(oldFiles)) { if (k === '_index.json') continue; try { parsed[k] = JSON.parse(v.toString('utf8')); } catch { broken.push(k); } }
      // 目次に載った条文ファイルが R2 に無ければ、そのファイルのベクトルの ID も分からない（目次を消すと次の回にも拾えない）ので、この法令は消さない
      let idx = null;
      try { idx = JSON.parse(oldFiles['_index.json'].toString('utf8')); } catch { /* 下で扱う */ }
      const missing = idx && Array.isArray(idx.files) ? idx.files.map((f) => f && f.filename).filter((f) => f && !oldFiles[f]) : null;
      if (!missing) { repealSkipped.push({ law_id: lawId, reason: '目次（_index.json）が読めない・形が違う。ベクトルを消し漏らすので消さない', law_title: rp.law_title }); rp.skip = true; return; }
      if (missing.length) { repealSkipped.push({ law_id: lawId, reason: `目次に載った条文ファイルが R2 に無い（${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' ほか' : ''}）。ベクトルを消し漏らすので消さない`, law_title: rp.law_title }); rp.skip = true; return; }
      if (broken.length) { repealSkipped.push({ law_id: lawId, reason: `条文ファイルが JSON として読めない（${broken.slice(0, 3).join('、')}${broken.length > 3 ? ' ほか' : ''}）。ベクトルを消し漏らすので消さない`, law_title: rp.law_title }); rp.skip = true; return; }
      const vdel = paragraphRecords(lawId, parsed).map((r) => r.id);
      const links = await linkedKeys(r2, lawId);
      // _index.json は最初に消えるように先頭に置く（07 は delete を並べて消す。途中で落ちても目次が残って中身が無い状態を作りにくくする）
      const del = [...oldNames.filter((n) => n === '_index.json'), ...oldNames.filter((n) => n !== '_index.json').sort()];
      laws[lawId] = {
        law_title: rp.law_title || '',
        is_new: false, is_repeal: true, repeal_status: rp.repeal_status, repeal_date: rp.repeal_date,
        old_files: oldNames.length, new_files: 0,
        put: [], delete: del, unchanged: 0,
        articles_old: articleMap(oldFiles).size, articles_new: 0, title_similarity: 0, renumber: false,
        // 紐付け（通達・判例・事例と裁決・委任先）は消さない（その法令の条文ページが無くなるので画面には出なくなる）。件数だけ残す
        links_total: Object.fromEntries(Object.entries(links).map(([k, v]) => [k, v.length])),
        dangling: {}, dangling_preexisting: {}, caption_changed: {},
        vectors: { upsert: 0, delete: vdel, delete_count: vdel.length },
        toc_entries: 0,
      };
      totals.delete += del.length; totals.vec_delete += vdel.length;
    });
    for (let i = repealed.length - 1; i >= 0; i--) if (repealed[i].skip) repealed.splice(i, 1);
    for (const r of repealed) { delete r.skip; delete r.pending; }
    totals.repealed = repealed.length;
    if (repealed.length) log(`廃止された法令 ${repealed.length} を消す（ファイル・ベクトル。退避してから）: ${repealed.map((r) => r.law_id).join(' ')}`);
    if (repealSkipped.length) log(`台帳に無いが消さない法令 ${repealSkipped.length}: ${repealSkipped.map((r) => `${r.law_id}（${r.reason}）`).join(' ')}`);
  }

  // 見直す対象（書く前に人が見る。blockers と違い、確認して問題なければそのまま流せる）。もとから浮いていた紐付けは入れない。
  // 委任先だけの見出しの変化と廃止された法令は止める理由にしない（lib/common.cjs の isReviewLaw。廃止は e-Gov で確かめたものだけを退避してから消す）
  const reviewLaws = Object.entries(laws).filter(([, e]) => isReviewLaw(e)).map(([id]) => id);
  const manifest = {
    created_at: new Date().toISOString(),
    run_id: process.env.UPDATE_RUN_ID || null,
    mode: report.mode || 'diff',
    articles_prefix: prefix,
    old_articles_prefix: oldPrefix,
    refs_prefix: CONFIG.refsPrefix,
    totals,
    blockers,
    ok_to_apply: blockers.length === 0,
    needs_review: reviewLaws.length > 0,
    review_laws: reviewLaws,
    repealed: repealed.map((r) => r.law_id),
    repealed_info: repealed,
    repeal_skipped: repealSkipped,
    laws,
  };
  writeJson(statePath('manifest.json'), manifest, true);
  log(`\nput=${totals.put} delete=${totals.delete} unchanged=${totals.unchanged_files} | vectors upsert=${totals.vec_upsert} delete=${totals.vec_delete} | 新たに浮く紐付け=${totals.dangling}（もとから浮いていた=${totals.dangling_preexisting}） 振り直し疑い=${totals.renumber}`);
  log(blockers.length ? `BLOCKED: ${JSON.stringify(blockers).slice(0, 500)}` : 'blockers なし（apply 可）');
  if (manifest.needs_review) log(`要確認: 見直す対象 ${reviewLaws.length} 法令（書く前に人が見る）。廃止で消す法令 ${repealed.length}`);
  log(`→ ${statePath('manifest.json')}`);
}
main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
