// 租税条約（R2 treaty/v1・Vectorize の _treaty）の週次更新: 財務省の一覧と現行和文 PDF を取り直し（crawl.py）、変わった国だけ解析して、
// 今の本番と比べて「反映したら何が変わるか」を作る（反映の下見）。
//
//   node scripts/treaty/weekly/run.cjs build
//
// **書かない**: R2 にも Vectorize にも書かない（読むだけ）。反映は apply（apply.cjs）。
//
//   - 一覧の選び方・PDF の読み取り・条の分け方は 01・02 の実物（crawl.py）。前回の状態の控え（R2 update_state/treaty/state.json）の
//     ETag / Last-Modified で PDF を条件付きで取り、変わっていない国は本番のまま使う（控えが無い初回は全部取り直して解析し、本番と比べる）
//   - 条の見出し: 本文が 10 字未満の条は「（削除）」（前の見出しは引き継がない）。それ以外は本番の同じ国・同じ条番号の見出しを引き継ぐ（03 と同じ）。見出しの無い条は空のまま
//     （**LLM は使わない**。件数を見直す対象に出す）
//   - R2 のファイルとベクトルは 04 と同じ形（index.json・{slug}.json・id tr_{slug}_{条番号}）。スロバキアは 02 と同じく、自分の PDF にテキスト層が無いときだけ
//     チェコの文書を承継適用（自分の PDF で載っている回の翌週に 304＝same になっても、承継で上書きしない）
//   - 今回読めなかった国（テキスト層の無い PDF に差し替わった・一覧から消えた）は本番のまま残す（消さない。見直す対象に出す）
//   - PDF が取れなかった国（404・5xx・通信の失敗。crawl.py の failed）は止める理由にする（古い条文のまま控えだけ進めない）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { R2 } = require('../../update/lib/r2.cjs');
const { Vectorize } = require('../../update/lib/vectorize.cjs');
const { Embedder, cosine } = require('../../update/lib/ai.cjs');
const { makeGenGuard } = require('../../update/lib/delta_apply.cjs');

const PREFIX = 'treaty/v1';
const NS = '_treaty';
const VEC_INDEX = 'tsutatsu-embeddings-v1';
const META_LIMIT = 10 * 1024;
const STATE_KEY = 'update_state/treaty/state.json';
const VEC_STATE_KEY = 'update_state/treaty/vec_state.json';
const APPLY_LOCK_KEY = 'update_state/treaty_apply_inprogress.json';
const SLOVAKIA_NOTE = 'チェコスロバキア条約の承継適用（チェコと同一文書）';

const log = (...a) => console.log(...a);
const sha = (s) => (s == null ? null : crypto.createHash('sha256').update(s).digest('hex'));
const stableJson = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  : Array.isArray(o) ? `[${o.map(stableJson).join(',')}]` : JSON.stringify(o));
const writeNdjson = (f, arr) => fs.writeFileSync(f, arr.map((o) => JSON.stringify(o)).join('\n') + (arr.length ? '\n' : ''));
const vecSig = (v) => ({ ns: v.namespace, th: sha(v.text), mh: sha(stableJson(v.metadata)) });

// ---------------------------------------------------------------- 04 と同じ形
const slugOf = (country) => crypto.createHash('md5').update(country).digest('hex').slice(0, 8);
function kindOf(title) {
  return (/情報の交換/.test(title) && !/二重課税/.test(title)) ? '情報交換協定' : /条約/.test(title) ? '租税条約' : '租税協定';
}
// R2 の {slug}.json の形（04 の body と同じ鍵の順）
function toFile({ country, title, src, doc_type, note, articles }) {
  const kind = kindOf(title || '');
  return { country, title, short: `日・${country}${kind}`, kind, src, doc_type, ...(note ? { note } : {}), articles };
}
const indexEntry = (f) => ({ c: f.country, slug: slugOf(f.country), kind: f.kind, short: f.short, title: f.title, src: f.src, doc_type: f.doc_type, n: f.articles.length, ...(f.note ? { note: f.note } : {}) });
function desiredVectors(files) {
  const out = new Map();
  for (const t of files) {
    const s = slugOf(t.country);
    for (const a of t.articles) {
      const label = a.no === 0 ? '議定書等' : `第${a.no}条`;
      const id = `tr_${s}_${a.no}`;
      out.set(id, {
        id, namespace: NS,
        text: `${t.short} ${label}（${a.cap || ''}） ${(a.body || '').slice(0, 1200)}`,
        metadata: { c: t.country, s, no: String(a.no), cap: (a.cap || '').slice(0, 60), t: t.short, src: t.src, b: (a.body || '').slice(0, 350) },
      });
    }
  }
  return out;
}
// 03 と同じ見出しの引き継ぎ（見出しの無い条だけ、本番の同じ国・同じ条番号から）→ 空のまま残った条の数
function carryCaptions(articles, prodArticles) {
  const prevCap = new Map((prodArticles || []).filter((a) => a.cap).map((a) => [a.no, a.cap]));
  let empty = 0;
  for (const a of articles) {
    if (a.no === 0 || a.cap) continue;
    // 削除された条は、前の見出しを引き継がない（先に見る）
    if ((a.body || '').replace(/\s/g, '').length < 10) { a.cap = '（削除）'; continue; }
    if (prevCap.has(a.no)) { a.cap = prevCap.get(a.no); continue; }
    empty++;
  }
  return empty;
}

function runProc(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('close', (code, signal) => resolve(code === 0 ? 0 : (code == null ? `signal ${signal || '?'}` : code)));
    p.on('error', () => resolve(127));
  });
}

// ---------------------------------------------------------------- build
async function build({ out, rid }) {
  const BD = path.join(out, 'build'), W = path.join(out, 'work');
  for (const d of [BD, W]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(BD, 'files'), { recursive: true });
  fs.mkdirSync(W, { recursive: true });
  const report = { blockers: [], review: [], notes: [] };
  const r2 = new R2();
  const gen = await makeGenGuard(r2, APPLY_LOCK_KEY);   // 世代 → 印の順に読む。読み終えるまでに反映・戻しが入ったら、この下見は使わない
  const lock = gen.lock;
  if (lock) report.blockers.push(`前回の租税条約の${lock.kind === 'restore' ? '戻し' : '反映'}（run ${lock.run_id}・${lock.phase}・${lock.started_at} 開始）が途中で止まっている（${APPLY_LOCK_KEY} が残っている）。Actions の Update treaties を mode=restore・restore_run_id=${lock.run_id} で戻してから流し直す`);

  // ---- 1. 今の本番
  const prodIndexBuf = await r2.get(`${PREFIX}/index.json`);
  if (!prodIndexBuf) throw new Error(`${PREFIX}/index.json が無い。書かずに止める`);
  const prodIndex = JSON.parse(prodIndexBuf.toString('utf8'));
  const prod = new Map(), prodRaw = new Map();
  for (const e of prodIndex.countries || []) {
    const key = `${PREFIX}/${e.slug}.json`;
    const b = await r2.get(key);
    let f = null;
    try { f = b ? JSON.parse(b.toString('utf8')) : null; } catch { f = null; }
    if (!f || !Array.isArray(f.articles)) throw new Error(`${key} が無い・形が違う（index.json には載っている）。書かずに止める`);
    prod.set(e.c, f); prodRaw.set(e.slug, b);
  }

  // ---- 2. 取り直し（crawl.py）
  const stateBuf = await r2.get(STATE_KEY);
  const state = stateBuf ? JSON.parse(stateBuf.toString('utf8')) : null;
  fs.writeFileSync(path.join(W, 'prev.json'), JSON.stringify(state || {}));
  fs.writeFileSync(path.join(W, 'prod.json'), JSON.stringify(Object.fromEntries([...prod].map(([c, f]) => [c, f.src]))));
  const code = await runProc(process.env.PYTHON || 'python3', [path.join(__dirname, 'crawl.py'), '--prev', path.join(W, 'prev.json'), '--prod', path.join(W, 'prod.json'), '--out', W]);
  if (code) throw new Error(`crawl.py が落ちた（${code}）。財務省の一覧か PDF が取れていない。書かずに止める`);
  const crawl = JSON.parse(fs.readFileSync(path.join(W, 'crawl.json'), 'utf8'));
  const firstRun = !state;
  if (firstRun) report.review.push(`初回: 状態の控え（${STATE_KEY}）が無いので、全部の国の PDF を取り直して解析し、今の本番（PC で作ったもの）と比べた`);

  // ---- 3. 国ごとに今回の姿を決める（本番の並び → 新しい国は一覧の並び）
  const now = new Map();
  const parsedC = [], newC = [], keptC = [], emptyCaps = [], failedC = [];
  // スロバキア: チェコの文書がチェコスロバキア条約で、スロバキア自身の PDF が読めない（テキスト層なし）ときだけ承継適用（02 と同じ）。
  //   一覧に無いときは、本番がもともと承継のときだけ（本番が自分の PDF なら本番のまま）
  const sk = crawl.countries.find((x) => x.country === 'スロバキア');
  const skProd = prod.get('スロバキア');
  const skSucceed = sk ? sk.status === 'phase2' : (!skProd || skProd.note === SLOVAKIA_NOTE);
  for (const c of crawl.countries) {
    const p = prod.get(c.country);
    if (c.status === 'parsed') {
      const articles = c.articles.map((a) => ({ ...a }));
      const empty = carryCaptions(articles, p && p.articles);
      if (empty) emptyCaps.push(`${c.country} ${empty} 条`);
      const f = toFile({ country: c.country, title: c.treaty_title, src: c.source_url, doc_type: c.doc_type, note: p && p.note && c.country !== 'スロバキア' ? p.note : undefined, articles });
      now.set(c.country, f);
      if (!p) newC.push(c.country);
      else if (stableJson(p) !== stableJson(f)) parsedC.push(`${c.country}（${p.articles.length} → ${f.articles.length} 条${c.flags && c.flags.length ? `・${c.flags.join('・')}` : ''}）`);
    } else {
      if (c.status === 'failed') failedC.push(`${c.country}（${c.reason}）`);
      if (!p) continue;
      now.set(c.country, p);
      if (c.status === 'phase2' && c.country !== 'スロバキア') keptC.push(`${c.country}（${c.reason}）`);
    }
  }
  for (const [c, p] of prod) if (!crawl.countries.some((x) => x.country === c)) { now.set(c, p); keptC.push(`${c}（財務省の一覧に無い）`); }
  // スロバキア: チェコの文書がチェコスロバキア条約なら、スロバキアはその承継適用（02 と同じ）
  const cz = now.get('チェコ');
  if (skSucceed && cz && /チェッコスロヴァキア/.test(cz.title || '')) {
    // 見出しは PC で国ごとに付けたので、スロバキアの本番の見出しがあればそれを使う（削除された条は「（削除）」のまま。前の見出しを引き継がない）
    const skCap = new Map(((prod.get('スロバキア') || {}).articles || []).filter((a) => a.cap).map((a) => [a.no, a.cap]));
    const isDeleted = (a) => a.no !== 0 && (a.body || '').replace(/\s/g, '').length < 10;
    const articles = cz.articles.map((a) => ({ ...a, ...(isDeleted(a) ? { cap: '（削除）' } : skCap.has(a.no) ? { cap: skCap.get(a.no) } : {}) }));
    const f = toFile({ country: 'スロバキア', title: cz.title, src: cz.src, doc_type: cz.doc_type, note: SLOVAKIA_NOTE, articles });
    if (!prod.has('スロバキア')) newC.push('スロバキア');
    else if (stableJson(prod.get('スロバキア')) !== stableJson(f)) parsedC.push('スロバキア（チェコの文書の承継適用）');
    now.set('スロバキア', f);
  } else if (sk && sk.status === 'phase2' && skProd) keptC.push(`スロバキア（${sk.reason}）`);
  const order = [...(prodIndex.countries || []).map((e) => e.c).filter((c) => now.has(c)), ...[...now.keys()].filter((c) => !prod.has(c))];
  const finals = order.map((c) => now.get(c));
  if (parsedC.length) report.review.push(`条文が変わった国 ${parsedC.length}（財務省の PDF が変わった。見て良ければ反映）: ${parsedC.join('、')}`);
  if (newC.length) report.review.push(`新しい国 ${newC.length}: ${newC.join('、')}`);
  if (failedC.length) report.blockers.push(`財務省の PDF が取れなかった国 ${failedC.length}（本番の条文が古いままになるので止める。財務省の URL が変わったか、一時的な障害。流し直すか、01 の選び方を直す）: ${failedC.join('、')}`);
  if (keptC.length) report.notes.push(`今回取れなかった国は本番のまま残す: ${keptC.join('、')}`);
  if (emptyCaps.length) report.review.push(`見出しの無い条（LLM を使わないので空のまま。検索には本文で出る）: ${emptyCaps.join('、')}`);
  // 一覧の形が変わると国が拾えなくなる（テキスト層の無い国も一覧には載るので、一覧に載った国の数で見る）
  if (crawl.countries.length < prod.size * 0.7) report.blockers.push(`財務省の一覧から取れた国が少なすぎる（${crawl.countries.length}。本番は ${prod.size}）。一覧の形が変わった疑い`);

  // ---- 4. R2 のファイル
  const files = {};
  const putFile = (key, obj, before) => {
    const local = `files/${key.replace(/\//g, '__')}`;
    fs.writeFileSync(path.join(BD, local), JSON.stringify(obj));
    files[key] = { sha_before: before ? sha(before) : null, local };
  };
  for (const f of finals) {
    const slug = slugOf(f.country);
    const p = prod.get(f.country);
    if (p && stableJson(p) === stableJson(f)) continue;
    putFile(`${PREFIX}/${slug}.json`, f, prodRaw.get(slug) || await r2.get(`${PREFIX}/${slug}.json`));
  }
  const index = { ...prodIndex, version: prodIndex.version || 1, countries: finals.map(indexEntry) };
  if (stableJson(index) !== stableJson(prodIndex)) putFile(`${PREFIX}/index.json`, index, prodIndexBuf);

  // ---- 5. ベクトル
  const desired = desiredVectors(finals);
  const tooBig = [...desired.values()].filter((v) => Buffer.byteLength(JSON.stringify(v.metadata)) > META_LIMIT);
  if (tooBig.length) report.blockers.push(`metadata が 10KiB を超えるベクトルが ${tooBig.length} 本（例 ${tooBig[0].id}）`);
  const vec = new Vectorize({ index: VEC_INDEX });
  const vsBuf = await r2.get(VEC_STATE_KEY);
  let vecState = vsBuf ? JSON.parse(vsBuf.toString('utf8')) : null;
  if (!vecState) {
    report.notes.push('ベクトルの状態の控えが無いので、本番のファイルから 04 と同じ作り方で組み立てた本文と、Vectorize の実物の metadata で作った');
    const prodDesired = desiredVectors([...prod.values()]);
    const ids = [...new Set([...prodDesired.keys(), ...desired.keys()])];
    vecState = {};
    for (let i = 0; i < ids.length; i += 20) {
      for (const g of await vec.getByIds(ids.slice(i, i + 20))) {
        const pv = prodDesired.get(g.id);
        vecState[g.id] = { ns: g.namespace || NS, th: pv ? sha(pv.text) : null, mh: sha(stableJson(g.metadata || {})) };
      }
      if (!vec.fakeFile) await new Promise((r) => setTimeout(r, Number(process.env.TREATY_VEC_PACE_MS || 400)));
    }
  }
  const upserts = [], metaUpdates = [], deletes = [], nextVec = {};
  for (const [id, v] of desired) {
    const s = vecSig(v);
    nextVec[id] = s;
    const cur = vecState[id];
    if (!cur || cur.th === null || cur.th !== s.th || cur.ns !== s.ns) upserts.push({ ...v, why: !cur ? 'new' : 'text' });
    else if (cur.mh !== s.mh) metaUpdates.push({ id, namespace: v.namespace, metadata: v.metadata });
  }
  for (const [id, cur] of Object.entries(vecState)) if (!desired.has(id)) deletes.push({ id, namespace: cur.ns });
  if (deletes.length) report.review.push(`消えるベクトル ${deletes.length} 本（条が減った国）`);
  const emb = new Embedder();
  const values = upserts.length ? await emb.embed(upserts.map((u) => u.text)) : [];
  const vectors = upserts.map((u, i) => ({ id: u.id, namespace: u.namespace, values: values[i], metadata: u.metadata, why: u.why }));
  const samples = [...desired.values()].filter((v) => vecState[v.id] && vecState[v.id].th === sha(v.text)).slice(0, 5);
  if (samples.length && upserts.length) {
    const got = new Map((await vec.getByIds(samples.map((s) => s.id))).map((g) => [g.id, g]));
    const re = await emb.embed(samples.map((s) => s.text));
    const cos = samples.map((s, i) => (got.get(s.id) && Array.isArray(got.get(s.id).values) ? cosine(re[i], got.get(s.id).values) : NaN));
    const bad = cos.filter((c) => !Number.isFinite(c) || c < 0.98);
    report.notes.push(`埋め込みの自己一致: ${cos.map((c) => (Number.isFinite(c) ? c.toFixed(4) : '取れない')).join(' / ')}`);
    if (bad.length) report.blockers.push(`埋め込みのずれ: 既存 ${samples.length} 本のうち ${bad.length} 本が 0.98 未満（Workers AI の出力が索引と合わない。AI_POOLING を確かめる）`);
    if (samples.length < 3) report.review.push(`埋め込みのずれを ${samples.length} 本しか確かめられなかった`);
  } else if (upserts.length) report.review.push('埋め込みのずれを確かめる既存のベクトルが無かった');

  // ---- 6. 成果物（本番を読み終えた。途中で反映・戻しが入っていれば捨てる）
  if (process.env.TREATY_TEST_MID_BUILD) require('child_process').execSync(process.env.TREATY_TEST_MID_BUILD, { stdio: 'inherit' });
  await gen.verify();
  writeNdjson(path.join(BD, 'vectors.ndjson'), vectors);
  writeNdjson(path.join(BD, 'meta_updates.ndjson'), metaUpdates);
  writeNdjson(path.join(BD, 'deletes.ndjson'), deletes);
  fs.writeFileSync(path.join(BD, 'vec_state_next.json'), JSON.stringify(nextVec));
  const nextState = { countries: Object.fromEntries(crawl.countries.map((c) => [c.country, { candidates: c.candidates, picked: c.picked }])), pdfs: crawl.pdfs };
  fs.writeFileSync(path.join(BD, 'state_next.json'), JSON.stringify(nextState));
  const stateChanged = !state || stableJson(state) !== stableJson(nextState);
  const m = {
    run_id: rid, created_at: new Date().toISOString(), first_run: firstRun,
    gen_sha_before: gen.sha, vec_state_sha_before: sha(vsBuf), state_sha_before: sha(stateBuf),
    files, counts: { ...crawl.counts, countries_prod: prod.size, countries_now: finals.length, changed: parsedC.length, new: newC.length },
    vectors: { upsert: vectors.length, upsert_new: upserts.filter((u) => u.why === 'new').length, upsert_text: upserts.filter((u) => u.why === 'text').length, meta_update: metaUpdates.length, delete: deletes.length },
    state_changed: stateChanged,
    blockers: report.blockers, review: report.review, notes: report.notes,
  };
  m.ok_to_apply = !m.blockers.length;
  m.needs_review = m.review.length > 0;
  m.nothing_to_do = !Object.keys(files).length && !vectors.length && !metaUpdates.length && !deletes.length && !stateChanged && !m.blockers.length && !m.review.length;
  fs.writeFileSync(path.join(BD, 'manifest.json'), JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(BD, 'report.md'), renderReport(m));
  log(`\nbuild: 国 ${finals.length}（変わった ${parsedC.length}・新しい ${newC.length}）/ ファイル ${Object.keys(files).length} / ベクトル 埋め込み ${vectors.length}・metadata ${metaUpdates.length}・削除 ${deletes.length} / 止めた理由 ${m.blockers.length}・見直す ${m.review.length}`);
  return m;
}

function renderReport(m) {
  const c = m.counts, v = m.vectors;
  const L = [`# 租税条約の作り直し（反映の下見）run ${m.run_id}`, '',
    `- 国: 本番 ${c.countries_prod} → 今回 ${c.countries_now}（条文が変わった ${c.changed}・新しい ${c.new}）`,
    `- 財務省: 変わらない ${c.same}・解析 ${c.parsed}・テキスト層なし ${c.phase2}・取れない ${c.failed || 0} / PDF 取得 ${c.pdf_200}・304 ${c.pdf_304}`,
    `- 書くファイル: ${Object.keys(m.files).length}`,
    `- ベクトル: 埋め込む ${v.upsert}（新しい ${v.upsert_new}・本文が変わった ${v.upsert_text}）・metadata だけ ${v.meta_update}・消す ${v.delete}${m.first_run ? '（初回）' : ''}`, ''];
  if (m.blockers.length) { L.push('## 止めた理由', ''); for (const b of m.blockers) L.push(`- ${b}`); L.push(''); }
  if (m.review.length) { L.push('## 見直す対象', ''); for (const b of m.review) L.push(`- ${b}`); L.push(''); }
  if (m.notes.length) { L.push('## メモ', ''); for (const b of m.notes) L.push(`- ${b}`); L.push(''); }
  return L.join('\n') + '\n';
}

module.exports = { build, PREFIX, STATE_KEY, VEC_STATE_KEY, APPLY_LOCK_KEY, META_LIMIT, VEC_INDEX, slugOf, toFile, desiredVectors };
