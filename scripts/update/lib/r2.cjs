// R2（joubun-kun-data）の読み書き。
//
// 通り道は 2 つ:
//   s3   : R2 の S3 互換 API（https://{account}.r2.cloudflarestorage.com）。SigV4 で署名する。
//          鍵は API トークンから導く（Access Key ID = トークンの ID、Secret = トークン値の SHA-256）ので秘密は増えない。
//          Cloudflare REST API の全体上限（5 分に 1,200 リクエスト）に掛からないので、全件再構築（数十万オブジェクト）はこちら。
//   rest : Cloudflare REST API（/r2/buckets/{bucket}/objects）。少量向け。5 分に 1,200 を超えると 429 になる
//          （2026-09-20 の全件再構築 run #7 が 05 の読み取りで 429 で止まった）。
//   R2_TRANSPORT=auto（既定。トークン ID が取れれば s3、取れなければ rest）/ s3（取れなければ失敗）/ rest
//   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY を直接与えてもよい（R2 の「API トークンの管理」で作った鍵）。
//
//   R2_FAKE_DIR を指定するとそのディレクトリをバケットに見立てて読み書きする（テスト・オフライン検証）。
//   UPDATE_DRY_RUN=1 のときは put/delete を実行せず記録だけする（get/list は本物を読む）。
//
// 書き込みは必ず writes[] に記録される（apply の報告と検証に使う）。
//   node scripts/update/lib/r2.cjs --selftest   通り道の確認（一覧を 1 回読むだけ・書かない）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG, retry, log, sleep } = require('./common.cjs');

// ===== SigV4（AWS Signature Version 4）。依存なし =====
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
// RFC 3986 の unreserved 以外を全部 %XX にする（encodeURIComponent は !*'() を残すので足す）
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodePath = (key) => key.split('/').map(rfc3986).join('/');
const amzDate = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

// 署名付きヘッダを返す。{ method, host, path（エンコード済み・先頭 /）, query（{k:v}）, headers（小文字キー）, payloadHash, accessKey, secretKey, region, service, date }
function signV4({ method, host, path: p, query = {}, headers = {}, payloadHash, accessKey, secretKey, region = 'auto', service = 's3', date = amzDate() }) {
  const h = {};
  for (const [k, v] of Object.entries({ ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date })) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const signedHeaders = Object.keys(h).sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${h[k]}\n`).join('');
  const canonicalQuery = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`).join('&');
  const canonicalRequest = [method, p, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    ...h,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}

// API トークンから S3 の鍵を導く。トークン ID は verify エンドポイントで取る（ユーザー所有→アカウント所有の順）
// ETag を If-Match に渡せる形に（引用符と弱い印 W/ を外す）
function normEtag(v) {
  return String(v || '').trim().replace(/^W\//i, '').replace(/"/g, '');
}

async function deriveS3Credentials(accountId, token) {
  if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) return { accessKey: process.env.R2_ACCESS_KEY_ID, secretKey: process.env.R2_SECRET_ACCESS_KEY, source: 'env' };
  const urls = [`https://api.cloudflare.com/client/v4/user/tokens/verify`, `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`];
  let lastErr = '';
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.success && j.result && j.result.id) return { accessKey: j.result.id, secretKey: sha256Hex(token), source: u.includes('/accounts/') ? 'account-token' : 'user-token' };
      lastErr = `${res.status} ${JSON.stringify(j.errors || '').slice(0, 120)}`;
    } catch (e) { lastErr = e.message; }
  }
  return { error: lastErr };
}

const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const xmlTag = (block, tag) => { const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? xmlUnescape(m[1]) : null; };

class R2 {
  constructor(opts = {}) {
    this.fakeDir = opts.fakeDir !== undefined ? opts.fakeDir : (process.env.R2_FAKE_DIR || null);
    this.dryRun = opts.dryRun !== undefined ? opts.dryRun : CONFIG.dryRun;
    this.bucket = opts.bucket || CONFIG.bucket;
    this.accountId = opts.accountId || CONFIG.accountId;
    this.token = opts.token || CONFIG.apiToken;
    this.transportWanted = (opts.transport || process.env.R2_TRANSPORT || 'auto').toLowerCase();
    this.transport = this.fakeDir ? 'fake' : null;   // 'fake' | 's3' | 'rest'（初回の呼び出しで決まる）
    this.s3 = null;
    this._ready = null;
    this.writes = [];   // { op: 'put'|'delete', key, bytes }
    this.reads = 0;
    if (!this.fakeDir && (!this.accountId || !this.token)) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN（または R2_ACCOUNT_ID / R2_API_TOKEN）を設定するか、R2_FAKE_DIR を指定してください');
    }
  }

  // 通り道を決める（1 回だけ）。auto: 鍵が導ければ s3、だめなら rest
  async ready() {
    if (this.transport) return this.transport;
    if (!this._ready) this._ready = (async () => {
      if (this.transportWanted === 'rest') { this.transport = 'rest'; return this.transport; }
      const cred = await deriveS3Credentials(this.accountId, this.token);
      if (cred.accessKey) {
        this.s3 = { accessKey: cred.accessKey, secretKey: cred.secretKey, host: `${this.accountId}.r2.cloudflarestorage.com` };
        this.transport = 's3';
        log(`R2: S3 API を使う（鍵の出所: ${cred.source}）`);
      } else if (this.transportWanted === 's3') {
        throw new Error(`R2: S3 の鍵が導けない（${cred.error}）。R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY を与えるか R2_TRANSPORT=rest にする`);
      } else {
        this.transport = 'rest';
        log(`R2: REST API を使う（S3 の鍵が導けない: ${cred.error}）。大量の読み書きは 5 分 1,200 件の上限に掛かる`);
      }
      return this.transport;
    })();
    return this._ready;
  }

  _restUrl(key) {
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/r2/buckets/${this.bucket}/objects/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  }
  _fakePath(key) { return path.join(this.fakeDir, ...key.split('/')); }

  // S3 リクエスト 1 回（署名して投げる）。key=null ならバケット自体（一覧）
  async _s3(method, key, { query = {}, body = null, contentType = null, extraHeaders = {} } = {}) {
    const p = '/' + this.bucket + (key ? '/' + encodePath(key) : '');
    const payloadHash = body ? sha256Hex(body) : sha256Hex('');
    const headers = { ...extraHeaders };
    if (contentType) headers['content-type'] = contentType;
    const signed = signV4({ method, host: this.s3.host, path: p, query, headers, payloadHash, accessKey: this.s3.accessKey, secretKey: this.s3.secretKey });
    const qs = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`).join('&');
    return fetch(`https://${this.s3.host}${p}${qs ? '?' + qs : ''}`, { method, headers: signed, body: body || undefined });
  }

  async get(key) {
    this.reads++;
    if (this.fakeDir) {
      const p = this._fakePath(key);
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    }
    await this.ready();
    return retry(async () => {
      const res = this.transport === 's3' ? await this._s3('GET', key) : await fetch(this._restUrl(key), { headers: { Authorization: `Bearer ${this.token}` } });
      if (res.status === 404) { await res.arrayBuffer().catch(() => {}); return null; }
      if (!res.ok) throw new Error(`R2 GET ${key} → ${res.status}${res.status === 403 && this.transport === 's3' ? '（S3 の署名か鍵の権限）' : ''}`);
      return Buffer.from(await res.arrayBuffer());
    }, { tries: 6, baseMs: 500, label: `R2 GET` });
  }

  async getJson(key) {
    const b = await this.get(key);
    return b ? JSON.parse(b.toString('utf8')) : null;
  }

  async put(key, body, contentType = 'application/json') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    this.writes.push({ op: 'put', key, bytes: buf.length });
    if (this.dryRun) return;
    if (this.fakeDir) {
      const p = this._fakePath(key);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      return;
    }
    await this.ready();
    await retry(async () => {
      const res = this.transport === 's3'
        ? await this._s3('PUT', key, { body: buf, contentType })
        : await fetch(this._restUrl(key), { method: 'PUT', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': contentType }, body: buf });
      if (!res.ok) throw new Error(`R2 PUT ${key} → ${res.status} ${(await res.text()).slice(0, 200)}`);
      await res.arrayBuffer().catch(() => {});
    }, { tries: 8, baseMs: 500, label: 'R2 PUT' });
  }

  // 無いときだけ書く（排他の印に使う）。書けたら true、既にあれば false。
  //   S3 API の If-None-Match: *（R2 の条件付き書き込み。既にあれば 412）。REST API では原子的にできないので使えない
  async putIfAbsent(key, body, contentType = 'application/json') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    this.writes.push({ op: 'putIfAbsent', key, bytes: buf.length });
    if (this.dryRun) return true;
    if (this.fakeDir) {
      const p = this._fakePath(key);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      try { fs.writeFileSync(p, buf, { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    }
    await this.ready();
    if (this.transport !== 's3') throw new Error('R2: 無いときだけ書く（排他）は S3 API でしかできない。R2_TRANSPORT=rest では使えない');
    return retry(async () => {
      const res = await this._s3('PUT', key, { body: buf, contentType, extraHeaders: { 'if-none-match': '*' } });
      await res.arrayBuffer().catch(() => {});
      if (res.status === 412) return false;
      if (!res.ok) throw new Error(`R2 PUT(If-None-Match) ${key} → ${res.status}`);
      return true;
    }, { tries: 6, baseMs: 500, label: 'R2 PUT if-none-match' });
  }

  // 中身と ETag を読む（条件付き書き込み putIfMatch と組で使う）。無ければ null。
  //   S3 API だけ（ETag はレスポンスの ETag ヘッダ）。R2_FAKE_DIR のときは中身の MD5（R2 の単発 PUT の ETag と同じ作り）
  async getWithEtag(key) {
    this.reads++;
    if (this.fakeDir) {
      const p = this._fakePath(key);
      if (!fs.existsSync(p)) return null;
      const body = fs.readFileSync(p);
      return { body, etag: crypto.createHash('md5').update(body).digest('hex') };
    }
    await this.ready();
    if (this.transport !== 's3') throw new Error('R2: ETag つきの読み取りは S3 API でしかできない。R2_TRANSPORT=rest では使えない');
    return retry(async () => {
      // 圧縮して返されると ETag が弱い形（W/"…"）になり、そのまま If-Match に使うと必ず 412 になる（Node の fetch は
      // 既定で Accept-Encoding: gzip を付ける。2026-10-10 に既にある Q&A への追記が全部「同時に書き換えられた」で止まった）。
      // 圧縮しない形で受け取り、念のため弱い印も外す
      const res = await this._s3('GET', key, { extraHeaders: { 'accept-encoding': 'identity' } });
      if (res.status === 404) { await res.arrayBuffer().catch(() => {}); return null; }
      if (!res.ok) throw new Error(`R2 GET ${key} → ${res.status}`);
      const etag = normEtag(res.headers.get('etag'));
      const body = Buffer.from(await res.arrayBuffer());
      if (!etag) throw new Error(`R2 GET ${key}: ETag が無い`);
      return { body, etag };
    }, { tries: 6, baseMs: 500, label: 'R2 GET(etag)' });
  }

  // 読んだときから変わっていないときだけ書く（R2 の条件付き書き込み）。書けたら true、変わっていたら false（412）。
  //   etag が null なら「まだ無いこと」を条件にする（If-None-Match: *）。getWithEtag で読んだ etag を渡す。
  //   同じキーを別の実行が同時に書き換えても、後から書く方は必ず false になる（読み直して比べるだけの方法と違い、間に隙間が無い）
  async putIfMatch(key, body, etag, contentType = 'application/json') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    this.writes.push({ op: 'putIfMatch', key, bytes: buf.length });
    if (this.dryRun) return true;
    if (this.fakeDir) {
      const p = this._fakePath(key);
      const cur = fs.existsSync(p) ? crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') : null;
      if (cur !== (etag || null)) return false;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      return true;
    }
    await this.ready();
    if (this.transport !== 's3') throw new Error('R2: 条件付き書き込みは S3 API でしかできない。R2_TRANSPORT=rest では使えない');
    return retry(async () => {
      const res = await this._s3('PUT', key, { body: buf, contentType, extraHeaders: etag ? { 'if-match': `"${etag}"` } : { 'if-none-match': '*' } });
      await res.arrayBuffer().catch(() => {});
      if (res.status === 412) return false;
      if (!res.ok) throw new Error(`R2 PUT(If-Match) ${key} → ${res.status}`);
      return true;
    }, { tries: 6, baseMs: 500, label: 'R2 PUT if-match' });
  }

  async delete(key) {
    this.writes.push({ op: 'delete', key });
    if (this.dryRun) return;
    if (this.fakeDir) {
      const p = this._fakePath(key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return;
    }
    await this.ready();
    await retry(async () => {
      const res = this.transport === 's3' ? await this._s3('DELETE', key) : await fetch(this._restUrl(key), { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` } });
      if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} → ${res.status}`);
      await res.arrayBuffer().catch(() => {});
    }, { tries: 8, baseMs: 500, label: 'R2 DELETE' });
  }

  // prefix 配下のキー一覧 [{ key, size, etag, last_modified }]
  async list(prefix) {
    if (this.fakeDir) {
      const out = [];
      const base = this._fakePath(prefix.replace(/\/$/, ''));
      const walk = (dir, rel) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          const st = fs.statSync(p);
          const key = (rel ? rel + '/' : '') + name;
          if (st.isDirectory()) walk(p, key); else out.push({ key, size: st.size, etag: null, last_modified: st.mtime.toISOString() });
        }
      };
      // prefix がディレクトリ境界でないこともある（"large_law_articles_v3/129AC" など）ので親を歩いて前方一致で絞る
      const stripped = prefix.replace(/\/$/, '');
      const parent = path.dirname(base);
      const relParent = stripped.includes('/') ? stripped.slice(0, stripped.lastIndexOf('/')) : '';
      walk(parent, relParent);
      return out.filter((o) => o.key.startsWith(prefix));
    }
    await this.ready();
    return this.transport === 's3' ? this._listS3(prefix) : this._listRest(prefix);
  }

  async _listS3(prefix) {
    const out = [];
    let token = null;
    for (;;) {
      const query = { 'list-type': '2', 'max-keys': '1000', prefix };
      if (token) query['continuation-token'] = token;
      const xml = await retry(async () => {
        const res = await this._s3('GET', null, { query });
        const text = await res.text();
        if (!res.ok) throw new Error(`R2 LIST ${prefix} → ${res.status} ${text.slice(0, 160)}`);
        return text;
      }, { tries: 6, baseMs: 500, label: 'R2 LIST' });
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const b = m[1];
        out.push({ key: xmlTag(b, 'Key'), size: Number(xmlTag(b, 'Size') || 0), etag: (xmlTag(b, 'ETag') || '').replace(/"/g, '') || null, last_modified: xmlTag(b, 'LastModified') });
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated ? xmlTag(xml, 'NextContinuationToken') : null;
      if (!token) break;
    }
    return out;
  }

  async _listRest(prefix) {
    const out = [];
    let cursor = null;
    for (;;) {
      const params = new URLSearchParams({ per_page: '1000', prefix });
      if (cursor) params.set('cursor', cursor);
      const data = await retry(async () => {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/r2/buckets/${this.bucket}/objects?${params}`, { headers: { Authorization: `Bearer ${this.token}` } });
        if (!res.ok) throw new Error(`R2 LIST ${prefix} → ${res.status}`);
        return res.json();
      }, { tries: 5, baseMs: 500, label: 'R2 LIST' });
      if (!data.success) throw new Error(`R2 LIST failed: ${JSON.stringify(data.errors)}`);
      for (const o of data.result || []) out.push({ key: o.key, size: o.size, etag: o.etag, last_modified: o.last_modified });
      cursor = data.result_info && data.result_info.cursor;
      if (!cursor || (data.result || []).length === 0) break;
      await sleep(50);
    }
    return out;
  }

  // 並列実行の小さなヘルパー
  static async pmap(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }
}

module.exports = { R2, log, _internal: { signV4, rfc3986, encodePath, deriveS3Credentials, xmlTag, normEtag } };

// ===== 通り道の確認（書かない） =====
if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    const r2 = new R2();
    const t = await r2.ready();
    const list = await r2.list('update_state/');
    log(`R2 selftest: transport=${t} bucket=${r2.bucket} update_state/ に ${list.length} 件（例: ${(list[0] || {}).key || '-'}）`);
    const led = await r2.get(CONFIG.ledgerKey);
    log(`  台帳 ${CONFIG.ledgerKey}: ${led ? `${led.length} bytes` : '無し'}`);
    if (process.env.R2_TRANSPORT === 's3' && t !== 's3') process.exit(2);
  })().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
}
