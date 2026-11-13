// 19: 浮き通達を、現行R2コーパス（tsutatsu_chunks_${TSU_PREV}。既定 v3）から逆引きして埋める。
//     同じLLM判定に二度払わないため。R2は読み取りのみ。
//
//   突き合わせキーは (source_url, tsutatsu_no)。チャンクの各要素は url と no を持つ。
//   本文・見出しが今回の解析で変わったもの（番号衝突の是正など）は旧割当を信用せず残す。
//
//   node scripts/tsutatsu/19_recover_assignments.cjs [--write]
const fs = require('fs');
const path = require('path');
const SITE = require('../site_config.cjs');
// 比べる相手（前回ビルド＝本番が読んでいる版）。v4 を作るときは v3（既定）。
const TSU_PREV = process.env.TSU_PREV || 'v3';
const STATE = path.join(__dirname, 'state');
const REPO = path.join(__dirname, '..', '..');
const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}` };
const HOJIN = '340AC0000000034', SHOTOKU = '340AC0000000033', SOZOKU = '325AC0000000073',
  SHOHI = '363AC0000000108', TSUSOKU = '337AC0000000066', CHOSYU = '334AC0000000147';
const norm = (s) => String(s || '').replace(/[−–—―ー－]/g, '-').replace(/\s/g, '').trim();

async function listKeys(prefix) {
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
}

async function main() {
  const stamp = fs.readdirSync(STATE).filter((x) => /^tsutatsu_orphans_\d{8}\.json$/.test(x)).sort().pop().match(/(\d{8})/)[1];
  const orphans = JSON.parse(fs.readFileSync(path.join(STATE, `tsutatsu_orphans_${stamp}.json`), 'utf8'));

  // R2 現行コーパス → (url|no) -> { law_id, jou, cap, body }
  const prev = new Map();
  for (const k of await listKeys(`tsutatsu_chunks_${TSU_PREV}/`)) {
    const lawId = path.basename(k, '.json');
    if (lawId === 'index') continue;
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/${encodeURIComponent(k)}`, { headers: H });
    if (!r.ok) continue;
    const d = await r.json();
    for (const [jou, arr] of Object.entries(d)) {
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        const key = `${t.url || ''}|${norm(t.no)}`;
        if (!prev.has(key)) prev.set(key, []);
        prev.get(key).push({ law_id: lawId, jou, cap: t.cap || '', body: t.body || '' });
      }
    }
  }
  console.error(`R2の既存コーパス: ${prev.size} 件（url×番号）`);

  const out = {}; let filled = 0, capMismatch = 0, notFound = 0;
  const remain = [];
  for (const o of orphans) {
    const hits = prev.get(`${o.source_url || ''}|${norm(o.no)}`);
    if (!hits || !hits.length) { notFound++; remain.push(o); continue; }
    // 見出しが変わっていたら別物の可能性がある（番号衝突の是正等）→ 旧割当を信用しない
    const cap = String(o.caption || '').trim();
    const ok = hits.filter((h) => !cap || !h.cap || h.cap.trim() === cap);
    if (!ok.length) { capMismatch++; remain.push(o); continue; }
    // 同じ通達が複数条にぶら下がる場合は先頭（home relation が先に積まれている）を採る
    out[`${o.source_path}#${o.no}`] = { law_id: ok[0].law_id, article: ok[0].jou, conf: 'recovered' };
    filled++;
  }
  console.log(`浮き通達 ${orphans.length}件`);
  console.log(`  (i) 旧コーパスから住所を復元できた   ${filled}件`);
  console.log(`  (ii) 復元できず 13_assign が要る     ${remain.length}件`);
  console.log(`        内訳: R2に無い ${notFound} / 見出しが変わった ${capMismatch}`);
  const byTree = {};
  remain.forEach((r) => { const t = r.circular_path || '?'; byTree[t] = (byTree[t] || 0) + 1; });
  console.log(`  (ii)の税目別: ${JSON.stringify(byTree)}`);
  if (process.argv.includes('--write')) {
    // 【2026-09-02 修正】既存の割当ファイルを丸ごと上書きして 1,288件を 0件にした事故があった。
    //   13_assign の結果（LLM割当・実費がかかっている）が入っているので、必ずマージする。
    const asgFile = path.join(STATE, `tsutatsu_assignments_${stamp}.json`);
    const existing = fs.existsSync(asgFile) ? JSON.parse(fs.readFileSync(asgFile, 'utf8')) : {};
    const merged = { ...existing };
    let added = 0;
    for (const [k, v] of Object.entries(out)) if (!merged[k]) { merged[k] = v; added++; }
    console.log(`  既存 ${Object.keys(existing).length}件 に ${added}件 を追加（上書きしない）`);
    fs.writeFileSync(asgFile, JSON.stringify(merged, null, 1));
    // 13_assign は targets を {sp, no, lawId} で受ける（lawId が無いと対象から外れる）。
    // ベース法令は circular_path から引く。08の表示ポリシーで落ちる連結納税と、
    // ベース法令マップに無い税目（揮発油・不服審査・税理士法等）は対象から除く。
    const BASE_BY_PATH = {
      'kihon/hojin': HOJIN, 'kobetsu/hojin': HOJIN, 'kihon/renketsu': null,
      'kihon/shotoku': SHOTOKU, 'kobetsu/shotoku': SHOTOKU,
      'kihon/sisan': SOZOKU, 'kobetsu/sozoku': SOZOKU,
      'kihon/shohi': SHOHI, 'kobetsu/kansetsu': SHOHI,
      // 13_assign の BASE 拡張に追随（地図の外にいた861本）
      'kihon/igi': TSUSOKU, 'kihon/shinsaseikyu': TSUSOKU,
      'kihon/zeirishi': '326AC1000000237', 'kobetsu/zeirishi': '326AC1000000237',
      'kihon/sake': '328AC0000000006', 'kihon/kihatsu': '332AC0000000055',
      'kihon/kokuki': '347AC0000000007', 'kihon/tabako': '359AC0000000072',
      'kihon/sekiyugasu': '340AC0000000156', 'kihon/sekiyusekitan': '353AC0000000025',
      'kihon/dengenkaihatsu': '349AC0000000079',
      'kihon/tsusoku': TSUSOKU, 'kobetsu/zeimuchosa': TSUSOKU,
      'kihon/chosyu': CHOSYU, 'kobetsu/chosyu': CHOSYU,
    };
    const targets = [];
    const skipped = {};
    for (const r of remain) {
      if (/\/renketsu\//.test(r.source_url || '')) { skipped.renketsu = (skipped.renketsu || 0) + 1; continue; }
      const lawId = BASE_BY_PATH[r.circular_path || ''];
      if (!lawId) { skipped[r.circular_path || '?'] = (skipped[r.circular_path || '?'] || 0) + 1; continue; }
      targets.push({ sp: r.source_path, no: r.no, lawId });
    }
    fs.writeFileSync(path.join(STATE, `tsutatsu_assign_targets_${stamp}.json`), JSON.stringify(targets, null, 1));
    console.log(`  対象外として除いた: ${JSON.stringify(skipped)}`);
    console.log(`→ state/tsutatsu_assignments_${stamp}.json (${Object.keys(merged).length}件)`);
    console.log(`→ state/tsutatsu_assign_targets_${stamp}.json (${targets.length}件)`);
  }
}
if (require.main === module) main();
