// Phase 1 Step A: e-Gov 法令API v2 から全法令一覧を取得し sync_state.json に保存
//
// 使用方法:
//   node scripts/update/01_fetch_law_list.cjs
//
// 出力:
//   scripts/update/state/sync_state.json
//     {
//       "fetched_at": "2026-05-15T...",
//       "total_count": 8910,
//       "laws": {
//         "129AC0000000089": {
//           "law_revision_id": "...",
//           "law_title": "民法",
//           "law_type": "Act",
//           "law_num": "明治二十九年法律第八十九号",
//           "amendment_promulgate_date": "2024-...",
//           "updated": "2025-..."
//         },
//         ...
//       }
//     }
//
// 注意: 8,910件 × limit=100 で約90回 API を叩く。レート制限考慮で200msスリープ。

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://laws.e-gov.go.jp/api/2';
const STATE_DIR = path.join(__dirname, 'state');
const OUTPUT_FILE = path.join(STATE_DIR, 'sync_state.json');
const LIMIT = 100;
const SLEEP_MS = 200;
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchPage(offset) {
  // repeal_status=None で現行法令のみに絞る (廃止/失効/停止/実効性喪失を除外)
  // R2 のデータも現行法令のみで構築されているのでそれに合わせる
  const url = `${API_BASE}/laws?limit=${LIMIT}&offset=${offset}&response_format=json&repeal_status=None`;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      const wait = 500 * Math.pow(2, attempt);
      console.log(`  retry ${attempt + 1}/${MAX_RETRIES} after ${wait}ms: ${e.message}`);
      await sleep(wait);
    }
  }
  throw new Error(`Failed to fetch offset=${offset} after ${MAX_RETRIES} retries`);
}

function extractLawEntry(law) {
  // /laws レスポンスは laws[].law_info / revision_info / current_revision_info を含む
  // ここでは current_revision_info を優先 (asof 指定なしなら最新)
  const info = law.law_info || {};
  const rev = law.current_revision_info || law.revision_info || {};

  return {
    law_revision_id: rev.law_revision_id || null,
    law_title: rev.law_title || info.law_title || null,
    law_type: info.law_type || null,
    law_num: info.law_num || null,
    amendment_promulgate_date: rev.amendment_promulgate_date || null,
    updated: rev.updated || info.updated || null,
  };
}

async function main() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  console.log('e-Gov 法令API v2 から全法令一覧を取得');
  console.log(`Base: ${API_BASE}`);
  console.log('');

  const laws = {};
  let offset = 0;
  let total = null;
  let pageNum = 0;

  while (true) {
    pageNum++;
    process.stdout.write(`  page ${pageNum} (offset=${offset})... `);
    const data = await fetchPage(offset);

    if (total === null) {
      total = data.total_count;
      console.log(`total=${total}`);
    } else {
      console.log(`got ${data.count}`);
    }

    for (const law of data.laws || []) {
      const lawId = (law.law_info && law.law_info.law_id) || null;
      if (!lawId) continue;
      laws[lawId] = extractLawEntry(law);
    }

    if (!data.next_offset || data.next_offset <= offset) break;
    offset = data.next_offset;
    await sleep(SLEEP_MS);
  }

  const result = {
    fetched_at: new Date().toISOString(),
    total_count: total,
    laws,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  console.log('');
  console.log(`完了: ${Object.keys(laws).length} 件を保存`);
  console.log(`出力先: ${OUTPUT_FILE}`);
}

main().catch(e => {
  console.error('FAIL:', e);
  process.exit(1);
});
