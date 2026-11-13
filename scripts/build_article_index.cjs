// 条文 → 事例・裁決 の索引を作る（「口」のデータ側）。
//
//   入力: scripts/shitsugi/04_relink_from_r2.cjs と scripts/saiketsu/04_relink_from_r2.cjs が出したリンク表
//         ＋ scripts/saiketsu/05_assign_articles.cjs が出した割当結果（--assign で渡す）
//   出力: article_links_v1/{law_id}.json     条 → [{i:事例/裁決ID, k:種別, s:出所, c:確信度}]
//         article_links_v1/_cases.json       ID → {t:表題, u:URL, k:種別, d:年月日}
//
//   出所(s) は必ず残す。'kankei'/'abstract'/'body'/'tsutatsu' は原文に書かれた引用、
//   'llm' は閉集合からの割当。口の側で引用を上位、割当を下位に並べられるようにするため。
//
//   node scripts/build_article_index.cjs --sh L1 --sa L2 --sh-assign A1 --sa-assign A2 --outdir DIR [--put]
//   --put を付けたときだけ R2 に書く（新規プレフィックス article_links_v1/ のみ。既存キーには触れない）
const fs = require('fs');
const path = require('path');
const SITE = require('./site_config.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}` };
const OBJ = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/`;
const PREFIX = 'article_links_v1/';

const get = async (k) => { const r = await fetch(OBJ + encodeURIComponent(k), { headers: H }); return r.ok ? r.json() : null; };
const listKeys = async (prefix) => {
  const out = []; let c = null;
  do {
    const u = new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects`);
    u.searchParams.set('prefix', prefix); u.searchParams.set('per_page', '1000');
    if (c) u.searchParams.set('cursor', c);
    const j = await (await fetch(u, { headers: H })).json();
    if (!j.success) break;
    out.push(...(j.result || []).map((x) => x.key)); c = (j.result_info || {}).cursor || null;
  } while (c);
  return out;
};
async function put(key, obj) {
  if (!key.startsWith(PREFIX)) throw new Error(`書き込みは ${PREFIX} 配下のみ: ${key}`);
  const r = await fetch(OBJ + encodeURIComponent(key), {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error(`PUT ${key} → ${r.status} ${await r.text()}`);
}

const arg = (f) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : null);

async function main() {
  const outDir = arg('--outdir') || '.';
  const doPut = process.argv.includes('--put');
  const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const sh = load(arg('--sh')), sa = load(arg('--sa'));
  const shA = load(arg('--sh-assign')).results, saA = load(arg('--sa-assign')).results;

  // 表題・URL は R2 の本体から取る（リンク表には入れていない）
  const cases = {};
  for (const [prefix, kind] of [['shitsugi_v1/cases_', 'j'], ['saiketsu_v1/cases_', 's']]) {
    const keys = await listKeys(prefix);
    for (let i = 0; i < keys.length; i += 8) {
      const batch = await Promise.all(keys.slice(i, i + 8).map((k) => get(k)));
      for (const d of batch) {
        if (!d) continue;
        for (const it of (Array.isArray(d) ? d : Object.values(d))) {
          if (!it || typeof it !== 'object' || !it.id) continue;
          cases[it.id] = { t: it.title || '', u: it.url || '', k: kind, d: it.date || it.as_of || '' };
        }
      }
    }
    process.stderr.write(`${kind}:${Object.keys(cases).length} `);
  }
  process.stderr.write('\n');

  // 条 → 事例/裁決
  const byLaw = {};
  const add = (lawId, article, entry) => {
    if (!lawId || !article) return;
    (byLaw[lawId] = byLaw[lawId] || {});
    (byLaw[lawId][article] = byLaw[lawId][article] || []).push(entry);
  };
  let nLink = 0;
  for (const [links, kind] of [[sh.links, 'j'], [sa.links, 's']]) {
    for (const [id, refs] of Object.entries(links)) {
      for (const r of refs) { add(r.law_id, r.article, { i: id, k: kind, s: r.src || 'kankei' }); nLink++; }
    }
  }
  let nLlm = 0;
  for (const [asg, kind] of [[shA, 'j'], [saA, 's']]) {
    for (const [id, r] of Object.entries(asg)) {
      for (const key of (r.articles || [])) {
        const [lawId, article] = String(key).split(':');
        add(lawId, article, { i: id, k: kind, s: 'llm', c: r.conf || 'low' });
        nLlm++;
      }
    }
  }
  // 並び順は「その条がその事例・裁決の主題にどれだけ近いか」の強さ順にする。
  //   kankei   関係法令欄／要旨に明記された条 = その事案の根拠条
  //   abstract 要旨の地の文に出てきた条
  //   tsutatsu 引用通達の帰属条（1段間接）
  //   body     判断本文で言及されただけ（手続条・傍論を多く含む）
  //   llm      閉集合からの割当（原文に条番号が無いもの）
  const RANK = { kankei: 0, abstract: 1, tsutatsu: 2, body: 3, llm: 4 };
  const rank = (e) => (RANK[e.s] === undefined ? 3 : RANK[e.s]);
  for (const law of Object.values(byLaw)) {
    for (const [a, arr] of Object.entries(law)) {
      const seen = new Set();
      law[a] = arr.filter((e) => (seen.has(e.i + e.k) ? false : seen.add(e.i + e.k)))
        .sort((x, y) => rank(x) - rank(y));
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  let bytes = 0;
  for (const [lawId, obj] of Object.entries(byLaw)) {
    const s = JSON.stringify(obj); bytes += s.length;
    fs.writeFileSync(path.join(outDir, `${lawId}.json`), s);
  }
  const casesStr = JSON.stringify(cases);
  fs.writeFileSync(path.join(outDir, '_cases.json'), casesStr);

  const nArt = Object.values(byLaw).reduce((s, o) => s + Object.keys(o).length, 0);
  console.log(`法令 ${Object.keys(byLaw).length}件 / 条 ${nArt}件`);
  console.log(`  原文の引用リンク ${nLink}本 / LLM割当 ${nLlm}本`);
  console.log(`  索引 ${(bytes / 1e6).toFixed(1)}MB + 事例メタ ${(casesStr.length / 1e6).toFixed(1)}MB（${Object.keys(cases).length}件）`);
  const top = Object.entries(byLaw).flatMap(([l, o]) => Object.entries(o).map(([a, arr]) => [`${l}:${a}`, arr.length]))
    .sort((x, y) => y[1] - x[1]).slice(0, 8);
  console.log(`  最多の条: ${top.map(([k, v]) => k + '=' + v).join(' / ')}`);

  if (doPut) {
    let n = 0;
    const entries = Object.entries(byLaw);
    for (let i = 0; i < entries.length; i += 6) {
      await Promise.all(entries.slice(i, i + 6).map(([lawId, obj]) => put(`${PREFIX}${lawId}.json`, obj)));
      n += Math.min(6, entries.length - i);
      process.stderr.write(`\r  R2書き込み ${n}/${entries.length}`);
    }
    await put(`${PREFIX}_cases.json`, cases);
    console.error('');
    console.log(`→ R2 ${PREFIX} に ${entries.length + 1} オブジェクト`);
  } else {
    console.log(`→ ${outDir}（--put でR2へ）`);
  }
}

if (require.main === module) main();
