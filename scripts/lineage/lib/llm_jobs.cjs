// 判例の紐付けを AI で決める仕事（条番号の無い判例の判断した条・改正で書き換えられた条の判断し直し）の共通部品。docs/lineage.md
//   nonum_cases.cjs（判例の週次の後）と judge_cases.cjs（月に 1 回）が使う。¥0 の確かめ（check_judge.cjs）は makeApi の代わりに作り物を渡す。
// 呼ぶのは本番の Worker（/api/select・/api/jev-score・/api/chat の Opus 5.5・/api/articles。バイパスキー）と e-Gov（判決のときの条文）だけ。
// 費用は R2 update_state/lineage_judge_budget/{YYYY-MM}.json の台帳で数える（Jev の 1 日の上限 JEV_DAILY_USD とは別の財布）。
// ログには件数・判例 ID・費用だけを出す（判決文・論点の文を出さない）。
'use strict';

const USD_JPY = 150;
const OPUS_IN = 4, OPUS_OUT = 20;   // $/MTok
const JEV_IN = 0.042;               // $/MTok
const BUDGET_PREFIX = 'update_state/lineage_judge_budget';

const z2h = (s) => String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/(?<=[一二三四五六七八九十百千〇])○|○(?=[一二三四五六七八九〇])/g, '〇').replace(/(?<=[一二三四五六七八九十百千〇])○|○(?=[一二三四五六七八九〇])/g, '〇');
const jst = (d = new Date()) => new Date(d.getTime() + 9 * 3600 * 1000);
const today = () => jst().toISOString().slice(0, 10);
const month = () => jst().toISOString().slice(0, 7);
// ISO 週（日本時間）「2026-W42」
function isoWeek(d = jst()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 本文の扱い（共有ノートの nonum.cjs・llm_pick.cjs と同じ）
// 判決文に「法令名＋第○条」の形があるか（略し方の読み取りでも取れない判例を選ぶのに使う）
const LAWJO = /(?:[一-龥]{1,12}(?:法|令|規則)|刑訴|民訴|刑法|民法|憲法)(?:施行令|施行規則)?(?:第)?(?:\d+|[〇一二三四五六七八九十百千]+)條?条/;
const hasLawArticle = (text) => LAWJO.test(z2h(text).replace(/\s+/g, ''));
// 条番号を伏せる（論点の文から選定が条番号に引っ張られないように）
const stripArticles = (s) => z2h(s)
  .replace(/[一-龥]{1,20}(?:法|令|規則)(?:（[^）]*）)?(?:第)?(?:\d+|[〇一二三四五六七八九十百千]+)条(?:の\d+)*(?:第?\d+項)?/g, '')
  .replace(/(?:第)?(?:\d+|[〇一二三四五六七八九十百千]+)条(?:の\d+)*(?:第?\d+項)?/g, '');
const reasonHead = (t, n = 1500) => { const i = t.indexOf('理由'); const s = i >= 0 ? i + 2 : 0; return t.slice(s, s + n).replace(/\s+/g, ''); };
// 論点の文: 判示事項・要旨。無ければ理由の冒頭 1,500 字（条番号は伏せる）
function issueText(rec, text) {
  const h = `${(rec && rec.hanji) || ''} ${(rec && rec.yoshi) || ''}`.trim();
  return stripArticles(h || reasonHead(text)).trim();
}
// 判決文が 3 万字を超えたら判断の段から 2.8 万字
const JUDGE_HEAD = /(当裁判所の判断|争点に対する判断|争点についての判断|争点に関する判断|本案についての判断|当審の判断|判断の理由|裁判所の判断)/;
function judgePart(rec, t) {
  if (t.length <= 30000) return t;
  if (/最高裁/.test((rec && rec.court) || '')) { const i = Math.max(0, t.indexOf('理由')); return t.slice(i, i + 28000); }
  const m = t.match(JUDGE_HEAD);
  return m ? t.slice(m.index, m.index + 28000) : t.slice(-28000);
}
const cleanText = (t) => z2h(t).replace(/【要旨[^】]*】/g, '').replace(/\s+/g, '');
const parseJsonReply = (text) => { try { return JSON.parse(String(text || '').replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1')); } catch { return null; } };

// ---------------------------------------------------------------- 本番の Worker
function makeApi({ url, key, fetchImpl = fetch, ua = 'joubun-kun-lineage-jobs/1.0', tries = 4 } = {}) {
  if (!url || !key) throw new Error('JUDGE_URL と JUDGE_KEY（本番の Worker とバイパスキー）が要る');
  async function post(p, body) {
    for (let i = 0; ; i++) {
      try {
        const r = await fetchImpl(url.replace(/\/$/, '') + p, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'x-api-key': key, 'user-agent': ua }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
        const t = await r.text();
        if (r.status === 429) { const e = new Error(`HTTP 429 ${p}`); e.budget = true; throw e; }   // Jev の 1 日の上限など
        if (!r.ok) throw new Error(`HTTP ${r.status} ${p}`);
        return JSON.parse(t);
      } catch (e) { if (e.budget || i >= tries) throw e; await new Promise((res) => setTimeout(res, 4000 * (i + 1))); }
    }
  }
  return {
    // 候補の条（本番の /api/select。Jev の上位 7 本・Opus なし）
    async select(question) {
      const s = await post('/api/select', { question: question.slice(0, 1500), flags: { jevNarrowOpus: 0 } });
      const cands = (s.selected || []).map((a) => ({
        law: a.law_id, art: String(a.id || '').split('_Art')[1] || '', title: `${a.law_title || ''}${a.title || ''}`, caption: a.caption || '',
        text: ((a.paragraphs || []).map((p) => (p.sentences || []).map((x) => x.text).join('')).join('')).slice(0, 500),
      })).filter((c) => c.law && c.art);
      return { cands, jpy: Number(s.cost_jpy) || 0 };
    },
    // 判決の全文を 1 回渡して候補ごとに採点（noul: 0〜1）
    async jevScore(rec, text, cands) {
      if (!cands.length) return { scores: {}, usd: 0 };
      const questions = {};
      cands.forEach((c, i) => { questions[`a${i}`] = { type: 'noul', instructions: `この判決は、${c.title}${c.caption}（今の条文: ${c.text}）の解釈や適用について判断しているか。判決が実際に争われた法律上の論点として、この条が定める事柄を論じていれば判断している（判決が条番号を書いていなくてもよい・判決のときの条文が今と違うことがある）。関係の薄い条なら判断していない。`, criteria: { true: 'この条の事柄について判断している', false: '判断していない' } }; });
      const res = await post('/api/jev-score', { items: [{ id: 'x', state: { 判決: `${rec.court || ''} ${rec.dateJp || ''} ${rec.title || ''}`, 判決文: text.slice(0, 60000) } }], questions });
      const ans = (res.results && res.results[0] && res.results[0].answers) || {};
      const scores = {};
      cands.forEach((c, i) => { scores[`${c.law}|${c.art}`] = ans[`a${i}`] ? ans[`a${i}`].noul : null; });
      return { scores, usd: ((res.usage && res.usage.input_tokens) || 0) * JEV_IN / 1e6 };
    },
    // Opus 5.5（本番の Worker の内部とバイパスキーだけ）
    async opus(system, content, maxTokens = 1500) {
      const res = await post('/api/chat', { model: 'opus-5-5', effort: 'low', maxTokens, system, messages: [{ role: 'user', content }] });
      const u = res.usage || {};
      const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      return { text: ((res.content || []).find((c) => c.type === 'text') || {}).text || '', usd: (input * OPUS_IN + (u.output_tokens || 0) * OPUS_OUT) / 1e6 };
    },
    // 今の条文（無ければ null）。id は「法令ID_Art条キー（枝番は _）」
    async article(lawId, art) {
      const id = `${lawId}_Art${String(art).replace(/の/g, '_')}`;
      const r = await post('/api/articles', { articleIds: [id] });
      const a = (r.results || []).find((x) => x && x.id === id);
      if (!a || !a.article || !(a.article.paragraphs || []).length) return null;
      const text = (a.article.paragraphs || []).map((p) => (p.sentences || []).map((x) => x.text).join('')).join('');
      return { law: lawId, art: String(art).replace(/_/g, 'の'), title: `${a.law_title || ''}${a.article.title || ''}`, caption: a.article.caption || '', text: text.slice(0, 600) };
    },
  };
}

// e-Gov の版（判決のときの条文。無ければ null）。asof は YYYY-MM-DD
async function egovArticleAsof(lawId, art, asof, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://laws.e-gov.go.jp/api/2/law_file/xml/${lawId}?asof=${asof}`, { headers: { 'user-agent': 'joubun-kun-lineage-jobs/1.0' }, signal: AbortSignal.timeout(120000) });
    if (!r.ok) return null;
    const x = await r.text();
    const main = (x.match(/<MainProvision[\s\S]*?<\/MainProvision>/) || [''])[0];
    const num = String(art).replace(/の/g, '_');
    const m = main.match(new RegExp(`<Article Num="${num}"[^>]*>([\\s\\S]*?)</Article>`));
    return m ? m[1].replace(/<ArticleCaption>[^<]*<\/ArticleCaption>|<ArticleTitle>[^<]*<\/ArticleTitle>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '').slice(0, 1500) : null;
  } catch { return null; }
}

// 系譜の組み立ての途中の本文の控え（scripts/lineage/texts.py の out/texts/{法令ID}.json・R2 lineage_v1/texts/）から、ver の日の条文。
// 無ければ null。控えは e-Gov の一番古い版（asof）まで（旧法は最後の日まで）。日の同じ控えは後のもの（後に当てた改正）
function textAt(doc, art, ver) {
  const h = doc && doc.arts && doc.arts[String(art).replace(/の/g, '_')];
  if (!h || !ver) return null;
  let got;
  for (const [d, t] of h) if (d <= ver && (!got || d >= got[0])) got = [d, t];
  if (!got || !got[1]) return null;
  // 頭の「第十八条」は組み立ての元の番号のまま（番号を付け替えても本文は書き換えない）なので、e-Gov の版と同じく外す（見出しは残す）
  return got[1].replace(/\s+/g, '').replace(ART_HEAD, '$1').slice(0, 1500) || null;
}
const ART_HEAD = /^((?:（[^）]{0,60}）)?)第[〇一二三四五六七八九十百千]+[条條](?:[のノ][〇一二三四五六七八九十百千]+)*/;

/**
 * 判決のときの条文 → { text, src: 'lineage' | 'egov' | null, approx }
 * 系譜の控えの範囲（旧法・asof までの判決）は控えから、それより後（2017 年ごろ以降）は e-Gov の版から。旧法は e-Gov に無いので控えだけ
 * @param {{lawId,art,ver,old}} from @param {string} dateIso 判決の日（ver が無いとき） @param {(lawId)=>Promise<object|null>} loadTexts
 */
async function articleAtJudgment(from, dateIso, loadTexts, fetchImpl = fetch) {
  if (!from || !from.lawId || !from.art) return { text: null, src: null };
  const ver = from.ver || dateIso;
  const doc = await loadTexts(from.lawId);
  if (doc && (from.old || !doc.asof || ver <= doc.asof)) {
    const t = textAt(doc, from.art, ver);
    // approx: 答え合わせで e-Gov の版と大きく違った条（途中の改正の一部が当たっていない。texts.py の low）
    if (t) return { text: t, src: 'lineage', approx: (doc.low || []).includes(String(from.art).replace(/の/g, '_')) };
  }
  if (from.old) return { text: null, src: null };
  const t = await egovArticleAsof(from.lawId, from.art, ver, fetchImpl);
  return { text: t, src: t ? 'egov' : null };
}

// ---------------------------------------------------------------- 費用の台帳（R2・月ごと）
async function loadBudget(r2) {
  const key = `${BUDGET_PREFIX}/${month()}.json`;
  const got = await r2.getWithEtag(key);
  const doc = got ? JSON.parse(got.body.toString('utf8')) : { month: month(), nonum: { jpy: 0, cases: 0, weeks: {} }, judge: { usd: 0, items: 0, runs: {} } };
  return { key, etag: got ? got.etag : null, doc };
}
async function saveBudget(r2, b) {
  const ok = await r2.putIfMatch(b.key, JSON.stringify(b.doc), b.etag);
  if (!ok) throw new Error(`費用の台帳 ${b.key} が書き込みの間に変わった（同時に動いている）。書かずに止める`);
}

module.exports = {
  USD_JPY, BUDGET_PREFIX, z2h, today, month, isoWeek, LAWJO, hasLawArticle, stripArticles, reasonHead, issueText, judgePart, cleanText, parseJsonReply,
  makeApi, egovArticleAsof, textAt, articleAtJudgment, loadBudget, saveBudget,
};
