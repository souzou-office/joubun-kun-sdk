// Workers AI（@cf/baai/bge-m3）で埋め込みを作る。REST API 経由なので Worker を配らずに使える。
//   AI_FAKE=1     決定的な疑似ベクトル（テキストのハッシュから生成、1024 次元）を返す
//   AI_POOLING    'cls' か 'mean' を渡すと bge-m3 の pooling を指定する（未指定なら Workers AI の既定）。
//                 索引（2026-05 にローカル bge-m3・CLS pooling で作成）と合わせるための設定。check_embed_drift.cjs で確かめる
const crypto = require('crypto');
const { CONFIG, retry, log, sleep } = require('./common.cjs');

const MODEL = '@cf/baai/bge-m3';
const DIM = 1024;
// Workers AI の bge-m3 は「1 リクエストの合計トークン」に上限がある（実測: 60,000 を超えると 400 "Max context reached"）。
// 本数ではなく推定トークン（日本語は 1 文字 ≒ 1〜1.5 トークン）で束ねる。超えたら半分に割って投げ直す
const MAX_TEXTS = Number(process.env.AI_BATCH || 50);          // 1 リクエストの本数の上限（bge-m3 は 100 まで）
const MAX_TOKENS = Number(process.env.AI_BATCH_TOKENS || 40000); // 1 リクエストの推定トークンの上限（60,000 に余裕を見る）
const TOKENS_PER_CHAR = 1.6;
const estTokens = (s) => Math.ceil(String(s).length * TOKENS_PER_CHAR) + 2;

function fakeVector(text) {
  const out = new Array(DIM);
  let seed = crypto.createHash('sha256').update(text, 'utf8').digest();
  for (let i = 0; i < DIM; i++) {
    if (i % 32 === 0 && i > 0) seed = crypto.createHash('sha256').update(seed).digest();
    out[i] = (seed[i % 32] / 255) * 2 - 1;
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

class Embedder {
  constructor(opts = {}) {
    this.fake = opts.fake !== undefined ? opts.fake : process.env.AI_FAKE === '1';
    this.accountId = opts.accountId || CONFIG.accountId;
    this.token = opts.token || CONFIG.apiToken;
    this.pooling = opts.pooling !== undefined ? opts.pooling : (process.env.AI_POOLING || null);
    this.calls = 0;
    this.texts = 0;
    if (!this.fake && (!this.accountId || !this.token)) throw new Error('CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN を設定するか、AI_FAKE=1 を指定してください');
  }

  // texts: string[] → number[][]（同じ順）
  async embed(texts) {
    const out = new Array(texts.length);
    // 推定トークンと本数で束ねる
    const batches = [];
    let cur = [], curTok = 0;
    texts.forEach((t, i) => {
      const tok = estTokens(t);
      if (cur.length && (cur.length >= MAX_TEXTS || curTok + tok > MAX_TOKENS)) { batches.push(cur); cur = []; curTok = 0; }
      cur.push(i); curTok += tok;
    });
    if (cur.length) batches.push(cur);
    let done = 0;
    for (const idx of batches) {
      const vecs = await this._embedBatch(idx.map((i) => texts[i]));
      idx.forEach((i, j) => { out[i] = vecs[j]; });
      done += idx.length;
      if (batches.length > 20 && done % 1000 < idx.length) log(`  embed ${done}/${texts.length}`);
    }
    return out;
  }

  // 1 リクエスト。合計トークン超過（code 3030）なら半分に割って再帰
  async _embedBatch(batch) {
    this.calls++;
    this.texts += batch.length;
    if (this.fake) return batch.map(fakeVector);
    const body = { text: batch };
    if (this.pooling) body.pooling = this.pooling;
    let res, j;
    try {
      j = await retry(async () => {
        res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${MODEL}`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const jj = await res.json().catch(() => ({}));
        const msg = JSON.stringify(jj.errors || '');
        if (res.status === 400 && /Max context reached|code":3030/.test(msg)) { const e = new Error('CONTEXT_LIMIT'); e.noRetry = true; throw e; }
        if (!res.ok || jj.success === false || !jj.result || !Array.isArray(jj.result.data)) throw new Error(`Workers AI → ${res.status} ${msg.slice(0, 300)}`);
        if (jj.result.data.length !== batch.length) throw new Error(`Workers AI: 返却数が合わない ${jj.result.data.length} != ${batch.length}`);
        return jj;
      }, { tries: 6, baseMs: 1000, label: 'Workers AI' });
    } catch (e) {
      if (e.message === 'CONTEXT_LIMIT' || (e.noRetry)) {
        if (batch.length === 1) throw new Error(`Workers AI: 1 本でも合計トークン上限を超える（${batch[0].length} 文字）。AI_MAX_TEXT_CHARS を下げるか本文を短くする`);
        const half = Math.ceil(batch.length / 2);
        log(`  合計トークン超過 → ${batch.length} 本を ${half} + ${batch.length - half} に分割`);
        const a = await this._embedBatch(batch.slice(0, half));
        const b = await this._embedBatch(batch.slice(half));
        return [...a, ...b];
      }
      throw e;
    }
    await sleep(30);
    return j.result.data;
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

module.exports = { Embedder, DIM, MODEL, cosine };
