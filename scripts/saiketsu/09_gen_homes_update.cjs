// 09: 事例・裁決の homes を新リンク（article_links_v1）に揃える更新ファイルを作る。
//     Vectorize には書き込まない。出力は通達の homes 更新と同じ NDJSON(.gz)。
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const SITE = require('../site_config.cjs');
const REPO=path.join(__dirname,'..','..');
const STATE=path.join(REPO,'scripts','tsutatsu','state');
const OUT=path.join(REPO,'docs','benchmarks','tax_ab','data');
const ACCT=process.env.CF_ACCOUNT_ID||SITE.cfAccountId;
const TOKEN=process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してから流してください（値は表示しない）'); process.exit(1); }
const H={Authorization:`Bearer ${TOKEN}`};
const D9='〇一二三四五六七八九';
function ik(n){n=parseInt(n,10);if(!n)return '〇';const th=~~(n/1000),hu=~~(n%1000/100),te=~~(n%100/10),on=n%10;let s='';if(th)s+=(th>1?D9[th]:'')+'千';if(hu)s+=(hu>1?D9[hu]:'')+'百';if(te)s+=(te>1?D9[te]:'')+'十';if(on)s+=D9[on];return s;}
const j2t=j=>{const p=String(j).split('の');let t='第'+ik(p[0])+'条';for(let i=1;i<p.length;i++)t+='の'+ik(p[i]);return t;};
const src=fs.readFileSync(path.join(REPO,'src','lawIds.js'),'utf8');
const NAME=JSON.parse(src.slice(src.indexOf('{'),src.lastIndexOf('}')+1));
const ID2NAME={};for(const [n,i] of Object.entries(NAME)) if(!ID2NAME[i])ID2NAME[i]=n;
const r2=async k=>{const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects/${encodeURIComponent(k)}`,{headers:H});return r.ok?r.json():null;};
async function keys(p){const o=[];let c=null;do{const u=new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/r2/buckets/joubun-kun-data/objects`);u.searchParams.set('prefix',p);u.searchParams.set('per_page','1000');if(c)u.searchParams.set('cursor',c);const j=await(await fetch(u,{headers:H})).json();if(!j.success)break;o.push(...(j.result||[]).map(x=>x.key));c=(j.result_info||{}).cursor||null;}while(c);return o;}
(async()=>{
 // 新リンク: sid -> homes 配列（順序は law_id, 条番号 の昇順で決定的に）
 const neu={j:new Map(),s:new Map()};
 for(const k of await keys('article_links_v1/')){const lid=path.basename(k,'.json');if(lid==='_cases')continue;const d=await r2(k);if(!d)continue;
   for(const [jou,hits] of Object.entries(d)) for(const h of hits){
     const m=h.k==='j'?neu.j:h.k==='s'?neu.s:null;if(!m)continue;
     if(!m.has(h.i))m.set(h.i,new Map());
     m.get(h.i).set(`${lid}:${jou}`,{l:lid,n:ID2NAME[lid]||lid,a:j2t(jou)});}}
 const homesOf=(kind,sid)=>{const m=neu[kind].get(sid);if(!m)return [];
   return [...m.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(x=>x[1]);};
 const stats={事例:0,裁決要旨:0,裁決節:0},skip={事例:0,裁決要旨:0,裁決節:0};
 const rows=[];
 const files=[['vec_backup_shitsugi.ndjson','j','事例'],['vec_backup_saiketsu.ndjson','s','裁決要旨'],['vec_backup_saiketsu_sec.ndjson','s','裁決節']];
 for(const [f,kind,lbl] of files){
   for(const l of fs.readFileSync(path.join(STATE,f),'utf8').split('\n')){
     if(!l)continue;let v;try{v=JSON.parse(l)}catch{continue}
     const sid=(v.metadata||{}).sid;if(!sid){skip[lbl]++;continue}
     const nh=JSON.stringify(homesOf(kind,sid));
     if((v.metadata||{}).homes===nh){skip[lbl]++;continue}
     // values は入れない。local_vec_v3.py homes-apply が --backup 側から取る設計
     rows.push({id:v.id,namespace:v.namespace,metadata:{...v.metadata,homes:nh}});
     stats[lbl]++;
   }}
 const p=path.join(OUT,'vec_homes_update_cases_b.ndjson');
 fs.writeFileSync(p,rows.map(o=>JSON.stringify(o)).join('\n')+'\n');
 zlib.gzipSync;
 fs.writeFileSync(p+'.gz',zlib.gzipSync(fs.readFileSync(p)));fs.unlinkSync(p);
 console.log('更新対象（homes が新リンクと違うものだけ）');
 for(const k of Object.keys(stats)) console.log(`  ${k.padEnd(6)} ${String(stats[k]).padStart(6)}本  （変更不要 ${skip[k]}本）`);
 console.log(`  合計 ${rows.length}本 → docs/benchmarks/tax_ab/data/vec_homes_update_cases_b.ndjson.gz (${(fs.statSync(p+'.gz').size/1e6).toFixed(1)}MB)`);
 // 検証: homes 以外が同一か
 const bk=new Map();
 for(const [f] of files) for(const l of fs.readFileSync(path.join(STATE,f),'utf8').split('\n')){if(!l)continue;try{const v=JSON.parse(l);bk.set(v.id,v)}catch{}}
 let ng=0,checked=0;
 for(const r of rows){const b=bk.get(r.id);if(!b){ng++;continue}
   if(b.namespace!==r.namespace)ng++;
   else{const a={...b.metadata};delete a.homes;const c={...r.metadata};delete c.homes;
     if(JSON.stringify(a)!==JSON.stringify(c))ng++;}
   checked++;}
 console.log(`\n検証: homes 以外（id・namespace・values・metadata）がバックアップと同一か → ${checked}本中 不一致 ${ng}本`);
 const s=rows[0];
 console.log(`\n1本目の確認: id=${s.id} namespace=${s.namespace}（values は入れない＝homes-apply がバックアップから取る）`);
 console.log(`  homes(旧): ${String((bk.get(s.id).metadata||{}).homes).slice(0,110)}`);
 console.log(`  homes(新): ${s.metadata.homes.slice(0,110)}`);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
