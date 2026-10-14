'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert'),crypto=require('crypto');
const {execFileSync}=require('child_process');
const {assets,directory}=require('./assets.cjs');
const {adaptMedia}=require('./compat.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'dist/video-analysis-standalone-preview-20261014');
const app=path.join(out,'resources/app'),licenses=path.join(out,'licenses');
const frozen='6693994942381b833ccfb4381cafee93df6e9b24';
const core=['ui.js','player.js','session.cjs','media.cjs','cache.cjs','process-identity.cjs','frame-index.cjs','preferences.cjs','logo.png'];
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function old(file){return execFileSync('git',['show',frozen+':plugin/'+file],{cwd:repo,maxBuffer:4*1024**2});}
function put(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});}
async function source(url,name,maximum){
 const r=await fetch(url,{signal:AbortSignal.timeout(180000)});assert(r.ok,'Source download HTTP '+r.status);
 const chunks=[];let n=0;for await(const b of r.body){n+=b.length;assert(n<=maximum);chunks.push(b);}
 const bytes=Buffer.concat(chunks);put(path.join(licenses,name),bytes);return {name,bytes:n,sha256:digest(bytes),url};
}
async function main(){
 directory(out);assert(!fs.existsSync(app),'Refusing overwrite of an assembled application.');
 const hashes={},originals={};for(const name of core){const original=old(name),b=name==='media.cjs'?adaptMedia(original):original;put(path.join(app,'core',name),b);hashes[name]=digest(b);originals[name]=digest(original);}
 for(const name of ['main.cjs','preload.cjs','files.cjs'])put(path.join(app,name),fs.readFileSync(path.join(__dirname,name)));
 let html=old('index.html').toString().replace(/\s*<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 html=html.replace('<title>视频分析</title>','<title>视频分析 · 独立展示版</title>')
  .replace('<meta charset="utf-8">','<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'self\'; img-src \'self\' data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'">')
  .replace('在 Eagle 中单选 MP4 后打开插件','拖入 MP4 或视频文件夹，或点击右侧打开')
  .replace('<h1>素材</h1>','<h1>视频分析 · 展示版</h1><div class="file-actions"><button id="openFiles" type="button">打开视频</button><button id="openFolder" type="button">打开文件夹</button></div><p id="importStatus" class="muted" role="status">支持≤30秒 MP4；原视频只读</p><select id="videoList" size="5" aria-label="视频列表"></select>')
  .replace('<section class="comments"','<section hidden class="comments"');
 put(path.join(app,'index.html'),html);
 put(path.join(app,'styles.css'),old('styles.css').toString()+'\n/* Isolated one-off file source UI. */\n.comments,.comment-markers{display:none!important}.file-actions{display:flex;gap:8px;flex-wrap:wrap}#videoList{width:100%;min-height:100px;max-height:160px;background:#202020;color:#ddd;border:1px solid #444;border-radius:4px;margin-bottom:18px}#videoList option{padding:6px}#importStatus{font-size:12px;overflow-wrap:anywhere}.sidebar{overflow-y:auto}\n');
 put(path.join(app,'package.json'),JSON.stringify({name:'video-analysis-standalone-preview',version:'0.1.0',main:'main.cjs',description:'Temporary standalone demonstration; no Eagle integration or annotation storage.'},null,2));
 const tools=path.join(out,'resources/tools');
 const version=execFileSync(path.join(tools,'ffmpeg.exe'),['-version'],{encoding:'utf8'});
 assert(!/--enable-(?:gpl|nonfree)\b/.test(version));
 put(path.join(licenses,'FFmpeg-version-buildconf.txt'),version);
 put(path.join(licenses,'Electron-LICENSE.txt'),fs.readFileSync(path.join(out,'LICENSE')));
 const sources=[];
 sources.push(await source('https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/46d899d7a0','FFmpeg-46d899d7a0-source.tar.gz',32*1024**2));
 const response=await fetch('https://api.github.com/repos/BtbN/FFmpeg-Builds/commits?until=2026-10-14T00:00:00Z&per_page=1');assert(response.ok);
 const commit=(await response.json())[0].sha;
 sources.push(await source('https://codeload.github.com/BtbN/FFmpeg-Builds/tar.gz/'+commit,'BtbN-build-scripts-source.tar.gz',8*1024**2));
 put(path.join(licenses,'THIRD-PARTY-NOTICES.txt'),'Electron 44.7.2: MIT; Chromium and bundled components: see ../LICENSES.chromium.html.\nFFmpeg '+version.split('\n')[0]+'\nUnmodified BtbN Windows x64 LGPL-shared build; LGPL-3.0-or-later.\nFFmpeg source at the exact binary-reported revision is included. Build-script snapshot is a time-adjacent upstream reference, not asserted to reproduce the exact binary.\nExternal libraries and their source origins/build rules: included BtbN scripts.d and FFmpeg configure report. Additional third-party license/source completeness has not been audited; this demonstration is not a public release readiness claim.\nNo Eagle executable, API implementation, user media or cache included.\n');
 put(path.join(out,'README.txt'),fs.readFileSync(path.join(__dirname,'USAGE.txt')));
 put(path.join(out,'BUILD-INFO.json'),JSON.stringify({schema:1,kind:'one-off-standalone-demonstration',frozenPluginCommit:frozen,originalCoreSha256:originals,coreSha256:hashes,mediaCompatibility:'FFmpeg8 single filter graph for non-interleaved video/audio timestamp logs; demonstration copy only',runtimes:assets,sources,buildScriptsSnapshot:commit,noEagle:true,noAnnotations:true,preview:'720p',platform:'Windows x64; Windows 10 22H2 or newer',notStageAcceptance:true},null,2));
 console.log('Assembled frozen core, local-file adapter, runtime and source/license materials.');
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={repo,out,app,frozen,core,digest};
