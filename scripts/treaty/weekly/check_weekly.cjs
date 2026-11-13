// 租税条約の週次更新の確かめ（¥0・財務省にも Cloudflare にも要求を出さない）
//
//   node scripts/treaty/weekly/check_weekly.cjs      （python3 に beautifulsoup4・pymupdf が要る）
//
// 手元に偽の財務省（一覧の HTML と PyMuPDF で作った PDF。ETag で 304 を返す）を立て、偽の R2・Vectorize・埋め込みで build → apply → restore を流す。
// 一覧の選び方・PDF の読み取り・条の分け方は実物（01・02。crawl.py 経由）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { toFile, desiredVectors, slugOf } = require('./build.cjs');

const RUN = path.join(__dirname, 'run.cjs');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).slice(0, 2500)}` : ''}`); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'treaty-weekly-'));
const R2DIR = path.join(TMP, 'r2');
const VECFILE = path.join(TMP, 'vec.json');
const rk = (k) => path.join(R2DIR, ...k.split('/'));
const readR2J = (k) => (fs.existsSync(rk(k)) ? JSON.parse(fs.readFileSync(rk(k), 'utf8')) : null);
const putR2 = (k, o) => { fs.mkdirSync(path.dirname(rk(k)), { recursive: true }); fs.writeFileSync(rk(k), typeof o === 'string' ? o : JSON.stringify(o)); };
const vecDb = () => (fs.existsSync(VECFILE) ? JSON.parse(fs.readFileSync(VECFILE, 'utf8')) : {});

// ---------------------------------------------------------------- 偽の財務省
const KAN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const TITLES = {
  アイスランド: '所得に対する租税に関する二重課税の除去並びに脱税及び租税回避の防止のための日本国とアイスランドとの間の条約',
  チェコ: '所得に対する租税に関する二重課税の回避のための日本国とチェッコスロヴァキア社会主義共和国との間の条約',
  ペルー: '所得に対する租税に関する二重課税の除去並びに脱税及び租税回避の防止のための日本国とペルー共和国との間の条約',
};
const bodies = (country, changed3, del5) => Array.from({ length: 12 }, (_, i) => (i === 4 && del5 ? '削除' : (i === 2 && changed3
  ? `この条約の第三条の規定は、${country}について改正後の規定を適用するものとし、両締約国の権限のある当局が協議する。`
  : `この条約の規定は、${country}及び日本国の居住者に適用するものとし、所得に対する租税について定める（第${KAN[i + 1]}条）。`).repeat(3)));
const MKPDF = path.join(TMP, 'mkpdf.py');
fs.writeFileSync(MKPDF, `
import json, sys, pymupdf
spec = json.load(open(sys.argv[1], encoding='utf-8'))
doc = pymupdf.open()
page = doc.new_page(); y = 50
def put(t):
    global page, y
    for i in range(0, len(t), 44):
        if y > 780: page = doc.new_page(); y = 50
        page.insert_text((40, y), t[i:i+44], fontname='japan', fontsize=9); y += 14
put(spec['title'])
for i, b in enumerate(spec['bodies']):
    put('第' + spec['kan'][i + 1] + '条'); put(b)
if spec.get('scan'):
    doc = pymupdf.open(); doc.new_page()
doc.save(sys.argv[2])
`);
const site = {};
function makePdf(file, { country, changed3 = false, del5 = false, scan = false }) {
  const spec = path.join(TMP, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ title: TITLES[country] || `日本国と${country}との間の条約`, bodies: bodies(country, changed3, del5), kan: KAN, scan }));
  const out = path.join(TMP, `pdf-${file}`);
  execFileSync(process.env.PYTHON || 'python3', [MKPDF, spec, out]);
  site[`/pdf/${file}`] = fs.readFileSync(out);
}
let BASE = '';
function setList(countries) {
  const rows = countries.map(({ c, file }) => `<tr><td style="background-color: #f5f5f5">${c}</td></tr>
<tr><td>原条約 署名日 2018年1月15日 発効日 2018年12月28日</td><td><a href="${BASE}/pdf/${file}">和文</a></td></tr>`).join('\n');
  site['/list.html'] = Buffer.from(`<html><body><table>\n${rows}\n</table></body></html>`);
}
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const b = site[u];
  if (u === '/list.html' && site.listStatus) { res.writeHead(site.listStatus); res.end(); return; }
  if (site.status && site.status[u]) { res.writeHead(site.status[u]); res.end(); return; }
  if (!b) { res.writeHead(404); res.end(); return; }
  const et = `"${crypto.createHash('md5').update(b).digest('hex')}"`;
  if (req.headers['if-none-match'] === et) { res.writeHead(304, { ETag: et }); res.end(); return; }
  res.writeHead(200, { ETag: et, 'Content-Type': u.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8' });
  res.end(b);
});

// PC で作った今の本番（同じ PDF を 02 で読み、03 の LLM の見出しを付けたもの）
async function pcProduction() {
  const { Embedder } = require('../../update/lib/ai.cjs');
  const emb = new Embedder({ fake: true });
  const mk = (country, note, src) => toFile({ country, title: TITLES[country === 'スロバキア' ? 'チェコ' : country], src, doc_type: '条約本文', note,
    articles: bodies(country === 'スロバキア' ? 'チェコ' : country).map((b, i) => ({ no: i + 1, cap: `見出し${i + 1}`, body: b.replace(/\s/g, '') })) });
  // 本文は 02 の実際の出力に合わせる（下の初回の比べで、本文の違いが出ないように crawl の出力から取る）
  const files = [mk('アイスランド', undefined, `${BASE}/pdf/is.pdf`), mk('チェコ', undefined, `${BASE}/pdf/cz.pdf`), mk('スロバキア', 'チェコスロバキア条約の承継適用（チェコと同一文書）', `${BASE}/pdf/cz.pdf`)];
  return { files, emb };
}
async function writeProd(files, emb) {
  putR2('treaty/v1/index.json', { version: 1, countries: files.map((f) => ({ c: f.country, slug: slugOf(f.country), kind: f.kind, short: f.short, title: f.title, src: f.src, doc_type: f.doc_type, n: f.articles.length, ...(f.note ? { note: f.note } : {}) })) });
  for (const f of files) putR2(`treaty/v1/${slugOf(f.country)}.json`, f);
  const db = {};
  for (const v of desiredVectors(files).values()) { const [x] = await emb.embed([v.text]); db[v.id] = { values: x, metadata: v.metadata, namespace: v.namespace }; }
  db['tsutatsu-x'] = { values: Object.values(db)[0].values, metadata: { no: '1' }, namespace: '_reverse' };
  fs.writeFileSync(VECFILE, JSON.stringify(db));
}

function run(args, env = {}, out = path.join(TMP, 'out')) {
  return new Promise((resolve) => {
    const e = { ...process.env, TREATY_WEEKLY_OUT: out, R2_FAKE_DIR: R2DIR, VECTORIZE_FAKE_FILE: VECFILE, AI_FAKE: '1', TREATY_LIST_URL: `${BASE}/list.html`, TREATY_SLEEP_MS: '0', TREATY_RETRY_S: '0',
      TREATY_VEC_PACE_MS: '0', TREATY_VEC_POLL_MS: '0', ...env };
    for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GITHUB_ACTIONS', 'TREATY_APPROVED']) if (!(k in env)) delete e[k];
    const p = spawn(process.execPath, [RUN, ...args], { env: e });
    let so = '';
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { so += d; });
    p.on('close', (code) => resolve({ code, out: so }));
  });
}
async function week(n, { apply = true, approve = false, env = {} } = {}) {
  const out = path.join(TMP, `out-${n}`);
  const b = await run(['build'], { UPDATE_RUN_ID: `run-${n}`, ...env }, out);
  const mf = path.join(out, 'build', 'manifest.json');
  const m = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : null;
  const a = apply && m ? await run(['apply'], { ...(approve ? { TREATY_APPROVED: '1' } : {}), ...env }, out) : null;
  return { out, b, a, m };
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  makePdf('is.pdf', { country: 'アイスランド' });
  makePdf('cz.pdf', { country: 'チェコ' });
  makePdf('sk.pdf', { country: 'スロバキア', scan: true });
  setList([{ c: 'アイスランド', file: 'is.pdf' }, { c: 'チェコ', file: 'cz.pdf' }, { c: 'スロバキア', file: 'sk.pdf' }]);

  // 本番の本文は 02 の実際の読み取りに合わせる（初回に解析だけ流して本文を取る）
  const { files, emb } = await pcProduction();
  putR2('treaty/v1/index.json', { version: 1, countries: [] });
  const probe = await week('probe', { apply: false });
  const crawl = JSON.parse(fs.readFileSync(path.join(probe.out, 'work', 'crawl.json'), 'utf8'));
  for (const f of files) {
    const c = crawl.countries.find((x) => x.country === (f.country === 'スロバキア' ? 'チェコ' : f.country));
    f.articles = c.articles.map((a) => ({ ...a, cap: a.no ? `見出し${a.no}` : a.cap }));
    f.title = c.treaty_title; f.short = toFile({ country: f.country, title: f.title }).short; f.kind = toFile({ country: f.country, title: f.title }).kind;
  }
  files[2].articles = files[2].articles.map((a) => ({ ...a, cap: a.no ? `スロバキアの見出し${a.no}` : a.cap }));   // スロバキアの見出しは PC で別に付けた
  await writeProd(files, emb);
  check('（準備）偽の財務省の PDF を 02 が読める（3 か国・12 条）', crawl.countries.filter((c) => c.status === 'parsed').length === 2 && crawl.countries.find((c) => c.country === 'スロバキア').status === 'phase2' && files[0].articles.length === 12, JSON.stringify(crawl.counts) + probe.b.out.slice(-800));

  console.log('\n# 1. 初回（PC で作った今の本番）: 全部取り直して解析 → 本番と同じなら書くのは状態の控えだけ（見直す対象）');
  let w = await week(1, { apply: false });
  check('build が通る・初回は見直す対象', w.b.code === 0 && w.m && w.m.first_run && w.m.needs_review && w.m.ok_to_apply, w.b.out.slice(-1500));
  check('本番と同じ（見出しは本番から引き継ぐ・スロバキアはチェコの承継で自分の見出しのまま）→ ファイルもベクトルも変わらない', w.m && !Object.keys(w.m.files).length && w.m.vectors.upsert === 0 && w.m.vectors.meta_update === 0 && w.m.vectors.delete === 0, JSON.stringify(w.m && { f: Object.keys(w.m.files), v: w.m.vectors, rv: w.m.review }));
  let r = await run(['apply'], { TREATY_APPROVED: '1' }, w.out);
  check('承認で反映 → 状態の控え（PDF の ETag）ができる', r.code === 0 && readR2J('update_state/treaty/state.json') && readR2J('update_state/treaty/state.json').pdfs[`${BASE}/pdf/is.pdf`].etag, r.out.slice(-600));

  console.log('\n# 2. 変わらない週: PDF は全部 304 → 何もしない回');
  w = await week(2);
  check('何もしない回（nothing_to_do）・PDF は 304', w.m && w.m.nothing_to_do && w.m.counts.pdf_200 === 0 && w.m.counts.same === 2 && w.a && /反映するものが無い/.test(w.a.out), JSON.stringify(w.m && { c: w.m.counts, rv: w.m.review, s: w.m.state_changed }));

  console.log('\n# 3. アイスランドの PDF が変わる（第三条）→ その国だけ解析し直す → 見直す対象 → 承認で反映');
  makePdf('is.pdf', { country: 'アイスランド', changed3: true });
  w = await week(3, { apply: false });
  const isKey = `treaty/v1/${slugOf('アイスランド')}.json`;
  check('解析し直すのはアイスランドだけ・条文が変わった国として見直す対象', w.m && w.m.counts.parsed === 1 && w.m.review.some((x) => /条文が変わった国 1.*アイスランド/.test(x)) && Object.keys(w.m.files).join() === isKey, JSON.stringify(w.m && { c: w.m.counts, f: Object.keys(w.m.files), rv: w.m.review }));
  check('第三条のベクトルだけ埋め込み直す', w.m && w.m.vectors.upsert === 1 && w.m.vectors.upsert_text === 1, JSON.stringify(w.m && w.m.vectors));
  r = await run(['apply'], { TREATY_APPROVED: '1' }, w.out);
  const is3 = (readR2J(isKey) || { articles: [] }).articles.find((a) => a.no === 3);
  check('反映 → 第三条が新しい本文・見出しは本番から引き継ぐ', r.code === 0 && is3 && /改正後/.test(is3.body) && is3.cap === '見出し3' && /改正後/.test(vecDb()[`tr_${slugOf('アイスランド')}_3`].metadata.b), r.out.slice(-600));

  console.log('\n# 3b. アイスランドとチェコの第五条が削除される → 見出しは前の「見出し5」を引き継がず「（削除）」（承継のスロバキアも）');
  makePdf('is.pdf', { country: 'アイスランド', changed3: true, del5: true });
  makePdf('cz.pdf', { country: 'チェコ', del5: true });
  w = await week('3b', { apply: false });
  const is5f = w.m && w.m.files[isKey] ? JSON.parse(fs.readFileSync(path.join(w.out, 'build', w.m.files[isKey].local), 'utf8')) : null;
  const is5 = is5f && is5f.articles.find((a) => a.no === 5);
  check('削除された条の見出しは（削除）（前の見出しを引き継がない）・ベクトルの cap も', is5 && is5.cap === '（削除）' && is5.body.length < 10, JSON.stringify(is5) + JSON.stringify(w.m && w.m.review));
  const skFile = (k) => (w.m && w.m.files[k] ? JSON.parse(fs.readFileSync(path.join(w.out, 'build', w.m.files[k].local), 'utf8')) : null);
  const sk5 = ((skFile(`treaty/v1/${slugOf('スロバキア')}.json`) || { articles: [] }).articles).find((a) => a.no === 5);
  const cz5 = ((skFile(`treaty/v1/${slugOf('チェコ')}.json`) || { articles: [] }).articles).find((a) => a.no === 5);
  check('承継のスロバキアも削除された条は（削除）（スロバキアの前の見出しで上書きしない）', cz5 && cz5.cap === '（削除）' && sk5 && sk5.cap === '（削除）', JSON.stringify({ cz5, sk5 }));
  makePdf('is.pdf', { country: 'アイスランド', changed3: true });
  makePdf('cz.pdf', { country: 'チェコ' });

  console.log('\n# 4. 新しい国（ペルー）→ 一覧の最後に足す・見出しは空（LLM を使わない）→ 戻す');
  makePdf('pe.pdf', { country: 'ペルー' });
  setList([{ c: 'アイスランド', file: 'is.pdf' }, { c: 'チェコ', file: 'cz.pdf' }, { c: 'スロバキア', file: 'sk.pdf' }, { c: 'ペルー', file: 'pe.pdf' }]);
  w = await week(4, { apply: false });
  check('新しい国・見出しの無い条を見直す対象に出す', w.m && w.m.review.some((x) => /新しい国 1: ペルー/.test(x)) && w.m.review.some((x) => /見出しの無い条.*ペルー 12 条/.test(x)) && w.m.vectors.upsert_new === 12, JSON.stringify(w.m && { rv: w.m.review, v: w.m.vectors }));
  r = await run(['apply'], { TREATY_APPROVED: '1' }, w.out);
  const idx4 = readR2J('treaty/v1/index.json');
  check('反映 → 一覧の最後にペルー（12 条）・ファイルとベクトル', r.code === 0 && idx4.countries.map((c) => c.c).join() === 'アイスランド,チェコ,スロバキア,ペルー' && idx4.countries[3].n === 12 && readR2J(`treaty/v1/${slugOf('ペルー')}.json`) && vecDb()[`tr_${slugOf('ペルー')}_1`], r.out.slice(-600));
  r = await run(['restore', 'run-4'], {}, w.out);
  check('restore で戻る（一覧・ファイル・ベクトルからペルーが消える）', r.code === 0 && readR2J('treaty/v1/index.json').countries.length === 3 && !readR2J(`treaty/v1/${slugOf('ペルー')}.json`) && !vecDb()[`tr_${slugOf('ペルー')}_1`], r.out.slice(-600));
  setList([{ c: 'アイスランド', file: 'is.pdf' }, { c: 'チェコ', file: 'cz.pdf' }, { c: 'スロバキア', file: 'sk.pdf' }]);

  console.log('\n# 5. PDF がテキスト層の無いものに差し替わる → 本番のまま残す（消さない）');
  makePdf('cz.pdf', { country: 'チェコ', scan: true });
  w = await week(5);
  check('チェコは本番のまま・スロバキアも承継のまま・ファイルは書かない（控えだけ進めて自動で反映）', w.m && !Object.keys(w.m.files).length && w.m.notes.some((x) => /本番のまま残す.*チェコ/.test(x)) && !w.m.needs_review && w.a && w.a.code === 0 && readR2J(`treaty/v1/${slugOf('チェコ')}.json`).articles.length === 12, JSON.stringify(w.m && { f: Object.keys(w.m.files), n: w.m.notes, rv: w.m.review }) + (w.a ? w.a.out.slice(-300) : ''));
  makePdf('cz.pdf', { country: 'チェコ' });

  console.log('\n# 6. 止める: 下見の途中の戻し・一覧が崩れる・一覧が取れない');
  w = await week(6, { apply: false, env: { TREATY_TEST_MID_BUILD: `"${process.execPath}" "${RUN}" restore run-5` } });
  check('下見の途中に戻しが入る → build が落ちる（成果物なし）', w.b.code === 1 && !w.m && /下見の途中で反映か戻しが入った/.test(w.b.out), w.b.out.slice(-600));
  site['/list.html'] = Buffer.from('<html><body><table></table></body></html>');
  w = await week(7, { apply: false });
  check('一覧から国が取れない → 止める（exit 3）', w.b.code === 3 && w.m && !w.m.ok_to_apply && w.m.blockers.some((x) => /取れた国が少なすぎる/.test(x)), JSON.stringify(w.m && w.m.blockers) + w.b.out.slice(-400));
  site.listStatus = 500;
  w = await week(8, { apply: false });
  check('一覧が取れない（HTTP 500）→ build が落ちる', w.b.code === 1 && !w.m && /crawl\.py が落ちた/.test(w.b.out), w.b.out.slice(-500));

  delete site.listStatus;
  setList([{ c: 'アイスランド', file: 'is.pdf' }, { c: 'チェコ', file: 'cz.pdf' }, { c: 'スロバキア', file: 'sk.pdf' }]);

  console.log('\n# 9. スロバキアの PDF にテキスト層が付く → 自分の文書で反映 → 翌週 304（same）でもチェコの承継で上書きしない');
  makePdf('sk.pdf', { country: 'スロバキア' });
  w = await week(9, { approve: true });
  const skKey = `treaty/v1/${slugOf('スロバキア')}.json`;
  const sk9 = readR2J(skKey);
  check('スロバキアを自分の PDF で反映（承継の注記なし）', w.a && w.a.code === 0 && w.m.review.some((x) => /条文が変わった国.*スロバキア/.test(x)) && sk9 && !sk9.note && /sk\.pdf$/.test(sk9.src), JSON.stringify(w.m && w.m.review) + (w.a ? w.a.out.slice(-400) : ''));
  w = await week(10);
  check('翌週 304 → スロバキアは same・何もしない回（承継で上書きしない）', w.m && w.m.nothing_to_do && w.m.counts.same === 3 && !Object.keys(w.m.files).length && w.m.vectors.delete === 0 && readR2J(skKey).src === sk9.src, JSON.stringify(w.m && { c: w.m.counts, f: Object.keys(w.m.files), v: w.m.vectors, rv: w.m.review }));

  console.log('\n# 10. 財務省の PDF が取れない（404・500）→ 止める（古い条文のまま控えだけ進めない）');
  const stateBefore = JSON.stringify(readR2J('update_state/treaty/state.json'));
  site.status = { '/pdf/is.pdf': 404 };
  w = await week(11);
  check('PDF が 404 → 止める（exit 3）・書かない', w.b.code === 3 && w.m && !w.m.ok_to_apply && w.m.blockers.some((x) => /PDF が取れなかった国 1.*アイスランド/.test(x)) && w.a && w.a.code !== 0 && JSON.stringify(readR2J('update_state/treaty/state.json')) === stateBefore, JSON.stringify(w.m && { b: w.m.blockers, c: w.m.counts }) + w.b.out.slice(-400) + (w.a ? w.a.out.slice(-300) : ''));
  site.status = { '/pdf/cz.pdf': 500 };
  w = await week(12);
  check('PDF が 500 → 止める（チェコ）・スロバキアは自分の文書のまま', w.b.code === 3 && w.m && w.m.blockers.some((x) => /PDF が取れなかった国 1.*チェコ/.test(x)) && !w.m.files[skKey] && JSON.stringify(readR2J('update_state/treaty/state.json')) === stateBefore, JSON.stringify(w.m && { b: w.m.blockers, f: Object.keys(w.m.files) }) + w.b.out.slice(-400));
  delete site.status;

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
