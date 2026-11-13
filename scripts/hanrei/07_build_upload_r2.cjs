// 裁判例データを R2(joubun-kun-data) の新パス hanrei_v1/ 用にローカル構築し、
// （統合担当が）wrangler r2 object put でアップロードするハーネス。
// Blue-Green: hanrei_v1/ のみに書き出す。既存パス・既存データは一切触らない。
//
//   node scripts/hanrei/07_build_upload_r2.cjs                # ローカル構築のみ（hanrei_r2_out/）
//   node scripts/hanrei/07_build_upload_r2.cjs --stats        # 構築＋詳細サマリ＋スポットチェック
//   node scripts/hanrei/07_build_upload_r2.cjs --dry          # 構築＋アップロード対象一覧（実行なし）
//   node scripts/hanrei/07_build_upload_r2.cjs --upload       # 構築＋R2アップロード（--remote）※統合担当のみ実行
//   node scripts/hanrei/07_build_upload_r2.cjs --vectors N    # index.json の vectors を明示指定
//
// R2レイアウト（バケット joubun-kun-data / プレフィックス hanrei_v1/）:
//   hanrei_v1/cases_{NNNN}.json        NNNN=Math.floor(id/100) 4桁ゼロ埋め。{ "<id>": record }
//                                      record = パース行全体 + gensin.matchedId/appeals マージ + url
//   hanrei_v1/lookup/caseno_{E}{YY}.json  事件番号の元号年で分割（例 caseno_R05.json）
//                                      { "裁判所名(空白除去)|事件番号": [id,...] }
//   hanrei_v1/lookup/date_{YYYY}.json  ISO年で分割。{ "{審級}|{ISO日付}": [id,...] }
//   （links/{law_id}.json は手元だけに作り、R2 には上げない。条文ページの紐付けは hanrei_v2/links・scripts/lineage/relink_hanrei.cjs。2026-10-18）
//                                      items = 裁判所ランク(最高裁3>高裁2>他1)降順→dateIso降順の上位300件
//   hanrei_v1/index.json               { builtAt, cases, laws:[law_id...], vectors }
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { courtKey, classifyCourt } = require('./lib_common.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'hanrei_parsed');
const IDX_DIR = path.join(__dirname, 'state', 'indexes');
const OUT_ROOT = path.join(REPO_ROOT, 'hanrei_r2_out');
const BUCKET = 'joubun-kun-data';
const PREFIX = 'hanrei_v1';
const LINKS_TOP = 300; // 条キーごとの items 上限
const CHUNK_WARN_BYTES = 5 * 1024 * 1024; // cases チャンクの警告閾値

const args = process.argv.slice(2);
const doStats = args.includes('--stats');
const doDry = args.includes('--dry');
const doUpload = args.includes('--upload');
const vecArgIdx = args.indexOf('--vectors');
const vecOverride = vecArgIdx >= 0 && args[vecArgIdx + 1] ? parseInt(args[vecArgIdx + 1], 10) : null;

// ---------------------------------------------------------------- helpers

const ERA_LETTER = { 明治: 'M', 大正: 'T', 昭和: 'S', 平成: 'H', 令和: 'R' };

// 事件番号「令和4(行コ)280」→ "R04"。抽出不能なら null
function eraYearTag(caseNo) {
  const m = String(caseNo || '').match(/^(明治|大正|昭和|平成|令和)(元|\d+)/);
  if (!m) return null;
  const y = m[2] === '元' ? 1 : parseInt(m[2], 10);
  return `${ERA_LETTER[m[1]]}${String(y).padStart(2, '0')}`;
}

// 裁判所ランク: 最高裁3 > 高裁・知財高裁2 > 他1
function courtRank(court) {
  const c = String(court || '');
  if (/最高裁判所/.test(c)) return 3;
  if (/高等裁判所/.test(c)) return 2; // 知的財産高等裁判所を含む
  return 1;
}

// 条キーとして妥当か（アラビア数字＋「の」連結のみ。附則・変則はスキップ）
function isValidArtKey(art) {
  return typeof art === 'string' && /^\d+(の\d+)*$/.test(art);
}

// 条キーの数値対応ソート（"9" < "70の6の2" < "709"ではなく 9 < 70の6の2 < 709）
function artCompare(a, b) {
  const pa = a.split('の').map(Number);
  const pb = b.split('の').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] !== undefined ? pa[i] : -1;
    const y = pb[i] !== undefined ? pb[i] : -1;
    if (x !== y) return x - y;
  }
  return 0;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

// ---------------------------------------------------------------- build: cases + links 集計（シャード単位ストリーム）

function build() {
  if (!fs.existsSync(SRC_DIR)) throw new Error(`入力がありません: ${SRC_DIR}`);
  for (const f of ['caseno_index.json', 'date_index.json', 'shinkyu_links.json']) {
    if (!fs.existsSync(path.join(IDX_DIR, f))) throw new Error(`索引がありません: ${path.join(IDX_DIR, f)}（04_build_indexes.cjs を先に実行）`);
  }

  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const shinkyu = readJson(path.join(IDX_DIR, 'shinkyu_links.json'));
  const shards = fs.readdirSync(SRC_DIR).filter((f) => /^cases_\d{3}\.ndjson$/.test(f)).sort();

  const stats = {
    cases: 0, dupes: 0, badLines: 0, noDetailNs: 0,
    mergedGensin: 0, mergedAppeals: 0,
    vecY: 0, vecS: 0,
    chunkFiles: 0, chunkBytes: 0, maxChunk: { file: null, bytes: 0 }, bigChunks: [],
    refsTotal: 0, refsSkipped: 0,
  };
  const seenIds = new Set();
  const writtenChunks = new Set();
  // links 集計: lawId → artKey → [{v:出力item, r:ランク, d:dateIso}]
  const links = new Map();

  for (const shard of shards) {
    const lines = fs.readFileSync(path.join(SRC_DIR, shard), 'utf8').split('\n');
    const chunks = new Map(); // NNNN → { id: record }（このシャード内のみ）
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { stats.badLines++; continue; }
      const idNum = parseInt(rec.id, 10);
      if (!Number.isFinite(idNum)) { stats.badLines++; continue; }
      if (seenIds.has(rec.id)) { stats.dupes++; continue; }
      seenIds.add(rec.id);
      stats.cases++;

      // --- 審級リンクのマージ（gensin.matchedId / appeals） ---
      const lk = shinkyu[rec.id];
      if (lk) {
        if (lk.gensin) {
          rec.gensin = Object.assign(
            rec.gensin || { court: lk.gensin.court || null, caseNo: lk.gensin.caseNo || null, dateJp: lk.gensin.dateJp || null, kekka: null },
            { matchedId: lk.gensin.matchedId != null ? lk.gensin.matchedId : null }
          );
          stats.mergedGensin++;
        }
        if (Array.isArray(lk.appeals) && lk.appeals.length) {
          rec.appeals = lk.appeals;
          stats.mergedAppeals++;
        }
      }

      // --- url（detailNs 先頭） ---
      const dn = Array.isArray(rec.detailNs) && rec.detailNs.length ? rec.detailNs[0] : null;
      if (dn == null) stats.noDetailNs++;
      rec.url = `https://www.courts.go.jp/hanrei/${rec.id}/detail${dn != null ? dn : '2'}/index.html`;

      // --- Vectorize 期待本数（06 の契約ルールでの見積り: 要旨層 + shubun 以外のセクション） ---
      if ((rec.hanji && String(rec.hanji).trim()) || (rec.yoshi && String(rec.yoshi).trim())) stats.vecY++;
      for (const s of rec.sections || []) if (s && s.type !== 'shubun') stats.vecS++;

      // --- links 集計（lawRefs → 条文逆引き） ---
      for (const r of rec.lawRefs || []) {
        stats.refsTotal++;
        if (!r || !r.lawId || !isValidArtKey(r.art) || !/^[0-9A-Za-z_]+$/.test(r.lawId)) { stats.refsSkipped++; continue; }
        let perLaw = links.get(r.lawId);
        if (!perLaw) links.set(r.lawId, (perLaw = new Map()));
        let arr = perLaw.get(r.art);
        if (!arr) perLaw.set(r.art, (arr = []));
        arr.push({
          v: {
            id: rec.id,
            title: rec.title || null,
            court: [rec.court, rec.branch].filter(Boolean).join(' ') || null,
            dateJp: rec.dateJp || null,
            caseNo: rec.caseNo || null,
            kekka: rec.kekka || null,
            url: `https://www.courts.go.jp/hanrei/${rec.id}/detail${(rec.detailNs || [])[0] || 2}/index.html`,
          },
          r: courtRank(rec.court),
          d: rec.dateIso || '',
        });
      }

      // --- cases チャンクへ ---
      const nnnn = String(Math.floor(idNum / 100)).padStart(4, '0');
      let ck = chunks.get(nnnn);
      if (!ck) chunks.set(nnnn, (ck = {}));
      ck[rec.id] = rec;
    }

    // シャード内チャンクを書き出し（別シャードで同チャンクが出た場合はマージ）
    for (const [nnnn, obj] of chunks) {
      const file = path.join(OUT_ROOT, `cases_${nnnn}.json`);
      let out = obj;
      if (writtenChunks.has(nnnn)) out = Object.assign(readJson(file), obj);
      writeJson(file, out);
      writtenChunks.add(nnnn);
    }
  }

  // チャンクサイズ集計
  for (const nnnn of writtenChunks) {
    const file = path.join(OUT_ROOT, `cases_${nnnn}.json`);
    const b = fs.statSync(file).size;
    stats.chunkFiles++;
    stats.chunkBytes += b;
    if (b > stats.maxChunk.bytes) stats.maxChunk = { file: `cases_${nnnn}.json`, bytes: b };
    if (b > CHUNK_WARN_BYTES) stats.bigChunks.push(`cases_${nnnn}.json (${fmtMB(b)})`);
  }

  // ---------------------------------------------------------------- lookup: caseno_{E}{YY}.json
  const casenoIndex = readJson(path.join(IDX_DIR, 'caseno_index.json'));
  const casenoFiles = new Map(); // "R04" → { key: ids }
  let casenoKeys = 0, casenoOther = 0;
  for (const [key, ids] of Object.entries(casenoIndex)) {
    const caseNo = key.split('|')[1] || '';
    const tag = eraYearTag(caseNo) || 'other';
    if (tag === 'other') casenoOther++;
    let obj = casenoFiles.get(tag);
    if (!obj) casenoFiles.set(tag, (obj = {}));
    obj[key] = ids;
    casenoKeys++;
  }
  for (const [tag, obj] of casenoFiles) {
    writeJson(path.join(OUT_ROOT, 'lookup', `caseno_${tag}.json`), obj);
  }

  // ---------------------------------------------------------------- lookup: date_{YYYY}.json
  const dateIndex = readJson(path.join(IDX_DIR, 'date_index.json'));
  const dateFiles = new Map(); // "2006" → { key: ids }
  let dateKeys = 0, dateBad = 0;
  for (const [key, ids] of Object.entries(dateIndex)) {
    const iso = key.split('|')[1] || '';
    const yyyy = /^\d{4}-/.test(iso) ? iso.slice(0, 4) : null;
    if (!yyyy) { dateBad++; continue; }
    let obj = dateFiles.get(yyyy);
    if (!obj) dateFiles.set(yyyy, (obj = {}));
    obj[key] = ids;
    dateKeys++;
  }
  for (const [yyyy, obj] of dateFiles) {
    writeJson(path.join(OUT_ROOT, 'lookup', `date_${yyyy}.json`), obj);
  }

  // ---------------------------------------------------------------- links/{law_id}.json
  let linkPairs = 0, cappedKeys = 0, linksBytes = 0;
  const lawIds = [...links.keys()].sort();
  for (const lawId of lawIds) {
    const perLaw = links.get(lawId);
    const out = {};
    for (const artKey of [...perLaw.keys()].sort(artCompare)) {
      const arr = perLaw.get(artKey);
      arr.sort((a, b) => (b.r - a.r) || b.d.localeCompare(a.d) || (parseInt(b.v.id, 10) - parseInt(a.v.id, 10)));
      if (arr.length > LINKS_TOP) cappedKeys++;
      out[artKey] = { total: arr.length, items: arr.slice(0, LINKS_TOP).map((x) => x.v) };
      linkPairs++;
    }
    const file = path.join(OUT_ROOT, 'links', `${lawId}.json`);
    writeJson(file, out);
    linksBytes += fs.statSync(file).size;
  }

  // ---------------------------------------------------------------- court_names.json
  // worker の裁判所名照合テーブル（略称→正式名）。04 が生成した集合をそのまま配る。
  if (fs.existsSync(path.join(IDX_DIR, 'court_names.json'))) {
    writeJson(path.join(OUT_ROOT, 'court_names.json'), readJson(path.join(IDX_DIR, 'court_names.json')));
  }

  // ---------------------------------------------------------------- index.json
  const { vectors, vectorsSource } = resolveVectors(stats);
  writeJson(path.join(OUT_ROOT, 'index.json'), {
    builtAt: new Date().toISOString(),
    cases: stats.cases,
    laws: lawIds,
    vectors,
  });

  return { stats, casenoFiles, casenoKeys, casenoOther, dateFiles, dateKeys, dateBad, lawIds, linkPairs, cappedKeys, linksBytes, vectors, vectorsSource };
}

// index.json の vectors: --vectors 指定 > 06 の state 実数 > 契約ルールでの見積り
function resolveVectors(stats) {
  if (vecOverride != null && Number.isFinite(vecOverride)) {
    return { vectors: vecOverride, vectorsSource: '--vectors 指定' };
  }
  const stateDir = path.join(__dirname, 'state');
  const cands = fs.existsSync(stateDir)
    ? fs.readdirSync(stateDir).filter((f) => /^(embed|vector).*\.json$/.test(f))
    : [];
  for (const f of cands) {
    try {
      const j = readJson(path.join(stateDir, f));
      for (const k of ['vectors', 'inserted', 'upserted', 'total', 'count']) {
        if (typeof j[k] === 'number' && j[k] > 0) {
          return { vectors: j[k], vectorsSource: `state/${f} (.${k})` };
        }
      }
    } catch { /* 読めない state はスキップ */ }
  }
  return { vectors: stats.vecY + stats.vecS, vectorsSource: '契約ルールでの見積り（要旨層+非shubunセクション。06の実数確定後は --vectors で上書き可）' };
}

// ---------------------------------------------------------------- サマリ表示

function printSummary(r) {
  const { stats } = r;
  console.log('=== hanrei_v1 ローカル構築完了 ===');
  console.log(`出力: ${OUT_ROOT}`);
  console.log(`cases: ${stats.cases}件 (重複スキップ ${stats.dupes} / 壊れ行 ${stats.badLines} / detailNsなし ${stats.noDetailNs})`);
  console.log(`  審級マージ: gensin ${stats.mergedGensin} / appeals ${stats.mergedAppeals}`);
  console.log(`  チャンク: ${stats.chunkFiles}ファイル / 計 ${fmtMB(stats.chunkBytes)} / 最大 ${stats.maxChunk.file} (${fmtMB(stats.maxChunk.bytes)})`);
  if (stats.bigChunks.length) console.log(`  ★警告: 5MB超のチャンク ${stats.bigChunks.length}件: ${stats.bigChunks.join(', ')}`);
  console.log(`lookup/caseno: ${r.casenoFiles.size}ファイル / ${r.casenoKeys}キー (元号年抽出不能 ${r.casenoOther})`);
  console.log(`lookup/date:   ${r.dateFiles.size}ファイル / ${r.dateKeys}キー (不正キー ${r.dateBad})`);
  console.log(`links: ${r.lawIds.length}法令 / ${r.linkPairs}条キー / 300件超過カット ${r.cappedKeys}キー / 計 ${fmtMB(r.linksBytes)}`);
  console.log(`  (lawRefs 総数 ${stats.refsTotal} / 条キー不適合スキップ ${stats.refsSkipped})`);
  console.log(`vectors: ${r.vectors} [${r.vectorsSource}]`);

  const total = totalOutBytes();
  console.log(`合計: ${total.files}ファイル / ${fmtMB(total.bytes)}`);
}

function totalOutBytes() {
  let files = 0, bytes = 0;
  for (const f of walk(OUT_ROOT)) { files++; bytes += fs.statSync(f).size; }
  return { files, bytes };
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- スポットチェック（--stats）

function loadCaseFromChunks(id) {
  const nnnn = String(Math.floor(parseInt(id, 10) / 100)).padStart(4, '0');
  const file = path.join(OUT_ROOT, `cases_${nnnn}.json`);
  if (!fs.existsSync(file)) return { rec: null, chunk: `cases_${nnnn}.json` };
  return { rec: readJson(file)[id] || null, chunk: `cases_${nnnn}.json` };
}

function spotChecks() {
  console.log('=== スポットチェック ===');
  let ok = 0, ng = 0;
  const check = (label, cond, detail) => {
    if (cond) { ok++; console.log(`  OK ${label}${detail ? ` … ${detail}` : ''}`); }
    else { ng++; console.log(`  NG ${label}${detail ? ` … ${detail}` : ''}`); }
  };

  // 1) caseno 逆引き: いくつかの元号年ファイルの実在キーで record と突合
  const lookupDir = path.join(OUT_ROOT, 'lookup');
  for (const tag of ['R04', 'H17', 'S60']) {
    const file = path.join(lookupDir, `caseno_${tag}.json`);
    if (!fs.existsSync(file)) { check(`caseno_${tag}.json 存在`, false); continue; }
    const obj = readJson(file);
    const keys = Object.keys(obj);
    const key = keys[0];
    const [courtPart, caseNoPart] = key.split('|');
    const id = obj[key][0];
    const { rec, chunk } = loadCaseFromChunks(id);
    check(
      `caseno_${tag}.json "${key}" → id ${id}`,
      !!rec && rec.caseNo === caseNoPart && courtKey(rec.court, rec.branch) === courtPart,
      rec ? `${chunk} 内 court=${rec.court}${rec.branch ? ' ' + rec.branch : ''} caseNo=${rec.caseNo}` : `${chunk} に record なし`
    );
  }
  // 「東京高等裁判所|令和4(行コ)280」相当（高裁×令和4(行コ)）の実在キーを逆引き確認
  const r04file = path.join(lookupDir, 'caseno_R04.json');
  if (fs.existsSync(r04file)) {
    const obj = readJson(r04file);
    const hit = Object.keys(obj).find((k) => /高等裁判所\|令和4\(行コ\)\d+$/.test(k));
    if (!hit) {
      check('caseno_R04.json に「高裁|令和4(行コ)N」相当キー', false, '該当なし');
    } else {
      const id = obj[hit][0];
      const { rec, chunk } = loadCaseFromChunks(id);
      check(
        `caseno_R04.json 相当キー "${hit}" → id ${id}`,
        !!rec && rec.caseNo === hit.split('|')[1] && courtKey(rec.court, rec.branch) === hit.split('|')[0],
        rec ? `${chunk} 内 court=${rec.court} caseNo=${rec.caseNo}` : `${chunk} に record なし`
      );
    }
  }

  // 2) date 逆引き: 実在キーで審級・日付を突合
  for (const yyyy of ['2006', '2020']) {
    const file = path.join(lookupDir, `date_${yyyy}.json`);
    if (!fs.existsSync(file)) { check(`date_${yyyy}.json 存在`, false); continue; }
    const obj = readJson(file);
    const key = Object.keys(obj)[0];
    const [cls, iso] = key.split('|');
    const id = obj[key][0];
    const { rec, chunk } = loadCaseFromChunks(id);
    check(
      `date_${yyyy}.json "${key}" → id ${id}`,
      !!rec && rec.dateIso === iso && classifyCourt(rec.court) === cls,
      rec ? `${chunk} 内 court=${rec.court} dateIso=${rec.dateIso}` : `${chunk} に record なし`
    );
  }

  // 3) links: 民法709条ほか多数判例条文の total と先頭 item の整合
  const samples = [
    ['129AC0000000089', '709', '民法709条'],
    ['321CONSTITUTION', '14', '憲法14条'],
  ];
  for (const [lawId, art, label] of samples) {
    const file = path.join(OUT_ROOT, 'links', `${lawId}.json`);
    if (!fs.existsSync(file)) { check(`links/${lawId}.json 存在 (${label})`, false); continue; }
    const obj = readJson(file);
    const ent = obj[art];
    if (!ent) { check(`${label} 条キーあり`, false); continue; }
    const top = ent.items[0];
    const { rec } = loadCaseFromChunks(top.id);
    const cited = !!rec && (rec.lawRefs || []).some((x) => x.lawId === lawId && x.art === art);
    check(
      `${label} total=${ent.total} items=${ent.items.length}`,
      ent.total >= ent.items.length && ent.items.length <= LINKS_TOP && cited,
      `先頭: id=${top.id} ${top.court} ${top.dateJp}（引用突合 ${cited ? '一致' : '不一致'}）`
    );
  }

  // 4) index.json
  const idx = readJson(path.join(OUT_ROOT, 'index.json'));
  check('index.json', typeof idx.builtAt === 'string' && idx.cases > 0 && Array.isArray(idx.laws) && typeof idx.vectors === 'number',
    `cases=${idx.cases} laws=${idx.laws.length} vectors=${idx.vectors}`);

  console.log(`スポットチェック: OK ${ok} / NG ${ng}`);
  return ng === 0;
}

// ---------------------------------------------------------------- アップロード（--upload。実投入は統合担当のみが行う）

function upload() {
  // 条文 → 判例の逆引き（links/）は R2 に上げない（2026-10-18 のオーナーの決定。条文ページの紐付けは条の系譜で付け直した hanrei_v2/links だけで、
  // scripts/lineage/relink_hanrei.cjs が作る。ここで作る links/ は手元の確かめ（--stats）用）
  let files = walk(OUT_ROOT).filter((f) => !/[/\\]links[/\\]/.test(path.relative(OUT_ROOT, f).replace(/^/, '/')));
  // --only-cases: cases_*.json だけ再アップロード（審級リンク修正など cases のみ変わったとき）
  if (args.includes('--only-cases')) {
    files = files.filter((f) => /[/\\]cases_\d{4}\.json$/.test(f));
  }
  // --only-date: lookup/date_*.json だけ再アップロード（日付索引のキー形式を変えたとき等）
  if (args.includes('--only-date')) {
    files = files.filter((f) => /[/\\]date_\d{4}\.json$/.test(f));
  }
  // --only-courtnames: court_names.json だけ再アップロード
  if (args.includes('--only-courtnames')) {
    files = files.filter((f) => /[/\\]court_names\.json$/.test(f));
  }
  const uploads = files.map((f) => ({
    local: f,
    key: `${PREFIX}/${path.relative(OUT_ROOT, f).split(path.sep).join('/')}`,
  }));
  console.log(`アップロード対象: ${uploads.length}ファイル → ${BUCKET}/${PREFIX}/`);
  if (doDry) { console.log('★ DRY-RUN（アップロードは実行しません）'); return; }
  if (!doUpload) { console.log('（--upload 指定なし: 構築のみで終了。実投入は統合担当が行う）'); return; }

  console.log('★ R2 へ実アップロードを開始します（Blue-Green: hanrei_v1/ のみ）');
  let ok = 0, ng = 0;
  const failed = [];
  for (const u of uploads) {
    try {
      execSync(`npx wrangler r2 object put "${BUCKET}/${u.key}" --file="${u.local}" --content-type="application/json" --remote`, { stdio: 'pipe', cwd: REPO_ROOT });
      ok++;
    } catch (e) { ng++; failed.push(u.key); }
    if ((ok + ng) % 50 === 0) console.log(`  ${ok + ng}/${uploads.length}`);
  }
  console.log(`完了: ${ok} / 失敗 ${ng}`);
  if (failed.length) console.log(`失敗キー:\n  ${failed.join('\n  ')}`);
}

// ---------------------------------------------------------------- main

function main() {
  const t0 = Date.now();
  const r = build();
  printSummary(r);
  if (doStats) spotChecks();
  upload();
  console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

module.exports = { eraYearTag, courtRank, isValidArtKey, artCompare };

if (require.main === module) main();
