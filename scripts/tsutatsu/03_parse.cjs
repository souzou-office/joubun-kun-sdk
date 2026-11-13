// 保存した通達HTMLをパースし、通達項目（番号・見出し・本文・引用条文）を抽出して NDJSON 出力。
//
// 使い方:
//   node scripts/tsutatsu/03_parse.cjs                       # 最新スナップショット全体
//   node scripts/tsutatsu/03_parse.cjs --snapshot 20260602
//   node scripts/tsutatsu/03_parse.cjs --only kihon/hojin/09 # パス部分一致でフィルタ（検証用）
//   node scripts/tsutatsu/03_parse.cjs --max 50              # 先頭50ファイルだけ（検証用）
//
// 出力: scripts/tsutatsu/state/tsutatsu_items_YYYYMMDD.ndjson
//   { tsutatsu_no, circular_path, caption, body, citations:[{kind,article,branch,para,item,title}],
//     source_url, source_path, last_modified }
//
// 引用抽出の方針（実HTMLで確認済み）:
//   - 「法第○条」「令第○条」「規第○条」= 略称＝その通達のベース法令（法人税法/施行令/施行規則 等）。
//     ベース法令IDへの解決は 04_build_links.cjs 側で circular_path から行う（ここでは kind を出すだけ）。
//   - 「措置法第○条」= 租税特別措置法。
//   - 「同法第○条」や「民事再生法第○条」等の“前が漢字/かな”のものは略称ではない他法令なので除外。
//   - 末尾の改正履歴「（平19年課法2－3…により追加/改正）」は除去してから抽出（課法N－M を誤拾いしない）。

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { snapshot: null, only: null, max: Infinity };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--snapshot') o.snapshot = a[++i];
    else if (a[i] === '--only') o.only = a[++i];
    else if (a[i] === '--max') o.max = parseInt(a[++i], 10);
  }
  return o;
}

function latestSnapshot() {
  const dirs = fs.readdirSync(REPO_ROOT).filter((d) => /^all_tsutatsu_\d{8}$/.test(d));
  dirs.sort();
  return dirs.length ? dirs[dirs.length - 1].replace('all_tsutatsu_', '') : null;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.html?$/i.test(e.name)) out.push(p);
  }
  return out;
}

function zen2han(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&emsp;|&ensp;|&thinsp;/gi, ' ') // &emsp;未対応だと<strong>9－2－15&emsp;</strong>の番号判定が失敗し、後続通達が前の通達に丸呑みされる（9-2-14で実害）
    .replace(/&times;/gi, '×')
    .replace(/&divide;/gi, '÷')
    .replace(/&middot;/gi, '・')
    .replace(/&hellip;/gi, '…')
    .replace(/&rarr;/g, '→')
    .replace(/&larr;/g, '←')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normNo(s) {
  return zen2han(s)
    .replace(/[－—―‐–−]/g, '-')
    .replace(/\s+/g, '')
    .trim();
}

function extractContent(html) {
  let m = html.match(/InstanceBeginEditable name="bodyArea"[^>]*-->([\s\S]*?)<!--\s*InstanceEndEditable/);
  if (m) return m[1];
  m = html.match(/id="bodyArea"[^>]*>([\s\S]*?)(?:<div class="right-menu"|<footer)/);
  if (m) return m[1];
  // 【2026-09-02 追加】第3の雛形。bodyArea も InstanceBeginEditable も無く
  //   <div class="full-content contents"> で本文を囲むページがある（33ページ中32）。
  //   ここを拾えないと本文枠が無い＝0件として素通りし、通達が静かに消える。
  m = html.match(/<div class="full-content contents"[^>]*>([\s\S]*?)(?:<div id="footer"|<div class="page-top-link"|<footer)/);
  return m ? m[1] : null;
}

// 前方が漢字（同法・民事再生法・会社法 等の名前付き法令の一部）の場合のみ除外。
// ひらがな/カタカナの助詞（「で令第」「は法第」等）は略称＝ベース法令なので除外しない。
// 枝番は「の○」を連続で許す（「第40条の4の3」等の二重枝番に対応）。branch は "4の3" のような文字列。
// 旧/新/現 の接頭は同一法令の旧版・新版＝ベース法のまま拾う（「旧法第70条の6」「新法第70条の4」。同法/民法等の漢字接頭は従来どおり除外）。
const CITE_BASE = /(?<![一-鿿々〇])(?:旧|新|現)?(法|令|規則|規)第\s*(\d+)\s*条((?:の\s*\d+)*)(?:\s*第\s*(\d+)\s*項)?(?:\s*第\s*(\d+)\s*号)?(?:\s*《([^》]+)》)?/g;
// 「措置法第○条」=措置法、「措置法令第○条」=施行令、「措置法規則/規第○条」=施行規則（措置法ファミリーは別ID）。
const CITE_SOCHI = /(?:措置法|租税特別措置法)(令|規則|規)?第\s*(\d+)\s*条((?:の\s*\d+)*)(?:\s*第\s*(\d+)\s*項)?(?:\s*第\s*(\d+)\s*号)?(?:\s*《([^》]+)》)?/g;
// 附則の条（「法附則第19条」「措置法附則第○条」等）。本則の条と衝突しないよう article は "附則N" 文字列で持つ。
const CITE_FUSOKU = /(?<![一-鿿々〇])(?:旧|新|現)?(措置法|法|令|規則|規)附則第\s*(\d+)\s*条((?:の\s*\d+)*)(?:\s*第\s*(\d+)\s*項)?/g;

function extractCitations(text) {
  const t = zen2han(text).replace(/（[^（）]*により(?:追加|改正|削除|新設|変更)[^（）]*）/g, ' ');
  const cites = [];
  const seen = new Set();
  const branchStr = (s) => (s ? s.replace(/\s*の\s*/g, 'の').replace(/^の/, '') : null); // "の4の3"→"4の3"
  const add = (kind, artStr, brStr, paraStr, itemStr, titleStr) => {
    const item = {
      kind,
      article: +artStr,
      branch: branchStr(brStr),
      para: paraStr ? +paraStr : null,
      item: itemStr ? +itemStr : null,
      title: titleStr || null,
    };
    const key = `${kind}:${item.article}:${item.branch}:${item.para}:${item.item}`;
    if (seen.has(key)) return;
    seen.add(key);
    cites.push(item);
  };
  let m;
  // 附則の条を先に確定（「法附則第○条」を CITE_BASE が「法第…」と誤読しないよう、附則部分を別キーで先取り）
  while ((m = CITE_FUSOKU.exec(t))) {
    const suf = m[1] === '規' ? '規則' : m[1]; // 措置法|法|令|規則
    const art = '附則' + m[2] + (m[3] ? m[3].replace(/\s*の\s*/g, 'の') : '');
    const key = `${suf}附則:${art}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cites.push({ kind: suf + '附則', article: art, branch: null, para: m[4] ? +m[4] : null, item: null, title: null });
  }
  // 措置法系を先に：措置法令/規則を施行令・施行規則として確定（CITE_BASE は前が漢字の令/規を除外するので二重取りはしない）
  while ((m = CITE_SOCHI.exec(t))) {
    const suf = m[1] || ''; // ''|令|規則|規
    add('措置法' + (suf === '規' ? '規則' : suf), m[2], m[3], m[4], m[5], m[6]);
  }
  while ((m = CITE_BASE.exec(t))) add(m[1], m[2], m[3], m[4], m[5], m[6]);
  return cites;
}

// ページの「住所(home)」＝通達の構造上の所属を、タイトル/H1から判定。
// kind: 'jou'(第○条関係) | 'section'(第○節/章/款) | 'go'(第○号=印紙税) | 'topic'(個別通達) | 'unknown'
function extractHome(html) {
  const title = ((html.match(/<title>([^<]+)<\/title>/) || [])[1] || '').replace(/\s*[｜|].*$/, '').trim();
  const h1 = ((html.match(/<h1>([^<]+)<\/h1>/) || [])[1] || '').trim();
  const head = title || h1;
  if (!head) return { kind: 'unknown', label: '' };
  // 第○条《…》関係 / 第○条関係 → その条がホーム（枝番対応）
  // law: 見出しがどの法令の条か。'sochi'=措置法 / 'base'=その通達群のベース法（既定）
  let m = head.match(/第\s*([0-9０-９]+)\s*条((?:の\s*[0-9０-９]+)*)\s*(?:[《（(][^》）)]*[》）)])?\s*関係/);
  if (m) {
    const law = /措置法|租税特別/.test(head) ? 'sochi' : 'base';
    return { kind: 'jou', law, jou: zen2han(m[1]) + zen2han(m[2]).replace(/\s*の\s*/g, 'の'), label: head };
  }
  // 第○節/章/款/編 → セクション（条は本文引用で解決する型）
  if (/第\s*[0-9０-９一二三四五六七八九十百]+\s*[節章款編]/.test(head)) return { kind: 'section', label: head };
  // 第○号 → 印紙税 課税物件表の号
  m = head.match(/第\s*([0-9０-９]+)\s*号/);
  if (m) return { kind: 'go', go: zen2han(m[1]), label: head };
  // それ以外＝個別通達のトピックタイトル（条は本文/タイトルから解決）
  return { kind: 'topic', label: head };
}

// 通達番号として認めるか。従来は /^\d+(?:[-の]\d+)*$/ のみで、範囲番号
// 「23~35共-1」「42の6~48(共)-1」（複数条にまたがる通達）を弾いていた。
function isTsutatsuNo(no) {
  if (!no) return false;
  if (/^\d+(?:[-の]\d+)*$/.test(no)) return true;
  // 範囲型「23~35共-1」（23条から35条まで）
  if (/^\d+(?:の\d+)*[~～]\d+(?:の\d+)*[(（]?共[)）]?(?:-\d+(?:の\d+)*)+$/.test(no)) return true;
  // 【2026-09-02 追加】列挙型「36・37共-1」「69の6・69の7共-5」（36条と37条に共通）。
  //   これを番号と認めないと、<strong>36</strong><strong>・37共－1</strong> のように
  //   タグが分割されたページで smOne が部分的な「36」だけを採用し、
  //   1ページ8本が全て番号「36」に潰れて衝突する（shotoku/05/11.htm で実害）。
  // 【2026-10-04】「共」の無い列挙型「10・10の２-1」も番号と認める（国税庁が令和8年9月の措置法通達（所得税）の改正で
  //   第10条と第10条の2をまとめた「10・10の２-1」形に番号を振り直した。認めないとページの通達が全部落ちる）
  return /^\d+(?:の\d+)*(?:・\d+(?:の\d+)*)+(?:[(（]?共[)）]?)?(?:-\d+(?:の\d+)*)+$/.test(no);
}

function parseItems(content) {
  const items = [];
  let caption = null;
  let current = null;
  // 【2026-09-02 修正】class が <p の直後に来る前提だったため、
  //   <p align="left" class="indent1"> と <p  class="indent2">（空白2つ）の段落を
  //   丸ごと無視していた。同じページに両方の書き方が混在するので、そのページの
  //   通達が部分的に欠ける（shotoku/07/01 は 45-3,45-4,45-5,45-10〜45-14 の8本が脱落）。
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>|<p[^>]*\sclass="(indent\d)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) {
      caption = stripTags(m[1]).replace(/^[（(]/, '').replace(/[）)]$/, '');
    } else {
      const inner = m[3];
      // 評基通等は番号が連続する<strong>に分割される（<strong>24</strong><strong>－2　</strong>本文…）。
      // 最初のstrongだけ取ると枝番「－2」がbodyへ落ち、番号が親(24)に潰れて同番号衝突を起こす。
      // → 連続strongを全部結合して番号として解釈。純粋な番号にならない場合は旧挙動（先頭strongのみ）へフォールバック。
      // 番号のマークアップは <strong> と <span class="bold"> の2流派がある（hojin/01_01.htm等は後者）
      const smAll = inner.match(/^\s*((?:(?:<strong>|<span class="bold">)[^<]*(?:<\/strong>|<\/span>)\s*)+)([\s\S]*)$/);
      const smOne = inner.match(/^\s*(?:<strong>|<span class="bold">)([^<]+)(?:<\/strong>|<\/span>)([\s\S]*)$/);
      // 【2026-09-02 修正】番号のマークアップには第3の流派がある。太字タグに包まず
      //   段落の先頭に生テキストで置く型（税理士法・審査請求・法人個別の別紙など）。
      //   <p class="indent1">2－1　税理士法（以下「法」という。）…
      //   誤検出を避けるため、ハイフンを含む形（2-1 / 23～35共-1）だけを番号と見る。
      //   注記の「1　…」「(1)　…」のような箇条番号はハイフンが無いので拾わない。
      const smBare = inner.match(/^\s*((?:\d+(?:の\d+)*)(?:(?:[～~]|・)\d+(?:の\d+)*)*\s*(?:[(（]?共[)）]?)?(?:[－−-]\s*\d+(?:の\d+)*(?:[(（]\d+[)）])?)+)(?:[\s　]|&emsp;|&nbsp;)([\s\S]*)$/);
      let no = smAll ? normNo(stripTags(smAll[1])) : null;
      let rest = smAll ? smAll[2] : null;
      if (!isTsutatsuNo(no) && smOne) {
        no = normNo(smOne[1]);
        rest = smOne[2];
      }
      if (!isTsutatsuNo(no) && smBare) {
        no = normNo(smBare[1]);
        rest = smBare[2];
      }
      if (isTsutatsuNo(no)) {
        if (current) items.push(current);
        current = { tsutatsu_no: no, caption, body: stripTags(rest) };
      } else if (current) {
        current.body += ' ' + stripTags(inner);
      }
    }
  }
  if (current) items.push(current);
  return items;
}

function main() {
  const opts = parseArgs();
  const stamp = opts.snapshot || latestSnapshot();
  if (!stamp) {
    console.error('スナップショットが見つかりません (all_tsutatsu_YYYYMMDD)');
    process.exit(1);
  }
  const snapshotDir = path.join(REPO_ROOT, `all_tsutatsu_${stamp}`);
  const outFile = path.join(STATE_DIR, `tsutatsu_items_${stamp}.ndjson`);

  // manifest から path -> {url, last_modified}
  const manifestFile = path.join(STATE_DIR, `manifest_${stamp}.ndjson`);
  const metaByPath = {};
  if (fs.existsSync(manifestFile)) {
    for (const line of fs.readFileSync(manifestFile, 'utf8').split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        if (r.local_path) metaByPath[r.local_path] = { url: r.url, last_modified: r.last_modified };
      } catch {}
    }
  }

  let files = walk(snapshotDir);
  if (opts.only) files = files.filter((f) => f.split(path.sep).join('/').includes(opts.only));
  if (opts.max !== Infinity) files = files.slice(0, opts.max);

  const out = fs.createWriteStream(outFile, { flags: 'w' });
  let pages = 0;
  let itemCount = 0;
  let pagesWithItems = 0;
  let withCite = 0;

  for (const file of files) {
    pages++;
    const html = fs.readFileSync(file, 'utf8');
    const content = extractContent(html);
    if (!content) continue;
    const items = parseItems(content);
    if (!items.length) continue;
    pagesWithItems++;

    const relPath = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const circularPath = path
      .relative(snapshotDir, file)
      .split(path.sep)
      .slice(0, 2)
      .join('/'); // 例: kihon/hojin
    const meta = metaByPath[relPath] || {};
    const home = extractHome(html);

    for (const it of items) {
      const citations = extractCitations(it.body);
      if (citations.length) withCite++;
      itemCount++;
      out.write(
        JSON.stringify({
          tsutatsu_no: it.tsutatsu_no,
          circular_path: circularPath,
          home,
          caption: it.caption,
          body: it.body,
          citations,
          source_url: meta.url || null,
          source_path: relPath,
          last_modified: meta.last_modified || null,
        }) + '\n'
      );
    }
  }
  out.end();

  console.log(`ファイル: ${pages} (うち項目あり ${pagesWithItems})`);
  console.log(`通達項目: ${itemCount} (うち条文引用あり ${withCite} = ${itemCount ? Math.round((withCite / itemCount) * 100) : 0}%)`);
  console.log(`出力: ${outFile}`);
}

main();
