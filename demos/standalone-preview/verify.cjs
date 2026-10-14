'use strict';
// Independent Electron verification only; never starts Eagle or touches its cache/library.
const fs=require('fs'),path=require('path'),assert=require('assert');
const {spawn}=require('child_process');
const {out,repo,digest}=require('./assemble.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const evidence=path.join(__dirname,'evidence');fs.mkdirSync(evidence,{recursive:true});
const started=new Date().toISOString(),id=started.replace(/[:.]/g,'-');
const report={kind:'independent-Electron-not-Eagle',started,checks:[],errors:[],limitations:['No physical monitor present timestamp or subjective audio/drag acceptance measured.']};
let child,socket,sequence=0,context=null;const pending=new Map(),contexts=[];
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},20000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression,isolated=false){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...(isolated?{contextId:context}:{})});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function until(expression,isolated=false,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){const v=await evaluate(expression,isolated);if(v)return v;await sleep(150);}throw new Error('Condition timed out: '+expression+'; '+await evaluate('document.body.innerText'));}
async function main(){
 const fixture=path.join(repo,'prototypes/playback-clock/runtime/fixtures/h264-cfr.mp4');
 const original=digest(fs.readFileSync(fixture));
 const sampleDir=path.join(__dirname,'work','中文 空格 视频');if(!fs.existsSync(sampleDir))fs.mkdirSync(sampleDir);
 const cancel=process.argv.includes('--cancel');report.case=cancel?'close-during-prepare':'normal-and-reopen';
 const input=path.join(sampleDir,cancel?'取消 '+id+'.mp4':'有声 测试.mp4');
 if(!fs.existsSync(input)){
  if(cancel){const box=Buffer.alloc(32);box.writeUInt32BE(32);box.write('free',4);box.write(id.slice(0,24),8);fs.writeFileSync(input,Buffer.concat([fs.readFileSync(fixture),box]),{flag:'wx'});}
  else fs.copyFileSync(fixture,input,fs.constants.COPYFILE_EXCL);
 }
 const fixtures=fs.readdirSync(path.dirname(fixture)).filter(n=>/\.mp4$/.test(n));
 report.fixtures=fixtures;
 for(const name of fixtures.filter(n=>n!==path.basename(fixture))){const dest=path.join(sampleDir,name);if(!fs.existsSync(dest))fs.copyFileSync(path.join(path.dirname(fixture),name),dest,fs.constants.COPYFILE_EXCL);}
 child=spawn(path.join(out,'VideoAnalysisPreview.exe'),['--remote-debugging-port=0',input],{cwd:out,windowsHide:true,env:{...process.env,EVA_STANDALONE_VERIFY:'1'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-12000));child.stdout.resume();
 let endpoint;const portFile=path.join(out,'verification-data/browser/DevToolsActivePort');
 for(let i=0;i<100;i++){if(fs.existsSync(portFile)){const port=fs.readFileSync(portFile,'utf8').split('\n')[0];try{const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();endpoint=pages.find(p=>p.type==='page')?.webSocketDebuggerUrl;if(endpoint)break;}catch{}}if(child.exitCode!==null)throw new Error('Exited '+child.exitCode+' '+stderr);await sleep(100);}
 assert(endpoint,'No local Electron debug endpoint.');
 socket=new WebSocket(endpoint);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}else if(m.method==='Runtime.executionContextCreated')contexts.push(m.params.context);else if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails);};
 await call('Runtime.enable');await call('Page.enable');
 await until('document.body.dataset.state !== undefined');
 if(cancel){
  await until('document.body.dataset.state === "preparing"');
  await until('document.getElementById("status").textContent.includes("帧")',false,20000);
  report.cancellationAt=await evaluate('document.getElementById("status").textContent');await evaluate('window.close()');
  for(let i=0;i<150&&child.exitCode===null;i++)await sleep(100);
  assert(child.exitCode===0,'Preparing close did not finish.');
  const leftovers=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){if(/\.partial/.test(e.name))leftovers.push(path.relative(out,p));walk(p);}else if(/write.lock|\.partial|lease/i.test(e.name))leftovers.push(path.relative(out,p));}}
  walk(path.join(out,'verification-data/cache'));assert.deepStrictEqual(leftovers,[]);
  assert(digest(fs.readFileSync(fixture))===original);report.checks.push('Close during preparation exits normally; no partial/writer/lease remains; original hash unchanged.');report.status='passed';return;
 }
 for(const c of contexts){try{const r=await call('Runtime.evaluate',{expression:'typeof StandaloneObservation',contextId:c.id,returnByValue:true});if(r.result.value==='object'){context=c.id;break;}}catch{}}
 assert(context,'Read-only isolated observation unavailable. '+await evaluate('document.body.innerText'));
 await until('StandaloneObservation.snapshot().state === "paused"',true);
 report.initial=await evaluate('StandaloneObservation.snapshot()',true);report.checks.push('Chinese/space MP4 path; bundled tools; automatic cache; first frame paused.');
 assert(report.initial.playback.frameOrdinal===0);assert(report.initial.duration>0);
 await evaluate('document.getElementById("next").click()');await until('StandaloneObservation.snapshot().playback.frameOrdinal === 1',true);report.checks.push('Next frame draws ordinal 1.');
 await evaluate('document.getElementById("previous").click()');await until('StandaloneObservation.snapshot().playback.frameOrdinal === 0',true);
 await evaluate('document.getElementById("timeline").focus()');
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await until('StandaloneObservation.snapshot().state === "playing"',true);await until('StandaloneObservation.snapshot().playback.time > 0.15',true,10000);
 report.playing=await evaluate('StandaloneObservation.snapshot()',true);
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
 await until('StandaloneObservation.snapshot().state === "paused"',true);assert(report.playing.playback.time>0);report.checks.push('Space starts and pauses; time advances; audio context state retained in snapshot.');
 const rect=await evaluate('(()=>{const r=document.getElementById("timeline").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
 const y=rect.y+rect.height/2;
 await call('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x+2,y,button:'left',buttons:1,clickCount:1});
 for(const part of [.9,.1,.8,.2,.7])await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+rect.width*part,y,buttons:1});
 await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+rect.width*.7,y,button:'left',buttons:0,clickCount:1});await sleep(300);
 report.scrub=await evaluate('StandaloneObservation.snapshot()',true);assert(Math.abs(report.scrub.playback.time-report.scrub.duration*.7)<.12);report.checks.push('Rapid reverse drag settles near requested 70% position.');
 const before=report.scrub.playback.time;
 await evaluate('(()=>{document.querySelector(".memory-settings").open=true;const e=document.getElementById("memoryPercent");e.value="3";document.getElementById("memoryApply").click()})()');
 await until('StandaloneObservation.snapshot().state === "paused" && StandaloneObservation.snapshot().memorySettings.percent === 3',true);
 report.memory=await evaluate('StandaloneObservation.snapshot()',true);assert(Math.abs(report.memory.playback.time-before)<.12);report.checks.push('RAM percentage changes, keeps time and pauses.');
 // Real Chromium file drag payload, not an injected filesystem adapter.
 for(const type of ['dragEnter','dragOver','drop'])await call('Input.dispatchDragEvent',{type,x:400,y:200,data:{items:[],files:[sampleDir],dragOperationsMask:1}});
 await until('document.getElementById("videoList").options.length >= 3');await until('StandaloneObservation.snapshot().state === "paused"',true);
 report.folderCount=await evaluate('document.getElementById("videoList").options.length');report.checks.push('Native File drag payload imports Chinese/space folder with video list.');
 for(let i=0;i<report.folderCount;i++){
  await evaluate('(()=>{const e=document.getElementById("videoList");e.selectedIndex='+i+';e.dispatchEvent(new Event("change"))})()');
  await until('StandaloneObservation.snapshot().state === "paused"',true);await sleep(200);
 }
 report.switched=await evaluate('StandaloneObservation.snapshot()',true);assert(report.switched.source.filePath!==report.initial.source.filePath);report.checks.push('Folder list switches video without Eagle.');
 assert(await evaluate('typeof require === "undefined" && typeof StandaloneObservation === "undefined"'));assert(await evaluate('getComputedStyle(document.querySelector(".comments")).display === "none"'));report.checks.push('Page cannot access Node or isolated observation; annotation/test controls absent.');
 const shot=await call('Page.captureScreenshot',{format:'png'});const png=Buffer.from(shot.data,'base64');assert(png.length<=2*1024**2);fs.writeFileSync(path.join(evidence,id+'.png'),png,{flag:'wx'});report.screenshot=id+'.png';
 assert(digest(fs.readFileSync(fixture))===original);report.checks.push('Original fixture SHA256 unchanged.');
 await evaluate('window.close()');for(let i=0;i<100&&child.exitCode===null;i++)await sleep(100);assert(child.exitCode===0,'Normal close did not finish '+stderr);report.checks.push('Normal close releases session and exits process.');
 report.status='passed';
}
main().catch(e=>{report.status='failed';report.failure=e.stack;console.error(e.stack);process.exitCode=1;}).finally(()=>{
 if(socket)socket.close();if(child&&child.exitCode===null)child.kill();report.finished=new Date().toISOString();const bytes=Buffer.from(JSON.stringify(report,null,2));assert(bytes.length<2*1024**2);fs.writeFileSync(path.join(evidence,id+'.json'),bytes,{flag:'wx'});console.log('Independent verification:',report.status,id,report.checks);
});
