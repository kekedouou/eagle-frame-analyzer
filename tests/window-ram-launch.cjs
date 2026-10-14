'use strict';
// Integrate the actual launcher and captured Player constructor, with model
// SDK/readiness/driver. No video, Eagle instance or evidence file is touched.
const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto'),assert=require('assert');
const root=path.resolve(__dirname,'..'),plugin=path.join(root,'plugin'),host=path.join(root,'tests/host/window');
const playerText=fs.readFileSync(path.join(plugin,'player.js'),'utf8'),code=fs.readFileSync(path.join(__dirname,'support/window-launch.cjs'),'utf8');
const config={schema:'T2-ram-host-v2',ramMiB:2048,compressedMiB:256,rendererStopMiB:3072};
const source={itemId:'MV6H7OK0MBGX2',sha256:'d7bbab0b425381c880adacb9f8d95d900aa162c4c5c9308cf9a3f8482ff67658'};
async function check(fault,mode='performance'){
 const m={exports:{}},nodes={status:{},error:{}},handlers=new Map(),win={performance:{now:()=>1},setTimeout,clearTimeout,
  addEventListener:(n,f)=>handlers.set(n,f),removeEventListener:n=>handlers.delete(n)};
 win.eval=s=>vm.runInNewContext(s,{window:win,console});let callback,called=0,snapshot;
 const sdk={onPluginCreate(fn){callback=fn;}},doc={title:'',getElementById:n=>nodes[n]},saved=[];
 const realRequire=require('module').createRequire(path.join(__dirname,'support/window-launch.cjs'));
 let cacheChecked=0;
 vm.runInNewContext(code,{module:m,console,Buffer,require:n=>n==='../../plugin/eagle.cjs'?{createEagleAdapter:()=>({captureSelected:async()=>({...source,itemId:fault==='selection'?'wrong':source.itemId})})}:n==='./window-host.cjs'?{...realRequire(n),_test:{registeredManifest(){cacheChecked++;if(fault==='missing-cache')throw new Error('missing complete cache');}}}:realRequire(n)});
 const controller=m.exports.install({window:win,document:doc,eagle:sdk,hostRoot:host,
  verify:()=>({host,plugin,marker:{mode,ramDiagnostic:config,sourceHashes:{'plugin/player.js':crypto.createHash('sha256').update(playerText).digest('hex')}}}),
  createStore:()=>({start(){},close(){},save(_k,v){saved.push(v);return {};}}),
  run(args){called++;assert(doc.title.includes(mode==='reuse'?'2GB缓存复用':'2GB RAM'));assert.equal(args.launchContext.ramDiagnostic.rendererRssStopBytes,3*1024**3);
   assert.equal(args.launchContext.ramDiagnostic.candidatePlayerSha256,args.launchContext.ramDiagnostic.originalPlayerSha256);
   return {done:Promise.resolve({complete:true,earlyRegressionPassed:true,reuseGatePassed:true,p03:{withinTarget:null},receipts:[]}),cancel(){}};}});
 sdk.onPluginCreate(()=>{
  const p=new win.EVAPlayer.Player({frameIndex:require('../plugin/frame-index.cjs'),canvas:{getContext:()=>({})},readAsset:async()=>new Uint8Array(),env:{now:()=>0,raf:()=>0}});
  assert.equal(p.snapshot().budget.limit,2*1024**3);assert.equal(p.compressedLimit,256*1024**2);
  snapshot={state:'paused',sourceIdentity:source,loadMetrics:{entryAt:0,readyAt:1,totalMs:1,reused:true},
   playback:{budget:{limit:fault==='budget'?1024**3:p.snapshot().budget.limit},compressed:{limitBytes:p.compressedLimit}}};
  win.EVADiagnostics={snapshot:()=>snapshot,subscribe:()=>()=>{}};
 });
 const result=await callback({path:host});assert.equal(result.complete,!fault);assert.equal(called,fault?0:1);assert.equal(saved.length,fault?1:0);
 assert(controller.snapshot().completed);assert.equal(handlers.size,0);
 assert.equal(cacheChecked,mode==='reuse'&&fault!=='selection'?1:0);
}
(async()=>{await check();await check('selection');await check('budget');await check(undefined,'reuse');await check('missing-cache','reuse');console.log('Window RAM launcher: actual 2GiB captured constructor/256MiB pool and 3GiB context wired; wrong source/budget and missing reuse cache blocked; model SDK/driver only.');})().catch(e=>{console.error(e.stack);process.exitCode=1;});
