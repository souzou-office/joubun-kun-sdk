// 判例の引用を「判決が使った版の条」から「今の条」へ付け直す（curRefs）と、条文 → 判例の逆引き（hanrei_v2/links）を作る部品。
// 全件の作り直し（scripts/lineage/relink_hanrei.cjs）と判例の週次（scripts/hanrei/weekly/run.cjs）で共用する。LLM もネットも使わない。
//
// 表（付け直しの表）は scripts/lineage/tables.py が条の系譜から作る（R2 lineage_v1/tables/{法令ID}.json）:
//   { law_id, title, born, old, old_law, acts: {"平成29年法律第44号": 施行日}, arts: {"89": [[from, to, how, [[法令ID, 条キー, 確からしさ]]]]} }
//
// 判決が使った版の決め方（docs/lineage.md）:
//   1. 判決文に「（…法律第N号による改正前のもの）」があれば（lawRefs の before）、その改正法の施行日の前日の版
//   2. 無ければ判決日の版
//   3. その版にその条が無ければ、今の法令ができる前の判決は作り直す前の旧法の表（old）で引き、
//      そうでなければ直前にその条があった日の版（経過措置で旧法を当てた・旧い番号のまま引いた）
//   系譜（表）の無い法令は、今までどおり今の同じ番号の条に付ける（how: nolineage）
//
// curRefs の 1 件: { lawId, art, how, from: { lawId, art, ver }, conf }
//   how: same・renum・split・moved・old・gone（今の条から外す。lawId・art は null）。3. の直前の版で引いたものは prev: true を足す
//        nolineage（系譜の無い法令）・unverified（判決日より前にその条が無い＝読み取りの誤りなど。今の同じ番号に付けたまま）
'use strict';

const ART_RE = /^\d+(の\d+)*$/;
const LAW_RE = /^[0-9A-Za-z_]+$/;
const KEEP = new Set(['same', 'renum', 'split', 'moved', 'old', 'nolineage', 'unverified']);

const dayBefore = (iso) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t - 86400000).toISOString().slice(0, 10) : iso;
};

const arr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; } }
  return [];
};

// 期間の一覧から、その日を含む期間（from <= d < to）
function findPeriod(ps, d) {
  if (!Array.isArray(ps)) return null;
  for (const p of ps) if (p[0] <= d && (p[1] == null || d < p[1])) return p;
  return null;
}
// その日より前に始まった最後の期間（直前にその条があった版）
function lastBefore(ps, d) {
  if (!Array.isArray(ps)) return null;
  let best = null;
  for (const p of ps) if (p[0] <= d && (!best || p[0] > best[0])) best = p;
  return best;
}

// 判決文の「…法律第N号による改正前」→ その改正の前日（表の acts に無ければ判決日）
function versionDate(T, jd, before) {
  let d = jd;
  for (const b of before || []) {
    const enf = T && T.acts && T.acts[b];
    if (enf) { const x = dayBefore(enf); if (x < d) d = x; }
  }
  return d;
}

/**
 * 1 つの引用を付け直す。
 * @param {{lawId:string, art:string, before?:string[]}} ref
 * @param {string} jd 判決日（YYYY-MM-DD）
 * @param {(id:string)=>object|null} table 表を引く関数
 * @returns {Array<{lawId, art, how, from, conf}>}
 */
function resolveRef(ref, jd, table) {
  const { lawId, art } = ref;
  const T = table(lawId);
  // law: 判決が引いた法令の名前（旧法の表の題名。MCP・条文ページの注記で「旧民事訴訟法」などと書くため）
  const from = (fl, ver) => { const FT = table(fl); return { lawId: fl, art, ver, ...(FT && FT.title ? { law: FT.title, ...(FT.old_law ? { old: true } : {}) } : {}) }; };
  if (!T) return [{ lawId, art, how: 'nolineage', from: from(lawId, jd || null), conf: null }];
  // 今の同じ番号の条（外した引用を「判決当時は別の規定」の畳む枠に出す先）。今の法令の表で、その番号の期間が今まで続いていれば有る
  const sameNow = (CT, cl) => {
    const ps = CT && !CT.old_law && CT.arts && CT.arts[art];
    return Array.isArray(ps) && ps.some((x) => x[1] == null) ? [cl, art] : null;
  };
  const out = (p, fl, ver, prev, curT, curLaw) => {
    const notes = notesOf(p, ref, jd, ver, !!(T && T.old_law) || fl !== lawId);
    const nz = notes.length ? { notes } : {};
    if (p[2] === 'gone' || !p[3] || !p[3].length) {
      const at = sameNow(curT === undefined ? T : curT, curLaw || lawId);
      return [{ lawId: null, art: null, how: 'gone', from: from(fl, ver), conf: null, ...(prev ? { prev: true } : {}), ...nz, ...(at ? { at } : {}) }];
    }
    return p[3].map(([l, a, c]) => ({ lawId: l, art: a, how: p[2], from: from(fl, ver), conf: c, ...(prev ? { prev: true } : {}), ...nz }));
  };
  if (!jd) return [{ lawId, art, how: 'unverified', from: from(lawId, null), conf: null, notes: [{ k: 'unverified' }] }];
  // 政令・省令・勅令で e-Gov の一番古い版より前の判決: 系譜では引けない。今の同じ番号に付けたまま、その後の改正の回数を注記する
  if (T.egov_only && T.since && jd < T.since) {
    const n = (T.amend_dates || []).filter((x) => x > jd).length;
    return [{ lawId, art, how: 'nolineage', from: from(lawId, jd), conf: null, ...(n ? { notes: [{ k: 'ord', n }] } : {}) }];
  }
  // 旧法の名前で引いた引用（有限会社法・借地法・旧刑訴法など）: 判決日の旧法の表
  if (T.old_law) {
    const ps = T.arts && T.arts[art];
    const p = findPeriod(ps, jd) || lastBefore(ps, jd);
    if (!p) return [{ lawId: null, art: null, how: 'gone', from: from(lawId, jd), conf: null }];
    return out(p, lawId, jd, false, null);
  }
  // 判決文が「旧民法」「旧刑訴法」のように今と同じ法令名に「旧」を付けて引いた条（makeOldNameReader）
  if (ref.oldName) {
    const elsewhere = OLD_ELSEWHERE[lawId];
    if (elsewhere) return [{ lawId: null, art: null, how: 'gone', from: from(lawId, jd), conf: null, notes: [{ k: 'other_law', law: elsewhere }] }];
    if (T.old && table(T.old)) {   // 作り直す前の旧法がある（旧刑訴法・旧所得税法など）: 旧法の表で引く
      const O = table(T.old);
      const op = findPeriod(O.arts && O.arts[art], jd) || lastBefore(O.arts && O.arts[art], jd);
      if (op) return out(op, T.old, jd, false, T, lawId).map((c) => ({ ...c, notes: [...(c.notes || []), { k: 'old_name' }] }));
    }
    const ps0 = T.arts && T.arts[art];
    const cur0 = findPeriod(ps0, jd);
    if (cur0) {   // 判決のときの版より一つ前の版（その番号の条が今の形になる前）
      const dd = dayBefore(cur0[0]);
      const pp = findPeriod(ps0, dd) || lastBefore(ps0, dd);
      if (pp) return out(pp, lawId, dd).map((c) => ({ ...c, notes: [...(c.notes || []), { k: 'old_name' }] }));
    }
  }
  // 判決文が「改正前民法570条」のように改正前の印だけを付けて引いた条（2026-10-17・03 の prior）: 判決のときの版より一つ前の版
  if (ref.prior) {
    const ps1 = T.arts && T.arts[art];
    const cur1 = findPeriod(ps1, jd);
    if (cur1) {
      const dd = dayBefore(cur1[0]);
      const pp = findPeriod(ps1, dd) || lastBefore(ps1, dd);
      if (pp) return out(pp, lawId, dd).map((c) => ({ ...c, notes: [...(c.notes || []), { k: 'prior' }] }));
    }
  }
  const d = versionDate(T, jd, ref.before);
  const ps = T.arts && T.arts[art];
  let p = findPeriod(ps, d);
  if (p) return out(p, lawId, d);
  // 今の法令ができる前の判決: 作り直す前の旧法の表で引く
  if (T.born && jd < T.born && T.old) {
    const O = table(T.old);
    if (O) {
      const ops = O.arts && O.arts[art];
      const op = findPeriod(ops, jd) || lastBefore(ops, jd);
      if (op) return out(op, T.old, jd, false, T, lawId);
      const at = sameNow(T, lawId);
      return [{ lawId: null, art: null, how: 'gone', from: from(T.old, jd), conf: null, ...(at ? { at } : {}) }];
    }
  }
  p = lastBefore(ps, d);
  if (p) return out(p, lawId, p[0], true);
  return [{ lawId, art, how: 'unverified', from: from(lawId, d), conf: null, notes: [{ k: 'unverified' }] }];
}

// 「旧」を付けて今と同じ名前で引くが、別の法令を指すもの（今の法令の系譜では引けない。今の条から外す）
const OLD_ELSEWHERE = {
  '140AC0000000045': '明治13年太政官布告第36号（旧刑法）',
  '321CONSTITUTION': '大日本帝国憲法',
};

const DAY = 86400000;
const days = (a, b) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;

/**
 * 注記（判決の日 → 今 の間にその条に起きたこと）。表の期間の [4] その後の出来事・[5] 直前の変化から作る。
 *   before   判決文に「…による改正前」と明示（その版で引いた）
 *   amended  判決の後に改正された（同じ規定）: d 最初の施行日・law 改正法・n 回数
 *   replaced 判決当時の条は今の同じ番号の条とは別の規定（差し替え・削除）: d・law
 *   near     判決が改正の公布と施行のあいだか、番号の変更・差し替えの施行の直後（2 年以内）。改正前の規定を当てている可能性
 * 旧法（作り直す前の法令）の表で引いたものは、出来事が旧法の中のことなので amended・near は付けない
 */
function notesOf(p, ref, jd, ver, oldLaw) {
  const notes = [];
  const after = ver || jd || '';
  const later = (Array.isArray(p[4]) ? p[4] : []).filter((x) => (x[0] || '') > after);
  const prev = p[5] || null;
  const explicit = Array.isArray(ref.before) && ref.before.length && ver && ver !== jd;
  if (explicit) notes.push({ k: 'before', law: ref.before[0] });
  if (p[2] === 'gone') {
    const end = later.find((x) => x[1] === 'end');
    notes.push({ k: 'replaced', ...(end ? { d: end[0], law: end[2] } : {}) });
  } else if (!oldLaw) {
    const am = later.filter((x) => x[1] === 'amend' || x[1] === 'renum');
    if (am.length) notes.push({ k: 'amended', d: am[0][0], law: am[0][2], n: am.length });
  }
  if (!oldLaw && !explicit && jd) {
    const pend = later.find((x) => (x[1] === 'renum' || x[1] === 'end') && x[3] && x[3] <= jd);
    const just = prev && prev[0] && prev[0] <= jd && days(jd, prev[0]) <= 730 ? prev : null;
    const hit = pend || just;
    if (hit) notes.push({ k: 'near', d: hit[0], law: hit[2] });
  }
  return notes;
}

/**
 * 条番号の無い判例の判断した条（how: nonum）の注記（2026-10-17 のオーナーの決定）。番号を引いた判例と同じ材料（表の期間の later）で、
 * 判決の日に今の条 art が同じ規定なら、判決の後の改正（amend・renum）を amended に。判決の後にできた条（判決の日にその番号の今の規定が無い）なら born
 * （できた日: 法令ごとできたなら e-Gov の制定の施行日 T.enacted、無ければ系譜の最初の期間の始まり＝公布日。改正で足された条はその期間の始まり＝施行日）
 */
function nonumNotes(T, art, jd) {
  if (!T || !T.arts || !jd) return [];
  const ps = T.arts[art];
  if (!Array.isArray(ps) || !ps.length) return [];
  const toX = (q) => q && q[2] !== 'gone' && Array.isArray(q[3]) && q[3].some((t) => String(t[1]) === String(art));
  const p = findPeriod(ps, jd);
  if (p && toX(p)) return notesOf(p, { lawId: T.law_id, art }, jd, jd, false);
  const first = ps.filter(toX).sort((a, b) => String(a[0]).localeCompare(String(b[0])))[0];
  if (!first || !first[0] || first[0] <= jd) return [];
  const prev = first[5] || null;
  const lawBorn = T.born && first[0] === T.born;
  if (lawBorn && T.enacted && T.enacted.d) return [{ k: 'born', d: T.enacted.d }];
  if (lawBorn) return [{ k: 'born', d: first[0], prom: true }];
  return [{ k: 'born', d: first[0], ...(prev && prev[1] === 'renum' ? { renum: true } : {}), ...(prev && prev[2] ? { law: prev[2] } : {}) }];
}

const ymd = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${+m[1]}年${+m[2]}月${+m[3]}日` : ''; };
const artText = (a) => { const [n, ...eda] = String(a || '').split('の'); return `第${n}条${eda.map((x) => `の${x}`).join('')}`; };

// 注記の文言（条文ページの判例の欄・MCP で同じものを使う。worker/lawpages.js の hanreiNoteText と同じ）
function noteText(n, ctx = {}) {
  if (!n || !n.k) return '';
  const law = n.law ? `（${n.law}）` : '';
  switch (n.k) {
    case 'before': return `${n.law || ''}による改正前の規定として引用`;
    case 'amended': return `この判決の後、${ymd(n.d)}に改正されています${law}${n.n > 1 ? `（ほか ${n.n - 1} 回）` : ''}`;
    case 'replaced': return `判決当時の${artText(ctx.art)}は、今の${artText(ctx.art)}とは別の規定です${n.d ? `（${ymd(n.d)}施行の${n.law || '改正'}で差し替え・削除）` : ''}`;
    case 'near': return `判決の前後に改正があります（改正前の規定を当てている可能性があります${n.d ? `・${ymd(n.d)}施行${law}` : ''}）`;
    case 'unverified': return '判決のときの条文を確かめられませんでした';
    case 'ord': return `この判決の後、この法令は ${n.n} 回改正されています（条までは確認できません）`;
    case 'old_name': return '判決文では「旧」を付けて引用（今より前の版の規定）';
    case 'prior': return '判決文では「改正前」の規定として引用（今より前の版の規定）';
    case 'born': return n.renum ? `この条は判決の後（${ymd(n.d)}）に今の番号になりました${law}。判決は前の規定で判断しています`
      : `この条は判決の後（${ymd(n.d)}${n.prom ? '公布' : ''}）にできました${law}。判決は前の規定で判断しています`;
    case 'other_law': return `判決文の「旧」の条は${n.law || '別の法令'}の規定で、今の法令とは別の法令です`;
    default: return '';
  }
}

/**
 * 判例 1 件の curRefs。lawRefs と、旧法の名前で引いた未解決の引用（oldNames: 名前 → 旧法の法令 ID）を付け直す。
 * 同じ今の条に行き着いたものは 1 件にまとめる（そのまま引いたもの → 確からしさの高いもの の順に残す）。
 */
function curRefsOf(rec, table, oldNames, beforeOf, oldNamed) {
  const jd = /^\d{4}-\d{2}-\d{2}$/.test(rec.dateIso || '') ? rec.dateIso : null;
  const refs = [];
  for (const r of arr(rec.lawRefs)) {
    if (!r || !r.lawId || !LAW_RE.test(r.lawId) || typeof r.art !== 'string' || !ART_RE.test(r.art)) continue;
    const before = r.before || (beforeOf ? beforeOf(`${r.lawId}|${r.art}`) : null) || [];
    // oldName: 「旧民法」のように「旧」を付けて引いた（本文の読み直し makeOldNameReader か 03 の kyu）。prior: 「改正前民法」など改正前の印だけ（改正法の番号なし）
    const oldName = (oldNamed && oldNamed(`${r.lawId}|${r.art}`)) || r.kyu === true;
    const prior = !oldName && r.prior === true && !before.length;
    refs.push({ lawId: r.lawId, art: r.art, before, ...(oldName ? { oldName: true } : {}), ...(prior ? { prior: true } : {}) });
  }
  if (oldNames) {
    for (const u of arr(rec.unresolvedRefs)) {
      const id = u && oldNames.get(u.name);
      if (id && typeof u.art === 'string' && ART_RE.test(u.art)) refs.push({ lawId: id, art: u.art, before: [] });
    }
  }
  const all = [];
  for (const r of refs) all.push(...resolveRef(r, jd, table));
  // まとめる: 今の条ごとに 1 件。外した引用（gone）は 引いた条ごとに 1 件
  const direct = (c) => c.from && c.from.lawId === c.lawId && c.from.art === c.art;
  const byKey = new Map();
  for (const c of all) {
    const k = c.how === 'gone' ? `gone|${c.from.lawId}|${c.from.art}` : `${c.lawId}|${c.art}`;
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, c); continue; }
    const score = (x) => (direct(x) ? 2 : 0) + (x.conf == null ? 1 : x.conf);
    if (score(c) > score(cur)) byKey.set(k, c);
  }
  return [...byKey.values()];
}

// 条文ページに出す「旧○○法△条として引用」の元（そのまま引いたものは null）
function viaOf(c, table) {
  if (!c.from || (c.from.lawId === c.lawId && c.from.art === c.art)) return null;
  const T = table(c.from.lawId);
  const old = !!(T && T.old_law);
  return { lawId: c.from.lawId, law: (T && T.title) || null, art: c.from.art, old };
}

// 「旧民事訴訟法89条として引用」「改正前の商法266条として引用」
function viaText(v) {
  if (!v || !v.law || !v.art) return '';
  const [n, ...eda] = String(v.art).split('の');
  const a = `${n}条${eda.map((x) => `の${x}`).join('')}`;
  return v.old ? `旧${v.law}${a}として引用` : `改正前の${v.law}${a}として引用`;
}

// ---------------------------------------------------------------- 条文ページに載せるか（2026-10-16 のオーナーの方針・docs/lineage.md「載せる条件」）
// 基準は「旧法下・改正前の判例の判断・論理が今の条の解釈にも通用するか」。作り直しのときに確かなものだけ載せ、確かでないものは載せない
//   same・renum: 判決の後に条が丸ごと書き換えられた（書き直し・新しい規定）なら載せない。文言の改正だけ・表記の現代語化だけなら載せる
//   旧法（from.old）・moved・split: 旧条ごとの受け皿の判定（old_to_current.json。Jev で 1 組ずつ採点）で、行き先が 1 つ・確か・0.9 以上だけ
//   nolineage（憲法・政令など系譜の無い法令）: 今の同じ番号のまま。gone・unverified: 載せない
//   判例ごとの Opus の判断（lost_judge.json・2 回目の lost_judge2.json。キーは「判例ID|判決が引いた法令ID|条」）があればそれに従う（両方が applies に入れた条に載せる・misread は載せない）
//   判決の結びの決まり文句の中でだけ引いた条は、どの判断より先に載せない（hide: boiler・2026-10-17）
const PLAIN_LAWS = /平成16年12月1日法律第147号|平成7年5月12日法律第91号/;   // 民法の現代語化・刑法の表記の平易化（中身を変えない）
const REWRITE_OP = /書き直し|新しい規定/;
const keyU = (a) => String(a).replace(/の/g, '_');
const keyN = (a) => String(a).replace(/_/g, 'の');

// 系譜（lineage.json）→ 今の条ごとの、条が丸ごと書き換えられた出来事 { 条キー: [[施行日, 改正法]] }（表の rewrites に入れる）
function rewritesOf(L) {
  const out = {};
  for (const [art, pid] of Object.entries((L && L.final) || {})) {
    const evs = arr(((L.lineage || {})[pid])).filter((e) => e && REWRITE_OP.test(e.op || '')).map((e) => [e.date || '', e.law || '']);
    if (evs.length) out[keyN(art)] = evs;
  }
  return out;
}
// 判決の版（ver）より後に、今の条が丸ごと書き換えられたか（表に rewrites が無い＝系譜の無い法令は false）
function rewrittenSince(T, art, ver) {
  const rw = T && T.rewrites && T.rewrites[art];
  return Array.isArray(rw) && rw.some((x) => (x[0] || '') > (ver || '') && !PLAIN_LAWS.test(x[1] || ''));
}
const okDest = (d) => d && LAW_RE.test(String(d.lawId || '')) && ART_RE.test(String(d.art || ''));

// 判決の結びの決まり文句（「よって、…条を適用して（により・に従い）、主文のとおり判決する」）の中でだけ引いた条（2026-10-17 のオーナーの決定）。
// 理由の本文にも裁判所の参照法条にも同じ条番号が出てこなければ「結びだけ」（訴訟費用の負担・上告の棄却・未決勾留の算入など）。
// 条番号は算用数字・漢数字・「四〇一」の 3 通りで探す（枝番は本体の番号で見る）。判決文（R2 はセクションごとに 4,000 字で切れている）に結びが
// 見つからない判例は null（今までどおり載せる）
const KANJI = '〇一二三四五六七八九';
const kanNum = (n) => { let s = ''; for (const [v, u] of [[1000, '千'], [100, '百'], [10, '十']]) { const q = Math.floor(n / v); n %= v; if (q) s += (q === 1 ? '' : KANJI[q]) + u; } return s + (n ? KANJI[n] : ''); };
const digitKan = (n) => String(n).split('').map((d) => KANJI[+d]).join('');
const z2h = (s) => String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/(?<=[一二三四五六七八九十百千〇])○|○(?=[一二三四五六七八九〇])/g, '〇').replace(/(?<=[一二三四五六七八九十百千〇])○|○(?=[一二三四五六七八九〇])/g, '〇');
// 結びの文は「主文のとおり（通り）判決（決定・命令）する」を含む文の全部（2026-10-17 に広げた。「よって・以上により・そこで」で始まる文に限ると結びの 6 割しか拾えなかった）
const CLOSE_RE = /[^。]{0,300}?主文(?:の)?(?:とおり|通り)(?:判決|決定|命令)(?:す|を)[^。]{0,20}。/g;
function artForms(art) {
  const b = Number(String(art).split(/[_の]/)[0]);
  if (!b) return [];
  return [new RegExp(`(?<![0-9])${b}条`), new RegExp(`(?<![〇一二三四五六七八九十百千])${kanNum(b)}条`), new RegExp(`(?<![〇一二三四五六七八九十百千])${digitKan(b)}条`)];
}
function makeClosingOnly(rec) {
  const txt = z2h(arr(rec && rec.sections).map((s) => (s && s.text) || '').join('\n'));
  const closes = txt.match(CLOSE_RE) || [];
  if (!closes.length) return null;
  let rest = txt;
  for (const c of closes) rest = rest.split(c).join('');
  const close = closes.join(''), sansho = z2h((rec && rec.sanshoRaw) || '');
  return (art) => {
    const fm = artForms(art);
    return fm.length > 0 && fm.some((re) => re.test(close)) && !fm.some((re) => re.test(rest) || re.test(sansho));
  };
}
const appliesOf = (J) => (J && !J.misread ? arr(J.applies).map(String) : []);

// 決まった言い回しの文の中でだけ引いた条（2026-10-17 のオーナーの決定）: 刑訴法411条の「記録を調べても（精査しても）刑訴法411条を適用すべきものとは
// 認められない」（最高裁の刑事の上告棄却にほぼ必ず入る、職権で破棄すべき事情も見当たらないという確認の文で、411条の中身を判断していない）。
// 判決文の中でその条がこの型の文にしか出てこず、参照法条にも無ければ載せない（hide: boiler411）。411条で破棄した判決・各号を論じた判決は載る
const STOCK = {
  '323AC0000000131|411': { hide: 'boiler411', test: (s) => /適用すべき|破棄すべき/.test(s) && /(?:認められない|認めら?れ?ない|見当ら?な?い|存しない|ない)/.test(s) && !/破棄する/.test(s) },
  // 2026-10-18 のオーナーの決定: 上告を退ける決まった言い回し（下級審の判決が経過として書いた文も。その条を判断していない）
  //   刑訴法405条「…刑訴法405条の上告理由に当たらない」（「適法な上告理由」「上告適法の理由」「適法要件を欠く」も）
  '323AC0000000131|405': { hide: 'boiler405', test: (s) => /上告理由に(?:当た|当|あた|該)らない|適法な上告(?:の)?理由|上告適法の理由|上告の理由に(?:当た|当|あた|該)らない|上告(?:の)?理由とならない|適法要件を欠く|(?:四〇五|405|四百五)条の事由(?:は|が)(?:なく|ない)/.test(s) },
  //   民訴法312条「民訴法312条1項又は2項に規定する事由に該当しない」
  '408AC0000000109|312': { hide: 'boiler312', test: (s) => /(?:規定する|所定の|定める)?(?:事由|場合)(?:の)?(?:いずれ)?に(?:も)?(?:該当|当た|当|あた)ら?しない|所定の場合に限られる|事由を主張するもの(?:で)?(?:は)?ない|上告理由に(?:当た|当|あた|該)らない|上告の理由に(?:当た|当|あた|該)らない|明らかに該当しない/.test(s) },
  //   民訴法318条「民訴法318条1項により受理すべきものとは認められない」
  '408AC0000000109|318': { hide: 'boiler318', test: (s) => /受理すべきものとは認められない|受理しない|受理すべきものと(?:は)?認め(?:られ)?ない|事件に(?:当た|当|あた)らない|上告(?:の)?理由とならない/.test(s) },
};
function makeStockOnly(rec) {
  const txt = z2h(arr(rec && rec.sections).map((s) => (s && s.text) || '').join('\n'));
  if (!txt) return null;
  const sents = txt.split(/(?<=。)(?![）)」』])/);   // 括弧の中の「。」（「（以下「本件規定」という。）」）では切らない
  const sansho = z2h((rec && rec.sanshoRaw) || '');
  const memo = new Map();
  return (lawId, art) => {
    const k = `${lawId}|${art}`;
    const rule = STOCK[k];
    if (!rule) return null;
    if (memo.has(k)) return memo.get(k);
    const fm = artForms(art);
    const hits = sents.filter((s) => fm.some((re) => re.test(s)));
    const only = hits.length > 0 && hits.every(rule.test) && !fm.some((re) => re.test(sansho));
    memo.set(k, only ? rule.hide : null);
    return memo.get(k);
  };
}

// 最高裁の「上告理由に当たらない」だけで理由の欄の無い決定（2026-10-17 のオーナーの決定。どの条についても判断していない）: 条番号の無い判例の判断した条を
// 載せない。「上告の理由としてその適法要件を欠く」「上告適法の理由とならない」「刑訴法405条の上告理由に当たらない」なども拾う。
// 職権で判断した・「なお…判断する」があれば理由ありとして外さない
const NO_GROUND_RE = /上告の理由として(?:その)?適法要件を欠く|適法な上告(?:の)?理由に(?:当た|当|あた)らない|適法な上告(?:の)?理由と(?:なら|ならない|は(?:ならない|認められない))|上告(?:の)?理由に(?:当た|当|あた)らない|上告適法の理由と(?:なら|ならない)|上告理由として不適法|(?:四〇五|405)条の上告理由|上告理由(?:として|と)?(?:は)?(?:採用|採る)(?:できない|に足りない)/;
const HAS_REASON_RE = /職権(?:で|により|をもつて|をもって|を以て)?(?:判断|按|考察|検討)|なお[、，]?(?:[^。]{0,30})(?:判断する|按ずる|考える|付言する)|当裁判所の判断/;
function noGroundDecision(rec) {
  if (!/最高裁判所/.test(String((rec && rec.court) || ''))) return false;
  const txt = z2h(arr(rec && rec.sections).map((s) => (s && s.text) || '').join('\n'));
  return NO_GROUND_RE.test(txt) && !HAS_REASON_RE.test(txt);
}

/**
 * 1 つの付け直し（curRefs の 1 件）を条文ページに載せるかを決め、c に show か hide を足して返す。
 *   show: [{ lawId, art, by: 'lineage'|'jev'|'opus', s?, reason? }]（空なら載せない）・hide: 載せない理由
 * @param {string} cid 判例 ID
 * @param {{old?: object, judge?: object}} policy old: old_to_current.json・judge: lost_judge.json
 */
function decideShow(cid, c, table, policy, closingOnly, stockOnly) {
  const fr = c.from || {};
  const P = policy || {};
  let show = [], hide = null;
  if (closingOnly && closingOnly(fr.art)) {
    const out = { ...c, show: [], hide: 'boiler' };
    return out;
  }
  const st = stockOnly && fr.lawId && stockOnly(fr.lawId, fr.art);
  if (st) return { ...c, show: [], hide: st };
  if (fr.old || c.how === 'moved' || c.how === 'split') {
    const m = P.old && P.old[fr.lawId];
    const r = m && m.rows && m.rows[keyU(fr.art)];
    const to = r && Array.isArray(r.to) ? r.to : [];
    const t = r && r.band === '確か' && to.length === 1 ? to[0] : null;
    if (t && Number(t.jev) >= 0.9) show = [{ lawId: t.law, art: keyN(t.art), by: 'jev', s: Number(t.jev) }];
    else hide = !r ? 'old_nomap' : (r.band === '受け皿なし' || !to.length) ? 'old_none' : to.length > 1 ? 'old_split' : 'old_unsure';
  } else if (c.how === 'same' || c.how === 'renum') {
    if (rewrittenSince(table(c.lawId), c.art, fr.ver)) hide = 'rewrite';
    else show = [{ lawId: c.lawId, art: c.art, by: 'lineage' }];
  } else if (c.how === 'nolineage') {
    if (c.lawId && c.art) show = [{ lawId: c.lawId, art: c.art, by: 'lineage' }];
  } else hide = c.how;   // gone・unverified・（旧法の印の無い）old
  // 判例ごとの Opus の判断。2 回目（judge2・問い方を変えたもの）があれば、両方が載せるとした条だけ載せる
  // （2026-10-17。食い違いはオーナーが確かめるまで載せない側に倒す: hide 'judge_split'）
  const key = `${cid}|${fr.lawId}|${fr.art}`;
  const J = P.judge && P.judge[key];
  const J2 = P.judge2 ? P.judge2[key] : undefined;
  if (J || J2) {
    const a1 = appliesOf(J), a2 = appliesOf(J2);
    const both = J2 === undefined ? a1 : J === undefined ? [] : a1.filter((a) => a2.includes(a));
    const reason = (J && J.reason) || (J2 && (J2.why || J2.reason)) || '';
    const ap = both.map((a) => { const [l, x] = a.split('|'); return { lawId: l, art: keyN(x || ''), by: 'opus', ...(reason ? { reason: String(reason).slice(0, 300) } : {}) }; }).filter(okDest);
    if (ap.length) { show = ap; hide = null; }
    else {
      show = [];
      hide = (a1.length || a2.length) ? 'judge_split' : ((J && J.misread) || (J2 && J2.misread)) ? 'misread' : 'not_applicable';
    }
  }
  show = show.filter(okDest);
  const out = { ...c, show };
  delete out.hide;
  if (!show.length) out.hide = hide || 'none';
  return out;
}

// 載せる先ごとの注記: 系譜の行き先（c.lawId・c.art）か今の同じ番号の条（c.at）に載せるなら全部、別の条（Opus が選んだ条）なら引用そのものの注記だけ
const CITE_NOTES = new Set(['before', 'old_name', 'prior', 'other_law']);
function notesFor(c, d) {
  const ns = arr(c.notes);
  const same = (d.lawId === c.lawId && d.art === c.art) || (Array.isArray(c.at) && d.lawId === c.at[0] && d.art === c.at[1]);
  return same ? ns : ns.filter((n) => n && CITE_NOTES.has(n.k));
}
// 載せる先に対する「旧○○法△条として引用」の元（そのまま引いたものは null）
function viaFor(c, d, table) {
  if (!c.from || (c.from.lawId === d.lawId && c.from.art === d.art)) return null;
  const T = table(c.from.lawId);
  return { lawId: c.from.lawId, law: (T && T.title) || c.from.law || null, art: c.from.art, old: !!((T && T.old_law) || c.from.old) };
}
// 逆引きに置く item（show の先ごと）→ [{ lawId, art, v }]
function linkItemsOf(rec, c, table) {
  return arr(c.show).filter(okDest).map((d) => {
    const v = linkItem(rec, viaFor(c, d, table), notesFor(c, d));
    if (d.by === 'opus') v.judge = { by: 'opus', ...(d.reason ? { reason: d.reason } : {}) };
    return { lawId: d.lawId, art: d.art, v };
  });
}

// 逆引きのどこに置くか: 今の条の一覧（items）か、今の同じ番号の条の「判決当時は別の規定」の畳む枠（other）か。置かないなら null
//   2026-10-16 の方針（decideShow）からは使わない（畳む枠も作らない）。decideShow を通していない curRefs 用に残す
function placeOf(c) {
  if (linkable(c)) return { lawId: c.lawId, art: c.art, box: 'items' };
  if (c && c.how === 'gone' && Array.isArray(c.at) && LAW_RE.test(String(c.at[0] || '')) && ART_RE.test(String(c.at[1] || ''))) return { lawId: c.at[0], art: c.at[1], box: 'other' };
  return null;
}

const linkable = (c) => c && KEEP.has(c.how) && c.lawId && LAW_RE.test(c.lawId) && typeof c.art === 'string' && ART_RE.test(c.art);

// 07 と同じ links の 1 件（＋付け直した元）
function linkItem(rec, via, notes) {
  const v = {
    id: rec.id,
    title: rec.title || null,
    court: [rec.court, rec.branch].filter(Boolean).join(' ') || null,
    dateJp: rec.dateJp || null,
    caseNo: rec.caseNo || null,
    kekka: rec.kekka || null,
    url: `https://www.courts.go.jp/hanrei/${rec.id}/detail${(rec.detailNs || [])[0] || 2}/index.html`,
  };
  if (via) v.via = via;
  if (notes && notes.length) v.notes = notes;
  const ap = appealOf(rec);
  if (ap) v.appeal = ap;
  return v;
}

// 上告審（最高裁）の結果（2026-10-18 のオーナーの決定）: 今の 3 点一致（裁判所＋事件番号＋日付）の審級リンクでつながった原審の判決にだけ付ける（rec.appeals。
// 検索画面の【審級関係】と同じ）。つながらない判例には何も付けない（データに無いことから確定を推し量らない）。
//   k: haki（破棄自判・破棄差戻など）・kikyaku（棄却）・kyakka（却下）。「その他」は付けない。上告審が複数あれば破棄 → 棄却 → 却下 の順に 1 つ
function appealOf(rec) {
  const aps = arr(rec && rec.appeals).filter((a) => a && /最高裁判所/.test(String(a.court || '')) && /^\d{1,7}$/.test(String(a.id || '')));
  const kind = (a) => (/^破棄/.test(String(a.kekka || '')) ? 'haki' : String(a.kekka || '') === '棄却' ? 'kikyaku' : String(a.kekka || '') === '却下' ? 'kyakka' : null);
  for (const k of ['haki', 'kikyaku', 'kyakka']) {
    const a = aps.find((x) => kind(x) === k);
    if (a) return { k, kekka: String(a.kekka), d: a.dateJp || null, id: String(a.id) };
  }
  return null;
}

// 判決文の「…による改正前」を、今の 03_parse と同じ読み取りで本文から取り直す（before を持たない古い判例用）
//   → (key "lawId|art") => before[] | null
function makeBeforeReader(parse) {
  const lex = parse.buildLexicon();
  return (rec) => {
    const secs = arr(rec.sections);
    const text = secs.map((s) => (s && s.text) || '').join('\n');
    const raw = rec.sanshoRaw || '';
    if (!/改正前/.test(text) && !/改正前/.test(raw)) return null;
    const acc = { refs: new Map(), unresolved: new Map() };
    if (text) parse.extractCitations(text, lex, acc);
    if (raw) parse.extractCitations(raw, lex, acc);
    const m = new Map();
    for (const [k, e] of acc.refs) if (e.before && e.before.length) m.set(k, e.before);
    return m.size ? (k) => m.get(k) || null : null;
  };
}

// 判決文で「旧民法第九百八十六条」「旧刑訴法第四百十一条」のように、今と同じ法令名に「旧」を付けて引いた条を拾う。
//   その条を引いた所が全部「旧」付きのときだけ（同じ判決で今の条としても引いていれば付け直さない）→ (key "lawId|art") => true/false
const ALIASES = { 刑事訴訟法: ['刑訴法'], 民事訴訟法: ['民訴法'], 労働基準法: ['労基法'], 地方自治法: ['自治法'], 国家公務員法: ['国公法'], 地方公務員法: ['地公法'], 日本国憲法: ['憲法'] };
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function makeOldNameReader(parse) {
  const NUMC = '[０-９0-9〇一二三四五六七八九十百千]+';
  return (rec) => {
    const refs = arr(rec.lawRefs).filter((r) => r && r.lawId && r.law);
    if (!refs.length) return null;
    const text = arr(rec.sections).map((x) => (x && x.text) || '').join('\n') + '\n' + (rec.sanshoRaw || '');
    if (!/旧/.test(text)) return null;
    const flags = new Map();   // key → { old, plain }
    for (const lawName of [...new Set(refs.map((r) => r.law))]) {
      const id = refs.find((r) => r.law === lawName).lawId;
      const names = [lawName, ...(ALIASES[lawName] || [])];
      const re = new RegExp(`(旧)?(?:${names.map(escRe).join('|')})(?:[(（][^)）]{0,40}[)）])?第?(${NUMC})条((?:の${NUMC})*)`, 'g');
      for (const m of text.matchAll(re)) {
        const before = text[m.index - 1] || '';
        if (!m[1] && /[一-鿿]/.test(before)) continue;   // 「新民法」「改正民法」など法令名の一部
        const a = parse.normArt(m[2].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/〇/g, '0'), (m[3] || '').replace(/^の/, ''));
        if (!a) continue;
        const k = `${id}|${a}`;
        const f = flags.get(k) || { old: 0, plain: 0 };
        if (m[1]) f.old++; else f.plain++;
        flags.set(k, f);
      }
    }
    const hit = new Set([...flags].filter(([, f]) => f.old > 0 && f.plain === 0).map(([k]) => k));
    return hit.size ? (k) => hit.has(k) : null;
  };
}

module.exports = { nonumNotes, makeStockOnly, noGroundDecision, makeClosingOnly, rewritesOf, rewrittenSince, decideShow, linkItemsOf, viaFor, notesFor, makeOldNameReader, OLD_ELSEWHERE, placeOf, notesOf, noteText, resolveRef, curRefsOf, viaOf, viaText, linkItem, linkable, makeBeforeReader, findPeriod, lastBefore, versionDate, dayBefore, KEEP };
