'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert'),{execFileSync}=require('child_process');
const {repo,out,app,frozen,core,digest}=require('./assemble.cjs');
const {collect}=require('./files.cjs'),{adaptMedia}=require('./compat.cjs');
async function main(){
 for(const n of fs.readdirSync(__dirname).filter(n=>n.endsWith('.cjs')))execFileSync(process.execPath,['--check',path.join(__dirname,n)]);
 const source=path.join(repo,'prototypes/playback-clock/runtime/fixtures/h264-cfr.mp4'),before=digest(fs.readFileSync(source));
 const found=await collect([source,source,source.toUpperCase(),'relative.mp4',path.join(__dirname,'USAGE.txt')]);assert.strictEqual(found.files.length,1);assert.strictEqual(found.skipped,1);
 const controller=new AbortController();controller.abort();await assert.rejects(collect([source],controller.signal),{name:'AbortError'});
 assert.strictEqual(digest(fs.readFileSync(source)),before);
 for(const name of core){const original=execFileSync('git',['show',frozen+':plugin/'+name],{cwd:repo,maxBuffer:4*1024**2});const expected=name==='media.cjs'?adaptMedia(original):original;assert.strictEqual(digest(fs.readFileSync(path.join(app,'core',name))),digest(expected),name);}
 for(const n of ['main.cjs','preload.cjs','files.cjs'])assert.deepStrictEqual(fs.readFileSync(path.join(app,n)),fs.readFileSync(path.join(__dirname,n)),n);
 assert.strictEqual(execFileSync('git',['diff','--name-only','bf7fffc','--','plugin','tests/host/window','docs/product.md','docs/architecture.md'],{cwd:repo,encoding:'utf8'}).trim(),'');
 const html=fs.readFileSync(path.join(app,'index.html'),'utf8');assert(!/<script\b/.test(html));assert(!html.includes('在 Eagle 中'));assert(!fs.existsSync(path.join(app,'eagle.cjs')));
 const evidenceFiles=fs.readdirSync(path.join(__dirname,'evidence')).map(n=>fs.statSync(path.join(__dirname,'evidence',n)).size);assert(evidenceFiles.every(n=>n<=2*1024**2));assert(evidenceFiles.reduce((a,b)=>a+b,0)<=16*1024**2);
 console.log('PASS: syntax, bounded scanner/dedup/cancellation, frozen-copy integrity, isolated compatibility, protected plugin/entry/product/architecture, evidence budget.');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
