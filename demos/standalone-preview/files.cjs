'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const LIMITS=Object.freeze({inputs:128,files:500,entries:10000,depth:8,sourceBytes:2*1024**3});
async function collect(inputs,signal){
 if(!Array.isArray(inputs)||!inputs.length||inputs.length>LIMITS.inputs)throw new Error('请拖入视频或文件夹（单次最多128项）。');
 const files=[],seen=new Set();let entries=0,skipped=0,truncated=false;
 const check=()=>{if(signal?.aborted){const e=new Error('已取消旧文件扫描。');e.name='AbortError';throw e;}};
 async function visit(input,depth){
  check();if(files.length>=LIMITS.files||entries>=LIMITS.entries){truncated=true;return;}
  if(typeof input!=='string'||input.includes('\0')||!path.isAbsolute(input)){skipped++;return;}
  const absolute=path.resolve(input),key=absolute.toLowerCase();if(seen.has(key))return;seen.add(key);entries++;
  let s,real;try{s=await fs.promises.lstat(absolute);real=await fs.promises.realpath(absolute);}catch(_){skipped++;return;}
  check();if(s.isSymbolicLink()||real.toLowerCase()!==key){skipped++;return;}
  if(s.isDirectory()){
   if(depth>=LIMITS.depth){truncated=true;return;}
   let dir;try{dir=await fs.promises.opendir(absolute);}catch(_){skipped++;return;}
   for await(const entry of dir){await visit(path.join(absolute,entry.name),depth+1);if(files.length>=LIMITS.files||entries>=LIMITS.entries){truncated=true;break;}}
  }else if(s.isFile()&&path.extname(absolute).toLowerCase()==='.mp4'){
   if(s.size<=0||s.size>LIMITS.sourceBytes){skipped++;return;}
   const id='file-'+crypto.createHash('sha256').update(key).digest('hex');
   files.push(Object.freeze({id,itemId:id,filePath:absolute,name:path.basename(absolute),ext:'mp4'}));
  }
 }
 for(const input of inputs){await visit(input,0);if(truncated&&files.length>=LIMITS.files)break;}
 files.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true})||a.filePath.localeCompare(b.filePath));
 return Object.freeze({files:Object.freeze(files),entries,skipped,truncated});
}
module.exports={collect,LIMITS};
