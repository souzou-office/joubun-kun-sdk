#!/usr/bin/env node
// 08_upload_r2.cjs を R2_FAKE_DIR（ディレクトリで R2 を模す）で検査する。¥0・ネットワークなし。
//
//   node scripts/delegation/check_upload_r2.cjs
//
// 見るもの: 初回は上がる / 途中で失敗した後（index.json だけ無い）の再実行は --force 無しで止まり既存を触らない /
//          --force は既存を全部退避してから書く / 公開中のプレフィックス（wrangler.toml の DELEGATIONS_PREFIX・コード既定 v1）には --force でも書かない /
//          wrangler 経由（--transport wrangler。wrangler をスタブに差し替え）でも同じ振る舞い
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-upload-'));
const REBUILD = path.join(ROOT, 'rebuild'), R2DIR = path.join(ROOT, 'r2'), WR = path.join(ROOT, 'wrangler');
const DIST = path.join(REBUILD, 'delegations', 'r2_dist');
fs.mkdirSync(DIST, { recursive: true }); fs.mkdirSync(R2DIR); fs.mkdirSync(WR);
fs.writeFileSync(path.join(DIST, 'index.json'), JSON.stringify({ '417AC0000000086': 0, '340AC0000000034': 1 }));
fs.writeFileSync(path.join(DIST, 'chunk_000.json'), JSON.stringify({ '417AC0000000086': { law_title: '会社法', articles: {} } }));
fs.writeFileSync(path.join(DIST, 'chunk_001.json'), JSON.stringify({ '340AC0000000034': { law_title: '法人税法', articles: {} } }));
fs.writeFileSync(path.join(WR, 'wrangler.toml'), '[vars]\nDELEGATIONS_PREFIX = "delegations_v1"\n');
fs.writeFileSync(path.join(WR, 'wrangler.staging.toml'), '[vars]\nDELEGATIONS_PREFIX = "delegations_v2"\n');   // staging が v2 を読んでいる想定

const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '08_upload_r2.cjs'), ...args], {
  env: { ...process.env, DELEG_REBUILD_DIR: REBUILD, R2_FAKE_DIR: R2DIR, WRANGLER_DIR: WR, UPDATE_DRY_RUN: '', CLOUDFLARE_ACCOUNT_ID: 'x', CLOUDFLARE_API_TOKEN: 'x' },
  encoding: 'utf8',
});
const files = (prefix) => { const d = path.join(R2DIR, ...prefix.split('/')); if (!fs.existsSync(d)) return []; const out = []; (function walk(p, rel) { for (const n of fs.readdirSync(p)) { const q = path.join(p, n); const k = rel ? rel + '/' + n : n; if (fs.statSync(q).isDirectory()) walk(q, k); else out.push(k); } })(d, ''); return out.sort(); };
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  → ' + detail}`); if (!ok) fails++; };

// 1. 初回
let r = run('--prefix', 'delegations_v3');
check('初回: 3 ファイルが上がる', r.status === 0 && files('delegations_v3').join() === 'chunk_000.json,chunk_001.json,index.json', r.stderr + r.stdout);

// 2. 途中失敗を模す（index.json だけ消す）→ --force 無しは止まり、既存のチャンクを触らない
fs.unlinkSync(path.join(R2DIR, 'delegations_v3', 'index.json'));
fs.writeFileSync(path.join(R2DIR, 'delegations_v3', 'chunk_000.json'), '{"old":true}');
r = run('--prefix', 'delegations_v3');
check('index.json が無くても既存の鍵があれば --force 無しで止まる', r.status !== 0 && /既に 2 件ある/.test(r.stderr + r.stdout), r.stderr + r.stdout);
check('止まったときは既存のチャンクを書き換えない', fs.readFileSync(path.join(R2DIR, 'delegations_v3', 'chunk_000.json'), 'utf8') === '{"old":true}');

// 3. --force は既存を全部退避してから書く
r = run('--prefix', 'delegations_v3', '--force');
const backups = files('backup_updates');
check('--force: 既存 2 件を backup_updates/ に退避してから上書き', r.status === 0 && backups.length === 2 && backups.every((k) => /\/delegations_v3\/chunk_00[01]\.json$/.test(k)) && files('delegations_v3').join() === 'chunk_000.json,chunk_001.json,index.json', `${r.stderr}${r.stdout} ${backups}`);
const bk = backups.find((k) => /chunk_000/.test(k));
check('退避した中身は上書き前のもの', bk && fs.readFileSync(path.join(R2DIR, 'backup_updates', ...bk.split('/')), 'utf8') === '{"old":true}');

// 4. 公開中のプレフィックスには --force でも書かない（wrangler.toml の v1、staging の v2、コード既定の v1）
for (const p of ['delegations_v1', 'delegations_v2']) {
  r = run('--prefix', p, '--force');
  check(`公開中の ${p} には --force でも書かない`, r.status !== 0 && /公開中のプレフィックス/.test(r.stderr + r.stdout) && files(p).length === 0, r.stderr + r.stdout);
}
// 4b. 続けて --force しても前の退避を潰さない（退避先が実行ごとに一意）
fs.writeFileSync(path.join(R2DIR, 'delegations_v3', 'chunk_000.json'), '{"old2":true}');
r = run('--prefix', 'delegations_v3', '--force');
const backups2 = files('backup_updates');
check('続けて --force: 退避が 2 世代分残る', r.status === 0 && backups2.length === 5 && backups2.some((k) => k !== bk && /chunk_000/.test(k) && fs.readFileSync(path.join(R2DIR, 'backup_updates', ...k.split('/')), 'utf8') === '{"old2":true}') && fs.readFileSync(path.join(R2DIR, 'backup_updates', ...bk.split('/')), 'utf8') === '{"old":true}', `${r.stderr}${r.stdout} ${backups2}`);
// 4c. wrangler.toml が読めなければ、公開中でないプレフィックスでも上げない
r = spawnSync(process.execPath, [path.join(__dirname, '08_upload_r2.cjs'), '--prefix', 'delegations_v5'], { env: { ...process.env, DELEG_REBUILD_DIR: REBUILD, R2_FAKE_DIR: R2DIR, WRANGLER_DIR: path.join(ROOT, 'nowhere'), UPDATE_DRY_RUN: '', CLOUDFLARE_ACCOUNT_ID: 'x', CLOUDFLARE_API_TOKEN: 'x' }, encoding: 'utf8' });
check('wrangler.toml が読めなければ止まる（書かない）', r.status !== 0 && /が読めない/.test(r.stderr + r.stdout) && files('delegations_v5').length === 0, r.stderr + r.stdout);
// 6. wrangler 経由（トークンの環境変数なし）。wrangler を Node のスタブに差し替えて get/put をディレクトリで模す
const STUB = path.join(ROOT, 'wrangler-stub.cjs'), WDIR = path.join(ROOT, 'wr2');
fs.mkdirSync(WDIR);
fs.writeFileSync(STUB, `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);   // r2 object get|put bucket/key --file F [--content-type T] --remote
if (a[0] !== 'r2' || a[1] !== 'object' || !a.includes('--remote')) { console.error('stub: unexpected args ' + a.join(' ')); process.exit(2); }
const key = a[3].replace(/^[^/]+\\//, ''); const file = a[a.indexOf('--file') + 1];
const p = path.join(${JSON.stringify(WDIR)}, ...key.split('/'));
if (a[2] === 'get') { if (!fs.existsSync(p)) { console.error('The specified key does not exist.'); process.exit(1); } fs.copyFileSync(p, file); process.exit(0); }
if (a[2] === 'put') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(file, p); process.exit(0); }
process.exit(2);
`);
const runW = (...a) => spawnSync(process.execPath, [path.join(__dirname, '08_upload_r2.cjs'), '--transport', 'wrangler', ...a], {
  env: { ...process.env, DELEG_REBUILD_DIR: REBUILD, WRANGLER_DIR: WR, WRANGLER_CMD: `${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)}`, R2_FAKE_DIR: '', CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '', R2_ACCOUNT_ID: '', R2_API_TOKEN: '', UPDATE_DRY_RUN: '' },
  encoding: 'utf8',
});
const wfiles = (prefix) => { const d = path.join(WDIR, ...prefix.split('/')); if (!fs.existsSync(d)) return []; const out = []; (function walk(p, rel) { for (const n of fs.readdirSync(p)) { const q = path.join(p, n); const k = rel ? rel + '/' + n : n; if (fs.statSync(q).isDirectory()) walk(q, k); else out.push(k); } })(d, ''); return out.sort(); };
r = runW('--prefix', 'delegations_v3');
check('wrangler: 初回は 3 ファイルが上がる（トークンの環境変数なし）', r.status === 0 && /通り道: wrangler/.test(r.stdout + r.stderr) && wfiles('delegations_v3').join() === 'chunk_000.json,chunk_001.json,index.json', r.stderr + r.stdout);
fs.unlinkSync(path.join(WDIR, 'delegations_v3', 'index.json'));
fs.writeFileSync(path.join(WDIR, 'delegations_v3', 'chunk_000.json'), '{"old":true}');
r = runW('--prefix', 'delegations_v3');
check('wrangler: index.json が無くても既存の鍵があれば止まり、書き換えない', r.status !== 0 && /既に 2 件ある/.test(r.stderr + r.stdout) && fs.readFileSync(path.join(WDIR, 'delegations_v3', 'chunk_000.json'), 'utf8') === '{"old":true}', r.stderr + r.stdout);
r = runW('--prefix', 'delegations_v3', '--force');
const wb = wfiles('backup_updates');
check('wrangler: --force は既存 2 件を退避してから上書き', r.status === 0 && wb.length === 2 && wb.some((k) => /chunk_000/.test(k) && fs.readFileSync(path.join(WDIR, 'backup_updates', ...k.split('/')), 'utf8') === '{"old":true}') && wfiles('delegations_v3').join() === 'chunk_000.json,chunk_001.json,index.json', `${r.stderr}${r.stdout} ${wb}`);
r = runW('--prefix', 'delegations_v1', '--force');
check('wrangler: 公開中の v1 には --force でも書かない', r.status !== 0 && /公開中のプレフィックス/.test(r.stderr + r.stdout) && wfiles('delegations_v1').length === 0, r.stderr + r.stdout);
r = runW('--prefix', 'delegations_v6', '--dry-run');
check('wrangler: --dry-run は書かない', r.status === 0 && wfiles('delegations_v6').length === 0, r.stderr + r.stdout);
// 6b. 取得の失敗は「無い」と決めつけない（認証エラーの出力に 404 や鍵名が混ざっていても止まる・書かない）
const STUB_FAIL = path.join(ROOT, 'wrangler-fail.cjs');
fs.writeFileSync(STUB_FAIL, `const a = process.argv.slice(2); if (a[2] === 'get') { console.error('Authentication error [code: 10000] while fetching ' + a[3] + ' (HTTP 404 not found from gateway)'); process.exit(1); } console.error('put must not be reached'); process.exit(3);`);
r = spawnSync(process.execPath, [path.join(__dirname, '08_upload_r2.cjs'), '--prefix', 'delegations_v10', '--transport', 'wrangler'], { env: { ...process.env, DELEG_REBUILD_DIR: REBUILD, WRANGLER_DIR: WR, WRANGLER_CMD: `${JSON.stringify(process.execPath)} ${JSON.stringify(STUB_FAIL)}` }, encoding: 'utf8' });
check('wrangler: 不存在の決まった文言でない失敗（認証エラーに 404 が混ざる）は止まり、put に進まない', r.status !== 0 && /無いとは判定できない/.test(r.stderr + r.stdout) && !/put must not be reached/.test(r.stderr + r.stdout), r.stderr + r.stdout);
r = spawnSync(process.execPath, [path.join(__dirname, '08_upload_r2.cjs'), '--prefix', 'delegations_v8', '--transport', 'wrangler'], { env: { ...process.env, DELEG_REBUILD_DIR: REBUILD, WRANGLER_DIR: WR, WRANGLER_CMD: `${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)}`, WRANGLER_MAX_REQUESTS: '4' }, encoding: 'utf8' });
check('wrangler: 見込みリクエスト数が上限を超えたら止まり api に誘導（書かない）', r.status !== 0 && /--transport api/.test(r.stderr + r.stdout) && wfiles('delegations_v8').length === 0, r.stderr + r.stdout);
r = spawnSync(process.execPath, [path.join(__dirname, '08_upload_r2.cjs'), '--prefix', 'delegations_v9'], { env: { ...process.env, DELEG_REBUILD_DIR: REBUILD, WRANGLER_DIR: WR, WRANGLER_CMD: 'false', R2_FAKE_DIR: '', CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '', R2_ACCOUNT_ID: '', R2_API_TOKEN: '' }, encoding: 'utf8' });
check('--transport 未指定は api（トークンが無ければ wrangler に落ちず、認証で止まる）', r.status !== 0 && !/通り道: wrangler/.test(r.stderr + r.stdout) && wfiles('delegations_v9').length === 0, r.stderr + r.stdout);
r = spawnSync(process.execPath, [path.join(__dirname, '08_upload_r2.cjs'), '--prefix', 'delegations_v7', '--transport', 'ftp'], { env: { ...process.env, DELEG_REBUILD_DIR: REBUILD, WRANGLER_DIR: WR }, encoding: 'utf8' });
check('不明な --transport は止まる', r.status !== 0 && /--transport は/.test(r.stderr + r.stdout));

// 5. dry-run は何も書かない
r = run('--prefix', 'delegations_v4', '--dry-run');
check('--dry-run は書かない', r.status === 0 && files('delegations_v4').length === 0, r.stderr + r.stdout);

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(fails ? `\n${fails} 件失敗` : '\nすべて通過');
process.exit(fails ? 1 : 0);
