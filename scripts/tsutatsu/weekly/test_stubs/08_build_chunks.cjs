// 確かめ用の 08 の代わり（check_build.cjs）。tsutatsu_chunks_{TSU_VER}/ に本物と同じ形で書く
const fs = require('fs'); const path = require('path');
const { readNdjson, buildChunks } = require(process.env.TSU_STUB_LIB);
if (process.env.TSU_STUB_FAIL_08 === '1') process.exit(1);
const stamp = process.argv[2];
const state = path.join(__dirname, 'state');
const links = JSON.parse(fs.readFileSync(path.join(state, `article_tsutatsu_links_${stamp}.json`), 'utf8'));
const items = readNdjson(path.join(state, `tsutatsu_items_${stamp}.ndjson`));
const { byLaw, index } = buildChunks(links, items);
const dir = path.join(__dirname, '..', '..', `tsutatsu_chunks_${process.env.TSU_VER}`);
fs.mkdirSync(dir, { recursive: true });
for (const [law, arts] of Object.entries(byLaw)) fs.writeFileSync(path.join(dir, `${law}.json`), JSON.stringify(arts));
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
