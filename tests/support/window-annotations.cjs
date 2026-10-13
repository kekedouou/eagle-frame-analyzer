'use strict';
// Independent T3 test entry: observe the FORMAL UI. No automatic add; only
// an exact chat-approved Save click may dispatch once. Rollback is test-only.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {createStore,_test:{canonical}}=require('./t2-evidence.cjs');
const {validateSnapshot}=require('../../plugin/eagle.cjs');
const MAX_EVENTS=64,MAX_BYTES=1024*1024;
function canWrite(approval,snapshot,spent,baselineReady){
 const d=snapshot&&snapshot.comments&&snapshot.comments.draft;
 return !!(approval&&approval.addOnce===true&&baselineReady&&!spent&&d&&['editing','failed'].includes(d.status)&&
  snapshot.sourceIdentity&&snapshot.sourceIdentity.itemId===approval.itemId&&d.source.id===approval.itemId&&
  d.libraryPath===approval.libraryPath&&d.frameId===approval.frameId&&Math.abs(d.time-approval.time)<=.001&&d.text===approval.text);
}
function deadline(work){return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('T3 Eagle API response timed out')),15000);Promise.resolve(work).then(v=>{clearTimeout(t);resolve(v);},e=>{clearTimeout(t);reject(e);});});}
async function hashSource(file){
 const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.size>512*1024**2)throw Error('Unsafe T3 source identity');
 const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
 const after=fs.lstatSync(file);if(['dev','ino','size','mtimeMs'].some(k=>before[k]!==after[k]))throw Error('T3 source changed during hashing');
 return hash.digest('hex');
}
function sameOriginals(before,after,addedId){
 const normalized=items=>items.slice().sort((a,b)=>a.id.localeCompare(b.id));
 return canonical(normalized(before))===canonical(normalized(after.filter(x=>x.id!==addedId)));
}
function run(options){
 const {bridge,document:doc,window:win,pluginRoot,eagle,launchContext:context}=options;
 const repo=path.resolve(pluginRoot,'..'),approval=context.annotationApproval||null,storeFactory=options.createStore||createStore;
 const groupId=new Date().toISOString()+'-'+crypto.randomBytes(6).toString('hex'),receipts=[];
 let baseline=null,baselineReady=false,spent=false,finished=false,finishing=null,unsubscribe=null,bytes=0,sequence=0,lastSignature=null;
 let error=null,queue=Promise.resolve(),resolveDone,pendingClick=null;
 const done=new Promise(resolve=>{resolveDone=resolve;});
 function persist(event,data){
  if(sequence>=MAX_EVENTS)throw Error('T3 observation limit reached; old evidence retained');
  const payload={schema:'window-annotations-v1',stage:'T3',origin:'real-Eagle-independent-entry',groupId,sequence:sequence++,at:new Date().toISOString(),event,data};
  const estimate=Buffer.byteLength(JSON.stringify(payload));if(estimate>128*1024||bytes+estimate+8192>MAX_BYTES)throw Error('T3 observation exceeds fixed 1MiB run budget');
  let store;try{store=storeFactory(repo,{stage:'T3'});store.start({reserveBytes:256*1024});const receipt=store.save('host',payload);bytes+=receipt.bytes;receipts.push(receipt);}finally{if(store)store.close();}
 }
 async function native(source,library){
  if(path.resolve(eagle.library.path)!==library)throw Error('素材库已变化，未访问另一素材库');
  const item=await deadline(eagle.item.getById(source.id)),value=validateSnapshot(item);
  if(path.resolve(eagle.library.path)!==library||value.id!==source.id||value.filePath!==source.filePath)throw Error('素材身份已变化，未执行数据操作');
  if(!Array.isArray(item.comments))throw Error('Native comments are invalid');
  const comments=JSON.parse(JSON.stringify(item.comments));if(Buffer.byteLength(JSON.stringify(comments))>128*1024)throw Error('Native comments exceed T3 bounded evidence');
  return {item,comments};
 }
 function observe(){
  if(finished)return;const s=bridge.snapshot(),c=s.comments,d=c&&c.draft;
  const signature=canonical({epoch:s.epoch,status:c&&c.status,message:c&&c.message,items:c&&c.items,
   draft:d?{id:d.id,status:d.status,time:d.time,message:d.message,text:['saving','unknown','checking'].includes(d.status)?d.text:null}:null});
  if(signature===lastSignature)return;lastSignature=signature;
  const value={state:s.state,source:s.sourceIdentity,comments:c,playback:s.playback?{frameId:s.playback.frameId,time:s.playback.time,state:s.playback.state}:null,
   annotationReceipts:s.annotationReceipts||[]};
  queue=queue.then(async()=>{
   persist('state',value);
   const saved=value.annotationReceipts.filter(r=>r.status==='saved').at(-1);
   if(saved&&baseline&&saved.source.id===baseline.source.id){const read=await native(baseline.source,baseline.libraryPath);persist('independent-native-read',{commentId:saved.commentId,time:saved.time,text:saved.text,
    found:read.comments.some(x=>x.id===saved.commentId&&x.annotation===saved.text&&Math.abs(x.duration-saved.time)<=.001),originalsUnchanged:sameOriginals(baseline.comments,read.comments,saved.commentId),comments:read.comments});}
  }).catch(e=>{error=String(e.message);doc.title='T3 标注验收 · 记录失败：'+error;});
 }
 function click(event){
  const button=event.target&&event.target.closest&&event.target.closest('button');if(!button)return;
  if(button.id==='commentSave'){
   let snapshot,draft;
   try{snapshot=bridge.snapshot();draft=snapshot.comments&&snapshot.comments.draft;}
   catch(e){event.preventDefault();event.stopImmediatePropagation();error='无法核对保存范围，已阻止写入：'+e.message;doc.title='T3 标注验收 · '+error;return;}
   if(draft&&draft.status==='unknown')return; // Explicit verification is read-only.
   let identityMatches=false;
   try{identityMatches=baselineReady&&baseline.source.id===approval?.itemId&&draft?.source.filePath===baseline.source.filePath&&
    snapshot.sourceIdentity?.sha256===baseline.sha256&&draft?.libraryPath===baseline.libraryPath&&path.resolve(eagle.library.path)===baseline.libraryPath;}catch(_){}
   if(!canWrite(approval,snapshot,spent,identityMatches)){
    event.preventDefault();event.stopImmediatePropagation();
    const node=doc.getElementById('commentStatus');if(node)node.textContent='本次写入尚未授权，或不符合已批准的素材、时间和文字。未发送标注。';
    try{persist('save-blocked',{approved:!!approval,spent,baselineReady,itemId:snapshot.sourceIdentity&&snapshot.sourceIdentity.itemId});}catch(e){error=e.message;}
    return;
   }
   spent=true;try{persist('approved-save-click',{approval,draft});}catch(e){error=e.message;event.preventDefault();event.stopImmediatePropagation();}
  }
  if(button.dataset&&button.dataset.commentId){
   const s=bridge.snapshot(),target=s.comments.items.find(x=>x.id===button.dataset.commentId);
   pendingClick=target?{id:target.id,time:target.time}:null;
  }
 }
 function afterState(){observe();if(!pendingClick||finished)return;const s=bridge.snapshot();if(s.state==='paused'){
  const target=pendingClick;pendingClick=null;queue=queue.then(()=>persist('annotation-seek-settled',{target,actual:s.playback})).catch(e=>{error=e.message;});
 }}
 doc.addEventListener('click',click,true);
 unsubscribe=bridge.subscribe(event=>{if(event.type==='state'||event.type==='load-result')afterState();});
 const initialization=(async()=>{
  const s=bridge.snapshot(),source={id:s.sourceIdentity.itemId,filePath:s.sourceIdentity.filePath,name:s.source.name,ext:'mp4'},libraryPath=path.resolve(eagle.library.path);
  const raw=await native(source,libraryPath),sha=await (options.hashSource||hashSource)(source.filePath);
  if(sha!==s.sourceIdentity.sha256)throw Error('Source SHA differs from loaded formal player');
  baseline={source,libraryPath,sha256:sha,comments:raw.comments};baselineReady=true;
  persist('initial',{launchContext:context,baseline,runtime:{node:process.versions.node,chrome:process.versions.chrome||null,electron:process.versions.electron||null},
   approval,manualExperience:'not-yet-reviewed',overallT3Accepted:false});observe();
 })().catch(e=>{error=String(e.message);doc.title='T3 标注验收 · 初始核对失败：'+error;});
 async function finish(reason='window-close'){
  if(finishing)return finishing;
  finishing=(async()=>{
   await initialization;await queue;
   let closing=null,rollback={status:'not-requested'},sourceUnchanged=null;
   try{
    options.verifyLaunch();closing=await options.closeSession();
    if(!closing||closing.status!=='closed')throw Error('正式会话未确认关闭；未执行标注回退');
    await queue;
    const final=bridge.snapshot(),saved=(final.annotationReceipts||[]).filter(r=>r.status==='saved'&&approval&&r.source.id===approval.itemId&&r.libraryPath===approval.libraryPath&&r.frameId===approval.frameId&&r.text===approval.text&&Math.abs(r.time-approval.time)<=.001).at(-1);
    if(baseline){sourceUnchanged=await (options.hashSource||hashSource)(baseline.source.filePath)===baseline.sha256;if(!sourceUnchanged)throw Error('Source changed; no automatic rollback');}
    if(approval&&approval.allowDelete===true&&saved&&baseline){
     const read=await native(baseline.source,baseline.libraryPath),comment=read.comments.find(x=>x.id===saved.commentId);
     if(!comment||comment.annotation!==approval.text||Math.abs(comment.duration-approval.time)>.001||baseline.comments.some(x=>x.id===comment.id)||!sameOriginals(baseline.comments,read.comments,comment.id))throw Error('Rollback identity/originals not proven; retained');
     if(typeof read.item.removeComment!=='function')throw Error('removeComment unavailable; test annotation retained');
     persist('rollback-intent',{itemId:baseline.source.id,commentId:comment.id,text:comment.annotation,time:comment.duration});
     try{await deadline(read.item.removeComment(comment.id));}catch(_){} // Never retry a possibly committed remove.
     const after=await native(baseline.source,baseline.libraryPath);
     const restored=canonical(after.comments.slice().sort((a,b)=>a.id.localeCompare(b.id)))===canonical(baseline.comments.slice().sort((a,b)=>a.id.localeCompare(b.id)));
     rollback={status:restored?'restored':'unknown',commentId:comment.id,comments:after.comments};
     if(!restored)error='测试标注删除结果未确认；不会重复删除。';
    }
    if(baseline)sourceUnchanged=await (options.hashSource||hashSource)(baseline.source.filePath)===baseline.sha256&&sourceUnchanged;
    if(sourceUnchanged===false)throw Error('Source SHA changed during T3; observation cannot pass');
    persist('summary',{reason,complete:!error&&reason!=='timeout'&&closing&&closing.status==='closed',observationSaved:true,overallT3Accepted:false,
     manualExperience:'awaiting-user',error,sourceUnchanged,closing,final,rollback,approval,receipts:receipts.slice()});
   }catch(e){error=String(e.message);try{persist('failure',{reason,error,closing,rollback,sourceUnchanged});}catch(saving){error+='; evidence: '+saving.message;}}
   finally{finished=true;if(unsubscribe)unsubscribe();doc.removeEventListener('click',click,true);resolveDone({complete:!error&&reason!=='timeout',observationSaved:!error,overallT3Accepted:false,error,receipts});}
  })();return finishing;
 }
 return {done,cancel:finish,unsavedEvidence:()=>error?JSON.stringify({groupId,error,receipts}):null};
}
module.exports={run,_test:{canWrite,sameOriginals}};
