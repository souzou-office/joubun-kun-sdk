// 16: 紐づいた通達(home)を bge-m3 で埋め込み、namespace "_reverse" に登録（逆引き検索用）。
// 各ベクトルの metadata に行き先の条文(homes = "law_id:jou|...")を持たせる。
// 検索時に /search が並列で "_reverse" を引き、当たった通達の homes を「条文候補」に足す（口語クエリ救済）。
// 14_embed_theme は逆(浮き通達→_theme)。こちらは紐づいた通達→_reverse。
//
//   node scripts/tsutatsu/16_embed_reverse.cjs --dry   # 対象数のみ
//   node scripts/tsutatsu/16_embed_reverse.cjs          # 埋め込み実行（ステージング相手）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');
const STATE = path.join(__dirname, 'state');
const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;   // 平文の既定値は置かない（鍵は取り替え済み。環境変数で渡す）
if (!KEY) { console.error('環境変数 BYPASS_KEY を設定してください'); process.exit(1); }
const BATCH = 20;
const NS = '_reverse';

const LAW_NAME = {
  '340AC0000000034': '法人税法', '340CO0000000097': '法人税法施行令', '340M50000040012': '法人税法施行規則',
  '340AC0000000033': '所得税法', '340CO0000000096': '所得税法施行令', '340M50000040011': '所得税法施行規則',
  '325AC0000000073': '相続税法', '325CO0000000071': '相続税法施行令', '325M50000040017': '相続税法施行規則',
  '363AC0000000108': '消費税法', '363CO0000000360': '消費税法施行令', '363M50000040053': '消費税法施行規則',
  '337AC0000000066': '国税通則法', '337CO0000000135': '国税通則法施行令',
  '334AC0000000147': '国税徴収法', '334CO0000000329': '国税徴収法施行令',
  '342AC0000000023': '印紙税法', '342CO0000000108': '印紙税法施行令', '342M50000040019': '印紙税法施行規則',
  '332AC0000000026': '租税特別措置法', '332CO0000000043': '租税特別措置法施行令', '332M50000040015': '租税特別措置法施行規則',
  '410AC0000000025': '電子帳簿保存法', '410M50000040043': '電子帳簿保存法施行規則',
  '403AC0000000069': '地価税法', '403CO0000000174': '地価税法施行令', '403M50000040031': '地価税法施行規則',
  '328AC0000000006': '酒税法', '430AC0000000016': '国際観光旅客税法',
};
// 算用数字 → 漢数字（条番号用、〜9999）
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

function latestStamp() {
  const f = fs.readdirSync(STATE).filter((x) => /^tsutatsu_items_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

(async () => {
  const dry = process.argv.includes('--dry');
  const stamp = latestStamp();
  const links = JSON.parse(fs.readFileSync(path.join(STATE, `article_tsutatsu_links_${stamp}.json`), 'utf8'));
  // ページ(source_url)＋通達番号で一意化。circular_path は群(例 kihon/chosyu)で全ページ共有のため衝突する。
  const itemMap = {};
  for (const l of fs.readFileSync(path.join(STATE, `tsutatsu_items_${stamp}.ndjson`), 'utf8').split('\n').filter(Boolean)) {
    try { const it = JSON.parse(l); if (it.source_url) itemMap[`${it.source_url}|${it.tsutatsu_no}`] = it; } catch {}
  }
  // 通達ごとに home 条文を集約（複数 home 可）。まず html 通達のみ。
  const byTsu = {};
  for (const [artKey, refs] of Object.entries(links)) {
    for (const r of refs) {
      if (r.relation !== 'home' || r.source !== 'html' || !r.source_url) continue;
      const k = `${r.source_url}|${r.tsutatsu_no}`;
      const it = itemMap[k];
      if (!it || !it.body || it.body.length < 20) continue;
      const id = crypto.createHash('md5').update('rev|' + k).digest('hex');
      if (!byTsu[id]) {
        const bodyFlat = (it.body || '').replace(/\s+/g, ' ').trim();
        const snip = (bodyFlat.match(/^.{0,120}?。/) || [bodyFlat.slice(0, 100)])[0]; // 本文の頭1文（選定LLMへの証拠用）
        byTsu[id] = { no: String(r.tsutatsu_no), cap: (r.caption || '').slice(0, 80), snip, src: r.source_url || '', text: `${r.caption || ''} ${(it.body || '').slice(0, 1500)}`.trim(), homes: new Set() };
      }
      byTsu[id].homes.add(artKey); // "law_id:jou"
    }
  }
  const targets = Object.entries(byTsu).map(([id, t]) => {
    // 行き先条文を {l:law_id, n:法令名, a:漢数字タイトル} に展開（worker が force-add で読むだけ）
    const homes = [...t.homes].map((hk) => { const i = hk.indexOf(':'); const lid = hk.slice(0, i), jou = hk.slice(i + 1); return { l: lid, n: LAW_NAME[lid] || lid, a: jou2title(jou) }; });
    return { id, ns: NS, text: t.text, metadata: { no: t.no, cap: t.cap, snip: t.snip || '', src: t.src, homes: JSON.stringify(homes) } };
  });
  console.log(`逆引き埋め込み対象（home通達・html）: ${targets.length}本 → namespace "${NS}"`);
  if (dry) { console.log('  例:', JSON.stringify(targets[0] && { no: targets[0].no, cap: targets[0].metadata.cap, homes: targets[0].metadata.homes })); console.log('★ DRY-RUN'); return; }

  let ok = 0, ng = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    try {
      const res = await fetch(`${WORKER}/api/admin/embed-tsutatsu`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ items: batch }),
      });
      const j = await res.json();
      if (res.ok && j.upserted) ok += j.upserted; else { ng += batch.length; if (ng <= 40) console.log('\n NG', res.status, JSON.stringify(j).slice(0, 120)); }
    } catch (e) { ng += batch.length; if (ng <= 40) console.log('\n ERR', e.message); }
    process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length}  登録${ok} 失敗${ng}`);
  }
  console.log(`\n完了: ${ok}登録 / ${ng}失敗  (namespace ${NS})`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
