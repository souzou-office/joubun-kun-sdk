// 別表のベクトル（tsutatsu-embeddings-v1 の _beppyo・bpr_*）の週次更新: 今の本番の条文と refs から「あるべき全体」を作り、
// 前回反映した状態の控えと比べて「反映したら何が変わるか」を作る（反映の下見）。
//
//   node scripts/beppyo/weekly/run.cjs build
//
// **書かない**: R2 にも Vectorize にも書かない（読むだけ）。反映は apply（apply.cjs）。
//
// 材料は今の本番だけ（PC の途中データは使わない）:
//   - 別表: R2 の条文ファイル（wrangler.toml の ARTICLES_PREFIX。法令の週次が毎週書き換える）のうち、名前が「別表」で始まるもの
//   - homes の逆引き: R2 の refs（REFS_PREFIX）の全チャンクの target_appdx
// 作り方は PC の 13・13b・15 と同じ関数（scripts/rebuild/lib/beppyo.cjs）:
//   _beppyo: 1 別表＝1 ベクトル（id は md5('bp|法令ID|別表名')）。metadata の homes は 10KiB に収まるよう後ろから削る
//   bpr_{法令ID}_b{番号}: 3 万字以上の別表の行（id は `${法令ID}_${別表名}_g${n}`）。表が縮んだ・3 万字を切ったら余った行を消す
// 前回反映した状態の控え（R2 update_state/beppyo/vec_state.json）と比べて、新しい・本文が変わった・metadata だけ変わった・消えた、に分ける。
// 控えが無い初回:
//   - bpr: Vectorize の一覧（list-vectors）から行の形の id を拾い、実物の metadata（t＝本文）で控えを作る（本文が同じ行は埋め込み直さない）
//   - _beppyo: 本文は metadata に無いので、今ある別表は全部埋め込み直す（約 3,600 本）。今の条文に無い別表の古いベクトルは見つけられない（報告に書く）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { R2 } = require('../../update/lib/r2.cjs');
const { Vectorize } = require('../../update/lib/vectorize.cjs');
const { Embedder, cosine } = require('../../update/lib/ai.cjs');
const B = require('../../rebuild/lib/beppyo.cjs');
const { makeGenGuard } = require('../../update/lib/delta_apply.cjs');
const { LAWS_APPLY_MARK } = require('../../update/apply_mark.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VEC_INDEX = 'tsutatsu-embeddings-v1';
const META_LIMIT = 10 * 1024;
const ID_MAX_BYTES = 64;   // Vectorize の id の上限
const VEC_STATE_KEY = 'update_state/beppyo/vec_state.json';
const APPLY_LOCK_KEY = 'update_state/beppyo_apply_inprogress.json';
const LEDGER_KEY = 'update_state/sync_state.json';   // 法令の週次の台帳（下見の後に法令が反映されたら古い下見は反映しない）
const MAX_EMBED = Number(process.env.BEPPYO_MAX_EMBED || 5000);
const HARD_MAX = Number(process.env.BEPPYO_HARD_MAX || 30000);
const MAX_DELETE = Number(process.env.BEPPYO_MAX_DELETE || 300);
const DROP_MIN = Number(process.env.BEPPYO_DROP_MIN || 20);

const log = (...a) => console.log(...a);
const sha = (s) => (s == null ? null : crypto.createHash('sha256').update(s).digest('hex'));
const stableJson = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  : Array.isArray(o) ? `[${o.map(stableJson).join(',')}]` : JSON.stringify(o));
const writeNdjson = (f, arr) => fs.writeFileSync(f, arr.map((o) => JSON.stringify(o)).join('\n') + (arr.length ? '\n' : ''));
const vecSig = (v) => ({ ns: v.namespace, th: sha(v.text), mh: sha(stableJson(v.metadata)) });
const isRowNs = (ns) => /^bpr_/.test(ns || '');

// 本番の条文・refs のプレフィックス（wrangler.toml。確かめ用に BEPPYO_ARTICLES_PREFIX・BEPPYO_REFS_PREFIX で差し替えられる）
function prodPrefixes() {
  const toml = fs.readFileSync(path.join(REPO_ROOT, 'wrangler.toml'), 'utf8');
  const pick = (name, env) => {
    if (process.env[env]) return process.env[env];
    const m = toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, 'm'));
    if (!m) throw new Error(`wrangler.toml に ${name} が無い`);
    return m[1];
  };
  return { articles: pick('ARTICLES_PREFIX', 'BEPPYO_ARTICLES_PREFIX'), refs: pick('REFS_PREFIX', 'BEPPYO_REFS_PREFIX') };
}
const prodKey = (p) => `${p.articles}|${p.refs}`;

// refs の中身の印: REFS_PREFIX の一覧（鍵・ETag・大きさ・更新時刻）の hash。refs_index.json は法令 → チャンク番号の表なので、
// チャンクの中身だけ変わる（refs だけの作り直しなど）と変わらない。一覧なら 1 回の要求で中身の書き換えも分かる
async function refsSignature(r2, prefix) {
  const list = await r2.list(`${prefix}/`);
  return sha(list.map((o) => `${o.key}\t${o.etag || ''}\t${o.size}\t${o.last_modified || ''}`).sort().join('\n'));
}

// metadata が 10KiB を超える別表は homes を後ろ（refs の逆引き側）から削る → 削った数
function fitHomes(md) {
  if (Buffer.byteLength(JSON.stringify(md)) <= META_LIMIT) return 0;
  const homes = JSON.parse(md.homes);
  let cut = 0;
  while (homes.length && Buffer.byteLength(JSON.stringify({ ...md, homes: JSON.stringify(homes) })) > META_LIMIT) { homes.pop(); cut++; }
  md.homes = JSON.stringify(homes);
  return cut;
}

// ---------------------------------------------------------------- build
async function build({ out, rid }) {
  const BD = path.join(out, 'build');
  fs.rmSync(BD, { recursive: true, force: true });
  fs.mkdirSync(BD, { recursive: true });
  const report = { blockers: [], review: [], notes: [] };
  const r2 = new R2();
  const P = prodPrefixes();
  const gen = await makeGenGuard(r2, APPLY_LOCK_KEY);   // 世代 → 印の順に読む。読み終えるまでに反映・戻しが入ったら、この下見は使わない
  const lock = gen.lock;
  if (lock) report.blockers.push(`前回の別表の${lock.kind === 'restore' ? '戻し' : '反映'}（run ${lock.run_id}・${lock.phase}・${lock.started_at} 開始）が途中で止まっている（${APPLY_LOCK_KEY} が残っている）。Actions の Update beppyo vectors を mode=restore・restore_run_id=${lock.run_id} で戻してから流し直す`);
  const ledgerBuf = await r2.get(LEDGER_KEY);
  // 法令の週次の反映中（条文・refs が書きかけ）なら比べない。印は反映が全部通ってから外れる
  const lawMark = await r2.getJson(LAWS_APPLY_MARK);
  if (lawMark) report.blockers.push(`法令の週次の反映（run ${lawMark.run_id}・${lawMark.mode}・${lawMark.started_at} 開始）が途中（${LAWS_APPLY_MARK} が残っている）。条文・refs が書きかけなので比べない。法令の週次を流し直して反映を終えてから流す`);
  const refsSig = await refsSignature(r2, P.refs);   // 読み終えた後と反映のときに、refs の中身が変わっていないかを見る
  if (!ledgerBuf) throw new Error(`法令の台帳 ${LEDGER_KEY} が無い。書かずに止める`);

  // ---- 1. refs の逆引き（全チャンク）
  const refsIndexBuf = await r2.get(`${P.refs}/refs_index.json`);
  if (!refsIndexBuf) throw new Error(`${P.refs}/refs_index.json が無い。書かずに止める`);
  const refsIndex = JSON.parse(refsIndexBuf.toString('utf8'));
  const chunkNums = [...new Set(Object.values(refsIndex))].sort((a, b) => a - b);
  const homesMap = {};
  const hstats = {};
  for (const num of chunkNums) {
    const key = `${P.refs}/refs_chunk_${String(num).padStart(3, '0')}.json`;
    const ch = await r2.getJson(key);
    // 索引に載っているのに無いチャンクがあれば止める（黙って飛ばすと、その法令から来る homes を消す下見になる）
    if (!ch || typeof ch !== 'object' || Array.isArray(ch)) throw new Error(`${key} が無い・形が違う（refs_index.json には載っている）。書かずに止める`);
    // refs_index.json がこのチャンクに割り当てている法令が、どれもチャンクに refs として在るか（欠けたまま進めると、その法令から来る homes を消す下見になる。空の refs {} は正常）
    const want = Object.entries(refsIndex).filter(([, n]) => n === num).map(([id]) => id);
    const bad = want.filter((id) => !ch[id] || typeof ch[id].refs !== 'object' || ch[id].refs === null || Array.isArray(ch[id].refs));
    if (bad.length) throw new Error(`${key} に refs_index.json が載せている法令の refs が無い・形が違う（${bad.slice(0, 5).join('、')}${bad.length > 5 ? ' ほか' : ''}）。書かずに止める`);
    for (const law of Object.values(ch)) B.addAppdxHomes(homesMap, (law && law.refs) || {}, hstats);
  }
  const refsHomes = B.finishAppdxHomes(homesMap);
  report.notes.push(`refs: チャンク ${chunkNums.length}・別表への参照 ${hstats.appdxRefs || 0}（別表に付いた ${hstats.attached || 0}）・homes の付く別表 ${Object.keys(refsHomes).length}`);

  // ---- 2. 別表のファイル（本番の条文）
  const all = await r2.list(`${P.articles}/`);
  const files = all.filter((o) => /^別表.*\.json$/.test(path.posix.basename(o.key))).map((o) => o.key).sort();
  if (!files.length) throw new Error(`${P.articles}/ に別表のファイルが 1 つも無い（一覧が取れていない）。書かずに止める`);
  const desired = new Map();   // id -> { id, namespace, text, metadata }（同じ id は後のものが勝つ＝13・15 の upsert の順と同じ）
  let tables = 0, bigTables = 0, homesCut = 0, badFiles = [];
  const longIds = [];
  const put = (id, namespace, text, metadata) => {
    if (Buffer.byteLength(id) > ID_MAX_BYTES) { longIds.push(id); return; }
    desired.set(id, { id, namespace, text, metadata });
  };
  for (const key of files) {
    const data = await r2.getJson(key);
    if (!data || !Array.isArray(data.articles)) { badFiles.push(key); continue; }
    const lawId = data.law_id || '', lawTitle = data.law_title || '';
    for (const art of data.articles) {
      const e = B.beppyoEntry(lawId, lawTitle, art, refsHomes);
      if (!e) continue;
      tables++;
      homesCut += fitHomes(e.metadata);
      put(e.id, e.ns, e.text, e.metadata);
      if (B.isBigTable(art)) {
        bigTables++;
        for (const r of B.buildRows(lawId, art)) put(r.id, r.ns, r.text, r.metadata);
      }
    }
  }
  if (badFiles.length) report.blockers.push(`別表のファイルが読めない・形が違う ${badFiles.length} 本: ${badFiles.slice(0, 5).join('、')}${badFiles.length > 5 ? ' ほか' : ''}`);
  if (homesCut) report.notes.push(`metadata が 10KiB を超える別表の homes を ${homesCut} 件削った（refs の逆引き側から）`);
  if (longIds.length) report.notes.push(`id が ${ID_MAX_BYTES} バイトを超える行 ${longIds.length} 本は作らない（Vectorize に入らない。例 ${longIds[0]}）`);
  const nBp = [...desired.values()].filter((v) => v.namespace === B.NS).length, nRow = desired.size - nBp;
  report.notes.push(`別表のファイル ${files.length}・別表 ${tables}（大別表 ${bigTables}）→ _beppyo ${nBp} 本・行 ${nRow} 本`);
  const tooBig = [...desired.values()].filter((v) => Buffer.byteLength(JSON.stringify(v.metadata)) > META_LIMIT);
  if (tooBig.length) report.blockers.push(`metadata が 10KiB を超えるベクトルが ${tooBig.length} 本（例 ${tooBig[0].id}）`);

  // ---- 3. 状態の控えと比べる
  const vec = new Vectorize({ index: VEC_INDEX });
  const stateBuf = await r2.get(VEC_STATE_KEY);
  let vecState = stateBuf ? JSON.parse(stateBuf.toString('utf8')) : null;
  const firstRun = !vecState;
  const PACE = Number(process.env.BEPPYO_VEC_PACE_MS || 400);
  const getAll = async (ids) => {
    const got = [];
    for (let i = 0; i < ids.length; i += 20) {
      got.push(...await vec.getByIds(ids.slice(i, i + 20)));
      if (PACE && !vec.fakeFile && i + 20 < ids.length) await new Promise((r) => setTimeout(r, PACE));
    }
    return got;
  };
  if (firstRun) {
    report.review.push('初回: 反映した状態の控え（update_state/beppyo/vec_state.json）が無いので、Vectorize の実物から作った。_beppyo は本文が metadata に無いので全部埋め込み直す（今の条文に無い別表の古い _beppyo は見つけられない）');
    vecState = {};
    const bpIds = [...desired.values()].filter((v) => v.namespace === B.NS).map((v) => v.id);
    for (const g of await getAll(bpIds)) vecState[g.id] = { ns: g.namespace || B.NS, th: null, mh: sha(stableJson(g.metadata || {})) };
    const listed = (await vec.listIds()).filter((id) => B.rowIdParts(id));
    for (const g of await getAll(listed)) {
      const p = B.rowIdParts(g.id);
      const t = g.metadata && typeof g.metadata.t === 'string' ? g.metadata.t : null;
      vecState[g.id] = { ns: g.namespace || p.ns, th: t == null ? null : sha(t), mh: sha(stableJson(g.metadata || {})) };
    }
    report.notes.push(`初回の確かめ: _beppyo 候補 ${bpIds.length} 本のうち Vectorize にあった ${Object.values(vecState).filter((s) => s.ns === B.NS).length} 本・一覧にあった行 ${listed.length} 本`);
  }
  const prevBp = Object.values(vecState).filter((s) => s.ns === B.NS).length;
  const prevRow = Object.values(vecState).filter((s) => isRowNs(s.ns)).length;
  if (!firstRun && nBp < prevBp * 0.9 && prevBp - nBp > DROP_MIN) report.blockers.push(`別表（_beppyo）が 1 割超減った（${prevBp} → ${nBp}）。条文の一覧が取れていない疑い`);
  if (!firstRun && nRow < prevRow * 0.9 && prevRow - nRow > DROP_MIN * 10) report.blockers.push(`大別表の行が 1 割超減った（${prevRow} → ${nRow}）`);

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
  const delBp = deletes.filter((d) => d.namespace === B.NS);
  if (upserts.length > MAX_EMBED) report.review.push(`埋め込むベクトルが ${upserts.length} 本（${MAX_EMBED} 本超）`);
  if (deletes.length > MAX_DELETE) report.review.push(`消すベクトルが ${deletes.length} 本（${MAX_DELETE} 本超。_beppyo ${delBp.length}・行 ${deletes.length - delBp.length}）`);
  if (upserts.length > HARD_MAX) report.blockers.push(`埋め込むベクトルが ${upserts.length} 本（${HARD_MAX} 本超）。状態の控えか条文の読み取りが崩れている疑い`);

  // ---- 4. 埋め込み・ずれの確かめ
  const emb = new Embedder();
  const toEmbed = upserts.length > HARD_MAX ? [] : upserts;
  const values = toEmbed.length ? await emb.embed(toEmbed.map((u) => u.text)) : [];
  const vectors = toEmbed.map((u, i) => ({ id: u.id, namespace: u.namespace, values: values[i], metadata: u.metadata, why: u.why }));
  const samples = [...desired.values()].filter((v) => vecState[v.id] && vecState[v.id].th === sha(v.text)).slice(0, 5);
  if (samples.length) {
    const got = new Map((await vec.getByIds(samples.map((s) => s.id))).map((g) => [g.id, g]));
    const re = await emb.embed(samples.map((s) => s.text));
    const cos = samples.map((s, i) => (got.get(s.id) && Array.isArray(got.get(s.id).values) ? cosine(re[i], got.get(s.id).values) : NaN));
    const bad = cos.filter((c) => !Number.isFinite(c) || c < 0.98);
    report.notes.push(`埋め込みの自己一致: ${cos.map((c) => (Number.isFinite(c) ? c.toFixed(4) : '取れない')).join(' / ')}`);
    if (bad.length) report.blockers.push(`埋め込みのずれ: 既存 ${samples.length} 本のうち ${bad.length} 本が 0.98 未満（Workers AI の出力が索引と合わない。AI_POOLING を確かめる）`);
    if (samples.length < 3 && upserts.length) report.review.push(`埋め込みのずれを ${samples.length} 本しか確かめられなかった`);   // 埋め込まない回は確かめる本数を問わない
  } else if (upserts.length) report.review.push('埋め込みのずれを確かめる既存のベクトルが無かった');

  // ---- 5. 成果物（本番を読み終えた。途中で反映・戻しが入っていれば捨てる）
  if (process.env.BEPPYO_TEST_MID_BUILD) require('child_process').execSync(process.env.BEPPYO_TEST_MID_BUILD, { stdio: 'inherit' });   // 確かめ用: 下見の途中に戻しを挟む
  await gen.verify();
  if (!lawMark && await r2.getJson(LAWS_APPLY_MARK)) throw new Error(`下見の途中で法令の週次の反映が始まった（${LAWS_APPLY_MARK} が現れた）。この下見は使わない。何も書いていない。流し直す`);
  if (sha(await r2.get(LEDGER_KEY)) !== sha(ledgerBuf)) throw new Error(`下見の途中で法令の週次が反映された（${LEDGER_KEY} が変わった）。読んだ条文・refs が途中で変わりうるので、この下見は使わない。何も書いていない。流し直す`);
  if (await refsSignature(r2, P.refs) !== refsSig) throw new Error(`下見の途中で refs（${P.refs}）が書き換わった。この下見は使わない。何も書いていない。流し直す`);
  writeNdjson(path.join(BD, 'vectors.ndjson'), vectors);
  writeNdjson(path.join(BD, 'meta_updates.ndjson'), metaUpdates);
  writeNdjson(path.join(BD, 'deletes.ndjson'), deletes);
  fs.writeFileSync(path.join(BD, 'vec_state_next.json'), JSON.stringify(nextState));
  const changedTables = [...new Set([...upserts, ...metaUpdates, ...deletes].map((v) => {
    if (v.namespace === B.NS) { const d = desired.get(v.id); return d ? `${d.metadata.law_title} ${d.metadata.article_title}` : `（消える _beppyo ${v.id}）`; }
    const p = B.rowIdParts(v.id); return p ? `${p.lawId} ${p.title}（行）` : v.id;
  }))].sort();
  const m = {
    run_id: rid, created_at: new Date().toISOString(), first_run: firstRun,
    prod_prefix: prodKey(P), ledger_sha: sha(ledgerBuf), refs_index_sha: sha(refsIndexBuf), refs_sig: refsSig,
    vec_state_sha_before: stateBuf ? sha(stateBuf) : null, gen_sha_before: gen.sha,
    files: {},
    counts: { files: files.length, tables, big_tables: bigTables, beppyo: nBp, rows: nRow, prev_beppyo: prevBp, prev_rows: prevRow },
    vectors: { upsert: vectors.length, upsert_new: upserts.filter((u) => u.why === 'new').length, upsert_text: upserts.filter((u) => u.why === 'text').length, meta_update: metaUpdates.length, delete: deletes.length },
    changed_tables: changedTables,
    blockers: report.blockers, review: report.review, notes: report.notes,
  };
  m.ok_to_apply = !m.blockers.length;
  m.needs_review = m.review.length > 0;
  m.nothing_to_do = !vectors.length && !metaUpdates.length && !deletes.length && !m.blockers.length && !m.review.length;
  fs.writeFileSync(path.join(BD, 'manifest.json'), JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(BD, 'report.md'), renderReport(m));
  log(`\nbuild: _beppyo ${nBp}・行 ${nRow} / 埋め込み ${vectors.length}・metadata ${metaUpdates.length}・削除 ${deletes.length} / 止めた理由 ${m.blockers.length}・見直す ${m.review.length}`);
  return m;
}

function renderReport(m) {
  const c = m.counts, v = m.vectors;
  const L = [`# 別表のベクトルの作り直し（反映の下見）run ${m.run_id}`, '',
    `- 本番: ${m.prod_prefix.replace('|', '・')}`,
    `- 別表のファイル ${c.files}・別表 ${c.tables}（大別表 ${c.big_tables}）`,
    `- _beppyo: ${c.prev_beppyo} → ${c.beppyo} 本・大別表の行: ${c.prev_rows} → ${c.rows} 本`,
    `- ベクトル: 埋め込む ${v.upsert}（新しい ${v.upsert_new}・本文が変わった ${v.upsert_text}）・metadata だけ ${v.meta_update}・消す ${v.delete}${m.first_run ? '（初回）' : ''}`, ''];
  if (m.blockers.length) { L.push('## 止めた理由', ''); for (const b of m.blockers) L.push(`- ${b}`); L.push(''); }
  if (m.review.length) { L.push('## 見直す対象', ''); for (const b of m.review) L.push(`- ${b}`); L.push(''); }
  if (m.notes.length) { L.push('## メモ', ''); for (const b of m.notes) L.push(`- ${b}`); L.push(''); }
  if (m.changed_tables.length) L.push(`## 変わる別表（${m.changed_tables.length}）`, '', ...m.changed_tables.slice(0, 200).map((x) => `- ${x}`), ...(m.changed_tables.length > 200 ? [`- ほか ${m.changed_tables.length - 200}`] : []), '');
  return L.join('\n') + '\n';
}

module.exports = { build, prodPrefixes, prodKey, refsSignature, VEC_STATE_KEY, APPLY_LOCK_KEY, LEDGER_KEY, META_LIMIT, VEC_INDEX };
