'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { candidate } = require('./support/ram-diagnostic.cjs');
const original = fs.readFileSync(path.join(__dirname, '../plugin/player.js'), 'utf8');
const formal = require('../plugin/player.js'), index = require('../plugin/frame-index.cjs');
assert.throws(() => new formal.Budget(1024 ** 3));
for (const mib of [512, 1024]) {
  const c = candidate(original, mib), m = { exports: {} };
  vm.runInNewContext(c.source, { module: m, console });
  const b = new m.exports.Budget(c.options.ramBytes), t = b.reserve(c.options.ramBytes, 'test');
  assert.throws(() => b.reserve(1, 'overshoot')); b.release(t); assert.equal(b.snapshot().used, 0);
  const options = { ...c.options, frameIndex: index, canvas: { getContext: () => ({}) }, readAsset: async () => new Uint8Array(),
    env: { raf: () => 0, caf: () => {}, now: () => 0 } };
  const p = new m.exports.Player(options);
  assert.equal(p.snapshot().budget.limit, mib * 1024 ** 2);
  assert.equal(p.compressedLimit, mib * 1024 ** 2 / 8);
  assert.throws(() => new m.exports.Player({ ...options, ramBytes: 1024 ** 3 + 1 }));
  assert.throws(() => new m.exports.Player({ ...options, compressedRamBytes: 128 * 1024 ** 2 + 1 }));
}
assert.throws(() => candidate(original, 2048));
assert.throws(() => candidate(original.replace('const RAM_LIMIT =', 'const CHANGED ='), 1024));
assert.throws(() => candidate(original + '\nconst RAM_LIMIT = 512 * 1024 * 1024;', 1024));
assert.equal(fs.readFileSync(path.join(__dirname, '../plugin/player.js'), 'utf8'), original);
console.log('T2 RAM diagnostic: two bounded captures, proportional pools, real ledger overflow/release and changed-source refusal; formal default unchanged.');
