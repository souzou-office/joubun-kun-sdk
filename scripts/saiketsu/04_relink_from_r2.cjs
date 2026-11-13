// 04: R2 の裁決レコードに、修正後の抽出器を当て直して条文リンク表を作る。
//
//   なぜ 03 を再実行しないのか: 03 の入力は取得元HTML（all_saiketsu_*/）で、
//   この環境には無い。R2 には title / abstract / sections が残っているので、
//   そこから抽出し直し、R2 の既存 law_refs と**和集合**にする（既存は
//   「関係法令等」欄から取ったもので、R2 には欄の原文が残っていないため再現できない）。
//
//   抽出は必ず scripts/saiketsu/03_parse.cjs の extractLawRefs を import する。写しは書かない。
//
//   node scripts/saiketsu/04_relink_from_r2.cjs            # 集計のみ（R2読み取り・0円）
//   node scripts/saiketsu/04_relink_from_r2.cjs --out FILE # リンク表をJSONで書き出す
const fs = require('fs');
const path = require('path');
const { extractLawRefs } = require('./03_parse.cjs');
const { loadLawIds } = require('../shitsugi/03_parse.cjs');
const SITE = require('../site_config.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const H = { Authorization: `Bearer ${TOKEN}` };
const OBJ = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/`;

const flatten = (secs) => {
  let s = '';
  for (const x of (secs || [])) { s += '\n' + (x.head || '') + '\n' + (x.text || '') + flatten(x.children); }
  return s;
};

async function listCaseKeys() {
  const out = []; let cursor = null;
  do {
    const u = new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects`);
    u.searchParams.set('prefix', 'saiketsu_v1/cases_');
    u.searchParams.set('per_page', '1000');
    if (cursor) u.searchParams.set('cursor', cursor);
    const j = await (await fetch(u, { headers: H })).json();
    if (!j.success) break;
    out.push(...(j.result || []).map((x) => x.key));
    cursor = (j.result_info || {}).cursor || null;
  } while (cursor);
  return out;
}

// 1 件の裁決（R2 の形）→ 条文リンク。週次（scripts/cases/weekly）もこれを使う（写しを書かない）
//   → [{law_id, law, article, count, src}]（count の多い順）
function linkSaiketsu(it, ALL) {
  const body = `${it.title || ''}\n${it.abstract || ''}\n${flatten(it.sections)}`;
  const found = new Map();
  // 要旨のみで取れたものは「規範の中心」に近いので重みを分ける
  for (const r of extractLawRefs(`${it.title || ''}\n${it.abstract || ''}`, 20, ALL)) {
    found.set(`${r.law_id}:${r.article}`, { law_id: r.law_id, law: r.law, article: r.article, count: r.count, src: 'abstract' });
  }
  for (const r of extractLawRefs(body, 20, ALL)) {
    const k = `${r.law_id}:${r.article}`;
    if (found.has(k)) found.get(k).count = r.count;
    else found.set(k, { law_id: r.law_id, law: r.law, article: r.article, count: r.count, src: 'body' });
  }
  const beforeR2 = found.size;
  for (const r of (it.law_refs || [])) {
    if (!r.law_id || !r.article) continue;
    const k = `${r.law_id}:${r.article}`;
    if (!found.has(k)) found.set(k, { law_id: r.law_id, law: r.law, article: r.article, count: r.count || 1, src: 'kankei' });
  }
  return { found: [...found.values()].sort((a, b) => b.count - a.count), beforeR2 };
}

async function main() {
  if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
  const outFile = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  const ALL = loadLawIds();
  const keys = await listCaseKeys();
  const links = {};      // case_id -> [{law_id, article, count, src}]
  const unlinked = [];   // 条文が1本も付かなかった裁決（LLM割当の対象）
  let total = 0, r2Only = 0, newOnly = 0;
  for (let i = 0; i < keys.length; i += 8) {
    const batch = await Promise.all(keys.slice(i, i + 8).map(async (k) => {
      const r = await fetch(OBJ + encodeURIComponent(k), { headers: H });
      return r.ok ? r.json() : null;
    }));
    for (const d of batch) {
      if (!d) continue;
      for (const it of (Array.isArray(d) ? d : Object.values(d))) {
        if (!it || typeof it !== 'object' || !it.id) continue;
        total++;
        const { found: arr, beforeR2 } = linkSaiketsu(it, ALL);
        if (arr.length > beforeR2) r2Only++;
        if (beforeR2 && !(it.law_refs || []).some((r) => r.law_id && r.article)) newOnly++;
        if (arr.length) links[it.id] = arr;
        else unlinked.push({ id: it.id, title: it.title, topics: it.topics || [], tax_laws: it.tax_laws || [], abstract: it.abstract || '' });
      }
    }
    process.stderr.write('.');
  }
  const ok = Object.keys(links).length;
  console.error('');
  console.log(`裁決 ${total}件`);
  console.log(`  条文が付いた       ${ok}/${total} (${(100 * ok / total).toFixed(1)}%)`);
  console.log(`  条文ゼロ（要割当） ${unlinked.length}件`);
  console.log(`  R2既存の欄だけが持っていた分がある裁決 ${r2Only}件 / 新抽出だけが持つ裁決 ${newOnly}件`);
  const per = Object.values(links).map((a) => a.length).sort((a, b) => a - b);
  console.log(`  1件あたり条文数 中央値 ${per[per.length >> 1]} / 平均 ${(per.reduce((a, b) => a + b, 0) / per.length).toFixed(1)} / 最大 ${per[per.length - 1]}`);
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), total, links, unlinked }, null, 1));
    console.log(`→ ${outFile}`);
  }
}

if (require.main === module) main();
module.exports = { flatten, linkSaiketsu };
