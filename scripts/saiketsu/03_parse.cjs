// 国税不服審判所 公表裁決事例のパース（セクション親子構造・確定仕様）
//
//   node scripts/saiketsu/03_parse.cjs            # 最新スナップショットを全件パース
//   node scripts/saiketsu/03_parse.cjs --stats    # 統計のみ
//
// 入力: all_saiketsu_YYYYMMDD/service/ 配下のHTML
//   MP/{税法01-13}/{論点コード}.html : 裁決要旨（タイトル+本文+「裁決事例集 No.X - Y頁」+裁決日）
//   JP/{号}/{連番}/index.html       : 裁決書全文（番号見出しでセクション構造を持つ）
// 出力: scripts/saiketsu/state/saiketsu_items_YYYYMMDD.ndjson （1行=1裁決）
//
// 設計（ユーザー合意済み・2026-08-12）:
//   ・チャンキングは「文字数」ではなく「セクション見出し」で切る（条文の項と同じ親子構造）
//   ・拾う: 事案の概要 / 基礎事実 / 事実 / 争点 / 主張 / 判断（争点ごと）→ 各1ベクトル
//   ・捨てる: 審査請求に至る経緯（単独）/ 結論 / ナビ定型
//   ・関係法令等: ベクトル化せず条文リンク（law_refs）抽出の材料にする
//   ・裁決要旨（MP）は独立1ベクトル（規範層・最強シグナル）
//   ・検索ヒットは sid（号-頁）で裁決単位に集約（洪水ガード）

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');

// MP税法ディレクトリ → 法令ID・名称（税法レベルの確定アンカー）
const TAX_DIRS = {
  '01': ['337AC0000000066', '国税通則法'],
  '02': ['340AC0000000033', '所得税法'],
  '03': ['340AC0000000034', '法人税法'],
  '04': ['325AC0000000073', '相続税法'],
  '05': ['363AC0000000108', '消費税法'],
  '06': ['403AC0000000069', '地価税法'],
  '07': ['342AC0000000035', '登録免許税法'],
  '08': ['342AC0000000023', '印紙税法'],
  '09': ['332AC0000000055', '揮発油税法'],
  '10': ['346AC0000000089', '自動車重量税法'],
  '11': ['334AC0000000147', '国税徴収法'],
  '12': ['332AC0000000026', '租税特別措置法'],
  '13': ['359AC0000000072', 'たばこ税法'],
};

const LAW_SUFFIX = '(?:法律|省令|政令|規則|条約|規程|法|令)';
function normNum(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function loadLawIds() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'lawIds.js'), 'utf8');
  const m = src.match(/export const ALL_LAW_IDS\s*=\s*(\{[\s\S]*\});/);
  if (!m) throw new Error('ALL_LAW_IDS not found');
  return JSON.parse(m[1]);
}

// 漢字連結で頭にゴミが付くため、辞書との最長サフィックス一致で法令名を確定（law_id解決も兼ねる）
function resolveBySuffix(name, ALL_LAW_IDS) {
  for (let i = 0; i <= name.length - 2; i++) {
    const cand = name.slice(i);
    if (ALL_LAW_IDS[cand]) return { law: cand, law_id: ALL_LAW_IDS[cand] };
  }
  return null;
}

// 【2026-09-01 修正】以前は「法令名＋第N条」が**くっついた形だけ**を正規表現で拾っていた。
//   そのため「所得税法第37条、第38条」の2つ目以降が取れず、カタカナ混じりの法令名
//   （[一-龠] のみ）も対象外だった。質疑応答事例では同じ型の誤りが621件あった。
//   事例側で使っている scanLawArticles（行を左から走査し、法令名が現れるたびに帰属先を
//   切り替える）を import してそのまま使う。**写しは書かない。**
const { scanLawArticles } = require('../shitsugi/03_parse.cjs');

function extractLawRefs(text, maxRefs, ALL_LAW_IDS) {
  const t = normNum(text);
  const found = new Map();
  for (const line of String(t).split(/[\n。]/)) {
    const seg = line.trim();
    if (!seg || !/第\d+(?:の\d+)*条/.test(seg)) continue;
    if (/同法|当該|前記|上記|本件/.test(seg) && !new RegExp(`[^\\s、]{2,15}${LAW_SUFFIX}第`).test(seg)) continue;
    let parsed = [];
    // 括弧の扱いは事例（関係法令欄）と裁決（地の文）で違う。事例では括弧の中は
    // 法令番号ノイズなので丸ごと落とすが、裁決では「（登録免許税法第10条第1項）」の
    // ように引用そのものが括弧の中にある。落として良いのは法令番号だけ。
    // 《国税の徴収の所轄庁》は条見出しなので外す（外さないと直後の「第3項」を落とす）。
    const cleaned = seg
      .replace(/（[^）]*(?:法律|政令|省令|勅令|府令|規則)第\d+号[^）]*）/g, '')
      .replace(/《[^》]*》/g, '');
    try { parsed = scanLawArticles(cleaned, ALL_LAW_IDS, seg); } catch { parsed = []; }
    for (const p of parsed) {
      if (p.kind !== 'law' || !p.law_id || !p.article) continue;
      // 「改正前」「旧」で始まる引用は現行条文と別物なので除く（従来の挙動を維持）
      if (/改正前|旧/.test(String(p.law || ''))) continue;
      // 1つの法令に複数条が並ぶ場合、scanLawArticles は articles にまとめて返す。
      // article だけ見ると2本目以降（「所得税法第64条…及び同法第9条」の第9条）を落とす。
      for (const art of (p.articles && p.articles.length ? p.articles : [p.article])) {
        const k = `${p.law_id}:${art}`;
        if (found.has(k)) found.get(k).count++;
        else found.set(k, { law: p.law, law_id: p.law_id, article: art, count: 1 });
      }
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count).slice(0, maxRefs);
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&emsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ');
}

function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter((x) => /^manifest_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

// ============ MP（要旨）============
// 2様式が同居する:
//   旧様式（〜号78・冊子時代）: タイトル行 + 「裁決事例集 No.X - Y頁」 + 本文 + 日付
//     → 結合キー = 「号-頁」（全文ページのタイトルにも頁がある）
//   新様式（号79以降・Web公表）: <h2 class="likeH3" id="aNNN">タイトル</h2> +
//     全文ページへの直リンク(/service/JP/{号}/{連番}/index.html) + 《ポイント》《要旨》
//     → 結合キー = 「号-連番」（リンクがそのままキー）
function parseMpPage(html, relPath) {
  const taxDir = (relPath.match(/^MP\/(\d{2})\//) || [])[1];
  const topic = ((html.match(/<title>([^|<]+)/) || [])[1] || '').trim();
  const items = [];

  // --- 新様式（構造化HTML） ---
  for (const m of html.matchAll(/<h2 class="likeH3" id="a\d+[^"]*"[^>]*>(?:<span>)?([\s\S]*?)(?:<\/span>)?<\/h2>([\s\S]*?)(?=<h2 class="likeH3"|<\/body|$)/g)) {
    const title = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const block = m[2];
    // リンクは絶対（/service/JP/…）と相対（../../JP/…）の両方がある
    const link = block.match(/href="(?:\/service\/|(?:\.\.\/)+)JP\/(\d+)\/(\d+)\/index\.html"[^>]*>([^<]*)</);
    if (!link) continue;
    // 《参考判決・裁決》は引用列挙なので本文から除外。《ポイント》《要旨》を本文に。
    const bodyHtml = block.split(/《参考判決/)[0];
    const body = stripHtml(bodyHtml)
      .replace(/\s+/g, ' ')
      .replace(/《ポイント》|《要旨》/g, '\n')
      .replace(/^[\s▼]*(?:昭和|平成|令和)\d+年\d+月\d+日裁決\s*/, '') // 冒頭の日付リンク行を除去
      .trim();
    items.push({
      key: `${link[1]}-${link[2]}`,
      title,
      body,
      date: (link[3] || '').trim() || null,
      topic, taxDir,
    });
  }

  // --- 旧様式（テキスト走査） ---
  const text = stripHtml(html).replace(/\n{2,}/g, '\n');
  const lines = text.split('\n').map((l) => l.trim());
  let cur = null;
  for (const line of lines) {
    const refM = line.match(/裁決事例集\s*No\.(\d+)\s*-\s*(\d+)頁/);
    const dateM = line.match(/^((?:昭和|平成|令和)\d+年\d+月\d+日裁決)/);
    if (refM && cur) { cur.key = `${refM[1]}-${refM[2]}`; continue; }
    if (dateM && cur) { cur.date = dateM[1]; if (cur.key) items.push(cur); cur = null; continue; }
    if (/(?:した|する)事例$/.test(line) && line.length > 15) {
      if (cur && cur.key) items.push(cur);
      cur = { title: line, body: '', topic, taxDir, key: null };
      continue;
    }
    if (cur && line && !/^トップに戻る|^検索の仕方|^関連リンク/.test(line)) {
      if (cur.key) cur.body += (cur.body ? '\n' : '') + line;
    }
  }
  if (cur && cur.key) items.push(cur);
  return items.filter((x) => x.key);
}

// ============ JP（全文・セクション親子）============
// 番号見出しでツリー化: レベル1「１　事実」/ レベル2「(1)　事案の概要」
function splitSections(lines) {
  const tree = [];
  let curL1 = null, curL2 = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (/^トップに戻る|^このページの先頭|^サイトマップ/.test(l)) continue;
    const h1 = normNum(l).match(/^([1-9])[　 ]+(.{1,30})$/);
    const h2 = normNum(l).match(/^[（(](\d{1,2})[）)][　 ]*(.{0,50})$/);
    if (h1 && !/^[0-9,．.]+$/.test(h1[2])) {
      curL1 = { n: h1[1], head: h1[2].trim(), text: '', children: [] };
      curL2 = null;
      tree.push(curL1);
      continue;
    }
    if (h2 && curL1) {
      curL2 = { n: `(${h2[1]})`, head: h2[2].trim(), text: '' };
      curL1.children.push(curL2);
      continue;
    }
    if (curL2) curL2.text += (curL2.text ? '\n' : '') + l;
    else if (curL1) curL1.text += (curL1.text ? '\n' : '') + l;
  }
  return tree;
}

// 拾う/捨てる/関係法令 の判定
function classifyHead(head) {
  if (/関係法令/.test(head)) return 'refs';
  if (/^結論/.test(head)) return 'drop';
  if (/審査請求に至る経緯/.test(head) && !/事実/.test(head)) return 'drop';
  return 'keep';
}

// 長大セクションの安全弁: 文単位で上限4000字（文中切断なし）
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

// relPath 例: JP/141/01/index.html → dirNo=141, dirNn=01
function parseJpPage(html, relPath) {
  const pm = relPath.match(/^JP\/(\d+)\/(\d+)\/index\.html$/);
  if (!pm) return null;
  const dirNo = pm[1], dirNn = pm[2];
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const tm = normNum(title).match(/[（(]([^、）(]*)、?\s*裁決事例集No\.(\d+)[　\s]*(\d+)頁/);
  // キー: 旧様式（〜78号）は「号-頁」（タイトルから）、新様式（79号〜）は「号-連番」（パスから）
  const isOld = parseInt(dirNo, 10) <= 78;
  const no = dirNo;
  const page = isOld ? (tm ? tm[3] : dirNn) : dirNn;
  const date = tm ? (tm[1] || null) : ((normNum(title).match(/[（(]([^）(]*裁決)[）)]/) || [])[1] || null);
  const text = stripHtml(html).replace(/\n{2,}/g, '\n');
  const lines = text.split('\n');
  // 《裁決書（抄）》以降
  const start = lines.findIndex((l) => /裁決書/.test(l));
  const bodyLines = start >= 0 ? lines.slice(start + 1) : lines;
  const sections = splitSections(bodyLines);
  const { units, refsText } = unitsFromSections(sections);
  return {
    no, page, date,
    sections, units, refsText,
    fullLen: text.replace(/\s+/g, '').length,
  };
}

// セクションの親子構造 → 埋め込みユニット（葉セクション）と関係法令テキスト。
// R2 のレコードは sections を持つので、週次（scripts/cases/weekly）は本番のレコードからも同じユニットを組み立て直せる
function unitsFromSections(sections) {
  const units = [];
  let refsText = '';
  for (const s1 of sections || []) {
    const kids = s1.children || [];   // R2 から読んだときに欠けていても落ちないように（パースしたものは必ず配列）
    const leaves = kids.length ? kids : [s1];
    for (const leaf of leaves) {
      const head = leaf.head || s1.head;
      const cls = classifyHead(head);
      const t = (leaf.text || '').replace(/\s+/g, '');
      if (cls === 'refs') { refsText += t + '\n'; continue; }
      if (cls === 'drop') continue;
      if (t.length < 40) continue; // 空コンテナ・断片
      units.push({ sec: `${s1.head}${leaf !== s1 ? '＞' + head : ''}`.slice(0, 40), text: capSentences(t, 4000) });
    }
    // レベル1に本文があり子も居る場合（判断の導入部等）は親の本文も1ユニットに
    if (kids.length && (s1.text || '').replace(/\s+/g, '').length >= 200 && classifyHead(s1.head) === 'keep') {
      units.push({ sec: s1.head.slice(0, 40), text: capSentences(s1.text.replace(/\s+/g, ''), 4000) });
    }
  }
  return { units, refsText };
}

// ============ main ============
function main() {
  const statsOnly = process.argv.includes('--stats');
  const ALL_LAW_IDS = loadLawIds();
  const stamp = latestStamp();
  if (!stamp) throw new Error('manifest がありません');
  const root = path.join(REPO_ROOT, `all_saiketsu_${stamp}`, 'service');

  const walk = (dir, out) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.html$/.test(e.name)) out.push(p);
    }
  };

  // MP（要旨）
  const abstracts = new Map();
  const mpFiles = [];
  walk(path.join(root, 'MP'), mpFiles);
  let mpItems = 0;
  for (const f of mpFiles) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (/index\.html$/.test(rel)) continue;
    for (const it of parseMpPage(fs.readFileSync(f, 'utf8'), rel)) {
      mpItems++;
      const key = it.key;
      if (!abstracts.has(key)) {
        abstracts.set(key, { title: it.title, body: it.body, date: it.date || null, topics: [], taxDirs: [] });
      }
      const ex = abstracts.get(key);
      if (it.topic && !ex.topics.includes(it.topic)) ex.topics.push(it.topic);
      if (it.taxDir && !ex.taxDirs.includes(it.taxDir)) ex.taxDirs.push(it.taxDir);
    }
  }

  // JP（全文）
  const fulls = new Map();
  const jpFiles = [];
  walk(path.join(root, 'JP'), jpFiles);
  for (const f of jpFiles) {
    if (!/index\.html$/.test(f)) continue;
    const rel = path.relative(root, f).split(path.sep).join('/');
    const parsed = parseJpPage(fs.readFileSync(f, 'utf8'), rel);
    if (!parsed) continue;
    fulls.set(`${parsed.no}-${parsed.page}`, { ...parsed, source_path: rel });
  }

  // 結合・出力
  const outFile = path.join(STATE_DIR, `saiketsu_items_${stamp}.ndjson`);
  const out = statsOnly ? null : fs.createWriteStream(outFile);
  let joined = 0, abstOnly = 0, fullOnly = 0, unitTotal = 0;
  const keys = new Set([...abstracts.keys(), ...fulls.keys()]);
  for (const key of [...keys].sort()) {
    const a = abstracts.get(key);
    const fl = fulls.get(key);
    if (a && fl) joined++;
    else if (a) abstOnly++;
    else fullOnly++;
    if (!a) continue; // 要旨なしは検索対象外（要旨=規範層が主役）

    const refSrc = (a.title + '\n' + a.body) + (fl ? '\n' + fl.refsText : '');
    const refs = extractLawRefs(refSrc, 8, ALL_LAW_IDS);
    const laws = a.taxDirs.map((d) => TAX_DIRS[d]).filter(Boolean);
    const units = fl ? fl.units : [];
    unitTotal += units.length + 1; // +1 = 要旨ベクトル

    if (out) {
      out.write(JSON.stringify({
        id: key,
        no: key.split('-')[0],
        page: key.split('-')[1],
        title: a.title,
        abstract: a.body,
        date: a.date || (fl && fl.date) || null,
        topics: a.topics,
        tax_laws: laws.map(([id, name]) => ({ law_id: id, law: name })),
        law_refs: refs,
        sections: fl ? fl.sections : null,
        units,
        full_len: fl ? fl.fullLen : 0,
        source_path: fl ? fl.source_path : null,
        url: fl ? `https://www.kfs.go.jp/${['service', fl.source_path].join('/')}`.replace('/service/service/', '/service/') : null,
        has_full: !!fl,
      }) + '\n');
    }
  }
  if (out) out.end();

  console.log(`パース完了 (snapshot ${stamp})`);
  console.log(`  MPページ: ${mpFiles.length} / 要旨ブロック: ${mpItems} / ユニーク裁決(要旨): ${abstracts.size}`);
  console.log(`  全文: ${fulls.size} / 結合: ${joined} / 要旨のみ: ${abstOnly} / 全文のみ: ${fullOnly}`);
  console.log(`  埋め込みユニット合計（要旨含む）: ${unitTotal}`);
  if (!statsOnly) console.log(`出力: ${outFile}`);
}

// require された場合は実行しない（検証スクリプトが抽出関数だけを使うため）
if (require.main === module) main();

module.exports = { extractLawRefs, resolveBySuffix, unitsFromSections };
