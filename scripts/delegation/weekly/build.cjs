// 委任先（DELEGATIONS_PREFIX。「政令で定める」→ 受け皿の条）の週次更新: 法令の週次で変わった法令の周りだけ紐付けをやり直し、
// 今の本番の配信用チャンクと比べて「反映したら何が変わるか」を作る（反映の下見）。
//
//   node scripts/delegation/weekly/run.cjs build
//
// **書かない**: R2 にも Vectorize にも書かない（読むだけ）。反映は apply（apply.cjs）。
//
// 材料は今の本番だけ（K: ドライブの fetched_laws・refs_v2.json は使わない）:
//   - 条文: R2 の ARTICLES_PREFIX（法令の週次が毎週書き換える）。r2laws.cjs で PC の fetched_laws と同じ形に組み立てる
//   - 逆引き: R2 の REFS_PREFIX の全チャンク（00_index_refs と同じく external / varref で、参照先が自分でないもの）
// 紐付けは今までの実物（01_extract_delegations の extractLaw・02_link_by_reverse の linkParent・07 の slimLaw）をそのまま使う（LLM は使わない）。
//
// やり直す法令（親）: 前回反映した状態の控え（R2 update_state/delegations/state.json）と比べて、条文（一覧の ETag）か refs が変わった法令と、
//   その法令が前回・今回に引いていた法令（子が変われば親の受け皿が変わる）。控えが無い初回（と DELEG_FULL=1）は全法令をやり直す
//   （本番は PC で作ったものなので、全部と比べて違いを見直す対象に出す）。
// 配信用チャンクは今の本番のものを直して書く（チャンクの割り当ては変えない。新しい法令は最後のチャンクへ、2MB を超えたら次のチャンクへ）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { R2 } = require('../../update/lib/r2.cjs');
const { makeGenGuard } = require('../../update/lib/delta_apply.cjs');
const { fetchLaw, pool } = require('./r2laws.cjs');
const { LAWS_APPLY_MARK } = require('../../update/apply_mark.cjs');
const { refsSignature } = require('../../beppyo/weekly/build.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STATE_KEY = 'update_state/delegations/state.json';
const VEC_STATE_KEY = 'update_state/delegations/vec_state.json';   // delta_apply の決まり（委任先にベクトルは無いので常に {}）
const APPLY_LOCK_KEY = 'update_state/delegations_apply_inprogress.json';
const LEDGER_KEY = 'update_state/sync_state.json';
const CONC = Number(process.env.DELEG_CONCURRENCY || 16);
const MAX_CHANGED_LAWS = Number(process.env.DELEG_MAX_CHANGED || 100);
const ERR_MIN = Number(process.env.DELEG_ERR_MIN || 5);
const DROP_MIN = Number(process.env.DELEG_DROP_MIN || 50);   // 減った数がこれ以下なら割合では止めない（確かめ用の小さいデータで止まらないように。本番は約 15 万件）

const log = (...a) => console.log(...a);
const sha = (s) => (s == null ? null : crypto.createHash('sha256').update(s).digest('hex'));
const stableJson = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  : Array.isArray(o) ? `[${o.map(stableJson).join(',')}]` : JSON.stringify(o));
const chunkKey = (P, n) => `${P}/chunk_${String(n).padStart(3, '0')}.json`;

// 本番の条文・refs・委任先のプレフィックス（wrangler.toml。確かめ用に DELEG_*_PREFIX で差し替えられる）
function prodPrefixes() {
  const toml = fs.readFileSync(path.join(REPO_ROOT, 'wrangler.toml'), 'utf8');
  const pick = (name, env) => {
    if (process.env[env]) return process.env[env];
    const m = toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, 'm'));
    if (!m) throw new Error(`wrangler.toml に ${name} が無い`);
    return m[1];
  };
  return { articles: pick('ARTICLES_PREFIX', 'DELEG_ARTICLES_PREFIX'), refs: pick('REFS_PREFIX', 'DELEG_REFS_PREFIX'), deleg: pick('DELEGATIONS_PREFIX', 'DELEG_PREFIX') };
}

// 委任の強さの内訳（見直す対象の判断用）
function statusCounts(slim) {
  const c = {};
  for (const arr of Object.values((slim && slim.articles) || {})) for (const d of arr) c[d.status] = (c[d.status] || 0) + 1;
  return c;
}
const strongOf = (c) => (c.confirmed || 0) + (c.multiple || 0);
// 候補の並びだけが違うか（refs の並びの違いで候補の順が変わることがある）
function sameIgnoringOrder(a, b) {
  const norm = (s) => s && Object.fromEntries(Object.entries(s.articles || {}).map(([k, arr]) => [k, arr.map((d) => ({ ...d, candidates: [...(d.candidates || [])].map(stableJson).sort() })).map(stableJson).sort()]));
  return stableJson({ t: a && a.law_title, n: a && a.count, a: norm(a) }) === stableJson({ t: b && b.law_title, n: b && b.count, a: norm(b) });
}

// ---------------------------------------------------------------- build
async function build({ out, rid }) {
  const BD = path.join(out, 'build');
  const W = path.join(out, 'work');   // DELEG_REBUILD_DIR（fetched_laws/・delegations/reverse_index/）
  for (const d of [BD, W]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(BD, 'files'), { recursive: true });
  const FETCHED = path.join(W, 'fetched_laws'), REVND = path.join(W, 'reverse_nd'), REV = path.join(W, 'delegations', 'reverse_index');
  for (const d of [FETCHED, REVND, REV]) fs.mkdirSync(d, { recursive: true });
  const report = { blockers: [], review: [], notes: [] };
  const r2 = new R2();
  const P = prodPrefixes();
  const gen = await makeGenGuard(r2, APPLY_LOCK_KEY);   // 世代 → 印の順に読む。読み終えるまでに反映・戻しが入ったら、この下見は使わない
  const lock = gen.lock;
  if (lock) report.blockers.push(`前回の委任先の${lock.kind === 'restore' ? '戻し' : '反映'}（run ${lock.run_id}・${lock.phase}・${lock.started_at} 開始）が途中で止まっている（${APPLY_LOCK_KEY} が残っている）。Actions の Update delegations を mode=restore・restore_run_id=${lock.run_id} で戻してから流し直す`);
  const ledgerBuf = await r2.get(LEDGER_KEY);
  if (!ledgerBuf) throw new Error(`法令の台帳 ${LEDGER_KEY} が無い。書かずに止める`);
  // 法令の週次の反映中（条文・refs が書きかけ）なら比べない。印は反映が全部通ってから外れる
  const lawMark = await r2.getJson(LAWS_APPLY_MARK);
  if (lawMark) report.blockers.push(`法令の週次の反映（run ${lawMark.run_id}・${lawMark.mode}・${lawMark.started_at} 開始）が途中（${LAWS_APPLY_MARK} が残っている）。条文・refs が書きかけなので比べない。法令の週次を流し直して反映を終えてから流す`);
  const refsListSig = await refsSignature(r2, P.refs);   // 読み終えた後と反映のときに、refs の中身が変わっていないかを見る（refs_index.json はチャンクの中身だけの書き換えでは変わらない）
  const stateBuf = await r2.get(STATE_KEY);
  const state = stateBuf ? JSON.parse(stateBuf.toString('utf8')) : null;
  const full = !state || process.env.DELEG_FULL === '1';

  // ---- 1. 条文の一覧（法令ごとの鍵と ETag）
  const listing = await r2.list(`${P.articles}/`);
  const perLaw = new Map();
  for (const o of listing) {
    const rest = o.key.slice(P.articles.length + 1);
    const i = rest.indexOf('/');
    if (i < 0) continue;
    const id = rest.slice(0, i);
    if (!perLaw.has(id)) perLaw.set(id, []);
    perLaw.get(id).push(`${rest.slice(i + 1)}\t${o.etag || ''}\t${o.size}\t${o.last_modified || ''}`);   // 更新時刻も入れる（ETag が無いときも、同じ大きさの書き換えを拾う）
  }
  const lawSig = {};
  const lawsNow = new Set();
  for (const [id, arr] of perLaw) {
    if (!arr.some((x) => x.startsWith('_index.json\t'))) continue;
    lawsNow.add(id);
    lawSig[id] = sha(arr.sort().join('\n'));
  }
  if (!lawsNow.size) throw new Error(`${P.articles}/ に法令が 1 つも無い（一覧が取れていない）。書かずに止める`);

  // ---- 2. refs（全チャンク）: 法令ごとの refs の hash・引いている法令・逆引き（参照先ごとに作業フォルダへ書き足す）
  const refsIndexBuf = await r2.get(`${P.refs}/refs_index.json`);
  if (!refsIndexBuf) throw new Error(`${P.refs}/refs_index.json が無い。書かずに止める`);
  const refsIndex = JSON.parse(refsIndexBuf.toString('utf8'));
  const chunkNums = [...new Set(Object.values(refsIndex))].sort((a, b) => a - b);
  const refsSig = {}, targets = {};
  let revEntries = 0;
  for (const num of chunkNums) {
    const key = `${P.refs}/refs_chunk_${String(num).padStart(3, '0')}.json`;
    const ch = await r2.getJson(key);
    if (!ch || typeof ch !== 'object' || Array.isArray(ch)) throw new Error(`${key} が無い・形が違う（refs_index.json には載っている）。書かずに止める`);
    const buf = new Map();
    // refs_index.json がこのチャンクに割り当てている法令が、どれも refs として在るか（欠けたまま進めると、その法令の refs が消えたと取り違えて紐付けを外す下見になる。空の refs {} は正常）
    const bad = Object.entries(refsIndex).filter(([, n]) => n === num).map(([id]) => id).filter((id) => !ch[id] || typeof ch[id].refs !== 'object' || ch[id].refs === null || Array.isArray(ch[id].refs));
    if (bad.length) throw new Error(`${key} に refs_index.json が載せている法令の refs が無い・形が違う（${bad.slice(0, 5).join('、')}${bad.length > 5 ? ' ほか' : ''}）。書かずに止める`);
    for (const [lawId, law] of Object.entries(ch)) {
      const refs = (law && law.refs) || {};
      refsSig[lawId] = sha(stableJson(refs));
      const ts = new Set();
      for (const [k, arr] of Object.entries(refs)) {
        const at = k.indexOf('_Art');
        if (at < 0) continue;
        const src = k.substring(0, at);
        (arr || []).forEach((r, i) => {
          if ((r.type === 'external' || r.type === 'varref') && r.target_law_id && r.target_law_id !== src) {
            ts.add(r.target_law_id);
            if (!buf.has(r.target_law_id)) buf.set(r.target_law_id, []);
            buf.get(r.target_law_id).push(JSON.stringify({ src, key: k, i, ref: r }));
            revEntries++;
          }
        });
      }
      targets[lawId] = [...ts].sort();
    }
    for (const [t, lines] of buf) fs.appendFileSync(path.join(REVND, `${t}.ndjson`), lines.join('\n') + '\n');
  }
  report.notes.push(`refs: チャンク ${chunkNums.length}・逆引き ${revEntries} 件`);

  // ---- 3. 今の本番の配信用チャンク
  const prodIndexBuf = await r2.get(`${P.deleg}/index.json`);
  if (!prodIndexBuf) throw new Error(`${P.deleg}/index.json が無い。書かずに止める`);
  const prodIndex = JSON.parse(prodIndexBuf.toString('utf8'));
  const prodChunks = new Map(), prodRaw = new Map();
  for (const n of [...new Set(Object.values(prodIndex))].sort((a, b) => a - b)) {
    const b = await r2.get(chunkKey(P.deleg, n));
    let c = null;
    try { c = b ? JSON.parse(b.toString('utf8')) : null; } catch { c = null; }
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${chunkKey(P.deleg, n)} が無い・形が違う（index.json には載っている）。書かずに止める`);
    prodChunks.set(n, c); prodRaw.set(n, b);
  }
  const prodEntry = (id) => (prodIndex[id] !== undefined ? prodChunks.get(prodIndex[id])[id] || null : null);

  process.env.DELEG_REBUILD_DIR = W;   // 01・02・lib.cjs はこの置き場を読む（require の前に決める）
  const lib = require('../lib.cjs');

  // ---- 4. やり直す法令
  const sigOf = (s, id) => (s && s[id]) || null;
  const allIds = new Set([...lawsNow, ...Object.keys((state && state.law_sigs) || {})]);
  const changed = full ? [...new Set([...lawsNow, ...Object.keys(prodIndex)])] : [...allIds].filter((id) => sigOf(state.law_sigs, id) !== (lawSig[id] || null) || sigOf(state.refs_sigs, id) !== (refsSig[id] || null));
  const recompute = new Set(changed);
  if (!full) for (const id of changed) for (const t of [...(targets[id] || []), ...(((state && state.targets) || {})[id] || [])]) recompute.add(t);
  // 専属の施行令・施行規則（題名が「{親}施行令」「{親}施行規則」）が変わったら親もやり直す（02 は法令単位の受け皿にこの子を使う。
  // 子の refs が親を引いていなくても、この関係で親の結果が変わりうる）
  if (!full) {
    const titleToId = lib.lawTitleIndex();
    const idToTitle = new Map([...titleToId].map(([t, id]) => [id, t]));
    for (const id of changed) {
      const m = (idToTitle.get(id) || '').match(/^(.+)(施行令|施行規則)$/);
      const parent = m && titleToId.get(m[1]);
      if (parent && parent !== id) recompute.add(parent);
    }
  }
  // 前の回に紐付けに失敗した法令は、変わっていなくても必ずやり直す（通るまで。子が変わってやり直した親が落ちた場合も、親の印は変わらないので、ここで拾う）
  const retry = ((state && state.failed) || []).filter((id) => lawsNow.has(id));
  for (const id of retry) recompute.add(id);
  if (retry.length) report.notes.push(`前の回に紐付けに失敗した法令 ${retry.length} をやり直す: ${retry.slice(0, 10).join('、')}${retry.length > 10 ? ' ほか' : ''}`);
  report.notes.push(full ? `全法令をやり直す（${state ? 'DELEG_FULL=1' : '初回: 状態の控えが無い'}）: ${lawsNow.size} 法令` : `条文か refs が変わった法令 ${changed.length}・それが引く法令を足して ${recompute.size} 法令をやり直す`);
  if (full) report.review.push(state ? '全法令のやり直し（DELEG_FULL=1）' : `初回: 状態の控え（${STATE_KEY}）が無いので全法令をやり直し、今の本番（PC で作ったもの）と比べた`);

  // ---- 5. 条文を取る（やり直す親・それを引く子・専属の施行令・施行規則）
  const { extractLaw } = require('../01_extract_delegations.cjs');
  const { linkParent } = require('../02_link_by_reverse.cjs');
  const { slimLaw, CHUNK_LIMIT } = require('../07_export_r2_dist.cjs');
  const got = new Set(), missing = new Set();
  const fetchMany = async (ids) => {
    const todo = [...new Set(ids)].filter((id) => !got.has(id) && !missing.has(id) && lawsNow.has(id));
    await pool(todo, CONC, async (id) => {
      const law = await fetchLaw(r2, P.articles, id);
      if (!law) { missing.add(id); return; }
      fs.writeFileSync(path.join(FETCHED, `${id}.json`), JSON.stringify(law));
      got.add(id);
    });
  };
  const parents = [...recompute].filter((id) => lawsNow.has(id)).sort();
  await fetchMany(parents);
  const kids = new Set();
  const titleIdx = lib.lawTitleIndex();
  for (const p of parents) {
    const f = path.join(REVND, `${p}.ndjson`);
    const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    // 00 と同じ形の逆引き（参照元の法令の順にそろえる）
    lines.sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
    fs.writeFileSync(path.join(REV, `${p}.json`), JSON.stringify(lines));
    for (const e of lines) kids.add(e.src);
    if (got.has(p)) {
      const t = JSON.parse(fs.readFileSync(path.join(FETCHED, `${p}.json`), 'utf8')).law_title;
      for (const suf of ['施行令', '施行規則']) { const id = titleIdx.get(t + suf); if (id) kids.add(id); }
    }
  }
  await fetchMany([...kids]);
  report.notes.push(`条文を取った法令 ${got.size}（やり直す親 ${parents.length}・参照元と専属の子 ${kids.size}）`);

  // ---- 6. 紐付け（01 → 02 → 07 の slimLaw）と本番との比べ
  const nowOf = new Map(), errors = [];
  for (const id of [...recompute].sort()) {
    if (!lawsNow.has(id)) { nowOf.set(id, null); continue; }   // 法令が消えた（廃止）
    try {
      if ((process.env.DELEG_TEST_FAIL_LAWS || '').split(',').includes(id)) throw new Error('（確かめ用）紐付けを落とした');
      const raw = extractLaw(id);
      if (!raw.delegations.some((d) => d.provision === 'main')) { nowOf.set(id, null); continue; }
      const slim = slimLaw(linkParent(id, { raw, noWrite: true, quiet: true }));
      nowOf.set(id, slim.count ? slim : null);
    } catch (e) { errors.push(`${id}（${String(e && e.message || e).slice(0, 80)}）`); }
  }
  const diffs = [];
  for (const [id, now] of nowOf) {
    const prod = prodEntry(id);
    if (stableJson(now) === stableJson(prod)) continue;
    const cb = statusCounts(prod), ca = statusCounts(now);
    diffs.push({ id, title: (now || prod || {}).law_title || id, now, prod, before: cb, after: ca, orderOnly: !!(now && prod && sameIgnoringOrder(now, prod)) });
  }
  if (errors.length) (errors.length > ERR_MIN && errors.length > recompute.size * 0.01 ? report.blockers : report.review).push(`紐付けに失敗した法令 ${errors.length}（本番のまま残し、翌週またやり直す）: ${errors.slice(0, 5).join('、')}${errors.length > 5 ? ' ほか' : ''}`);

  // ---- 7. 配信用チャンクを直す
  const newChunks = new Map([...prodChunks].map(([n, c]) => [n, c]));
  const index = { ...prodIndex };
  const dirty = new Set();
  let idxDirty = false;
  const clone = (n) => { if (!dirty.has(n)) { newChunks.set(n, { ...newChunks.get(n) }); dirty.add(n); } return newChunks.get(n); };
  let last = Math.max(-1, ...prodChunks.keys());
  const sizeOf = (n) => Buffer.byteLength(JSON.stringify(newChunks.get(n) || {}));
  for (const d of diffs.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (index[d.id] !== undefined) {
      const c = clone(index[d.id]);
      if (d.now) c[d.id] = d.now; else { delete c[d.id]; delete index[d.id]; idxDirty = true; }
    } else if (d.now) {
      if (last < 0 || sizeOf(last) + Buffer.byteLength(JSON.stringify(d.now)) > CHUNK_LIMIT) { last++; newChunks.set(last, {}); }
      clone(last)[d.id] = d.now;
      index[d.id] = last; idxDirty = true;
    }
  }
  const files = {};
  const putFile = (key, obj, before) => {
    const local = `files/${key.replace(/\//g, '__')}`;
    fs.writeFileSync(path.join(BD, local), JSON.stringify(obj));
    files[key] = { sha_before: before ? sha(before) : null, local };
  };
  for (const n of [...dirty].sort((a, b) => a - b)) {
    const before = prodRaw.get(n) || await r2.get(chunkKey(P.deleg, n));   // 新しい番号でも R2 に残りがあれば「書く前」として控える
    putFile(chunkKey(P.deleg, n), newChunks.get(n), before);
  }
  if (idxDirty) putFile(`${P.deleg}/index.json`, index, prodIndexBuf);

  // ---- 8. 見直す対象・止める条件
  const total = (idx, get) => Object.keys(idx).reduce((s, id) => s + ((get(id) || {}).count || 0), 0);
  const prodTotal = total(prodIndex, prodEntry);
  const nowTotal = prodTotal + diffs.reduce((s, d) => s + ((d.now || {}).count || 0) - ((d.prod || {}).count || 0), 0);
  if (nowTotal < prodTotal * 0.9 && prodTotal - nowTotal > DROP_MIN) report.blockers.push(`委任の総数が 1 割超かつ ${DROP_MIN} 件超減る（${prodTotal} → ${nowTotal}）。条文か refs の読み取りが崩れている疑い`);
  const real = diffs.filter((d) => !d.orderOnly);
  if (real.length > MAX_CHANGED_LAWS) report.review.push(`委任先が変わる法令が ${real.length}（${MAX_CHANGED_LAWS} 超。候補の並びだけ変わる法令 ${diffs.length - real.length} は別）`);
  const losing = real.filter((d) => { const b = strongOf(d.before), a = strongOf(d.after); return b - a >= 5 || (b >= 5 && a < b * 0.7); });
  if (losing.length) report.review.push(`条が決まる委任（確定＋複数候補）が大きく減る法令 ${losing.length}: ${losing.slice(0, 10).map((d) => `${d.title} ${strongOf(d.before)}→${strongOf(d.after)}`).join('、')}${losing.length > 10 ? ' ほか' : ''}`);
  const gone = real.filter((d) => d.prod && !d.now);
  if (gone.length) report.notes.push(`委任先の一覧から外れる法令 ${gone.length}（廃止・委任が無くなった）: ${gone.slice(0, 10).map((d) => d.title).join('、')}${gone.length > 10 ? ' ほか' : ''}`);

  // ---- 9. 状態の控え（反映したら置く）。印は今の値。紐付けに失敗した法令は failed に残し、次の回に必ずやり直す（通ったら外れる）
  const failedIds = [...new Set(errors.map((e) => e.split('（')[0]))].sort();
  const nextState = { law_sigs: {}, refs_sigs: {}, targets: {}, failed: failedIds };
  for (const id of new Set([...lawsNow, ...Object.keys(refsSig)])) {
    nextState.law_sigs[id] = lawSig[id] || null;
    nextState.refs_sigs[id] = refsSig[id] || null;
    nextState.targets[id] = targets[id] || [];
  }
  const stateChanged = !state || stableJson(state) !== stableJson(nextState);

  // ---- 10. 成果物（本番を読み終えた。途中で反映・戻しが入っていれば捨てる）
  if (process.env.DELEG_TEST_MID_BUILD) require('child_process').execSync(process.env.DELEG_TEST_MID_BUILD, { stdio: 'inherit' });   // 確かめ用
  await gen.verify();
  if (!lawMark && await r2.getJson(LAWS_APPLY_MARK)) throw new Error(`下見の途中で法令の週次の反映が始まった（${LAWS_APPLY_MARK} が現れた）。この下見は使わない。何も書いていない。流し直す`);
  if (sha(await r2.get(LEDGER_KEY)) !== sha(ledgerBuf)) throw new Error(`下見の途中で法令の週次が反映された（${LEDGER_KEY} が変わった）。読んだ条文・refs が途中で変わりうるので、この下見は使わない。何も書いていない。流し直す`);
  if (await refsSignature(r2, P.refs) !== refsListSig) throw new Error(`下見の途中で refs（${P.refs}）が書き換わった。この下見は使わない。何も書いていない。流し直す`);
  for (const f of ['vectors.ndjson', 'meta_updates.ndjson', 'deletes.ndjson']) fs.writeFileSync(path.join(BD, f), '');
  fs.writeFileSync(path.join(BD, 'vec_state_next.json'), '{}');
  fs.writeFileSync(path.join(BD, 'state_next.json'), JSON.stringify(nextState));
  const byStatus = (key) => diffs.reduce((acc, d) => { for (const [k, v] of Object.entries(d[key])) acc[k] = (acc[k] || 0) + v; return acc; }, {});
  const m = {
    run_id: rid, created_at: new Date().toISOString(), full, prod_prefix: P.deleg, articles_prefix: P.articles, refs_prefix: P.refs,
    ledger_sha: sha(ledgerBuf), refs_index_sha: sha(refsIndexBuf), refs_sig: refsListSig, gen_sha_before: gen.sha,
    vec_state_sha_before: sha(await r2.get(VEC_STATE_KEY)), state_sha_before: stateBuf ? sha(stateBuf) : null,
    files, vectors: { upsert: 0, meta_update: 0, delete: 0 },
    counts: { laws: lawsNow.size, recomputed: recompute.size, changed_laws: real.length, order_only: diffs.length - real.length, errors: errors.length, delegations_before: prodTotal, delegations_after: nowTotal, status_before: byStatus('before'), status_after: byStatus('after') },
    changed: real.slice(0, 300).map((d) => ({ id: d.id, title: d.title, before: d.before, after: d.after })),
    state_changed: stateChanged,
    blockers: report.blockers, review: report.review, notes: report.notes,
  };
  m.ok_to_apply = !m.blockers.length;
  m.needs_review = m.review.length > 0;
  m.nothing_to_do = !Object.keys(files).length && !stateChanged && !m.blockers.length && !m.review.length;
  fs.writeFileSync(path.join(BD, 'manifest.json'), JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(BD, 'report.md'), renderReport(m));
  log(`\nbuild: やり直した ${recompute.size} 法令 / 変わる ${real.length}（並びだけ ${diffs.length - real.length}）/ ファイル ${Object.keys(files).length} / 止めた理由 ${m.blockers.length}・見直す ${m.review.length}`);
  return m;
}

function renderReport(m) {
  const c = m.counts;
  const fmt = (o) => Object.entries(o).sort().map(([k, v]) => `${k} ${v}`).join('・') || 'なし';
  const L = [`# 委任先の作り直し（反映の下見）run ${m.run_id}`, '',
    `- 本番: ${m.prod_prefix}（条文 ${m.articles_prefix}・refs ${m.refs_prefix}）`,
    `- 法令 ${c.laws}・やり直した ${c.recomputed}${m.full ? '（全法令）' : ''}・委任先が変わる ${c.changed_laws}（候補の並びだけ変わる ${c.order_only}）・失敗 ${c.errors}`,
    `- 委任の総数: ${c.delegations_before} → ${c.delegations_after}`,
    `- 変わる法令の内訳（前）: ${fmt(c.status_before)}`,
    `- 変わる法令の内訳（後）: ${fmt(c.status_after)}`,
    `- 書くファイル: ${Object.keys(m.files).length}`, ''];
  if (m.blockers.length) { L.push('## 止めた理由', ''); for (const b of m.blockers) L.push(`- ${b}`); L.push(''); }
  if (m.review.length) { L.push('## 見直す対象', ''); for (const b of m.review) L.push(`- ${b}`); L.push(''); }
  if (m.notes.length) { L.push('## メモ', ''); for (const b of m.notes) L.push(`- ${b}`); L.push(''); }
  if (m.changed.length) {
    L.push(`## 委任先が変わる法令（${c.changed_laws}${c.changed_laws > m.changed.length ? `。先頭 ${m.changed.length}` : ''}）`, '', '| 法令 | 確定 | 複数候補 | 弱い | 法令単位 | なし |', '|---|---|---|---|---|---|');
    const cell = (d, k) => `${d.before[k] || 0}→${d.after[k] || 0}`;
    for (const d of m.changed) L.push(`| ${d.title}（${d.id}） | ${cell(d, 'confirmed')} | ${cell(d, 'multiple')} | ${cell(d, 'weak')} | ${cell(d, 'law_level')} | ${cell(d, 'none')} |`);
    L.push('');
  }
  return L.join('\n') + '\n';
}

module.exports = { build, prodPrefixes, STATE_KEY, VEC_STATE_KEY, APPLY_LOCK_KEY, LEDGER_KEY };
