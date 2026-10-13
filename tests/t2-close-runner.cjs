'use strict';
// Safety boundaries of the explicit diagnostic, no real media/cache writes.
const assert = require('assert'), path = require('path');
const { _test: { selectedInput, validateInventory, limitedTransaction } } = require('../scripts/verify-t2-close.cjs');
const input = selectedInput({ sources: [{ key: 'baseline', file: path.join(__dirname, 'library/images/old.info/old.mp4') }] });
assert.equal(input.itemId, 'MV6H7OK0MBGX2');
assert.equal(path.basename(input.file), '喜多郁代.mp4');
assert.equal(path.basename(path.dirname(input.file)), 'MV6H7OK0MBGX2.info');
assert.throws(() => selectedInput({ sources: [] }), /registered/);
validateInventory({ usedBytes: 0, diskLimitBytes: 5 * 1024 ** 3, leases: [] });
assert.throws(() => validateInventory({ usedBytes: 0, diskLimitBytes: 5 * 1024 ** 3, leases: [{}] }), /no live lease/);
assert.throws(() => validateInventory({ usedBytes: 5 * 1024 ** 3, diskLimitBytes: 5 * 1024 ** 3, leases: [] }), /free cache budget/);
assert.throws(() => validateInventory({ leases: [] }), /free cache budget/);
let bytes = 0;
const tx = limitedTransaction({ writeAsset(_n, data) { bytes += data.length; },
  openAsset() { return { append(data) { bytes += data.length; }, patch() {}, close() {} }; } }, 4);
tx.writeAsset('one', Buffer.alloc(2)); tx.openAsset('two').append(Buffer.alloc(2));
assert.equal(bytes, 4);
assert.throws(() => tx.openAsset('three').append(Buffer.alloc(1)), /fixed asset budget/);
assert.throws(() => tx.writeAsset('four', Buffer.alloc(1)), /fixed asset budget/);
assert.equal(bytes, 4);
console.log('T2 close-runner safety: scoped sample, no-eviction headroom, active leases and combined stream/asset budget checked; no real media generated.');
