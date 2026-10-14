'use strict';
// All privileged code stays in this isolated, local-only preload; no Node or IPC API in page globals.
const {ipcRenderer,webUtils}=require('electron');
const path=require('path'),fs=require('fs');
const {collect}=require('./files.cjs');
const {Player}=require('./core/player.js'),{createUI}=require('./core/ui.js');
const {createSession}=require('./core/session.cjs'),{createCache}=require('./core/cache.cjs');
const {createMedia}=require('./core/media.cjs'),{createMemoryPreferences}=require('./core/preferences.cjs');
const frameIndex=require('./core/frame-index.cjs');
window.addEventListener('DOMContentLoaded',async()=>{
 const ui=createUI({document,window});let session=null,selected=null,closing=false,allowClose=false,closeTask=null;
 let scan=null,imports=0,files=[];const now=()=>performance.now();
 const message=text=>{document.getElementById('importStatus').textContent=String(text).slice(0,1024);};
 const notice=(s)=>{const value=s.state==='empty'?{...s,progress:{message:'拖入 MP4 或视频文件夹，或点击右侧打开'}}:s;ui.update(value);document.body.dataset.state=s.state;};
 function cleanup(){if(closeTask)return closeTask;closing=true;if(scan)scan.abort();closeTask=Promise.resolve(session?.close()).then(result=>{if(result?.status==='error')throw new Error(result.error?.message||'资源释放失败');ui.destroy();return result;});return closeTask;}
 window.addEventListener('beforeunload',event=>{
  if(allowClose)return;event.preventDefault();event.returnValue=false;
  cleanup().then(()=>window.setTimeout(()=>{allowClose=true;window.close();},0)).catch(e=>message('关闭清理失败：'+e.message));
 });
 window.addEventListener('pagehide',()=>cleanup().catch(()=>{}));
 try{
  const config=await ipcRenderer.invoke('preview:initial');if(closing)return;
  const preferences=createMemoryPreferences({pluginRoot:config.data});
  const cache=createCache({pluginRoot:config.data,...(config.smoke?{diskBytes:512*1024**2}:{})});
  const tools=path.join(__dirname,'..','tools');
  for(const name of ['ffmpeg.exe','ffprobe.exe'])if(!fs.statSync(path.join(tools,name)).isFile())throw new Error('内置工具缺失，请重新完整解压软件。');
  const media=createMedia({tools:{ffmpeg:path.join(tools,'ffmpeg.exe'),ffprobe:path.join(tools,'ffprobe.exe')},cache,frameIndex});
  const source={captureSelected(){if(!selected)throw new Error('请先打开一个MP4视频。');return selected;},async readComments(){return {libraryPath:config.data,items:[]};}};
  session=createSession({eagleAdapter:source,media,cache,memoryPreferences:preferences,now,onChange:notice,
   createPlayer:options=>{const m=preferences.snapshot();return new Player({...options,ramBytes:m.ramBytes,compressedRamBytes:m.compressedRamBytes,canvas:ui.canvas,frameIndex});}});
  ui.bindSession(session);notice(session.snapshot());
  // Read-only observation in the isolated context for automated verification; not exposed to page scripts.
  Object.defineProperty(window,'StandaloneObservation',{value:Object.freeze({snapshot:()=>session.snapshot(),memory:()=>session.memorySnapshot()}),configurable:false});
  const list=document.getElementById('videoList');
  async function activate(index){
   if(closing||!Number.isSafeInteger(index)||!files[index])return;
   selected=files[index];list.selectedIndex=index;message('已选择 '+selected.name);
   await session.loadSelected({trigger:'local-selection',startedAt:now()});
  }
  async function importPaths(paths){
   if(closing||!Array.isArray(paths)||!paths.length)return;
   const token=++imports;if(scan)scan.abort();scan=new AbortController();message('正在读取视频列表…');
   try{
    const found=await collect(paths,scan.signal);if(closing||token!==imports)return;
    if(!found.files.length){message('未找到可用MP4（仅普通文件、不跟随链接、单文件≤2GiB）。');return;}
    files=found.files;list.replaceChildren();
    for(const file of files){const item=document.createElement('option');item.textContent=file.name;item.title=file.filePath;list.appendChild(item);}
    message('共 '+files.length+' 个MP4'+(found.truncated?'，列表已到扫描上限':'')+(found.skipped?'；跳过 '+found.skipped+' 项':''));
    await activate(0);
   }catch(e){if(e.name!=='AbortError'&&!closing&&token===imports)message(e.message);}
  }
  list.addEventListener('change',()=>activate(list.selectedIndex).catch(e=>message(e.message)));
  for(const [id,kind] of [['openFiles','files'],['openFolder','folder']])document.getElementById(id).addEventListener('click',async()=>{
   try{await importPaths(await ipcRenderer.invoke('preview:pick',kind));}catch(e){message(e.message);}
  });
  window.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';});
  window.addEventListener('drop',event=>{
   event.preventDefault();let paths;
   try{paths=Array.from(event.dataTransfer?.files||[]).map(file=>webUtils.getPathForFile(file));}catch(e){message(e.message);return;}
   importPaths(paths).catch(e=>message(e.message));
  });
  ipcRenderer.on('preview:paths',(_event,paths)=>importPaths(paths).catch(e=>message(e.message)));
  if(config.paths.length)await importPaths(config.paths);
 }catch(e){notice({state:'error',duration:0,source:null,playback:null,error:{message:e.message}});message(e.message);}
});
