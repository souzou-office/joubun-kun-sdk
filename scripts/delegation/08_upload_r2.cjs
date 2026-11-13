#!/usr/bin/env node
// 07 の配信用ファイル（rebuild_output/delegations/r2_dist/）を R2 に上げる。
//
//   node scripts/delegation/08_upload_r2.cjs [--prefix delegations_v2] [--force] [--dry-run]
//
// - 既定の上げ先は delegations_v2（新しいプレフィックス）。公開中のプレフィックス（wrangler.toml / wrangler.staging.toml の
//   DELEGATIONS_PREFIX）には --force でも書かない（Blue-Green。上書き中に旧 index と新チャンクが混ざって読み取りが壊れるため）。
//   上げたら wrangler.staging.toml の DELEGATIONS_PREFIX を新しい世代にして staging で確かめ、良ければ wrangler.toml と
//   Variables DELEGATIONS_PREFIX（update_laws.yml の 05_diff）も同じ値に PR で直し、main を checkout してから wrangler deploy
// - 上げ先のプレフィックスに鍵が 1 つでもあれば止まる（index.json の有無ではなく一覧で見る。途中で失敗した後の再実行でも既存を黙って
//   上書きしない）。--force のときは、既存の鍵を全部 backup_updates/{run_id}/ に退避してから書く
// - 通り道は 2 つ（--transport api|wrangler。既定は api）
//     api:      scripts/update/lib/common.cjs と同じ認証（CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN）。S3 互換 API。既存の鍵は一覧で見る
//     wrangler: 明示したときだけ。`wrangler login` 済みの PC で `npx wrangler r2 object get/put --remote` を使う（トークンの環境変数が要らない。
//               tsutatsu/09_upload_chunks.cjs と同じ）。CLI は Cloudflare REST API を通るので、アカウント全体で 5 分 1,200 件の上限に掛かる
//               （CLAUDE.md「R2 を大量に触るスクリプトは R2 クラス」）。この配信物は index.json + 2MB チャンク数十個で、有無の確認と
//               書き込みを合わせても 100 件前後なので使えるが、WRANGLER_MAX_REQUESTS（既定 300）を超える件数なら止めて api に誘導する。
//               一覧が無いので、これから書く鍵（index.json とチャンク）の有無を 1 つずつ見る。コマンドは WRANGLER_CMD で差し替えられる（検査用）
// - 固定データの検査: node scripts/delegation/check_upload_r2.cjs（¥0）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { DELEG_DIR } = require('./lib.cjs');
const { R2 } = require('../update/lib/r2.cjs');
const { CONFIG, log } = require('../update/lib/common.cjs');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const PREFIX = String(opt('--prefix', 'delegations_v2')).replace(/\/+$/, '');
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run') || CONFIG.dryRun;
const TRANSPORT = String(opt('--transport', 'api'));   // wrangler は明示したときだけ（REST API の上限を消費するため既定にしない）
const WRANGLER_MAX_REQUESTS = Number(process.env.WRANGLER_MAX_REQUESTS || 300);
const BUCKET = process.env.R2_BUCKET || CONFIG.bucket;
const WRANGLER_CMD = process.env.WRANGLER_CMD || 'npx wrangler';
const WRANGLER_NOT_FOUND_RE = /The specified (?:key|object) does not exist|\bNoSuchKey\b|\[code: 10007\]/;

// wrangler 経由の R2（get / put だけ。一覧は無い）。鍵は "bucket/key" で渡す
function wranglerClient() {
  const q = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
  const run = (cmd) => {
    try { return { ok: true, out: execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }) }; }
    catch (e) { return { ok: false, out: `${e.stdout || ''}\n${e.stderr || ''}`, status: e.status }; }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-r2-'));
  return {
    transport: 'wrangler',
    async get(key) {
      const file = path.join(tmp, crypto.randomUUID());
      const r = run(`${WRANGLER_CMD} r2 object get ${q(`${BUCKET}/${key}`)} --file ${q(file)} --remote`);
      if (r.ok) { const b = fs.readFileSync(file); fs.unlinkSync(file); return b; }
      // 「無い」と判定するのは、鍵の不存在を示す決まった文言だけ（wrangler / R2 の "The specified key does not exist."、
      // S3 互換の NoSuchKey、R2 のエラーコード 10007）。それ以外の失敗（認証・通信など。出力に 404 や鍵名が混ざっていても）は
      // 無いことにせず止める。止まってしまう文言があれば、この判定に足す
      if (WRANGLER_NOT_FOUND_RE.test(r.out)) return null;
      throw new Error(`wrangler r2 object get ${key} が失敗（無いとは判定できない）（${(r.out || '').trim().slice(-300)}）`);
    },
    async put(key, body, contentType = 'application/json') {
      if (DRY) return;
      const file = path.join(tmp, crypto.randomUUID());
      fs.writeFileSync(file, Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'));
      const r = run(`${WRANGLER_CMD} r2 object put ${q(`${BUCKET}/${key}`)} --file ${q(file)} --content-type ${q(contentType)} --remote`);
      fs.unlinkSync(file);
      if (!r.ok) throw new Error(`wrangler r2 object put ${key} が失敗（${(r.out || '').trim().slice(-300)}）`);
    },
    async getJson(key) { const b = await this.get(key); return b ? JSON.parse(b.toString('utf8')) : null; },
  };
}
const DIST = path.join(DELEG_DIR, 'r2_dist');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// 公開中のプレフィックス（wrangler.toml と wrangler.staging.toml の vars DELEGATIONS_PREFIX、とコード既定の delegations_v1）。
// 設定ファイルが読めなければ止める（読めないまま既定だけ守って続けると、本番が v2 以降を読んでいるときに公開中の世代を上書きできてしまう）。
// 変数が無いのは正常（コード既定の v1 を読んでいる）
function livePrefixes() {
  const out = new Set(['delegations_v1']);
  for (const f of ['wrangler.toml', 'wrangler.staging.toml']) {
    const file = path.join(process.env.WRANGLER_DIR || REPO_ROOT, f);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`${file} が読めない（${e.code || e.message}）。公開中のプレフィックスが分からないので上げない`); }
    const m = text.match(/^\s*DELEGATIONS_PREFIX\s*=\s*"([^"]+)"/m);
    if (m) out.add(m[1]);
  }
  return out;
}

async function main() {
  if (!/^[A-Za-z0-9_]+$/.test(PREFIX)) throw new Error(`プレフィックスが不正: ${PREFIX}`);
  const files = fs.existsSync(DIST) ? fs.readdirSync(DIST).filter((f) => f === 'index.json' || /^chunk_\d{3}\.json$/.test(f)) : [];
  if (!files.includes('index.json')) throw new Error(`${DIST} に index.json が無い（先に 06 → 07 を流す）`);
  const index = JSON.parse(fs.readFileSync(path.join(DIST, 'index.json'), 'utf8'));
  const chunkNums = new Set(Object.values(index).map((n) => String(n).padStart(3, '0')));
  for (const n of chunkNums) if (!files.includes(`chunk_${n}.json`)) throw new Error(`index.json が指す chunk_${n}.json が無い`);
  log(`上げ先 ${PREFIX}/（法令 ${Object.keys(index).length} 件・チャンク ${chunkNums.size} 個・ファイル ${files.length}）${DRY ? '（dry-run）' : ''}`);

  const live = livePrefixes();
  if (live.has(PREFIX)) throw new Error(`${PREFIX} は公開中のプレフィックス（wrangler.toml / staging の DELEGATIONS_PREFIX かコード既定）。--force でも書かない。別の世代（例 delegations_v3）に上げて、設定で切り替える`);
  if (TRANSPORT !== 'api' && TRANSPORT !== 'wrangler') throw new Error(`--transport は api か wrangler（${TRANSPORT}）`);
  if (TRANSPORT === 'wrangler') {
    // 有無の確認 1 回 + 書き込み 1 回（--force なら退避の get/put でさらに 2 回）が鍵ごとに要る。REST API の共有上限（5 分 1,200 件）を
    // 食い潰さないよう、見込みの件数が上限を超える配信物は api（S3 互換・R2 クラス）に回す
    const est = files.length * (FORCE ? 4 : 2);
    if (est > WRANGLER_MAX_REQUESTS) throw new Error(`wrangler 経由は ${files.length} ファイル（見込み ${est} リクエスト）には使わない（上限 ${WRANGLER_MAX_REQUESTS}）。--transport api（CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN）で上げる`);
  }
  const r2 = TRANSPORT === 'api' ? new R2({ dryRun: DRY }) : wranglerClient();
  log(`通り道: ${TRANSPORT}${TRANSPORT === 'wrangler' ? `（${WRANGLER_CMD}。これから書く ${files.length} 鍵の有無を 1 つずつ見る）` : ''}`);
  // 既存の鍵は index.json の有無ではなく一覧で見る（前回が途中で失敗して index.json だけ無い状態でも黙って上書きしない）。
  // wrangler には一覧が無いので、これから書く鍵の有無を 1 つずつ見る（書かない鍵は上書きしないので、退避の対象もこれで足りる）
  let existingKeys;
  if (TRANSPORT === 'api') {
    existingKeys = (await r2.list(`${PREFIX}/`)).map((o) => (typeof o === 'string' ? o : o.key)).filter(Boolean);
  } else {
    existingKeys = [];
    for (const f of files) if ((await r2.get(`${PREFIX}/${f}`)) !== null) existingKeys.push(`${PREFIX}/${f}`);
  }
  if (existingKeys.length && !FORCE) throw new Error(`${PREFIX}/ に既に ${existingKeys.length} 件ある（${existingKeys.slice(0, 3).join(', ')}…）。別のプレフィックスにするか --force（全部退避してから上書き）`);
  // 退避先は実行ごとに一意に（同じ秒に 2 回 --force しても前の退避を潰さない）
  const rid = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + crypto.randomUUID().slice(0, 8);
  if (existingKeys.length) {
    log(`退避 ${existingKeys.length} 件 → ${CONFIG.backupPrefix}/${rid}/${PREFIX}/`);
    for (const k of existingKeys) { const b = await r2.get(k); if (b) await r2.put(`${CONFIG.backupPrefix}/${rid}/${k}`, b); }
  }
  // チャンクを先に、index.json を最後に（途中で止まっても読む側が壊れた索引を掴まない）
  for (const f of files.filter((x) => x !== 'index.json')) await r2.put(`${PREFIX}/${f}`, fs.readFileSync(path.join(DIST, f)));
  await r2.put(`${PREFIX}/index.json`, fs.readFileSync(path.join(DIST, 'index.json')));
  // 読み返して確認
  if (!DRY) {
    const back = await r2.getJson(`${PREFIX}/index.json`);
    if (!back || Object.keys(back).length !== Object.keys(index).length) throw new Error('上げた index.json を読み返せない');
  }
  log(`完了: ${PREFIX}/ に ${files.length} ファイル${DRY ? '（dry-run・書いていない）' : ''}。次: wrangler.staging.toml の DELEGATIONS_PREFIX を ${PREFIX} にして staging で確認`);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
