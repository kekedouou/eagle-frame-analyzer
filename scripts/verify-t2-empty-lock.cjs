'use strict';
// Explicit Windows filesystem checks / narrowly scoped current empty-lock repair.
// Never executes as part of default checks; no media or Eagle/library writes.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert');
const {createCache}=require('../plugin/cache.cjs');
const {claimEmptyWriter}=require('../plugin/process-identity.cjs');
const {createStore}=require('../tests/support/t2-evidence.cjs');
const repo=path.resolve(__dirname,'..'),scratch=path.join(repo,'tests/host/t2/cache-scratch');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function inventory(dir,depth=0,out=[]) {
 const s=fs.lstatSync(dir);assert(s.isDirectory()&&!s.isSymbolicLink()&&depth<=4&&fs.realpathSync(dir).toLowerCase()===dir.toLowerCase());
 for(const name of fs.readdirSync(dir).sort()) {const file=path.join(dir,name),v=fs.lstatSync(file);
  if(v.isDirectory()) inventory(file,depth+1,out);
  else {assert(v.isFile()&&!v.isSymbolicLink()&&v.nlink===1);out.push({file,ino:v.ino,dev:v.dev,bytes:v.size,mtimeMs:v.mtimeMs});}}
 return out;
}
async function main() {
 const mode=process.argv[2];assert(['filesystem','repair-current'].includes(mode),'Use filesystem or repair-current explicitly.');
 const store=createStore(repo);store.start({reserveBytes:256*1024});let own=null,known=[],success=false;
 try {
  if(mode==='filesystem') {
   const before=inventory(scratch);assert(before.reduce((n,s)=>n+s.bytes,0)+65536<=2*1024**2);
   own=path.join(scratch,'empty-lock-'+crypto.randomBytes(12).toString('hex'));fs.mkdirSync(own);
   const file=path.join(own,'writer.lock'),data=Buffer.from('{"test":"exclusive-empty-claim"}');
   fs.writeFileSync(file,'',{flag:'wx'});const fd=fs.openSync(file,'r+');
   try {assert.equal(claimEmptyWriter(file,data),false);assert.equal(fs.fstatSync(fd).size,0);} finally {fs.closeSync(fd);}
   assert.equal(claimEmptyWriter(file,data),true);assert(fs.readFileSync(file).equals(data));
   assert.equal(claimEmptyWriter(file,Buffer.from('other')),false);assert(fs.readFileSync(file).equals(data));
   // The formal cache accepts a genuinely orphaned empty record without deleting
   // any asset; normal owned cleanup then removes the new writer.
   const plugin=path.join(own,'plugin 中文 空格');fs.mkdirSync(plugin);const cache=createCache({pluginRoot:plugin});
   let tx=cache.begin({sourceSha256:'a'.repeat(64)});tx.close();
   fs.writeFileSync(path.join(cache.root,'writer.lock'),'',{flag:'wx'});
   tx=cache.begin({sourceSha256:'a'.repeat(64)});assert(JSON.parse(fs.readFileSync(path.join(cache.root,'writer.lock'))).processIdentity);
   tx.close();assert(!fs.existsSync(path.join(cache.root,'writer.lock')));
   const {publish,hash}=require('../tests/t2-lifecycle.cjs'),items=[];
   for(const n of [1,2,3]){const item=await publish({cache},n,256);items.push(item);if(n!==2)cache.release(item);}
   const cleared=cache.clearOther({sourceSha256:hash(1)});assert.equal(cleared.cleared,1);
   assert(fs.existsSync(items[0].cacheDir)&&fs.existsSync(items[1].cacheDir)&&!fs.existsSync(items[2].cacheDir));cache.release(items[1]);
   const marker=path.join(items[0].cacheDir,'owner.json'),owner=JSON.parse(fs.readFileSync(marker));owner.lastUsedAt=Date.now()-86400001;fs.writeFileSync(marker,JSON.stringify(owner));
   tx=cache.begin({sourceSha256:hash(2)});assert.equal(tx.cleanup.cleared,1);tx.close();assert(!fs.existsSync(items[0].cacheDir));assert(fs.existsSync(items[1].cacheDir));
   const {createMemoryPreferences,OWNER}=require('../plugin/preferences.cjs'),settings=path.join(plugin,'memory-settings.json');
   fs.writeFileSync(settings,JSON.stringify({owner:OWNER,percent:2.5}),{flag:'wx'});const original=fs.readFileSync(settings);
   let prefs=createMemoryPreferences({pluginRoot:plugin,totalRamBytes:42551783424});assert.equal(prefs.snapshot().ramMiB,1024);assert(fs.readFileSync(settings).equals(original));
   prefs.save(2048);prefs=createMemoryPreferences({pluginRoot:plugin,totalRamBytes:42551783424});assert.equal(prefs.snapshot().ramMiB,2048);prefs.save(1024);
   assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings)),{owner:OWNER,ramMiB:1024});assert(!fs.existsSync(path.join(plugin,'memory-settings.next.json')));
   known=inventory(own);assert(known.length<=16&&known.reduce((n,s)=>n+s.bytes,0)<65536);
   const snapshots=known.map(s=>({...s,sha256:sha(fs.readFileSync(s.file))}));
   assert.deepStrictEqual(inventory(scratch).filter(s=>!s.file.startsWith(own+path.sep)),before);
   console.log(store.save('lifecycle',{protocol:'t2-empty-writer-windows-v1',passed:true,activeHandleProtected:true,
    orphanClaimed:true,nonemptyPreserved:true,formalBeginClosePassed:true,oneDayExpiryPassed:true,clearOtherCurrentAndLeaseProtected:true,
    fixedRamSettingsRealSaveReplaceReloadPassed:true,legacyReadPreservedUntilApply:true,files:snapshots,
    limitation:'Real Windows filesystem/handle checks, not real Eagle interaction or process-crash test.'}));
   for(const record of snapshots) {const now=fs.lstatSync(record.file);assert(now.ino===record.ino&&now.dev===record.dev&&sha(fs.readFileSync(record.file))===record.sha256);fs.unlinkSync(record.file);}
   fs.rmdirSync(items[1].cacheDir);fs.rmdirSync(cache.root);fs.rmdirSync(plugin);fs.rmdirSync(own);own=null;
   assert.deepStrictEqual(inventory(scratch),before);success=true;
  } else {
   const plugin=path.join(repo,'plugin'),root=path.join(plugin,'cache'),lock=path.join(root,'writer.lock');
   const before=inventory(root),v=fs.lstatSync(lock);assert(v.isFile()&&!v.isSymbolicLink()&&v.nlink===1&&v.size===0);
   assert(fs.readdirSync(root).every(n=>n==='owner.json'||n==='writer.lock'||/^media-[0-9a-f]{64}-[0-9a-f]{12}$/.test(n)),'Unknown/partial cache entries: repair must not perform unrelated recovery.');
   const owner=JSON.parse(fs.readFileSync(path.join(root,'owner.json')));assert.equal(owner.root,root);assert.equal(owner.kind,'root');
   console.log(store.save('audit',{protocol:'t2-current-empty-writer-before-v1',root,emptyLock:before.find(s=>s.file===lock),owner,
    protectedFileCount:before.length-1,protectedBytes:before.filter(s=>s.file!==lock).reduce((n,s)=>n+s.bytes,0),sourceOrLibraryWrites:false}));
   const cache=createCache({pluginRoot:plugin});const tx=cache.begin({sourceSha256:'a'.repeat(64)});tx.close();
   assert.deepStrictEqual(inventory(root),before.filter(s=>s.file!==lock));success=true;
   console.log(store.save('audit',{protocol:'t2-current-empty-writer-repair-v1',passed:true,emptyLockCleared:true,
    protectedFileIdentitiesSizesTimesUnchanged:true,sourceOrLibraryWrites:false,mediaGenerated:false,
    limitation:'File identity/size/time comparison of existing assets, not full rehash; no Eagle interaction.'}));
  }
 } catch(e) {try{console.log(store.save('audit',{protocol:'t2-empty-writer-failure-v1',mode,error:String(e.stack),retainedDirectory:own}));}catch(_){}throw e;}
 finally {store.close();if(!success&&own)console.error('Retained bounded scratch:',own);}
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
