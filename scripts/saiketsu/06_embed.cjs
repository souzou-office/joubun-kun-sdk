// 裁決事例を bge-m3 でベクトル化 → staging Vectorize の namespace "_saiketsu" に登録。
// 既存 /api/admin/embed-tsutatsu 端点（ns指定可・bypassキー必須）を流用。Worker変更なし・既存ns非接触。
//
//   node scripts/saiketsu/06_embed.cjs --dry     # 対象数と統計のみ
//   node scripts/saiketsu/06_embed.cjs
//
// 1裁決=複数ベクトル（親子構造・ユーザー合意済み設計）:
//   ・裁決要旨（タイトル+ポイント/要旨）: 規範層・最強シグナル
//   ・セクションごと（事案の概要/基礎事実/争点/主張/判断（争点ごと））: 事実語彙層
// 全ベクトルが metadata.sid（号-頁 or 号-連番）で親裁決を指す。検索側は sid で集約して1カード化。
// homes: law_refs（関係法令等セクション+要旨から辞書解決済み）を _reverse と同形式で持つ。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');

const STATE_DIR = path.join(__dirname, 'state');
const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;
const BATCH = 20;
const NS = '_saiketsu';

function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter((x) => /^saiketsu_items_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

// 算用数字 → 漢数字（16_embed_reverse.cjs と同一。homes の a は article_title 形式）
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
function jou2title(jou) {
  const p = String(jou).split('の');
  let t = '第' + intToKanji(p[0]) + '条';
  for (let i = 1; i < p.length; i++) t += 'の' + intToKanji(p[i]);
  return t;
}

(async () => {
  const dry = process.argv.includes('--dry');
  const stamp = latestStamp();
  if (!stamp) throw new Error('saiketsu_items がありません');
  const items = fs
    .readFileSync(path.join(STATE_DIR, `saiketsu_items_${stamp}.ndjson`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const targets = [];
  let cases = 0;
  for (const it of items) {
    if (!it.abstract || it.abstract.length < 30) continue;
    cases++;
    const homes = (it.law_refs || []).slice(0, 10).map((r) => ({ l: r.law_id, n: r.law, a: jou2title(r.article) }));
    const cat = (it.tax_laws || []).map((x) => x.law).join('・');
    const common = {
      sid: it.id,
      title: (it.title || '').slice(0, 90),
      abst: (it.abstract || '').replace(/\s+/g, ' ').slice(0, 200),
      cat,
      date: it.date || '',
      topic: (it.topics || [])[0] || '',
      homes: JSON.stringify(homes),
      url: it.url || '',
    };
    // 要旨ベクトル
    targets.push({
      id: crypto.createHash('md5').update(`saiketsu:${it.id}#abst`).digest('hex'),
      ns: NS, no: `${it.id}#要旨`,
      text: `${it.title}\n${it.abstract.slice(0, 1500)}`,
      metadata: { ...common, sec: '裁決要旨' },
    });
    // セクションベクトル
    (it.units || []).forEach((u, i) => {
      targets.push({
        id: crypto.createHash('md5').update(`saiketsu:${it.id}#s${i}`).digest('hex'),
        ns: NS, no: `${it.id}#${u.sec}`,
        text: `${it.title.slice(0, 100)}\n${u.text}`,
        metadata: { ...common, sec: u.sec.slice(0, 40) },
      });
    });
  }

  console.log(`埋め込み対象: ${targets.length} ベクトル / ${cases} 裁決 (snapshot ${stamp})`);
  const secFreq = {};
  for (const t of targets) secFreq[t.metadata.sec.split('＞')[0]] = (secFreq[t.metadata.sec.split('＞')[0]] || 0) + 1;
  for (const [k, n] of Object.entries(secFreq).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${n}\t${k}`);
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
    if ((i / BATCH) % 10 === 0) process.stdout.write(`\r  ${Math.min(i + BATCH, targets.length)}/${targets.length}  登録${ok} 失敗${ng}`);
  }
  console.log(`\n完了: ${ok}登録 / ${ng}失敗  (namespace ${NS})`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
