// Phase 4: 条文⇔通達リンク表（アンカー表）を構築。
// HTML通達項目(03) ＋ PDF個別通達(05) の引用条文を、通達グループ→ベース法令マップで law_id に解決し、
// 「条文(law_id+条番号) → 通達参照[]」の逆引きインデックスを作る。
//
// ベース法令は各通達の凡例（略語定義）で裏取り済み：
//   hojin/renketsu/kobetsu-hojin → 法人税法、shotoku → 所得税法、sisan/sozoku/hyoka → 相続税法、
//   shohi → 消費税法、tsusoku → 国税通則法、chosyu → 国税徴収法、措置法(kind) → 租税特別措置法。
//   間接諸税個別(kansetsu)等は法令混在のため未マップ（アンカー対象外＝取りこぼしをログ）。
//
// 出力:
//   scripts/tsutatsu/state/article_tsutatsu_links_YYYYMMDD.json   { "<law_id>:<条>": [ref, ...] }

const fs = require('fs');
const path = require('path');
const STATE_DIR = path.join(__dirname, 'state');

function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter((x) => /^tsutatsu_items_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

const HOJIN = { '法': '340AC0000000034', '令': '340CO0000000097', '規': '340M50000040012', '規則': '340M50000040012' };
const SHOTOKU = { '法': '340AC0000000033', '令': '340CO0000000096', '規': '340M50000040011', '規則': '340M50000040011' };
const SOZOKU = { '法': '325AC0000000073', '令': '325CO0000000071', '規': '325M50000040017', '規則': '325M50000040017' };
const SHOHI = { '法': '363AC0000000108', '令': '363CO0000000360', '規': '363M50000040053', '規則': '363M50000040053' };
const TSUSOKU = { '法': '337AC0000000066', '令': '337CO0000000135', '規': '337M50000040028', '規則': '337M50000040028' };
const CHOSYU = { '法': '334AC0000000147', '令': '334CO0000000329', '規': '337M50000040031', '規則': '337M50000040031' };
const DENCHO = { '法': '410AC0000000025', '規': '410M50000040043', '規則': '410M50000040043' }; // 電子帳簿保存法(+施行規則)
const CHIKA = { '法': '403AC0000000069', '令': '403CO0000000174', '規': '403M50000040031', '規則': '403M50000040031' };  // 地価税法(+施行令/規則)
const BASE = {
  'kihon/hojin': HOJIN, 'kobetsu/hojin': HOJIN, 'kihon/renketsu': HOJIN,
  'kihon/shotoku': SHOTOKU, 'kobetsu/shotoku': SHOTOKU,
  'kihon/sisan': SOZOKU, 'kobetsu/sozoku': SOZOKU, 'kobetsu/hyoka': SOZOKU,
  'kihon/shohi': SHOHI,
  'kihon/tsusoku': TSUSOKU,
  'kihon/chosyu': CHOSYU, 'kobetsu/chosyu': CHOSYU,
  'kobetsu/zeimuchosa': TSUSOKU, // 税務調査手続通達 → 国税通則法(調査の条)
  'kobetsu/kansetsu': SHOHI,     // 間接諸税(総額表示等) → 消費税法
  'kihon/inshi': { '法': '342AC0000000023', '令': '342CO0000000108', '規': '342M50000040019', '規則': '342M50000040019' },
  'kihon/sake': { '法': '328AC0000000006' },
  'kihon/kanko': { '法': '430AC0000000016' },
};
// kobetsu/sonota は1パスに3種の通達が混在（耐用年数/借地権=地価税/電帳法）→ source_path で法令を判定
function lawMapFor(item) {
  const sp = item.source_path || item.source_url || '';
  if (/sonota\/980528/.test(sp)) return DENCHO;     // 電子帳簿保存法通達
  if (/sonota\/911218/.test(sp)) return CHIKA;      // 地価税法通達（借地権等の意義）
  if (/sonota\/700525/.test(sp)) return HOJIN;      // 耐用年数通達 → 法人税(施行令)
  return BASE[item.circular_path];
}
const SOCHI_LAW = '332AC0000000026';
const SOCHI_REI = '332CO0000000043';     // 租税特別措置法施行令（「措置法令第○条」）
const SOCHI_KISOKU = '332M50000040015';  // 租税特別措置法施行規則（「措置法規則/規第○条」）
// law_id→正式名称。本文に略称でなくフル名称で自法令を引用する型（「法人税法施行令第51条」等）の救済に使う。
const NAME = {
  '340AC0000000034': '法人税法', '340CO0000000097': '法人税法施行令', '340M50000040012': '法人税法施行規則',
  '340AC0000000033': '所得税法', '340CO0000000096': '所得税法施行令', '340M50000040011': '所得税法施行規則',
  '325AC0000000073': '相続税法', '325CO0000000071': '相続税法施行令', '325M50000040017': '相続税法施行規則',
  '363AC0000000108': '消費税法', '363CO0000000360': '消費税法施行令', '363M50000040053': '消費税法施行規則',
  '337AC0000000066': '国税通則法', '337CO0000000135': '国税通則法施行令',
  '334AC0000000147': '国税徴収法', '334CO0000000329': '国税徴収法施行令',
  '342AC0000000023': '印紙税法', '342CO0000000108': '印紙税法施行令', '342M50000040019': '印紙税法施行規則',
  '332AC0000000026': '租税特別措置法', '332CO0000000043': '租税特別措置法施行令', '332M50000040015': '租税特別措置法施行規則',
  '410AC0000000025': '電子帳簿保存法', '403AC0000000069': '地価税法',
};
// 本文からベース法令のフル名称＋第○条を拾う（規則→令→法の順＝長い名称優先）。見つからなければ null。
function fullCiteKey(b, body) {
  if (!b || !body) return null;
  for (const kind of ['規則', '令', '法']) {
    const lid = b[kind]; if (!lid || !NAME[lid]) continue;
    const mm = body.match(new RegExp(NAME[lid].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '第(\\d+)条((?:の\\d+)*)'));
    if (mm) return `${lid}:${mm[1]}${(mm[2] || '').replace(/\s*の\s*/g, 'の')}`;
  }
  return null;
}

function resolve(b, cite) {
  if (cite.kind === '措置法') return { law_id: SOCHI_LAW, article: cite.article, branch: cite.branch };
  if (cite.kind === '措置法令') return { law_id: SOCHI_REI, article: cite.article, branch: cite.branch };
  if (cite.kind === '措置法規則') return { law_id: SOCHI_KISOKU, article: cite.article, branch: cite.branch };
  if (cite.kind.endsWith('附則')) { // 「法附則第○条」等。article は "附則N"。本則の条と衝突しない別キー。
    const bk = cite.kind.slice(0, -2); // 措置法|法|令|規則
    const lid = bk === '措置法' ? SOCHI_LAW : (b && b[bk]);
    return lid ? { law_id: lid, article: cite.article, branch: null } : null;
  }
  if (!b) return null;
  const law_id = b[cite.kind];
  if (!law_id) return null;
  return { law_id, article: cite.article, branch: cite.branch };
}

function artKey(r) {
  return `${r.law_id}:${r.article}${r.branch ? 'の' + r.branch : ''}`;
}
// 通達番号の条プレフィックス（"68の18-2"→"68の18", "41の5-14"→"41の5"）
function prefixOf(no) { const m = String(no || '').match(/^(\d+(?:の\d+)*)-\d+(?:の\d+)*$/); return m ? m[1] : null; }

// 附則ページの内容（施行期日・適用時期・経過的取扱）と純施行文＝住所を持たない構造的項目（削除と同様に出力対象外）。
// 注: 「第1 〜関係」等のキャプションだけで切ると実体ある個別通達まで巻き込むので、ラベル=附則 と 純施行文に限定。
function isStructural(item) {
  const lab = (item.home || {}).label || '';
  if (/^附則/.test(lab)) return true;
  const body = (item.body || '').replace(/&emsp;|[\s　]/g, '');
  if (/^(この|本)?(政令|省令|法律|改正|通達|告示)は[^。]{0,30}施行する。?$/.test(body)) return true; // 施行文だけの項目
  return false;
}
// 節→条マップ：本文に条が無く節タイトルだけの型を、節が対応する条に決定的に割当（誤配回避で確実なものだけ）。
function sectionKey(item) {
  const lab = (item.home || {}).label || '';
  const no = String(item.tsutatsu_no || '');
  if (item.circular_path === 'kihon/shohi' && /関係/.test(lab) && /^6(?:\D|$)/.test(no)) return '363AC0000000108:6'; // 消費税基本通達 非課税各節(第1〜13節「〜関係」/番号6始まり)→ 消費税法第6条(非課税)
  if (item.circular_path === 'kihon/inshi') return '342AC0000000023:2';                                              // 印紙税基本通達 各節→ 印紙税法第2条(課税物件＝別表第一)
  if (item.circular_path === 'kihon/shohi' && /国外事業者/.test(lab)) return '363AC0000000108:2';                    // 消費税法第2条(定義: 国外事業者)
  if (item.circular_path === 'kihon/hojin' && /資本金等の額及び資本等取引/.test(lab)) return '340AC0000000034:2';   // 法人税法第2条(資本金等の額の定義)
  if (item.circular_path === 'kihon/hojin' && /外貨建資産等の換算/.test(lab)) return '340AC0000000034:61の8';       // 法人税法第61条の8(外貨建取引の換算)
  return null;
}

function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function main() {
  const stamp = process.argv[2] || latestStamp();
  const htmlItems = readNdjson(path.join(STATE_DIR, `tsutatsu_items_${stamp}.ndjson`));
  // 【2026-09-02 修正】pdf_items が無いのを黙って空配列にしていたため、PDF由来の通達129本が
  //   丸ごと欠落したビルドが「正常終了」していた（74条から通達が消えた死因）。
  //   不在なら止める。意図的にHTMLだけで回すときは --allow-missing-pdf を付ける。
  const pdfFile = path.join(STATE_DIR, `pdf_items_${stamp}.ndjson`);
  if (!fs.existsSync(pdfFile) && !process.argv.includes('--allow-missing-pdf')) {
    console.error(`エラー: ${pdfFile} がありません。`);
    console.error('  PDF由来の通達が丸ごと欠けたリンク表ができます（前回これで74条ぶんが消えました）。');
    console.error('  04_fetch_pdfs.cjs → 05_extract_pdf_text.py を実行するか、');
    console.error('  承知のうえで続ける場合は --allow-missing-pdf を付けてください。');
    process.exit(1);
  }
  const pdfItems = readNdjson(pdfFile);
  const asgFile = path.join(STATE_DIR, `tsutatsu_assignments_${stamp}.json`);
  const assignments = fs.existsSync(asgFile) ? JSON.parse(fs.readFileSync(asgFile, 'utf8')) : {}; // 13_assign のビルド時LLM割当

  const index = {}; // artKey -> [ref]
  let resolved = 0, orphan = 0;
  const orphanByLaw = {};
  const seenTsutatsu = new Set();
  const orphanItems = [];
  const status = { sochiho: 0, home_jou: 0, cite: 0, hyoka22: 0, taiyo: 0, go_taisho: 0, fullcite: 0, section: 0, chika: 0, assigned: 0, structural: 0, orphan: 0 };

  // 範囲番号（「23~35共-1」「42の6~48(共)-1」「68の10~68の36(共)-1」）は
  // 範囲内の条すべてに共通して適用される通達。範囲内の全条に貼らないと、
  // 先頭条以外からは辿れない。RANGE_MODE=first で先頭条のみに切り替えられる。
  //
  // 展開規則（条の体系に合わせる。素の条と枝番条は別物なので混ぜない）:
  //   23~35            → 23,24,…,35
  //   42の6~47         → 42の6（起点そのもの）と 43,…,47。素の42条は範囲外なので含めない
  //   55~57の8         → 55,56 と 57の8（終点そのもの）。素の57条は含めない
  //   68の10~68の36    → 同じ条の枝番なので 68の10,68の11,…,68の36
  const RANGE_MODE = process.env.RANGE_MODE || 'all';
  const RANGE_NO = /^(\d+(?:の\d+)*)[~～](\d+(?:の\d+)*)[(（]?共[)）]?-/;
  // 列挙型「36・37共-1」は書かれている条だけに紐づける（範囲ではないので間を埋めない）
  //   「共」の無い「10・10の２-1」（令和8年9月の措置法通達の改正の形）も同じ（03 で全角数字は半角に直っている）
  const LIST_NO = /^(\d+(?:の\d+)*(?:・\d+(?:の\d+)*)+)(?:[(（]?共[)）]?)?-/;
  function expandRange(no) {
    const lm = String(no || '').match(LIST_NO);
    if (lm) {
      const arts = lm[1].split('・');
      return RANGE_MODE === 'first' ? [arts[0]] : arts;
    }
    const m = String(no || '').match(RANGE_NO);
    if (!m) return null;
    const from = m[1], to = m[2];
    if (RANGE_MODE === 'first') return [from];
    const fp = from.split('の').map(Number), tp = to.split('の').map(Number);
    const out = [];
    if (fp[0] === tp[0]) {
      // 同一条の枝番の範囲（68の10~68の36）
      if (fp.length === 2 && tp.length === 2 && tp[1] >= fp[1]) {
        for (let i = fp[1]; i <= tp[1]; i++) out.push(`${fp[0]}の${i}`);
      } else out.push(from);
      return out;
    }
    if (tp[0] < fp[0]) return [from];
    // 起点: 枝番つきならその枝番から、素の条番号は含めない
    out.push(from);
    for (let n = fp[0] + 1; n < tp[0]; n++) out.push(String(n));
    out.push(to);
    return [...new Set(out)];
  }

  // 通達アイテム → { primary:[artKey], cross:[artKey] }。主＝住所(home)、cross＝本文で触れる関連条文。
  function resolveItem(item) {
    const circ = item.circular_path;
    // sochiho（措置法個別通達）では凡例上「法／令／規則」＝措置法ファミリー。ベース法(相続税法等)に解決すると誤配（70条の6は措置法）。
    let b = lawMapFor(item);
    if (/\/sochiho\//.test(item.source_path || '')) b = { '法': SOCHI_LAW, '令': SOCHI_REI, '規則': SOCHI_KISOKU, '規': SOCHI_KISOKU };
    const cites = [...new Set((item.citations || []).map((c) => resolve(b, c)).filter(Boolean).map(artKey))];
    const home = item.home || {};
    // -2) R2 v2 から復元した項目（20_recover_pdf_items）は、前回ビルドが決めた条を
    //     そのまま持っている。再解決すると別の結果になりかねないので、そのまま使う。
    if (Array.isArray(item.recovered_arts) && item.recovered_arts.length) {
      status.recovered = (status.recovered || 0) + 1;
      return { primary: item.recovered_arts, cross: [] };
    }
    // -1) 附則/見出し行/適用時期等の構造的項目は住所を持たない → 出力対象外（orphanにも数えない）
    if (isStructural(item)) { status.structural++; return { primary: [], cross: [], structural: true }; }
    // -0.5) 範囲番号は番号そのものが帰属条を示している。見出しや引用より優先する。
    const rng = expandRange(item.tsutatsu_no);
    if (rng && rng.length) {
      const lawId = /\/sochiho\//.test(item.source_path || '') ? SOCHI_LAW
        : (home.law === 'sochi' ? SOCHI_LAW : (b && b['法']));
      if (lawId) {
        status.range = (status.range || 0) + 1;
        const keys = rng.map((a) => `${lawId}:${a}`);
        return { primary: keys, cross: cites.filter((k) => !keys.includes(k)) };
      }
    }
    // 0) 措置法の個別通達(sochiho)：見出し/番号の条はすべて措置法。ベース法(法人/所得)に貼る誤りを防ぐ本命。
    //    例「第68条の18関係」は措置法68の18（"措置法"の字が無くても sochiho パス＝措置法個別通達）。番号68の18-2も措置法68の18。
    if (/\/sochiho\//.test(item.source_path || '')) {
      let art = (home.kind === 'jou' && home.jou) ? home.jou : prefixOf(item.tsutatsu_no);
      if (!art) { const m = (item.source_path || '').match(/\/soti(\d+(?:_\d+)?)\//); if (m) art = m[1].replace(/_/g, 'の'); } // パスの soti33→措置法33条(番号も見出しも無い収用/山林等)
      if (art) { status.sochiho++; const hk = `${SOCHI_LAW}:${art}`; return { primary: [hk], cross: cites.filter((k) => k !== hk) }; }
    }
    // 1) 第○条関係：見出しの条が主。本文引用は「関連条文」(cross)に回す（誤配防止の本命）
    //    見出しが「措置法第○条関係」の場合は措置法の条に貼る（ベース法に貼ると法律違いの誤リンク）
    const homeLawId = home.law === 'sochi' ? SOCHI_LAW : (b && b['法']);
    if (home.kind === 'jou' && homeLawId) {
      const hk = `${homeLawId}:${home.jou}`;
      status.home_jou++;
      return { primary: [hk], cross: cites.filter((k) => k !== hk) };
    }
    // 2) 節/章/款・個別・号で本文引用あり：引用＝解釈対象の条が主
    if (cites.length) { status.cite++; return { primary: cites, cross: [] }; }
    // 3) フォールバック（引用なし）— 絶対に浮かせない
    if (/hyoka/.test((item.circular_path || '') + '|' + (item.source_path || ''))) { status.hyoka22++; return { primary: [`${SOZOKU['法']}:22`], cross: [] }; } // 財産評価(基本/個別)→相続税法22条(評価の原則)。PDFはsource_path欠落のためcircular_pathも見る
    if (/sonota\/700525/.test(item.source_path || '')) { status.taiyo++; return { primary: [`${HOJIN['令']}:56`, `${SHOTOKU['令']}:129`], cross: cites }; } // 耐用年数通達→法人税/所得税施行令の耐用年数条(委任元)
    if (home.kind === 'go' && b && b['法']) { status.go_taisho++; return { primary: [`${b['法']}:2`], cross: [] }; } // 印紙税の号→課税物件(第2条)
    // 3.5) 本文にベース法令を“フル名称”で引用（「法人税法施行令第51条」等＝略称網が漏らす型）→ その条が住所
    const fk = fullCiteKey(b, item.body);
    if (fk) { status.fullcite = (status.fullcite || 0) + 1; return { primary: [fk], cross: cites.filter((k) => k !== fk) }; }
    // 3.7) 節→条マップ（消費税の非課税各節→第6条 等。本文に条が無い節型を確実なものだけ決定的に割当）
    const sk = sectionKey(item);
    if (sk) { status.section++; return { primary: [sk], cross: cites.filter((k) => k !== sk) }; }
    // 3.8) 地価税法取扱通達(sonota/911218)：番号の頭＝条番号（6-24→第6条, 17-2→第17条）。別表しか引かず浮く分を救済。
    if (/sonota\/911218/.test(item.source_path || '')) {
      const art = (String(item.tsutatsu_no).match(/^(\d+(?:の\d+)*)/) || [])[1];
      if (art) { status.chika = (status.chika || 0) + 1; return { primary: [`${CHIKA['法']}:${art}`], cross: cites }; }
    }
    // 4) ビルド時LLM割当（13_assign）の住所を取り込む（節型/個別で引用も無い浮き分）
    const asg = assignments[`${item.source_path}#${item.tsutatsu_no}`];
    if (asg) { status.assigned++; return { primary: [`${asg.law_id}:${asg.article}`], cross: cites }; }
    status.orphan++;
    // 13_assign の対象を出せるよう、住所が決まらなかった通達を控えておく
    orphanItems.push({ source_path: item.source_path, source_url: item.source_url, no: item.tsutatsu_no, caption: item.caption, circular_path: item.circular_path });
    return { primary: [], cross: [] };
  }

  // 条キー「law_id:条」の条の部分から空白を除く（念のための止め。v4 までの実データに空白入りは無い）。
  //   前回ビルドからの復元（19・20）や LLM 割当（13）に「70 の7の2」のような空白入りが混じると、
  //   Worker（titleToJou は空白なし）から引けない別キーになり、その条の通達がページにも検索にも出なくなる。
  const normKey = (k) => { const i = String(k).indexOf(':'); return i < 0 ? k : k.slice(0, i + 1) + k.slice(i + 1).replace(/\s+/g, ''); };
  let keySpaceFixed = 0;
  function addItem(item, ref) {
    const r0 = resolveItem(item);
    const fix = (arr) => (arr || []).map((k) => { const n = normKey(k); if (n !== k) keySpaceFixed++; return n; });
    const primary = [...new Set(fix(r0.primary))];
    const cross = [...new Set(fix(r0.cross))].filter((k) => !primary.includes(k));
    const { structural } = r0;
    if (structural) return; // 構造的項目は出力にもorphanにも入れない
    if (!primary.length) { orphan++; orphanByLaw[item.circular_path || '?'] = (orphanByLaw[item.circular_path || '?'] || 0) + 1; return; }
    for (const k of primary) { (index[k] = index[k] || []).push({ ...ref, relation: 'home', cited_article: k }); resolved++; seenTsutatsu.add(ref.id); }
    for (const k of cross) { (index[k] = index[k] || []).push({ ...ref, relation: 'cross', cited_article: k }); seenTsutatsu.add(ref.id); }
  }

  for (const it of htmlItems) {
    addItem(it, {
      id: 'h:' + it.circular_path + ':' + it.tsutatsu_no,
      source: 'html', tsutatsu_no: it.tsutatsu_no, caption: it.caption,
      circular_path: it.circular_path, source_url: it.source_url,
    });
  }
  // 【2026-09-03】PDFタイトルの選び直し。
  //   4,281件を再抽出したとき、1ページ目の先頭行を拾う都合で様式名が本文断片に
  //   化けたものが出た（「更 正 の 請 求 書」→「（還付金額については過少となる場合）」）。
  //   R2 v2 のタイトル（現行本番が出しているもの）と見比べ、様式名らしい方を採る。
  //   由来で決め打ちせず両方に同じ物差しを当てる。逆向き（v2が断片・今回が様式名）もあるため。
  const v2TitleFile = path.join(STATE_DIR, 'pdf_titles_v2.json');
  const v2Titles = fs.existsSync(v2TitleFile) ? JSON.parse(fs.readFileSync(v2TitleFile, 'utf8')) : {};
  const FORM_WORD = /(様式|届出|申請|明細|計算|証明|要領|一覧|請求|通知|申告|報告|承認|申出|届|証書|調書|願)/;
  const SENTENCE = /(。|ます|である|により|について|場合)/;
  function titleScore(t) {
    if (!t) return -99;
    const s = String(t).replace(/\s+/g, ' ').trim();
    let v = 0;
    if (FORM_WORD.test(s)) v += 3;
    if (SENTENCE.test(s)) v -= 2;
    if (/^[（(]/.test(s)) v -= 1;
    if (s.length >= 4 && s.length <= 40) v += 1;
    if (s.length > 60) v -= 1;
    return v;
  }
  let titleSwapped = 0;
  for (const it of pdfItems) {
    if (it.error) continue;
    const alt = v2Titles[it.url];
    let title = it.title;
    if (alt && alt !== title && titleScore(alt) > titleScore(title)) { title = alt; titleSwapped++; }
    addItem(it, {
      id: 'p:' + it.url,
      source: 'pdf', title, abolished: !!it.abolished,
      circular_path: it.circular_path, source_url: it.url,
    });
  }
  if (titleSwapped) console.log(`PDFタイトル: R2 v2 側の方が様式名らしいものに差し替え ${titleSwapped}件`);

  const outFile = path.join(STATE_DIR, `article_tsutatsu_links_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(index, null, 0), 'utf8');

  // stats
  const articleKeys = Object.keys(index);
  const byLaw = {};
  for (const k of articleKeys) { const lid = k.split(':')[0]; byLaw[lid] = (byLaw[lid] || 0) + 1; }
  const lawName = { '340AC0000000034': '法人税法', '340CO0000000097': '法人税法施行令', '340M50000040012': '法人税法施行規則', '340AC0000000033': '所得税法', '340CO0000000096': '所得税法施行令', '340M50000040011': '所得税法施行規則', '325AC0000000073': '相続税法', '325CO0000000071': '相続税法施行令', '363AC0000000108': '消費税法', '363CO0000000360': '消費税法施行令', '332AC0000000026': '租税特別措置法', '332CO0000000043': '租税特別措置法施行令', '332M50000040015': '租税特別措置法施行規則', '337AC0000000066': '国税通則法', '334AC0000000147': '国税徴収法', '342AC0000000023': '印紙税法', '328AC0000000006': '酒税法', '430AC0000000016': '国際観光旅客税法' };

  if (keySpaceFixed) console.log(`条キーの空白を除いた: ${keySpaceFixed}件（「70 の7の2」→「70の7の2」など）`);
  console.log(`アンカー内訳: 措置法個別(sochiho)=${status.sochiho} 見出し(条関係)=${status.home_jou} 引用(節/個別/号)=${status.cite} 財産評価→22条=${status.hyoka22} 耐用年数→施行令=${status.taiyo} 印紙税号→2条=${status.go_taisho} フル名称引用=${status.fullcite} 節→条マップ=${status.section} 地価税(番号)=${status.chika} LLM割当=${status.assigned} / 構造除外=${status.structural} ★浮き=${status.orphan}`);
  console.log(`アンカーされた条文(distinct): ${articleKeys.length}`);
  console.log(`アンカーに乗った通達(distinct): ${seenTsutatsu.size}`);
  console.log('--- 法令別の条文数 ---');
  Object.entries(byLaw).sort((a, b) => b[1] - a[1]).forEach(([lid, n]) => console.log(String(n).padStart(5), (lawName[lid] || lid)));
  console.log('--- まだ浮いてる通達(法律別) ---', JSON.stringify(orphanByLaw));
  // top条文
  const top = articleKeys.map((k) => [k, index[k].length]).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('--- 通達が多くぶら下がる条文 top12 ---');
  top.forEach(([k, n]) => console.log(String(n).padStart(4), k, '(' + (lawName[k.split(':')[0]] || k.split(':')[0]) + ' 第' + k.split(':')[1] + '条)'));
  const orphanFile = path.join(STATE_DIR, `tsutatsu_orphans_${stamp}.json`);
  fs.writeFileSync(orphanFile, JSON.stringify(orphanItems, null, 1), 'utf8');
  console.log('出力:', outFile);
  console.log(`浮き通達の一覧: ${orphanFile} (${orphanItems.length}件)`);
}

main();
