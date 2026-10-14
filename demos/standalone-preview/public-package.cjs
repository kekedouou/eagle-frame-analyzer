'use strict';
// Publication changes only documentation/material indexing; frozen runtime bytes remain identical.
const fs=require('fs'),path=require('path'),zlib=require('zlib'),crypto=require('crypto'),assert=require('assert');
const {execFileSync}=require('child_process');
const root=path.resolve(__dirname,'../..'),original=path.join(root,'dist/video-analysis-standalone-preview-20261014');
const out=path.join(root,'dist/video-analysis-standalone-0.1.0-win-x64'),zip=out+'.zip';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function tarEntries(file){const b=zlib.gunzipSync(fs.readFileSync(file)),entries=[];let at=0;assert(b.length<128*1024**2);while(at+512<=b.length){const header=b.subarray(at,at+512),name=header.subarray(0,100).toString().replace(/\0.*$/s,''),size=parseInt(header.subarray(124,136).toString().trim(),8)||0;at+=512;if(!name)break;assert(!name.startsWith('/')&&!name.split('/').includes('..'));entries.push({name,body:b.subarray(at,at+size)});at+=Math.ceil(size/512)*512;}return entries;}
function put(file,b){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b,{flag:'wx'});}
function manifest(dir){const files=[];function walk(d){assert(fs.realpathSync(d).toLowerCase()===d.toLowerCase());for(const entry of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,entry.name);assert(!entry.isSymbolicLink());if(entry.isDirectory())walk(f);else {const b=fs.readFileSync(f);files.push({path:path.relative(dir,f).replace(/\\/g,'/'),bytes:b.length,sha256:hash(b)});}}}walk(dir);return files;}
function main(){
 assert(!fs.existsSync(out)&&!fs.existsSync(zip),'Existing publication output preserved.');
 const old=JSON.parse(fs.readFileSync(path.join(original,'INTEGRITY.json')));
 for(const item of old.files){const source=path.join(original,item.path);assert.strictEqual(hash(fs.readFileSync(source)),item.sha256);if(['README.txt','BUILD-INFO.json'].includes(item.path))continue;put(path.join(out,item.path),fs.readFileSync(source));}
 const usage=fs.readFileSync(path.join(__dirname,'USAGE.txt'),'utf8').replace('视频分析 · 独立绿色展示版','视频分析 · Windows绿色独立版 0.1.0').replace('这是当前 Eagle 插件成果的一次性展示，不是新的正式产品。','这是Eagle视频分析插件成果的公开体验发行包。独立运行，无需Eagle；插件仍是持续开发主线。').replace('公开分发前还需完整复核第三方组件许可证与源码材料；本包附已有许可证、FFmpeg源码和构建脚本参考。','许可、版权与源码材料见licenses目录及THIRD-PARTY.md。当前使用说明与公开发行状态以本说明及GitHub版本页为准。');
 put(path.join(out,'README.txt'),usage+'\n下载与反馈：https://github.com/kekedouou/eagle-frame-analyzer/releases/tag/standalone-v0.1.0\n本包未作Windows代码签名，系统可能提示确认来源；请先核对下载地址和SHA256。\n');
 put(path.join(out,'THIRD-PARTY.md'),fs.readFileSync(path.join(__dirname,'THIRD-PARTY.md')));
 const sourceTar=path.join(original,'licenses/FFmpeg-46d899d7a0-source.tar.gz'),ffmpeg=tarEntries(sourceTar);
 for(const license of ['COPYING.LGPLv3','COPYING.GPLv3']){const e=ffmpeg.find(e=>e.name.endsWith('/'+license));assert(e);put(path.join(out,'licenses',license),e.body);}
 const scripts=tarEntries(path.join(original,'licenses/BtbN-build-scripts-source.tar.gz'));
 const license=scripts.find(e=>/^[^/]+\/LICENSE$/.test(e.name));assert(license);put(path.join(out,'licenses/BtbN-LICENSE.txt'),license.body);
 const refs=scripts.filter(e=>/\/scripts.d\/.*\.sh$/.test(e.name)).map(e=>({script:e.name.split('/').slice(1).join('/'),declarations:e.body.toString().split('\n').filter(s=>/^SCRIPT_(REPO|REV|URL|SHA|VERSION|BRANCH|COMMIT)/.test(s))})).filter(e=>e.declarations.length);
 put(path.join(out,'licenses/third-party-source-index.json'),JSON.stringify({snapshot:'63ac3265b0789ea16c7b1f8351cd2ad195a28722',scope:'Source declarations in saved upstream recipe; includes optional/not-enabled packages; does not assert exact dependency binary revision reproduction.',references:refs},null,2));
 const info=JSON.parse(fs.readFileSync(path.join(original,'BUILD-INFO.json')));info.publication={version:'0.1.0',tag:'standalone-v0.1.0',originalPackageSha256:'872a48e5078beed202a063af2d1c16a85700a7dc7aaae687fc84e9a02d245ec5',changes:'User-facing README and additional license/source index only; all pre-existing runtime and material files unchanged.'};
 put(path.join(out,'BUILD-INFO.json'),JSON.stringify(info,null,2));
 const files=manifest(out);assert(files.reduce((n,f)=>n+f.bytes,0)<=768*1024**2);put(path.join(out,'INTEGRITY.json'),JSON.stringify({schema:1,files},null,2));
 for(const item of old.files.filter(x=>!['README.txt','BUILD-INFO.json'].includes(x.path)))assert.strictEqual(hash(fs.readFileSync(path.join(out,item.path))),item.sha256);
 const quote=s=>"'"+s.replace(/'/g,"''")+"'";
 execFileSync('powershell.exe',['-NoProfile','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('+quote(out)+','+quote(zip)+',[IO.Compression.CompressionLevel]::Optimal,$true)'],{stdio:'inherit'});
 const bytes=fs.statSync(zip).size,sha256=hash(fs.readFileSync(zip));assert(bytes<=384*1024**2);
 fs.writeFileSync(zip+'.sha256',sha256+'  '+path.basename(zip)+'\n',{flag:'wx'});
 const receipt={schema:1,tag:'standalone-v0.1.0',zip:path.basename(zip),bytes,sha256,files:files.length+1,allOriginalRuntimeAndMaterialFilesUnchanged:true,originalRuntimeSourceCommit:'613c4e29c0c073c52f4da4fc0f5d6fcc23cb3a5d',at:new Date().toISOString()};
 put(path.join(__dirname,'work/public-package-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}
main();
