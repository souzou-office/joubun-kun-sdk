// e-Gov 法令 API v2（https://laws.e-gov.go.jp/api/2）の読み取り。
//   fetchAllLaws()      現行法令の一覧（改正 ID つき）。01/02 と同じ条件 repeal_status=None
//   fetchLawXml(lawId)  現行版の法令 XML（一括ダウンロードと同じ <Law> 形式）
const { CONFIG, sleep, retry, log } = require('./common.cjs');

const LIMIT = 100;
const SLEEP_MS = Number(process.env.EGOV_SLEEP_MS || 200);

function extractLawEntry(law) {
  const info = law.law_info || {};
  const rev = law.current_revision_info || law.revision_info || {};
  return {
    law_revision_id: rev.law_revision_id || null,
    law_title: rev.law_title || info.law_title || null,
    law_type: info.law_type || null,
    law_num: info.law_num || null,
    amendment_promulgate_date: rev.amendment_promulgate_date || null,
    amendment_enforcement_date: rev.amendment_enforcement_date || null,
    updated: rev.updated || info.updated || null,
    revision_status: rev.current_revision_status || null,   // 'CurrentEnforced' / 'UnEnforced' など（未施行の新法は law_id では本文が取れない）
    // 条文の公開ページの法令検索・分野別一覧用（2026-09-24。足しただけで、差分の判定には使わない）
    abbrev: rev.abbrev || null,       // 略称（カンマ区切り。例「区分所有法,マンション法」）
    category: rev.category || null,   // e-Gov の分類（例「民事」「国税」）
  };
}

async function fetchJson(url) {
  return retry(async () => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }, { tries: 5, baseMs: 800, label: 'e-Gov' });
}

// 全法令の一覧。返却 { fetched_at, total_count, laws: { law_id: entry } }
async function fetchAllLaws({ onPage } = {}) {
  const laws = {};
  let offset = 0, total = null, page = 0;
  for (;;) {
    page++;
    const data = await fetchJson(`${CONFIG.egovApiBase}/laws?limit=${LIMIT}&offset=${offset}&response_format=json&repeal_status=None`);
    if (total === null) total = data.total_count;
    for (const law of data.laws || []) {
      const lawId = law.law_info && law.law_info.law_id;
      if (lawId) laws[lawId] = extractLawEntry(law);
    }
    if (onPage) onPage(page, offset, total);
    if (!data.next_offset || data.next_offset <= offset) break;
    offset = data.next_offset;
    await sleep(SLEEP_MS);
  }
  return { fetched_at: new Date().toISOString(), total_count: total, laws };
}

// 1 法令の一覧エントリ（改正 ID の確認用）
async function fetchLawEntry(lawId) {
  const data = await fetchJson(`${CONFIG.egovApiBase}/laws?limit=1&response_format=json&law_id=${encodeURIComponent(lawId)}`);
  const law = (data.laws || [])[0];
  return law ? extractLawEntry(law) : null;
}

// 1 法令の廃止の状態（廃止された法令を R2・Vectorize から消す前の確かめ・05_diff.cjs）。
// 返却 { repeal_status: 'None' | 'Repeal' | 'Expire' など, repeal_date, law_title }。e-Gov に無ければ null。
// 確かめ用に EGOV_FAKE_STATUS_FILE（{ law_id: { repeal_status, repeal_date, law_title } } の JSON）を読む
async function fetchLawStatus(lawId) {
  if (process.env.EGOV_FAKE_STATUS_FILE) {
    const m = JSON.parse(require('fs').readFileSync(process.env.EGOV_FAKE_STATUS_FILE, 'utf8'));
    if (m[lawId] === '__fail__') throw new Error(`HTTP 503 (fake) ${lawId}`);
    return m[lawId] || null;
  }
  const data = await fetchJson(`${CONFIG.egovApiBase}/laws?limit=1&response_format=json&law_id=${encodeURIComponent(lawId)}`);
  const law = (data.laws || [])[0];
  if (!law) return null;
  const rev = law.current_revision_info || law.revision_info || {};
  return { repeal_status: rev.repeal_status || null, repeal_date: rev.repeal_date || null, law_title: rev.law_title || (law.law_info || {}).law_title || null };
}

// 現行版の XML 本文（文字列）。asof を渡すとその日時点の版
async function fetchLawXml(lawId, { asof } = {}) {
  const url = `${CONFIG.egovApiBase}/law_file/xml/${encodeURIComponent(lawId)}${asof ? `?asof=${asof}` : ''}`;
  return retry(async () => {
    const res = await fetch(url);
    if (!res.ok) { const e = new Error(`HTTP ${res.status} law_file ${lawId}`); if (res.status === 404) e.noRetry = true; throw e; }
    const text = await res.text();
    if (!/<Law[\s>]/.test(text.slice(0, 2000))) throw new Error(`XML らしくない応答 ${lawId}`);
    return text;
  }, { tries: 5, baseMs: 1000, label: `law_file ${lawId}` });
}

module.exports = { fetchAllLaws, fetchLawEntry, fetchLawStatus, fetchLawXml, extractLawEntry, SLEEP_MS, log };
