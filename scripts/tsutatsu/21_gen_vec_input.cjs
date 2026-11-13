// 21: 版の切替（v3 → v4 など）に必要な埋め込み入力を作る（R2読み取りのみ・Vectorizeには触れない）。
//     前回ビルド＝TSU_PREV（既定 v3。R2 から読む）、今回＝TSU_VER（必須。出力ファイル名に入る）。
//
//   text / id / metadata の作り方は 11_embed_giants.cjs と 16_embed_reverse.cjs の
//   実物からそのまま読み込んで使う（写しを書かない）。1文字でも違うと既存ベクトルと
//   意味空間がずれ、同じ通達が別ベクトルになる。
//
//   出力（docs/benchmarks/tax_ab/data/）:
//     vec_input_{ver}.ndjson        {id, namespace, text, metadata}  新規・本文が変わって埋め込み直すもの
//     vec_homes_update_{ver}.ndjson {id, namespace, metadata}        homes だけ差し替えるもの
//     vec_compat_check_{ver}.ndjson 既存20本と同じ text（cosine 検証用）
//     vec_delete_{ver}.ndjson       {id, namespace}                  消えた通達（PREV_ITEMS を渡したときだけ）
//
//   TSU_VER=v4 [PREV_ITEMS=scripts/tsutatsu/state/tsutatsu_items_20260902.ndjson] node scripts/tsutatsu/21_gen_vec_input.cjs
//
//   PREV_ITEMS（前回ビルドの tsutatsu_items）を渡すと、同じ id（同じ URL・同じ番号）で本文か見出しが
//   変わった通達を埋め込み直しの対象に入れ、前回あって今回無い通達を削除の一覧に出す。
//   渡さないと「id が無ければ新規」だけで判定する（改正された通達のベクトルが古いまま残る）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SITE = require('../site_config.cjs');
const REPO = path.join(__dirname, '..', '..');
const STATE = path.join(__dirname, 'state');
const OUT = path.join(REPO, 'docs', 'benchmarks', 'tax_ab', 'data');
const ACCT = process.env.CF_ACCOUNT_ID || SITE.cfAccountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}` };
const VEC_THRESHOLD = 70;
const TSU_PREV = process.env.TSU_PREV || 'v3';
const TSU_VER = process.env.TSU_VER;
if (!TSU_VER || TSU_VER === TSU_PREV) { console.error(`TSU_VER（新しい版。例 v4）を TSU_PREV=${TSU_PREV} と別に指定してください`); process.exit(1); }
const norm = (s) => String(s || '').replace(/[−–—―ー－]/g, '-').replace(/\s/g, '').trim();

// 既存スクリプトから jou2title / LAW_NAME を実物のまま借りる
function loadFrom16() {
  const src = fs.readFileSync(path.join(__dirname, '16_embed_reverse.cjs'), 'utf8');
  const lawName = (src.match(/const LAW_NAME = \{[\s\S]*?\n\};/) || [])[0];
  const intToKanji = (src.match(/function intToKanji\([\s\S]*?\n\}/) || [])[0];
  const jou2title = (src.match(/function jou2title\([\s\S]*?\n\}/) || [])[0];
  if (!lawName || !intToKanji || !jou2title) throw new Error('16_embed_reverse から関数を取り出せない');
  return new Function(`${lawName}\n${intToKanji}\n${jou2title}\nreturn { LAW_NAME, jou2title };`)();
}

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

(async () => {
  // 実在id（22番が Vectorize から取得）を渡すと、新規/既存の判定にこれを使う。
  //   REVERSE_EXISTING=scripts/tsutatsu/state/reverse_existing_ids.json
  const EXIST_IDS = process.env.REVERSE_EXISTING
    ? new Set(JSON.parse(fs.readFileSync(process.env.REVERSE_EXISTING, 'utf8'))) : null;
  const REV_ONLY = process.argv.includes('--reverse-delta');   // _reverse の新規だけ出す
  // 既に別ファイルで埋め込み中の id を差分から除く（ユーザーPCで走っている
  // vec_input_v3 の838本を二重に埋め込ませないため）
  const EXCL = process.env.EXCLUDE_IDS
    ? new Set(require('zlib').gunzipSync(fs.readFileSync(process.env.EXCLUDE_IDS)).toString('utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l).id)) : null;
  // _reverse の候補を新規/既存の区別なく全部書き出す（22番で実在確認するための入力）
  const DUMP_ALL = (process.argv.find((a) => a.startsWith('--dump-rev-all=')) || '').split('=')[1] || null;
  // 巨大条文側も同じ検証をする。「v2 のチャンクに番号があるから既にベクトルがある」と
  // みなして skip している分が、本当に Vectorize にあるかは別問題。
  const DUMP_G = (process.argv.find((a) => a.startsWith('--dump-giant-all=')) || '').split('=')[1] || null;
  const { LAW_NAME, jou2title } = loadFrom16();
  const stamp = fs.readdirSync(STATE).filter((x) => /^tsutatsu_items_\d{8}\.ndjson$/.test(x)).sort().pop().match(/(\d{8})/)[1];

  // 通達本文: (source_url|no) -> {body, caption}
  const itemMap = {};
  for (const l of fs.readFileSync(path.join(STATE, `tsutatsu_items_${stamp}.ndjson`), 'utf8').split('\n')) {
    if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    itemMap[`${o.source_url}|${o.tsutatsu_no}`] = { body: o.body || '', caption: o.caption || '' };
  }
  // 前回ビルドの通達本文（PREV_ITEMS）: (source_url|no) -> 見出し＋本文。改正・削除の判定に使う
  const prevItems = process.env.PREV_ITEMS ? new Map() : null;
  if (prevItems) {
    for (const l of fs.readFileSync(process.env.PREV_ITEMS, 'utf8').split('\n')) {
      if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
      prevItems.set(`${o.source_url}|${o.tsutatsu_no}`, { body: o.body || '', caption: o.caption || '' });
    }
  }
  // 削除の判定は「最終チャンク（08 → 24 の後のローカル tsutatsu_chunks_{TSU_VER}）」を正にする。
  //   今回の items に無くても、24 が前回版から復元して残した通達はベクトルも残す。
  const finalByUrl = new Set();      // url|番号（正規化）
  const finalByKey = new Map();      // 条キー -> 番号（正規化）の集合
  if (prevItems) {
    const dir = path.join(REPO, `tsutatsu_chunks_${TSU_VER}`);
    if (!fs.existsSync(dir)) { console.error(`${dir} がありません。PREV_ITEMS を使うときは 08・24 の後に流してください（削除は最終チャンクで判定する）`); process.exit(1); }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
      const lawId = path.basename(f, '.json');
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const [jou, arr] of Object.entries(d)) {
        if (!Array.isArray(arr)) continue;
        const set = new Set();
        for (const t of arr) { const n = norm(t.no || t.title); set.add(n); if (t.url) finalByUrl.add(`${t.url}|${n}`); }
        finalByKey.set(`${lawId}:${jou}`, set);
      }
    }
  }
  const changedItem = (k) => {
    if (!prevItems) return false;
    const a = prevItems.get(k), b = itemMap[k];
    return !!(a && b && (a.body !== b.body || a.caption !== b.caption));
  };
  // 前回ビルド（TSU_PREV）の条→番号。変数名の v2 は歴史的なもの（中身は TSU_PREV）
  const v2 = new Map();
  const v2Raw = new Map();     // 条キー -> 生の番号の集合（巨大条文の削除 id を作るため）
  const v2ByUrl = new Map();   // (url|番号) -> Set(条キー)
  for (const k of await listKeys(`tsutatsu_chunks_${TSU_PREV}/`)) {
    const lawId = path.basename(k, '.json'); if (lawId === 'index') continue;
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/${encodeURIComponent(k)}`, { headers: H });
    if (!r.ok) continue;
    const d = await r.json();
    for (const [jou, arr] of Object.entries(d)) {
      if (!Array.isArray(arr)) continue;
      v2.set(`${lawId}:${jou}`, new Set(arr.map((t) => norm(t.no || t.title))));
      v2Raw.set(`${lawId}:${jou}`, new Set(arr.map((t) => String(t.no || t.title || '')).filter(Boolean)));
      // homes の比較は (url, 番号) で行う。番号だけだと国税徴収法のように条ごとに
      // 番号が振り直される体系で別の通達を同一視してしまう（5,715件に水増しされた）。
      for (const t of arr) {
        const k = `${t.url || ''}|${norm(t.no || t.title)}`;
        if (!v2ByUrl.has(k)) v2ByUrl.set(k, new Set());
        v2ByUrl.get(k).add(`${lawId}:${jou}`);
      }
    }
  }
  const links = JSON.parse(fs.readFileSync(path.join(STATE, `article_tsutatsu_links_${stamp}.json`), 'utf8'));
  // 条キーに空白があると namespace が Worker（空白なし）とずれる（07 が除く。古い 07 の出力を読んだときの止め）
  const spacedKeys = Object.keys(links).filter((k) => /\s/.test(k.slice(k.indexOf(':') + 1)));
  if (spacedKeys.length) { console.error(`条キーに空白が ${spacedKeys.length} 件（例 ${spacedKeys.slice(0, 3).join(' / ')}）。07_build_links を今のコードで流し直してください`); process.exit(1); }

  const input = [], homesUpd = [], giantSkipped = [];
  const seen = new Set(), gSeen = new Set();
  let cntA = 0, cntB = 0, cntC = 0, cntD = 0;
  const del = [];

  // (a)(b) 巨大条文。新規namespace の条は「全件」入れる（増分だけだと絞り込みで既存が消える）
  for (const [key, refs] of Object.entries(links)) {
    // 【重要】閾値の判定は「重複排除後の本数」で行う。08_build_chunks が refDedupKey で
    //   重複を落とした結果が Worker の見る本数なので、refs.length（cross 関係や
    //   同一通達の複数エントリを含む生の数）で判定すると対象が水増しされる。
    const uniqNos = new Set(refs.map((r) => norm(r.tsutatsu_no || r.title)));
    if (uniqNos.size <= VEC_THRESHOLD) continue;
    const [lawId, jou] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const old = v2.get(key) || new Set();
    const wasBig = old.size > VEC_THRESHOLD;
    for (const r of refs) {
      const no = r.tsutatsu_no || r.title || ''; if (!no) continue;
      // 本文か見出しが前回から変わった通達は、既にベクトルがあっても埋め込み直す（同じ id に上書き）
      const reembed = wasBig && old.has(norm(no)) && changedItem(`${r.source_url}|${r.tsutatsu_no}`);
      if (wasBig && old.has(norm(no)) && !reembed) {        // 既にベクトルがある（はず）
        if (DUMP_G) {
          const gid = crypto.createHash('md5').update(`${lawId}:${jou}:${no}`).digest('hex');
          if (!gSeen.has(gid)) { gSeen.add(gid); giantSkipped.push({ id: gid, namespace: key, metadata: { no: String(no) } }); }
        }
        continue;
      }
      const it = itemMap[`${r.source_url}|${r.tsutatsu_no}`] || {};
      const text = (`${it.caption || ''} ${(it.body || '').slice(0, 4000)}`).trim() || String(no);
      const id = crypto.createHash('md5').update(`${lawId}:${jou}:${no}`).digest('hex');
      if (seen.has(id)) continue; seen.add(id);
      input.push({ id, namespace: key, text, metadata: { no: String(no) } });
      if (reembed) cntD++; else if (wasBig) cntA++; else cntB++;
    }
  }

  // 前回は巨大条文だった条の namespace から、今回その条に無い番号を消す（残すと絞り込みで幽霊が当たる）。
  //   前回の巨大条文を全部回す（今回の links から条ごと消えた場合も拾うため）。
  //   残すのは、今回の links にある番号と、最終チャンク（24 の復元込み）にある番号。
  if (prevItems) {
    for (const [key, old] of v2) {
      if (old.size <= VEC_THRESHOLD) continue;
      const nowNos = new Set((links[key] || []).map((r) => norm(r.tsutatsu_no || r.title)));
      const finalNos = finalByKey.get(key) || new Set();
      for (const no of v2Raw.get(key) || []) {
        if (nowNos.has(norm(no)) || finalNos.has(norm(no))) continue;
        del.push({ id: crypto.createHash('md5').update(`${key}:${no}`).digest('hex'), namespace: key, metadata: { no } });
      }
    }
  }

  // (c)(d) _reverse
  const revV2 = new Set();
  for (const s of v2.values()) for (const x of s) revV2.add(x);
  const homesChanged = (t) => {
    const before = v2ByUrl.get(`${t.src}|${norm(t.no)}`);
    if (!before) return true;
    if (before.size !== t.homes.size) return true;
    for (const k of t.homes) if (!before.has(k)) return true;
    return false;
  };
  const byTsu = {};
  for (const [key, refs] of Object.entries(links)) {
    for (const r of refs) {
      if (r.source !== 'html') continue;
      const k = `${r.source_url}|${r.tsutatsu_no}`;
      const it = itemMap[k];
      if (!it || !it.body || it.body.length < 20) continue;   // 16 と同じ足切り
      const id = crypto.createHash('md5').update('rev|' + k).digest('hex');
      if (!byTsu[id]) {
        const flat = it.body.replace(/\s+/g, ' ').trim();
        const snip = (flat.match(/^.{0,120}?。/) || [flat.slice(0, 100)])[0];
        // 【2026-09-03 修正】新規/既存の判定を「通達番号が v2 のどこかにあるか」で
        //   やっていた。番号は法令をまたいで重複する（国税徴収法は条ごとに振り直す）ので、
        //   v3 で初めて拾った通達1,239本が「既存」に化け、homes更新だけ出して
        //   本文の埋め込みが作られなかった。実在確認は Vectorize の get_by_ids
        //   （22番）で取った id 集合を唯一の真実として使う。
        const isNew = EXIST_IDS ? !EXIST_IDS.has(id) : !revV2.has(norm(r.tsutatsu_no));
        byTsu[id] = { key: k, no: String(r.tsutatsu_no), cap: (it.caption || '').slice(0, 80), snip,
          src: r.source_url || '', text: `${it.caption || ''} ${it.body.slice(0, 1500)}`.trim(), homes: new Set(), isNew };
      }
      byTsu[id].homes.add(key);
    }
  }
  const revAll = [];
  for (const [id, t] of Object.entries(byTsu)) {
    const homes = [...t.homes].map((hk) => { const i = hk.indexOf(':'); const lid = hk.slice(0, i), jou = hk.slice(i + 1); return { l: lid, n: LAW_NAME[lid] || lid, a: jou2title(jou) }; });
    const metadata = { no: t.no, cap: t.cap, snip: t.snip || '', src: t.src, homes: JSON.stringify(homes) };
    if (DUMP_ALL) revAll.push({ id, namespace: '_reverse', text: t.text, metadata });
    if (t.isNew) { input.push({ id, namespace: '_reverse', text: t.text, metadata }); cntC++; }
    else if (changedItem(t.key)) { input.push({ id, namespace: '_reverse', text: t.text, metadata }); cntD++; }
    else if (homesChanged(t)) homesUpd.push({ id, namespace: '_reverse', metadata });
    // homes が変わっていない既存通達は触らない（全件 upsert すると本番の 11,763本を
    // 無用に書き換えることになる。差分だけ出す）
  }

  // 前回の通達のうち、今回 _reverse を作らない通達の _reverse を消す（id は 16 と同じ md5('rev|url|番号')）。
  //   ページから消えた通達に加え、ページには残っていても紐付けが無くなって最終チャンクから外れた通達も消す
  //   （残すと古い homes のまま、今は対応しない条へ橋渡しする）。24 が復元して最終チャンクに残した通達は消さない。
  if (prevItems) {
    for (const [k, v] of prevItems) {
      if (!v.body || v.body.length < 20) continue;    // 16 と同じ足切り（元から入っていない）
      const bar = k.lastIndexOf('|');
      if (finalByUrl.has(`${k.slice(0, bar)}|${norm(k.slice(bar + 1))}`)) continue;   // 最終チャンクにある（24 の復元を含む）
      const id = crypto.createHash('md5').update('rev|' + k).digest('hex');
      if (!byTsu[id]) del.push({ id, namespace: '_reverse', metadata: { key: k } });
    }
  }

  // 互換性チェック用（既存にもある通達から20本）
  //   本文・見出しが変わったものは除く（新しい本文と本番の古いベクトルを比べると、正常でも cosine が下がる）
  const compat = Object.entries(byTsu).filter(([, t]) => !t.isNew && !changedItem(t.key)).slice(0, 20)
    .map(([id, t]) => ({ id, namespace: '_reverse', text: t.text }));

  fs.mkdirSync(OUT, { recursive: true });
  if (DUMP_G) {
    fs.writeFileSync(DUMP_G, giantSkipped.map((o) => JSON.stringify(o)).join('\n') + '\n');
    console.log(`巨大条文で「既存だから入れない」と判定した分: ${giantSkipped.length}件 → ${DUMP_G}`);
    return;
  }
  if (DUMP_ALL) {
    fs.writeFileSync(DUMP_ALL, revAll.map((o) => JSON.stringify(o)).join('\n') + '\n');
    console.log(`_reverse 候補（新規既存問わず）: ${revAll.length}件 → ${DUMP_ALL}`);
    return;
  }
  if (REV_ONLY) {
    const rev = input.filter((o) => o.namespace === '_reverse' && !(EXCL && EXCL.has(o.id)));
    const f = path.join(OUT, `vec_input_${TSU_VER}_delta_reverse.ndjson`);
    fs.writeFileSync(f, rev.map((o) => JSON.stringify(o)).join('\n') + '\n');
    console.log(`vec_input_${TSU_VER}_delta_reverse.ndjson  ${rev.length}件 ${(fs.statSync(f).size / 1e6).toFixed(1)}MB`);
    const g = input.filter((o) => o.namespace !== '_reverse').length;
    console.log(`  （巨大条文ぶん ${g}件・除外した既出 ${input.length - g - rev.length}件・homes更新 ${homesUpd.length}件 はこのモードでは書かない）`);
    return;
  }
  const w = (f, arr) => { fs.writeFileSync(path.join(OUT, f), arr.map((o) => JSON.stringify(o)).join('\n') + '\n'); return (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(1); };
  const s1 = w(`vec_input_${TSU_VER}.ndjson`, input);
  const s2 = w(`vec_homes_update_${TSU_VER}.ndjson`, homesUpd);
  const s3 = w(`vec_compat_check_${TSU_VER}.ndjson`, compat);
  console.log(`前回ビルド tsutatsu_chunks_${TSU_PREV} / 今回 ${TSU_VER}${prevItems ? '' : '（PREV_ITEMS なし: 改正・削除は判定しない）'}`);
  console.log(`vec_input_${TSU_VER}.ndjson        ${input.length}件 ${s1}MB`);
  console.log(`  (a) 巨大条文の増分         ${cntA}本`);
  console.log(`  (b) 新規namespace の全件   ${cntB}本`);
  console.log(`  (c) _reverse の新規        ${cntC}本`);
  console.log(`  (d) 本文・見出しが変わって埋め込み直す ${cntD}本（巨大条文と _reverse の合計）`);
  console.log(`vec_homes_update_${TSU_VER}.ndjson ${homesUpd.length}件 ${s2}MB  （metadata のみ・再埋め込み不要）`);
  console.log(`vec_compat_check_${TSU_VER}.ndjson ${compat.length}件 ${s3}MB`);
  const delFile = path.join(OUT, `vec_delete_${TSU_VER}.ndjson`);
  if (!prevItems && fs.existsSync(delFile)) {
    // 前の実行の削除計画が残っていると、今回の生成結果と食い違ったまま本番に当てかねない
    fs.unlinkSync(delFile);
    console.log(`vec_delete_${TSU_VER}.ndjson を消した（PREV_ITEMS なしでは削除計画を作らない。前の実行の残りを使わせないため）`);
  }
  if (prevItems) {
    const delU = [...new Map(del.map((o) => [`${o.namespace}|${o.id}`, o])).values()];
    const s4 = w(`vec_delete_${TSU_VER}.ndjson`, delU);
    console.log(`vec_delete_${TSU_VER}.ndjson       ${delU.length}件 ${s4}MB  （消えた通達。R2 を切り替えた後に local_vec_v3.py delete で消す）`);
  }
})();
