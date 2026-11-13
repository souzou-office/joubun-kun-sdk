// Vectorize（law-embeddings-v2）の upsert / delete / get / query。REST API v2 を使う。
//   VECTORIZE_FAKE_FILE を指定すると、その JSON ファイル { id: {values, metadata} } を索引に見立てる。
//   UPDATE_DRY_RUN=1 なら upsert/delete は記録だけ。
const fs = require('fs');
const path = require('path');
const { CONFIG, retry, log } = require('./common.cjs');

const UPSERT_BATCH = 1000;   // 1 リクエストあたりのベクトル数（1024 次元 × 1000 ≒ 10MB 弱）
const DELETE_BATCH = 100;   // delete_by_ids は 1 リクエスト 100 件まで（超えると 400 code 40007。2026-09-21 run #11）

class Vectorize {
  constructor(opts = {}) {
    this.fakeFile = opts.fakeFile !== undefined ? opts.fakeFile : (process.env.VECTORIZE_FAKE_FILE || null);
    this.dryRun = opts.dryRun !== undefined ? opts.dryRun : CONFIG.dryRun;
    this.index = opts.index || CONFIG.vectorizeIndex;
    this.accountId = opts.accountId || CONFIG.accountId;
    this.token = opts.token || CONFIG.apiToken;
    this.ops = [];   // { op: 'upsert'|'delete', count }
    if (!this.fakeFile && (!this.accountId || !this.token)) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN を設定するか、VECTORIZE_FAKE_FILE を指定してください');
    }
  }
  _base() { return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/vectorize/v2/indexes/${this.index}`; }
  _readFake() { return fs.existsSync(this.fakeFile) ? JSON.parse(fs.readFileSync(this.fakeFile, 'utf8')) : {}; }
  _writeFake(obj) { fs.mkdirSync(path.dirname(this.fakeFile), { recursive: true }); fs.writeFileSync(this.fakeFile, JSON.stringify(obj)); }
  // 偽の索引の書き込み（mutation）。本物と同じく mutationId を返す。
  //   VECTORIZE_FAKE_LAG=1 のときは、書き込みを「処理待ち」（{fakeFile}.pending.json）に積むだけで索引に入れない＝処理が遅れている索引。
  //   _fakeProcessPending(n) で先頭から n 件だけ処理する（確かめ用）
  _fakeMutation(op) {
    const id = `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (process.env.VECTORIZE_FAKE_LAG === '1') {
      const pf = `${this.fakeFile}.pending.json`;
      const q = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : [];
      q.push({ id, ...op });
      fs.writeFileSync(pf, JSON.stringify(q));
      return id;
    }
    this._fakeApply(op);
    return id;
  }
  _fakeApply(op) {
    const db = this._readFake();
    if (op.upsert) for (const v of op.upsert) db[v.id] = { values: v.values, metadata: v.metadata, ...(v.namespace ? { namespace: v.namespace } : {}) };
    if (op.delete) for (const id of op.delete) delete db[id];
    this._writeFake(db);
  }
  _fakeProcessPending(n = Infinity) {
    const pf = `${this.fakeFile}.pending.json`;
    const q = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : [];
    const take = q.splice(0, n);
    for (const m of take) this._fakeApply(m);
    fs.writeFileSync(pf, JSON.stringify(q));
    return take.length;
  }

  // vectors: [{ id, values, metadata }] → 最後の書き込みの mutationId（取れなければ null）
  async upsert(vectors) {
    let mutationId = null;
    for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
      const batch = vectors.slice(i, i + UPSERT_BATCH);
      this.ops.push({ op: 'upsert', count: batch.length });
      if (this.dryRun) continue;
      if (this.fakeFile) {
        mutationId = this._fakeMutation({ upsert: batch });
        continue;
      }
      const body = batch.map((v) => JSON.stringify(v)).join('\n') + '\n';
      const res1 = await retry(async () => {
        const res = await fetch(`${this._base()}/upsert`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/x-ndjson' }, body });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.success === false) throw new Error(`Vectorize upsert → ${res.status} ${JSON.stringify(j.errors || '').slice(0, 300)}`);
        return j;
      }, { tries: 6, baseMs: 1000, label: 'Vectorize upsert' });
      mutationId = (res1 && res1.result && res1.result.mutationId) || mutationId;
      log(`  vectorize upsert ${Math.min(i + UPSERT_BATCH, vectors.length)}/${vectors.length}`);
    }
    return mutationId;
  }

  async deleteByIds(ids) {
    let mutationId = null;
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const batch = ids.slice(i, i + DELETE_BATCH);
      this.ops.push({ op: 'delete', count: batch.length });
      if (this.dryRun) continue;
      if (this.fakeFile) {
        mutationId = this._fakeMutation({ delete: batch });
        continue;
      }
      const res1 = await retry(async () => {
        const res = await fetch(`${this._base()}/delete_by_ids`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.success === false) throw new Error(`Vectorize delete → ${res.status} ${JSON.stringify(j.errors || '').slice(0, 300)}`);
        return j;
      }, { tries: 6, baseMs: 1000, label: 'Vectorize delete' });
      mutationId = (res1 && res1.result && res1.result.mutationId) || mutationId;
    }
    return mutationId;
  }

  // ID で取る（values 込み。検証と、上書き前の退避に使う。namespace は返ってきたときだけ付ける）
  async getByIds(ids) {
    if (this.fakeFile) {
      const db = this._readFake();
      return ids.filter((id) => db[id]).map((id) => ({ id, values: db[id].values, metadata: db[id].metadata, ...(db[id].namespace ? { namespace: db[id].namespace } : {}) }));
    }
    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const j = await retry(async () => {
        const res = await fetch(`${this._base()}/get_by_ids`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.success === false) throw new Error(`Vectorize get_by_ids → ${res.status}`);
        return j;
      }, { tries: 5, baseMs: 800, label: 'Vectorize get' });
      for (const v of j.result || []) out.push({ id: v.id, values: v.values, metadata: v.metadata, ...(v.namespace ? { namespace: v.namespace } : {}) });
    }
    return out;
  }

  // 索引の全 id（読むだけ。list-vectors は id だけを返し、namespace は分からない）。最初の呼び出しの時点の姿を返す
  //   → [id, ...]。pageMs: 1 ページごとの間（API の上限に掛からないように）
  async listIds({ pageMs = 300 } = {}) {
    if (this.fakeFile) return Object.keys(this._readFake());
    const out = [];
    let cursor = null;
    for (let page = 0; ; page++) {
      const qs = new URLSearchParams({ count: '1000', ...(cursor ? { cursor } : {}) });
      const j = await retry(async () => {
        const res = await fetch(`${this._base()}/list?${qs}`, { headers: { Authorization: `Bearer ${this.token}` } });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.success === false) throw new Error(`Vectorize list → ${res.status}`);
        return j;
      }, { tries: 5, baseMs: 1000, label: 'Vectorize list' });
      const r = j.result || {};
      for (const v of r.vectors || []) out.push(typeof v === 'string' ? v : v.id);
      if (!r.isTruncated || !r.nextCursor) break;
      cursor = r.nextCursor;
      if (pageMs) await new Promise((res) => setTimeout(res, pageMs));
    }
    return out;
  }

  // 索引の状態（読むだけ。scripts/health/audit.cjs が本数を数える）→ { vectorCount, dimensions, ... }
  //   偽の索引では、今入っている本数
  async info() {
    if (this.fakeFile) return { vectorCount: Object.keys(this._readFake()).length, dimensions: 1024 };
    const j = await retry(async () => {
      const res = await fetch(`${this._base()}/info`, { headers: { Authorization: `Bearer ${this.token}` } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.success === false) throw new Error(`Vectorize info → ${res.status}`);
      return j;
    }, { tries: 4, baseMs: 800, label: 'Vectorize info' });
    return j.result || {};
  }

  // 近いベクトルを引く（読むだけ。本番の全体チェック scripts/health/check_prod.cjs が固定の文言で索引が生きているかを見る）
  // → [{ id, score, metadata }]（score の高い順）
  async query(vector, { topK = 10, namespace = null } = {}) {
    if (this.fakeFile) {
      const db = this._readFake();
      const dot = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); };
      return Object.entries(db).filter(([, v]) => (v.namespace || null) === (namespace || null))
        .map(([id, v]) => ({ id, score: dot(vector, v.values), metadata: v.metadata || {} }))
        .sort((a, b) => b.score - a.score).slice(0, topK);
    }
    const body = { vector, topK, returnMetadata: 'all', ...(namespace ? { namespace } : {}) };
    const j = await retry(async () => {
      const res = await fetch(`${this._base()}/query`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.success === false) throw new Error(`Vectorize query → ${res.status}`);
      return j;
    }, { tries: 4, baseMs: 800, label: 'Vectorize query' });
    return ((j.result && j.result.matches) || []).map((m) => ({ id: m.id, score: m.score, metadata: m.metadata || {} }));
  }
}

module.exports = { Vectorize };
