// ベクトル ID とベクトル化テキストの生成。scripts/rebuild/lib/ids.py と 03_prepare_embedding_inputs.py の移植。
// **ID が 1 文字でも変わると既存ベクトルと別物になる**ので、変えるときは check_vector_ids.cjs（Python との一致検査）を通す。
const { md5 } = require('./common.cjs');

const VECTORIZE_ID_MAX_BYTES = 64;
const UNSAFE = /[\s\x00-\x1f\x7f]/g;   // Python の [\s\x00-\x1f\x7f]（\s は全角空白も含む）
const byteLen = (s) => Buffer.byteLength(s, 'utf8');
const sanitize = (s) => String(s == null ? '' : s).replace(UNSAFE, '');

function makeVectorId(lawId, articleTitle, paragraphNum, caption = '') {
  lawId = sanitize(lawId); articleTitle = sanitize(articleTitle); paragraphNum = sanitize(paragraphNum);
  const short = `${lawId}_${articleTitle}_${paragraphNum}`;
  if (byteLen(short) <= VECTORIZE_ID_MAX_BYTES && !caption) return short;
  const articleHash = md5(articleTitle).slice(0, 10);
  const captionHash = caption ? md5(caption).slice(0, 8) : '00000000';
  const hashed = `${lawId}_a${articleHash}_c${captionHash}_${paragraphNum}`;
  if (byteLen(hashed) <= VECTORIZE_ID_MAX_BYTES) return hashed;
  const lawHash = md5(lawId).slice(0, 12);
  return `l${lawHash}_a${articleHash}_c${captionHash}_${paragraphNum}`;
}

// 同じ ID が出たら _2, _3 … を付ける（Python の IdAllocator と同じ）
class IdAllocator {
  constructor() { this.counts = new Map(); }
  allocate(lawId, articleTitle, paragraphNum, caption = '') {
    const base = makeVectorId(lawId, articleTitle, paragraphNum, caption);
    const count = this.counts.get(base) || 0;
    this.counts.set(base, count + 1);
    if (count === 0) return base;
    const suffix = `_${count + 1}`;
    const maxBase = VECTORIZE_ID_MAX_BYTES - byteLen(suffix);
    if (byteLen(base) <= maxBase) return base + suffix;
    let buf = Buffer.from(base, 'utf8').subarray(0, maxBase);
    while (buf.length && (buf[buf.length - 1] & 0xC0) === 0x80) buf = buf.subarray(0, buf.length - 1);
    return buf.toString('utf8') + suffix;
  }
}

function collectSubitem(sub, parts) {
  if (sub.subitem_title) parts.push(sub.subitem_title);
  for (const s of sub.sentences || []) if (s.text) parts.push(s.text);
  for (const c of sub.sub_items || []) collectSubitem(c, parts);
}
function collectParagraphTexts(p) {
  const parts = [];
  for (const s of p.sentences || []) if (s.text) parts.push(s.text);
  for (const it of p.items || []) {
    if (it.item_title) parts.push(it.item_title);
    for (const s of it.sentences || []) if (s.text) parts.push(s.text);
    for (const sub of it.sub_items || []) collectSubitem(sub, parts);
  }
  return parts.join(' ');
}
const DEFAULT_MAX_TEXT_LENGTH = 6000;
function buildEmbeddingText(lawTitle, articleTitle, caption, paragraph, maxLength = DEFAULT_MAX_TEXT_LENGTH) {
  const body = collectParagraphTexts(paragraph);
  const parts = [lawTitle, articleTitle];
  if (caption) parts.push(caption);
  if (body) parts.push(body);
  let text = parts.filter(Boolean).join(' ');
  // Python の text[:max_length] は文字（コードポイント）単位
  if (text.length > maxLength) text = Array.from(text).slice(0, maxLength).join('');
  return text;
}

// 1 法令分の条文ファイル群 → ベクトル入力 [{ id, text, metadata }]
// files: { filename: parsedJson }（_index.json は含めない）。Python と同じくファイル名の昇順で処理する
function paragraphRecords(lawId, files, maxLength = DEFAULT_MAX_TEXT_LENGTH) {
  const alloc = new IdAllocator();
  const out = [];
  for (const filename of Object.keys(files).sort()) {
    const data = files[filename];
    const lawTitle = data.law_title || '';
    for (const article of data.articles || []) {
      const title = article.title || '';
      const caption = article.caption || '';
      for (const para of article.paragraphs || []) {
        const paraNum = para.num != null ? String(para.num) : '1';
        const text = buildEmbeddingText(lawTitle, title, caption, para, maxLength);
        if (!text.trim()) continue;
        const id = alloc.allocate(lawId, title, paraNum, caption);
        out.push({ id, text, metadata: { law_id: lawId, law_title: lawTitle, article_title: title, article_caption: caption, paragraph_num: paraNum } });
      }
    }
  }
  return out;
}

module.exports = { makeVectorId, IdAllocator, buildEmbeddingText, paragraphRecords, DEFAULT_MAX_TEXT_LENGTH };
