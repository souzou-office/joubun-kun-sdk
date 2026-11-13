// 確かめ用の 03 の代わり（check_build.cjs）。TSU_FIX_ITEMS の中身を tsutatsu_items_{stamp}.ndjson に写す
const fs = require('fs'); const path = require('path');
const stamp = process.argv[process.argv.indexOf('--snapshot') + 1];
const state = path.join(__dirname, 'state');
fs.mkdirSync(state, { recursive: true });
fs.copyFileSync(process.env.TSU_FIX_ITEMS, path.join(state, `tsutatsu_items_${stamp}.ndjson`));
