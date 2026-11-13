// 08: リンク表(07)を /api/tsutatsu 用の独立チャンク形式に整形する。
// refs(refs_chunks_v4 / _Art{N})とは完全に別系統。通達独自の「law_id＋条番号」キーで、別R2ネームスペースへ。
//
// 出力（リポジトリ直下、R2アップロード用）:
//   tsutatsu_chunks_v1/index.json         { generated_from, laws: { <law_id>: {articles, refs} } }
//   tsutatsu_chunks_v1/<law_id>.json      { "<条番号>": [ ref, ... ] }      ← 条番号は算用数字（例 "70の6","34"）
//
// ref 形:
//   { src:"html"|"pdf", no:"9-2-12"(html) / title:"…"(pdf), cap:見出し, grp:通達グループ, url:原本URL, ab:廃止flag }

const fs = require('fs');
const path = require('path');
const STATE_DIR = path.join(__dirname, 'state');
const REPO_ROOT = path.join(__dirname, '..', '..');
// 出力先の版は TSU_VER で切り替える（既定 v1）。v2/v3 を作るときに
// スクリプトを書き換えて版を取り違えないための引数化。
const TSU_VER = process.env.TSU_VER || 'v1';
const OUT_DIR = path.join(REPO_ROOT, `tsutatsu_chunks_${TSU_VER}`);

// ===== 表示ポリシー：連結納税基本通達(renketsu)はアプリ出力から除外 =====
// 連結納税制度は2022年廃止（→グループ通算）。同じ内容が単体(hojin)の現行番号で重複して存在するため、
// チャンク(=アプリが読む出力)からは連結を隠す。
// 取得(01_crawl)とリンク表(07_build_links)には連結も“全部”残るので、差分・監査・方針変更には影響しない
// （「全部保持・出す時だけ除外」）。戻したい場合はこの正規表現を空にするだけで全件復活する。
const EXCLUDE_URL_RE = /\/renketsu\//;

// ===== 表示ポリシー②：日付アーカイブ(/YYYYMMDD/)の“重複”を除外 =====
// NTAは基本通達の旧版を /20230930/ のような日付ディレクトリに残す。これが現行版と重複する。
// ただし落とすのは「同じ番号の現行(非日付)版が別にある」場合だけ。
// 日付版しか存在しない通達（個別通達など）は唯一のコピーなので残す＝取りこぼし防止。
// 6桁の日付ディレクトリ(個別通達 /050609/ 等)は番号の一部なので対象外。8桁(YYYYMMDD)だけを対象。
const DATED_URL_RE = /\/(?:19|20)\d{6}\//;

function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter((x) => /^article_tsutatsu_links_\d{8}\.json$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

function leanRef(r, bodyMap) {
  const o = { src: r.source, grp: r.circular_path, url: r.source_url };
  if (r.source === 'html') {
    o.no = r.tsutatsu_no;
    if (r.caption) o.cap = r.caption;
    // ページ(source_url)＋番号で引く。circular_path は2階層で切られ 評基通(hyoka_new)と相基通(sozoku2)が
    // 同じ 'kihon/sisan' になる等、通達文書間で同番号衝突→本文が入れ替わる事故があった。
    const body = (bodyMap && bodyMap[`${r.source_url}|${r.tsutatsu_no}`]) || '';
    if (body) o.body = body.slice(0, 4000); // 展開表示用の本文（長すぎるものだけ切る）
  } else {
    if (r.title) o.title = r.title;
    if (r.abolished) o.ab = 1;
  }
  return o;
}

function refDedupKey(r) {
  return (r.source || '') + '|' + (r.source_url || '') + '|' + (r.tsutatsu_no || r.title || '');
}

function main() {
  const stamp = process.argv[2] || latestStamp();
  const links = JSON.parse(fs.readFileSync(path.join(STATE_DIR, `article_tsutatsu_links_${stamp}.json`), 'utf8'));

  // 通達本文（展開表示用）を tsutatsu_items から読み込む
  const bodyMap = {};
  for (const line of fs.readFileSync(path.join(STATE_DIR, `tsutatsu_items_${stamp}.ndjson`), 'utf8').split('\n').filter(Boolean)) {
    try { const it = JSON.parse(line); bodyMap[`${it.source_url}|${it.tsutatsu_no}`] = it.body; } catch {}
  }

  // law_id → { 条番号 → [ref] }
  const byLaw = {};
  let excludedTotal = 0;          // 連結除外の累計
  const excludedByLaw = {};
  let datedDupExcluded = 0;       // 日付アーカイブ重複の除外累計
  const datedDupByLaw = {};
  let datedOnlyKept = 0;          // 日付版しか無く残したもの（取りこぼし防止の確認用）
  let deletedExcluded = 0;
  let foldedDup = 0;              // 同一条・同一番号(html)の URL 違い重複を畳んだ数        // 削除/廃止済み通達（本文が「削除…」or改正履歴のみ）の除外累計
  // 条キーに空白があると Worker から引けない別キーになる（07 が除く。古い 07 の出力を読んだときの止め）
  const spaced = Object.keys(links).filter((k) => /\s/.test(k.slice(k.indexOf(':') + 1)));
  if (spaced.length) { console.error(`条キーに空白が ${spaced.length} 件（例 ${spaced.slice(0, 3).join(' / ')}）。07_build_links を今のコードで流し直してください`); process.exit(1); }
  for (const [key, refs] of Object.entries(links)) {
    const idx = key.indexOf(':');
    const lawId = key.slice(0, idx);
    const jou = key.slice(idx + 1); // "70の6" / "34"
    (byLaw[lawId] = byLaw[lawId] || {});

    // (1) 連結納税通達を除外（フラット）
    let refs2 = [];
    for (const r of refs) {
      if (EXCLUDE_URL_RE.test(r.source_url || '')) {
        excludedTotal++;
        excludedByLaw[lawId] = (excludedByLaw[lawId] || 0) + 1;
        continue;
      }
      refs2.push(r);
    }

    // (2) 日付アーカイブの重複を除外（同じ番号の現行版が別にある場合だけ落とす）
    const logicalId = (r) => (r.source || '') + '|' + (r.tsutatsu_no || r.title || '');
    const currentIds = new Set(refs2.filter((r) => !DATED_URL_RE.test(r.source_url || '')).map(logicalId));
    refs2 = refs2.filter((r) => {
      if (!DATED_URL_RE.test(r.source_url || '')) return true;
      if (currentIds.has(logicalId(r))) { // 現行版が別にある日付版＝重複 → 落とす
        datedDupExcluded++;
        datedDupByLaw[lawId] = (datedDupByLaw[lawId] || 0) + 1;
        return false;
      }
      datedOnlyKept++; // 日付版しか無い＝唯一のコピーなので残す
      return true;
    });

    // (3) 重複排除 + 整形
    const seen = new Set();
    const list = [];
    for (const r of refs2) {
      const dk = refDedupKey(r);
      if (seen.has(dk)) continue;
      seen.add(dk);
      const lr = leanRef(r, bodyMap);
      // (3b) 削除/廃止済み通達（本文が「削除…」or 改正履歴の括弧のみ）は出力しない。取得側には保持。
      const b = (lr.body || '').trim();
      if (/^削除/.test(b) || /^（[^（）]*(?:削除|廃止)[^（）]*）\s*$/.test(b)) { deletedExcluded++; continue; }
      list.push(lr);
    }
    // (3c) 【2026-09-03】目次ページ由来の重複エントリを落とす。
    //   v3 で新しく拾えるようになった目次ページ（例 kobetsu/sozoku/sochiho/080708/01.htm）は、
    //   同じ通達番号を「見出し無し・本文＝通達の題名だけ」という形で持っている。
    //   これを残すと:
    //     ・目次側が先に並ぶと画面の見出しが空になる（70の6-11 で発覚）
    //     ・選定ゲートの候補上限 slice(0,60) と、巨大条文の topK=50 を重複が食う
    //
    //   【重要】番号だけで畳んではいけない。国税徴収法基本通達のように条ごとに番号が
    //   振り直される体系では、同じ条に「法第15条関係 1」と「法第17条関係 1」が
    //   クロス参照で並ぶ。v2 の同番号ペア945組のうち921組は本文が別物だった。
    //   落とすのは「見出しが無く・本文が60字未満で・同番号の兄弟にもっと長い本文がある」
    //   ものだけ。これで目次エントリだけが消え、別物の通達は残る。
    const folded = [];
    {
      const byNo = new Map();
      for (const t of list) {
        if (t.src !== 'html') continue;
        const k = String(t.no || '').replace(/[−–—―ー－]/g, '-').replace(/\s/g, '').trim();
        (byNo.get(k) || byNo.set(k, []).get(k)).push(t);
      }
      for (const t of list) {
        if (t.src !== 'html') { folded.push(t); continue; }
        const k = String(t.no || '').replace(/[−–—―ー－]/g, '-').replace(/\s/g, '').trim();
        const sibs = byNo.get(k) || [];
        const blen = (t.body || '').replace(/\s+/g, '').length;
        const isToc = !(t.cap || '').trim() && blen < 60
          && sibs.some((o) => o !== t && (o.body || '').replace(/\s+/g, '').length > blen);
        if (isToc) { foldedDup++; continue; }
        folded.push(t);
      }
    }
    const list2 = folded;
    // html(基本通達) を先、その後 pdf。さらに番号順。
    list2.sort((a, b) => (a.src === b.src ? String(a.no || a.title || '').localeCompare(String(b.no || b.title || '')) : a.src === 'html' ? -1 : 1));
    if (list2.length) byLaw[lawId][jou] = list2; // 除外で空になった条はキーごと省く
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = {
    generated_from: stamp,
    exclusions: {
      renketsu: { rule: 'source_url に /renketsu/ を含む通達を除外（連結納税基本通達＝2022廃止→グループ通算）', total: excludedTotal },
      dated_archive: { rule: '/YYYYMMDD/ の日付アーカイブ版は、同番号の現行版が別にある場合のみ除外（唯一のコピーは残す）', total: datedDupExcluded, dated_only_kept: datedOnlyKept },
      deleted: { rule: '本文が「削除…」や改正履歴の括弧のみの廃止済み通達を出力から除外（取得側には保持）', total: deletedExcluded },
    },
    laws: {},
  };
  let totalRefs = 0;
  for (const [lawId, arts] of Object.entries(byLaw)) {
    if (!Object.keys(arts).length) continue; // 全条が空になった法令は書き出さない
    fs.writeFileSync(path.join(OUT_DIR, `${lawId}.json`), JSON.stringify(arts), 'utf8');
    const refs = Object.values(arts).reduce((s, l) => s + l.length, 0);
    totalRefs += refs;
    index.laws[lawId] = { articles: Object.keys(arts).length, refs, excluded_renketsu: excludedByLaw[lawId] || 0, excluded_dated: datedDupByLaw[lawId] || 0 };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  // stats
  const lawName = { '340AC0000000034': '法人税法', '340CO0000000097': '法人税法施行令', '340M50000040012': '法人税法施行規則', '340AC0000000033': '所得税法', '340CO0000000096': '所得税法施行令', '340M50000040011': '所得税法施行規則', '325AC0000000073': '相続税法', '325CO0000000071': '相続税法施行令', '363AC0000000108': '消費税法', '363CO0000000360': '消費税法施行令', '332AC0000000026': '租税特別措置法', '337AC0000000066': '国税通則法', '334AC0000000147': '国税徴収法', '342AC0000000023': '印紙税法', '328AC0000000006': '酒税法', '430AC0000000016': '国際観光旅客税法' };
  console.log(`出力: ${OUT_DIR}`);
  console.log(`法令ファイル: ${Object.keys(index.laws).length} / 条文キー総数: ${Object.values(byLaw).reduce((s, a) => s + Object.keys(a).length, 0)} / 通達参照総数: ${totalRefs}`);
  console.log(`連結除外(renketsu): ${excludedTotal} 件（取得側には保持。法令別: ${JSON.stringify(excludedByLaw)}）`);
  console.log(`日付アーカイブ重複除外: ${datedDupExcluded} 件（現行版があるものだけ。日付版しか無く残した: ${datedOnlyKept} 件。法令別: ${JSON.stringify(datedDupByLaw)}）`);
  console.log(`削除/廃止通達の除外: ${deletedExcluded} 件（本文が削除…のみ。取得側には保持）`);
  console.log(`目次ページ由来の重複エントリを除外: ${foldedDup} 件（見出し無し・本文が題名だけのもの）`);
  console.log('--- 法令別 (条文数 / 参照数 / ファイルKB) ---');
  Object.entries(index.laws).sort((a, b) => b[1].refs - a[1].refs).forEach(([lid, s]) => {
    const kb = Math.round(fs.statSync(path.join(OUT_DIR, `${lid}.json`)).size / 1024);
    console.log(String(s.articles).padStart(4), '条', String(s.refs).padStart(5), '参照', String(kb).padStart(4) + 'KB', lawName[lid] || lid);
  });
}

main();
