'use strict';
const assert = require('assert'), { ordinals, pixelDifference } = require('./support/window-frame-reference.cjs');
assert.deepStrictEqual(ordinals(1), [0]); assert.equal(ordinals(1596).length, 24); assert.equal(ordinals(1596)[23], 1595);
assert.throws(() => ordinals(0)); assert.throws(() => ordinals(1.5));
assert(pixelDifference(Buffer.from([0, 10, 255]), Buffer.from([0, 10, 255])).exact);
assert.deepStrictEqual(pixelDifference(Buffer.from([0, 10]), Buffer.from([1, 8])), { changedChannels: 2, maxChannelDifference: 2, exact: false });
assert.throws(() => pixelDifference(Buffer.from([1]), Buffer.alloc(0)));
console.log('window-frame-reference: sample bounds and exact pixel mismatch detection; model only, no Canvas/Eagle/media executed.');
