// 04: R2 の質疑応答事例に、修正後のパーサを当て直して条文リンク表を作る。
//     裁決側の scripts/saiketsu/04_relink_from_r2.cjs と対になる。
//
//   ① 関係法令欄の法令引用（parseKankeiLine の law）
//   ② 関係法令欄の通達番号 → tsutatsu_chunks_v2 の逆引き → その通達の帰属条
//      （通達の帰属条は 07_build_links + 13_assign で作られ検証済み。ここで新たな推測はしない）
//   解析は必ず本物の parseKankeiLine を import する。写しは書かない。
//
//   node scripts/shitsugi/04_relink_from_r2.cjs [--out FILE]
const fs = require('fs');
const path = require('path');
const { parseKankeiLine, loadLawIds } = require('./03_parse.cjs');
const SITE = require('../site_config.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const H = { Authorization: `Bearer ${TOKEN}` };
const OBJ = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/`;
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
const norm = (s) => String(s || '').replace(/[−–—―ー－]/g, '-').replace(/\s/g, '').trim();

// 事例には裁決の tax_laws にあたる欄が無い。カテゴリ（=国税庁サイトの分野）が
// 同じ役割を果たすので、法令レベルの帰属として使う。割当の候補を絞る用途のみ。
const CATEGORY_LAW = {
  所得税: ['340AC0000000033'], 源泉所得税: ['340AC0000000033'], 譲渡所得: ['340AC0000000033', '332AC0000000026'],
  法人税: ['340AC0000000034'], 消費税: ['363AC0000000108'], 相続税・贈与税: ['325AC0000000073'],
  財産評価: ['325AC0000000073'], 印紙税: ['342AC0000000023'], 酒税: ['328AC0000000006'],
  国税通則: ['337AC0000000066'], 国税徴収: ['334AC0000000147'], 登録免許税: ['342AC0000000035'],
};
// 特例はほぼ全て租税特別措置法にある。対照実験で外した8件中6件が「カテゴリは所得税
// だが正解は措置法41条（住宅借入金等特別控除）」の型で、候補に一度も入っていなかった。
const SOCHI = '332AC0000000026';
function categoryLaws(category, ALL, lawNameById) {
  for (const [k, ids] of Object.entries(CATEGORY_LAW)) {
    if (!String(category || '').includes(k)) continue;
    const all = ids.includes(SOCHI) ? ids : [...ids, SOCHI];
    return all.map((id) => ({ law_id: id, law: lawNameById[id] || '' }));
  }
  return [];
}

// 通達番号 → 帰属条 の逆引き表。
// 【重要】キーは「ベース法令:番号」。番号だけで引くと、通達番号「4」だけで15法令
//   計265本にぶら下がり、1件の事例に365本の条文が付く（実測）。通達名から
//   ベース法令を解決して、その法令（＋施行令・施行規則）の中だけを引く。
//   chunks: [[law_id, 通達のチャンク（{条: [通達]}）]]
function buildTsuRev(chunks) {
  const rev = new Map();
  for (const [lawId, d] of chunks) {
    if (!d) continue;
    for (const [jou, arr] of Object.entries(d)) {
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        const no = norm(t.no); if (!no) continue;
        const key = `${lawId}:${no}`;
        const cur = rev.get(key) || [];
        if (!cur.includes(jou)) cur.push(jou);
        rev.set(key, cur);
      }
    }
  }
  return rev;
}

// 1 件の事例（R2 の形）→ 条文リンク。週次（scripts/cases/weekly）もこれを使う（写しを書かない）
//   → { found: [{law_id, law?, article, src, via?}], hadDirect }
function makeShitsugiLinker(ALL, rev) {
  // 通達名 → ベース法令。「所得税基本通達」→ 所得税法 のように接尾辞を剥がして解決する。
  const TSU_ALIAS = { 所得税: '所得税法', 法人税: '法人税法', 相続税: '相続税法', 消費税: '消費税法', 財産評価: '相続税法', 印紙税: '印紙税法', 酒税: '酒税法', 地価税: '地価税法' };
  const tsuScopeCache = new Map();
  const unresolvedName = {};
  const ambiguous = {};
  const AMBIGUOUS_MAX = 3;
  function tsuScope(name) {
    const key = String(name || '');
    if (tsuScopeCache.has(key)) return tsuScopeCache.get(key);
    let base = key.replace(/（[^）]*）/g, '').replace(/(?:法令解釈)?(?:基本通達|関係通達|取扱通達|通達|事務運営指針)$/, '').trim();
    base = base.replace(/^(?:[^\s]*?)(所得税|法人税|相続税|消費税|財産評価|印紙税|酒税|地価税|国税通則法|国税徴収法|租税特別措置法)$/, '$1');
    const lawName = ALL[base] ? base : (TSU_ALIAS[base] || null);
    const ids = [];
    if (lawName && ALL[lawName]) {
      for (const suffix of ['', '施行令', '施行規則']) {
        const id = ALL[lawName + suffix];
        if (id) ids.push(id);
      }
    }
    tsuScopeCache.set(key, ids);
    return ids;
  }
  function link(it) {
      const parsed = [];
      for (const line of (it.kankei_raw || [])) parsed.push(...parseKankeiLine(line, ALL));
      const found = new Map();
      // ① 関係法令欄に書かれた条文そのもの
      for (const p of parsed) {
        if (p.kind !== 'law' || !p.law_id) continue;
        for (const art of (p.articles && p.articles.length ? p.articles : [p.article])) {
          if (!art) continue;
          found.set(`${p.law_id}:${art}`, { law_id: p.law_id, law: p.law, article: art, src: 'kankei' });
        }
      }
      const hadDirect = found.size > 0;
      // ② 通達番号 → その通達の帰属条（通達名で法令を絞ってから引く）
      for (const p of parsed) {
        if (p.kind !== 'tsutatsu') continue;
        const scope = tsuScope(p.name);
        if (!scope.length) { unresolvedName[p.name] = (unresolvedName[p.name] || 0) + 1; continue; }
        for (const no0 of (p.nos || []).map(norm)) {
          // 「67-4(1)」は地図側に (1) 抜きで入っていることがあるので括弧を落として再試行する
          for (const lawId of scope) {
            let jous = rev.get(`${lawId}:${no0}`);
            if (!jous) jous = rev.get(`${lawId}:${no0.replace(/[(（]\d+[)）]$/, '')}`);
            if (!jous) continue;
            // 1つの番号が多くの条に散っている＝その番号は識別子として機能していない。
            // 通達番号「1」は措置法だけで18条、「70の6-13」は6条にぶら下がる。
            // 拾うと事例1件に無関係な条が大量に付くので、曖昧な番号は使わない。
            if (jous.length > AMBIGUOUS_MAX) { ambiguous[`${lawId}:${no0}`] = jous.length; continue; }
            for (const jou of jous) {
              const key = `${lawId}:${jou}`;
              if (!found.has(key)) found.set(key, { law_id: lawId, article: jou, src: 'tsutatsu', via: `${p.name}${no0}` });
            }
          }
        }
      }
      return { found: [...found.values()], hadDirect };
  }
  return { link, unresolvedName, ambiguous };
}

async function main() {
  if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
  const outFile = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  const ALL = loadLawIds();
  const tsuKeys = await listKeys('tsutatsu_chunks_v2/');
  const chunks = [];
  for (const k of tsuKeys) chunks.push([path.basename(k, '.json'), await get(k)]);
  const rev = buildTsuRev(chunks);
  console.error(`通達の地図: ${rev.size} 件（法令×番号） / 法令 ${tsuKeys.length} 件`);
  const { link, unresolvedName, ambiguous } = makeShitsugiLinker(ALL, rev);

  const links = {}, unlinked = [], meta = [];
  const lawNameById = {};
  for (const [k, v] of Object.entries(ALL)) if (!lawNameById[v]) lawNameById[v] = k;
  let total = 0, direct = 0, viaTsu = 0;
  for (const k of (await listKeys('shitsugi_v1/')).filter((x) => /cases_/.test(x))) {
    const d = await get(k); if (!d) continue;
    for (const it of (Array.isArray(d) ? d : Object.values(d))) {
      if (!it || typeof it !== 'object') continue;
      total++;
      const { found: foundArr, hadDirect } = link(it);
      const found = new Map(foundArr.map((f) => [`${f.law_id}:${f.article}`, f]));
      if (hadDirect) direct++;
      else if (found.size) viaTsu++;
      const rec = {
        id: it.id,
        title: it.title || '',
        abstract: `${it.shokai || ''}\n${it.kaito || ''}`.trim(),
        topics: it.category ? [it.category] : [],
        tax_laws: categoryLaws(it.category, ALL, lawNameById),
        kankei_raw: it.kankei_raw || [],
      };
      meta.push(rec);
      if (found.size) links[it.id] = [...found.values()];
      else unlinked.push(rec);
    }
  }
  const ok = Object.keys(links).length;
  console.log(`事例 ${total}件`);
  console.log(`  条文が付いた       ${ok}/${total} (${(100 * ok / total).toFixed(1)}%)`);
  console.log(`    うち関係法令欄から直接 ${direct}件 / 通達の地図経由のみ ${viaTsu}件`);
  console.log(`  条文ゼロ           ${unlinked.length}件`);
  const per = Object.values(links).map((a) => a.length).sort((a, b) => a - b);
  console.log(`  1件あたり条文数 中央値 ${per[per.length >> 1]} / 平均 ${(per.reduce((a, b) => a + b, 0) / per.length).toFixed(1)} / 90%点 ${per[Math.floor(per.length * 0.9)]} / 最大 ${per[per.length - 1]}`);
  const amb = Object.entries(ambiguous).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (amb.length) console.log(`  曖昧すぎて使わなかった通達番号 ${Object.keys(ambiguous).length}種: ${amb.map(([k, v]) => k + '→' + v + '条').join(' / ')}`);
  const un = Object.entries(unresolvedName).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (un.length) console.log(`  ベース法令を解決できなかった通達名: ${un.map(([k, v]) => k + '×' + v).join(' / ')}`);
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), total, links, unlinked }, null, 1));
    const metaFile = outFile.replace(/\.json$/, '_meta.json');
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    console.log(`→ ${outFile}`);
    console.log(`→ ${metaFile}`);
    const noLaw = unlinked.filter((u) => !u.tax_laws.length).length;
    console.log(`  未紐付けのうち法令レベルの帰属も作れない ${noLaw}件`);
  }
}

if (require.main === module) main();
module.exports = { buildTsuRev, makeShitsugiLinker, categoryLaws };
