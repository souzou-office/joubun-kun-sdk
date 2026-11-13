// 通達の週次更新 段 3a: 今回の写しから作り直し、今の本番と比べて「反映したら何が変わるか」を作る（docs/tsutatsu_hanrei_weekly.md）。
//
//   node scripts/tsutatsu/weekly/run.cjs build     （crawl の後に同じ作業フォルダで流す）
//
// **書かない**: R2 にも Vectorize にも書かない（読むだけ）。反映（段 3b）は別。
//
// 前回の作り直しの状態（K: ドライブの items・割当・PDF の本文）は使わない。今の本番（R2 の tsutatsu_chunks_{本番}）を
// 「前回の作り直しの結果」として読み、そこから引き継ぐ:
//   - PDF の通達: 本番のチャンクの PDF（url・題名・廃止・どの条に付いているか）をそのまま引き継ぐ（20_recover と同じ）。
//     本番に無い新しい PDF だけ 05（pdfplumber）で本文から引用を抜く
//   - 機械で紐付かない HTML の通達（浮き）: 本番で同じ url・同じ番号・同じ見出しの通達が付いていた条を引き継ぐ（19_recover と同じ。
//     前回の LLM の割当もこれで引き継がれる）。それでも付かない浮きは本番にも出ないので報告に並べない（前回より 50 本超増えたときだけ見直す対象。LLM は使わない）
//   - 03（HTML の解析）・07（紐付け）・08（チャンク）は今までの実物をそのまま流す
// ベクトルは、紐付けの表と通達の本文から「あるべきベクトル」を 21_gen_vec_input と同じ作り方で全部計算し、
// 前回反映した状態（R2 update_state/tsutatsu/vec_state.json。項目ごとの本文と metadata の hash）と比べて、
// 新しい・本文が変わった（埋め込み直す）・metadata だけ変わった・消えた、に分ける。埋め込みは Workers AI（bge-m3）。
// vec_state が無い初回は、Vectorize に実物があるかを get_by_ids で確かめて作る（本文は今の本番と同じとみなす）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { R2 } = require('../../update/lib/r2.cjs');
const { makeGenGuard } = require('../../update/lib/delta_apply.cjs');
const { Vectorize } = require('../../update/lib/vectorize.cjs');
const { Embedder, cosine } = require('../../update/lib/ai.cjs');
const { buildPageTitles } = require('../page_titles.cjs');   // ページの見出し（pages.json）

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TSU_DIR = path.resolve(__dirname, '..');
const VEC_INDEX = 'tsutatsu-embeddings-v1';
const VEC_THRESHOLD = 70;                 // 21 と同じ（巨大条文の閾値）
const META_LIMIT = 10 * 1024;             // Vectorize の metadata の上限
const MAX_EMBED = Number(process.env.TSU_MAX_EMBED || 2000);          // これを超える埋め込みは見直す対象
const MAX_CHANGED_FILES = Number(process.env.TSU_MAX_CHANGED_FILES || 10);
const LOCAL_VER = 'weekly';               // 08 の出力先 tsutatsu_chunks_weekly（作業フォルダの中）
const VEC_STATE_KEY = 'update_state/tsutatsu/vec_state.json';
const BUILD_STATE_KEY = 'update_state/tsutatsu/build_state.json';
const APPLY_LOCK_KEY = 'update_state/tsutatsu_apply_inprogress.json';   // 反映・戻しの作業中の印（apply.cjs）

const log = (...a) => console.log(...a);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const norm = (s) => String(s || '').replace(/[−–—―ー－]/g, '-').replace(/\s/g, '').trim();
const stableJson = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  : Array.isArray(o) ? `[${o.map(stableJson).join(',')}]` : JSON.stringify(o));
// 各段の出力は厳しく読む（無い・壊れた行があれば、その通達が消えたものとして差分を作らないよう、ファイル名と行番号を出して止める）
function readNdjson(f, { required = true } = {}) {
  if (!fs.existsSync(f)) {
    if (required) throw new Error(`${path.basename(f)} が無い（前の段の出力が欠けている）。書かずに止める`);
    return [];
  }
  return fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [l, i]).filter(([l]) => l.trim()).map(([l, i]) => {
    try { return JSON.parse(l); } catch { throw new Error(`${path.basename(f)} の ${i + 1} 行目が読めない（壊れている）。書かずに止める`); }
  });
}
function readJsonStrict(f) {
  if (!fs.existsSync(f)) throw new Error(`${path.basename(f)} が無い（前の段の出力が欠けている）。書かずに止める`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new Error(`${path.basename(f)} が JSON として読めない（壊れている）。書かずに止める`); }
}
const writeNdjson = (f, arr) => fs.writeFileSync(f, arr.map((o) => JSON.stringify(o)).join('\n') + (arr.length ? '\n' : ''));

// 本番が読んでいる通達のプレフィックス（wrangler.toml の TSUTATSU_CHUNKS_PREFIX）。確かめ用に TSU_PROD_PREFIX で上書きできる
function prodPrefix() {
  if (process.env.TSU_PROD_PREFIX) return process.env.TSU_PROD_PREFIX;
  const toml = fs.readFileSync(path.join(REPO_ROOT, 'wrangler.toml'), 'utf8');
  const m = toml.match(/^\s*TSUTATSU_CHUNKS_PREFIX\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('wrangler.toml に TSUTATSU_CHUNKS_PREFIX が無い');
  return m[1];
}

// 21 と同じく、16_embed_reverse から jou2title / LAW_NAME を実物のまま借りる（写しを書かない）
function loadFrom16() {
  const src = fs.readFileSync(path.join(TSU_DIR, '16_embed_reverse.cjs'), 'utf8');
  const lawName = (src.match(/const LAW_NAME = \{[\s\S]*?\n\};/) || [])[0];
  const intToKanji = (src.match(/function intToKanji\([\s\S]*?\n\}/) || [])[0];
  const jou2title = (src.match(/function jou2title\([\s\S]*?\n\}/) || [])[0];
  if (!lawName || !intToKanji || !jou2title) throw new Error('16_embed_reverse から関数を取り出せない');
  return new Function(`${lawName}\n${intToKanji}\n${jou2title}\nreturn { LAW_NAME, jou2title };`)();
}

// 「あるべきベクトル」を全部出す（21_gen_vec_input の巨大条文と _reverse の作り方と同じ。id・text・metadata を 1 文字も変えない）
//   links: 07 の出力 { "<law_id>:<条>": [ref] }、itemMap: (source_url|tsutatsu_no) -> {body, caption}
function desiredVectors(links, itemMap, { LAW_NAME, jou2title }) {
  const out = new Map();   // id -> { id, namespace, text, metadata }
  for (const [key, refs] of Object.entries(links)) {
    const uniqNos = new Set(refs.map((r) => norm(r.tsutatsu_no || r.title)));
    if (uniqNos.size <= VEC_THRESHOLD) continue;
    const i = key.indexOf(':');
    const lawId = key.slice(0, i), jou = key.slice(i + 1);
    for (const r of refs) {
      const no = r.tsutatsu_no || r.title || ''; if (!no) continue;
      const id = md5(`${lawId}:${jou}:${no}`);
      if (out.has(id)) continue;
      const it = itemMap[`${r.source_url}|${r.tsutatsu_no}`] || {};
      const text = (`${it.caption || ''} ${(it.body || '').slice(0, 4000)}`).trim() || String(no);
      out.set(id, { id, namespace: key, text, metadata: { no: String(no) } });
    }
  }
  const byTsu = {};
  for (const [key, refs] of Object.entries(links)) {
    for (const r of refs) {
      if (r.source !== 'html') continue;
      const k = `${r.source_url}|${r.tsutatsu_no}`;
      const it = itemMap[k];
      if (!it || !it.body || it.body.length < 20) continue;
      const id = md5('rev|' + k);
      if (!byTsu[id]) {
        const flat = it.body.replace(/\s+/g, ' ').trim();
        const snip = (flat.match(/^.{0,120}?。/) || [flat.slice(0, 100)])[0];
        byTsu[id] = { no: String(r.tsutatsu_no), cap: (it.caption || '').slice(0, 80), snip, src: r.source_url || '',
          text: `${it.caption || ''} ${it.body.slice(0, 1500)}`.trim(), homes: new Set() };
      }
      byTsu[id].homes.add(key);
    }
  }
  for (const [id, t] of Object.entries(byTsu)) {
    const homes = [...t.homes].map((hk) => { const i = hk.indexOf(':'); const lid = hk.slice(0, i), jou = hk.slice(i + 1); return { l: lid, n: LAW_NAME[lid] || lid, a: jou2title(jou) }; });
    out.set(id, { id, namespace: '_reverse', text: t.text, metadata: { no: t.no, cap: t.cap, snip: t.snip || '', src: t.src, homes: JSON.stringify(homes) } });
  }
  return out;
}
const vecSig = (v) => ({ ns: v.namespace, th: sha(v.text), mh: sha(stableJson(v.metadata)) });

// 本番のチャンクから、前回の反映で入っていたはずのベクトルの id と、その埋め込み元の本文の hash を出す
//   （初回の状態づくりに使う。本文は 21 と同じ作り方で組み立て直す。チャンクは見出しを丸ごと・本文を 4,000 字まで持つので、
//    巨大条文の text＝見出し＋本文 4,000 字、_reverse の text＝見出し＋本文 1,500 字 をそのまま作れる）
//   → Map id -> { ns, th }
function prodVectorIds(prodLaws) {
  const ids = new Map();
  for (const [lawId, arts] of Object.entries(prodLaws)) {
    for (const [jou, arr] of Object.entries(arts)) {
      if (!Array.isArray(arr)) continue;
      const key = `${lawId}:${jou}`;
      const nos = new Set(arr.map((t) => norm(t.no || t.title)));
      if (nos.size > VEC_THRESHOLD) {
        for (const t of arr) {
          const no = String(t.no || t.title || ''); if (!no) continue;
          const id = md5(`${key}:${no}`);
          if (ids.has(id)) continue;
          const text = t.src === 'html' ? (`${t.cap || ''} ${String(t.body || '').slice(0, 4000)}`.trim() || no) : no;
          ids.set(id, { ns: key, th: sha(text) });
        }
      }
      for (const t of arr) {
        if (t.src !== 'html' || !t.url || !t.no || String(t.body || '').length < 20) continue;
        const id = md5(`rev|${t.url}|${t.no}`);
        if (!ids.has(id)) ids.set(id, { ns: '_reverse', th: sha(`${t.cap || ''} ${String(t.body).slice(0, 1500)}`.trim()) });
      }
    }
  }
  return ids;
}

function runProc(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    // シグナルで落ちた（メモリ不足の SIGKILL など）ときは code が null になる。0 のときだけ成功（null を成功扱いしない）
    p.on('close', (code, signal) => resolve(code === 0 ? 0 : (code == null ? `signal ${signal || '?'}` : code)));
    p.on('error', () => resolve(127));
  });
}

async function build({ out, stamp, rid, gen = null }) {
  const work = path.join(out, 'work');
  const scripts = path.join(work, 'scripts', 'tsutatsu');
  const state = path.join(scripts, 'state');
  const B = path.join(out, 'build');
  fs.rmSync(B, { recursive: true, force: true });
  fs.mkdirSync(path.join(B, 'files'), { recursive: true });
  if (!fs.existsSync(path.join(work, `all_tsutatsu_${stamp}`))) throw new Error(`今回の写し all_tsutatsu_${stamp} が作業フォルダに無い（crawl が基準を更新した回だけ build する）`);
  // TSU_BUILD_SCRIPTS: 確かめ用に 03・07・08 の代わりを渡す（check_weekly.cjs。本番では付けない）
  const src = process.env.TSU_BUILD_SCRIPTS || TSU_DIR;
  for (const f of ['03_parse.cjs', '07_build_links.cjs', '08_build_chunks.cjs']) fs.copyFileSync(path.join(src, f), path.join(scripts, f));
  const report = { blockers: [], review: [], notes: [] };
  const r2 = new R2();
  const PROD = prodPrefix();
  log(`本番の通達: ${PROD}`);
  // 反映か戻しが途中で止まっていれば、本番が書きかけなので比べない（下見の結果を反映の元にしない）
  const genGuard = await makeGenGuard(r2, APPLY_LOCK_KEY);   // 世代 → 印の順に読む。読み終えるまでに反映・戻しが入ったら、この下見は使わない
  const lock = genGuard.lock;
  if (lock) report.blockers.push(`前回の通達の${lock.kind === 'restore' ? '戻し' : '反映'}（run ${lock.run_id}・${lock.phase}・${lock.started_at} 開始）が途中で止まっている（${APPLY_LOCK_KEY} が残っている）。Actions の Update tsutatsu data を mode=restore・restore_run_id=${lock.run_id} で戻してから流し直す`);

  // ---- 1. HTML の解析（03）
  if (await runProc(process.execPath, [path.join(scripts, '03_parse.cjs'), '--snapshot', stamp], { cwd: work })) throw new Error('03_parse が落ちた');
  const items = readNdjson(path.join(state, `tsutatsu_items_${stamp}.ndjson`));
  if (!items.length) throw new Error(`tsutatsu_items_${stamp}.ndjson が空（03 が通達を 1 本も取れなかった）。書かずに止める`);
  const itemMap = {};
  for (const o of items) itemMap[`${o.source_url}|${o.tsutatsu_no}`] = { body: o.body || '', caption: o.caption || '' };

  // ---- 2. 本番のチャンクを読む
  // index.json は 1 回だけ読み、同じ中身を比べる元と退避の hash（sha_before）の両方に使う（間で本番が変わっても取り違えない）
  const prodIndexBuf = await r2.get(`${PROD}/index.json`);
  let prodIndex = null;
  try { prodIndex = prodIndexBuf ? JSON.parse(prodIndexBuf.toString('utf8')) : null; } catch { prodIndex = null; }
  if (!prodIndex || !prodIndex.laws) throw new Error(`本番の ${PROD}/index.json が読めない`);
  const prodLaws = {};
  const prodRaw = {};
  for (const lawId of Object.keys(prodIndex.laws)) {
    const buf = await r2.get(`${PROD}/${lawId}.json`);
    if (!buf) throw new Error(`本番の ${PROD}/${lawId}.json が無い（index.json には載っている）`);
    prodRaw[lawId] = buf;
    prodLaws[lawId] = JSON.parse(buf.toString('utf8'));
  }

  // ---- 3. PDF の通達: 本番から引き継ぐ（20）＋本番に無い新しい PDF だけ 05
  const prodPdf = new Map();   // url -> {title, ab, grp, arts:Set}
  for (const [lawId, arts] of Object.entries(prodLaws)) {
    for (const [jou, arr] of Object.entries(arts)) {
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        if (t.src !== 'pdf' || !t.url) continue;
        if (!prodPdf.has(t.url)) prodPdf.set(t.url, { title: t.title || '', ab: !!t.ab, grp: t.grp || '', arts: new Set() });
        const e = prodPdf.get(t.url);
        if (t.title && !e.title) e.title = t.title;
        e.arts.add(`${lawId}:${jou}`);
      }
    }
  }
  const titles = {};
  for (const [u, v] of prodPdf) if (v.title) titles[u] = v.title;
  fs.writeFileSync(path.join(state, 'pdf_titles_v2.json'), JSON.stringify(titles));   // 07 が読む名前（中身は本番の PDF の題名）
  const pmanAll = readNdjson(path.join(state, `pdf_manifest_${stamp}.ndjson`));
  const pman = pmanAll.filter((r) => !r.error && r.local_path);
  const newPdf = pman.filter((r) => !prodPdf.has(r.url));
  // 本番にある PDF のうち、今回の取り直しに無いもの（国税庁から消えた）は外す（取れなかっただけのものは manifest に error で載るので残す）
  const present = new Set(pmanAll.map((r) => r.url));
  const pdfGone = [...prodPdf.keys()].filter((u) => !present.has(u)).sort();
  for (const u of pdfGone) prodPdf.delete(u);
  // 本番にある PDF のうち、中身が変わったもの。紐付けは本番のまま引き継ぎ（読み直した引用で付け替えると前回の割当を失う）、見直す対象にする。
  //   比べる元: 前回反映したときの PDF の hash（build_state.json の pdf_hashes）。まだ無ければ前回の取り直しとの差（summary.json）
  const ledger = readJsonStrict(path.join(state, 'pdf_ledger.json'));
  const curHashes = {};   // 今回取れた PDF の中身の hash
  for (const r of pman) if (ledger[r.url] && ledger[r.url].content_hash) curHashes[r.url] = ledger[r.url].content_hash;
  const prevBuildBuf = await r2.get(BUILD_STATE_KEY);
  const prevBuild = prevBuildBuf ? JSON.parse(prevBuildBuf.toString('utf8')) : null;
  const prevHashes = (prevBuild && prevBuild.pdf_hashes) || null;
  // 次の比べる元: 今回取れたものは今回の hash、取れなかった既存の PDF は前回反映したときの hash を持ち越す（取れなかった回で比べる元を失わない）。消えた PDF は落とす
  const pdfHashes = {};
  if (prevHashes) for (const u of prodPdf.keys()) if (prevHashes[u]) pdfHashes[u] = prevHashes[u];
  Object.assign(pdfHashes, curHashes);
  let pdfChanged;
  // 前回の hash が無い既存の PDF（前回取れなかった等）は、今回取れたら「変わっていない」とせず見直す対象にする。今回取れなかったものは比べない（hash は持ち越す）
  if (prevHashes) pdfChanged = [...prodPdf.keys()].filter((u) => curHashes[u] && prevHashes[u] !== curHashes[u]);
  else {
    const sum = readJsonStrict(path.join(out, 'summary.json'));
    pdfChanged = ((sum.pdf && sum.pdf.changed) || []).map((x) => x.url).filter((u) => prodPdf.has(u));
  }
  pdfChanged.sort();
  const pdfItems = [...prodPdf.entries()].map(([url, v]) => ({ url, title: v.title, abolished: v.ab, circular_path: v.grp, citations: [], recovered_arts: [...v.arts], recovered_from: `r2_${PROD}` }));
  let newPdfItems = [];
  let pdfUnreadable = null;   // 読めなかった新しい PDF の数（読まなかった回は null）
  if (newPdf.length) {
    const py = process.env.TSU_PYTHON || 'python3';
    if (process.env.TSU_SKIP_PDF_TEXT === '1') {
      report.notes.push(`新しい PDF ${newPdf.length} 本の本文を読まなかった（TSU_SKIP_PDF_TEXT。確かめ用）`);
    } else {
      // 新しい PDF だけを別の作業フォルダに写して 05 を流す（05 はスナップショットの PDF を全部読むので）
      const pr = path.join(out, 'pdf05');
      fs.rmSync(pr, { recursive: true, force: true });
      fs.mkdirSync(path.join(pr, 'scripts', 'tsutatsu'), { recursive: true });
      fs.copyFileSync(path.join(TSU_DIR, '05_extract_pdf_text.py'), path.join(pr, 'scripts', 'tsutatsu', '05_extract_pdf_text.py'));
      for (const r of newPdf) {
        const dst = path.join(pr, r.local_path.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(work, r.local_path.split('/').join(path.sep)), dst);
      }
      const code = await runProc(py, [path.join(pr, 'scripts', 'tsutatsu', '05_extract_pdf_text.py'), '--snapshot', stamp], { cwd: pr });
      if (code) report.blockers.push(`05（新しい PDF ${newPdf.length} 本の本文の読み取り）が落ちた（exit ${code}。python と pdfplumber が要る）`);
      if (!code) {
        // 頼んだ PDF ごとに結果を確かめる（1 本ずつの読み取り失敗・結果の欠け・形の違いを黙って捨てない。見直す対象にして止める）
        const outRows = readNdjson(path.join(pr, 'scripts', 'tsutatsu', 'state', `pdf_items_${stamp}.ndjson`));
        const byPath = new Map(outRows.map((o) => [o.local_path, o]));
        const bad = [];
        for (const r of newPdf) {
          const o = byPath.get(r.local_path);
          if (!o) { bad.push(`${r.url}（結果が無い）`); continue; }
          if (o.error) { bad.push(`${r.url}（読めない: ${String(o.error).slice(0, 80)}）`); continue; }
          if (o.url !== r.url || typeof o.title !== 'string' || !Array.isArray(o.citations)) { bad.push(`${r.url}（結果の形が違う）`); continue; }
          newPdfItems.push(o);
        }
        // 読めない PDF（スキャン画像など。2026-10 で約 770 本）は紐付けないだけで、本番にも無い。毎週同じものを出さず、
        // 前回反映したときより 50 本超増えたときだけ見直す対象にする（読み取りが崩れた疑い。下の「8.」）
        pdfUnreadable = bad.length;
        if (bad.length) log(`新しい PDF ${newPdf.length} 本のうち ${bad.length} 本を読めなかった（紐付けない）: ${bad.slice(0, 3).join('、')}${bad.length > 3 ? ' ほか' : ''}`);
      }
    }
  }
  writeNdjson(path.join(state, `pdf_items_${stamp}.ndjson`), [...pdfItems, ...newPdfItems]);

  // ---- 4. 紐付け（07）→ 浮きを本番から引き継ぐ（19）→ もう一度 07
  // 1 回目の 07 は必ず機械の紐付けだけで流す（同じ作業フォルダで流し直したとき、前回戻した割当を読んで浮きから外れ、
  // その後の割当の上書きで消えるのを防ぐ）
  fs.rmSync(path.join(state, `tsutatsu_assignments_${stamp}.json`), { force: true });
  if (await runProc(process.execPath, [path.join(scripts, '07_build_links.cjs'), stamp], { cwd: work })) throw new Error('07_build_links が落ちた');
  const orphans = readJsonStrict(path.join(state, `tsutatsu_orphans_${stamp}.json`));
  const prevByKey = new Map();   // url|番号 -> [{law_id, jou, cap}]
  for (const [lawId, arts] of Object.entries(prodLaws)) {
    for (const [jou, arr] of Object.entries(arts)) {
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        const k = `${t.url || ''}|${norm(t.no)}`;
        if (!prevByKey.has(k)) prevByKey.set(k, []);
        prevByKey.get(k).push({ law_id: lawId, jou, cap: t.cap || '' });
      }
    }
  }
  const assignments = {};
  let recovered = 0;
  const remain = [];
  const extraHomes = [];   // 本番で 2 つ以上の条に付いていた浮き: 07 の割当は 1 条だけなので、残りの条は 07 の後に links へ足す
  for (const o of orphans) {
    const hits = prevByKey.get(`${o.source_url || ''}|${norm(o.no)}`) || [];
    const cap = String(o.caption || '').trim();
    const ok = hits.filter((h) => !cap || !h.cap || h.cap.trim() === cap);   // 見出しが変わっていたら引き継がない（19 と同じ）
    if (!ok.length) { remain.push(o); continue; }
    assignments[`${o.source_path}#${o.no}`] = { law_id: ok[0].law_id, article: ok[0].jou, conf: 'recovered' };
    const keys = [...new Set(ok.map((h) => `${h.law_id}:${h.jou}`))];
    if (keys.length > 1) extraHomes.push({ url: o.source_url || '', no: String(o.no), first: keys[0], rest: keys.slice(1) });
    recovered++;
  }
  fs.writeFileSync(path.join(state, `tsutatsu_assignments_${stamp}.json`), JSON.stringify(assignments, null, 1));
  if (await runProc(process.execPath, [path.join(scripts, '07_build_links.cjs'), stamp], { cwd: work })) throw new Error('07_build_links（2 回目）が落ちた');
  const linksFile = path.join(state, `article_tsutatsu_links_${stamp}.json`);
  const links = readJsonStrict(linksFile);
  // 2 条目以降の紐付けを戻す（07 が 1 条目に置いた ref を写す。同じ条に同じ url・番号が既にあれば足さない）
  let extraAdded = 0;
  for (const e of extraHomes) {
    const src = (links[e.first] || []).find((r) => r.source === 'html' && r.source_url === e.url && norm(r.tsutatsu_no) === norm(e.no));
    if (!src) continue;
    for (const k of e.rest) {
      const arr = links[k] || (links[k] = []);
      if (arr.some((r) => r.source === 'html' && r.source_url === e.url && norm(r.tsutatsu_no) === norm(e.no))) continue;
      arr.push({ ...src, cited_article: k.slice(k.indexOf(':') + 1) });
      extraAdded++;
    }
  }
  if (extraAdded) {
    fs.writeFileSync(linksFile, JSON.stringify(links));
    report.notes.push(`本番で 2 つ以上の条に付いていた浮き ${extraHomes.length} 本の、2 条目以降 ${extraAdded} 本の紐付けを戻した`);
  }
  const orphansAfter = readJsonStrict(path.join(state, `tsutatsu_orphans_${stamp}.json`));

  // ---- 5. チャンク（08）
  if (await runProc(process.execPath, [path.join(scripts, '08_build_chunks.cjs'), stamp], { cwd: work, env: { ...process.env, TSU_VER: LOCAL_VER } })) throw new Error('08_build_chunks が落ちた');
  const chunkDir = path.join(work, `tsutatsu_chunks_${LOCAL_VER}`);
  const newIndex = readJsonStrict(path.join(chunkDir, 'index.json'));
  if (!newIndex.laws || typeof newIndex.laws !== 'object') throw new Error('08 の index.json に laws が無い。書かずに止める');

  // ---- 6. 本番と比べる（法令ファイルごと）
  const files = {};        // R2 のキー -> { sha_before, local }
  const changedLaws = [], addedLaws = [];
  const articleDrops = [];
  let refsProd = 0, refsNew = 0;
  for (const v of Object.values(prodIndex.laws)) refsProd += v.refs || 0;
  for (const v of Object.values(newIndex.laws)) refsNew += v.refs || 0;
  for (const lawId of Object.keys(newIndex.laws)) {
    const fp = path.join(chunkDir, `${lawId}.json`);
    const now = readJsonStrict(fp);   // index に載っているのにファイルが無い・壊れている → 止める
    const buf = fs.readFileSync(fp);
    const before = prodLaws[lawId];
    if (before && stableJson(before) === stableJson(now)) continue;
    const key = `${PROD}/${lawId}.json`;
    fs.writeFileSync(path.join(B, 'files', `${lawId}.json`), buf);
    files[key] = { sha_before: prodRaw[lawId] ? sha(prodRaw[lawId]) : null, local: `files/${lawId}.json` };
    (before ? changedLaws : addedLaws).push(lawId);
    if (before) {
      for (const [jou, arr] of Object.entries(before)) {
        const n0 = Array.isArray(arr) ? arr.length : 0, n1 = Array.isArray(now[jou]) ? now[jou].length : 0;
        if (n0 > 0 && n1 < n0 * 0.7) articleDrops.push(`${lawId}:${jou}（${n0} → ${n1}）`);   // 1 本だけの条から消えたときも出す
      }
    }
  }
  const lostLaws = Object.keys(prodIndex.laws).filter((l) => !newIndex.laws[l]);
  // index.json は法令の一覧（Worker が先に読む）。法令ファイルが変わった回か、一覧が変わった回に書く。消えた法令のファイルは残す（index で外れる）
  const indexChanged = stableJson(prodIndex.laws) !== stableJson(newIndex.laws);
  if (indexChanged || Object.keys(files).length) {
    fs.copyFileSync(path.join(chunkDir, 'index.json'), path.join(B, 'files', 'index.json'));
    files[`${PROD}/index.json`] = { sha_before: sha(prodIndexBuf), local: 'files/index.json' };
  }

  // ---- 6b. ページの見出し（{PROD}/pages.json。URL → 見出し。scripts/tsutatsu/page_titles.cjs）
  //   通達のデータに出てくるページだけ。法令ファイルとは別に、変わったときだけ書く（index.json は巻き込まない）。
  //   初めて書く回は見直す対象にする（オーナーの「反映」で書く）。通達の 9 割に見出しが付かなければ書かない（取り込みの崩れ）
  const pagesKey = `${PROD}/pages.json`;
  const chunkUrls = new Set();
  for (const lawId of Object.keys(newIndex.laws)) for (const arr of Object.values(readJsonStrict(path.join(chunkDir, `${lawId}.json`)))) for (const t of arr || []) if (t && t.url) chunkUrls.add(t.url);
  const pages = buildPageTitles(path.join(work, `all_tsutatsu_${stamp}`), { urls: chunkUrls });
  const pagesBuf = Buffer.from(JSON.stringify(pages));
  const prodPagesBuf = await r2.get(pagesKey);
  let pagesState = 'same';
  const covered = Object.keys(pages).length / Math.max(1, chunkUrls.size);
  if (covered < 0.9) {
    pagesState = 'skipped';
    report.notes.push(`ページの見出しが通達のページの ${Math.round(covered * 100)}%（${Object.keys(pages).length} / ${chunkUrls.size}）にしか付かないので、pages.json は書かない（取り込みの崩れの疑い）`);
  } else if (!prodPagesBuf || sha(prodPagesBuf) !== sha(pagesBuf)) {
    fs.writeFileSync(path.join(B, 'files', 'pages.json'), pagesBuf);
    files[pagesKey] = { sha_before: prodPagesBuf ? sha(prodPagesBuf) : null, local: 'files/pages.json' };
    pagesState = prodPagesBuf ? 'changed' : 'new';
    if (!prodPagesBuf) report.review.push(`初回: ページの見出し（${pagesKey}・${Object.keys(pages).length} ページ）を新しく書く`);
  }

  // ---- 7. ベクトル（あるべき全体を出し、前回反映した状態と比べる）
  const desired = desiredVectors(links, itemMap, loadFrom16());
  const tooBig = [...desired.values()].filter((v) => Buffer.byteLength(JSON.stringify(v.metadata)) > META_LIMIT);
  if (tooBig.length) report.blockers.push(`metadata が 10KiB を超えるベクトルが ${tooBig.length} 本（例 ${tooBig[0].id}）`);
  const vec = new Vectorize({ index: VEC_INDEX });
  const stateBuf = await r2.get(VEC_STATE_KEY);
  let vecState = stateBuf ? JSON.parse(stateBuf.toString('utf8')) : null;
  const firstRun = !vecState;
  if (firstRun) {
    // 初回: Vectorize に実物があるかを確かめて状態を作る（あるものは本文が今の本番と同じとみなし、metadata は実物の値で比べる）
    report.review.push('初回: 反映した状態の控え（vec_state.json）が無いので、Vectorize の実物を get_by_ids で確かめて作った。埋め込み元の本文は本番のチャンクから組み立て直して比べた（組み立て直せないものは埋め込み直す）');
    const prodIds = prodVectorIds(prodLaws);
    const cand = new Map([...prodIds].map(([id, v]) => [id, v.ns]));
    for (const [id, v] of desired) if (!cand.has(id)) cand.set(id, v.namespace);
    const ids = [...cand.keys()];
    vecState = {};
    const PACE = Number(process.env.TSU_VEC_PACE_MS || 400);
    for (let i = 0; i < ids.length; i += 20) {
      const got = await vec.getByIds(ids.slice(i, i + 20));
      for (const g of got) {
        // 本文の hash は本番のチャンクから組み立て直したもの。組み立て直せない（本番のチャンクに無い＝連結・日付版など）ものは null＝本文不明で埋め込み直す
        const pv = prodIds.get(g.id);
        vecState[g.id] = { ns: pv ? pv.ns : cand.get(g.id), th: pv ? pv.th : null, mh: sha(stableJson(g.metadata || {})) };
      }
      if (PACE && !vec.fakeFile) await new Promise((r) => setTimeout(r, PACE));
    }
    report.notes.push(`初回の確かめ: 候補 ${ids.length} 本のうち Vectorize にあった ${Object.keys(vecState).length} 本`);
  }
  const upserts = [], metaUpdates = [], deletes = [];
  const nextState = {};
  for (const [id, v] of desired) {
    const s = vecSig(v);
    nextState[id] = s;
    const cur = vecState[id];
    if (!cur || cur.th === null || cur.th !== s.th || cur.ns !== s.ns) upserts.push({ ...v, why: !cur ? 'new' : 'text' });
    else if (cur.mh !== s.mh) metaUpdates.push({ id, namespace: v.namespace, metadata: v.metadata });
  }
  for (const [id, cur] of Object.entries(vecState)) if (!desired.has(id)) deletes.push({ id, namespace: cur.ns });
  if (upserts.length > MAX_EMBED) report.review.push(`埋め込むベクトルが ${upserts.length} 本（${MAX_EMBED} 本超）`);

  // 埋め込み（Workers AI）と、ずれの確かめ（変わっていない既存 5 本を埋め込み直して実物と比べる）
  const emb = new Embedder();
  // 多すぎるときは埋め込まずに止める（途中で切ると、反映したときに一部だけ古いまま残る）
  const HARD_MAX = MAX_EMBED * 5;
  if (upserts.length > HARD_MAX) report.blockers.push(`埋め込むベクトルが ${upserts.length} 本（${HARD_MAX} 本超）。状態の控えか紐付けが崩れている疑い`);
  const toEmbed = upserts.length > HARD_MAX ? [] : upserts;
  const values = toEmbed.length ? await emb.embed(toEmbed.map((u) => u.text)) : [];
  // why: new＝今の索引に無いはず／text＝今の索引にあるはず（反映の段 3b が、あるはずのものを退避できるまで書かない）
  const vectors = toEmbed.map((u, i) => ({ id: u.id, namespace: u.namespace, values: values[i], metadata: u.metadata, why: u.why }));
  const samples = [...desired.values()].filter((v) => vecState[v.id] && vecState[v.id].th === sha(v.text)).slice(0, 5);
  if (samples.length) {
    const got = new Map((await vec.getByIds(samples.map((s) => s.id))).map((g) => [g.id, g]));
    const re = await emb.embed(samples.map((s) => s.text));
    const cos = samples.map((s, i) => (got.get(s.id) && Array.isArray(got.get(s.id).values) ? cosine(re[i], got.get(s.id).values) : NaN));
    const bad = cos.filter((c) => !Number.isFinite(c) || c < 0.98);
    report.notes.push(`埋め込みの自己一致: ${cos.map((c) => (Number.isFinite(c) ? c.toFixed(4) : '取れない')).join(' / ')}`);
    if (bad.length) report.blockers.push(`埋め込みのずれ: 既存 ${samples.length} 本のうち ${bad.length} 本が 0.98 未満（Workers AI の出力が索引と合わない。AI_POOLING を確かめる）`);
    if (samples.length < 3) report.review.push(`埋め込みのずれを ${samples.length} 本しか確かめられなかった`);
  } else if (upserts.length) report.review.push('埋め込みのずれを確かめる既存のベクトルが無かった');

  // ---- 8. 止める条件・見直す対象
  if (lostLaws.length) report.blockers.push(`本番にある法令が今回のチャンクから消えた: ${lostLaws.join(', ')}`);
  if (refsNew < refsProd * 0.9) report.blockers.push(`通達の参照の総数が 1 割超減った（${refsProd} → ${refsNew}）`);
  if (changedLaws.length + addedLaws.length > MAX_CHANGED_FILES) report.review.push(`変わる法令ファイルが ${changedLaws.length + addedLaws.length} 本（${MAX_CHANGED_FILES} 本超。改正の時期か取り直しの崩れ）`);
  if (articleDrops.length) report.review.push(`通達の本数が 3 割超減った条が ${articleDrops.length}: ${articleDrops.slice(0, 10).join('、')}${articleDrops.length > 10 ? ' ほか' : ''}`);
  if (prevBuild && orphansAfter.length > (prevBuild.orphans || 0) + 50) report.review.push(`紐付かない通達が前回より ${orphansAfter.length - prevBuild.orphans} 本増えた（${prevBuild.orphans} → ${orphansAfter.length}）`);
  // 紐付かない通達（浮き）と本番に無い PDF は本番にも出ていないので、報告には出さない（2026-10-11 まで毎週「新しい浮き 2929 本」
  // 「新しい PDF 2680 本」と同じものを並べていた）。上の「前回より 50 本超増えた」と下の読めない PDF の増え方だけ見る
  log(`紐付かない通達（浮き）: ${orphansAfter.length} 本（本番から引き継いだ ${recovered} 本は除く）。本番に無い PDF: ${newPdf.length} 本（本文を読めた ${newPdfItems.length} 本）`);
  const prevUnreadable = prevBuild && Number.isFinite(prevBuild.pdf_unreadable) ? prevBuild.pdf_unreadable : null;
  if (pdfUnreadable !== null && prevUnreadable !== null && pdfUnreadable > prevUnreadable + 50) report.review.push(`読めない PDF が前回より ${pdfUnreadable - prevUnreadable} 本増えた（${prevUnreadable} → ${pdfUnreadable}。05 の読み取りが崩れた疑い）`);
  const list = (a) => `${a.slice(0, 10).join('、')}${a.length > 10 ? ' ほか' : ''}`;
  if (pdfGone.length) report.review.push(`本番にある PDF の通達 ${pdfGone.length} 本が国税庁から消えたので外す（見て良ければ反映）: ${list(pdfGone)}`);
  if (pdfChanged.length) report.review.push(`本番にある PDF の通達 ${pdfChanged.length} 本の中身が変わった、または前回の中身が分からない（紐付け・題名は本番のまま。中身を見て良ければ反映、付け替えるなら手で）: ${list(pdfChanged)}`);

  // ---- 9. 成果物（本番を読み終えた。途中で反映・戻しが入っていれば捨てる）
  if (process.env.TSU_TEST_MID_BUILD) require('child_process').execSync(process.env.TSU_TEST_MID_BUILD, { stdio: 'inherit' });   // 確かめ用: 下見の途中に戻しを挟む
  await genGuard.verify();
  writeNdjson(path.join(B, 'vectors.ndjson'), vectors);
  writeNdjson(path.join(B, 'meta_updates.ndjson'), metaUpdates);
  writeNdjson(path.join(B, 'deletes.ndjson'), deletes);
  fs.writeFileSync(path.join(B, 'vec_state_next.json'), JSON.stringify(nextState));
  fs.writeFileSync(path.join(B, 'pdf_hashes.json'), JSON.stringify(pdfHashes));   // 反映したら build_state.json に置き、次の回の「中身が変わった PDF」の比べる元にする
  const m = {
    run_id: rid, stamp, baseline_gen: gen, created_at: new Date().toISOString(), prod_prefix: PROD, first_run: firstRun,
    vec_state_sha_before: stateBuf ? sha(stateBuf) : null, gen_sha_before: genGuard.sha,
    build_state_sha_before: prevBuildBuf ? sha(prevBuildBuf) : null,
    files, changed_laws: changedLaws, added_laws: addedLaws, index_changed: indexChanged, pages: { state: pagesState, count: Object.keys(pages).length, of: chunkUrls.size },
    refs: { prod: refsProd, now: refsNew }, articles_dropped: articleDrops,
    vectors: { upsert: vectors.length, upsert_new: upserts.filter((u) => u.why === 'new').length, upsert_text: upserts.filter((u) => u.why === 'text').length, meta_update: metaUpdates.length, delete: deletes.length },
    orphans: orphansAfter.length, new_pdfs: newPdf.length, pdf_unreadable: pdfUnreadable !== null ? pdfUnreadable : prevUnreadable, pdfs_gone: pdfGone, pdfs_changed: pdfChanged,
    blockers: report.blockers, review: report.review, notes: report.notes,
  };
  m.ok_to_apply = !m.blockers.length;
  m.needs_review = m.review.length > 0;
  m.nothing_to_do = !Object.keys(files).length && !vectors.length && !metaUpdates.length && !deletes.length && !m.blockers.length && !m.review.length;
  fs.writeFileSync(path.join(B, 'manifest.json'), JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(B, 'report.md'), renderBuildReport(m));
  log(`\nbuild: 変わる法令ファイル ${changedLaws.length}（新しい ${addedLaws.length}）/ ベクトル 埋め込み ${vectors.length}・metadata ${metaUpdates.length}・削除 ${deletes.length} / 止めた理由 ${m.blockers.length}・見直す ${m.review.length}`);
  return m;
}

function renderBuildReport(m) {
  const L = [`# 通達の作り直し（反映の下見）${m.stamp}（run ${m.run_id}）`, '',
    `- 本番: ${m.prod_prefix}${m.first_run ? '（初回）' : ''}`,
    `- 変わる法令ファイル: ${m.changed_laws.length}${m.added_laws.length ? `・新しい法令 ${m.added_laws.length}` : ''}${m.index_changed ? '・法令の一覧（index.json）も変わる' : ''}`,
    `- ページの見出し（pages.json）: ${m.pages ? ({ same: '変わらない', changed: '変わる', new: '初めて書く', skipped: '書かない（下の注意）' }[m.pages.state] + `・${m.pages.count} / ${m.pages.of} ページ`) : '—'}`,
    `- 通達の参照の総数: ${m.refs.prod} → ${m.refs.now}`,
    `- ベクトル: 埋め込む ${m.vectors.upsert}（新しい ${m.vectors.upsert_new}・本文が変わった ${m.vectors.upsert_text}）・metadata だけ ${m.vectors.meta_update}・消す ${m.vectors.delete}`, ''];
  if (m.blockers.length) { L.push('## 止めた理由', ''); for (const b of m.blockers) L.push(`- ${b}`); L.push(''); }
  if (m.review.length) { L.push('## 見直す対象', ''); for (const b of m.review) L.push(`- ${b}`); L.push(''); }
  if (m.notes.length) { L.push('## メモ', ''); for (const b of m.notes) L.push(`- ${b}`); L.push(''); }
  if (m.changed_laws.length || m.added_laws.length) { L.push('## 変わる法令ファイル', ''); for (const l of [...m.changed_laws, ...m.added_laws]) L.push(`- ${l}`); L.push(''); }
  return L.join('\n') + '\n';
}

module.exports = { build, desiredVectors, prodVectorIds, vecSig, stableJson, prodPrefix, loadFrom16, VEC_STATE_KEY, BUILD_STATE_KEY, APPLY_LOCK_KEY, META_LIMIT, VEC_INDEX };
