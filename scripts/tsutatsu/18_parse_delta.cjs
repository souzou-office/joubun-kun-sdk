// 18: 03_parse.cjs の修正で通達が何本増え、何本減ったかを同一スナップショットで測る。
//     比較対象は git HEAD 版と作業ツリー版。どちらも本物のソースから作る（写しは書かない）。
//   node scripts/tsutatsu/18_parse_delta.cjs [--ref HEAD]
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const REPO=path.join(__dirname,'..','..');
function build(src,tag){
  src=src.replace(/\nmain\(\);\s*$/,'\n')+'\nmodule.exports={extractContent,parseItems};\n';
  const m=new module.constructor();m._compile(src,path.join(__dirname,`03_parse.__${tag}.cjs`));return m.exports;
}
function walk(d,o=[]){if(!fs.existsSync(d))return o;
 for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isDirectory())walk(p,o);else if(/\.html?$/i.test(e.name))o.push(p);}return o;}
const ref=process.argv.includes('--ref')?process.argv[process.argv.indexOf('--ref')+1]:'HEAD';
const OLD=build(execFileSync('git',['show',`${ref}:scripts/tsutatsu/03_parse.cjs`],{cwd:REPO,maxBuffer:64e6}).toString(),'old');
const NEW=build(fs.readFileSync(path.join(__dirname,'03_parse.cjs'),'utf8'),'new');
const stamp=fs.readdirSync(REPO).filter(x=>/^all_tsutatsu_\d{8}$/.test(x)).sort().pop();
const dir=path.join(REPO,stamp);
let o=0,n=0,zo=0,zn=0,changed=0,lostTot=0;
const gainT={},lostT={},ex=[],lostEx=[];
// 【衝突指標】同じページ内で異なる通達が同じ番号に潰れている件数。
// 本数の増減だけ見ていたため「36・37共-1」が全部「36」に潰れる欠陥を見逃した。
// 番号が一意でなければ、その後の割当・表示は必ず壊れる。
const collide=(list)=>{const c={};list.forEach(x=>c[x]=(c[x]||0)+1);
  return Object.values(c).reduce((s,v)=>s+(v>1?v-1:0),0);};
let colO=0,colN=0;const colEx=[];
for(const f of walk(dir)){
  const html=fs.readFileSync(f,'utf8');
  const co=OLD.extractContent(html), cn=NEW.extractContent(html);
  const a=co?OLD.parseItems(co).map(x=>x.tsutatsu_no):[];
  const b=cn?NEW.parseItems(cn).map(x=>x.tsutatsu_no):[];
  o+=a.length;n+=b.length; if(!a.length)zo++; if(!b.length)zn++;
  const ca=collide(a),cb=collide(b); colO+=ca; colN+=cb;
  if(cb>0&&colEx.length<8)colEx.push(`${path.relative(dir,f)}  衝突 ${ca}→${cb}  [${b.filter((x,i)=>b.indexOf(x)!==i).slice(0,4).join(', ')}]`);
  const as=new Set(a),bs=new Set(b);
  const g=b.filter(x=>!as.has(x)),l=a.filter(x=>!bs.has(x));
  if(!g.length&&!l.length)continue;
  changed++;lostTot+=l.length;
  const t=path.relative(dir,f).split(path.sep).slice(0,2).join('/');
  gainT[t]=(gainT[t]||0)+g.length; if(l.length)lostT[t]=(lostT[t]||0)+l.length;
  if(g.length&&ex.length<10)ex.push(`${path.relative(dir,f)}  ${a.length}→${b.length}  +[${g.slice(0,5).join(', ')}]`);
  if(l.length&&lostEx.length<10)lostEx.push(`${path.relative(dir,f)}  ${a.length}→${b.length}  -[${l.slice(0,6).join(', ')}]`);
}
console.log(`${stamp}: ${walk(dir).length}ページ`);
console.log(`  通達の抽出数        ${o} → ${n}   (+${n-o})`);
console.log(`  1件も取れないページ  ${zo} → ${zn}`);
console.log(`  結果が変わったページ ${changed}`);
console.log(`  ★失った通達         ${lostTot}本 ${lostTot?JSON.stringify(lostT):'（なし）'}`);
console.log(`  ★同一ページ内の番号衝突 ${colO} → ${colN}本`);
if(colEx.length){console.log('  衝突が残るページ:');colEx.forEach(e=>console.log('    '+e));}
console.log('\n  税目別の救出:');
Object.entries(gainT).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`    ${k.padEnd(24)} +${v}`));
console.log('\n  救出例:');ex.forEach(e=>console.log('    '+e));
if(lostEx.length){console.log('\n  ⚠️ 喪失例:');lostEx.forEach(e=>console.log('    '+e));}
