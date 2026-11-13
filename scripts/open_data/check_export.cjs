#!/usr/bin/env node
// 公開データの書き出し（export.cjs）の確かめ。¥0・本番に触らない・固定データだけ。
//   node scripts/open_data/check_export.cjs
// 手元のディレクトリを本番（R2_FAKE_DIR）と公開用のバケット（OPEN_DATA_FAKE_DIR）に見立てて流し、次を見る:
//   - 本則の条にだけ article_id が付く（附則・別表・同じ見出しの 2 つ目には付かない）・ベクトル化用の文を出さない
//   - refs の to_article_id・委任の受け皿の article_id・告示の未収録箇所（ID が版をまたいで同じ）
//   - MANIFEST の件数とハッシュ・latest.json は最後に書く・本番には 1 つも書かない
//   - 前の版より 5% 超減ったら書く前に止まる・--force-shrink で通る・古い版は 3 つだけ残す
//   - 書く先が本番のバケットと同じなら止まる
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const EXPORT = path.join(__dirname, 'export.cjs');
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { failed++; console.log('  NG  ', msg); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-data-check-'));
const SRC = path.join(tmp, 'src'), DEST = path.join(tmp, 'dest'), OUT = path.join(tmp, 'out');
const put = (root, key, obj) => { const p = path.join(root, ...key.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const A = 'large_law_articles_v4', R = 'refs_chunks_v5', D = 'delegations_v6';
const L1 = '999AC0000000001', L2 = '999CO0000000002';

function seed({ dropArticles = false } = {}) {
  fs.rmSync(SRC, { recursive: true, force: true });
  put(SRC, 'update_state/sync_state.json', { fetched_at: '2026-10-12T00:00:00+09:00', total_count: 2, laws: {
    [L1]: { law_revision_id: `${L1}_20260401_506AC0000000099`, law_title: '検査法', law_type: 'Act', law_num: '令和八年法律第一号', revision_status: 'CurrentEnforced', abbrev: '検法', category: '民事' },
    [L2]: { law_revision_id: `${L2}_20260401_000000000000000`, law_title: '検査法施行令', law_type: 'CabinetOrder', law_num: '令和八年政令第一号', revision_status: 'CurrentEnforced' },
  } });
  const para = (t) => [{ num: '1', sentences: [{ num: '1', text: t }] }];
  const art = (title, extra = {}) => ({ type: 'article', number: '', title, caption: '', structure: {}, paragraphs: para(`${title}の本文`), full_text: `${title}の本文`, embedding_text: 'ベクトル化用の文', ...extra });
  const files1 = [
    { title: '第一条', filename: '第一条.json', arts: [art('第一条', { caption: '（目的）' }), art('第一条', { structure: { suppl: true, amend_law_num: '' } })] },
    { title: '第二条', filename: '第二条.json', arts: [art('第二条')] },
    { title: '第三条の二', filename: '第三条の二.json', arts: [art('第三条の二'), art('第三条の二', { caption: '（重複）' })] },
    { title: '別表第一', filename: '別表第一.json', arts: [{ ...art('別表第一'), type: 'appdx_table' }] },
  ];
  const files = dropArticles ? files1.slice(0, 1) : files1;
  put(SRC, `${A}/${L1}/_index.json`, { law_id: L1, law_title: '検査法', law_num: '令和八年法律第一号', law_type: 'Act', article_count: 6, files: files.map(({ arts, ...f }) => f), toc: [] });
  for (const f of files) put(SRC, `${A}/${L1}/${f.filename}`, { law_id: L1, law_title: '検査法', articles: f.arts });
  put(SRC, `${A}/${L2}/_index.json`, { law_id: L2, law_title: '検査法施行令', article_count: 1, files: [{ title: '第一条', filename: '第一条.json' }], toc: [] });
  put(SRC, `${A}/${L2}/第一条.json`, { law_id: L2, law_title: '検査法施行令', articles: [art('第一条')] });
  put(SRC, `${R}/refs_index.json`, { [L1]: 0, [L2]: 0 });
  put(SRC, `${R}/refs_chunk_000.json`, {
    [L1]: { refs: { [`${L1}_Art2`]: [{ paragraph: '1', item: null, sentence_index: 1, start: 0, end: 3, type: 'internal', target_article: '1' }, { paragraph: '1', type: 'external', target_law_id: L2, target_article: '1' }] }, reverse_refs: {} },
    [L2]: { refs: {}, reverse_refs: {} },
  });
  put(SRC, `${D}/index.json`, { [L1]: 0 });
  put(SRC, `${D}/chunk_000.json`, { [L1]: { law_title: '検査法', count: 2, articles: {
    '2': [{ paragraph: '1', item: null, expr: '政令で定める', kind: 'seirei', status: 'confirmed', candidates: [{ law_id: L2, article: '1', strength: 'strong' }] }],
    '3_2': [{ paragraph: '2', item: '1', expr: '国土交通大臣が定める', trailing: '基準', kind: 'kokuji', status: 'kokuji', candidates: [] }],
  } } });
  // 紐付け（条 → 通達・質疑応答事例・裁決・判例）。本文（body）は書き出さない
  put(SRC, 'tsutatsu_chunks_v4/index.json', { laws: { [L1]: { articles: 1 } } });
  put(SRC, `tsutatsu_chunks_v4/${L1}.json`, { '2': [{ src: 'html', no: '2-1', cap: '（意義）', grp: 'kihon/test', url: 'https://www.nta.go.jp/law/tsutatsu/kihon/test/02.htm', body: '通達の本文' }, { src: 'pdf', title: '個別通達', url: 'https://example.com/evil.pdf', ab: 1 }], 'bad-key': [{ no: 'x' }] });
  put(SRC, 'article_links_v1/_cases.json', { j1: { t: '事例の題名', u: 'https://www.nta.go.jp/law/shitsugi/x.htm', d: '' }, s1: { t: '裁決の題名', u: 'https://www.kfs.go.jp/service/JP/1/index.html', d: '令和5年3月1日' } });
  put(SRC, `article_links_v1/${L1}.json`, { '3の2': [{ i: 'j1', k: 'j', s: 'body', c: 0.9 }, { i: 's1', k: 's', s: 'llm', c: 0.5 }, { i: 'missing', k: 'j' }] });
  put(SRC, 'hanrei_v2/index.json', { v: 1 });
  put(SRC, `hanrei_v2/links/${L1}.json`, { '1': { total: 2, items: [{ id: '90001', title: '損害賠償請求事件', court: '最高裁判所', dateJp: '令和4年1月1日', caseNo: '令和3(受)100', kekka: '棄却', url: 'https://www.courts.go.jp/hanrei/90001/detail2/index.html', youshi: '要旨は出さない' }] } });
  // 300 件を超える条の 301 件目からの続き（上位の続き。上位にある判例は入っていない）
  put(SRC, `hanrei_v2/links_more/${L1}/1.json`, { total: 2, items: [
    { id: '90002', title: '旧法の事件', court: '東京地方裁判所', dateJp: '平成2年2月2日', url: 'https://www.courts.go.jp/hanrei/90002/detail2/index.html', via: { law: '旧検査法', art: '9', old: true }, notes: [{ k: 'amended', d: '2001-04-01' }], judge: { by: 'opus', reason: '今の条にも通用する' } },
  ] });
}

function run(args, env = {}) {
  return execFileSync(process.execPath, [EXPORT, ...args], { env: { ...process.env, R2_FAKE_DIR: SRC, OPEN_DATA_FAKE_DIR: DEST, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function runFail(args, env = {}) { try { run(args, env); return null; } catch (e) { return String(e.stderr || e.stdout || e.message); } }
const readGz = (p) => zlib.gunzipSync(fs.readFileSync(p)).toString('utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const snapshot = (root) => { const out = {}; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(root, p)] = fs.readFileSync(p).toString('base64'); } }; walk(root); return JSON.stringify(out); };

console.log('0. 週次の反映の途中なら書き出さない');
seed();
for (const k of ['update_state/laws_apply_inprogress.json', 'update_state/delegations_apply_inprogress.json', 'update_state/tsutatsu_apply_inprogress.json', 'update_state/cases_apply_inprogress.json', 'update_state/hanrei_apply_inprogress.json']) {
  const p = path.join(SRC, k);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{"mode":"apply"}');
  const err = runFail(['--out', OUT, '--release', '2026-10-31']);
  ok(!!err && err.includes('反映の途中'), `${k} があれば止める`);
  fs.unlinkSync(p);
}
// 書き出しの途中で反映があった（台帳が書き換わった）ら版にしない・MANIFEST を書かない（GPT レビュー #415）
{
  const err = runFail(['--out', OUT, '--release', '2026-10-30'], { OPEN_DATA_TEST_TOUCH: 'update_state/sync_state.json' });
  ok(!!err && err.includes('書き出しの間に元のデータが変わった') && !fs.existsSync(path.join(OUT, 'releases', '2026-10-30', 'MANIFEST.json')), '書き出しの途中で台帳が変わったら止め、MANIFEST を書かない');
  seed();
}

console.log('1. 1 回目の版');
seed();
const before = snapshot(SRC);
run(['--out', OUT, '--upload', '--release', '2026-11-01']);
ok(snapshot(SRC) === before, '本番（R2_FAKE_DIR）に 1 つも書いていない');
const rel = path.join(DEST, 'releases', '2026-11-01');
const arts = readGz(path.join(rel, 'articles.jsonl.gz'));
const ids = arts.map((a) => a.article_id);
ok(arts.length === 7, `条は 7 件（${arts.length}）`);
ok(ids.filter(Boolean).sort().join(',') === [`${L1}_Art1`, `${L1}_Art2`, `${L1}_Art3_2`, `${L2}_Art1`].sort().join(','), '本則の条にだけ article_id（附則・別表・同じ見出しの 2 つ目は null）');
ok(arts.every((a) => !('embedding_text' in a)), 'ベクトル化用の文を出さない');
ok(arts.find((a) => a.article_id === `${L1}_Art3_2`).page_url === `https://joubun-kun.com/law/${L1}/3-2`, '条文ページの URL（3-2）');
ok(arts.filter((a) => a.provision === 'suppl').length === 1, '附則の条は provision: suppl');
const laws = readGz(path.join(rel, 'laws.jsonl.gz'));
ok(laws.length === 2 && laws[0].law_id === L1 && laws[0].law_revision_id && laws[0].main_article_count === 3, '法令 2 本・台帳の書誌・本則の条の数');
const refs = readGz(path.join(rel, 'refs.jsonl.gz'));
ok(refs.length === 2 && refs[0].to_article_id === `${L1}_Art1` && refs[1].to_article_id === `${L2}_Art1`, 'refs の行き先 ID（同じ法令の中・他の法令）');
const deleg = readGz(path.join(rel, 'delegations.jsonl.gz'));
ok(deleg.length === 2 && deleg[0].candidates[0].article_id === `${L2}_Art1`, '委任の受け皿に article_id');
const gaps = readGz(path.join(rel, 'kokuji_gaps.jsonl.gz'));
ok(gaps.length === 1 && gaps[0].from_article_id === `${L1}_Art3_2` && gaps[0].article_title === '第三条の二' && gaps[0].page_url.endsWith('/3-2'), '告示の未収録箇所（委任元・見出し・条文ページ）');
const manifest = JSON.parse(fs.readFileSync(path.join(rel, 'MANIFEST.json'), 'utf8'));
const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(rel, 'refs.jsonl.gz'))).digest('hex');
ok(manifest.files.refs.records === 2 && manifest.files.refs.sha256 === sha && manifest.license === 'CC-BY-4.0', 'MANIFEST の件数・ハッシュ・ライセンス');
ok(JSON.parse(fs.readFileSync(path.join(DEST, 'latest.json'), 'utf8')).release === '2026-11-01', 'latest.json が新しい版を指す');

{
  const links = readGz(path.join(rel, 'links.jsonl.gz'));
  const by = (k) => links.filter((x) => x.kind === k);
  ok(links.length === 6 && manifest.files.links.records === 6, `紐付けは 6 件（通達 2・事例 1・裁決 1・判例 2。${links.length}）`);
  ok(by('tsutatsu')[0].article_id === `${L1}_Art2` && by('tsutatsu')[0].title === '2-1（意義）' && by('tsutatsu')[0].url.startsWith('https://www.nta.go.jp/') && by('tsutatsu')[1].url === null && by('tsutatsu')[1].abolished === true, '通達: 条の ID・題名（番号＋見出し）・国税庁の URL だけ・廃止の印');
  ok(links.every((x) => !('body' in x) && !JSON.stringify(x).includes('通達の本文') && !JSON.stringify(x).includes('要旨は出さない')), '本文（通達の本文・判決の要旨）は出さない');
  ok(by('shitsugi')[0].article_id === `${L1}_Art3_2` && by('shitsugi')[0].method === 'rule' && by('saiketsu')[0].method === 'llm' && by('saiketsu')[0].date === '令和5年3月1日' && by('shitsugi')[0].page_url.endsWith('/3-2'), '事例・裁決: 条のキー（3の2 → Art3_2）・付け方（rule / llm）・日付');
  const h2 = by('hanrei').find((x) => x.source_id === '90002');
  ok(by('hanrei').length === 2 && h2 && h2.cited_as.law === '旧検査法' && h2.method === 'llm' && h2.ai_reason === '今の条にも通用する' && h2.notes.length === 1, '判例: 上位と続き（links_more）を合わせて全部・判決文での引き方・注記・AI の理由');
  ok(manifest.notes.links && manifest.notes.links.badKey === 1 && manifest.notes.links.badShape === 1 && manifest.sources.hanrei && manifest.sources.lineage, '形の違うキー・壊れた行は数えて飛ばす・出典に裁判所と名古屋大学のデータ');
}

{
  // 続き（links_more）が無い・形が違う・合わせても total に届かないときは、一部だけを出さずに止める（GPT レビュー #418）
  const mk = path.join(SRC, 'hanrei_v2', 'links_more', L1, '1.json');
  const keep = fs.readFileSync(mk, 'utf8');
  fs.unlinkSync(mk);
  ok((runFail(['--out', OUT, '--release', '2026-10-29']) || '').includes('links_more'), '判例の続きのファイルが無ければ止める');
  fs.writeFileSync(mk, '{"items":"x"}');
  ok((runFail(['--out', OUT, '--release', '2026-10-29']) || '').includes('形が違う'), '続きの形が違えば止める');
  fs.writeFileSync(mk, JSON.stringify({ total: 2, items: [{ id: '90001' }] }));
  ok((runFail(['--out', OUT, '--release', '2026-10-29']) || '').includes('届かない'), '上位と続きを合わせても total に届かなければ止める（同じ id は 1 件に数える）');
  fs.writeFileSync(mk, keep);
}

{
  // R2 に目次があるのに台帳に無い法令（廃止された法令など）は、法令・条・参照・委任・紐付けのどれにも入れず、ID をログと MANIFEST に出す
  const L3 = '999AC0000000003';
  const rp = (k) => path.join(SRC, k);
  const keepFiles = [`${R}/refs_index.json`, `${R}/refs_chunk_000.json`, `${D}/index.json`, `${D}/chunk_000.json`, 'tsutatsu_chunks_v4/index.json'].map((k) => [k, fs.readFileSync(rp(k), 'utf8')]);
  const edit = (k, f) => { const o = JSON.parse(fs.readFileSync(rp(k), 'utf8')); f(o); fs.writeFileSync(rp(k), JSON.stringify(o)); };
  put(SRC, `${A}/${L3}/_index.json`, { law_id: L3, law_title: '廃止された法', files: [{ title: '第一条', filename: '第一条.json' }], toc: [] });
  put(SRC, `${A}/${L3}/第一条.json`, { law_id: L3, law_title: '廃止された法', articles: [{ type: 'article', number: '', title: '第一条', caption: '', structure: {}, paragraphs: [], full_text: '本文' }] });
  edit(`${R}/refs_index.json`, (o) => { o[L3] = 0; });
  edit(`${R}/refs_chunk_000.json`, (o) => { o[L3] = { refs: { [`${L3}_Art1`]: [{ paragraph: '1', type: 'external', target_law_id: L2, target_article: '1' }] }, reverse_refs: {} };
    o[L1].refs[`${L1}_Art2`].push({ paragraph: '1', type: 'external', target_law_id: L3, target_article: '1' }); });
  edit(`${D}/index.json`, (o) => { o[L3] = 0; });
  edit(`${D}/chunk_000.json`, (o) => { o[L3] = { law_title: '廃止された法', count: 1, articles: { '1': [{ paragraph: '1', item: null, expr: '政令で定める', kind: 'seirei', status: 'confirmed', candidates: [] }] } }; });
  edit('tsutatsu_chunks_v4/index.json', (o) => { o.laws[L3] = { articles: 1 }; });
  put(SRC, `tsutatsu_chunks_v4/${L3}.json`, { '1': [{ src: 'html', no: '1-1', cap: '（廃止）', grp: 'kihon/test', url: 'https://www.nta.go.jp/law/tsutatsu/kihon/test/01.htm' }] });
  const lg = run(['--out', OUT, '--release', '2026-10-20']);
  const r20 = path.join(OUT, 'releases', '2026-10-20');
  const mf = JSON.parse(fs.readFileSync(path.join(r20, 'MANIFEST.json'), 'utf8'));
  const has3 = (name, f) => readGz(path.join(r20, `${name}.jsonl.gz`)).some(f);
  ok(lg.includes(`台帳に無い法令（廃止など・公開データから外した） 1: ${L3}`) && JSON.stringify(mf.notes.notInLedger) === JSON.stringify([L3]), '台帳に無い法令の ID をログと MANIFEST に出す');
  ok(!has3('laws', (x) => x.law_id === L3) && !has3('articles', (x) => x.law_id === L3) && !has3('refs', (x) => x.from_law_id === L3)
    && !has3('delegations', (x) => x.law_id === L3) && !has3('links', (x) => x.law_id === L3), '台帳に無い法令は法令・条・参照・委任・紐付けのどれにも入れない');
  ok(mf.notes.refs_to_not_in_ledger === 1 && has3('refs', (x) => x.from_law_id === L1 && x.to_law_id === L3), '今の法令から台帳に無い法令への参照は残し、数を MANIFEST に出す');
  fs.rmSync(path.join(SRC, A, L3), { recursive: true, force: true });
  fs.rmSync(rp(`tsutatsu_chunks_v4/${L3}.json`), { force: true });
  for (const [k, t] of keepFiles) fs.writeFileSync(rp(k), t);
  // 台帳が古い・壊れていて大量に台帳に無いときは止める（100 本かつ 5% 超）
  const many = [];
  for (let i = 0; i < 101; i++) { const id = `998AC${String(i).padStart(10, '0')}`; many.push(id); put(SRC, `${A}/${id}/_index.json`, { law_id: id, files: [], toc: [] }); }
  let stopped = false;
  try { run(['--out', OUT, '--release', '2026-10-20.5']); } catch (e) { stopped = /台帳に無い（100 本かつ 5% 超）/.test(String(e.stderr || e.message)); }
  ok(stopped && !fs.existsSync(path.join(OUT, 'releases', '2026-10-20.5', 'MANIFEST.json')), '台帳に無い法令が多すぎるときは書き出さない（台帳が古い・壊れている）');
  for (const id of many) fs.rmSync(path.join(SRC, A, id), { recursive: true, force: true });
}

console.log('1b. 台帳の改正 ID が前の版と同じ法令は、R2 を読まずに前の版の行を使い回す（--prev）');
{
  const prevDir = rel;   // 1 回目の版（MANIFEST・laws・articles がある）
  const outOf = (r) => path.join(OUT, 'releases', r);
  const textOf = (r, id) => (readGz(path.join(outOf(r), 'articles.jsonl.gz')).find((x) => x.article_id === id) || {}).full_text;
  const log0 = run(['--out', OUT, '--release', '2026-10-21', '--prev', prevDir]);
  const same = ['laws', 'articles'].every((k) => JSON.stringify(readGz(path.join(outOf('2026-10-21'), `${k}.jsonl.gz`))) === JSON.stringify(readGz(path.join(rel, `${k}.jsonl.gz`))));
  ok(/前の版から使い回した法令 2/.test(log0) && same, '何も変わっていなければ全部使い回し、全部読んだ版と中身が同じ');
  ok(JSON.parse(fs.readFileSync(path.join(outOf('2026-10-21'), 'MANIFEST.json'), 'utf8')).build.prev_release === '2026-11-01', 'MANIFEST に使い回した前の版を書く');
  // 改正 ID が変わらないまま R2 の条文だけ変わった（ファイルの指紋で気づいて読み直す）。--full も読み直す
  const f2 = path.join(SRC, A, L1, '第二条.json');
  const keep2 = fs.readFileSync(f2, 'utf8');
  fs.writeFileSync(f2, keep2.replace(/第二条の本文/g, '第二条の新しい本文'));
  run(['--out', OUT, '--release', '2026-10-22', '--prev', prevDir]);
  ok(textOf('2026-10-22', `${L1}_Art2`) === '第二条の新しい本文', '改正 ID が同じでも、R2 のファイルが書き換わった（指紋が違う）法令は読み直す');
  const logF = run(['--out', OUT, '--release', '2026-10-23', '--prev', prevDir, '--full']);
  ok(/--full/.test(logF) && textOf('2026-10-23', `${L1}_Art2`) === '第二条の新しい本文', '--full なら前の版を使わずに全部読む');
  // 台帳の改正 ID が変わった法令だけ読み直す
  const ledgerPath = path.join(SRC, 'update_state', 'sync_state.json');
  const ledger0 = fs.readFileSync(ledgerPath, 'utf8');
  const led = JSON.parse(ledger0); led.laws[L1].law_revision_id = `${L1}_20261101_507AC0000000001`; fs.writeFileSync(ledgerPath, JSON.stringify(led));
  const log1 = run(['--out', OUT, '--release', '2026-10-24', '--prev', prevDir]);
  const laws1 = readGz(path.join(outOf('2026-10-24'), 'laws.jsonl.gz'));
  ok(/R2 から読んだ法令 1・前の版から使い回した法令 1/.test(log1) && textOf('2026-10-24', `${L1}_Art2`) === '第二条の新しい本文' && laws1.find((x) => x.law_id === L1).law_revision_id.endsWith('507AC0000000001'), '改正 ID が変わった法令だけ R2 から読み直す');
  // 改正 ID は同じでも、施行の状態が変わった（未施行 → 施行済み）法令は読み直す
  const led2 = JSON.parse(ledger0); led2.laws[L1].revision_status = 'UnEnforced'; fs.writeFileSync(ledgerPath, JSON.stringify(led2));
  ok(/R2 から読んだ法令 1・前の版から使い回した法令 1/.test(run(['--out', OUT, '--release', '2026-10-26', '--prev', prevDir])), '施行の状態が変わった法令は改正 ID が同じでも読み直す');
  fs.writeFileSync(ledgerPath, ledger0);
  // 行の形の版が違う前の版は使わない
  const shp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-data-prev-'));
  for (const n of ['laws.jsonl.gz', 'articles.jsonl.gz']) fs.copyFileSync(path.join(prevDir, n), path.join(shp, n));
  const mf = JSON.parse(fs.readFileSync(path.join(prevDir, 'MANIFEST.json'), 'utf8')); mf.build.row_shape = 0; fs.writeFileSync(path.join(shp, 'MANIFEST.json'), JSON.stringify(mf));
  ok(/行の形の版が違う/.test(run(['--out', OUT, '--release', '2026-10-27', '--prev', shp])), '行の形の版が違う前の版は使わずに全部読む');
  // 前の版のファイルが MANIFEST と違えば（壊れた・途中で切れた）使わない
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'open-data-prev-'));
  for (const n of ['MANIFEST.json', 'laws.jsonl.gz', 'articles.jsonl.gz']) fs.copyFileSync(path.join(prevDir, n), path.join(bad, n));
  fs.writeFileSync(path.join(bad, 'laws.jsonl.gz'), zlib.gzipSync('{"law_id":"x"}\n'));
  ok(/sha256 が MANIFEST と違う/.test(run(['--out', OUT, '--release', '2026-10-25', '--prev', bad])), '前の版のファイルが MANIFEST と違えば使わずに全部読む');
  fs.writeFileSync(f2, keep2); fs.writeFileSync(ledgerPath, ledger0);
}

console.log('2. 同じ委任には次の版でも同じ未収録箇所の ID');
run(['--out', OUT, '--upload', '--release', '2026-11-02']);
const gaps2 = readGz(path.join(DEST, 'releases', '2026-11-02', 'kokuji_gaps.jsonl.gz'));
ok(gaps2[0].gap_id === gaps[0].gap_id && /^kg_[0-9a-f]{12}$/.test(gaps[0].gap_id), `未収録箇所の ID が同じ（${gaps[0].gap_id}）`);

{
  // --write-check: 公開用のバケットに書けるかだけ確かめる（書いて読み直し、消す。版のファイルには触らない）
  const before = fs.readdirSync(DEST).sort().join(',');
  const outw = run(['--write-check']);
  const wc = path.join(DEST, '_write_check');
  ok(/書ける: .*読み直し、消した/.test(outw) && (!fs.existsSync(wc) || fs.readdirSync(wc).length === 0), '--write-check は書いて読み直し、消す（残さない）');
  ok(fs.readdirSync(DEST).filter((n) => n !== '_write_check').sort().join(',') === before.split(',').filter((n) => n && n !== '_write_check').join(','), '--write-check は版のファイルに触らない');
  ok(/本番のバケットと同じ/.test(runFail(['--write-check'], { OPEN_DATA_FAKE_DIR: '', OPEN_DATA_BUCKET: 'joubun-kun-data', CLOUDFLARE_ACCOUNT_ID: 'x', CLOUDFLARE_API_TOKEN: 'y' }) || ''), '--write-check も書く先が本番のバケットなら止まる');
}
console.log('3. 件数が 5% 超減ったら書く前に止まる');
seed({ dropArticles: true });
const err = runFail(['--out', OUT, '--upload', '--release', '2026-11-03']);
ok(err && /5% 超減った/.test(err), '止まった');
ok(!fs.existsSync(path.join(DEST, 'releases', '2026-11-03')), '止まった版は公開用のバケットに無い');
ok(JSON.parse(fs.readFileSync(path.join(DEST, 'latest.json'), 'utf8')).release === '2026-11-02', 'latest.json は前の版のまま');
run(['--out', OUT, '--upload', '--release', '2026-11-03', '--force-shrink']);
ok(JSON.parse(fs.readFileSync(path.join(DEST, 'latest.json'), 'utf8')).release === '2026-11-03', '--force-shrink で通る');

console.log('4. 古い版は 3 つだけ残す');
seed({ dropArticles: true });
run(['--out', OUT, '--upload', '--release', '2026-11-04']);
const vers = fs.readdirSync(path.join(DEST, 'releases')).filter((v) => fs.readdirSync(path.join(DEST, 'releases', v)).length).sort();   // 手元の見立てでは消した版の空のディレクトリが残る
ok(vers.join(',') === '2026-11-02,2026-11-03,2026-11-04', `残った版: ${vers.join(',')}`);

console.log('4b. 公開済みの版を上書きしない・latest の版は消さない・途中で落ちた版');
seed({ dropArticles: true });
const latestNow = () => JSON.parse(fs.readFileSync(path.join(DEST, 'latest.json'), 'utf8')).release;
const snapDest = snapshot(DEST);
ok(/今の版（2026-11-04）より新しくする/.test(runFail(['--out', OUT, '--upload', '--release', '2026-11-04']) || ''), '同じ版名で流し直すと止まる（上書きしない）');
ok(/より新しくする/.test(runFail(['--out', OUT, '--upload', '--release', '2026-10-01']) || ''), '古い日付の版名も止まる（自分の版を消さない）');
ok(snapshot(DEST) === snapDest, '止まったときは公開用のバケットを 1 つも書き換えない');
put(DEST, 'releases/2026-11-05/_writing.json', { started_at: 'x' });   // 途中で落ちた版の印
put(DEST, 'releases/2026-11-05/laws.jsonl.gz', 'half');
ok(/途中で落ちた書き出しが使った/.test(runFail(['--out', OUT, '--upload', '--release', '2026-11-05']) || ''), '途中で落ちた版名には書かない');
ok(!fs.existsSync(path.join(DEST, '_export_lock.json')), '止まってもバケット全体の印は外す');
run(['--out', OUT, '--upload', '--release', '2026-11-05.2']);
ok(latestNow() === '2026-11-05.2' && !fs.existsSync(path.join(DEST, 'releases', '2026-11-05.2', '_writing.json')), '別の版名（.2）なら書ける・書き終わったら印を消す');
const vers2 = fs.readdirSync(path.join(DEST, 'releases')).filter((v) => fs.readdirSync(path.join(DEST, 'releases', v)).length).sort();
ok(vers2.join(',') === '2026-11-03,2026-11-04,2026-11-05.2', `途中で落ちた古い版は消し、書き終わった版を 3 つ残す（${vers2.join(',')}）`);
run(['--out', OUT, '--upload', '--release', '2026-11-06', '--force-shrink']);
ok(fs.existsSync(path.join(DEST, 'releases', '2026-11-06', 'MANIFEST.json')) && latestNow() === '2026-11-06', '次の版を書ける');

console.log('4b2. バケット全体の印（違う版名で同時に流さない）');
put(DEST, '_export_lock.json', { release: '2026-11-08', started_at: 'x' });   // ほかの書き出しが書いている途中
const lockSnap = snapshot(DEST);
ok(/ほかの書き出しが公開用のバケットに書いている（2026-11-08/.test(runFail(['--out', OUT, '--upload', '--release', '2026-11-09', '--force-shrink']) || ''), 'ほかの書き出しが印を持っていれば止まる');
ok(snapshot(DEST) === lockSnap, '止まったときは何も書かない（書いている途中の版も消さない）');
run(['--out', OUT, '--upload', '--release', '2026-11-09', '--force-shrink', '--break-lock']);
ok(latestNow() === '2026-11-09' && !fs.existsSync(path.join(DEST, '_export_lock.json')), '--break-lock で外して流し直せる・終わったら印を外す');

console.log('4b3. 同じ日の連番は数で比べる（.9 の次は .10）');
{
  const { compareRelease } = require('./export.cjs');
  const sorted = ['2026-11-02.10', '2026-11-03', '2026-11-02', '2026-11-02.9', '2026-11-02.2'].sort(compareRelease);
  ok(sorted.join(',') === '2026-11-02,2026-11-02.2,2026-11-02.9,2026-11-02.10,2026-11-03', `並び: ${sorted.join(',')}`);
  run(['--out', OUT, '--upload', '--release', '2026-11-09.9', '--force-shrink']);
  run(['--out', OUT, '--upload', '--release', '2026-11-09.10', '--force-shrink']);
  ok(latestNow() === '2026-11-09.10', '.9 の次に .10 を公開できる');
  ok(/より新しくする/.test(runFail(['--out', OUT, '--upload', '--release', '2026-11-09.2']) || ''), '.10 の後に .2 は受け付けない');
  const kept = fs.readdirSync(path.join(DEST, 'releases')).filter((v) => fs.readdirSync(path.join(DEST, 'releases', v)).length).sort(compareRelease);
  ok(kept.join(',') === '2026-11-09,2026-11-09.9,2026-11-09.10', `残す版も数の順（${kept.join(',')}）`);
}

console.log('4c. 前の版が読めないときは止まる（初回扱いにしない）');
const keepLatest = fs.readFileSync(path.join(DEST, 'latest.json'));
fs.writeFileSync(path.join(DEST, 'latest.json'), '{壊れた');
ok(/latest.json が壊れている/.test(runFail(['--out', OUT, '--upload', '--release', '2026-11-10']) || ''), 'latest.json が壊れていたら止まる');
fs.writeFileSync(path.join(DEST, 'latest.json'), JSON.stringify({ release: '2026-01-01' }));
ok(/MANIFEST が無い・壊れている/.test(runFail(['--out', OUT, '--upload', '--release', '2026-11-10']) || ''), 'latest が指す版の MANIFEST が無ければ止まる');
ok(!fs.existsSync(path.join(DEST, '_export_lock.json')), '前の版が読めずに止まっても印は外す');
fs.writeFileSync(path.join(DEST, 'latest.json'), keepLatest);

console.log('4d. 目次に載った条文ファイルが無いときは書き出さない');
put(SRC, `${A}/${L1}/_index.json`, { law_id: L1, law_title: '検査法', files: [{ title: '第一条', filename: '第一条.json' }, { title: '第九条', filename: '第九条.json' }], toc: [] });
ok(/条文ファイルが 1 件読めない・無い: 999AC0000000001\/第九条.json/.test(runFail(['--out', OUT, '--release', '2026-12-02']) || ''), '止まって、どのファイルかを出す');
run(['--out', OUT, '--release', '2026-12-02'], { OPEN_DATA_ALLOW_MISSING: `${L1}/第九条.json` });
ok(JSON.parse(fs.readFileSync(path.join(OUT, 'releases', '2026-12-02', 'MANIFEST.json'), 'utf8')).notes.allowedMissing === 1, '元から壊れていると書いたものだけ通す（数は MANIFEST に残る）');
seed();
fs.writeFileSync(path.join(SRC, A, L2, '_index.json'), '{"law_id":"x"}');   // 一覧にある目次の files が無い
ok(/999CO0000000002\/_index.json（無い・形が違う）/.test(runFail(['--out', OUT, '--release', '2026-12-03']) || ''), '壊れた目次の法令を丸ごと省いて公開しない');
run(['--out', OUT, '--release', '2026-12-03'], { OPEN_DATA_ALLOW_MISSING: `${L2}/_index.json` });
ok(readGz(path.join(OUT, 'releases', '2026-12-03', 'laws.jsonl.gz')).length === 1, '目次も元から壊れていると書けば通す（その法令は入らない）');

console.log('5. 書く先の取り違え・試し用の引数');
seed({ dropArticles: true });
ok(/本番のバケットと同じ/.test(runFail(['--out', OUT, '--upload'], { OPEN_DATA_FAKE_DIR: '', OPEN_DATA_BUCKET: 'joubun-kun-data', CLOUDFLARE_ACCOUNT_ID: 'x', CLOUDFLARE_API_TOKEN: 'y' }) || ''), '書く先が本番のバケットなら止まる');
ok(/--upload と一緒に使えない/.test(runFail(['--out', OUT, '--upload', '--limit-laws', '1']) || ''), '--limit-laws と --upload は一緒に使えない');
ok(/公開用のバケットに書かない/.test(runFail(['--out', OUT, '--upload', '--only', 'laws']) || ''), '--only で絞った版は書かない');
run(['--out', OUT, '--only', 'refs', '--release', '2026-12-01']);
ok(fs.existsSync(path.join(OUT, 'releases', '2026-12-01', 'refs.jsonl.gz')) && !fs.existsSync(path.join(DEST, 'releases', '2026-12-01')), '--upload なしは手元だけ');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 件 NG` : '\nすべて ok');
process.exit(failed ? 1 : 0);
