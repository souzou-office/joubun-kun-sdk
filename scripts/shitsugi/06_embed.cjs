// 質疑応答事例を bge-m3 でベクトル化 → staging Vectorize の namespace "_shitsugi" に登録。
// 既存 /api/admin/embed-tsutatsu 端点（ns指定可・bypassキー必須）を流用。Worker変更なし・既存ns非接触。
//
//   node scripts/shitsugi/06_embed.cjs --dry     # 対象数と統計のみ
//   node scripts/shitsugi/06_embed.cjs
//
// テキスト: タイトル + 照会要旨 + 回答要旨（計〜1500字。照会要旨が口語クエリの受け皿）
// メタデータ: 表示用（title/q/a抜粋/anchors/url）を持たせ、検索ヒット時の別フェッチ不要に。
// アンカー: 03の直接アンカー（条文）に加え、通達のみの事例は
//           tsutatsu の article_tsutatsu_links から通達→home条文の2ホップで解決する。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');
const TSUTATSU_STATE = path.join(REPO_ROOT, 'scripts', 'tsutatsu', 'state');

const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;
const BATCH = 20;
const NS = '_shitsugi';

function latestStamp(dir, re) {
  const f = fs.readdirSync(dir).filter((x) => re.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

// 算用数字 → 漢数字（16_embed_reverse.cjs と同一。homes の a は article_title 形式で持つ）
function intToKanji(n) {
  n = parseInt(n, 10); if (!n) return '〇';
  const d = '〇一二三四五六七八九';
  const th = Math.floor(n / 1000), hu = Math.floor((n % 1000) / 100), te = Math.floor((n % 100) / 10), on = n % 10;
  let s = '';
  if (th) s += (th > 1 ? d[th] : '') + '千';
  if (hu) s += (hu > 1 ? d[hu] : '') + '百';
  if (te) s += (te > 1 ? d[te] : '') + '十';
  if (on) s += d[on];
  return s;
}
// "70の6" → "第七十条の六"、"22" → "第二十二条"
function jou2title(jou) {
  const p = String(jou).split('の');
  let t = '第' + intToKanji(p[0]) + '条';
  for (let i = 1; i < p.length; i++) t += 'の' + intToKanji(p[i]);
  return t;
}

// 通達名 → article_tsutatsu_links の circular_path 候補（カテゴリで措置法通達を曖昧性解消）
function tsutatsuPathCandidates(name, category) {
  const M = {
    法人税基本通達: ['kihon/hojin'],
    連結納税基本通達: ['kihon/renketsu'],
    所得税基本通達: ['kihon/shotoku'],
    消費税法基本通達: ['kihon/shohi'],
    相続税法基本通達: ['kihon/sisan'],
    財産評価基本通達: ['kihon/sisan'],
    国税通則法基本通達: ['kihon/tsusoku'],
    国税徴収法基本通達: ['kihon/chosyu'],
    印紙税法基本通達: ['kihon/inshi'],
  };
  if (M[name]) return M[name];
  if (/租税特別措置法|措置法/.test(name)) {
    if (category === '法人税') return ['kobetsu/hojin'];
    if (/所得税|譲渡所得|源泉/.test(category || '')) return ['kobetsu/shotoku'];
    if (/相続|贈与|評価/.test(category || '')) return ['kobetsu/sozoku'];
    return ['kobetsu/hojin', 'kobetsu/shotoku', 'kobetsu/sozoku'];
  }
  if (/耐用年数/.test(name)) return ['kobetsu/sonota'];
  return [];
}

// article_tsutatsu_links を反転: "circular_path#no" → Set("law_id:article")
function buildTsutatsuIndex() {
  const stamp = latestStamp(TSUTATSU_STATE, /^article_tsutatsu_links_\d{8}\.json$/);
  if (!stamp) return new Map();
  const links = JSON.parse(
    fs.readFileSync(path.join(TSUTATSU_STATE, `article_tsutatsu_links_${stamp}.json`), 'utf8')
  );
  const idx = new Map();
  for (const [artKey, items] of Object.entries(links)) {
    for (const it of items) {
      if (!it.tsutatsu_no || !it.circular_path) continue;
      if (it.relation && it.relation !== 'home') continue; // home条文のみ（最も強いアンカー）
      const k = `${it.circular_path}#${it.tsutatsu_no}`;
      if (!idx.has(k)) idx.set(k, new Set());
      idx.get(k).add(artKey);
    }
  }
  return idx;
}

// homes: worker の _reverse ブロックと同形式 [{l: law_id, n: 法令名, a: 第二十二条}]
function collectHomes(item, tsutatsuIdx, LAW_NAME) {
  const seen = new Set();
  const homes = [];
  const push = (l, n, art) => {
    if (!l || !art) return;
    const a = jou2title(art);
    const k = `${l}_${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    homes.push({ l, n: n || LAW_NAME[l] || '', a });
  };
  for (const a of item.anchors || []) {
    if (!a.law_id) continue;
    const arts = a.articles && a.articles.length ? a.articles : a.article ? [a.article] : [];
    for (const art of arts) push(a.law_id, a.law, art);
  }
  // 2ホップ: 通達参照 → home条文（"law_id:jou" 形式）
  for (const t of item.tsutatsu_refs || []) {
    for (const no of t.nos || []) {
      for (const p of tsutatsuPathCandidates(t.name, item.category)) {
        const hit = tsutatsuIdx.get(`${p}#${no}`);
        if (hit) for (const k of hit) {
          const i = k.indexOf(':');
          push(k.slice(0, i), null, k.slice(i + 1));
        }
      }
    }
  }
  return homes;
}

const LAW_NAME = {
  '340AC0000000034': '法人税法', '340CO0000000097': '法人税法施行令', '340M50000040012': '法人税法施行規則',
  '340AC0000000033': '所得税法', '340CO0000000096': '所得税法施行令', '340M50000040011': '所得税法施行規則',
  '325AC0000000073': '相続税法', '325CO0000000071': '相続税法施行令', '325M50000040017': '相続税法施行規則',
  '363AC0000000108': '消費税法', '363CO0000000360': '消費税法施行令', '363M50000040053': '消費税法施行規則',
  '337AC0000000066': '国税通則法', '337CO0000000135': '国税通則法施行令',
  '334AC0000000147': '国税徴収法', '334CO0000000329': '国税徴収法施行令',
  '342AC0000000023': '印紙税法', '342CO0000000108': '印紙税法施行令', '342M50000040019': '印紙税法施行規則',
  '332AC0000000026': '租税特別措置法', '332CO0000000043': '租税特別措置法施行令', '332M50000040015': '租税特別措置法施行規則',
  '328AC0000000006': '酒税法', '430AC0000000016': '国際観光旅客税法',
};

(async () => {
  const dry = process.argv.includes('--dry');
  const stamp = latestStamp(STATE_DIR, /^shitsugi_items_\d{8}\.ndjson$/);
  if (!stamp) throw new Error('shitsugi_items がありません');
  const items = fs
    .readFileSync(path.join(STATE_DIR, `shitsugi_items_${stamp}.ndjson`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tsutatsuIdx = buildTsutatsuIndex();

  const targets = [];
  let anchored = 0, twoHopOnly = 0, noAnchor = 0;
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (!it.shokai || !it.kaito) continue;
    const homes = collectHomes(it, tsutatsuIdx, LAW_NAME);
    const direct = (it.anchors || []).some((a) => a.law_id);
    if (homes.length) anchored++;
    if (!direct && homes.length) twoHopOnly++;
    if (!homes.length) noAnchor++;

    const text = `${it.title}\n${it.shokai.slice(0, 900)}\n${it.kaito.slice(0, 500)}`;
    targets.push({
      id: crypto.createHash('md5').update(`shitsugi:${it.id}`).digest('hex'),
      ns: NS,
      no: it.id,
      text,
      metadata: {
        sid: it.id,
        cat: it.category || '',
        title: (it.title || '').slice(0, 100),
        q: it.shokai.slice(0, 300),
        a: it.kaito.slice(0, 300),
        homes: JSON.stringify(homes.slice(0, 12)),
        url: it.url,
        img: (it.images || []).length,
        as_of: it.as_of || '',
      },
    });
  }

  const byCat = {};
  for (const t of targets) byCat[t.metadata.cat] = (byCat[t.metadata.cat] || 0) + 1;
  console.log(`埋め込み対象: ${targets.length} 事例 (snapshot ${stamp})`);
  console.log(`  アンカーあり: ${anchored}（うち2ホップのみ ${twoHopOnly}） / アンカーなし: ${noAnchor}`);
  for (const [k, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`    ${n}\t${k}`);
  if (dry) { console.log('★ DRY-RUN'); return; }
  if (!KEY) { console.error('BYPASS_KEY 環境変数が必要です'); process.exit(1); }

  let ok = 0, ng = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    try {
      const res = await fetch(`${WORKER}/api/admin/embed-tsutatsu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ items: batch }),
      });
      const j = await res.json();
      if (res.ok && j.upserted) ok += j.upserted;
      else { ng += batch.length; console.log('\n NG', res.status, JSON.stringify(j).slice(0, 150)); }
    } catch (e) { ng += batch.length; console.log('\n ERR', e.message); }
    process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length}  登録${ok} 失敗${ng}`);
  }
  console.log(`\n完了: ${ok}登録 / ${ng}失敗  (namespace ${NS})`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
