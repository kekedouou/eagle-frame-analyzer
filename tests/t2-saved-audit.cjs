'use strict';
const assert=require('assert'),{_test:{recordedFrames}}=require('../scripts/verify-t2-cache.cjs');
const s={frames:3,manifestSha256:'a'.repeat(64),manifestBytes:100},r=ids=>({value:{type:'round',trace:{frameIds:ids}}});
const good=recordedFrames(s,[r([0,1,2]),r([0,1,2])]);assert(!good.liveVerified);assert.equal(good.info.frames.length,3);
for(const rows of [[],[r([0,1])],[r([0,1,1])],[r([0,1,2]),r([0,2,1])],[r([0,1,'2'])]])assert.throws(()=>recordedFrames(s,rows));
assert(!recordedFrames({...s,interruptedTrace:{frameIds:[0,1,2]}},[]).liveVerified);
console.log('Saved-only audit models: consistent complete frame IDs required; live manifest is never claimed; no cache writes.');
