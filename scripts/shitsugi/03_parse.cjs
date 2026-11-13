// 質疑応答事例 個別ページのパース＋アンカー抽出
//
//   node scripts/shitsugi/03_parse.cjs            # 最新スナップショットを全件パース
//   node scripts/shitsugi/03_parse.cjs --stats    # 統計のみ（law_id未解決一覧など）
//
// 入力: scripts/shitsugi/state/manifest_YYYYMMDD.ndjson + all_shitsugi_YYYYMMDD/ のHTML
// 出力: scripts/shitsugi/state/shitsugi_items_YYYYMMDD.ndjson （1行=1事例）
//
// 事例ページ判定: 【照会要旨】と【回答要旨】の両見出しを持つページ。
// 【関係法令通達】の各行から法令（法人税法第22条第2項）と通達（法人税基本通達2－1－18）を
// ルールベースで抽出し、src/lawIds.js（ALL_LAW_IDS）で law_id を解決する。

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_DIR = path.join(__dirname, 'state');

// lawIds.js は ESM（export const ALL_LAW_IDS = {...};）なので剥がしてパース
function loadLawIds() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'lawIds.js'), 'utf8');
  const m = src.match(/export const ALL_LAW_IDS\s*=\s*(\{[\s\S]*\});/);
  if (!m) throw new Error('ALL_LAW_IDS not found in src/lawIds.js');
  return JSON.parse(m[1]);
}

// 別名 → 正式名（質疑応答事例の表記ゆれ吸収）
const LAW_ALIASES = {
  措置法: '租税特別措置法',
  措法: '租税特別措置法',
  租税特別措置法施行令: '租税特別措置法施行令',
  通則法: '国税通則法',
  災害減免法: '昭和二十二年法律第百七十五号（災害被害者に対する租税の減免、徴収猶予等に関する法律）',
  // 法令名中の「、」で分割された断片（災害被害者に対する租税の減免、徴収猶予等に関する法律）
  徴収猶予等に関する法律: '昭和二十二年法律第百七十五号（災害被害者に対する租税の減免、徴収猶予等に関する法律）',
  徴収猶予等に関する法律の施行に関する政令: '昭和二十二年政令第二百六十八号（災害被害者に対する租税の減免、徴収猶予等に関する法律の施行に関する政令）',
  租税条約等実施特例法: '租税条約等の実施に伴う所得税法、法人税法及び地方税法の特例等に関する法律',
  租税条約等実施特例省令: '租税条約等の実施に伴う所得税法、法人税法及び地方税法の特例等に関する法律の施行に関する省令',
  印紙をもってする歳入金納付に関する法律: '印紙をもつてする歳入金納付に関する法律',
  復興財源確保法: '東日本大震災からの復興のための施策を実施するために必要な財源の確保に関する特別措置法',
  特定調停法: '特定債務等の調整の促進のための特定調停に関する法律',
  震災特例法: '東日本大震災の被災者等に係る国税関係法律の臨時特例に関する法律',
};
// ほかの法令の名前の末尾にもなる略称（「臨時措置法」「特別措置法」「特措法」の末尾の「措置法」「措法」）
const SOCHI_ALIASES = new Set(['措置法', '措法']);

function latestStamp() {
  const f = fs.readdirSync(STATE_DIR).filter((x) => /^manifest_\d{8}\.ndjson$/.test(x)).sort();
  return f.length ? f[f.length - 1].match(/(\d{8})/)[1] : null;
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function decodeEntities(s) {
  return s
    .replace(/&emsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&times;/gi, '×')
    .replace(/&divide;/gi, '÷')
    .replace(/&middot;/gi, '・')
    .replace(/&hellip;/gi, '…')
    .replace(/&rarr;/g, '→')
    .replace(/&larr;/g, '←')
    .replace(/&darr;/g, '↓')
    .replace(/&uarr;/g, '↑')
    .replace(/&rArr;/g, '⇒')
    .replace(/&laquo;/gi, '《')
    .replace(/&raquo;/gi, '》')
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&');
}

// セクションHTML → プレーンテキスト。丸数字画像は①…に置換、本文画像は [図: alt] に置換して記録。
function htmlToText(html, images, sectionName) {
  let s = html;
  // コメントアウトされたブロックを丸ごと除去（<!-- <ul>…</ul> --> のように内部に > を含む
  // 複数行コメントがあり、タグ除去だけだと --> の断片と非表示テキストが本文に混入する）
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // 丸数字（/shared/images/decimal/NN.gif alt="丸N"）
  s = s.replace(/<img[^>]*alt=["']丸(\d+)["'][^>]*>/gi, (_, n) => CIRCLED[parseInt(n, 10) - 1] || `(${n})`);
  // 本文画像（図解・計算式）
  s = s.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (tag, src) => {
    const altM = tag.match(/alt=["']([^"']*)["']/i);
    const alt = altM ? decodeEntities(altM[1]) : '';
    if (/\.(gif|png|jpe?g)$/i.test(src) && !/\/shared\/|\/common\//i.test(src)) {
      images.push({ src, alt, section: sectionName });
      return `\n[図: ${alt || '図'}]\n`;
    }
    return alt; // 装飾画像はalt文字のみ
  });
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(h\d|div|table|tr|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \s]+$/g, '').replace(/^\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 漢数字・全角数字 → 半角（条・項・号番号用の簡易変換）
function normNum(s) {
  const z2h = (t) => t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return z2h(s);
}

// 「第22条の3第2項第1号」等 → { article: '22の3', paragraphs: ['2'], items: ['1'] }
function parseArticleRef(s) {
  const t = normNum(s);
  const out = { article: null, paragraphs: [], items: [] };
  const am = t.match(/第(\d+(?:の\d+)*)条(の\d+(?:の\d+)*)?/);
  if (am) out.article = am[1] + (am[2] || '');
  for (const m of t.matchAll(/第(\d+)項/g)) out.paragraphs.push(m[1]);
  for (const m of t.matchAll(/第(\d+(?:の\d+)*)号/g)) out.items.push(m[1]);
  return out;
}

// 法令名サフィックス。長い候補を先に（「〜に関する法律」は 法律 で終わる: 2025-12-30 の教訓と同じ）
const LAW_SUFFIX = '(?:法律|省令|政令|規則|条約|規程|法|令)';

function resolveLaw(lawName, ALL_LAW_IDS) {
  // 「所得税法等の一部を改正する法律による改正前の法人税法」→「法人税法」（現行法にアンカー）
  const n = lawName.replace(/^.*による改正前の/, '');
  return ALL_LAW_IDS[n] || ALL_LAW_IDS[LAW_ALIASES[n]] || null;
}

function lawAnchor(lawName, refPart, ALL_LAW_IDS, raw) {
  const ref = parseArticleRef(refPart);
  const articles = [...refPart.matchAll(/第(\d+(?:の\d+)*)条(?!第)/g)].map((m) => m[1]);
  return {
    kind: 'law',
    law: lawName,
    law_id: resolveLaw(lawName, ALL_LAW_IDS),
    article: ref.article,
    articles: articles.length > 1 ? articles : undefined,
    paragraphs: ref.paragraphs,
    items: ref.items,
    raw,
  };
}

// 行を左から走査し、法令名が出るたびに帰属先を切り替えて条番号を集める。
// 「災害被害者に対する租税の減免、徴収猶予等に関する法律」のように読点を含む法令名があるため、
// 「、」で分割する方式は使えない。各位置で最長一致の法令名を試す。
function buildNameIndex(ALL_LAW_IDS) {
  if (buildNameIndex._cache) return buildNameIndex._cache;
  const map = { ...ALL_LAW_IDS };
  // 「昭和二十二年法律第百七十五号（災害被害者に…関する法律）」形式のキーは、原文では
  // 括弧内の通称だけで書かれるため、通称も引けるようにする
  for (const [k, v] of Object.entries({ ...map })) {
    const m = k.match(/^.+?（(.+)）$/);
    if (m && !map[m[1]]) map[m[1]] = v;
  }
  for (const [alias, full] of Object.entries(LAW_ALIASES)) {
    if (!map[alias] && map[full]) map[alias] = map[full];
  }
  const names = Object.keys(map).sort((a, b) => b.length - a.length);
  // 【2026-09-01 高速化】全8,900件を各文字位置で試すと裁決本文（平均7,500字）では
  //   現実的な時間で終わらない。先頭1文字で引ける索引を持つ（長い順は維持するので
  //   最長一致という結果は変わらない）。
  const byFirst = new Map();
  for (const nm of names) {
    const c = nm[0];
    if (!byFirst.has(c)) byFirst.set(c, []);
    byFirst.get(c).push(nm);
  }
  const findAt = (text, i) => {
    const cand = byFirst.get(text[i]);
    if (!cand) return undefined;
    for (const nm of cand) if (text.startsWith(nm, i)) return nm;
    return undefined;
  };
  // 接尾一致（「改正前の法人税法」→ 法人税法）は末尾文字で引く
  const byLast = new Map();
  for (const nm of names) {
    const c = nm[nm.length - 1];
    if (!byLast.has(c)) byLast.set(c, []);
    byLast.get(c).push(nm);
  }
  const findTail = (s2, exclude) => {
    const cand = byLast.get(s2[s2.length - 1]);
    if (!cand) return undefined;
    for (const nm of cand) if (nm !== exclude && s2.endsWith(nm)) return nm;
    return undefined;
  };
  return (buildNameIndex._cache = { map, names, findAt, findTail });
}

function scanLawArticles(text, ALL_LAW_IDS, raw) {
  const { map, findAt, findTail } = buildNameIndex(ALL_LAW_IDS);
  const byLaw = new Map();
  let curLaw = null, curId = null;
  let i = 0;
  while (i < text.length) {
    // 通達名が始まったら以後の帰属をリセット（通達は tsutatsu 側の担当）
    // 【2026-09-01 修正】30字先の「通達」まで読点なしで飛ぶため、
    //   「相続税法第22条の趣旨及び財産評価基本通達」のように手前の法令＋条番号ごと
    //   食い潰していた（裁決の地の文で多発）。飛ばす範囲に条番号が入るなら通達名の
    //   始まりではないので、リセットしない。
    const tsu = text.slice(i).match(/^[^、,，]{0,30}?通達/);
    if (tsu && !/第\d+(?:の\d+)*条/.test(tsu[0])) { curLaw = null; curId = null; i += tsu[0].length; continue; }
    // 「附則」以降の条番号は本則と別の番号体系なので、本則条文に帰属させない。
    // 「平成28年改正法附則第45条」を消費税法45条として登録するような誤りを防ぐ
    if (text.startsWith('附則', i)) { curLaw = null; curId = null; i += 2; continue; }
    // その位置から始まる「法令名らしいひとかたまり」（条番号の手前まで）
    // 【2026-09-01 修正】「第38条及び第33条」の「及び」等が法令名候補として消費され、
    //   帰属先(curLaw)が null に落ちて2つ目以降の条が捨てられていた。
    //   条文の列挙をつなぐ語は帰属先を変えないので、素通りさせる。
    const conj = text.slice(i).match(/^(?:及び|並びに|又は|若しくは|、|,|，|・|かつ|ならびに)/);
    if (conj) {
      // 接続詞の直後に法令名が来る場合（「並びに法人税法第22条」）は、
      // 接続詞だけを飛ばして次の周回で法令名を拾わせる（トークンに食わせない）。
      i += conj[0].length;
      continue;
    }
    // 【2026-09-01 修正】条番号の照合は法令名候補(token)より先に行う。
    //   後にすると「第37条並びに法人税法」がひとかたまりの法令名候補として
    //   遅延一致してしまい、直前の法令の条が丸ごと消える。
    // 枝番は「第2条の21」のように**条の後ろ**に付く（「第2の21条」ではない）。
    // m[1]=条番号 / m[2]=枝番（"の21" 等・複数段あり） / m[3]=項・号
    const m = text.slice(i).match(/^第?(\d+(?:の\d+)*)条((?:の\d+)*)((?:第\d+項)*(?:第\d+(?:の\d+)*号)*)/);
    if (m) {
      if (curLaw) {
        const art = m[1] + (m[2] || '');
        if (!byLaw.has(curLaw)) {
          byLaw.set(curLaw, { kind: 'law', law: curLaw, law_id: curId, article: art, articles: [], paragraphs: [], items: [], raw });
        }
        const a = byLaw.get(curLaw);
        if (!a.articles.includes(art)) a.articles.push(art);
        for (const x of m[3].matchAll(/第(\d+)項/g)) if (!a.paragraphs.includes(x[1])) a.paragraphs.push(x[1]);
        for (const x of m[3].matchAll(/第(\d+(?:の\d+)*)号/g)) if (!a.items.includes(x[1])) a.items.push(x[1]);
      }
      i += m[0].length;
      continue;
    }
    const token = (text.slice(i).match(/^(?!及び|並びに|又は|若しくは)[^、,，。\s]{2,60}?(?:条約|協定|法律|省令|政令|規則|規程|法|令)(?=第|、|,|，|。|\s|$)/) || [])[0] || null;
    const hit = findAt(text, i);
    if (hit) {
      curLaw = hit; curId = map[hit];
      // 「郵政民営化法等の施行に伴う関係法律の整備等に関する法律」のように、既知名の後ろに名前が続く場合は
      // ひとかたまり全部を消費する。既知名の分だけ進めると、残りを別の法令名と誤認して帰属が飛ぶ
      // 【2026-09-01 修正】ただし地の文では token が節をまたぐ（「建築基準法に規定する…は道路交通法」）。
      //   既知名の後ろが別の既知法令名で終わるなら1つの名前ではないので、丸呑みしない。
      const glue = token && token.length > hit.length && token.startsWith(hit);
      const rest = glue ? token.slice(hit.length) : '';
      const restIsOtherLaw = glue && !!findTail(rest, hit);
      i += (glue && !restIsOtherLaw) ? token.length : hit.length;
      // 【2026-10-15 修正】略称の後ろに「施行令」「施行規則」が続く「措置法施行令第26条」「通則法施行令（以下…）第6条」は、
      //   略称（措置法）の法律の条に付けていた（裁決で 86 本）。正式名＋施行令が地図にあればそちらに付け、無ければ帰属をリセットする
      const sub = ((glue && !restIsOtherLaw ? rest : text.slice(i)).match(/^施行(?:令|規則|規程)/) || [])[0];
      if (sub) {
        const full = (LAW_ALIASES[hit] || hit) + sub;
        if (map[full]) { curLaw = full; curId = map[full]; } else { curLaw = null; curId = null; }
        if (!(glue && !restIsOtherLaw)) i += sub.length;
      }
      continue;
    }
    if (token) {
      // 地図に無い名前。「旧所得税法」「改正前の法人税法」のように既知名で終わるならそれに帰属させ、
      // 「日・ブラジル租税条約」のように全く未知なら帰属をリセットする。
      // リセットしないと、その後の条番号が直前の法令に吸い込まれ、誤帰属が再発する
      const tail = findTail(token, null);
      // 【2026-10-15 修正】「平成7年分所得税の特別減税のための臨時措置法」「新型インフル特措法」の末尾を略称「措置法」「措法」
      //   （租税特別措置法）と読んでいた。略称の直前が「臨時」「特別」「特例」「特」なら別の法令の名前とみてリセットする。
      //   「…の目的等通則法」「請求人に措置法」のような地の文の続きは今までどおり略称と読む
      const prefix = tail ? token.slice(0, token.length - tail.length) : '';
      const otherLaw = tail && SOCHI_ALIASES.has(tail) && /(?:臨時|特別|特例|特)$/.test(prefix);
      if (tail && !otherLaw) { curLaw = tail; curId = map[tail]; } else { curLaw = null; curId = null; }
      i += token.length;
      continue;
    }
    i++;
  }
  // 出力形は従来と互換（articles は2件以上のときだけ持たせる）
  return [...byLaw.values()].map((a) => ({ ...a, articles: a.articles.length > 1 ? a.articles : undefined }));
}

// 【関係法令通達】の1行をパース。戻り値は配列（改正前併記等で1行に複数法令があり得る）
function parseKankeiLine(line, ALL_LAW_IDS) {
  const raw = line.trim();
  if (!raw) return [];
  const t = normNum(raw).replace(/ /g, ' ').trim();

  // 通達行: 「法人税基本通達2-1-18、2-1-19」「耐用年数の適用等に関する取扱通達1-1-1」
  //
  // 【2026-09-01 修正2】番号の正規表現が範囲表記「181～223共-6」「23～35共-2」を拾えず nos が空だった。
  // 【2026-09-01 修正3】通達と法令が同居する行（「所得税基本通達181～223共-1、民法第494条」）で
  //   両方落ちていた。法令を通常どおり解析したうえで、通達部分も拾って両方返す。
  //   ※ 逆に「通達を先に切り出す」実装にすると、「所得税法第216条、所得税基本通達216-1」のような
  //     法令が先に来る行が丸ごと通達に吸われ、**324件で条文が消える**（実測して差し戻した）。
  // 通達番号の形（実データから）:
  //   36-9 / 9-4-1 / 181~223共-6 / 2-3-22の7        … ハイフンで繋ぐ形
  //   財産評価基本通達2 / 同7                        … **枝番のない単独番号**
  //   64(2)-12の2 / 61の4(1)-7(注)                  … 括弧つき（措置法関係通達）
  // 【2026-09-01 修正】括弧が半角しか想定されておらず、「67－4（1）」の全角括弧を
  //   番号の一部として飲み込めずに末尾の「1」が別番号として残っていた。
  //   通達番号「1」は措置法だけで18条にぶら下がるので、事例1件に19本の誤リンクが付く。
  const NUMPAT = '\\d+(?:の\\d+)*(?:[(（]\\d+[)）])?';
  const TSU_NO_RE = () => new RegExp(`(${NUMPAT}(?:[～~]${NUMPAT})?(?:[(（]?共[)）]?)?(?:[－−-]${NUMPAT})*)`, 'g');
  // 単独番号を許すと注記文の数字まで拾ってしまうので、対象文字列を通達名の直後に限ったうえで、
  // 「令和7年8月1日現在の…」のような注記は呼び出し側で除外する。
  // 注記（「令和7年8月1日現在の法令・通達等に基づいて…」等）は日付の数字を含むので、
  // 行ごと捨てるのではなく**注記の手前までを対象にする**（同じ行に番号が同居するため）。
  const pickNos = (str) => {
    let t2 = String(str);
    const cut = t2.search(/令和|平成|昭和|現在の法令|に基づいて作成|前提とした一般的な回答|この質疑事例/);
    if (cut >= 0) t2 = t2.slice(0, cut);
    return [...t2.matchAll(TSU_NO_RE())]
      .map((m) => m[1].replace(/[－−]/g, '-').replace(/[～~]/g, '~'))
      .filter((x) => x && !/^0+$/.test(x));
  };
  if (/通達|事務運営指針/.test(t) && !/第\d+条/.test(t)) {
    const nameM = t.match(/([^\s、。「」（）]+?(?:基本通達|取扱通達|通達|事務運営指針))/);
    const name = nameM ? nameM[1] : t;
    return [{ kind: 'tsutatsu', name, nos: pickNos(t), raw }];
  }
  if (/通達|事務運営指針/.test(t)) {
    // scanLawArticles は区切りに読点しか認識しない。実データには全角スペース区切りの行があり
    //   「消費税法施行令第45条第3項　消費税法基本通達10-1-5」
    // そのまま渡すと後続の通達名を条番号の続きと見て打ち切られ、法令が取れない（実測2件）。
    const laws = scanLawArticles(t.replace(/（[^）]*）/g, '').replace(/[　\t]+/g, '、'), ALL_LAW_IDS, raw);
    const nameM = t.match(/([^\s、。「」（）]+?(?:基本通達|取扱通達|通達|事務運営指針))/);
    if (nameM) {
      const name = nameM[1];
      const after = t.slice(t.indexOf(name) + name.length);
      const lawStart = after.search(new RegExp(`[^\\s、。]+?${LAW_SUFFIX}第`));
      const nos = pickNos(lawStart >= 0 ? after.slice(0, lawStart) : after);
      if (laws.length || nos.length) return [...laws, { kind: 'tsutatsu', name, nos, raw }];
    }
    if (laws.length) return laws;
  }

  // 括弧書き（「令和7年法律第13号」等）を除去してから法令をパース（raw は保持）
  const tp = t.replace(/（[^）]*）/g, '');

  // 法令行: 「法人税法第22条第2項、第4項」「〜の促進に関する法律第2条第2項」
  //
  // 【2026-08-30 修正】以前は行頭の法令名を1つ取り、その後の条番号を**全部その法令に帰属**させていた。
  // 複数法令が並ぶ行（「所得税法第37条、…、地方税法第343条、第359条」）で2つ目以降の法令名が無視され、
  // 実在しない条文（所得税法343条など）が生まれていた。1,939事例中621事例に誤りがあった。
  // 現在は行を左から走査し、法令名が現れるたびに帰属先を切り替える（15_fix_anchors.cjs と同一方式）。
  const scanned = scanLawArticles(tp, ALL_LAW_IDS, raw);
  if (scanned.length) return scanned;

  // 別表参照: 「減価償却資産の耐用年数等に関する省令別表第1、別表第2」
  const appxM = tp.match(new RegExp(`^([^\\s、。]+?${LAW_SUFFIX})別表第`));
  if (appxM) {
    const appendices = [...tp.matchAll(/別表第(\d+)/g)].map((m) => m[1]);
    return [{
      kind: 'law',
      law: appxM[1],
      law_id: resolveLaw(appxM[1], ALL_LAW_IDS),
      article: null,
      appendices,
      paragraphs: [],
      items: [],
      raw,
    }];
  }

  // 法令名のみ（条指定なし）
  const nameOnly = tp.match(new RegExp(`^([^\\s、。]+?${LAW_SUFFIX})$`));
  if (nameOnly) {
    return [lawAnchor(nameOnly[1], '', ALL_LAW_IDS, raw)];
  }

  // フォールバック: 行中の「〜法第N条」を全て走査（「改正前の法人税法第63条」等の行中法令）
  const found = [];
  for (const m of tp.matchAll(new RegExp(`([^\\s、。「」]+?${LAW_SUFFIX})(第\\d+条[^\\s、。]*(?:、第\\d+[条項号][^\\s、。]*)*)`, 'g'))) {
    if (m[1].length < 3) continue;
    found.push(lawAnchor(m[1], m[2], ALL_LAW_IDS, raw));
  }
  if (found.length) return found;

  return [{ kind: 'other', raw }];
}

// bodyArea 抽出＋セクション分割
function parseCase(html, rec) {
  if (!/【照会要旨】/.test(html) || !/【回答要旨】/.test(html)) return null;

  // 本文は InstanceBeginEditable name="bodyArea" 〜 直後の InstanceEndEditable。
  // （パンくず内にも InstanceEndEditable が出現するため div 起点の lazy マッチでは手前で切れる）
  const bodyM = html.match(/<!--\s*InstanceBeginEditable\s+name="bodyArea"\s*-->([\s\S]*?)<!--\s*InstanceEndEditable\s*-->/);
  const body = bodyM ? bodyM[1] : html;

  const h1M = body.match(/<h1>([\s\S]*?)<\/h1>/);
  const title = h1M ? decodeEntities(h1M[1].replace(/<[^>]+>/g, '')).trim() : (rec.title || '').replace(/｜国税庁$/, '');

  // カテゴリ: パンくずの質疑応答事例直後のリンク（パンくずは bodyArea 外なので html 全体から）
  const crumbM = html.match(/law\/shitsugi\/01\.htm"[^>]*>[^<]*<\/a><\/li><li><a[^>]*>([^<]+)<\/a>/);
  let category = crumbM ? crumbM[1].trim() : null;
  if (!category && /\/taxes\/sake\/qa\//.test(rec.url)) category = '酒税関係';

  // <h2>【…】</h2> で分割
  const parts = body.split(/<h2>【([^】]+)】<\/h2>/);
  // parts: [前段, 見出し1, 中身1, 見出し2, 中身2, ...]
  const sections = {};
  for (let i = 1; i < parts.length; i += 2) sections[parts[i]] = parts[i + 1] || '';

  const images = [];
  const shokai = sections['照会要旨'] ? htmlToText(sections['照会要旨'], images, 'shokai') : '';
  const kaito = sections['回答要旨'] ? htmlToText(sections['回答要旨'], images, 'kaito') : '';

  // 関係法令通達: 注記より前の <p> 行を1行ずつ
  let kankeiRaw = [];
  let asOf = null;
  if (sections['関係法令通達']) {
    const sec = sections['関係法令通達'];
    const noteM = sec.match(/((?:令和|平成)[0-9０-９元]+年[0-9０-９]+月[0-9０-９]+日)現在/);
    if (noteM) asOf = normNum(noteM[1]);
    // 注記は <p class="red">注記… のほか <p><strong class="red">注記<br>… の形もある（2026-09 時点で 558 件）。
    // 後者を切れずに「令和７年８月１日現在の法令・通達等に…」の行が残り、通達名として拾われていた（Issue #201）。
    // どの書き方でも「注記」の手前で切り、念のため注記の定型文の行も下で捨てる
    const noteAt = sec.search(/<(?:p|strong|span|div)\b[^>]*class="red"[^>]*>\s*注記|注記\s*<br/);
    const beforeNote = noteAt >= 0 ? sec.slice(0, noteAt) : sec;
    kankeiRaw = htmlToText(beforeNote, [], 'kankei')
      .split('\n')
      .map((l) => l.replace(/^ +/, '').trim())
      .filter((l) => l && !/^注記/.test(l) && !/^(?:令和|平成)[0-9０-９元]+年[0-9０-９]+月[0-9０-９]+日現在の法令|^この質疑事例は/.test(l));
  }

  // 関連事例リンク（本文中の他事例への href）
  const related = new Set();
  for (const m of body.matchAll(/href=["']\/law\/shitsugi\/([a-z]+\/\d+\/\d+)\.htm["']/g)) related.add(m[1]);
  for (const m of body.matchAll(/href=["']\/taxes\/sake\/qa\/(\d+)\.htm["']/g)) related.add(`sake/${m[1]}`);

  return { title, category, shokai, kaito, kankeiRaw, images, asOf, related: [...related] };
}

// 酒税QA（/taxes/sake/qa/）: 「Q1　…」「A　…」「根拠法令等：…」のQ&Aリスト形式。
// 1ページ複数Qあり（最大14）。スペースは全角/半角混在。
function parseSakePage(html, rec) {
  const bodyM = html.match(/<!--\s*InstanceBeginEditable\s+name="bodyArea"\s*-->([\s\S]*?)<!--\s*InstanceEndEditable\s*-->/);
  if (!bodyM) return [];
  const body = bodyM[1];
  const h1M = body.match(/<h1>([\s\S]*?)<\/h1>/);
  const section = h1M ? decodeEntities(h1M[1].replace(/<[^>]+>/g, '')).trim().replace(/[【】]/g, '') : '';
  const images = [];
  const text = htmlToText(body, images, 'kaito');
  const qas = [];
  let cur = null, mode = null;
  for (const line of text.split('\n')) {
    const qm = line.match(/^[\s　]*Q(\d+)[\s　]+(.*)/);
    if (qm) { if (cur) qas.push(cur); cur = { n: qm[1], q: [qm[2]], a: [], kankei: [] }; mode = 'q'; continue; }
    if (!cur) continue;
    const am = line.match(/^[\s　]*A[\s　]+(.*)/);
    if (am && mode === 'q') { mode = 'a'; cur.a.push(am[1]); continue; }
    if (/^[\s　]*根拠法令等/.test(line)) {
      mode = 'k';
      const rest = line.replace(/^[\s　]*根拠法令等[：:]?[\s　]*/, '').trim();
      if (rest) cur.kankei.push(rest);
      continue;
    }
    if (mode === 'q') cur.q.push(line);
    else if (mode === 'a') cur.a.push(line);
    else if (mode === 'k' && line.trim()) cur.kankei.push(line.trim());
  }
  if (cur) qas.push(cur);
  return qas
    .filter((x) => x.q.join('').trim() && x.a.join('').trim())
    .map((x) => ({
      title: `${section ? section + '：' : ''}${x.q.join(' ').trim().slice(0, 60)}`,
      category: '酒税関係',
      shokai: x.q.join('\n').trim(),
      kaito: x.a.join('\n').trim(),
      kankeiRaw: x.kankei,
      images,
      asOf: null,
      related: [],
      qn: x.n,
    }));
}

function idForUrl(url) {
  const u = new URL(url);
  if (u.pathname.startsWith('/taxes/sake/qa/')) return 'sake/' + u.pathname.replace('/taxes/sake/qa/', '').replace(/\.html?$/, '');
  return u.pathname.replace('/law/shitsugi/', '').replace(/\.html?$/, '');
}

function main() {
  const statsOnly = process.argv.includes('--stats');
  const ALL_LAW_IDS = loadLawIds();
  const stamp = latestStamp();
  if (!stamp) throw new Error('manifest が見つかりません');
  const manifest = fs
    .readFileSync(path.join(STATE_DIR, `manifest_${stamp}.ndjson`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const outFile = path.join(STATE_DIR, `shitsugi_items_${stamp}.ndjson`);
  const out = statsOnly ? null : fs.createWriteStream(outFile);

  let cases = 0, indexPages = 0, errors = 0;
  const unresolved = {};
  const byCategory = {};
  let withImages = 0, withAnchors = 0, lineKinds = { law: 0, tsutatsu: 0, other: 0 };
  const seen = new Set();

  for (const rec of manifest) {
    if (!rec.local_path || rec.error) continue;
    if (seen.has(rec.url)) continue;
    seen.add(rec.url);
    const abs = path.join(REPO_ROOT, rec.local_path.split('/').join(path.sep));
    if (!fs.existsSync(abs)) continue;
    let html;
    try {
      html = fs.readFileSync(abs, 'utf8');
    } catch { errors++; continue; }

    let variants = [];
    const parsedMain = parseCase(html, rec);
    if (parsedMain) variants = [{ suffix: '', parsed: parsedMain }];
    else if (/\/taxes\/sake\/qa\//.test(rec.url)) {
      const qas = parseSakePage(html, rec);
      variants = qas.map((p, i) => ({ suffix: qas.length > 1 ? `#q${p.qn || i + 1}` : '', parsed: p }));
    }
    if (!variants.length) { indexPages++; continue; }

    for (const { suffix, parsed } of variants) {
    const anchors = [];
    const tsutatsuRefs = [];
    const others = [];
    for (const line of parsed.kankeiRaw) {
      for (const p of parseKankeiLine(line, ALL_LAW_IDS)) {
        lineKinds[p.kind] = (lineKinds[p.kind] || 0) + 1;
        if (p.kind === 'law') {
          anchors.push(p);
          if (!p.law_id) unresolved[p.law] = (unresolved[p.law] || 0) + 1;
        } else if (p.kind === 'tsutatsu') tsutatsuRefs.push(p);
        else others.push(p.raw);
      }
    }

    cases++;
    byCategory[parsed.category || '?'] = (byCategory[parsed.category || '?'] || 0) + 1;
    if (parsed.images.length) withImages++;
    if (anchors.some((a) => a.law_id)) withAnchors++;

    if (out) {
      out.write(
        JSON.stringify({
          id: idForUrl(rec.url) + suffix,
          url: rec.url,
          source_path: rec.local_path,
          category: parsed.category,
          title: parsed.title,
          shokai: parsed.shokai,
          kaito: parsed.kaito,
          kankei_raw: parsed.kankeiRaw,
          anchors,
          tsutatsu_refs: tsutatsuRefs,
          kankei_other: others,
          images: parsed.images,
          related: parsed.related,
          as_of: parsed.asOf,
          content_hash: rec.content_hash,
          last_modified: rec.last_modified,
        }) + '\n'
      );
    }
    }
  }
  if (out) out.end();

  console.log(`パース完了 (snapshot ${stamp})`);
  console.log(`  事例: ${cases} / 目次等: ${indexPages} / 読込エラー: ${errors}`);
  console.log(`  画像あり: ${withImages} / 条文アンカー解決済み: ${withAnchors}`);
  console.log(`  関係法令行内訳: 法令 ${lineKinds.law} / 通達 ${lineKinds.tsutatsu} / その他 ${lineKinds.other}`);
  console.log('  カテゴリ内訳:');
  for (const [k, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) console.log(`    ${n}\t${k}`);
  const un = Object.entries(unresolved).sort((a, b) => b[1] - a[1]);
  if (un.length) {
    console.log(`  law_id 未解決 (${un.length}種):`);
    for (const [k, n] of un.slice(0, 30)) console.log(`    ${n}\t${k}`);
  }
  if (!statsOnly) console.log(`出力: ${outFile}`);
}

// require された場合は実行しない（検証スクリプトが解析関数だけを使うため）
if (require.main === module) main();


// 検証・再適用スクリプトから本物の解析をそのまま呼べるように公開する。
// （写しを書くと本番と別物を測ることになる。2026-08〜09に同じ事故を繰り返した）
module.exports = { parseKankeiLine, scanLawArticles, resolveLaw, loadLawIds, parseCase };
