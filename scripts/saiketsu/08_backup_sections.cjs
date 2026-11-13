// 08: 裁決の節ベクトル（saiketsu:{id}#s{i}）をバックアップする（読み取りのみ）。
//   R2 の sections 件数は埋め込み時の units 件数と一致しないので、i を 0..N まで
//   総当たりして実在するものを拾う。
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const SITE = require('../site_config.cjs');
const REPO=path.join(__dirname,'..','..');
const OUT=path.join(REPO,'scripts','tsutatsu','state');
const ACCT=process.env.CF_ACCOUNT_ID||SITE.cfAccountId;
const TOKEN=process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const H={Authorization:`Bearer ${TOKEN}`};
const IDX='tsutatsu-embeddings-v1';
const MAXI=parseInt(process.env.MAXI||'12',10);
const md5=s=>crypto.createHash('md5').update(s).digest('hex');
const r2=async k=>{const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/${encodeURIComponent(k)}`,{headers:H});return r.ok?r.json():null;};
async function keys(p){const o=[];let c=null;do{const u=new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects`);u.searchParams.set('prefix',p);u.searchParams.set('per_page','1000');if(c)u.searchParams.set('cursor',c);const j=await(await fetch(u,{headers:H})).json();if(!j.success)break;o.push(...(j.result||[]).map(x=>x.key));c=(j.result_info||{}).cursor||null;}while(c);return o;}
async function get(ids){for(let a=0;a<5;a++){try{const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/vectorize/v2/indexes/${IDX}/get_by_ids`,{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({ids})});const j=await r.json();if(j.success)return j.result||[];if(a===4)throw new Error(JSON.stringify(j.errors).slice(0,140));}catch(e){if(a===4)throw e;}await new Promise(s=>setTimeout(s,800*2**a));}return[];}
(async()=>{
 const cands=[];
 for(const k of await keys('saiketsu_v1/cases_')){const d=await r2(k);if(!d)continue;
   for(const id of Object.keys(d)) for(let i=0;i<MAXI;i++) cands.push(md5(`saiketsu:${id}#s${i}`));}
 console.log(`探索する節ベクトル候補: ${cands.length}本（1裁決あたり i=0..${MAXI-1}）`);
 const out=fs.createWriteStream(path.join(OUT,'vec_backup_saiketsu_sec.ndjson'));
 let found=0;
 for(let i=0;i<cands.length;i+=20){
   for(const v of await get(cands.slice(i,i+20))){out.write(JSON.stringify(v)+'\n');found++;}
   if((i/20)%200===0)process.stdout.write(`\r  ${i}/${cands.length} 実在${found}`);
 }
 out.end();
 console.log(`\r  ${cands.length}/${cands.length} 実在${found}                    `);
 console.log(`→ scripts/tsutatsu/state/vec_backup_saiketsu_sec.ndjson`);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
