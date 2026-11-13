// データ側のスクリプト（scripts/rebuild・update・hanrei・tsutatsu・cases・shitsugi・saiketsu・treaty・delegation・beppyo など）の
// サイト固有の既定値の入口。クローラの連絡先・Cloudflare のアカウント ID・Worker の URL・オーナーの PC の置き場をここから取る。
//
// - site_config.private.cjs（同じフォルダ）に条文くん自身の値がある。あればそれを既定にする（このリポジトリでは今までと同じ値）。
// - 公開用の写しにはそのファイルを含めない。無ければすべて環境変数から取る:
//     CRAWLER_CONTACT・CF_ACCOUNT_ID・STAGING_WORKER_URL・BENCH_WORKER_URL・PRODUCTION_WORKER_URL・LOCAL_DATA_ROOT
// - クローラの連絡先だけは、private があっても環境変数 CRAWLER_CONTACT を先に見る。
// - 各スクリプトが今まで通り先に見ている環境変数（CF_ACCOUNT_ID・WORKER_URL・DELEG_REBUILD_DIR など）は、呼び出し側でそのまま先に見る。
// Python 側は scripts/site_config.py（private は scripts/site_config_private.py）。
'use strict';
const fs = require('fs');
const path = require('path');

const PRIVATE_FILE = path.join(__dirname, 'site_config.private.cjs');
const P = fs.existsSync(PRIVATE_FILE) ? require(PRIVATE_FILE) : null;
const env = process.env;

module.exports = {
  crawlerContact: env.CRAWLER_CONTACT || (P ? P.crawlerContact : ''),
  cfAccountId: P ? P.cfAccountId : (env.CF_ACCOUNT_ID || ''),
  workerUrls: P ? P.workerUrls : {
    staging: env.STAGING_WORKER_URL || '',
    bench: env.BENCH_WORKER_URL || '',
    production: env.PRODUCTION_WORKER_URL || '',
  },
  localDataRoot: P ? P.localDataRoot : (env.LOCAL_DATA_ROOT || '.'),
};

// スクリプトを作業フォルダ（{root}/scripts/{name}/）に写して流すとき（通達・事例と裁決の週次の取得など）、
// 写した先から require('../site_config.cjs') で読めるように、このファイル（と private があれば private）も {root}/scripts/ に写す。
Object.defineProperty(module.exports, 'copyInto', {
  enumerable: false,
  value: (scriptsDir) => {
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const f of ['site_config.cjs', 'site_config.private.cjs']) {
      const src = path.join(__dirname, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(scriptsDir, f));
    }
  },
});
