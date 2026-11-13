// 10: homes 適用後の状態を Vectorize に直接聞いて確認する（読み取りのみ）。
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const SITE = require('../site_config.cjs');
const REPO=path.join(__dirname,'..','..');
const STATE=path.join(REPO,'scripts','tsutatsu','state');
const DATA=path.join(REPO,'docs','benchmarks','tax_ab','data');
const ACCT=process.env.CF_ACCOUNT_ID||SITE.cfAccountId;
const TOKEN=process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const H={Authorization:`Bearer ${TOKEN}`};
const IDX='tsutatsu-embeddings-v1';
async function get(ids){for(let a=0;a<5;a++){try{const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/vectorize/v2/indexes/${IDX}/get_by_ids`,{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({ids})});const j=await r.json();if(j.success)return j.result||[];if(a===4)throw new Error(JSON.stringify(j.errors).slice(0,140));}catch(e){if(a===4)throw e;}await new Promise(s=>setTimeout(s,800*2**a));}return[];}
(async()=>{
 const upd=new Map();
 for(const l of zlib.gunzipSync(fs.readFileSync(path.join(DATA,'vec_homes_update_cases_b.ndjson.gz'))).toString('utf8').split('\n')){
   if(!l)continue;const o=JSON.parse(l);upd.set(o.id,o);}
 const bk=new Map();
 for(const f of ['vec_backup_shitsugi.ndjson','vec_backup_saiketsu.ndjson','vec_backup_saiketsu_sec.ndjson'])
   for(const l of fs.readFileSync(path.join(STATE,f),'utf8').split('\n')){if(!l)continue;try{const v=JSON.parse(l);bk.set(v.id,v)}catch{}}
 console.log(`更新ファイル ${upd.size}本 / バックアップ ${bk.size}本`);
 // 抜き取り: 種類ごとに20本
 const pick={事例:[],裁決要旨:[],裁決節:[]};
 for(const [id,o] of upd){
   const b=bk.get(id);if(!b)continue;
   const k=o.namespace==='_shitsugi'?'事例':((b.metadata||{}).sec==='裁決要旨'?'裁決要旨':'裁決節');
   if(pick[k].length<20)pick[k].push(id);
 }
 let ok=0,ngHomes=0,ngNs=0,ngMeta=0,miss=0;
 for(const [k,ids] of Object.entries(pick)){
   let a=0,b2=0;
   for(let i=0;i<ids.length;i+=20){
     for(const v of await get(ids.slice(i,i+20))){
       const u=upd.get(v.id),bb=bk.get(v.id);
       if(!u){miss++;continue}
       if((v.metadata||{}).homes!==u.metadata.homes){ngHomes++;continue}
       if(v.namespace!==bb.namespace){ngNs++;continue}
       const x={...(v.metadata||{})},y={...(bb.metadata||{})};delete x.homes;delete y.homes;
       if(JSON.stringify(x)!==JSON.stringify(y)){ngMeta++;continue}
       ok++;a++;
     }}
   console.log(`  ${k}: ${ids.length}本中 ${a}本が一致`);
 }
 console.log(`抜き取り計: 一致 ${ok} / homes不一致 ${ngHomes} / namespace不一致 ${ngNs} / 他metadata不一致 ${ngMeta} / 取得できず ${miss}`);
 // 全件
 const all=[...bk.keys()];
 let empty=0,mism=0,got=0;
 const out=fs.createWriteStream(path.join(STATE,'vec_after_apply_cases.ndjson'));
 for(let i=0;i<all.length;i+=20){
   for(const v of await get(all.slice(i,i+20))){
     got++;out.write(JSON.stringify(v)+'\n');
     const h=(v.metadata||{}).homes;
     if(!h||h==='[]')empty++;
     const u=upd.get(v.id);
     if(u&&h!==u.metadata.homes)mism++;
   }
   if((i/20)%200===0)process.stdout.write(`\r  全件 ${i}/${all.length}`);
 }
 out.end();
 console.log(`\r  全件 ${all.length}/${all.length} 取得${got}                    `);
 console.log(`全件: homes 空 ${empty}件 / 更新ファイルと不一致 ${mism}件`);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
