'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { candidate, rssLimit, activate, hostRssLimit } = require('./support/ram-diagnostic.cjs');
const original = fs.readFileSync(path.join(__dirname, '../plugin/player.js'), 'utf8');
const formal = require('../plugin/player.js'), index = require('../plugin/frame-index.cjs');
assert.equal(new formal.Budget(1024 ** 3).snapshot().limit, 1024 ** 3);
for (const mib of [512, 1024, 2048]) {
  const c = candidate(original, mib, { host2GiB:mib===2048 }), m = { exports: {} };
  vm.runInNewContext(c.source, { module: m, console });
  const b = new m.exports.Budget(c.options.ramBytes), t = b.reserve(c.options.ramBytes, 'test');
  assert.throws(() => b.reserve(1, 'overshoot')); b.release(t); assert.equal(b.snapshot().used, 0);
  const options = { ...c.options, frameIndex: index, canvas: { getContext: () => ({}) }, readAsset: async () => new Uint8Array(),
    env: { raf: () => 0, caf: () => {}, now: () => 0 } };
  const p = new m.exports.Player(options);
  assert.equal(p.snapshot().budget.limit, mib * 1024 ** 2);
  assert.equal(p.compressedLimit, mib * 1024 ** 2 / 8);
  assert.throws(() => new m.exports.Player({ ...options, ramBytes: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => new m.exports.Player({ ...options, compressedRamBytes: c.options.compressedRamBytes + 1 }));
}
assert.throws(() => candidate(original, 2048));
assert.throws(() => candidate(original,4096,{host2GiB:true}));
assert.throws(() => candidate(original.replace('const RAM_LIMIT = 1024 * 1024 * 1024;','const RAM_LIMIT = 512 * 1024 * 1024;'),2048,{host2GiB:true}));
const host2={schema:'T2-ram-host-v2',ramMiB:2048,compressedMiB:256,rendererStopMiB:3072};
assert.equal(hostRssLimit(null),1.5*1024**3);assert.equal(hostRssLimit({schema:'T2-ram-host-v1',ramMiB:1024,compressedMiB:128}),1.5*1024**3);
assert.equal(hostRssLimit(host2),3*1024**3);
for(const changed of [{rendererStopMiB:4096},{rendererStopMiB:1536},{ramMiB:4096},{compressedMiB:128},{schema:'T2-ram-host-v1'}])assert.throws(()=>hostRssLimit({...host2,...changed}));
assert.throws(() => candidate(original.replace('const RAM_LIMIT =', 'const CHANGED ='), 1024));
assert.throws(() => candidate(original + '\nconst RAM_LIMIT = 512 * 1024 * 1024;', 1024));
assert.equal(rssLimit([]), 1.5 * 1024 ** 3);
assert.equal(rssLimit(['--ram-compare', '--rss-stop-mib=2048']), 2 * 1024 ** 3);
assert.throws(() => rssLimit(['--rss-stop-mib=2048']));
assert.throws(() => rssLimit(['--ram-compare', '--rss-stop-mib=4096']));
assert.throws(() => rssLimit(['--ram-compare', '--rss-stop-mib=2048', '--rss-stop-mib=2048']));
const win = {};
win.eval = text => vm.runInNewContext(text, { window: win, console });
const capture = activate(win, original, 1024);
const live = new win.EVAPlayer.Player({ ramBytes: 1, compressedRamBytes: 0, frameIndex: index,
  canvas: { getContext: () => ({}) }, readAsset: async () => new Uint8Array(), env: { raf: () => 0, now: () => 0 } });
assert.equal(live.snapshot().budget.limit, 1024 ** 3);
assert.equal(live.compressedLimit, 128 * 1024 ** 2);
assert.equal(capture.options.ramBytes, 1024 ** 3);
const captured2=activate(win,original,2048,{host2GiB:true});
const live2=new win.EVAPlayer.Player({frameIndex:index,canvas:{getContext:()=>({})},readAsset:async()=>new Uint8Array(),env:{raf:()=>0,now:()=>0}});
assert.equal(live2.snapshot().budget.limit,2*1024**3);assert.equal(live2.compressedLimit,256*1024**2);assert.equal(captured2.source,original);
assert.throws(() => activate({}, original, 1024));
assert.equal(fs.readFileSync(path.join(__dirname, '../plugin/player.js'), 'utf8'), original);
console.log('T2 RAM diagnostic: bounded captures and explicit 2GiB host/3GiB renderer tuple, proportional pools/ledger and source guards; independent Chrome and formal defaults unchanged.');
