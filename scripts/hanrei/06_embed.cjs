// 裁判例を bge-m3 でベクトル化 → staging Vectorize の namespace "_hanrei" に登録。
// 既存 /api/admin/embed-tsutatsu 端点（ns指定可・bypassキー必須）を流用。Worker変更なし・既存ns非接触。
// （scripts/saiketsu/06_embed.cjs の流儀を踏襲。Blue-Green原則: 既存データ・既存nsには触らない）
//
//   node scripts/hanrei/06_embed.cjs --dry-run              # 投入せず統計とサンプルのみ（全量検証）
//   node scripts/hanrei/06_embed.cjs --dry-run --limit 100  # 先頭100判例のみ
//   BYPASS_KEY=xxx node scripts/hanrei/06_embed.cjs         # 実投入（統合担当のみが実行する）
//   BYPASS_KEY=xxx node scripts/hanrei/06_embed.cjs --resume  # 進捗ファイルから再開
//   node scripts/hanrei/06_embed.cjs --ns _hanrei_test ...  # namespace 上書き（既定 _hanrei）
//
// 1判例=複数ベクトル（saiketsu と同じ親子構造）:
//   ・要旨ベクトル "{id}-y": hanji / yoshi のどちらかがあれば1本（両方あれば連結）。規範層・最強シグナル
//   ・セクションベクトル "{id}-s{通し番号}": sections のうち type==='shubun' を除く各セクション
//     （通し番号は投入セクションの0始まり連番）
// 全ベクトルが metadata.sid で親判例を指す。検索側は sid で集約して1カード化。
//
// metadata（契約）: { sid, t:'y'|type, h:head≤60, ttl:title≤80, c:court, d:dateIso, k:kekka,
//                    homes:JSON文字列 [{l,n,a}] lawRefs上位≤8件(count降順・aは第七十条の六 形式) }
// Vectorize の1ベクトル metadata 上限 10KiB を超える場合は homes を後ろから削って収める。
//
// 埋め込みテキスト: "{title}（{court} {dateJp}）{head}\n{text}"（埋め込みはWorker側 @cf/baai/bge-m3）
//
// 進捗: scripts/hanrei/state/embed_progress.json（--resume で完了済みシャード/バッチ位置から再開）

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const SITE = require('../site_config.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PARSED_DIR = path.join(REPO_ROOT, 'hanrei_parsed');
const STATE_DIR = path.join(__dirname, 'state');
const PROGRESS_FILE = path.join(STATE_DIR, 'embed_progress.json');

const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;
const BATCH = 20;
const MAX_RETRIES = 3;
const META_LIMIT = 10 * 1024; // Vectorize: 10KiB / vector metadata
const YOSHI_MAX = 4000; // 要旨テキスト上限
const SEC_MAX = 4000; // セクションテキスト上限（parse 時点で≤4000字の契約だが、別紙表など78件の例外があるため防御的にカット）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CLI ----
function parseArgs(argv) {
  const o = { dry: false, limit: Infinity, resume: false, ns: '_hanrei' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--dry') o.dry = true;
    else if (a === '--resume') o.resume = true;
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10);
    else if (a === '--ns') o.ns = String(argv[++i] || '_hanrei');
    else { console.error(`未知の引数: ${a}`); process.exit(1); }
  }
  if (!Number.isFinite(o.limit) || o.limit <= 0) {
    if (o.limit !== Infinity) { console.error('--limit は正の整数で指定してください'); process.exit(1); }
  }
  return o;
}

// ---- 算用数字 → 漢数字（saiketsu/06_embed.cjs から流用。homes の a は article_title 形式） ----
function intToKanji(n) {
  n = parseInt(n, 10); if (!n) return '〇';
  const d = '〇一二三四五六七八九';
  const th = Math.floor(n / 1000), hu = Math.floor((n % 1000) / 100), te = Math.floor((n % 100) / 10), on = n % 10;
  let s = '';
  if (th) s += (th > 1 ? d[th] : '') + '千';
  if (hu) s += (hu > 1 ? d[hu] : '') + '百';
  if (te) s += (te > 1 ? d[te] : '') + '十';
  if (on) s += d[on];
  return s;
}
// "70の6" → "第七十条の六"、"22" → "第二十二条"
function jou2title(jou) {
  const p = String(jou).split('の');
  let t = '第' + intToKanji(p[0]) + '条';
  for (let i = 1; i < p.length; i++) t += 'の' + intToKanji(p[i]);
  return t;
}

// ---- homes: lawRefs 上位≤8件（count降順） → [{l,n,a}] ----
function buildHomes(lawRefs) {
  return (lawRefs || [])
    .filter((r) => r && r.lawId && r.art)
    .slice() // 元配列を壊さない
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 8)
    .map((r) => ({ l: r.lawId, n: r.law || '', a: jou2title(r.art) }));
}

const metaBytes = (m) => Buffer.byteLength(JSON.stringify(m), 'utf8');

// metadata が 10KiB を超える場合 homes を後ろから削って収める（それでも超えるなら homes=[]）
function fitMetadata(meta, homes, stats) {
  let hs = homes;
  let m = { ...meta, homes: JSON.stringify(hs) };
  while (metaBytes(m) > META_LIMIT && hs.length > 0) {
    hs = hs.slice(0, hs.length - 1);
    m = { ...meta, homes: JSON.stringify(hs) };
    stats.homesTrimmed++;
  }
  if (metaBytes(m) > META_LIMIT) stats.metaOverAfterTrim++; // 契約上は起き得ない（全フィールドに上限あり）
  return m;
}

// ---- 1判例 → ベクトル配列 ----
function caseToTargets(c, ns, stats) {
  const out = [];
  const id = String(c.id);
  const title = String(c.title || '');
  const court = String(c.court || '');
  const dateJp = String(c.dateJp || '');
  const homes = buildHomes(c.lawRefs);
  const common = {
    sid: id,
    ttl: title.slice(0, 80),
    c: court,
    d: c.dateIso || '',
    k: c.kekka || '',
  };
  const prefix = `${title}（${court} ${dateJp}）`;

  // 要旨ベクトル（hanji / yoshi のどちらかがあれば1本）
  const yoshiText = [c.hanji, c.yoshi].filter((x) => x && String(x).trim()).join('\n');
  if (yoshiText) {
    const head = '要旨';
    const meta = fitMetadata({ ...common, t: 'y', h: head }, homes, stats);
    out.push({ id: `${id}-y`, ns, text: `${prefix}${head}\n${yoshiText.slice(0, YOSHI_MAX)}`, metadata: meta });
    stats.byType.y = (stats.byType.y || 0) + 1;
    stats.yoshiCases++;
  }

  // セクションベクトル（type==='shubun' は除外・空テキストはスキップ）
  let s = 0;
  for (const sec of c.sections || []) {
    if (!sec || sec.type === 'shubun') continue;
    const text = String(sec.text || '').trim();
    if (!text) { stats.emptySections++; continue; }
    if (text.length < 30) stats.shortSections++; // 参考統計（契約どおり投入はする）
    const head = String(sec.head || '').slice(0, 60);
    const t = sec.type || 'other';
    const meta = fitMetadata({ ...common, t, h: head }, homes, stats);
    out.push({ id: `${id}-s${s}`, ns, text: `${prefix}${head}\n${text.slice(0, SEC_MAX)}`, metadata: meta });
    stats.byType[t] = (stats.byType[t] || 0) + 1;
    s++;
  }
  return out;
}

// ---- シャード一覧 ----
function listShards() {
  return fs.readdirSync(PARSED_DIR)
    .filter((f) => /^cases_\d{3}\.ndjson$/.test(f))
    .sort();
}

// ---- シャードを1行ずつ読む ----
async function* readShard(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(PARSED_DIR, file), 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const l = line.trim();
    if (l) yield JSON.parse(l);
  }
}

// ---- 進捗ファイル ----
function loadProgress(ns) {
  try {
    const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    if (p && p.ns === ns) return p;
    console.log(`  進捗ファイルの ns (${p && p.ns}) が対象 ns (${ns}) と異なるため無視します`);
  } catch (_) { /* 進捗なし */ }
  return null;
}
function saveProgress(p) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  p.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 1));
}

// ---- 1バッチ投入（リトライ付き） ----
async function upsertBatch(batch) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${WORKER}/api/admin/embed-tsutatsu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ items: batch }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.upserted) return j.upserted;
      // bge-m3 の60,000トークン/リクエスト上限（エラー3030）はリトライ無意味。半分に割って再送すれば必ず通る
      if (String(j.error || '').includes('3030') && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        console.log(`
  3030上限 → バッチ分割 ${batch.length}件 → ${mid}+${batch.length - mid}`);
        return (await upsertBatch(batch.slice(0, mid))) + (await upsertBatch(batch.slice(mid)));
      }
      if (attempt < MAX_RETRIES) {
        console.log(`\n  NG ${res.status} ${JSON.stringify(j).slice(0, 150)} → retry ${attempt}/${MAX_RETRIES - 1}`);
      } else {
        console.log(`\n  NG ${res.status} ${JSON.stringify(j).slice(0, 150)} → give up`);
        return 0;
      }
    } catch (e) {
      if (attempt < MAX_RETRIES) console.log(`\n  ERR ${e.message} → retry ${attempt}/${MAX_RETRIES - 1}`);
      else { console.log(`\n  ERR ${e.message} → give up`); return 0; }
    }
    await sleep(1000 * Math.pow(3, attempt - 1)); // 1s, 3s
  }
  return 0;
}

async function main() {
  const opt = parseArgs(process.argv);
  const shards = listShards();
  if (!shards.length) throw new Error(`hanrei_parsed/cases_*.ndjson がありません (${PARSED_DIR})`);
  if (!opt.dry && !KEY) { console.error('BYPASS_KEY 環境変数が必要です（--dry-run なら不要）'); process.exit(1); }

  const stats = {
    cases: 0, yoshiCases: 0, vectors: 0,
    byType: {},
    textChars: 0, textMax: 0,
    metaBytesSum: 0, metaBytesMax: 0, metaOver: 0, metaOverAfterTrim: 0, homesTrimmed: 0,
    emptySections: 0, shortSections: 0,
  };
  const samples = [];

  // 進捗（実投入時のみ意味を持つ）
  let progress = opt.resume ? loadProgress(opt.ns) : null;
  if (opt.resume && !progress) console.log('  進捗ファイルなし → 最初から実行します');
  if (!progress) progress = { ns: opt.ns, doneShards: [], current: null, ok: 0, ng: 0 };
  const doneSet = new Set(progress.doneShards);

  let ok = progress.ok || 0, ng = progress.ng || 0;
  let caseCount = 0;
  let stopped = false;

  for (const shard of shards) {
    if (stopped) break;
    const shardDone = doneSet.has(shard) && !opt.dry;
    // resume 時: 完了済みシャードでもケース数上限（--limit）判定のためにケース数は数えないと
    // 位置がずれるが、limit は「処理する判例数」の上限として completed 分は数えない（再開後の残量指定）。
    if (shardDone) continue;
    const resumeVec = (!opt.dry && progress.current && progress.current.shard === shard)
      ? progress.current.nextVec : 0;

    // シャード内の全ターゲットを構築（1シャード≈880判例なのでメモリは軽い）
    const targets = [];
    for await (const c of readShard(shard)) {
      if (caseCount >= opt.limit) { stopped = true; break; }
      caseCount++;
      stats.cases++;
      const ts = caseToTargets(c, opt.ns, stats);
      for (const t of ts) {
        stats.vectors++;
        stats.textChars += t.text.length;
        if (t.text.length > stats.textMax) stats.textMax = t.text.length;
        const mb = metaBytes(t.metadata);
        stats.metaBytesSum += mb;
        if (mb > stats.metaBytesMax) stats.metaBytesMax = mb;
        if (mb > META_LIMIT) stats.metaOver++;
        if (samples.length < 3) samples.push(t);
      }
      if (!opt.dry) targets.push(...ts);
    }

    if (opt.dry) continue;

    // 投入（resume 位置から）
    for (let i = resumeVec; i < targets.length; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      // bge-m3 の1リクエスト上限（60,000トークン）対策: 長文が偏ったバッチは合計45,000字で分割して送る
      let up = 0;
      {
        let sub = [];
        let subChars = 0;
        for (const t of batch) {
          if (sub.length && subChars + t.text.length > 28000) {
            up += await upsertBatch(sub); sub = []; subChars = 0;
          }
          sub.push(t); subChars += t.text.length;
        }
        if (sub.length) up += await upsertBatch(sub);
      }
      ok += up; ng += batch.length - up;
      progress.ok = ok; progress.ng = ng;
      progress.current = { shard, nextVec: i + BATCH };
      saveProgress(progress);
      process.stdout.write(`\r  [${shard}] ${Math.min(i + BATCH, targets.length)}/${targets.length}  累計 登録${ok} 失敗${ng}`);
    }
    if (!stopped) { // --limit でシャード途中終了した場合は「完了」にしない
      progress.doneShards.push(shard);
      progress.current = null;
    }
    saveProgress(progress);
    console.log(`\n  ${shard} ${stopped ? '途中終了(--limit)' : '完了'} (${targets.length} vectors)`);
  }

  // ---- 統計出力 ----
  console.log(`\n==== 統計 (namespace ${opt.ns}) ====`);
  console.log(`判例: ${stats.cases}（要旨ベクトルあり ${stats.yoshiCases}） / ベクトル: ${stats.vectors}`);
  for (const [k, n] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(7)}  t=${k}`);
  if (stats.vectors) {
    console.log(`テキスト: 計${stats.textChars.toLocaleString()}字 / 平均${Math.round(stats.textChars / stats.vectors)}字 / 最大${stats.textMax}字`);
    console.log(`metadata: 平均${Math.round(stats.metaBytesSum / stats.vectors)}B / 最大${stats.metaBytesMax}B（上限${META_LIMIT}B）`);
    console.log(`  10KiB超過: トリム前${stats.metaOver}件 → トリム後${stats.metaOverAfterTrim}件（homes削除 ${stats.homesTrimmed}回）`);
    console.log(`  空テキストでスキップしたセクション: ${stats.emptySections} / 30字未満（投入済・参考）: ${stats.shortSections}`);
  }
  if (stats.metaOverAfterTrim > 0) {
    console.error('★ metadata 10KiB 超過が残っています。契約違反のため要調査。');
    process.exitCode = 1;
  }

  if (opt.dry) {
    console.log('\n---- サンプル（先頭3件） ----');
    for (const t of samples) {
      console.log(JSON.stringify({
        id: t.id, ns: t.ns,
        text: t.text.slice(0, 160) + (t.text.length > 160 ? `…(${t.text.length}字)` : ''),
        metadata: t.metadata,
      }, null, 1));
    }
    console.log('\n★ DRY-RUN（投入していません）');
    return;
  }
  console.log(`\n完了: ${ok}登録 / ${ng}失敗  (namespace ${opt.ns})`);
}

// 週次更新（scripts/hanrei/weekly/run.cjs）が同じ文面・metadata でベクトルを作るために使う
module.exports = { caseToTargets, buildHomes, jou2title, fitMetadata, META_LIMIT };

if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });
