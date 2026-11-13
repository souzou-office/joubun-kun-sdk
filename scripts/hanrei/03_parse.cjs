// 裁判例の統合パース: inventory.ndjson + hanrei_raw/detail/*.html + hanrei_raw/pdftext/*.json
//   → hanrei_parsed/cases_{shard}.ndjson （1判例=1行、shard = floor(id/1000) 3桁ゼロ埋め）
//
//   node scripts/hanrei/03_parse.cjs              # 全件パース
//   node scripts/hanrei/03_parse.cjs --only 96174 # 特定IDのみ（カンマ区切り可・標準出力に表示）
//   node scripts/hanrei/03_parse.cjs --stats      # 統計のみ（書き込みなし）
//   node scripts/hanrei/03_parse.cjs --inventory path/to/inventory.ndjson  # inventoryの差し替え（テスト用）
//
// 仕様:
//   ・同一idの複数detailNをマージ（値が両方あれば長い方）
//   ・詳細ページの<dt>/<dd>をフィールド契約へマップ（detail8固有6項目は chizai へ）
//   ・PDFテキストから主文抽出＋セクション分割（type: shubun/gaiyou/zentei/souten/handan/riyu/other）
//   ・条文引用抽出: 検証済み extract_cites3.py の窓ベース最長末尾一致レキシコン解決を移植
//     （静的略称辞書＋文書内「以下「X」という」動的略称＋枝番全段＋改正前qualifier検出）
//   ・lawIdsで解決できないもの（就業規則・条例等）は unresolvedRefs へ隔離
//   ・外国の法令（「米国特許法」「スペイン民法」）・別の法令の略称（「金商法」の末尾の「商法」）は日本の法令に付けず unresolvedRefs へ。
//     項・号・期間の数（「二四二条の二の一項」「二三六条の五年」「七〇九条の一般」）は枝番にしない（2026-10-15・check_citations.cjs）
//   ・参照法条（sanshoRaw）も同じ解決器に通して lawRefs へ合流
'use strict';

const fs = require('fs');
const path = require('path');
const {
  toHalf, jpNumToInt, warekiToIso, parseCourt, DETAILN_COLLECTION, decodeEntities,
} = require('./lib_common.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
// HANREI_DATA_ROOT: 週次更新（scripts/hanrei/weekly）の作業フォルダ。未指定なら従来どおり（hanrei_raw/・hanrei_parsed/・scripts/hanrei/state/）
const DATA_ROOT = process.env.HANREI_DATA_ROOT ? path.resolve(process.env.HANREI_DATA_ROOT) : null;
const RAW_DIR = path.join(DATA_ROOT || REPO_ROOT, 'hanrei_raw');
const DETAIL_DIR = path.join(RAW_DIR, 'detail');
const PDFTEXT_DIR = path.join(RAW_DIR, 'pdftext');
const PARSED_DIR = path.join(DATA_ROOT || REPO_ROOT, 'hanrei_parsed');
const INVENTORY = DATA_ROOT ? path.join(DATA_ROOT, 'state', 'inventory.ndjson') : path.join(__dirname, 'state', 'inventory.ndjson');

// ============ 法令レキシコン（lawIds） ============
// loadLawIds は scripts/saiketsu/03_parse.cjs の実装を流用
function loadLawIds() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'lawIds.js'), 'utf8');
  const m = src.match(/export const ALL_LAW_IDS\s*=\s*(\{[\s\S]*\});/);
  if (!m) throw new Error('ALL_LAW_IDS not found');
  return JSON.parse(m[1]);
}

// extract_cites3.py と同じレキシコン構築: 正式名 + 「X（Y）」型のX（括弧前）も同じIDで登録
function buildLexicon() {
  const ALL = loadLawIds();
  const nameToId = new Map();
  for (const [name, id] of Object.entries(ALL)) {
    nameToId.set(name, id);
    const m = name.match(/^(.+?)（(.+?)）$/);
    if (m && !nameToId.has(m[1])) nameToId.set(m[1], id);
  }
  let maxLen = 0;
  for (const n of nameToId.keys()) if (n.length > maxLen) maxLen = n.length;
  return { nameToId, maxLen };
}

// サフィックス一致は scripts/saiketsu/03_parse.cjs の resolveBySuffix() を流用
function resolveBySuffix(name, lex) {
  for (let i = 0; i <= name.length - 2; i++) {
    const cand = name.slice(i);
    if (lex.nameToId.has(cand)) return cand;
  }
  return null;
}

// ============ 条文引用抽出（extract_cites3.py v3 の移植） ============
// 〇 も数字（「民法七〇九条」）。2026-10 まで NUM に無く、〇 を含む条番号は読めていなかった
const NUM = '[０-９0-9〇一二三四五六七八九十百千]+';
const EDA = `(?:の${NUM})*`;
// 法令名の漢字は「条」をまたがない（「条例」は除く）。「民法第七七三条人事訴訟法第三〇条」で前の引用ごと
// 「民法第七七三条人事訴訟法」を一つの名前として飲み込まないように（2026-10-15）
const KAN = '(?:(?!条(?!例))[一-龥])';
const LAWNAME =
  // 「刑訴四〇八条」「民訴四〇一条」「旧刑訴四四六条」（「法」の付かない略し方）と「同四一四条」（直前の法令。2026-10-17）は、条番号が続くときだけ
  `(?:旧?(?:刑訴|民訴)(?=第?${NUM}条)|同(?!一)(?=第?${NUM}条)|[一-龥]{1,3}国憲法|憲法` +
  `|${KAN}+(?:[のびに、]|及び|並びに|に関する|のための|に係る)*${KAN}*(?:に関する|のための|に係る)法律(?:施行令|施行規則)?` +
  `|${KAN}{1,20}(?:法律|法|施行令|施行規則|条例|規程|規則|令))`;
const FULL_RE = new RegExp(`(${LAWNAME})((?:（[^（）]{1,60}）)?)第?(${NUM})条(${EDA})`, 'g');
const LAWNAME_RE = new RegExp(LAWNAME, 'g');
// 続けて書いた条: 項・号・本文・ただし書 などを挟んで「、」「及び」「並びに」「又は」「若しくは」「ないし」「から」「・」の後の「第N条」
const CONT_RE = new RegExp(`^(?:(?:第?${NUM}(?:項|号)|本文|ただし書|但書|前段|後段|柱書|括弧書)(?:の${NUM})?)*(?:、|，|,|及び|並びに|又は|若しくは|ないし|乃至|から|・)第?(${NUM})条(${EDA})`);
const KAISEIMAE_RE = /(?:平成|昭和|令和)[０-９0-9一二三四五六七八九十元]+年[^（）。]{0,15}第[０-９0-9一二三四五六七八九十百千]+号による改正前の[^（）。、]{0,20}/g;
const TEIGI_RE = /以下[、]?(?:単に)?「([^「」]{1,25})」という/g;
// 「（平成29年法律第44号による改正前のもの）」「平成14年法律第44号による改正前の商法」の改正法の番号 → ['平成29年法律第44号', ...]
// 判決が使った版を引くのに使う（条の系譜。scripts/lineage/・docs/lineage.md）
const BEFORE_RE = /(明治|大正|昭和|平成|令和)([０-９0-9一二三四五六七八九十元]+)年法律第([０-９0-9一二三四五六七八九十百千]+)号(?:[^（）。]{0,30}?)による改正前/g;
function beforeOf(s) {
  const out = [];
  for (const m of String(s || '').matchAll(BEFORE_RE)) {
    const y = m[2] === '元' ? 1 : jpNumToInt(m[2]);
    const n = jpNumToInt(m[3]);
    if (y && n) out.push(`${m[1]}${y}年法律第${n}号`);
  }
  return out;
}

// 静的略称辞書（extract_cites3.py と同一）
const ABBR = {
  刑訴法: '刑事訴訟法', 民訴法: '民事訴訟法', 行訴法: '行政事件訴訟法',
  措置法: '租税特別措置法', 通則法: '国税通則法', 憲法: '日本国憲法',
  独禁法: '私的独占の禁止及び公正取引の確保に関する法律',
  情報公開法: '行政機関の保有する情報の公開に関する法律', 労基法: '労働基準法',
  // 末尾が別の法令の正式名になる略称（「金商法」の末尾は「商法」）。OTHER_HEAD で末尾一致を断ったときに引く
  金商法: '金融商品取引法', 特商法: '特定商取引に関する法律', 労災保険法: '労働者災害補償保険法',
  入管法: '出入国管理及び難民認定法', 入管難民法: '出入国管理及び難民認定法',
  地震保険法: '地震保険に関する法律', 再生医療法: '再生医療等の安全性の確保等に関する法律',
};

// 法令名の略し方（2026-10-17・判例の写しで読めなかった名前を数えて足した。AI は使っていない）: 略称・通称・改題の前の題名 → [法令 ID, 今の題名]。
// 辞書（src/lawIds.js）で今の題名では引けない法令（「昭和二十二年法律第五十四号（…）」の形でしか無い・改題した）もここで引く。
// 長い正式名は、法令名の正規表現が途中の「、」「及び」で切って後ろだけ拾うので、直前の文と合わせて末尾一致で見る（aliasAt）
const ALIAS = (() => {
  const t = {};
  const put = (id, law, ...names) => { for (const n of names) t[n] = [id, law]; };
  put('323AC0000000131', '刑事訴訟法', '刑訴', '刑訴法');
  put('408AC0000000109', '民事訴訟法', '民訴', '民訴法');
  put('323AC0000000249', '刑事訴訟法施行法', '刑訴施行法', '刑訴法施行法');
  put('322AC0000000054', '私的独占の禁止及び公正取引の確保に関する法律', '独禁法', '独占禁止法', '私的独占の禁止及び公正取引の確保に関する法律', '私的独占禁止法');
  put('324AC0000000174', '労働組合法', '労組法');
  put('323AC0000000025', '金融商品取引法', '証券取引法', '証取法', '金商法');
  put('328AC0000000014', '麻薬及び向精神薬取締法', '麻薬取締法', '麻向法');
  put('322AC0000000125', '国家賠償法', '国賠法');
  put('325AC1000000100', '公職選挙法', '公選法');
  put('325AC0000000261', '地方公務員法', '地公法');
  put('322AC0000000120', '国家公務員法', '国公法');
  put('405AC0000000047', '不正競争防止法', '不競法');
  put('330AC0000000097', '自動車損害賠償保障法', '自賠法');
  put('337AC0000000069', '建物の区分所有等に関する法律', '区分所有法');
  put('335AC0000000105', '道路交通法', '道交法');
  put('345AC0000000137', '廃棄物の処理及び清掃に関する法律', '廃棄物処理法', '廃掃法');
  put('333AC0000000006', '銃砲刀剣類所持等取締法', '銃刀法', '銃砲刀剣類所持等取締法');
  put('358AC1000000032', '貸金業法', '貸金業規制法', '貸金業の規制等に関する法律');
  put('329AC0000000195', '出資の受入れ、預り金及び金利等の取締りに関する法律', '出資法', '出資の受入れ、預り金及び金利等の取締りに関する法律', '出資の受入れ、預り金及び金利等の取締等に関する法律');
  put('332AC0000000166', '核原料物質、核燃料物質及び原子炉の規制に関する法律', '原子炉等規制法', '炉規法', '炉規制法', '核原料物質、核燃料物質及び原子炉の規制に関する法律');
  put('406AC0000000117', '原子爆弾被爆者に対する援護に関する法律', '被爆者援護法');
  put('331AC0000000162', '地方教育行政の組織及び運営に関する法律', '地教行法', '地方教育行政法');
  put('360AC0000000088', '労働者派遣事業の適正な運営の確保及び派遣労働者の保護等に関する法律', '労働者派遣法', '派遣法');
  put('351AC0000000057', '特定商取引に関する法律', '特定商取引法', '特商法');
  put('322AC0000000067', '地方自治法', '自治法', '地自法');
  put('417AC0000000123', '障害者の日常生活及び社会生活を総合的に支援するための法律', '障害者総合支援法', '総合支援法');
  put('335AC0000000145', '医薬品、医療機器等の品質、有効性及び安全性の確保等に関する法律', '薬事法', '薬機法', '医薬品医療機器等法', '医薬品、医療機器等の品質、有効性及び安全性の確保等に関する法律');
  put('326AC0100000252', '覚醒剤取締法', '覚せい剤取締法');
  put('336AC0000000147', '原子力損害の賠償に関する法律', '原賠法');
  put('215AC0000000060', '暴力行為等処罰ニ関スル法律', '暴力行為等処罰ニ関スル法律', '暴力行為等処罰に関する法律', '暴力行為処罰法', '暴処法');
  put('323AC0000000257', '行政執行法人の労働関係に関する法律', '公共企業体等労働関係法', '公労法');
  put('327AC0000000289', '地方公営企業等の労働関係に関する法律', '地方公営企業労働関係法', '地公労法');
  put('413AC0000000137', '特定電気通信による情報の流通によって発生する権利侵害等への対処に関する法律', 'プロバイダ責任制限法', 'プロバイダー責任制限法',
    '特定電気通信役務提供者の損害賠償責任の制限及び発信者情報の開示に関する法律');
  put('325AC0000000239', '商品先物取引法', '商品取引所法');
  put('405AC0000000088', '行政手続法', '行手法');
  put('426AC0000000068', '行政不服審査法', '行審法');
  put('354AC0000000004', '民事執行法', '民執法');
  put('401AC0000000091', '民事保全法', '民保法');
  put('411AC0000000225', '民事再生法', '民再法');
  put('414AC0000000154', '会社更生法', '会更法');
  put('347AC0000000057', '労働安全衛生法', '安衛法', '労安法');
  put('324AC0000000228', '外国為替及び外国貿易法', '外為法');
  put('415AC0000000057', '個人情報の保護に関する法律', '個人情報保護法');
  put('337AC0000000134', '不当景品類及び不当表示防止法', '景表法', '景品表示法');
  put('323AC0000000122', '風俗営業等の規制及び業務の適正化等に関する法律', '風営法', '風適法');
  put('419AC0000000128', '労働契約法', '労契法');
  put('322AC0000000049', '労働基準法', '労基法');
  put('337AC0000000139', '行政事件訴訟法', '行訴法');
  return t;
})();
const ALIAS_KEYS = Object.keys(ALIAS).sort((a, b) => b.length - a.length);
// 解決できなかった法令名 name（text の中で pre の直後）を略し方の表で引く → { id, law, head }（head: 表の名前より前の部分）
function aliasAt(pre, name) {
  const full = (pre + name).replace(/，/g, '、');
  for (const k of ALIAS_KEYS) if (k.length > name.length && full.endsWith(k)) return { id: ALIAS[k][0], law: ALIAS[k][1], head: '' };
  if (ALIAS[name]) return { id: ALIAS[name][0], law: ALIAS[name][1], head: '' };
  // 前の漢字ごと拾った名前（「不負担刑訴法」「旧刑訴」「新刑訴法」）: 表の名前の前が 4 字まで
  for (const k of ALIAS_KEYS) {
    if (k.length < 2 || k.length >= name.length || !name.endsWith(k)) continue;
    const head = name.slice(0, name.length - k.length);
    if (head.length <= 4) return { id: ALIAS[k][0], law: ALIAS[k][1], head };
  }
  return null;
}

// 正式名の直前がこれで終わると、別の法令の名前の一部（略称や廃止された法令）で、その正式名ではない
// （「金商法」≠商法、「労災保険法」≠保険法、「有限会社法」≠会社法、「入管難民法」≠民法）。判例の写しで数えて足した
const OTHER_HEAD = {
  商法: ['金', '特'], 保険法: ['労災', '失業', '簡易生命', '地震'], 医療法: ['原爆', '被爆者', '再生', '国民'],
  会社法: ['有限', '旅客', '軍需'], 都市計画法: ['特別'], 銀行法: ['相互'], 民法: ['難'], 会計法: ['特別'],
  放送法: ['ラジオ', 'ビジョン'], 仲裁法: ['公催'], 裁判所法: ['行政', '憲法'], 火薬類取締法施行規則: ['銃砲'],
};

// 外国の法令: 正式名の直前が国・州の名前（「米国特許法」「スペイン民法」「アメリカ合衆国の特許法」「ブラジル新民法」
// 「米国デジタルミレニアム著作権法」）。日本の法令には付けない
const FOREIGN_NAMES = 'アメリカ|イギリス|フランス|ドイツ|イタリア|イタリヤ|スペイン|ポルトガル|オランダ|ベルギー|スイス|オーストリア' +
  '|スウェーデン|ノルウェー|デンマーク|フィンランド|ロシア|ロシヤ|ポーランド|ルーマニア|ルーマニヤ|ギリシャ|トルコ|イスラエル|イラン|イラク' +
  '|エジプト|チュニジア|ウガンダ|ナイジェリア|ケニア|ブラジル|アルゼンチン|ペルー|チリ|コロンビア|メキシコ|カナダ|パナマ|ケイマン|バハマ' +
  '|オーストラリア|ニュージーランド|フィリピン|ベトナム|カンボジア|ミャンマー|ビルマ|マレーシア|シンガポール|インドネシア|インド|パキスタン' +
  '|スリランカ|バングラデシュ|ネパール|モンゴル|ウクライナ|ハワイ|カリフォルニア|ニューヨーク|デラウェア|テキサス|ルクセンブルク' +
  '|リヒテンシュタイン|ナチス|米国|英国|仏国|独国|合衆国|連邦|中華民国|中華人民共和国|中国|韓国|大韓民国|朝鮮|台湾|欧州|同国|外国' +
  '|[ァ-ヶー・]{2,}(?:国|州|島)|米|英|仏|独';
const FOREIGN_HEAD_RE = new RegExp(`(?:${FOREIGN_NAMES})(?:[ァ-ヶー・]{2,})?(?:新|旧|現行|改正)?の?$`);

// 窓ベース最長末尾一致（正式名が正規表現の捕捉より長い場合も窓が拾う）
function windowResolve(text, end, lex) {
  const w = text.slice(Math.max(0, end - 70), end);
  for (let L = Math.min(w.length, lex.maxLen); L >= 2; L--) {
    const cand = w.slice(w.length - L);
    if (lex.nameToId.has(cand)) return cand;
  }
  return null;
}

// 末尾一致で見つけた正式名 canon（text の end で終わる）が、本当にその法令かを直前の字で確かめる
//   → { canon } その法令（略称から別の正式名に引き直したものを含む）／ { other: 名前 } 外国や別の法令（unresolved へ）
function checkHead(text, end, canon, lex) {
  // PDF の行の折り返し（「金\n商法」）をまたいで見る
  const head = text.slice(Math.max(0, end - canon.length - 30), end - canon.length).replace(/\s+/g, '');
  if (FOREIGN_HEAD_RE.test(head)) return { other: head.match(/[一-龥ァ-ヶー・]*の?$/)[0] + canon };
  const run = head.match(/[一-龥ァ-ヶー]*$/)[0];
  if ((OTHER_HEAD[canon] || []).some((p) => run.endsWith(p))) {
    const name = run + canon;
    const k = Object.keys(ABBR).find((a) => name.endsWith(a) && lex.nameToId.has(ABBR[a]));
    return k ? { canon: ABBR[k] } : { other: name.slice(-12) };
  }
  return { canon };
}

function resolveAt(text, end, lex) {
  const canon = windowResolve(text, end, lex);
  return canon ? checkHead(text, end, canon, lex) : null;
}

// 条番号の正規化: 「六六」「６６」→"66"、枝番全段 「６６条の６」→"66の6"
function normArt(numStr, edaStr) {
  const segs = [numStr, ...String(edaStr || '').split('の').filter(Boolean)];
  const out = [];
  for (const s of segs) {
    const n = jpNumToInt(s);
    if (!n) return null; // 読めない・0（伏せ字の「第〇条」）
    out.push(String(n));
  }
  return out.join('の');
}

// 枝番の後ろの字（after）を見て、枝番でない「の＋数」を外してから normArt
//   「二条の三項」「二四四条の二の二項」: 最後の数は項・号の番号（漢数字の書き方。算用数字の「１０４条の３項」は
//     「の３」が枝番で項の番号が抜けたものが多いので外さない。「２４２条の２１項」も、本当の枝番「の２１」か
//     「の２ 第１項」かを条の一覧なしには決められないので書いてあるとおりに読む（別の条に黙って付けない））
//   「二三六条の五年」「一五三条の六ヵ月」「民法４条の１８歳」: 期間・年齢など
//   「一四二条の二重起訴」: 漢数字で始まる語
//   枝番に「の一」は無いので、「七〇九条の一般」「一六七条の一事不再理」「二四二条の二の一項」の「の一」から後ろは枝番ではない
const UNIT_RE = /^(?:年|歳|か月|ヵ月|ヶ月|カ月|ケ月|箇月|か年|ケ年|月|日|円|倍|人|回|件|%|％|パーセント|割|時間)/;
const KANJI_WORD_RE = /^[重者審面種段通名個箇]/;
function normArtAt(numStr, edaStr, after) {
  let segs = String(edaStr || '').split('の').filter(Boolean);
  if (segs.length) {
    const last = segs[segs.length - 1];
    if (/^[項号]/.test(after) && /^[〇一二三四五六七八九十百千]+$/.test(last)) {
      segs.pop();
    } else if (UNIT_RE.test(after) || (/^[〇一二三四五六七八九十百千]+$/.test(last) && KANJI_WORD_RE.test(after))) {
      segs.pop();
    }
    const i1 = segs.findIndex((s) => jpNumToInt(s) === 1);
    if (i1 >= 0) segs = segs.slice(0, i1);
  }
  return normArt(numStr, segs.map((s) => 'の' + s).join(''));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 文書内「以下「X」という」の定義元（直前の正式法令名）を解決して動的略称辞書を作る
function buildTeigiDefs(text, teigiSet, lex, defsBefore) {
  const defs = new Map();
  for (const m of text.matchAll(TEIGI_RE)) {
    const abbr = m[1];
    if (!teigiSet.has(abbr) || defs.has(abbr)) continue;
    const wstart = Math.max(0, m.index - 150);
    const seg = text.slice(wstart, m.index);
    let last = null;
    // 法律番号の中の「年法律」（「会社法（平成17年法律第86号）」）は法令名ではない（これを最後の法令名に取ると定義が作れない。2026-10-18）
    for (const lm of seg.matchAll(LAWNAME_RE)) { if (/^第[0-9０-９〇一二三四五六七八九十百千]+号/.test(seg.slice(lm.index + lm[0].length)) && /年法律$|年政令$|年法$/.test(lm[0])) continue; last = lm; }
    if (!last) continue;
    // 外国の法令・別の法令の略称（「アメリカ合衆国の特許法（以下「米国特許法」という。）」）は定義にしない
    const ar = resolveAt(abbr, abbr.length, lex);
    if (ar && ar.other) continue;
    const lend = wstart + last.index + last[0].length;
    // 定義（以下「X」という）の直前にある法令名だけを使う。直前に法令名が無いのに少し前の別の法令名を取ると、
    // 「労働契約法や障害者の…法律（以下「障害者総合支援法」という）」が労働契約法に付く（2026-10-18）
    // 間に入るのは法律番号などの括弧（「会社法（平成17年法律第86号）（以下…）」）と開き括弧だけ。〔〕［］の括弧
    // （「不正競争防止法〔以下「不競法」という〕」）と、同じ括弧の中の法律番号（「不正競争防止法（平成５年法律第４７号。以下「法」という。）」）も許す
    //   法令名をかぎ括弧でくくった書き方（「「防衛施設周辺の生活環境の整備等に関する法律」（以下「環境整備法」という」）の閉じ括弧も許す
    //   括弧の中で法令名の直後に続ける書き方（「（…による改正前の供託規則。以下「旧供託規則」という」）の「。」「、」も許す
    //   括弧の代わりのダッシュ（「首都高速道路公団法―以下「公団法」という」。裁判所の PDF で「一」「ー」になったもの（16517「建築基準法一以下「法」という」）も）と
    //   〈〉《》の括弧（「特定商取引に関する法律〈以下「特定商取引法」という〉」）も許す（2026-10-18・全判例で 22 か所）
    if (!/^[」』]?[。、，,]?(?:[（〔(［〈《][^（）〔〕()［］〈〉《》]{0,80}[）〕)］〉》])*(?:[（〔(［〈《](?:[^（）〔〕()［］〈〉《》「」]{0,40}(?:号|附則)[。、，,])?|[一―－ー—])?$/.test(text.slice(lend, m.index))) continue;
    const sfx = resolveBySuffix(last[0], lex);
    const r = resolveAt(text, lend, lex) || (sfx ? checkHead(text, lend, sfx, lex) : null);
    const canon = r && r.canon;
    if (canon && canon !== abbr) {
      defs.set(abbr, canon);
      // 「…法律第N号による改正前の民法（以下「改正前民法」という。）」: 改正前の印は法令名の前にも付く（2026-10-17）。
      // 略称そのものが「改正前」「旧」で始まるもの（「改正前民法」「旧商法」）も改正前の定義（改正法の番号が無ければ空の配列）
      const headSeg = seg.slice(Math.max(0, last.index - 60), last.index);
      const q = [...beforeOf(seg.slice(last.index)), ...(/改正前の?$/.test(headSeg) ? beforeOf(headSeg) : [])];
      const priorDef = /改正前の?$/.test(headSeg) || /^(?:改正前|旧)/.test(abbr);
      if (defsBefore && (q.length || priorDef)) defsBefore.set(abbr, [...new Set(q)]);
    }
  }
  return defs;
}

/**
 * 条文引用抽出（本体）。
 * @returns {{ refs: Map, unresolved: Map, stats: object }}
 *   refs: `${lawId}|${art}` → {lawId, law, art, count, kaiseimae, before?}
 *     before: 判決文に書いてある「…法律第N号による改正前」の改正法（定義した略称の引用も含む）。無ければ持たない
 *   unresolved: `${name}|${art}` → {name, art, count}
 *   stats: extract_cites3.py の出力（cites_result3.json）と突合可能な数値
 */
function extractCitations(text, lex, acc) {
  const refs = acc ? acc.refs : new Map();
  const unresolved = acc ? acc.unresolved : new Map();
  const stats = { full: 0, resolvedFull: 0, dou: 0, ryaku: 0, ryakuResolved: 0, kaiseimaeCount: 0, teigi: [] };
  if (!text) return { refs, unresolved, stats };
  // 枝番のカタカナの「ノ」（「第二百六十六条ノ三」「借家法１条ノ２」。昭和の判決や旧法の引用に多い）は「の」と同じ。
  //   2026-10-15 まで「ノ」から後ろが落ちて 266 条に付いていた
  text = text.replace(/(?<=[条0-9０-９〇一二三四五六七八九十百千])ノ(?=[0-9０-９〇一二三四五六七八九十百千])/g, 'の');
  text = text.replace(/舊/g, '旧').replace(/條/g, '条');   // 「舊刑訴四四六條」（旧字体。字数は変わらない）
  // 零に記号の「○」（U+25CB）を使った条番号（「借地法一○条」「民訴四○一条」）は「〇」と同じ。伏せ字の「第○条」は読まないので、漢数字に挟まれた所だけ（2026-10-17）
  text = text.replace(/(?<=[一二三四五六七八九十百千〇])○|○(?=[一二三四五六七八九〇])/g, '〇').replace(/(?<=[一二三四五六七八九十百千〇])○|○(?=[一二三四五六七八九〇])/g, '〇');

  const teigiAll = new Set([...text.matchAll(TEIGI_RE)].map((m) => m[1]));
  const teigiHou = [...teigiAll].filter((t) =>
    /(法|令|規則|規程|条例)$/.test(t) && t.length <= 12 && !/(方法|手法)$/.test(t));
  const teigiSet = new Set(teigiHou);
  stats.teigi = teigiHou.sort();
  const defsBefore = new Map();
  const teigiDefs = buildTeigiDefs(text, teigiSet, lex, defsBefore);

  // prior: その条を引いた所が全部「改正前」「旧」付き（2026-10-17。今の条としても引いていれば付けない。条の系譜で前の版を引く）・kyu: そのうち全部「旧」
  const plainSeen = new Set(), notKyu = new Set();
  const addRef = (canon, art, kaiseimae, before, kyu, idOf) => {
    const lawId = idOf || lex.nameToId.get(canon);
    const k = `${lawId}|${art}`;
    let e = refs.get(k);
    if (e) { e.count++; if (kaiseimae) e.kaiseimae = true; }
    else { e = { lawId, law: canon, art, count: 1, kaiseimae: !!kaiseimae }; refs.set(k, e); }
    if (before && before.length) e.before = [...new Set([...(e.before || []), ...before])].sort();
    if (!kaiseimae) plainSeen.add(k);
    if (!kyu) notKyu.add(k);
    if (plainSeen.has(k)) delete e.prior; else e.prior = true;
    if (notKyu.has(k)) delete e.kyu; else e.kyu = true;
  };
  const addUnresolved = (name, art) => {
    const k = `${name}|${art}`;
    const e = unresolved.get(k);
    if (e) e.count++;
    else unresolved.set(k, { name, art, count: 1 });
  };
  // 定義が作れなかった略称（直前に法令名が無い・正式名が法令名の正規表現で取れない）は、略し方の表 ALIAS の今の題名で引く（「障害者総合支援法」など）
  const resolveAbbr = (name) => teigiDefs.get(name) ||
    (lex.nameToId.has(ABBR[name]) ? ABBR[name] : null) || (ALIAS[name] && lex.nameToId.has(ALIAS[name][1]) ? ALIAS[name][1] : null);

  // 直前に読んだ法令（「同法」が指す先）と、続けて書いた条（「刑訴四三四条、四二六条」「民法七〇九条及び七一〇条」。2026-10-17）
  let last = null;
  const setLast = (law, add) => { last = { law: String(law || ''), add }; };
  const cont = (pos, add) => {
    for (let guard = 0; guard < 30; guard++) {
      const mm = CONT_RE.exec(text.slice(pos, pos + 80));
      if (!mm) return;
      const end = pos + mm[0].length;
      const a = normArtAt(mm[1], mm[2], text.slice(end, end + 6));
      if (a !== null) { add(a); stats.cont = (stats.cont || 0) + 1; }
      pos = end;
    }
  };
  const fullSpans = [];
  const fm = [...text.matchAll(FULL_RE)];
  for (const m of fm) fullSpans.push([m.index, m.index + m[0].length]);

  for (const m of fm) {
    const name = m[1];
    const art = normArtAt(m[3], m[4], text.slice(m.index + m[0].length, m.index + m[0].length + 6));
    if (name.startsWith('同')) {
      // 「同法○条」「同○条」「又同法」「各同法」: 直前に読んだ法令（同じ改正前・「旧」の印）に戻す（2026-10-17）。「同法施行令」など別の法令は今までどおり読まない
      stats.dou++;
      const dm = /^同(法|令|規則)?$/.exec(name);
      if (dm && last && art !== null && (!dm[1] || (dm[1] === '法' ? /法(律)?$/.test(last.law) : last.law.endsWith(dm[1])))) {
        stats.douResolved = (stats.douResolved || 0) + 1;
        last.add(art);
        cont(m.index + m[0].length, last.add);
      }
      continue;
    }
    const dm2 = /^[又各他及並算入右前記上]{1,3}同(法|令)?$/.exec(name);
    if (dm2 && last && art !== null) { stats.douResolved = (stats.douResolved || 0) + 1; last.add(art); cont(m.index + m[0].length, last.add); continue; }
    const isTeigiName = teigiSet.has(name) ||
      [...teigiSet].some((t) => (t === '本件条例' || t === '本件規則') &&
        name !== t && t.length >= 2 && name.endsWith(t));
    if (isTeigiName) {
      // 定義済み略称そのもの（措置法/本件条例等）→略称引用として扱い、動的定義で解決を試みる
      stats.ryaku++;
      const canon = resolveAbbr(name);
      if (canon && art !== null) {
        stats.ryakuResolved++;
        const add = (a) => addRef(canon, a, /改正前/.test(m[2]) || defsBefore.has(name), [...beforeOf(m[2]), ...(defsBefore.get(name) || [])], /^旧/.test(name));
        add(art); setLast(canon, add); cont(m.index + m[0].length, add);
      } else if (art !== null) { const add = (a) => addUnresolved(name, a); add(art); setLast(name, add); cont(m.index + m[0].length, add); }
      continue;
    }
    stats.full++;
    const pre = text.slice(Math.max(0, m.index - 40), m.index);
    const r = resolveAt(text, m.index + name.length, lex);
    let canon = r && r.canon;
    if (!r && ABBR[name] && lex.nameToId.has(ABBR[name])) canon = ABBR[name];
    // 略し方の表（ALIAS）: 辞書で引けない略称・通称・改題の前の題名・途中で切れた長い正式名
    let alias = null;
    if (!canon) { alias = aliasAt(pre, name); if (alias) { canon = alias.law; stats.alias = (stats.alias || 0) + 1; } }
    // 法令名の前の「改正前」「改正前の」「旧」（2026-10-17。「改正前民法570条」「旧商法266条」。LAWNAME は前の漢字ごと名前に拾うので、
    // 解決した法令名より前の部分（無ければ名前の頭）も見る）。「旧」は kyu も付ける（今と同じ名前に「旧」を付けて前の版を引いた）
    const lead = pre + (alias ? alias.head : canon && name.endsWith(canon) ? name.slice(0, name.length - canon.length) : ((name.match(/^(?:改正前の?|旧)/) || [''])[0]));
    const kyu = /旧$/.test(lead) && !/新旧$/.test(lead);
    const kaiseimae = /改正前/.test(m[2]) || /改正前の?$/.test(lead) || kyu;
    const before = [...beforeOf(m[2]), ...(/改正前の?$/.test(lead) ? beforeOf(lead) : [])];
    if (canon) {
      stats.resolvedFull++;
      const add = (a) => addRef(canon, a, kaiseimae, before, kyu, alias && alias.id);
      if (art !== null) { add(art); setLast(canon, add); cont(m.index + m[0].length, add); }
    } else if (art !== null) {
      const un = r ? r.other : name;
      const add = (a) => addUnresolved(un, a);
      add(art); setLast(un, add); cont(m.index + m[0].length, add);
    }
  }

  // 略称の単独引用（フルマッチ外）: 「措置法６６条の６」等
  for (const t of teigiSet) {
    const pat = new RegExp(`${escapeRe(t)}第?(${NUM})条(${EDA})`, 'g');
    for (const m of text.matchAll(pat)) {
      const inside = fullSpans.some(([s, e]) => s <= m.index && m.index < e);
      if (inside) continue;
      stats.ryaku++;
      const art = normArtAt(m[1], m[2], text.slice(m.index + m[0].length, m.index + m[0].length + 6));
      const canon = resolveAbbr(t);
      // 続けて書いた条（「法五二条一項、五六条」）も同じ略称で読む（2026-10-18）
      if (canon && art !== null) { stats.ryakuResolved++; const add = (a) => addRef(canon, a, defsBefore.has(t), defsBefore.get(t) || [], /^旧/.test(t)); add(art); cont(m.index + m[0].length, add); }
      else if (art !== null) { const add = (a) => addUnresolved(t, a); add(art); cont(m.index + m[0].length, add); }
    }
  }

  stats.kaiseimaeCount = [...text.matchAll(KAISEIMAE_RE)].length;
  return { refs, unresolved, stats };
}

// ============ 詳細ページ（dt/dd）パース ============
// ラベル → 契約フィールドのマップ。detail8固有の6項目は chizai オブジェクトへ。
const LABEL_MAP = {
  事件番号: 'caseNo', 事件名: 'title', 裁判年月日: 'dateJp',
  法廷名: 'courtRaw', '裁判所名・部': 'courtRaw', 裁判所名: 'courtRaw', 部名: 'courtBu',
  裁判種別: 'kind', 結果: 'kekka', 判決結果: 'kekka',
  '判例集等巻・号・頁': 'hanreishu', '高裁判例集登載巻・号・頁': 'hanreishu',
  判示事項: 'hanji', 判示事項の要旨: 'hanji',
  裁判要旨: 'yoshi',
  参照法条: 'sanshoRaw',
  分野: 'bunya',
  原審裁判所名: 'gensinCourt', 原審事件番号: 'gensinCaseNo',
  原審裁判年月日: 'gensinDateJp', 原審結果: 'gensinKekka',
  主な争点: 'chizai.souten', 権利種別: 'chizai.kenri', 訴訟類型: 'chizai.ruikei',
  発明等の名称等: 'chizai.hatsumei', 上告提起等の有無: 'chizai.jokoku',
  上告審の結果: 'chizai.jokokuKekka',
  // リンクセル・非契約項目は捨てる
  全文: null, 要旨: null, 事件種別: null, 事件種類: null, 当事者: null,
};

function parseDetailHtml(html) {
  const rec = { chizai: {} };
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const label = decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/[\s　]+/g, '');
    if (!(label in LABEL_MAP)) continue;
    const target = LABEL_MAP[label];
    if (target === null) continue;
    const val = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/[\s　]+/g, ' ').trim();
    if (!val) continue;
    if (target.startsWith('chizai.')) rec.chizai[target.slice(7)] = val;
    else rec[target] = val;
  }
  return rec;
}

// ============ 主文抽出＋セクション分割 ============
const MARKER_RE = /^(主文|事実及び理由|事実及理由|事実及び争点|罪となるべき事実|事実|理由)$/;
const DAI_HEAD_RE = /^第[０-９0-9一二三四五六七八九十百]+([\s　].{0,40})?$/;
const NUM_HEAD_RE = /^[０-９0-9一二三四五六七八九十]{1,3}([\s　].{0,40})?$/;

function isHeadLine(l, re) {
  return l.length <= 42 && !l.includes('。') && re.test(l);
}

function classifySectionType(head) {
  const h = String(head || '');
  if (/^主文$/.test(h)) return 'shubun';
  if (/判断/.test(h)) return 'handan';
  if (/争点/.test(h)) return 'souten';
  if (/前提事実|前提となる事実|基礎となる事実|基礎事実/.test(h)) return 'zentei';
  if (/事案の概要|事案の要旨|事件の概要/.test(h)) return 'gaiyou';
  if (/罪となるべき事実/.test(h)) return 'riyu';
  if (/^(理由|事実及び理由|事実及理由|事実)$/.test(h)) return 'riyu';
  return 'other';
}

// 長大セクションの安全弁（scripts/saiketsu/03_parse.cjs の capSentences を踏襲・上限4000字）
function capSentences(text, budget) {
  if (text.length <= budget) return text;
  const sents = text.split(/(?<=。)/);
  let out = '';
  for (const s of sents) {
    if (out.length && out.length + s.length > budget) break;
    out += s;
  }
  return out || text.slice(0, budget);
}

const SECTION_CAP = 4000;

function splitJudgment(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  const sections = [];
  let shubun = null;

  // 主文: 「主文」見出し行から次の 事実及び理由/理由/事実 系見出し行まで
  const si = lines.findIndex((l) => l === '主文');
  let bodyStart = 0;
  if (si >= 0) {
    let end = lines.length;
    for (let i = si + 1; i < lines.length; i++) {
      if (MARKER_RE.test(lines[i]) || isHeadLine(lines[i], DAI_HEAD_RE)) { end = i; break; }
    }
    shubun = lines.slice(si + 1, end).join('\n') || null;
    if (shubun) sections.push({ head: '主文', type: 'shubun', text: capSentences(shubun, SECTION_CAP) });
    bodyStart = end;
  }

  // 2階層分割: レベル1=「第１」型見出し（なければ「１」型）＋マーカー見出し、
  //             レベル2=「第N」直下の「１ 前提事実」型見出し（第N構造がある場合のみ）。
  // 見出しキャプションが長い場合（「１ 争点１（…か否か）について」等）はPDF正規化で
  // 本文と融合した1行になるため、行頭の算用数字も境界として扱う（headは番号のみ・本文は保持）
  const body = lines.slice(bodyStart);
  const hasDai = body.some((l) => isHeadLine(l, DAI_HEAD_RE));
  // 行頭数字境界: 「２８条…」「３０年…」のような助数詞つき数値（条文引用・年月等）は除外
  const NUM_FUSED_RE = /^[０-９0-9]{1,2}(?![０-９0-9]|条|項|号|年|月|日|人|円|万|億|件|回|時|分|頁|割|棟|筆|㎡)/;
  const BESSHI_RE = /^(別紙|別表)/;

  // 子見出しの type を優先しつつ、判断セクション配下は handan を維持する
  const leafType = (parentHead, childHead) => {
    const pt = classifySectionType(parentHead || '理由');
    const ct = classifySectionType(childHead || '');
    if (pt === 'handan') return 'handan';
    return ct !== 'other' ? ct : pt;
  };
  const pushSection = (head, type, textLines) => {
    const t = textLines.join('\n').trim();
    if (t) sections.push({ head, type, text: capSentences(t, SECTION_CAP) });
  };

  let l1Head = null, l2Head = null, buf = [];
  const flushLeaf = () => {
    if (l2Head === null) {
      pushSection(l1Head || '', classifySectionType(l1Head || '理由'), buf);
    } else {
      pushSection(l1Head ? `${l1Head}＞${l2Head}` : l2Head, leafType(l1Head, l2Head), buf);
    }
    buf = [];
  };
  for (const l of body) {
    if (l === '主文') continue; // 既出
    const marker = MARKER_RE.test(l);
    const daiHead = isHeadLine(l, DAI_HEAD_RE);
    const numHead = isHeadLine(l, NUM_HEAD_RE);
    const numFused = !numHead && NUM_FUSED_RE.test(l);
    const besshi = BESSHI_RE.test(l);
    if (marker || daiHead || besshi || (!hasDai && (numHead || numFused))) {
      flushLeaf();
      l2Head = null;
      if (marker || daiHead || numHead) {
        l1Head = l;
      } else if (besshi) {
        // 別紙/別表: 番号の振り直しが起きるため親を切り替える
        const pure = l.length <= 42 && !l.includes('。');
        l1Head = pure ? l : l.slice(0, 20);
        if (!pure) buf.push(l);
      } else {
        l1Head = l.match(NUM_FUSED_RE)[0]; // 融合行: headは番号のみ、本文は残す
        buf.push(l);
      }
      continue;
    }
    if (hasDai && (numHead || numFused)) {
      flushLeaf();
      l2Head = numHead ? l : l.match(NUM_FUSED_RE)[0];
      if (numFused) buf.push(l);
      continue;
    }
    buf.push(l);
  }
  flushLeaf();
  return { shubun, sections };
}

// ============ 入力読み込み ============
function readInventory(file) {
  // 追記式なので id+detailN で重複排除（後勝ち=最新クロール）
  const byKey = new Map();
  if (!fs.existsSync(file)) return byKey;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && row.id && row.detailN) byKey.set(`${row.id}_${row.detailN}`, row);
  }
  return byKey;
}

function listDetailFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d+_\d\.html$/.test(f));
}

function readPdfText(id) {
  const p = path.join(PDFTEXT_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readPointText(id) {
  const p = path.join(PDFTEXT_DIR, `point_${id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ============ 1判例の構築 ============
const longer = (a, b) => {
  const x = a || '', y = b || '';
  return y.length > x.length ? y : x;
};
const firstNonEmpty = (...vals) => vals.find((v) => v) || null;
const orNull = (v) => (v ? v : null);

function buildCase(id, detailRecs, invRows, lex) {
  // detailRecs: [{detailN, rec}] 昇順。マージは「値が両方あれば長い方」
  const merged = { chizai: {} };
  const scalarKeys = ['caseNo', 'title', 'dateJp', 'courtRaw', 'courtBu', 'kind', 'kekka',
    'hanreishu', 'hanji', 'yoshi', 'sanshoRaw', 'bunya',
    'gensinCourt', 'gensinCaseNo', 'gensinDateJp', 'gensinKekka'];
  for (const { rec } of detailRecs) {
    for (const k of scalarKeys) merged[k] = longer(merged[k], rec[k]);
    for (const k of Object.keys(rec.chizai || {})) {
      merged.chizai[k] = longer(merged.chizai[k], rec.chizai[k]);
    }
  }
  // inventory は詳細ページの歯抜けを補完（詳細優先）
  const inv = invRows[0] || null;
  if (inv) {
    merged.caseNo = merged.caseNo || inv.caseNo;
    merged.title = merged.title || inv.title;
    merged.dateJp = merged.dateJp || inv.date;
    merged.courtRaw = merged.courtRaw || inv.courtDetail || inv.court;
    merged.kind = merged.kind || inv.kind;
    merged.kekka = merged.kekka || inv.kekka;
    merged.bunya = merged.bunya || inv.bunya;
    merged.gensinCourt = merged.gensinCourt || inv.gensinCourt;
    merged.gensinCaseNo = merged.gensinCaseNo || inv.gensinCaseNo;
  }

  const { court, branch, courtDetail } = parseCourt(merged.courtRaw, merged.courtBu);
  const invBranch = firstNonEmpty(...invRows.map((r) => r.branch));

  const detailNs = [...new Set(detailRecs.map((d) => d.detailN))].sort();
  const collections = [...new Set([
    ...invRows.map((r) => r.collection).filter(Boolean),
    ...detailNs.map((n) => DETAILN_COLLECTION[n]).filter(Boolean),
  ])];

  // PDF全文
  const pt = readPdfText(id);
  const pdf = pt
    ? { pages: pt.pages || 0, chars: pt.chars || 0, found: pt.found !== false }
    : { pages: 0, chars: 0, found: false };
  const { shubun, sections } = pdf.found && pt.text
    ? splitJudgment(pt.text)
    : { shubun: null, sections: [] };

  // 知財 detail8 の要旨PDF → yoshi の補完
  if (!merged.yoshi) {
    const pp = readPointText(id);
    if (pp && pp.found !== false && pp.text) {
      merged.yoshi = pp.text.replace(/\s+/g, ' ').trim();
    }
  }

  // 条文引用: PDF本文 + 参照法条を同じ解決器へ（出所を count に加算）
  const acc = { refs: new Map(), unresolved: new Map() };
  let pdfStats = null;
  if (pdf.found && pt.text) {
    pdfStats = extractCitations(pt.text, lex, acc).stats;
  }
  if (merged.sanshoRaw) extractCitations(merged.sanshoRaw, lex, acc);
  const lawRefs = [...acc.refs.values()].sort((a, b) => b.count - a.count);
  const unresolvedRefs = [...acc.unresolved.values()].sort((a, b) => b.count - a.count);

  const gensin = (merged.gensinCourt || merged.gensinCaseNo || merged.gensinDateJp || merged.gensinKekka)
    ? {
      court: orNull(merged.gensinCourt),
      caseNo: orNull(merged.gensinCaseNo),
      dateJp: orNull(merged.gensinDateJp),
      kekka: orNull(merged.gensinKekka),
    }
    : null;

  const chizai = Object.keys(merged.chizai).length
    ? {
      souten: orNull(merged.chizai.souten), kenri: orNull(merged.chizai.kenri),
      ruikei: orNull(merged.chizai.ruikei), hatsumei: orNull(merged.chizai.hatsumei),
      jokoku: orNull(merged.chizai.jokoku), jokokuKekka: orNull(merged.chizai.jokokuKekka),
    }
    : null;

  const kase = {
    id,
    detailNs,
    collections,
    caseNo: orNull(merged.caseNo),
    title: orNull(merged.title),
    dateJp: orNull(merged.dateJp),
    dateIso: warekiToIso(merged.dateJp),
    court: orNull(court),
    branch: branch || invBranch || null,
    courtDetail: orNull(courtDetail),
    kind: orNull(merged.kind),
    kekka: orNull(merged.kekka),
    hanreishu: orNull(merged.hanreishu),
    hanji: orNull(merged.hanji),
    yoshi: orNull(merged.yoshi),
    sanshoRaw: orNull(merged.sanshoRaw),
    gensin,
    chizai,
    bunya: orNull(merged.bunya),
    pdf,
    shubun,
    sections,
    lawRefs,
    unresolvedRefs,
  };
  return { kase, pdfStats };
}

// ============ main ============
function shardOf(id) {
  return String(Math.floor(parseInt(id, 10) / 1000)).padStart(3, '0');
}

function main() {
  const args = process.argv.slice(2);
  const statsOnly = args.includes('--stats');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;
  const invIdx = args.indexOf('--inventory');
  const invPath = invIdx >= 0 ? path.resolve(args[invIdx + 1]) : INVENTORY;

  const t0 = Date.now();
  const lex = buildLexicon();
  const invByKey = readInventory(invPath);
  const detailFiles = listDetailFiles(DETAIL_DIR);

  // id → 入力ソースの収集（詳細HTML ∪ inventory ∪ pdftext）
  const detailByIds = new Map();
  for (const f of detailFiles) {
    const m = f.match(/^(\d+)_(\d)\.html$/);
    if (!detailByIds.has(m[1])) detailByIds.set(m[1], []);
    detailByIds.get(m[1]).push({ detailN: m[2], file: f });
  }
  const invByIds = new Map();
  for (const row of invByKey.values()) {
    if (!invByIds.has(row.id)) invByIds.set(row.id, []);
    invByIds.get(row.id).push(row);
  }
  const pdftextIds = fs.existsSync(PDFTEXT_DIR)
    ? fs.readdirSync(PDFTEXT_DIR)
      .map((f) => (f.match(/^(\d+)\.json$/) || [])[1]).filter(Boolean)
    : [];
  const allIds = [...new Set([...detailByIds.keys(), ...invByIds.keys(), ...pdftextIds])]
    .filter((id) => !only || only.has(id))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const shards = new Map();
  let nCases = 0, nWithPdf = 0, nWithRefs = 0, nSections = 0, nRefs = 0, nUnresolved = 0;
  const perCaseStats = [];
  for (const id of allIds) {
    const detailRecs = (detailByIds.get(id) || [])
      .sort((a, b) => a.detailN - b.detailN)
      .map(({ detailN, file }) => ({
        detailN,
        rec: parseDetailHtml(fs.readFileSync(path.join(DETAIL_DIR, file), 'utf8')),
      }));
    const invRows = invByIds.get(id) || [];
    const { kase, pdfStats } = buildCase(id, detailRecs, invRows, lex);
    nCases++;
    if (kase.pdf.found) nWithPdf++;
    if (kase.lawRefs.length) nWithRefs++;
    nSections += kase.sections.length;
    nRefs += kase.lawRefs.length;
    nUnresolved += kase.unresolvedRefs.length;
    if (pdfStats) perCaseStats.push({ id, ...pdfStats });

    if (only) {
      console.log(JSON.stringify(kase, null, 1));
      continue;
    }
    if (!statsOnly) {
      const sh = shardOf(id);
      if (!shards.has(sh)) shards.set(sh, []);
      shards.get(sh).push(JSON.stringify(kase));
    }
    if (nCases % 2000 === 0) {
      console.log(`  ${nCases}/${allIds.length}件 (経過 ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }

  if (!statsOnly && !only) {
    fs.mkdirSync(PARSED_DIR, { recursive: true });
    for (const [sh, rows] of [...shards.entries()].sort()) {
      fs.writeFileSync(path.join(PARSED_DIR, `cases_${sh}.ndjson`), rows.join('\n') + '\n');
    }
  }

  console.log(`パース完了: ${nCases}件 (詳細HTML ${detailFiles.length}枚 / inventory ${invByKey.size}行)`);
  console.log(`  PDF全文あり: ${nWithPdf}件 / セクション計: ${nSections} / lawRefs計: ${nRefs}（引用あり ${nWithRefs}件）/ unresolved計: ${nUnresolved}`);
  if (!statsOnly && !only) console.log(`出力: ${PARSED_DIR}/cases_*.ndjson（${shards.size}シャード, ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return perCaseStats;
}

module.exports = {
  buildLexicon, resolveBySuffix, windowResolve, resolveAt, extractCitations, normArt, normArtAt,
  parseDetailHtml, splitJudgment, classifySectionType, capSentences, buildCase,
  shardOf, LABEL_MAP, ALIAS, aliasAt,
};

if (require.main === module) main();
