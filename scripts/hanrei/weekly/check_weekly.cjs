// 判例の週次更新（run.cjs）の通しの確かめ。¥0・裁判所にも Cloudflare にも要求を出さない。
//
//   HANREI_PYTHON=/path/to/python node scripts/hanrei/weekly/check_weekly.cjs
//
// 手元に偽の裁判所（一覧・詳細・PDF）を立て、R2 は R2_FAKE_DIR、Vectorize は VECTORIZE_FAKE_FILE、埋め込みは AI_FAKE=1。
// HANREI_PYTHON に pdfplumber と reportlab の入った python を渡すと、PDF を作って 02 の本文抜き出しまで通す
// （無ければ PDF の本文なしで流す。セクションとベクトルの確かめは飛ばす）。
//
// 見るもの: 初回（既知の id の台帳なし）の扱い、新しい判例だけ足す、詳細の取れない判例は足さない、原審の引き当て
// （既存の判例・新しい判例どうし）と appeals、lookup・links（上位 300 件の並べ直しと total）・court_names・index、
// ベクトル、退避と戻し（後の反映があれば戻さない）、2 回目は何もしない、上限超えで止める、prepare の後に R2 や台帳が変わったら書かない、
// PDF が一時的に取れない判例は足さない（出していない 404 は本文なしで足す）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const RUN = path.join(__dirname, 'run.cjs');
const { caseToTargets } = require('../06_embed.cjs');
const { Embedder } = require('../../update/lib/ai.cjs');

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  → ' + detail}`); if (!ok) fails++; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- 偽の裁判所の中身
// collection → search の n と detailN
const COLL = { saikosai: [2, 2], kosai: [3, 3], sokuho: [4, 4], gyosei: [5, 5], rodo: [6, 6], chizai: [7, 7] };
const SITE = [
  // 既知（R2 にある）で一覧にも出る
  { id: '94000', coll: 'sokuho', date: '令和7年1月10日', court: '大阪地方裁判所', caseNo: '令和6(ワ)1', title: '既知の事件', kind: '判決', kekka: '棄却' },
  // 新しい: 地裁（既存 90001）の控訴審
  { id: '95001', coll: 'sokuho', date: '令和7年10月1日', court: '東京高等裁判所', caseNo: '令和6(ネ)200', title: '損害賠償請求控訴事件', kind: '判決', kekka: '棄却',
    gensin: '東京地方裁判所 令和5(ワ)100', gensinDate: '令和6年3月1日', hanji: '取締役の任務懈怠責任', yoshi: '会社法423条1項の責任を認めなかった事例',
    pdf: ['主 文', '本件控訴を棄却する。', '事実及び理由', '第１ 事案の概要', '本件は、会社法４２３条１項に基づく損害賠償を求める事案である。', '第２ 当裁判所の判断', '民法７０９条の要件も満たさない。'] },
  // 新しい: 上の控訴審（新しい判例どうし）の上告審
  { id: '95002', coll: 'saikosai', date: '令和8年2月1日', court: '最高裁判所第一小法廷', caseNo: '令和7(受)300', title: '損害賠償請求事件', kind: '判決', kekka: '破棄差戻',
    gensin: '東京高等裁判所 令和6(ネ)200', gensinDate: '令和7年10月1日', hanji: '民法709条の過失の判断', yoshi: '原審の判断には違法がある',
    pdf: ['主 文', '原判決を破棄する。', '理 由', '民法７０９条の過失の有無について判断する。'] },
  // 新しい: 詳細ページが 404（足さない）
  { id: '95003', coll: 'sokuho', date: '令和8年3月3日', court: '札幌地方裁判所', caseNo: '令和7(ワ)9', title: '詳細の取れない事件', kind: '判決', kekka: '認容', detail404: true },
  // 新しい: PDF が一時的に 500（本文が欠けたまま既知にしないよう、今回は足さない）
  { id: '95004', coll: 'sokuho', date: '令和8年4月1日', court: '名古屋地方裁判所', caseNo: '令和7(ワ)20', title: 'PDF の取れない事件', kind: '判決', kekka: '認容', hanji: 'PDF が 500', pdfError: true },
  // 新しい: 裁判所が PDF を出していない（404）。本文なしで足す
  //   参照法条から民事訴訟法 89 条を引く（条の系譜の付け直し hanrei_v2 の確かめ。PDF が無くても lawRefs ができる）
  { id: '95005', coll: 'sokuho', date: '令和8年4月4日', court: '福岡地方裁判所', caseNo: '令和7(ワ)30', title: 'PDF の無い事件', kind: '決定', kekka: '却下', hanji: 'PDF なし', sansho: '民事訴訟法89条' },
];

function listRowHtml(c) {
  const [, dn] = COLL[c.coll];
  const p0 = ['', c.caseNo, c.title, ''].join('\n');
  const p1 = ['', c.date, c.court, '', '', c.kind, c.kekka, '', '', '', c.gensin || '', '', ''].join('\n');
  return `<tr><th>判例</th><td><p>${p0}</p><p>${p1}</p><p></p><p><a href="/hanrei/${c.id}/detail${dn}/index.html">詳細</a></p></td></tr>`;
}
function detailHtml(c) {
  const dd = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const [g, gCase] = (c.gensin || '').split(' ');
  return `<html><body><dl>${dd('事件番号', c.caseNo)}${dd('事件名', c.title)}${dd('裁判年月日', c.date)}${dd('法廷名', c.court)}${dd('裁判種別', c.kind)}${dd('結果', c.kekka)}${dd('判示事項', c.hanji)}${dd('裁判要旨', c.yoshi)}${dd('原審裁判所名', g)}${dd('原審事件番号', gCase)}${dd('原審裁判年月日', c.gensinDate)}${dd('参照法条', c.sansho)}</dl></body></html>`;
}
const R_YEAR = (d) => parseInt((d.match(/令和(\d+)年/) || [])[1], 10);
const R_MONTH = (d) => parseInt((d.match(/年(\d+)月/) || [])[1], 10);

const FLAGS = { emptySokuho: false };   // 一覧で sokuho を 0 件にする（件数が減ったのを拾うかの確かめ）
function startCourts(pdfDir) {
  const hits = { list: 0, detail: 0, pdf: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let m;
    if ((m = u.pathname.match(/^\/hanrei\/search(\d)\/index\.html$/))) {
      hits.list++;
      const n = parseInt(m[1], 10);
      const coll = Object.keys(COLL).find((k) => COLL[k][0] === n);
      const yf = parseInt(u.searchParams.get('filter[judgeYearFrom]'), 10), yt = parseInt(u.searchParams.get('filter[judgeYearTo]'), 10);
      const mf = parseInt(u.searchParams.get('filter[judgeMonthFrom]'), 10), mt = parseInt(u.searchParams.get('filter[judgeMonthTo]'), 10);
      const rows = SITE.filter((c) => !(FLAGS.emptySokuho && coll === 'sokuho') && c.coll === coll && R_YEAR(c.date) >= yf && R_YEAR(c.date) <= yt && R_MONTH(c.date) >= mf && R_MONTH(c.date) <= mt);
      const body = rows.length ? `<p>${rows.length}件中 1～${rows.length}件を表示</p><table>${rows.map(listRowHtml).join('\n')}</table>` : '<p>該当する裁判例がありませんでした</p>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<html><body>${body}</body></html>`); return;
    }
    if ((m = u.pathname.match(/^\/hanrei\/(\d+)\/detail\d\/index\.html$/))) {
      hits.detail++;
      const c = SITE.find((x) => x.id === m[1]);
      if (!c || c.detail404) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(detailHtml(c)); return;
    }
    if ((m = u.pathname.match(/^\/assets\/hanrei\/hanrei-pdf-(\d+)\.pdf$/))) {
      hits.pdf++;
      if ((SITE.find((x) => x.id === m[1]) || {}).pdfError) { res.writeHead(500); res.end(); return; }
      const f = path.join(pdfDir, `${m[1]}.pdf`);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(fs.readFileSync(f)); return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}

// ---------------------------------------------------------------- 偽の R2（hanrei_v1 の今の姿）
const EXIST = {
  '90001': { id: '90001', detailNs: ['4'], collections: ['sokuho'], caseNo: '令和5(ワ)100', title: '損害賠償請求事件', dateJp: '令和6年3月1日', dateIso: '2024-03-01', court: '東京地方裁判所', branch: null, courtDetail: '東京地方裁判所', kind: '判決', kekka: '棄却', hanji: '取締役の責任', yoshi: '請求を棄却した事例', gensin: null, pdf: { pages: 1, chars: 10, found: true }, shubun: '棄却', sections: [], lawRefs: [{ lawId: '129AC0000000089', law: '民法', art: '709', count: 1, kaiseimae: false }], unresolvedRefs: [], url: 'https://www.courts.go.jp/hanrei/90001/detail4/index.html' },
  '90002': { id: '90002', detailNs: ['4'], collections: ['sokuho'], caseNo: '令和5(ワ)101', title: '別の事件', dateJp: '令和6年3月2日', dateIso: '2024-03-02', court: '東京地方裁判所', branch: null, kind: '判決', kekka: '認容', hanji: '別の判示', yoshi: null, gensin: null, pdf: { pages: 0, chars: 0, found: false }, sections: [], lawRefs: [], unresolvedRefs: [], url: 'https://www.courts.go.jp/hanrei/90002/detail4/index.html' },
  '90003': { id: '90003', detailNs: ['2'], collections: ['saikosai'], caseNo: '令和4(受)1', title: '三つめの事件', dateJp: '令和5年1月1日', dateIso: '2023-01-01', court: '最高裁判所', branch: null, kind: '判決', kekka: '棄却', hanji: '三つめの判示', yoshi: '三つめの要旨', gensin: null, pdf: { pages: 0, chars: 0, found: false }, sections: [], lawRefs: [], unresolvedRefs: [], url: 'https://www.courts.go.jp/hanrei/90003/detail2/index.html' },
  '94000': { id: '94000', detailNs: ['4'], collections: ['sokuho'], caseNo: '令和6(ワ)1', title: '既知の事件', dateJp: '令和7年1月10日', dateIso: '2025-01-10', court: '大阪地方裁判所', branch: null, kind: '判決', kekka: '棄却', hanji: null, yoshi: null, gensin: null, pdf: { pages: 0, chars: 0, found: false }, sections: [], lawRefs: [], unresolvedRefs: [], url: 'https://www.courts.go.jp/hanrei/94000/detail4/index.html' },
};
function linkItem(id, court, dateJp) { return { id, title: `事件${id}`, court, dateJp, caseNo: null, kekka: null, url: `https://www.courts.go.jp/hanrei/${id}/detail4/index.html` }; }
function buildR2(dir) {
  const put = (k, o) => { const p = path.join(dir, ...k.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };
  put('hanrei_v1/cases_0900.json', { '90001': EXIST['90001'], '90002': EXIST['90002'], '90003': EXIST['90003'] });
  put('hanrei_v1/cases_0940.json', { '94000': EXIST['94000'] });
  put('hanrei_v1/lookup/caseno_R05.json', { '東京地方裁判所|令和5(ワ)100': ['90001'], '東京地方裁判所|令和5(ワ)101': ['90002'] });
  put('hanrei_v1/lookup/date_2024.json', { '東京地方裁判所|2024-03-01': ['90001'] });
  // 民法 709 条: 地裁 300 件で上限いっぱい（total 301）。日付の古い 1 件が押し出されるはず
  const items = [];
  for (let i = 0; i < 300; i++) items.push(linkItem(String(80000 + i), '東京地方裁判所', `令和${1 + (i % 5)}年${1 + (i % 12)}月${1 + (i % 28)}日`));
  put('hanrei_v1/links/129AC0000000089.json', { '1': { total: 1, items: [linkItem('70000', '東京地方裁判所', '令和元年5月1日')] }, '709': { total: 301, items } });
  put('hanrei_v1/court_names.json', ['大阪地方裁判所', '東京地方裁判所']);
  put('hanrei_v1/index.json', { builtAt: '2026-09-09T00:00:00Z', cases: 4, laws: ['129AC0000000089'], vectors: 10 });
  // 条の系譜で付け直した逆引き（hanrei_v2）と付け直しの表（lineage_v1/tables）。表は確かめ用の作り物（89 条 → 61 条に番号が変わったことにする）
  put('hanrei_v2/index.json', { builtAt: '2026-10-15T00:00:00Z', cases: 4, laws: ['408AC0000000109'] });
  put('hanrei_v2/links/408AC0000000109.json', { '61': { total: 1, items: [{ ...linkItem('70001', '東京地方裁判所', '平成元年5月1日'), via: { lawId: '123AC0000000029', law: '民事訴訟法', art: '89', old: true } }] } });
  // hanrei_v2 の民法 709 条: 上位 300 件で埋まり、301 件目からの続き（links_more）に 2 件（2026-10-18）。新しい判例が上位に入ったら、押し出された判例は続きに移る（落ちない）
  put('hanrei_v2/links/129AC0000000089.json', { '709': { total: 302, items: items.map((x) => ({ ...x, id: String(Number(x.id) + 1000) })) } });
  put('hanrei_v2/links_more/129AC0000000089/709.json', { total: 302, items: [linkItem('79001', '東京地方裁判所', '平成2年1月1日'), linkItem('79000', '東京地方裁判所', '平成元年1月1日')] });
  put('hanrei_v2/currefs_0900.json', { '90001': [{ lawId: '129AC0000000089', art: '709', how: 'nolineage', from: { lawId: '129AC0000000089', art: '709', ver: '2024-03-01' }, conf: null }] });
  put('lineage_v1/tables/index.json', { '408AC0000000109': { title: '民事訴訟法', old_law: false, old: null, names: [] } });
  put('lineage_v1/tables/408AC0000000109.json', { law_id: '408AC0000000109', title: '民事訴訟法', born: '1998-01-01', old: null, acts: {}, arts: { 89: [['1998-01-01', null, 'renum', [['408AC0000000109', '61', 0.98]]]] } });
  put('lineage_v1/policy/old_to_current.json', {});   // 旧法の受け皿の判定（載せる条件。この確かめでは旧法を引かない）
}
async function buildVectors(file) {
  const emb = new Embedder({ fake: true });
  const st = { byType: {}, yoshiCases: 0, emptySections: 0, shortSections: 0, homesTrimmed: 0, metaOverAfterTrim: 0 };
  const ts = Object.values(EXIST).flatMap((c) => caseToTargets(c, '_hanrei', st));
  const vals = await emb.embed(ts.map((t) => t.text));
  const db = {};
  ts.forEach((t, i) => { db[t.id] = { values: vals[i], metadata: t.metadata }; });
  fs.writeFileSync(file, JSON.stringify(db));
  return Object.keys(db);
}

function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => { if (!fs.existsSync(d)) return; for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const k = rel ? `${rel}/${n}` : n; if (fs.statSync(p).isDirectory()) walk(p, k); else out[k] = sha(fs.readFileSync(p)); } };
  walk(dir, '');
  return out;
}
const rj = (dir, key) => { const p = path.join(dir, ...key.split('/')); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUN, ...args], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hanrei-weekly-'));
  const r2dir = path.join(root, 'r2'), vecFile = path.join(root, 'vec.json'), pdfDir = path.join(root, 'pdf');
  fs.mkdirSync(pdfDir, { recursive: true });
  // PDF（python に reportlab と pdfplumber があれば）
  const py = process.env.HANREI_PYTHON || 'python3';
  const canPdf = spawnSync(py, ['-c', 'import reportlab, pdfplumber'], { stdio: 'ignore' }).status === 0;
  if (canPdf) {
    for (const c of SITE.filter((x) => x.pdf)) {
      const code = `from reportlab.pdfgen import canvas\nfrom reportlab.pdfbase import pdfmetrics\nfrom reportlab.pdfbase.cidfonts import UnicodeCIDFont\nimport json,sys\npdfmetrics.registerFont(UnicodeCIDFont('HeiseiMin-W3'))\nc=canvas.Canvas(sys.argv[1]);c.setFont('HeiseiMin-W3',12);y=800\nfor l in json.loads(sys.argv[2]):\n  c.drawString(50,y,l);y-=20\nc.save()\n`;
      spawnSync(py, ['-c', code, path.join(pdfDir, `${c.id}.pdf`), JSON.stringify(c.pdf)], { stdio: 'inherit' });
    }
  } else console.log('（pdfplumber / reportlab が無いので PDF の本文なしで流す）');
  buildR2(r2dir);
  const vecIds0 = await buildVectors(vecFile);
  const r2Before = snapshot(r2dir);
  const vecBefore = sha(fs.readFileSync(vecFile));
  const { server, hits, base } = await startCourts(pdfDir);
  const env = { R2_FAKE_DIR: r2dir, VECTORIZE_FAKE_FILE: vecFile, AI_FAKE: '1', HANREI_CRAWL_BASE: base, HANREI_CRAWL_SLEEP_MS: '0', HANREI_CRAWL_RETRY_BASE_MS: '1', HANREI_PYTHON: py, HANREI_TODAY: '2026-09-25', HANREI_APPROVED: '1', GITHUB_ACTIONS: '', HANREI_STATE_DIR: path.join(root, 'state'), UPDATE_RUN_ID: 'run1', ...(canPdf ? {} : { HANREI_SKIP_PDF_TEXT: '1' }) };
  const man = () => rj(path.join(root, 'state'), 'manifest.json');

  // ---- 1 回目 prepare（初回: 台帳なし）
  let r = await run(['prepare'], env);
  let m = man();
  check('1回目 prepare が通る', r.code === 0 && m, r.out.slice(-800));
  check('一覧は令和7〜8年（6 コレクション × 2 年）', m.window.from === 7 && m.window.to === 8 && hits.list >= 12);
  check('初回: 既知の id を R2 の cases から作り、見直す対象にする（最初の反映は「反映」で）', m.first_run && m.known_count === 4 && m.needs_review && m.ok_to_apply && m.review.some((x) => /初回/.test(x)));
  check('新しい判例は 5 件（既知の 94000 は除く）', JSON.stringify(m.new_ids) === JSON.stringify(['95001', '95002', '95003', '95004', '95005']));
  check('詳細の取れない 95003・PDF が 500 の 95004 は足さない（翌週もう一度）・PDF を出していない 95005 は足す', JSON.stringify(m.added_ids) === JSON.stringify(['95001', '95002', '95005']) && JSON.stringify(m.failed_ids) === JSON.stringify(['95003', '95004']) && m.notes.some((x) => /95004（PDF が取れなかった）/.test(x)) && m.notes.some((x) => new RegExp(`PDF を出していない判例 ${canPdf ? 1 : 3} 件`).test(x)), JSON.stringify({ added: m.added_ids, failed: m.failed_ids, notes: m.notes }));
  check('原審の引き当て: 95001→既存 90001、95002→新しい 95001', JSON.stringify(m.appeals) === JSON.stringify([{ child: '95001', parent: '90001' }, { child: '95002', parent: '95001' }]));
  check('埋め込みのずれの確かめ（既存 3 件・cosine 1）', m.notes.some((x) => /自己一致: 1\.0000 \/ 1\.0000 \/ 1\.0000/.test(x)), m.notes.join(' | '));
  check('prepare は R2 にも Vectorize にも書かない', JSON.stringify(snapshot(r2dir)) === JSON.stringify(r2Before) && sha(fs.readFileSync(vecFile)) === vecBefore);
  check('台帳（次）に既知 4 件 + 足す 3 件', m.state_next && m.state_next.ids.length === 7 && m.state_sha_before === null);

  // ---- 見直す対象がある回（初回）は「反映」コメント（HANREI_APPROVED=1）からでないと書かない
  r = await run(['apply'], { ...env, HANREI_APPROVED: '0' });
  check('見直す対象がある回（初回）は、「反映」コメントの経路でなければ apply は書かずに止まる', r.code !== 0 && /「反映」コメントからしか/.test(r.out) && !fs.existsSync(path.join(r2dir, 'hanrei_v1', 'cases_0950.json')) && !fs.existsSync(path.join(r2dir, 'update_state', 'hanrei_apply_inprogress.json')));
  // ---- apply・restore は Actions（か確かめ用の偽の R2）からしか動かない
  r = await run(['apply'], { ...env, R2_FAKE_DIR: '' });
  const r2x = await run(['restore', 'run1'], { ...env, R2_FAKE_DIR: '' });
  const r2y = await run(['apply'], { ...env, VECTORIZE_FAKE_FILE: '' });
  check('apply・restore は手元（Actions でもなく、R2 と Vectorize の両方が偽物でもない）では動かない。片方だけ偽物も拒む', r.code !== 0 && /Actions の Update hanrei data からしか/.test(r.out) && r2x.code !== 0 && /Actions の Update hanrei data からしか/.test(r2x.out) && r2y.code !== 0 && /Actions の Update hanrei data からしか/.test(r2y.out));

  // ---- 別の実行が作業中の印を持っていたら（手元と Actions が同時など）、apply は書かずに止まり、他人の印は消さない
  {
    const lf = path.join(r2dir, 'update_state', 'hanrei_apply_inprogress.json');
    fs.mkdirSync(path.dirname(lf), { recursive: true });
    fs.writeFileSync(lf, JSON.stringify({ run_id: 'other', kind: 'apply', token: 'someone-else', started_at: '2026-09-25T00:00:00Z' }));
    const rr = await run(['apply'], env);
    check('作業中の印が他の実行のものなら apply は書かずに止まり、その印は残す', rr.code !== 0 && /作業中の印がある（run other/.test(rr.out) && JSON.parse(fs.readFileSync(lf, 'utf8')).token === 'someone-else' && !fs.existsSync(path.join(r2dir, 'hanrei_v1', 'cases_0950.json')), rr.out.slice(-300));
    fs.rmSync(lf);
  }

  // ---- 中間ファイル（NDJSON）の壊れた行は黙って飛ばさず、ファイル名と行番号を付けて止める
  {
    const { readNdjson } = require('./run.cjs');
    const bad = path.join(root, 'inventory.ndjson');
    fs.writeFileSync(bad, '{"id":"1"}\n{壊れた行\n{"id":"2"}\n');
    let msg = '';
    try { readNdjson(bad); } catch (e) { msg = e.message; }
    check('NDJSON の壊れた行はファイル名と行番号を付けて止める（無いファイルは空）', /inventory\.ndjson の 2 行目/.test(msg) && readNdjson(path.join(root, 'none.ndjson')).length === 0, msg);
  }

  // ---- 成果物が欠けていたら書かない（vectors.ndjson の 1 行を消す）
  const vf = path.join(root, 'state', 'vectors.ndjson');
  const vkeep = fs.readFileSync(vf, 'utf8');
  fs.writeFileSync(vf, vkeep.split('\n').filter(Boolean).slice(1).join('\n') + '\n');
  r = await run(['apply'], env);
  check('成果物（ベクトル）が manifest の本数と合わなければ apply は書かずに止まる', r.code !== 0 && /vectors\.ndjson が \d+ 本/.test(r.out) && !fs.existsSync(path.join(r2dir, 'hanrei_v1', 'cases_0950.json')), r.out.slice(-300));
  fs.writeFileSync(vf, vkeep);

  // ---- prepare の後に台帳が書かれたら（別の反映が先に入ったら）書かない
  const stFile = path.join(r2dir, 'update_state', 'hanrei_state.json');
  fs.mkdirSync(path.dirname(stFile), { recursive: true });
  fs.writeFileSync(stFile, JSON.stringify({ ids: ['1'], slices: {} }));
  r = await run(['apply'], env);
  check('prepare の後に台帳が変わっていたら apply は書かずに止まる', r.code !== 0 && /台帳/.test(r.out) && !fs.existsSync(path.join(r2dir, 'hanrei_v1', 'cases_0950.json')), r.out.slice(-300));
  fs.rmSync(stFile);

  // ---- 埋め込みのずれ: 比べられた既存の判例のうち 1 件でも合わなければ止める（件数が 3 件未満でも）
  {
    const keepV = fs.readFileSync(vecFile);
    const db = JSON.parse(keepV);
    db['90003-y'].values = db['90003-y'].values.map((x) => -x);
    delete db['90002-y'];
    fs.writeFileSync(vecFile, JSON.stringify(db));
    const rr = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run1x' });
    const mm = man();
    check('埋め込みのずれ: 合わないものが 1 件でもあれば止める・比べられた件数が 3 件未満なら見直す対象にも出す', rr.code === 0 && !mm.ok_to_apply && mm.blockers.some((x) => /90003-y（cosine -1\.0000）/.test(x)) && mm.review.some((x) => /2 件しか確かめられなかった/.test(x)), JSON.stringify({ b: mm.blockers, r: mm.review, n: mm.notes }));
    fs.writeFileSync(vecFile, keepV);
    await run(['prepare'], env);   // 本来の成果物に戻す
    m = man();
  }

  // ---- prepare の後に R2 が変わったら書かない
  const lk = path.join(r2dir, 'hanrei_v1', 'court_names.json');
  const keep = fs.readFileSync(lk);
  fs.writeFileSync(lk, JSON.stringify(['誰かが書き換えた']));
  r = await run(['apply'], env);
  check('prepare の後に R2 が変わっていたら apply は書かずに止まる・取った印は外す', r.code !== 0 && /変わった/.test(r.out) && !fs.existsSync(path.join(r2dir, 'hanrei_v1', 'cases_0950.json')) && !fs.existsSync(path.join(r2dir, 'update_state', 'hanrei_apply_inprogress.json')));
  fs.writeFileSync(lk, keep);

  // ---- apply（前の失敗の残りとして 95001-y が索引に既にある状態にする。上書きになり、退避される）
  {
    const db = JSON.parse(fs.readFileSync(vecFile, 'utf8'));
    db['95001-y'] = { values: db['90001-y'].values, metadata: { sid: '95001', ttl: '前の残り' } };
    fs.writeFileSync(vecFile, JSON.stringify(db));
  }
  r = await run(['apply'], env);
  check('apply が通る', r.code === 0, r.out.slice(-800));
  const c950 = rj(r2dir, 'hanrei_v1/cases_0950.json');
  const c900 = rj(r2dir, 'hanrei_v1/cases_0900.json');
  check('cases: 新しい 2 件（url・原審の matchedId つき）', c950 && c950['95001'] && c950['95002'] && !c950['95003'] && c950['95001'].gensin.matchedId === '90001' && c950['95002'].gensin.matchedId === '95001' && c950['95002'].url === 'https://www.courts.go.jp/hanrei/95002/detail2/index.html');
  check('cases: 既存 90001 に上告審（appeals）だけ足し、他の欄は変えない', JSON.stringify(c900['90001'].appeals) === JSON.stringify([{ id: '95001', court: '東京高等裁判所', dateJp: '令和7年10月1日', kekka: '棄却' }]) && JSON.stringify({ ...c900['90001'], appeals: undefined }) === JSON.stringify({ ...EXIST['90001'], appeals: undefined }) && JSON.stringify(c900['90002']) === JSON.stringify(EXIST['90002']));
  check('cases: 新しい 95001 にも新しい 95002 の appeals', JSON.stringify((c950['95001'].appeals || []).map((a) => a.id)) === '["95002"]');
  const cR06 = rj(r2dir, 'hanrei_v1/lookup/caseno_R06.json'), d2025 = rj(r2dir, 'hanrei_v1/lookup/date_2025.json'), d2026 = rj(r2dir, 'hanrei_v1/lookup/date_2026.json');
  check('lookup: 事件番号と日付（04 と同じ鍵。法廷名は裁判所名に丸める）', cR06 && JSON.stringify(cR06['東京高等裁判所|令和6(ネ)200']) === '["95001"]' && d2025 && JSON.stringify(d2025['東京高等裁判所|2025-10-01']) === '["95001"]' && d2026 && JSON.stringify(d2026['最高裁判所|2026-02-01']) === '["95002"]');
  if (canPdf) {
    const civ = rj(r2dir, 'hanrei_v1/links/129AC0000000089.json');
    const kai = rj(r2dir, 'hanrei_v1/links/417AC0000000086.json');
    check('v1 の紐付け（hanrei_v1/links）は書かない（2026-10-18 から条文 → 判例の逆引きは hanrei_v2 だけ）: 民法 709 条は前のまま（total 301・80000 が残る）', civ['709'].total === 301 && civ['709'].items.length === 300 && civ['709'].items.some((x) => x.id === '80000') && !civ['709'].items.some((x) => x.id === '95001' || x.id === '95002'), JSON.stringify(civ['709'].items.slice(0, 2).map((x) => x.id)) + ' total=' + civ['709'].total);
    check('v1 の紐付けは書かない: 会社法 423 条の v1 のファイルを作らない', !kai);
  }
  {
    const v1 = rj(r2dir, 'hanrei_v1/links/408AC0000000109.json'), v2 = rj(r2dir, 'hanrei_v2/links/408AC0000000109.json');
    const cr = rj(r2dir, 'hanrei_v2/currefs_0950.json'), i2 = rj(r2dir, 'hanrei_v2/index.json');
    check('v1 の紐付けは書かない: 民事訴訟法の v1 のファイルを作らない（v2 で 61 条に付く）', !v1, JSON.stringify(v1));
    check('hanrei_v2: 付け直しの表で 61 条に付け、元の条（via）を持つ・前からの item は残る', v2 && v2['61'] && v2['61'].total === 2 && v2['61'].items.some((x) => x.id === '95005' && x.via && x.via.art === '89' && x.via.law === '民事訴訟法' && x.via.old === false) && v2['61'].items.some((x) => x.id === '70001') && !v2['89'], JSON.stringify(v2));
    if (canPdf) {
      const ft = rj(r2dir, 'hanrei_v2/fulltext/95001.json');
      check('hanrei_v2: 新しい判例の判決文の全文を fulltext/ に置く（検索の区切りとは別）', ft && ft.id === '95001' && /会社法/.test(ft.text) && ft.source === 'https://www.courts.go.jp/assets/hanrei/hanrei-pdf-95001.pdf', JSON.stringify(ft).slice(0, 200));
    }
    if (canPdf) {
      const v2c = rj(r2dir, 'hanrei_v2/links/129AC0000000089.json');
      const it1 = v2c && v2c['709'] && v2c['709'].items.find((x) => x.id === '95001');
      check('hanrei_v2: 上告審（95002・最高裁・破棄差戻）が付いた原審 95001 の item に上告審の結果の印（同じ週の新しい判例どうしでも）', it1 && it1.appeal && it1.appeal.k === 'haki' && it1.appeal.id === '95002', JSON.stringify(it1));
    }
    {
      // 上位 300 件から押し出された判例は続き（links_more）に移る・判例は 1 件も落ちない・件数（total）は足した分だけ増える
      const v2c = rj(r2dir, 'hanrei_v2/links/129AC0000000089.json'), mo = rj(r2dir, 'hanrei_v2/links_more/129AC0000000089/709.json');
      const e = v2c && v2c['709'];
      const before = [...Array.from({ length: 300 }, (_, i) => String(81000 + i)), '79001', '79000'];
      const ids = e && mo ? [...e.items, ...mo.items].map((x) => String(x.id)) : [];
      const added = ids.filter((id) => !before.includes(id));
      // 新しい判例が民法 709 条に付くのは PDF の本文から引用を読めたときだけ（pdfplumber・reportlab が無い回は足す判例が無い）。
      // 無い回は「何も落とさず、何も動かさない」ことを確かめる（2026-11-07: Actions の Python にこの 2 つが無く、ここだけ落ちていた）
      if (!canPdf) check('hanrei_v2: PDF の本文なしの回は民法 709 条に足す判例が無く、上位 300 件と続き（links_more）は前のまま',
        e && mo && added.length === 0 && e.total === 302 && e.items.length === 300 && mo.total === 302 && JSON.stringify(mo.items.map((x) => x.id)) === JSON.stringify(['79001', '79000']) && before.every((id) => ids.includes(id)),
        JSON.stringify({ total: e && e.total, top: e && e.items.length, more: mo && mo.items.map((x) => x.id), added }));
      else check('hanrei_v2: 上位 300 件から押し出された判例は続き（links_more）に移す（落とさない・重ねない・total は足した分だけ増える）',
        e && mo && e.items.length === 300 && before.every((id) => ids.includes(id)) && new Set(ids).size === ids.length && added.length >= 1 && e.total === 302 + added.length && mo.total === e.total
        && mo.items.length === 2 + added.length && mo.items[mo.items.length - 1].id === '79000' && added.every((id) => e.items.some((x) => x.id === id)),
        JSON.stringify({ total: e && e.total, top: e && e.items.length, more: mo && mo.items.map((x) => x.id), added }));
    }
    const nq = rj(r2dir, 'update_state/lineage_nonum_queue.json');
    check('条番号の無い判例の待ち行列: 引用のある新しい判例（95001・95002・95005）は入れない', !nq || !['95001', '95002', '95005'].some((id) => nq.items && nq.items[id]), JSON.stringify(nq));
    check('hanrei_v2: 新しい判例の付け直し（currefs）と index の件数', cr && cr['95005'] && cr['95005'].some((x) => x.how === 'renum' && x.art === '61' && x.from.art === '89') && cr['95001'] && i2.cases === 7 && i2.laws.includes('408AC0000000109') && i2.updatedAt, JSON.stringify({ cr, i2 }));
  }
  const names = rj(r2dir, 'hanrei_v1/court_names.json'), idx = rj(r2dir, 'hanrei_v1/index.json');
  check('court_names に新しい裁判所・index の件数', names.includes('東京高等裁判所') && names.includes('最高裁判所') && !names.includes('最高裁判所第一小法廷') && names.includes('福岡地方裁判所') && !names.includes('名古屋地方裁判所') && idx.cases === 7 && idx.builtAt === '2026-09-09T00:00:00Z' && idx.updatedAt);
  const vdb = JSON.parse(fs.readFileSync(vecFile, 'utf8'));
  check('ベクトル: 新しい判例の要旨（-y）が入り、既存のベクトルは残る', vdb['95001-y'] && vdb['95002-y'] && vecIds0.every((id) => vdb[id]) && vdb['95001-y'].metadata.sid === '95001');
  if (canPdf) check('ベクトル: PDF の本文からセクション（-s）も入る', Object.keys(vdb).some((k) => /^95001-s\d+$/.test(k)));
  const st = rj(r2dir, 'update_state/hanrei_state.json');
  check('台帳: 既知の id に 3 件足す・取れなかった 95003・95004 は入れない', st && st.ids.length === 7 && st.ids.includes('95005') && !st.ids.includes('95003') && !st.ids.includes('95004'));
  const bm = rj(r2dir, 'update_state/hanrei_backup/run1/_manifest.json');
  check('退避: 上書きしたファイルの元・台帳は無かった印・足したベクトル・上書きしたベクトル', bm && JSON.stringify(bm.vectors_overwritten) === '["95001-y"]' && bm.files['hanrei_v1/cases_0900.json'] === true && bm.files['hanrei_v1/cases_0950.json'] === false && bm.state_existed === false && bm.vectors_added.includes('95001-y') && fs.existsSync(path.join(r2dir, 'update_state', 'hanrei_backup', 'run1', 'files', 'hanrei_v1', 'cases_0900.json')));

  // ---- 2 回目 prepare（台帳あり・新しいものは 95003 だけでまた取れない）
  r = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run2' });
  m = man();
  check('2回目: 台帳から既知 7 件・足すものは無い（95003・95004 はまた取れない）・何もしない回', r.code === 0 && !m.first_run && m.known_count === 7 && m.added_ids.length === 0 && !m.needs_review && m.ok_to_apply && m.nothing_to_do && Object.keys(m.files).length === 0, JSON.stringify({ review: m.review, blockers: m.blockers }));

  // ---- 一覧が 0 件に落ちたコレクション×年は「減った」として見直す対象にする
  FLAGS.emptySokuho = true;
  r = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run2b' });
  m = man();
  FLAGS.emptySokuho = false;
  check('一覧が 0 件に落ちたら見直す対象（sokuho_R07 2 → 0・sokuho_R08 3 → 0）', r.code === 0 && m.needs_review && !m.nothing_to_do && m.review.some((x) => /sokuho_R07 2 → 0/.test(x)) && m.review.some((x) => /sokuho_R08 3 → 0/.test(x)), JSON.stringify(m.review));
  check('件数の減少だけの回も、「反映」すれば台帳の件数を新しくする（既知の id はそのまま）', m.state_next && m.state_next.ids.length === 7 && m.state_next.slices.sokuho_R08 === 0 && Object.keys(m.files).length === 0);

  // ---- 戻す: この回の後にベクトルだけ変わっていても戻さない
  const vdbKeep = fs.readFileSync(vecFile);
  const vdbMod = JSON.parse(vdbKeep);
  vdbMod['95001-y'].metadata = { ...vdbMod['95001-y'].metadata, ttl: '後で直した題名' };
  fs.writeFileSync(vecFile, JSON.stringify(vdbMod));
  r = await run(['restore', 'run1'], env);
  check('restore: この回の後に変わったベクトルがあれば、何も書かずに止まる', r.code !== 0 && /変わったベクトル/.test(r.out) && fs.existsSync(path.join(r2dir, 'hanrei_v1', 'cases_0950.json')), r.out.slice(-300));
  fs.writeFileSync(vecFile, vdbKeep);

  // ---- 戻す: 戻す元（退避）が欠けていたり壊れていたりしたら、書き戻しを始めずに止まる
  {
    const bdir = path.join(r2dir, 'update_state', 'hanrei_backup', 'run1');
    const vb = path.join(bdir, 'vectors_before.json');
    fs.renameSync(vb, vb + '.x');
    let rr = await run(['restore', 'run1'], env);
    check('restore: vectors_before.json が無ければ何も書かずに止まる', rr.code !== 0 && /vectors_before\.json が無い/.test(rr.out) && fs.existsSync(path.join(r2dir, 'hanrei_v1', 'cases_0950.json')), rr.out.slice(-300));
    fs.renameSync(vb + '.x', vb);
    const bf = path.join(bdir, 'files', 'hanrei_v1', 'cases_0900.json');
    const bkeep = fs.readFileSync(bf);
    fs.writeFileSync(bf, '{}');
    rr = await run(['restore', 'run1'], env);
    check('restore: 退避のファイルが書く前の hash と合わなければ何も書かずに止まる', rr.code !== 0 && /退避の hanrei_v1\/cases_0900\.json/.test(rr.out) && JSON.parse(fs.readFileSync(path.join(r2dir, 'hanrei_v1', 'cases_0900.json'), 'utf8'))['90001'].appeals, rr.out.slice(-300));
    fs.writeFileSync(bf, bkeep);
  }

  // ---- 戻す: この回の後に別の反映が入っていたら戻さない（後の更新を消さない）
  const c950f = path.join(r2dir, 'hanrei_v1', 'cases_0950.json');
  const c950keep = fs.readFileSync(c950f);
  fs.writeFileSync(c950f, JSON.stringify({ ...JSON.parse(c950keep), '95099': { id: '95099' } }));
  r = await run(['restore', 'run1'], env);
  check('restore: この回の後に変わったファイルがあれば、何も書かずに止まる', r.code !== 0 && /後に変わった/.test(r.out) && JSON.parse(fs.readFileSync(c950f, 'utf8'))['95099'] && fs.existsSync(path.join(r2dir, 'update_state', 'hanrei_state.json')));
  fs.writeFileSync(c950f, c950keep);

  // ---- 戻すのが途中で落ちても（ファイルは戻した・ベクトルはまだ）、restore をやり直せば戻る
  r = await run(['restore', 'run1'], { ...env, HANREI_TEST_FAIL_RESTORE_AT: 'vectors' });
  check('restore: ベクトルを戻す前に落ちた（確かめ用）・戻し中の印が残る', r.code !== 0 && !fs.existsSync(path.join(r2dir, 'hanrei_v1', 'cases_0950.json')) && JSON.parse(fs.readFileSync(vecFile, 'utf8'))['95002-y'] && (rj(r2dir, 'update_state/hanrei_apply_inprogress.json') || {}).kind === 'restore');
  r = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run1r' });
  m = man();
  check('戻しが途中で落ちていれば、次の prepare は止まる（戻しかけを前提に進めない）', r.code === 0 && !m.ok_to_apply && m.blockers.some((x) => /前回の戻し（run run1/.test(x)));
  r = await run(['restore', 'run2x'], env);
  check('別の回の restore は、印が残っている間は拒む', r.code !== 0);

  // ---- 戻す（run1 を戻すと、R2 とベクトルが最初の姿に戻る。台帳は run1 の前は無かったので消える）
  r = await run(['restore', 'run1'], env);
  const after = snapshot(r2dir);
  const hanreiOnly = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith('hanrei_v1/')));
  check('restore: hanrei_v1 のファイルが最初の姿に戻る・台帳は消える', r.code === 0 && JSON.stringify(hanreiOnly(after)) === JSON.stringify(hanreiOnly(r2Before)) && !after['update_state/hanrei_state.json'], r.out.slice(-400));
  const vdb2 = JSON.parse(fs.readFileSync(vecFile, 'utf8'));
  const preDir = fs.readdirSync(path.join(r2dir, 'update_state', 'hanrei_backup', 'run1')).find((n) => /^pre_restore_/.test(n));
  check('restore: 戻す直前の中身（ファイルとベクトル）を控える', preDir && fs.existsSync(path.join(r2dir, 'update_state', 'hanrei_backup', 'run1', preDir, 'vectors_current.json')) && JSON.parse(fs.readFileSync(path.join(r2dir, 'update_state', 'hanrei_backup', 'run1', preDir, 'vectors_current.json'), 'utf8')).some((v) => v.id === '95001-y'));
  check('restore: 途中で落ちた後のやり直しでも戻る。足したベクトルは消し、上書きした 95001-y は消さずに元の値へ・既存は残る', !vdb2['95002-y'] && vdb2['95001-y'] && vdb2['95001-y'].metadata.ttl === '前の残り' && vecIds0.every((id) => vdb2[id]) && Object.keys(vdb2).length === vecIds0.length + 1, JSON.stringify(Object.keys(vdb2)));
  check('restore: やり直した戻しが終わると印は消える', !fs.existsSync(path.join(r2dir, 'update_state', 'hanrei_apply_inprogress.json')));
  r = await run(['restore', 'run1'], env);
  check('restore: もう一度流しても同じ姿のまま（書く前の姿なので通る）', r.code === 0 && JSON.stringify(hanreiOnly(snapshot(r2dir))) === JSON.stringify(hanreiOnly(r2Before)), r.out.slice(-300));

  // ---- 反映が途中で落ちたら（R2 は書いた・ベクトルはまだ）、印が残り、次の prepare は書きかけを既知に取り込まずに止まる
  r = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run4' });
  r = await run(['apply'], { ...env, UPDATE_RUN_ID: 'run4', HANREI_TEST_FAIL_APPLY_AT: 'vectors' });
  check('apply が R2 を書いた後・ベクトルの前に落ちる（確かめ用）と、反映中の印が残る', r.code !== 0 && fs.existsSync(path.join(r2dir, 'hanrei_v1', 'cases_0950.json')) && rj(r2dir, 'update_state/hanrei_apply_inprogress.json').run_id === 'run4' && !fs.existsSync(path.join(r2dir, 'update_state', 'hanrei_state.json')));
  r = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run5' });
  m = man();
  check('印が残っていれば prepare は止まる（書きかけの判例を既知の台帳に取り込まない）', r.code === 0 && !m.ok_to_apply && m.blockers.some((x) => /途中で止まっている.*restore_run_id=run4/.test(x)) && m.known_count === 0);
  r = await run(['apply'], { ...env, UPDATE_RUN_ID: 'run5' });
  check('印が残っていれば apply も止まる', r.code !== 0);
  r = await run(['restore', 'run4'], env);
  check('restore で戻すと印も消え、R2 は最初の姿に戻る', r.code === 0 && !fs.existsSync(path.join(r2dir, 'update_state', 'hanrei_apply_inprogress.json')) && JSON.stringify(hanreiOnly(snapshot(r2dir))) === JSON.stringify(hanreiOnly(r2Before)), r.out.slice(-300));
  r = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run6' });
  m = man();
  check('戻した後の prepare は、また初回として通る', r.code === 0 && m.ok_to_apply && m.first_run && m.known_count === 4);

  // ---- apply が退避の途中で強制終了（catch も動かない）→ 印は 'backup' のまま残る。本番は書いていないので restore で印だけ外せる
  r = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run7' });
  r = await run(['apply'], { ...env, UPDATE_RUN_ID: 'run7', HANREI_TEST_KILL_APPLY_AT: 'backup' });
  const lk7 = rj(r2dir, 'update_state/hanrei_apply_inprogress.json');
  check('退避の途中で強制終了すると印は backup のまま残り、本番（hanrei_v1）は変わっていない', r.code !== 0 && lk7 && lk7.run_id === 'run7' && lk7.phase === 'backup' && JSON.stringify(hanreiOnly(snapshot(r2dir))) === JSON.stringify(hanreiOnly(r2Before)));
  r = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run8' });
  m = man();
  check('その印が残っていれば prepare は止まり、「本番を書く前・印だけ外す」と案内する', !m.ok_to_apply && m.blockers.some((x) => /本番を書く前.*restore_run_id=run7 で印だけ外して/.test(x)));
  r = await run(['restore', 'run7'], env);
  check('restore で印だけ外れ（退避が無くても）、次の prepare は通る', r.code === 0 && /印だけ外した/.test(r.out) && !fs.existsSync(path.join(r2dir, 'update_state', 'hanrei_apply_inprogress.json')) && (await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run9' })).code === 0 && man().ok_to_apply);

  // ---- 上限を超えたら止める（apply も拒む）
  fs.mkdirSync(path.join(r2dir, 'update_state'), { recursive: true });
  fs.writeFileSync(path.join(r2dir, 'update_state', 'hanrei_state.json'), JSON.stringify({ ids: ['90001'], slices: {} }));
  r = await run(['prepare'], { ...env, UPDATE_RUN_ID: 'run3', HANREI_MAX_NEW: '1' });
  m = man();
  check('新しい判例が上限を超えたら止める', !m.ok_to_apply && m.blockers.some((x) => /上限/.test(x)));
  r = await run(['apply'], { ...env, UPDATE_RUN_ID: 'run3' });
  check('止めた回の apply は書かない', r.code !== 0 && /blockers/.test(r.out));

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `\n${fails} 件失敗` : '\nすべて通過');
  process.exit(fails ? 1 : 0);
})();
