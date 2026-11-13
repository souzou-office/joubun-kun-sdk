// 確かめ用の 07 の代わり（check_build.cjs）。本物と同じ名前・形のファイルを書く
const fs = require('fs'); const path = require('path');
const { readNdjson, buildLinks } = require(process.env.TSU_STUB_LIB);
const stamp = process.argv[2];
const state = path.join(__dirname, 'state');
const items = readNdjson(path.join(state, `tsutatsu_items_${stamp}.ndjson`));
const pdfItems = readNdjson(path.join(state, `pdf_items_${stamp}.ndjson`));
const af = path.join(state, `tsutatsu_assignments_${stamp}.json`);
// 確かめ用: 2 回目の 07（割当があるとき）をシグナルで落とす（メモリ不足の SIGKILL の代わり）
if (process.env.TSU_STUB_KILL_07_SECOND === '1' && fs.existsSync(af)) process.kill(process.pid, 'SIGKILL');
const { links, orphans } = buildLinks(items, pdfItems, fs.existsSync(af) ? JSON.parse(fs.readFileSync(af, 'utf8')) : {});
fs.writeFileSync(path.join(state, `article_tsutatsu_links_${stamp}.json`), JSON.stringify(links));
fs.writeFileSync(path.join(state, `tsutatsu_orphans_${stamp}.json`), JSON.stringify(orphans));
