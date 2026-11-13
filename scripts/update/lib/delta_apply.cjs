// 週次の下見（build/）を退避付きで本番に反映する・戻す。通達（scripts/tsutatsu/weekly/apply.cjs）・質疑応答事例と裁決（scripts/cases/weekly）で共用。
//
// 反映:
//   0. 作業中の印（cfg.lockKey）を「無いときだけ書く」で取る
//   1. 下見の後に本番が変わっていないか（書くファイル・状態の控えの hash、cfg.prodPrefix、cfg.freshCheck）。変わっていれば書かずに止める
//   2. 前の反映・戻しの書き込みを索引が処理し終えるのを待ち（印のベクトル）、触るベクトルの今の値を読む。今の索引にあるはずのものが取れなければ書かない
//   3. 退避: 上書きするファイル・状態の控え・触るベクトル（上書き・metadata の差し替え・削除）の今の値、書いた後のベクトル
//   4. 書く: 印を writing に → ファイル（一覧＝cfg.isIndexKey は最後）→ ベクトルの upsert → 削除 → 印のベクトル → 状態の控え
//   5. 読み戻し（ファイル・状態の控えの hash。索引が処理し終えたらベクトル）。全部通ってから印を外す
// 世代（genKeyOf(cfg.lockKey)）: 反映・戻しは本番を書き始める直前に世代のファイルを書き換える。下見は読み始めと終わりで世代が
//   同じことを確かめ（makeGenGuard）、manifest.gen_sha_before に残す。反映は印を取った後、世代が下見のときと同じときだけ書く（書かずに止まった反映・戻しは世代を進めない）
//   （下見の途中や、下見の後に別の反映・戻しが入ると、下見が読んだ本番と今の本番が食い違う。ファイルの hash だけでは、下見が「書かなくてよい」
//   とした分の食い違いを拾えない）
// 途中で落ちたら印が残り、次の下見・反映は止まる。restore で戻す（同じ回の restore はやり直せる）。
//
// 下見の成果物（dir）:
//   manifest.json   { run_id, stamp, ok_to_apply, needs_review, nothing_to_do, prod_prefix?, files: { R2 キー: { sha_before, local, content_type? } },
//                     vectors: { upsert, meta_update, delete }, ... }
//   files/…         書くファイル（JSON は形を確かめる。content_type が JSON 以外なら中身は確かめない）
//   vectors.ndjson  埋め込んだベクトル（why: new＝今の索引に無いはず／text＝あるはず）
//   meta_updates.ndjson  metadata だけ差し替えるもの（値は今の実物）
//   deletes.ndjson  消すもの
//   vec_state_next.json  反映後の状態の控え（id → { ns, th, mh }）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { R2 } = require('./r2.cjs');
const { Vectorize } = require('./vectorize.cjs');

const DIM = 1024;             // bge-m3
const PART = 1000;            // 退避のベクトルを R2 に置くときの 1 ファイルの本数（1 ファイル 20MB 前後）
const MARK_NS = '_weekly_mark';   // 画面・MCP の検索はどれも namespace を指定する（_reverse・_hanrei など）ので、この namespace の印は検索に出ない

const log = (...a) => console.log(...a);
const sha = (buf) => (buf == null ? null : crypto.createHash('sha256').update(buf).digest('hex'));
const stableJson = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  : Array.isArray(o) ? `[${o.map(stableJson).join(',')}]` : JSON.stringify(o));
const isJsonType = (ct) => !ct || /json/.test(ct);

// 反映・戻しの世代のファイル（作業中の印の隣）
const genKeyOf = (lockKey) => lockKey.replace(/_inprogress\.json$/, '_gen.json');
// 下見の読み取りを覆う世代の確かめ。読み始める前に呼ぶ（世代 → 作業中の印の順に読む）。verify は読み終えた後（manifest を書く前）に呼ぶ。
//   反映・戻しは印を取ってから、書き始める直前に世代を進める。だから「世代 → 印」の順に読めば、始めに印が無ければ、
//   その後に始まった反映・戻しは必ず世代を進めてから書く（verify で分かる）。逆の順だと、印を見た直後に始まった回の進めた世代を
//   始めの値として取り込み、書き換え途中の本番を読んでも気づかない（GPT の指摘）
//   verify で throw する: 世代が変わった、または印が現れた・別の回の印に変わった（始めから残っていた同じ印は、下見が「止めた理由」に出す）
//   lock: 始めに読んだ印（残っていれば下見の止めた理由に使う）
async function makeGenGuard(r2, lockKey) {
  const key = genKeyOf(lockKey);
  const start = sha(await r2.get(key));
  const lock = await r2.getJson(lockKey);
  return {
    sha: start,
    lock,
    key,
    async verify() {
      const lockNow = await r2.getJson(lockKey);
      if (lockNow && (!lock || lockNow.token !== lock.token)) throw new Error(`下見の途中で反映か戻しが始まった（${lockKey} が現れた）。読んだ本番が途中で変わりうるので、この下見は使わない。何も書いていない。流し直す`);
      const now = sha(await r2.get(key));
      if (now !== start) throw new Error(`下見の途中で反映か戻しが入った（${key} が変わった）。読んだ本番が途中で変わったので、この下見は使わない。何も書いていない。流し直す`);
    },
  };
}

// Vectorize は float32 で返すので hash では比べられない。namespace・metadata が同じで cosine がほぼ 1 なら同じとみなす
function sameVector(a, b) {
  if (!a || !b) return !a && !b;
  if (a.namespace && b.namespace && a.namespace !== b.namespace) return false;
  if (stableJson(a.metadata || {}) !== stableJson(b.metadata || {})) return false;
  if (!Array.isArray(a.values) || !Array.isArray(b.values) || a.values.length !== b.values.length) return false;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.values.length; i++) { d += a.values[i] * b.values[i]; na += a.values[i] ** 2; nb += b.values[i] ** 2; }
  return d / Math.sqrt(na * nb) >= 0.9999;
}

// cfg:
//   label          Actions のワークフロー名（案内文に出す。例 'Update tsutatsu data'）
//   envPrefix      確かめ・調整用の環境変数の頭（'TSU' → TSU_APPROVED・TSU_VEC_PACE_MS・TSU_TEST_FAIL_APPLY_AT など）
//   dir()          下見の成果物のフォルダ
//   lockKey・backupPrefix・mutKey・markId・vecIndex
//   idRe           ベクトル id の形
//   metaLimit      metadata の上限（バイト）
//   vecStateKey    状態の控えの R2 キー（manifest.vec_state_sha_before と照らす）
//   extraStates(m, dir, rid) → [{ key, body, sha_before }]   状態の控えのほかに、ベクトルの後に書く控え（build_state など）
//   prodPrefix()   本番の版（無ければ null）。manifest.prod_prefix と違えば書かない。restore も同じ版のときだけ
//   allowedKey(k, prod)  書いてよいキーか（keyLabel: 止めたときの案内に出す呼び名）
//   checkFile(k, obj, prod)  JSON のファイルの形を確かめる（throw で止める）
//   isIndexKey(k)  一覧のファイル（新しいファイルが先に在るように最後に書き、戻すときは最初に戻す）
//   checkSet(keys, prod)  ファイルの組み合わせを確かめる（例: 法令ファイルが変わるなら index.json も）
//   freshCheck(r2, m)  下見より新しい取り直しが無いかなど（throw で止める）
function makeApplier(cfg) {
  const E = (k, d) => (process.env[`${cfg.envPrefix}_${k}`] !== undefined ? process.env[`${cfg.envPrefix}_${k}`] : d);
  const num = (k, d) => Number(E(k, d));
  const GET_PACE_MS = () => num('VEC_PACE_MS', 400);
  const VEC_WAIT_MS = () => num('VEC_WAIT_MS', 15 * 60 * 1000);
  const VEC_POLL_MS = () => num('VEC_POLL_MS', 10000);
  const MISSING_TRIES = () => num('VEC_MISSING_TRIES', 6);
  const validVec = (v) => v && typeof v.id === 'string' && cfg.idRe.test(v.id) && typeof v.namespace === 'string' && v.namespace
    && Array.isArray(v.values) && v.values.length === DIM && v.values.every((x) => typeof x === 'number' && Number.isFinite(x))
    && v.metadata && typeof v.metadata === 'object' && !Array.isArray(v.metadata);
  const restoreHint = (rid) => `Actions の ${cfg.label} を mode=restore・restore_run_id=${rid} で戻す`;

  function assertWriteContext(what) {
    if (process.env.GITHUB_ACTIONS === 'true') return;
    if (process.env.R2_FAKE_DIR && process.env.VECTORIZE_FAKE_FILE) return;
    throw new Error(`${what} は Actions の ${cfg.label} からしか動かさない（同時に書かないように 1 本ずつ流すため）。戻すときは mode=restore・restore_run_id で実行する`);
  }

  // ---------------------------------------------------------------- 作業中の印（R2 の「無いときだけ書く」）
  async function acquireLock(r2, rid, kind, { takeoverSameRun = false } = {}) {
    const token = crypto.randomBytes(12).toString('hex');
    // phase: apply は 'backup'（退避中・本番はまだ書いていない）→ 'writing'（本番を書き始めた）。restore は 'restore'
    const body = JSON.stringify({ run_id: rid, kind, token, phase: kind === 'apply' ? 'backup' : 'restore', started_at: new Date().toISOString() });
    const pre = await r2.getJson(cfg.lockKey);
    if (pre && !(takeoverSameRun && pre.run_id === rid)) throw new Error(`作業中の印がある（run ${pre.run_id}・${pre.kind}・${pre.started_at} 開始）。別の反映か戻しが動いているか、途中で落ちている。何も書いていない`);
    if (!pre && await r2.putIfAbsent(cfg.lockKey, body)) return { token, fresh: true };
    const cur = await r2.getJson(cfg.lockKey);
    if (cur && cur.token === token) return { token, fresh: true };
    if (cur && takeoverSameRun && cur.run_id === rid) {
      await r2.put(cfg.lockKey, body);
      return { token, fresh: false };
    }
    throw new Error(`作業中の印がある（run ${cur && cur.run_id}・${cur && cur.kind}・${cur && cur.started_at} 開始）。別の反映か戻しが動いているか、途中で落ちている。何も書いていない`);
  }
  async function releaseLock(r2, token) {
    const cur = await r2.getJson(cfg.lockKey);
    if (cur && cur.token === token) await r2.delete(cfg.lockKey);
  }

  // ---------------------------------------------------------------- ベクトルの読み書きの小道具
  async function getMany(vec, ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
      out.push(...await vec.getByIds(ids.slice(i, i + 20)));
      if (GET_PACE_MS() && !vec.fakeFile && i + 20 < ids.length) await new Promise((r) => setTimeout(r, GET_PACE_MS()));
    }
    return out;
  }
  // 索引の処理の印。反映・戻しは、書き込みの最後に印のベクトル（cfg.markId）を seq 付きで書き、cfg.mutKey に同じ seq を控える。
  // Vectorize は書き込みを順に処理するので、印のベクトルに控えの seq 以上が見えれば、それより前の書き込み（分けて送った全部）も処理し終えている。
  // 時刻（processedUpToDatetime）は最後に処理した書き込みの時刻で、書き込みが無ければ進まず、分けて送った途中でも進むので使わない
  async function writeMark(vec, r2, rid, kind) {
    const seq = Date.now();   // 反映・戻しは作業中の印で 1 本ずつなので、時刻で増えていけばよい
    await vec.upsert([{ id: cfg.markId, namespace: MARK_NS, values: new Array(DIM).fill(1 / Math.sqrt(DIM)), metadata: { seq, run_id: rid, kind } }]);
    const mark = { seq, run_id: rid, kind, at: new Date().toISOString() };
    await r2.put(cfg.mutKey, JSON.stringify(mark));   // 印のベクトルの後に控える（ここで落ちても、印のベクトルの seq は控えより大きいので待ちは通る）
    return mark;
  }
  // 索引が mark の書き込みまで処理し終えるまで待つ → 処理し終えたら true。控えが無い（まだこの仕組みで書いていない）なら待たない
  async function waitMark(vec, mark, timeoutMs = VEC_WAIT_MS()) {
    if (!mark || !mark.seq) return true;
    const t0 = Date.now();
    for (;;) {
      const [g] = await vec.getByIds([cfg.markId]);
      if (g && g.metadata && Number(g.metadata.seq) >= Number(mark.seq)) return true;
      if (Date.now() - t0 >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, VEC_POLL_MS()));
    }
  }
  async function putParts(r2, prefix, list) {
    const n = Math.ceil(list.length / PART);
    for (let i = 0; i < n; i++) await r2.put(`${prefix}/${String(i).padStart(4, '0')}.json`, JSON.stringify(list.slice(i * PART, (i + 1) * PART)));
    return n;
  }
  async function getParts(r2, prefix, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = await r2.getJson(`${prefix}/${String(i).padStart(4, '0')}.json`);
      if (!Array.isArray(a)) throw new Error(`退避の ${prefix}/${String(i).padStart(4, '0')}.json が無い・読めない。何も書いていない`);
      out.push(...a);
    }
    return out;
  }

  // ---------------------------------------------------------------- 下見の成果物を厳しく読む（欠け・壊れ・件数違いのまま本番に書かない）
  function readLines(B, name) {
    const f = path.join(B, name);
    if (!fs.existsSync(f)) throw new Error(`${name} が無い（下見の成果物が欠けている）。書かずに止める`);
    return fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [l, i]).filter(([l]) => l.trim()).map(([l, i]) => {
      try { return JSON.parse(l); } catch { throw new Error(`${name} の ${i + 1} 行目が読めない。書かずに止める`); }
    });
  }
  function loadArtifacts(B, m, PROD) {
    const files = new Map();   // R2 のキー -> { buf, ct }
    for (const [k, f] of Object.entries(m.files || {})) {
      if (!cfg.allowedKey(k, PROD)) throw new Error(`書き先が${cfg.keyLabel || '許されたファイル'}でない: ${k}。書かずに止める`);
      const p = path.join(B, f.local || '');
      if (!f.local || !fs.existsSync(p)) throw new Error(`成果物が欠けている: ${k}（${f.local}）。書かずに止める`);
      const buf = fs.readFileSync(p);
      if (isJsonType(f.content_type)) {
        let o;
        try { o = JSON.parse(buf.toString('utf8')); } catch { throw new Error(`成果物が壊れている: ${k}（JSON として読めない）。書かずに止める`); }
        cfg.checkFile(k, o, PROD);
      } else if (f.sha_after && sha(buf) !== f.sha_after) throw new Error(`成果物が壊れている: ${k}（下見のときの hash と合わない）。書かずに止める`);
      files.set(k, { buf, ct: f.content_type || 'application/json' });
    }
    if (cfg.checkSet) cfg.checkSet([...files.keys()], PROD);
    let next;
    try { next = JSON.parse(fs.readFileSync(path.join(B, 'vec_state_next.json'), 'utf8')); } catch { throw new Error('vec_state_next.json が無い・読めない。書かずに止める'); }
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('vec_state_next.json の形が違う。書かずに止める');
    const up = readLines(B, 'vectors.ndjson'), meta = readLines(B, 'meta_updates.ndjson'), del = readLines(B, 'deletes.ndjson');
    const cnt = m.vectors || {};
    if (up.length !== cnt.upsert) throw new Error(`vectors.ndjson が ${up.length} 本（manifest では ${cnt.upsert} 本）。書かずに止める`);
    if (meta.length !== cnt.meta_update) throw new Error(`meta_updates.ndjson が ${meta.length} 本（manifest では ${cnt.meta_update} 本）。書かずに止める`);
    if (del.length !== cnt.delete) throw new Error(`deletes.ndjson が ${del.length} 本（manifest では ${cnt.delete} 本）。書かずに止める`);
    const seen = new Set();
    const once = (id, what) => { if (seen.has(id)) throw new Error(`${what}: ${id} が重複しているか、別の種類と重なっている。書かずに止める`); seen.add(id); };
    up.forEach((v, i) => {
      if (!validVec(v)) throw new Error(`vectors.ndjson の ${i + 1} 行目（${v && v.id}）の形が違う（id・namespace・${DIM} 次元の values・metadata）。書かずに止める`);
      if (v.why !== 'new' && v.why !== 'text') throw new Error(`vectors.ndjson の ${v.id}: why（new か text）が無い。書かずに止める`);
      if (Buffer.byteLength(JSON.stringify(v.metadata)) > cfg.metaLimit) throw new Error(`vectors.ndjson の ${v.id}: metadata が 10KiB を超える。書かずに止める`);
      if (!next[v.id] || next[v.id].ns !== v.namespace) throw new Error(`vectors.ndjson の ${v.id}: 状態の控え（vec_state_next）と namespace が合わない。書かずに止める`);
      once(v.id, 'vectors.ndjson');
    });
    meta.forEach((v, i) => {
      if (!v || typeof v.id !== 'string' || !cfg.idRe.test(v.id) || !v.metadata || typeof v.metadata !== 'object') throw new Error(`meta_updates.ndjson の ${i + 1} 行目の形が違う。書かずに止める`);
      if (Buffer.byteLength(JSON.stringify(v.metadata)) > cfg.metaLimit) throw new Error(`meta_updates.ndjson の ${v.id}: metadata が 10KiB を超える。書かずに止める`);
      if (!next[v.id] || next[v.id].ns !== v.namespace) throw new Error(`meta_updates.ndjson の ${v.id}: 状態の控えと namespace が合わない。書かずに止める`);
      once(v.id, 'meta_updates.ndjson');
    });
    del.forEach((v, i) => {
      if (!v || typeof v.id !== 'string' || !cfg.idRe.test(v.id)) throw new Error(`deletes.ndjson の ${i + 1} 行目の形が違う。書かずに止める`);
      if (next[v.id]) throw new Error(`deletes.ndjson の ${v.id}: 状態の控えでは残るはずのもの。書かずに止める`);
      once(v.id, 'deletes.ndjson');
    });
    return { files, next, up, meta, del };
  }

  // ---------------------------------------------------------------- apply
  async function apply() {
    assertWriteContext('apply');
    const B = cfg.dir();
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(B, 'manifest.json'), 'utf8')); } catch { throw new Error(`${B}/manifest.json が無い・読めない（下見の成果物を置いてください）`); }
    // 止めた回の成果物は途中まで（埋め込みを飛ばしている等）なので、強制反映の道は作らない。原因を直して取り直しからやり直す
    if (!m.ok_to_apply) throw new Error(`止めた理由があるので反映しない（原因を直して取り直しからやり直す）: ${(m.blockers || []).join(' / ')}`);
    if (m.needs_review && E('APPROVED', '') !== '1') throw new Error(`見直す対象がある回は、Issue の「反映」コメントからしか反映しない: ${(m.review || []).join(' / ')}`);
    if (m.nothing_to_do) { log('反映するものが無い'); return { nothing: true }; }
    const PROD = cfg.prodPrefix ? cfg.prodPrefix() : null;
    if (cfg.prodPrefix && PROD !== m.prod_prefix) throw new Error(`下見の後に本番のプレフィックスが変わった（${m.prod_prefix} → ${PROD}）。書かずに止める。取り直しからやり直す`);
    const a = loadArtifacts(B, m, PROD);
    const r2 = new R2();
    const vec = new Vectorize({ index: cfg.vecIndex });
    const rid = m.run_id;
    const bk = `${cfg.backupPrefix}/${rid}`;
    const extras = cfg.extraStates ? cfg.extraStates(m, B, rid) : [];

    // 0. 作業中の印を取る。書き始める前に落ちたら印を外す
    const { token } = await acquireLock(r2, rid, 'apply');
    let writing = false;
    try {
      // 0b. 下見の後に別の反映・戻しが入っていないか（世代）。印を持っている間は他は世代を書かない。書き換えるのは本番を書く直前
      const GEN = genKeyOf(cfg.lockKey);
      if (m.gen_sha_before !== undefined && sha(await r2.get(GEN)) !== m.gen_sha_before) throw new Error(`この下見の後に別の反映か戻しが入った（${GEN} が変わった）。古い下見は反映しない。書かずに止める。取り直しからやり直す`);
      // 1. 下見の後に本番が変わっていないか
      if (cfg.freshCheck) await cfg.freshCheck(r2, m);
      const current = new Map();
      for (const k of a.files.keys()) {
        const buf = await r2.get(k);
        current.set(k, buf);
        if (sha(buf) !== (m.files[k].sha_before ?? null)) throw new Error(`下見の後に ${k} が変わった。書かずに止める。取り直しからやり直す`);
      }
      const stateBuf = await r2.get(cfg.vecStateKey);
      if (sha(stateBuf) !== (m.vec_state_sha_before ?? null)) throw new Error(`下見の後に ${cfg.vecStateKey} が変わった（別の反映が先に入った）。書かずに止める`);
      const extraBufs = new Map();
      for (const x of extras) {
        const buf = await r2.get(x.key);
        extraBufs.set(x.key, buf);
        if (x.sha_before !== undefined && sha(buf) !== (x.sha_before ?? null)) throw new Error(`下見の後に ${x.key} が変わった（別の反映が先に入った）。書かずに止める`);
      }

      // 2. 触るベクトルの今の値（退避）。先に、前の反映・戻しの書き込みを索引が処理し終えるのを待つ（処理前の古い値を退避しない）
      const prevMut = await r2.getJson(cfg.mutKey);
      if (!await waitMark(vec, prevMut)) throw new Error(`Vectorize が前の反映・戻し（run ${prevMut.run_id}）の書き込みを ${Math.round(VEC_WAIT_MS() / 60000)} 分待っても処理し終えない（古い値を退避しうる）。何も書いていない。しばらくして流し直す`);
      const touched = [...a.up.map((v) => v.id), ...a.meta.map((v) => v.id), ...a.del.map((v) => v.id)];
      const got = new Map((await getMany(vec, touched)).map((v) => [v.id, v]));
      // 今の索引にあるはずのもの（本文が変わった・metadata だけ・消す）は、全部取れて退避できるまで書かない（取れないまま上書き・削除すると戻せない）
      const expected = [...a.up.filter((v) => v.why === 'text').map((v) => v.id), ...a.meta.map((v) => v.id), ...a.del.map((v) => v.id)];
      let missing = expected.filter((id) => !got.has(id));
      for (let t = 1; missing.length && t < MISSING_TRIES(); t++) {
        if (!vec.fakeFile) await new Promise((r) => setTimeout(r, VEC_POLL_MS() * t));
        for (const v of await getMany(vec, missing)) got.set(v.id, v);
        missing = expected.filter((id) => !got.has(id));
      }
      if (missing.length) throw new Error(`今の索引にあるはずのベクトルが取れない（${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ほか' : ''}・${missing.length} 本）。退避できないので何も書いていない。状態の控えと実物がずれているか、索引の処理が遅れている`);
      const nsOf = (id, fb) => (got.get(id) && got.get(id).namespace) || fb;
      const metaVecs = a.meta.map((v) => ({ id: v.id, namespace: v.namespace, values: got.get(v.id).values, metadata: v.metadata }));
      for (const v of metaVecs) if (!validVec(v)) throw new Error(`Vectorize から取った ${v.id} の値の形が違う。何も書いていない`);
      const writeVecs = [...a.up.map(({ id, namespace, values, metadata }) => ({ id, namespace, values, metadata })), ...metaVecs];
      // 退避の namespace: Vectorize が返した値 → 前回の状態の控え → 消すものの控え（どれも書く前の姿）→ 今回の控え（namespace は変わらない前提の最後の手）
      const oldState = stateBuf ? JSON.parse(stateBuf.toString('utf8')) : {};
      const delNs = new Map(a.del.map((d) => [d.id, d.namespace]));
      const before = [...got.values()].map((v) => ({ id: v.id, namespace: nsOf(v.id, (oldState[v.id] || {}).ns || delNs.get(v.id) || (a.next[v.id] || {}).ns), values: v.values, metadata: v.metadata }));
      for (const v of before) if (!validVec(v)) throw new Error(`退避するベクトル ${v.id} の形が違う（namespace が分からない・値が欠けている）。何も書いていない`);

      const nextStateBody = Buffer.from(JSON.stringify(a.next));
      const states = [{ key: cfg.vecStateKey, body: nextStateBody, prev: stateBuf },
        ...extras.map((x) => ({ key: x.key, body: Buffer.isBuffer(x.body) ? x.body : Buffer.from(x.body), prev: extraBufs.get(x.key) }))];
      const fileKeys = [...a.files.keys()];
      const allKeys = [...fileKeys, ...states.map((s) => s.key)];
      const beforeH = {}, afterH = {}, cts = {};
      for (const k of fileKeys) { beforeH[k] = sha(current.get(k)); afterH[k] = sha(a.files.get(k).buf); cts[k] = a.files.get(k).ct; }
      for (const s of states) { beforeH[s.key] = sha(s.prev); afterH[s.key] = sha(s.body); cts[s.key] = 'application/json'; }
      const existed = {};
      for (const k of fileKeys) { existed[k] = !!current.get(k); if (current.get(k)) await r2.put(`${bk}/files/${k}`, current.get(k), cts[k]); }
      for (const s of states) { existed[s.key] = !!s.prev; if (s.prev) await r2.put(`${bk}/files/${s.key}`, s.prev); }
      const nBefore = await putParts(r2, `${bk}/vectors_before`, before);
      const nAfter = await putParts(r2, `${bk}/vectors_after`, writeVecs);
      if (E('TEST_KILL_APPLY_AT', '') === 'backup') process.exit(137);   // 確かめ用: 退避の途中で強制終了
      const bm = {
        run_id: rid, stamp: m.stamp, prod_prefix: PROD, created_at: new Date().toISOString(), files: existed, before: beforeH, after: afterH,
        content_types: cts, state_keys: states.map((s) => s.key),
        vectors_written: writeVecs.map((v) => v.id), vectors_deleted: a.del.map((v) => v.id), vectors_existed: before.map((v) => v.id),
        parts: { before: nBefore, after: nAfter }, index: cfg.vecIndex,
      };
      await r2.put(`${bk}/_manifest.json`, JSON.stringify(bm));
      const chk = r2.dryRun ? bm : await r2.getJson(`${bk}/_manifest.json`);
      if (!chk || chk.run_id !== rid) throw new Error('退避の読み戻しに失敗。書き始めない');
      log(`退避: ファイル ${Object.values(existed).filter(Boolean).length}・ベクトル ${before.length} 本 → ${bk}/`);

      // 3. 書く（先に世代を進める: 今読んでいる下見・この後の古い下見を使わせない）
      writing = true;
      await r2.put(GEN, JSON.stringify({ run_id: rid, kind: 'apply', at: new Date().toISOString() }));
      await r2.put(cfg.lockKey, JSON.stringify({ ...(await r2.getJson(cfg.lockKey)), phase: 'writing', writing_at: new Date().toISOString() }));
      const body = fileKeys.filter((k) => !cfg.isIndexKey(k)), idx = fileKeys.filter((k) => cfg.isIndexKey(k));
      for (const k of [...body, ...idx]) await r2.put(k, a.files.get(k).buf, cts[k]);
      if (E('TEST_FAIL_APPLY_AT', '') === 'vectors') throw new Error('（確かめ用）ベクトルを入れる前に止めた');
      if (writeVecs.length) await vec.upsert(writeVecs);
      if (a.del.length) await vec.deleteByIds(a.del.map((v) => v.id));
      const myMark = (writeVecs.length || a.del.length) ? await writeMark(vec, r2, rid, 'apply') : null;
      for (const s of states) await r2.put(s.key, s.body);
      log(`反映: ファイル ${body.length}${idx.length ? `＋一覧 ${idx.length}` : ''} / ベクトル 埋め込み ${a.up.length}・metadata ${a.meta.length}・削除 ${a.del.length}`);

      // 4. 抜き取りで読み戻す。通ってから印を外す（合わなければ印を残し、次の下見・反映を止める。restore で戻す）
      for (const k of [...body.slice(0, 3), ...idx, ...states.map((s) => s.key)]) {
        if (sha(await r2.get(k)) !== afterH[k]) throw new Error(`検証: ${k} が書いた中身と合わない。印を残した。${restoreHint(rid)}`);
      }
      if (E('TEST_FAIL_APPLY_AT', '') === 'verify') throw new Error('（確かめ用）読み戻しの検証で止めた');
      if (writeVecs.length || a.del.length) {
        if (await waitMark(vec, myMark)) {
          const sample = writeVecs.slice(0, 3);
          const g = new Map((await vec.getByIds([...sample.map((v) => v.id), ...a.del.slice(0, 3).map((v) => v.id)])).map((v) => [v.id, v]));
          const bad = [...sample.filter((v) => !sameVector(g.get(v.id), v)).map((v) => v.id), ...a.del.slice(0, 3).filter((v) => g.has(v.id)).map((v) => v.id)];
          if (bad.length) throw new Error(`検証: 索引が処理し終えたのに、書いたベクトルと合わない（${bad.join(', ')}）。印を残した。${restoreHint(rid)}`);
        } else log(`※ 検証: Vectorize がまだ書き込みを処理し終えていない（${Math.round(VEC_WAIT_MS() / 60000)} 分待った）。ベクトルの読み戻しは飛ばした（翌日の全体チェックでベクトル検索を見る）`);
      }
      await releaseLock(r2, token);
      log(`戻すときは: ${restoreHint(rid)}（main のコードで動く）`);
      return { run_id: rid };
    } catch (e) {
      if (!writing) await releaseLock(r2, token).catch(() => {});
      throw e;
    }
  }

  // ---------------------------------------------------------------- restore
  async function restore(rid) {
    if (!rid) throw new Error('restore <run_id> を指定してください');
    assertWriteContext('restore');
    const r2 = new R2();
    const vec = new Vectorize({ index: cfg.vecIndex });
    const bk = `${cfg.backupPrefix}/${rid}`;
    const bm = await r2.getJson(`${bk}/_manifest.json`);
    if (!bm) {
      // 退避を作り終える前に落ちた apply（印が 'backup' のまま）: 本番は書いていないので、印だけ外す
      const lk = await r2.getJson(cfg.lockKey);
      if (lk && lk.run_id === rid && lk.kind === 'apply' && lk.phase === 'backup') {
        const again = await r2.getJson(cfg.lockKey);
        if (again && again.token === lk.token) await r2.delete(cfg.lockKey);
        log(`run ${rid} の反映は退避の途中（本番を書く前）で止まっていた。本番は変わっていないので、作業中の印だけ外した`);
        return { unlocked: true };
      }
      throw new Error(`${bk}/_manifest.json がありません`);
    }
    // 本番の版が反映したときと同じときだけ戻す。版を切り替えた後に古い版の回を戻すと、
    // 古い版の R2 を戻しながら、版を持たない共有の Vectorize を今の版から外れた値に書き換えてしまう
    if (cfg.prodPrefix) {
      const PROD = cfg.prodPrefix();
      if (bm.prod_prefix !== PROD) throw new Error(`この回は本番の版 ${bm.prod_prefix} に反映したもので、今の本番は ${PROD}。版を切り替えた後は戻さない（ベクトルは版を持たないので、今の版と食い違う）。何も書いていない`);
    }
    const { token, fresh } = await acquireLock(r2, rid, 'restore', { takeoverSameRun: true });
    let writing = false;
    try {
      // 今の本番が、この回の書いた直後か書く前のまま（apply が途中で落ちた）か。後で別の反映が入っていれば止める
      const allKeys = Object.keys(bm.files);
      const stateKeys = bm.state_keys || [];
      const cts = bm.content_types || {};
      const now = new Map();
      for (const k of allKeys) now.set(k, await r2.get(k));
      const changed = allKeys.filter((k) => { const h = sha(now.get(k)); return h !== (bm.after[k] ?? null) && h !== (bm.before[k] ?? null); });
      if (changed.length) throw new Error(`この回の後に変わったファイルがある（${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' ほか' : ''}）。後の反映を先に戻すか、手で確かめる。何も書いていない`);
      const vBefore = new Map((await getParts(r2, `${bk}/vectors_before`, bm.parts.before)).map((v) => [v.id, v]));
      const vAfter = new Map((await getParts(r2, `${bk}/vectors_after`, bm.parts.after)).map((v) => [v.id, v]));
      if (JSON.stringify([...vBefore.keys()].sort()) !== JSON.stringify([...bm.vectors_existed].sort())) throw new Error('退避のベクトルが、書く前にあった id と合わない。何も書いていない');
      if (JSON.stringify([...vAfter.keys()].sort()) !== JSON.stringify([...bm.vectors_written].sort())) throw new Error('退避の「書いた後」のベクトルが、書いた id と合わない。何も書いていない');
      for (const v of vBefore.values()) if (!validVec(v)) throw new Error(`退避のベクトル ${v.id} の形が不正。何も書いていない`);
      const ids = [...new Set([...bm.vectors_written, ...bm.vectors_deleted])];
      // 前の反映・戻しの書き込みを索引が処理し終えてから今の値を読む（処理前の値で「この回の後に変わった」を取り違えない）
      const prevMut = await r2.getJson(cfg.mutKey);
      if (!await waitMark(vec, prevMut)) throw new Error(`Vectorize が前の反映・戻し（run ${prevMut.run_id}）の書き込みを ${Math.round(VEC_WAIT_MS() / 60000)} 分待っても処理し終えない。何も書いていない。しばらくして流し直す`);
      const vNow = new Map((await getMany(vec, ids)).map((v) => [v.id, v]));
      // 書いた後: 書いたものは vectors_after の値、消したものは無い。書く前: vectors_before の値か、無い
      const vChanged = ids.filter((id) => !sameVector(vNow.get(id), vAfter.get(id)) && !sameVector(vNow.get(id), vBefore.get(id)));
      if (vChanged.length) throw new Error(`この回の後に変わったベクトルがある（${vChanged.slice(0, 5).join(', ')}${vChanged.length > 5 ? ' ほか' : ''}）。手で確かめる。何も書いていない`);
      const restoreBufs = new Map();
      for (const [k, ex] of Object.entries(bm.files)) {
        if (!ex) continue;
        const b = await r2.get(`${bk}/files/${k}`);
        if (sha(b) !== (bm.before[k] ?? null)) throw new Error(`退避の ${k} が欠けているか、書く前の hash と合わない。何も書いていない`);
        restoreBufs.set(k, b);
      }
      // ここから書く。戻す直前の中身も控える（戻したのを戻せるように）。先に世代を進める（戻しの前の下見は使わせない）
      writing = true;
      await r2.put(genKeyOf(cfg.lockKey), JSON.stringify({ run_id: rid, kind: 'restore', at: new Date().toISOString() }));
      const pre = `${bk}/pre_restore_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
      for (const k of allKeys) if (now.get(k)) await r2.put(`${pre}/${k}`, now.get(k), cts[k]);
      await putParts(r2, `${pre}/vectors_current`, [...vNow.values()]);
      log(`戻す前の中身（ファイル・ベクトル ${vNow.size} 本）を控えた: ${pre}/`);
      // 一覧を先に戻し（新しく足したファイルを消す前に一覧から外す）、ファイル → ベクトル → 状態の控えは最後
      const isState = (k) => stateKeys.includes(k);
      const idx = allKeys.filter((k) => !isState(k) && cfg.isIndexKey(k));
      const body = allKeys.filter((k) => !isState(k) && !cfg.isIndexKey(k));
      const put1 = async (k) => { if (bm.files[k]) await r2.put(k, restoreBufs.get(k), cts[k]); else await r2.delete(k); };
      for (const k of idx) await put1(k);
      for (const k of body) await put1(k);
      if (E('TEST_FAIL_RESTORE_AT', '') === 'vectors') throw new Error('（確かめ用）ベクトルを戻す前に止めた');
      // 消すのは、この回に新しく足したベクトルだけ。上書き・差し替え・削除したものは退避の値で upsert し直す
      const pureNew = bm.vectors_written.filter((id) => !vBefore.has(id));
      if (pureNew.length) await vec.deleteByIds(pureNew);
      if (vBefore.size) await vec.upsert([...vBefore.values()]);
      if (pureNew.length || vBefore.size) await writeMark(vec, r2, rid, 'restore');
      for (const k of allKeys.filter(isState)) await put1(k);
      await releaseLock(r2, token);
      log(`戻した: ファイル ${allKeys.length}・ベクトル 削除 ${pureNew.length} / 退避の値で上書き ${vBefore.size}`);
      return { restored: true };
    } catch (e) {
      if (!writing && fresh) await releaseLock(r2, token).catch(() => {});
      throw e;
    }
  }

  return { apply, restore };
}

module.exports = { makeApplier, makeGenGuard, genKeyOf, sameVector, stableJson, MARK_NS };
