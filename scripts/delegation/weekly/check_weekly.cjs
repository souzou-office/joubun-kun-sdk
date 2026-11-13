// 委任先の週次更新の確かめ（¥0・Cloudflare に要求を出さない・K: ドライブ不要）
//
//   node scripts/delegation/weekly/check_weekly.cjs
//
// 偽の R2（R2_FAKE_DIR）に条文（split.py と同じ形の条ごとのファイル）・refs・台帳・今の配信用チャンクを置き、build → apply → restore を流す。
// 紐付けは実物（01_extract_delegations・02_link_by_reverse・07 の slimLaw）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RUN = path.join(__dirname, 'run.cjs');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).slice(0, 2500)}` : ''}`); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-weekly-'));
const R2DIR = path.join(TMP, 'r2');
const VECFILE = path.join(TMP, 'vec.json');
const TITLES = path.join(TMP, 'titles.json');
const rk = (k) => path.join(R2DIR, ...k.split('/'));
const readR2J = (k) => (fs.existsSync(rk(k)) ? JSON.parse(fs.readFileSync(rk(k), 'utf8')) : null);
// 中身が同じなら書かない（法令の週次も変わったファイルしか書かない。書くと更新時刻が変わり、変わった法令に数えられる）
const putR2 = (k, o) => {
  const body = typeof o === 'string' ? o : JSON.stringify(o);
  if (fs.existsSync(rk(k)) && fs.readFileSync(rk(k), 'utf8') === body) return;
  fs.mkdirSync(path.dirname(rk(k)), { recursive: true }); fs.writeFileSync(rk(k), body);
};
const delR2 = (k) => fs.rmSync(rk(k), { recursive: true, force: true });

// ---------------------------------------------------------------- 偽の本番
const PARENT = '900AC0000000001', RULE = '900M60000010001', ORDER = '900CO0000000001', OTHER = '900AC0000000002', NEW = '900AC0000000003', GONE = '900AC0000000009';
fs.writeFileSync(TITLES, JSON.stringify({ 検査業法: PARENT, 検査業法施行令: ORDER, 検査業法施行規則: RULE }));
const sent = (text) => ({ text });
const art = (number, title, paragraphs, suppl) => ({ type: 'article', number, title, caption: '', paragraphs, ...(suppl ? { structure: { suppl: true } } : {}) });
const para = (num, sentences) => ({ num, sentences, items: [] });
// split.py と同じ形（_index.json と、題名ごとのファイル）
function putLaw(id, title, lawNum, articles) {
  // 変わったファイルだけ書き、無くなったファイルだけ消す（法令の週次と同じ。書き直すと更新時刻が変わって「変わった法令」に数えられる）
  const dir = rk(`arts/${id}`);
  const keep = new Set([...articles.map((a) => `${a.title}.json`), '_index.json']);
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  const meta = { law_id: id, law_title: title, law_num: lawNum, law_type: 'Act' };
  const grouped = new Map();
  for (const a of articles) { if (!grouped.has(a.title)) grouped.set(a.title, []); grouped.get(a.title).push(a); }
  const files = [];
  for (const [t, list] of grouped) { putR2(`arts/${id}/${t}.json`, { ...meta, articles: list }); files.push({ title: t, filename: `${t}.json` }); }
  putR2(`arts/${id}/_index.json`, { ...meta, article_count: articles.length, files });
}
const parentArticles = (extra = []) => [
  art('7', '第七条', [para('1', [sent('検査業者は、政令で定める期間内に届け出なければならない。')])]),
  art('49', '第四十九条', [para('1', [sent('検査業者は、届け出なければならない。')]), para('2', [sent('前項の届出は、法務省令で定める者を経由してすることができる。')])]),
  ...extra,
  art('1', '第一条', [para('1', [sent('この法律は、公布の日から施行する。政令で定める日から適用する。')])], true),   // 附則（紐付けの対象外）
];
const ruleText = '法第四十九条第二項に規定する法務省令で定める者は、登記所とする。';
function setLaws({ rule = ruleText, other = 'この法律は、検査について定める。', withNew = false, withParent = true } = {}) {
  if (withParent) putLaw(PARENT, '検査業法', '令和八年法律第一号', parentArticles()); else delR2(`arts/${PARENT}`);
  putLaw(RULE, '検査業法施行規則', '令和八年法務省令第一号', [art('1', '第一条', [para('1', [sent(rule)])])]);
  putLaw(ORDER, '検査業法施行令', '令和八年政令第一号', [art('1', '第一条', [para('1', [sent('法第七条に規定する政令で定める期間は、三十日とする。')])])]);
  putLaw(OTHER, '別の法', '令和八年法律第二号', [art('1', '第一条', [para('1', [sent(other)])])]);
  if (withNew) putLaw(NEW, '新しい法', '令和八年法律第三号', [art('1', '第一条', [para('1', [sent('新しい事業者は、政令で定める基準に従わなければならない。')])])]); else delR2(`arts/${NEW}`);
}
const vr = (src, start = 0) => ({ type: 'varref', abbreviation: '法', text: '法', start, end: start + 1, target_law_id: PARENT, paragraph: '1', item: null, sentence_index: 0 });
function setRefs({ ruleRefs = true } = {}) {
  putR2('refs/refs_index.json', { [PARENT]: 0, [RULE]: 0, [ORDER]: 0, [OTHER]: 0, [NEW]: 0 });
  putR2('refs/refs_chunk_000.json', {
    [PARENT]: { refs: {}, reverse_refs: {} },
    [RULE]: { refs: ruleRefs ? { [`${RULE}_Art1`]: [vr(RULE)] } : {}, reverse_refs: {} },
    [ORDER]: { refs: { [`${ORDER}_Art1`]: [vr(ORDER)] }, reverse_refs: {} },
    [OTHER]: { refs: {}, reverse_refs: {} },
    [NEW]: { refs: {}, reverse_refs: {} },
  });
}
let ledgerN = 0;
const bumpLedger = () => putR2('update_state/sync_state.json', { laws: {}, n: ++ledgerN });
// PC で作った今の本番: 第四十九条だけ（第七条の受け皿はまだ無かった）と、今は無い法令
function setProd() {
  const cand = { law_id: RULE, law_title: '検査業法施行規則', article: '1', article_title: '第一条', paragraph: '1', item: null, strength: 'strong', via_junyo: false };
  putR2('deleg/index.json', { [PARENT]: 0, [GONE]: 0 });
  putR2('deleg/chunk_000.json', {
    [PARENT]: { law_title: '検査業法', count: 1, articles: { 49: [{ paragraph: '2', item: null, expr: '法務省令で定める', kind: '省令', trailing: '者を経由してすること', status: 'confirmed', candidates: [cand] }] } },
    [GONE]: { law_title: '廃止された法', count: 1, articles: { 3: [{ paragraph: '1', item: null, expr: '政令で定める', kind: '政令', trailing: '', status: 'none', candidates: [] }] } },
  });
}

function run(args, env = {}, out = path.join(TMP, 'out')) {
  return new Promise((resolve) => {
    const e = { ...process.env, DELEG_WEEKLY_OUT: out, R2_FAKE_DIR: R2DIR, VECTORIZE_FAKE_FILE: VECFILE, DELEG_LAW_TITLES_JSON: TITLES,
      DELEG_ARTICLES_PREFIX: 'arts', DELEG_REFS_PREFIX: 'refs', DELEG_PREFIX: 'deleg', DELEG_VEC_POLL_MS: '0', DELEG_VEC_PACE_MS: '0', ...env };
    for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GITHUB_ACTIONS', 'DELEG_APPROVED', 'DELEG_FULL']) if (!(k in env)) delete e[k];
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
  const a = apply && m ? await run(['apply'], { ...(approve ? { DELEG_APPROVED: '1' } : {}), ...env }, out) : null;
  return { out, b, a, m };
}
const prodLaw = (id) => { const idx = readR2J('deleg/index.json'); return idx && idx[id] !== undefined ? (readR2J(`deleg/chunk_${String(idx[id]).padStart(3, '0')}.json`) || {})[id] : null; };

async function main() {
  {
    // 組み立て（r2laws.cjs の assembleLaw）: 附則は目次の附則のまとまりの順（制定時 → 改正法）に並べる。
    // 本則の第一条と同じファイルにある改正法の附則第一条が先に来ると、本則から番号が続く制定時の附則（第百二十二条〜）まで附則とみなされて紐付けから落ちる
    console.log('\n# 0. 附則の並び（本則から番号が続く制定時の附則は、PC と同じく本則と同じ扱い）');
    const { assembleLaw } = require('./r2laws.cjs');
    const { markProvisions } = require('../lib.cjs');
    const amend = (a) => ({ ...a, structure: { suppl: true, amend_law_num: '令和元年法律第一号' } });
    const A1 = art('1', '第一条', [para('1', [sent('本則')])]);
    const S1 = amend(art('1', '第一条', [para('1', [sent('改正法の附則')])]));
    const A121 = art('121', '第百二十一条', [para('1', [sent('本則の最後')])]);
    const S122 = art('122', '第百二十二条', [para('1', [sent('制定時の附則')])], true);
    const S133 = art('133', '第百三十三条', [para('1', [sent('制定時の附則。厚生労働省令で定める')])], true);
    const files = [{ articles: [A1, S1] }, { articles: [A121] }, { articles: [S122] }, { articles: [S133] }];
    const index = { law_id: 'X', law_title: 'X法', toc: [{ kind: 'suppl', title: '附則', first: '第百二十二条', count: 2 }, { kind: 'suppl', title: '附則（令和元年法律第一号）', first: '第一条', count: 1 }] };
    const law = assembleLaw(index, files);
    const marks = markProvisions(law.articles).map((a) => `${a.number}:${a.provision}`).join(',');
    check('附則を目次の順に並べる（本則 → 制定時の附則 → 改正法の附則）・制定時の附則は本則と同じ扱い（PC の文書順と同じ）', marks === '1:main,121:main,122:main,133:main,1:suppl', marks);
    const noToc = markProvisions(assembleLaw({ law_id: 'X' }, files).articles).map((a) => `${a.number}:${a.provision}`).join(',');
    check('目次が無ければ今までどおり files の順', noToc === '1:main,121:main,1:suppl,122:suppl,133:suppl', noToc);
  }
  setLaws(); setRefs(); bumpLedger(); setProd();

  console.log('\n# 1. 初回（PC で作った今の本番）: 全法令をやり直して比べる → 見直す対象 → 承認で反映');
  let w = await week(1, { apply: false });
  check('build が通る・全法令をやり直す・見直す対象', w.b.code === 0 && w.m && w.m.full && w.m.needs_review && w.m.ok_to_apply, w.b.out.slice(-2000));
  check('検査業法（第七条の受け皿が増える）と今は無い法令が変わる', w.m && w.m.counts.changed_laws === 2 && w.m.changed.some((c) => c.id === PARENT) && w.m.changed.some((c) => c.id === GONE), JSON.stringify(w.m && w.m.changed));
  let r = await run(['apply'], {}, w.out);
  check('承認なし → 反映しない', r.code !== 0 && /「反映」コメントからしか/.test(r.out), r.out.slice(-400));
  r = await run(['apply'], { DELEG_APPROVED: '1' }, w.out);
  const p1 = prodLaw(PARENT);
  check('承認で反映 → 状態の控えができる', r.code === 0 && readR2J('update_state/delegations/state.json'), r.out.slice(-800));
  check('第七条 → 施行令 第一条（確定）・第四十九条 → 施行規則 第一条（確定）', p1 && p1.articles['7'] && p1.articles['7'][0].status === 'confirmed' && p1.articles['7'][0].candidates[0].law_id === ORDER
    && p1.articles['49'][0].status === 'confirmed' && p1.articles['49'][0].candidates[0].law_id === RULE, JSON.stringify(p1));
  check('附則の委任は載せない・今は無い法令は一覧から外れる', p1 && Object.keys(p1.articles).sort().join() === '49,7' && !readR2J('deleg/index.json')[GONE] && !readR2J('deleg/chunk_000.json')[GONE], JSON.stringify(readR2J('deleg/index.json')));

  console.log('\n# 2. 変わらない週 → 何もしない回');
  w = await week(2);
  check('何もしない回（nothing_to_do）・やり直した法令 0', w.m && w.m.nothing_to_do && w.m.counts.recomputed === 0 && w.a && /反映するものが無い/.test(w.a.out), JSON.stringify(w.m && { c: w.m.counts, rv: w.m.review, s: w.m.state_changed }));

  console.log('\n# 3. 委任に関係ない法令だけ変わる → その法令だけやり直す（書くのは状態の控えだけ）');
  setLaws({ other: 'この法律は、検査の方法について定める。' }); bumpLedger();
  w = await week(3);
  check('やり直すのは 1 法令・配信用ファイルは書かない・状態の控えは進める（自動で反映）', w.m && w.m.counts.recomputed === 1 && !Object.keys(w.m.files).length && w.m.state_changed && !w.m.needs_review && w.a && w.a.code === 0, JSON.stringify(w.m && { c: w.m.counts, f: w.m.files }) + (w.a ? w.a.out.slice(-400) : ''));
  w = await week('3b');
  check('　→ 次の週は何もしない', w.m && w.m.nothing_to_do, JSON.stringify(w.m && w.m.counts));

  console.log('\n# 4. 子（施行規則）の受け皿の文が変わる → 親（検査業法）をやり直す（自動で反映）');
  const OTHER3 = 'この法律は、検査の方法について定める。';
  setLaws({ rule: '法第四十九条第二項の規定による届出は、登記所を経由してする。', other: OTHER3 }); bumpLedger();
  w = await week(4);
  const p4 = prodLaw(PARENT);
  check('施行規則と、それが引く検査業法をやり直す', w.m && w.m.counts.recomputed === 2 && w.m.counts.changed_laws === 1, JSON.stringify(w.m && w.m.counts));
  check('反映 → 第四十九条は確定でなくなる（第七条はそのまま）', w.a && w.a.code === 0 && p4 && p4.articles['49'][0].status !== 'confirmed' && p4.articles['7'][0].status === 'confirmed', (w.a && w.a.out.slice(-400)) + JSON.stringify(p4 && p4.articles['49']));
  setLaws({ other: OTHER3 }); bumpLedger();
  w = await week('4b');
  check('　→ 戻すと確定に戻る', w.a && w.a.code === 0 && prodLaw(PARENT).articles['49'][0].status === 'confirmed', w.a && w.a.out.slice(-400));

  console.log('\n# 5. 新しい法令（委任あり）→ 最後のチャンクに足して一覧に載せる → 廃止 → 外す → 戻す');
  setLaws({ withNew: true, other: OTHER3 }); bumpLedger();
  w = await week(5);
  check('新しい法令を足す（index.json も書く）', w.a && w.a.code === 0 && prodLaw(NEW) && readR2J('deleg/index.json')[NEW] === 0 && w.m.files['deleg/index.json'], JSON.stringify(w.m && w.m.files) + (w.a ? w.a.out.slice(-400) : ''));
  setLaws({ withNew: false, other: OTHER3 }); bumpLedger();
  w = await week(6);
  check("廃止 → チャンクと一覧から外す", w.a && w.a.code === 0 && !prodLaw(NEW) && readR2J("deleg/index.json")[NEW] === undefined, (w.a && w.a.out.slice(0, 1200)) + JSON.stringify(w.m && { rv: w.m.review, bl: w.m.blockers }));
  r = await run(['restore', 'run-6'], {}, w.out);
  check('restore で戻る（一覧とチャンクに戻る）', r.code === 0 && prodLaw(NEW) && readR2J('deleg/index.json')[NEW] === 0, r.out.slice(-600));

  console.log('\n# 6. 止める: 古い下見・下見の途中の戻し・refs の欠け・委任の急減');
  setLaws({ withNew: false, other: 'この法律は、検査の手順について定める。' }); bumpLedger();
  w = await week(7, { apply: false });
  bumpLedger();
  r = await run(['apply'], {}, w.out);
  check('下見の後に法令の週次が反映された → 書かない', r.code !== 0 && /法令の週次が反映された/.test(r.out), r.out.slice(-400));
  w = await week(8, { apply: false, env: { DELEG_TEST_MID_BUILD: `"${process.execPath}" "${RUN}" restore run-6` } });
  check('下見の途中に戻しが入る → build が落ちる（成果物なし）', w.b.code === 1 && !w.m && /下見の途中で反映か戻しが入った/.test(w.b.out), w.b.out.slice(-600));
  const saved = readR2J('refs/refs_chunk_000.json');
  putR2('refs/refs_index.json', { [PARENT]: 0, [RULE]: 1 });
  w = await week(9, { apply: false });
  check('refs のチャンクが無い → build が落ちる', w.b.code === 1 && !w.m && /refs_chunk_001\.json が無い/.test(w.b.out), w.b.out.slice(-500));
  setRefs(); putR2('refs/refs_chunk_000.json', saved);
  setLaws({ withParent: false }); bumpLedger();
  w = await week(10, { apply: false, env: { DELEG_DROP_MIN: '0' } });
  check('委任の総数が 1 割超減る → 止める（exit 3）', w.b.code === 3 && w.m && !w.m.ok_to_apply && w.m.blockers.some((x) => /委任の総数が 1 割超かつ 0 件超減る/.test(x)), JSON.stringify(w.m && w.m.blockers) + w.b.out.slice(-400));

  const bump = `"${process.execPath}" -e "const p=require('path');require('fs').writeFileSync(p.join(process.env.R2_FAKE_DIR,'update_state','sync_state.json'),JSON.stringify({laws:{},n:'mid'}))"`;
  w = await week(11, { apply: false, env: { DELEG_TEST_MID_BUILD: bump } });
  check('下見の途中で法令の週次が反映された（台帳が変わった）→ build が落ちる', w.b.code === 1 && !w.m && /下見の途中で法令の週次が反映された/.test(w.b.out), w.b.out.slice(-600));

  console.log('\n# 7. 法令の週次の反映中・refs だけの書き換え・refs の法令の欠け');
  setLaws({ withParent: true, other: 'この法律は、検査の記録について定める。' }); bumpLedger();
  w = await week(12, { apply: false });
  const saved12 = readR2J('refs/refs_chunk_000.json');
  setRefs({ ruleRefs: true }); const c = readR2J('refs/refs_chunk_000.json'); c[OTHER].refs = { [`${OTHER}_Art1`]: [] }; putR2('refs/refs_chunk_000.json', c);
  r = await run(['apply'], {}, w.out);
  check('下見の後に refs のチャンクだけ書き換わった（refs_index.json はそのまま）→ 書かない', r.code !== 0 && /refs（refs）が書き換わった/.test(r.out), r.out.slice(-400));
  putR2('refs/refs_chunk_000.json', saved12);
  putR2('update_state/laws_apply_inprogress.json', { run_id: 'L1', mode: 'apply', started_at: 'x' });
  w = await week(13, { apply: false });
  check('法令の週次の反映中の印がある → 下見は止める（exit 3）', w.b.code === 3 && w.m && w.m.blockers.some((x) => /法令の週次の反映（run L1・apply・x 開始）が途中/.test(x)), JSON.stringify(w.m && w.m.blockers));
  delR2('update_state/laws_apply_inprogress.json');
  setLaws({ withParent: true, other: 'この法律は、検査の帳簿について定める。' }); bumpLedger();
  w = await week(14, { apply: false });
  putR2('update_state/laws_apply_inprogress.json', { run_id: 'L2', mode: 'refs', started_at: 'y' });
  r = await run(['apply'], {}, w.out);
  check('下見の後に法令の週次の反映が始まった → 書かない', r.code !== 0 && /法令の週次の反映（run L2）が途中/.test(r.out), r.out.slice(-400));
  delR2('update_state/laws_apply_inprogress.json');
  const mark = `"${process.execPath}" -e "const p=require('path');require('fs').writeFileSync(p.join(process.env.R2_FAKE_DIR,'update_state','laws_apply_inprogress.json'),JSON.stringify({run_id:'L3'}))"`;
  w = await week(15, { apply: false, env: { DELEG_TEST_MID_BUILD: mark } });
  check('下見の途中で法令の週次の反映が始まった → build が落ちる', w.b.code === 1 && !w.m && /下見の途中で法令の週次の反映が始まった/.test(w.b.out), w.b.out.slice(-400));
  delR2('update_state/laws_apply_inprogress.json');
  const c16 = readR2J('refs/refs_chunk_000.json'); delete c16[RULE]; putR2('refs/refs_chunk_000.json', c16);
  w = await week(16, { apply: false });
  check('refs_index.json が載せている法令がチャンクに無い → build が落ちる', w.b.code === 1 && !w.m && /refs_index\.json が載せている法令の refs が無い/.test(w.b.out), w.b.out.slice(-400));
  putR2('refs/refs_chunk_000.json', saved12);

  console.log('\n# 8. 紐付けに失敗した法令は、変わっていなくても次の回に必ずやり直す');
  setLaws({ other: 'この法律は、検査の帳簿について定める。', rule: '法第四十九条第二項の規定による届出は、登記所を経由してする。' }); bumpLedger();
  w = await week(17, { apply: false, env: { DELEG_TEST_FAIL_LAWS: PARENT } });
  check('子（施行規則）が変わってやり直した親（検査業法）が落ちた → 見直す対象・本番のまま', w.m && w.m.counts.errors === 1 && w.m.review.some((x) => /紐付けに失敗した法令 1/.test(x)) && !w.m.changed.some((c) => c.id === PARENT), JSON.stringify(w.m && { c: w.m.counts, rv: w.m.review, f: Object.keys(w.m.files) }));
  r = await run(['apply'], { DELEG_APPROVED: '1' }, w.out);
  check('　→ 承認で反映（控えを進める）・控えに失敗した法令が残る', r.code === 0 && (readR2J('update_state/delegations/state.json').failed || []).join() === PARENT, r.out.slice(-400));
  w = await week(18);
  check('次の週: 何も変わっていなくても検査業法をやり直し、今度は通る（自動で反映・控えから外れる）', w.m && w.m.notes.some((x) => /前の回に紐付けに失敗した法令 1/.test(x)) && w.m.counts.errors === 0 && w.a && w.a.code === 0 && (readR2J('update_state/delegations/state.json').failed || []).length === 0 && prodLaw(PARENT).articles['49'][0].status !== 'confirmed', JSON.stringify(w.m && { c: w.m.counts, n: w.m.notes }) + (w.a ? w.a.out.slice(-300) : ''));
  delR2('update_state/delegations/state.json');
  w = await week(19, { apply: false, env: { DELEG_TEST_FAIL_LAWS: OTHER } });
  r = await run(['apply'], { DELEG_APPROVED: '1' }, w.out);
  check('初回（控えが無い）に落ちた法令も控えに残る', w.m && w.m.full && w.m.counts.errors === 1 && r.code === 0 && (readR2J('update_state/delegations/state.json').failed || []).join() === OTHER, r.out.slice(-300));
  w = await week(20);
  check('　→ 次の週にやり直して通る（何も変わっていないが 1 法令をやり直す）', w.m && w.m.notes.some((x) => /前の回に紐付けに失敗した法令 1/.test(x)) && w.m.counts.recomputed === 1 && w.m.counts.errors === 0 && (readR2J('update_state/delegations/state.json').failed || []).length === 0, JSON.stringify(w.m && { c: w.m.counts, n: w.m.notes }));

  console.log('\n# 8b. 親を引いていない専属の施行令だけが変わる → 親もやり直す');
  const c8 = readR2J('refs/refs_chunk_000.json'); c8[ORDER].refs = {}; putR2('refs/refs_chunk_000.json', c8);
  w = await week('20a');   // 施行令の refs が変わる回（この回は refs の変化で施行令をやり直す。控えの targets は空になる）
  setLaws({ other: 'この法律は、検査の帳簿について定める。', rule: '法第四十九条第二項の規定による届出は、登記所を経由してする。' });   // 他は前の回と同じ
  putLaw(ORDER, '検査業法施行令', '令和八年政令第一号', [art('1', '第一条', [para('1', [sent('法第七条に規定する政令で定める期間は、六十日とする。')])])]); bumpLedger();
  w = await week('20b', { apply: false });
  check('施行令の条文だけ変わる（refs は親を引いていない）→ 題名の関係で検査業法もやり直す', w.m && w.m.counts.recomputed === 2, JSON.stringify(w.m && w.m.counts));
  setRefs();

  console.log('\n# 9. 下見の後に条文のプレフィックスが切り替わった → 書かない');
  setLaws({ other: 'この法律は、検査の台帳について定める。' }); bumpLedger();
  w = await week(21, { apply: false });
  r = await run(['apply'], { DELEG_ARTICLES_PREFIX: 'arts2' }, w.out);
  check('条文のプレフィックスだけ変わった → 書かない', r.code !== 0 && /条文か refs のプレフィックスが変わった/.test(r.out), r.out.slice(-400));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
