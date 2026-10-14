'use strict';
// Pinned portable downloads only; no dependency installation or machine configuration.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert');
const {Readable}=require('stream'),{pipeline}=require('stream/promises');
const work=path.join(__dirname,'work');
const assets=[
 {name:'electron-v44.7.2-win32-x64.zip',url:'https://github.com/electron/electron/releases/download/v44.7.2/electron-v44.7.2-win32-x64.zip',bytes:157867015,sha256:'10a89447ef64ac5cb9f782af48ffd83734a40ae91681259d1048ca3c9e6c5da4'},
 {name:'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip',url:'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip',bytes:80983254,sha256:'6fbe3233f0b769ce6d906fc200ef0b874b681fa1554520f6880bfb45b4befa58'}
];
function directory(dir){const s=fs.lstatSync(dir);assert(s.isDirectory()&&!s.isSymbolicLink()&&path.resolve(dir).toLowerCase()===fs.realpathSync(dir).toLowerCase());}
async function hash(file){const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
async function download(asset){
 directory(__dirname);if(!fs.existsSync(work))fs.mkdirSync(work);directory(work);
 const file=path.join(work,asset.name);
 if(fs.existsSync(file)){assert.strictEqual(fs.statSync(file).size,asset.bytes);assert.strictEqual(await hash(file),asset.sha256);return asset;}
 const r=await fetch(asset.url,{signal:AbortSignal.timeout(300000)});assert(r.ok,'Runtime download HTTP '+r.status);
 let bytes=0;const h=crypto.createHash('sha256');
 const source=Readable.from((async function*(){for await(const b of r.body){bytes+=b.length;assert(bytes<=asset.bytes);h.update(b);yield b;}})());
 await pipeline(source,fs.createWriteStream(file,{flags:'wx'}));
 assert.strictEqual(bytes,asset.bytes);assert.strictEqual(h.digest('hex'),asset.sha256,'Download checksum mismatch; retained for inspection.');
 console.log('download verified:',asset.name,bytes);return asset;
}
if(require.main===module)Promise.all(assets.map(download)).then(()=>console.log('portable runtime downloads verified')).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={assets,work,directory,hash};
