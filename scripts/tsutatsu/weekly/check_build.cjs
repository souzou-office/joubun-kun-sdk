// 通達の週次 段 3a（build.cjs）の確かめ。¥0・国税庁にも Cloudflare にも要求を出さない。
//
//   node scripts/tsutatsu/weekly/check_build.cjs
//
// 03・07・08 は test_stubs/ の代わり（本物と同じ形のファイルを書く）。R2 は R2_FAKE_DIR、Vectorize は VECTORIZE_FAKE_FILE、埋め込みは AI_FAKE=1。
// 本番のチャンクからの PDF と浮きの引き継ぎ、法令ファイルの差分、ベクトルの分け方（新しい・本文が変わった・metadata だけ・消す）、
// 初回の状態づくり、巨大条文、止める条件・見直す対象、書かないこと、を見る。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { TMP, R2DIR, VECFILE, PROD, STAMP, HOJIN, SOZOKU, CHOSYU, NTA, PDF_A, baseItems, putProd, putVectors, runBuild } = require('./test_stubs/harness.cjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).slice(0, 2000)}` : ''}`); }
}

async function main() {
  console.log('\n# 1. 変わらない週（本番と同じ中身）');
  let items = baseItems();
  let { links } = putProd(items);
  await putVectors(links, items);
  let r = runBuild(items);
  check('終了コード 0', r.code === 0, r.out);
  check('本番の PDF を引き継いだ（a.pdf が 22 条に残る）・浮きの 9-1 を本番の 34 条から引き継いだ → 変わる法令ファイル 0', r.m && r.m.changed_laws.length === 0 && r.m.added_laws.length === 0 && !Object.keys(r.m.files).length, JSON.stringify(r.m && { c: r.m.changed_laws, a: r.m.added_laws, f: Object.keys(r.m.files) }));
  check('ベクトルも変わらない（埋め込み 0・metadata 0・削除 0）', r.m && r.m.vectors.upsert === 0 && r.m.vectors.meta_update === 0 && r.m.vectors.delete === 0, JSON.stringify(r.m && r.m.vectors));
  check('何もしない回（nothing_to_do）・止めない', r.m && r.m.nothing_to_do && r.m.ok_to_apply && !r.m.needs_review);
  check('埋め込みの自己一致を確かめた（1.0000）', /自己一致: 1\.0000/.test(r.report), r.report);
  check('R2 にも Vectorize にも書かない', r.r2Unchanged);
  const again = runBuild(items, { outDir: r.dir });
  check('同じ作業フォルダでもう一度流しても同じ（前回戻した浮きの割当を失わない）', again.code === 0 && again.m && again.m.nothing_to_do && again.m.orphans === 0 && /本番から引き継いだ 1 本/.test(again.out), JSON.stringify(again.m && { c: again.m.changed_laws, v: again.m.vectors, o: again.m.orphans }));

  console.log('\n# 2. 本文が 1 本変わり、1 本増え、1 本消え、紐付け先が 1 本変わる');
  const it2 = baseItems();
  it2[1].body = '資産の販売に係る収益の額は、原則として、その引渡しの日の属する事業年度の益金の額に算入する（改正）。';
  it2.push({ ...it2[0], tsutatsu_no: '22-3', caption: '（新設）', body: '新しく設けられた取扱い。内国法人の収益の計上時期について次による。' });
  const removed = it2.splice(2, 1)[0];   // 34-1 を消す
  it2.find((o) => o.tsutatsu_no === '3-1').home = `${SOZOKU}:3の2`;   // 3-1 の紐付け先が変わる（homes が変わる）
  r = runBuild(it2);
  check('終了コード 0', r.code === 0, r.out);
  check('変わる法令ファイル: 法人税法・相続税法', r.m && r.m.changed_laws.sort().join(',') === [HOJIN, SOZOKU].sort().join(','), JSON.stringify(r.m && r.m.changed_laws));
  check('index.json の sha_before は比べた本番の index.json の中身の hash', r.m && r.m.files[`${PROD}/index.json`] && r.m.files[`${PROD}/index.json`].sha_before === require('crypto').createHash('sha256').update(fs.readFileSync(path.join(R2DIR, PROD, 'index.json'))).digest('hex'));
  check('法令ファイルと index.json を成果物に置き、本番の中身の hash を控える', r.m && r.m.files[`${PROD}/${HOJIN}.json`] && r.m.files[`${PROD}/${HOJIN}.json`].sha_before && r.m.files[`${PROD}/index.json`] && fs.existsSync(path.join(r.B, 'files', `${HOJIN}.json`)));
  const upIds = new Set(r.vectors.map((v) => v.id));
  const md5 = (s) => require('crypto').createHash('md5').update(s).digest('hex');
  check('本文が変わった 22-2 と新しい 22-3 は埋め込む（_reverse）', upIds.has(md5(`rev|${NTA}/kihon/hojin/01.htm|22-2`)) && upIds.has(md5(`rev|${NTA}/kihon/hojin/01.htm|22-3`)), JSON.stringify(r.m && r.m.vectors));
  check('埋め込みは 1024 次元の数', r.vectors.length > 0 && r.vectors.every((v) => Array.isArray(v.values) && v.values.length === 1024));
  check('紐付け先だけ変わった 3-1 は metadata だけ（埋め込み直さない）', r.meta.some((u) => u.id === md5(`rev|${NTA}/kihon/sisan/sozoku2/01.htm|3-1`)) && !upIds.has(md5(`rev|${NTA}/kihon/sisan/sozoku2/01.htm|3-1`)));
  check('通達が 1 本だけの条から消えた（相続税法 3 条 1 → 0）も見直す対象', r.m && r.m.review.some((b) => /3 割超減った条/.test(b) && b.includes(`${SOZOKU}:3（1 → 0）`)), JSON.stringify(r.m && r.m.review));
  check('消えた 34-1 は削除', r.deletes.some((d) => d.id === md5(`rev|${NTA}/kihon/hojin/01.htm|34-1`)), JSON.stringify(r.deletes));
  check('変わっていない巨大条文（徴収法 47 条）は触らない', !r.vectors.some((v) => v.namespace === `${CHOSYU}:47`) && !r.deletes.some((d) => d.namespace === `${CHOSYU}:47`));
  check('次の状態の控え（vec_state_next）に新しい id があり、消えた id は無い', (() => { const s = JSON.parse(fs.readFileSync(path.join(r.B, 'vec_state_next.json'), 'utf8')); return s[md5(`rev|${NTA}/kihon/hojin/01.htm|22-3`)] && !s[md5(`rev|${NTA}/kihon/hojin/01.htm|34-1`)]; })());
  check('R2 にも Vectorize にも書かない', r.r2Unchanged);
  void removed;

  console.log('\n# 3. 浮きの引き継ぎ: 見出しが変わった浮きは引き継がない');
  const it3 = baseItems();
  it3.find((o) => o.tsutatsu_no === '9-1').caption = '（役員報酬の改正後の見出し）';
  r = runBuild(it3);
  check('9-1 が 34 条から外れる（法人税法のファイルが変わる）・浮きとして数える', r.m && r.m.changed_laws.includes(HOJIN) && r.m.orphans === 1, JSON.stringify(r.m && { c: r.m.changed_laws, o: r.m.orphans }));
  check('浮きは報告に並べない（本番にも出ていない）', !/浮き/.test(r.report), r.report);

  console.log('\n# 4. 新しい PDF（本番に無い）は本文を読む対象になる');
  r = runBuild(baseItems(), { pdfManifest: [{ url: PDF_A, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/a.pdf` }, { url: `${NTA}/kobetsu/hojin/new.pdf`, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/new.pdf` }] });
  check('新しい PDF 1 本を数える（本文は確かめ用に読まない）', r.m && r.m.new_pdfs === 1 && /新しい PDF 1 本の本文を読まなかった/.test(r.report), r.report);

  console.log('\n# 4b. 本番にある PDF が消えた・中身が変わった → 見直す対象（黙って本番のまま引き継がない）');
  r = runBuild(baseItems(), { pdfManifest: [{ url: `${NTA}/kobetsu/hojin/other.pdf`, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/other.pdf` }] });
  check('消えた a.pdf を外す（法人税法のファイルが変わる）・見直す対象に URL', r.code === 0 && r.m && r.m.pdfs_gone.includes(PDF_A) && r.m.changed_laws.includes(HOJIN) && r.m.review.some((b) => /国税庁から消えたので外す/.test(b) && b.includes(PDF_A)), JSON.stringify(r.m && { g: r.m.pdfs_gone, c: r.m.changed_laws, rv: r.m.review }));
  r = runBuild(baseItems(), { pdfManifest: [{ url: PDF_A, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/a.pdf`, error: 'HTTP 500' }] });
  check('取れなかっただけの PDF は外さない', r.code === 0 && r.m && !r.m.pdfs_gone.length && !r.m.changed_laws.length, JSON.stringify(r.m && { g: r.m.pdfs_gone, c: r.m.changed_laws }));
  r = runBuild(baseItems(), { pdfChanged: [PDF_A] });
  check('中身が変わった a.pdf（前回の取り直しとの差）→ 紐付けは本番のまま・見直す対象（何もしない回にしない）', r.code === 0 && r.m && r.m.pdfs_changed.includes(PDF_A) && !r.m.changed_laws.length && r.m.needs_review && !r.m.nothing_to_do, JSON.stringify(r.m && { ch: r.m.pdfs_changed, rv: r.m.review }));
  const bsk = path.join(R2DIR, 'update_state', 'tsutatsu', 'build_state.json');
  fs.mkdirSync(path.dirname(bsk), { recursive: true });
  fs.writeFileSync(bsk, JSON.stringify({ orphans: 0, pdf_hashes: { [PDF_A]: 'h:前回反映したときの中身' } }));
  r = runBuild(baseItems());
  check('前回反映したときの PDF の hash と違う → 中身が変わった（取り直しの差が無くても拾う）', r.code === 0 && r.m && r.m.pdfs_changed.includes(PDF_A), JSON.stringify(r.m && r.m.pdfs_changed));
  fs.writeFileSync(bsk, JSON.stringify({ orphans: 0, pdf_hashes: { [PDF_A]: `h:${PDF_A}` } }));
  r = runBuild(baseItems(), { pdfChanged: [PDF_A] });
  check('前回反映したときと同じ hash なら、取り直しの差があっても変わっていない', r.code === 0 && r.m && !r.m.pdfs_changed.length && r.m.nothing_to_do, JSON.stringify(r.m && r.m.pdfs_changed));
  check('今回の PDF の hash を成果物に置く（反映したら次の比べる元になる）', JSON.parse(fs.readFileSync(path.join(r.B, 'pdf_hashes.json'), 'utf8'))[PDF_A] === `h:${PDF_A}`);
  // 取れなかった回 → その成果物を反映した（build_state に採った）→ 次の回に違う中身で取れた、でも見逃さない
  fs.writeFileSync(bsk, JSON.stringify({ orphans: 0, pdf_hashes: { [PDF_A]: 'h:反映したときの中身' } }));
  r = runBuild(baseItems(), { pdfManifest: [{ url: PDF_A, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/a.pdf`, error: 'HTTP 500' }] });
  const carried = r.m && JSON.parse(fs.readFileSync(path.join(r.B, 'pdf_hashes.json'), 'utf8'));
  check('取れなかった既存の PDF は比べず、前回反映したときの hash を次の比べる元に持ち越す', r.code === 0 && r.m && !r.m.pdfs_changed.length && carried[PDF_A] === 'h:反映したときの中身', JSON.stringify(carried));
  fs.writeFileSync(bsk, JSON.stringify({ orphans: 0, pdf_hashes: carried }));
  r = runBuild(baseItems(), { pdfHash: { [PDF_A]: 'h:差し替えた中身' } });
  check('　→ 次の回に違う中身で取れたら、中身が変わったとして見直す対象', r.code === 0 && r.m && r.m.pdfs_changed.includes(PDF_A) && r.m.needs_review, JSON.stringify(r.m && r.m.pdfs_changed));
  fs.writeFileSync(bsk, JSON.stringify({ orphans: 0, pdf_hashes: {} }));
  r = runBuild(baseItems());
  check('前回の hash が無い既存の PDF は「変わっていない」にしない（見直す対象）', r.code === 0 && r.m && r.m.pdfs_changed.includes(PDF_A) && r.m.review.some((b) => /前回の中身が分からない/.test(b)), JSON.stringify(r.m && r.m.review));
  fs.rmSync(bsk, { force: true });

  console.log('\n# 5. 初回（vec_state.json が無い）: Vectorize の実物から状態を作る');
  items = baseItems();
  ({ links } = putProd(items));
  const d5 = await putVectors(links, items, { state: false });
  // Vectorize から 1 本消しておく（本番の作り直しで入っていなかったもの）＋本番のチャンクには無い古い id を 1 本足す
  const db = JSON.parse(fs.readFileSync(VECFILE, 'utf8'));
  const missing = md5(`rev|${NTA}/kihon/hojin/01.htm|22-1`);
  delete db[missing];
  db.deadbeef = { values: db[Object.keys(db)[0]].values, metadata: { no: 'x' }, namespace: '_reverse' };
  // metadata だけ古い 1 本（homes が古い）
  const stale = md5(`rev|${NTA}/kihon/sisan/sozoku2/01.htm|3-1`);
  db[stale].metadata = { ...db[stale].metadata, homes: '[]' };
  fs.writeFileSync(VECFILE, JSON.stringify(db));
  r = runBuild(items);
  check('終了コード 0・初回は見直す対象（オーナーの「反映」を通る）', r.code === 0 && r.m && r.m.first_run && r.m.needs_review && /初回/.test(r.m.review.join()), r.out.slice(-1500));
  check('Vectorize に無い 1 本を埋め込む', r.vectors.length === 1 && r.vectors[0].id === missing, JSON.stringify(r.m && r.m.vectors));
  check('metadata が古い 1 本は metadata だけ', r.meta.length === 1 && r.meta[0].id === stale);
  check('本番のチャンクにも今回にも無い id は消さない（初回は本番のチャンクから候補を作る）', !r.deletes.some((x) => x.id === 'deadbeef'));
  check('あるべき全体が状態の控えに入る', Object.keys(JSON.parse(fs.readFileSync(path.join(r.B, 'vec_state_next.json'), 'utf8'))).length === d5.size);
  check('R2 にも Vectorize にも書かない（初回でも）', r.r2Unchanged);
  // 初回で、本番のチャンク（＝既存ベクトルの埋め込み元）から本文が変わっている通達 → 埋め込み直す（今回の本文の hash を控えにしない）
  await putVectors(links, items, { state: false });
  const it5 = baseItems();
  it5.find((o) => o.tsutatsu_no === '22-2').body = '資産の販売に係る収益の額は、原則として、引渡しの日の属する事業年度の益金の額に算入する（初回の取得で改正）。';
  r = runBuild(it5);
  check('初回で本文が変わった 22-2 は埋め込み直す（本番のチャンクの本文と比べる）', r.code === 0 && r.vectors.some((v) => v.id === md5(`rev|${NTA}/kihon/hojin/01.htm|22-2`)) && r.m.vectors.upsert_text >= 1, JSON.stringify(r.m && r.m.vectors));
  check('本文が変わらない既存は埋め込み直さない・ずれの確かめにも使う（1.0000）', r.m && r.m.vectors.upsert === 1 && /自己一致: 1\.0000/.test(r.report), r.report);
  await putVectors(links, items);   // 以降のために戻す

  console.log('\n# 5b. 本番で 2 つの条に付いていた浮きは、両方の条に戻す');
  const hj = path.join(R2DIR, PROD, `${HOJIN}.json`);
  const hojinProd = JSON.parse(fs.readFileSync(hj, 'utf8'));
  const e91 = hojinProd['34'].find((t) => t.no === '9-1');
  hojinProd['35'] = [e91];
  fs.writeFileSync(hj, JSON.stringify(hojinProd));
  const idxProd = JSON.parse(fs.readFileSync(path.join(R2DIR, PROD, 'index.json'), 'utf8'));
  idxProd.laws[HOJIN] = { articles: Object.keys(hojinProd).length, refs: Object.values(hojinProd).reduce((n, a) => n + a.length, 0) };
  fs.writeFileSync(path.join(R2DIR, PROD, 'index.json'), JSON.stringify(idxProd));
  r = runBuild(baseItems());
  check('9-1 が 34 条と 35 条の両方に戻る（法令ファイルが変わらない）', r.code === 0 && r.m && !r.m.changed_laws.length && /2 条目以降 1 本の紐付けを戻した/.test(r.report), JSON.stringify(r.m && { c: r.m.changed_laws, n: r.m.notes }));
  ({ links } = putProd(items));   // 戻す
  await putVectors(links, items);

  console.log('\n# 5c. 新しい PDF が読めない（05 は正常に終わるが、1 本だけ読めない）→ 見直す対象');
  const py = process.env.TSU_PYTHON || '/tmp/venv_pdf/bin/python';
  const hasPdfplumber = spawnSync(py, ['-c', 'import pdfplumber'], { encoding: 'utf8' }).status === 0;
  if (!hasPdfplumber) { console.log('  （pdfplumber のある python が無いので飛ばす。TSU_PYTHON で渡す）'); }
  else {
    r = runBuild(baseItems(), { env: { TSU_SKIP_PDF_TEXT: '', TSU_PYTHON: py }, pdfManifest: [
      { url: PDF_A, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/a.pdf`, body: '%PDF-1.4 本番にある PDF（読まない）' },
      { url: `${NTA}/kobetsu/hojin/broken.pdf`, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/broken.pdf`, body: '%PDF-1.4 壊れた PDF' },
    ] });
    check('終了コード 0・読めない PDF を数える（紐付けない）・ログに URL', r.code === 0 && r.m && r.m.pdf_unreadable === 1 && /1 本を読めなかった/.test(r.out) && r.out.includes('broken.pdf'), JSON.stringify(r.m && r.m.review) + r.out.slice(-600));
    check('前回の数が無い・前回から増えていない → 見直す対象にしない（毎週同じものを出さない）', r.m && !r.m.review.some((b) => /読めない PDF/.test(b)), JSON.stringify(r.m && r.m.review));
    const bsk5 = path.join(R2DIR, 'update_state', 'tsutatsu', 'build_state.json');
    fs.mkdirSync(path.dirname(bsk5), { recursive: true });
    fs.writeFileSync(bsk5, JSON.stringify({ orphans: 0, pdf_hashes: { [PDF_A]: `h:${PDF_A}` }, pdf_unreadable: 0 }));
    const many = Array.from({ length: 52 }, (_, i) => ({ url: `${NTA}/kobetsu/hojin/broken${i}.pdf`, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/broken${i}.pdf`, body: '%PDF-1.4 壊れた PDF' }));
    r = runBuild(baseItems(), { env: { TSU_SKIP_PDF_TEXT: '', TSU_PYTHON: py }, pdfManifest: [{ url: PDF_A, local_path: `all_tsutatsu_${STAMP}/kobetsu/hojin/a.pdf`, body: '%PDF-1.4 本番にある PDF（読まない）' }, ...many] });
    check('読めない PDF が前回より 50 本超増えた → 見直す対象（読み取りが崩れた疑い）', r.code === 0 && r.m && r.m.needs_review && r.m.review.some((b) => /読めない PDF が前回より 52 本増えた/.test(b)), JSON.stringify(r.m && r.m.review));
    fs.rmSync(bsk5, { force: true });
  }

  console.log('\n# 6. 止める条件');
  r = runBuild(baseItems().filter((o) => !o.home || !o.home.startsWith(SOZOKU)));
  check('本番にある法令（相続税法）が消えた → 止める', r.code === 3 && r.m && r.m.blockers.some((b) => /消えた/.test(b) && b.includes(SOZOKU)), JSON.stringify(r.m && r.m.blockers));
  r = runBuild(baseItems().filter((o) => !(o.home && o.home.endsWith(':47') && Number(o.tsutatsu_no.split('-')[1]) > 10)));
  check('参照の総数が 1 割超減った → 止める', r.code === 3 && r.m && r.m.blockers.some((b) => /1 割超減った/.test(b)), JSON.stringify(r.m && r.m.blockers));
  check('通達の本数が 3 割超減った条 → 見直す対象にも出る', r.m && r.m.review.some((b) => /3 割超減った条/.test(b) && b.includes(`${CHOSYU}:47`)));
  await putVectors(links, items, { drift: true });
  r = runBuild(baseItems());
  check('埋め込みのずれ（既存と 0.98 未満）→ 止める', r.code === 3 && r.m && r.m.blockers.some((b) => /ずれ/.test(b)), JSON.stringify(r.m && r.m.blockers));
  await putVectors(links, items);
  r = runBuild(baseItems(), { env: { TSU_STUB_FAIL_08: '1' } });
  check('08 が落ちた → 落ちる（成果物を作らない）', r.code === 1 && !r.m, r.out.slice(-500));
  r = runBuild(baseItems(), { env: { TSU_STUB_KILL_07_SECOND: '1' } });
  check('2 回目の 07 がシグナルで落ちた → 落ちる（1 回目の出力で先に進まない・成果物を作らない）', r.code === 1 && !r.m && /07_build_links（2 回目）が落ちた/.test(r.out), r.out.slice(-500));
  r = runBuild(baseItems(), { env: { TSU_MAX_CHANGED_FILES: '0' } });
  check('変わる法令ファイルが上限超 → 見直す対象（上限 0 で確かめる。変わらない週は出ない）', r.m && !r.m.review.some((b) => /法令ファイル/.test(b)));
  const it7 = baseItems(); it7[0].body += '（改正）';
  r = runBuild(it7, { env: { TSU_MAX_CHANGED_FILES: '0' } });
  check('　→ 変わる週は出る', r.m && r.m.review.some((b) => /変わる法令ファイルが 1 本/.test(b)), JSON.stringify(r.m && r.m.review));

  console.log('\n# 7. 前の段の出力が欠けている・壊れている → 止める（消えたものとして差分を作らない）');
  const good = baseItems().map((o) => JSON.stringify(o));
  r = runBuild(null, { rawItems: [good[0], '{壊れた行', ...good.slice(1)].join('\n') + '\n' });
  check('03 の出力に壊れた行 → ファイル名と行番号を出して落ちる（成果物なし）', r.code === 1 && !r.m && /tsutatsu_items_20260927\.ndjson の 2 行目が読めない/.test(r.out), r.out.slice(-500));
  r = runBuild(null, { rawItems: '' });
  check('03 の出力が空 → 落ちる', r.code === 1 && !r.m && /が空/.test(r.out), r.out.slice(-400));
  r = runBuild(baseItems(), { pdfManifest: null });
  check('PDF の manifest が無い → 落ちる（新しい PDF が無いのと区別する）', r.code === 1 && !r.m && /pdf_manifest_20260927\.ndjson が無い/.test(r.out), r.out.slice(-400));

  console.log('\n# 7b. ページの見出し（pages.json・page_titles.cjs）');
  const PAGES = {
    'kihon/hojin/01.htm': '<html><head><title>第1款 益金の額｜国税庁</title></head><body>本文</body></html>',
    'kihon/sisan/sozoku2/01.htm': '<html><head><title>〔みなし相続財産〕｜国税庁</title></head><body>本文</body></html>',
    'kihon/chosyu/01.htm': '<html><head><title>第47条関係 差押えの要件｜国税庁</title></head><body><a href="../../kobetsu/hojin/a.pdf">別紙</a></body></html>',
    'kihon/other/99.htm': '<html><head><title>通達のデータに出てこないページ</title></head></html>',
  };
  const pagesKey = `${PROD}/pages.json`;
  fs.rmSync(path.join(R2DIR, PROD, 'pages.json'), { force: true });
  r = runBuild(baseItems(), { pages: PAGES });
  check('初めて書く回: pages.json を成果物に置き、見直す対象にする（index.json と法令ファイルは巻き込まない）', r.code === 0 && r.m && r.m.files[pagesKey] && r.m.files[pagesKey].sha_before === null && Object.keys(r.m.files).length === 1 && r.m.pages.state === 'new' && r.m.needs_review && r.m.review.some((x) => /初回: ページの見出し/.test(x)) && !r.m.nothing_to_do && r.r2Unchanged, JSON.stringify(r.m && { f: Object.keys(r.m.files), p: r.m.pages, rv: r.m.review }));
  const pj = r.m && r.m.files[pagesKey] ? JSON.parse(fs.readFileSync(path.join(r.B, 'files', 'pages.json'), 'utf8')) : {};
  check('見出しは「｜国税庁」を外す・通達のデータに出てくるページだけ', pj[`${NTA}/kihon/hojin/01.htm`] === '第1款 益金の額' && pj[`${NTA}/kihon/sisan/sozoku2/01.htm`] === '〔みなし相続財産〕' && !pj[`${NTA}/kihon/other/99.htm`], JSON.stringify(pj));
  check('PDF はリンクしているページの見出し＋リンクの文字', pj[PDF_A] === '第47条関係 差押えの要件（別紙）', JSON.stringify(pj[PDF_A]));
  check('報告に見出しの行', /ページの見出し（pages\.json）: 初めて書く・4 \/ 4 ページ/.test(r.report), r.report.split('\n').filter((l) => /pages/.test(l)).join(' / '));
  fs.writeFileSync(path.join(R2DIR, PROD, 'pages.json'), fs.readFileSync(path.join(r.B, 'files', 'pages.json')));
  r = runBuild(baseItems(), { pages: PAGES });
  check('本番と同じ → 書かない・何もしない回', r.code === 0 && r.m && !r.m.files[pagesKey] && r.m.pages.state === 'same' && r.m.nothing_to_do, JSON.stringify(r.m && { f: Object.keys(r.m.files), p: r.m.pages }));
  r = runBuild(baseItems(), { pages: { ...PAGES, 'kihon/hojin/01.htm': '<title>第1款 益金の額（改正）｜国税庁</title>' } });
  check('見出しが変わった → 書く（本番の中身の hash を控える・見直す対象にはしない・index.json は巻き込まない）', r.code === 0 && r.m && r.m.files[pagesKey] && r.m.files[pagesKey].sha_before && r.m.pages.state === 'changed' && !r.m.needs_review && !r.m.files[`${PROD}/index.json`], JSON.stringify(r.m && { f: Object.keys(r.m.files), p: r.m.pages, rv: r.m.review }));
  r = runBuild(baseItems(), { pages: { 'kihon/hojin/01.htm': PAGES['kihon/hojin/01.htm'] } });
  check('見出しが通達のページの 9 割に付かない → 書かない（注意に出す）', r.code === 0 && r.m && !r.m.files[pagesKey] && r.m.pages.state === 'skipped' && r.m.notes.some((x) => /pages\.json は書かない/.test(x)), JSON.stringify(r.m && { p: r.m.pages, n: r.m.notes }));
  fs.rmSync(path.join(R2DIR, PROD, 'pages.json'), { force: true });

  console.log('\n# 8. crawl が基準を更新しなかった回は build しない');
  r = runBuild(baseItems(), { saved: false });
  check('build しない（終了コード 0・成果物なし）', r.code === 0 && !r.m && /build はしない/.test(r.out), r.out.slice(-400));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通過 / ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
