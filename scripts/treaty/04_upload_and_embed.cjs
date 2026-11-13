// 04: 条約データを R2（treaty/v1/ 新prefix・Blue-Green）へアップロードし、
//     Vectorize（tsutatsu-embeddings-v1 の新namespace "_treaty"）へ埋め込む。
//     既存のR2 prefix / namespaceには一切触れない。
//
//   node scripts/treaty/04_upload_and_embed.cjs --dry      # 対象数のみ
//   node scripts/treaty/04_upload_and_embed.cjs            # R2 + 埋め込み
//   node scripts/treaty/04_upload_and_embed.cjs --embed    # 埋め込みのみ
//   node scripts/treaty/04_upload_and_embed.cjs --r2       # R2のみ

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const SITE = require('../site_config.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE = path.join(__dirname, 'state');
const ACCT = SITE.cfAccountId;
const BUCKET = 'joubun-kun-data';
const PREFIX = 'treaty/v1';
const ENDPOINT = `https://${ACCT}.r2.cloudflarestorage.com`;
const WORKER = process.env.WORKER_URL || SITE.workerUrls.staging;
const KEY = process.env.BYPASS_KEY;   // 秘密はリポジトリに書かない（環境変数だけ）
if (!KEY && !process.argv.includes('--dry')) { console.error('BYPASS_KEY を環境変数で渡してください'); process.exit(1); }
const BATCH = 20, NS = '_treaty';

function loadDotenv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

function slugOf(country) {
  return crypto.createHash('md5').update(country).digest('hex').slice(0, 8);
}

(async () => {
  const dry = process.argv.includes('--dry');
  const onlyEmbed = process.argv.includes('--embed');
  const onlyR2 = process.argv.includes('--r2');
  const data = JSON.parse(fs.readFileSync(path.join(STATE, 'treaty_articles_capped.json'), 'utf8'));

  // 表示名・種別を確定
  const countries = data.map((t) => {
    const title = t.treaty_title || '';
    const kind = (/情報の交換/.test(title) && !/二重課税/.test(title)) ? '情報交換協定'
      : /条約/.test(title) ? '租税条約' : '租税協定';
    const short = `日・${t.country}${kind}`;
    return { ...t, kind, short, slug: slugOf(t.country) };
  });
  const nArts = countries.reduce((s, t) => s + t.articles.length, 0);
  console.log(`対象: ${countries.length}か国 ${nArts}条 → r2://${BUCKET}/${PREFIX}/ + Vectorize ns ${NS}`);
  if (dry) {
    countries.slice(0, 5).forEach((t) => console.log(`  ${t.short} (${t.slug}) ${t.articles.length}条 ${t.doc_type}`));
    return;
  }

  // ---- R2 ----
  if (!onlyEmbed) {
    loadDotenv(path.join(REPO_ROOT, '.env'));
    const s3 = new S3Client({
      region: 'auto', endpoint: ENDPOINT,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
    const index = {
      version: 1,
      countries: countries.map((t) => ({
        c: t.country, slug: t.slug, kind: t.kind, short: t.short,
        title: t.treaty_title, src: t.source_url, doc_type: t.doc_type,
        n: t.articles.length, ...(t.note ? { note: t.note } : {}),
      })),
    };
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: `${PREFIX}/index.json`,
      Body: JSON.stringify(index), ContentType: 'application/json',
    }));
    let up = 0;
    for (const t of countries) {
      const body = JSON.stringify({
        country: t.country, title: t.treaty_title, short: t.short, kind: t.kind,
        src: t.source_url, doc_type: t.doc_type, ...(t.note ? { note: t.note } : {}),
        articles: t.articles,
      });
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: `${PREFIX}/${t.slug}.json`, Body: body, ContentType: 'application/json',
      }));
      up++;
      process.stdout.write(`\r  R2: ${up}/${countries.length}`);
    }
    console.log('\n  R2アップロード完了 (index + ' + up + 'ファイル)');
  }

  // ---- Vectorize ----
  if (!onlyR2) {
    const items = [];
    for (const t of countries) {
      for (const a of t.articles) {
        const label = a.no === 0 ? '議定書等' : `第${a.no}条`;
        items.push({
          id: `tr_${t.slug}_${a.no}`,
          ns: NS,
          text: `${t.short} ${label}（${a.cap || ''}） ${(a.body || '').slice(0, 1200)}`,
          metadata: {
            c: t.country, s: t.slug, no: String(a.no), cap: (a.cap || '').slice(0, 60),
            t: t.short, src: t.source_url, b: (a.body || '').slice(0, 350),
          },
        });
      }
    }
    let ok = 0, ng = 0;
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      try {
        const res = await fetch(`${WORKER}/api/admin/embed-tsutatsu`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
          body: JSON.stringify({ items: batch }),
        });
        const j = await res.json();
        if (res.ok && j.upserted) ok += j.upserted; else { ng += batch.length; console.log('\n NG', res.status, JSON.stringify(j).slice(0, 120)); }
      } catch (e) { ng += batch.length; console.log('\n ERR', e.message); }
      process.stdout.write(`\r  embed: ${Math.min(i + BATCH, items.length)}/${items.length}  登録${ok} 失敗${ng}`);
    }
    console.log('\n  埋め込み完了');
  }
})();
