'use strict';
const assert = require('assert');
const { createIdentity, _test } = require('../plugin/process-identity.cjs');
const parent = { pid: 10, startTicks: '638958000000000000', image: 'G:\\Eagle\\Eagle.exe' };
const child = { pid: 20, startTicks: '638958000010000000', image: 'G:\\Eagle\\ffmpeg.exe' };
const record = { processIdentity: parent, children: [{ state: 'running', identity: child }] };
let count = 0;
function test(name, fn) { fn(); count++; console.log('ok T2 process: ' + name); }
test('PID absence alone does not prove ownership or child termination', () => {
  assert(!_test.proveGone({ pid: 10 }, []).safe);
  assert(!_test.proveGone({ processIdentity: parent, children: [{ state: 'starting' }] }, []).safe);
  assert(!_test.proveGone({ processIdentity: parent, children: [{ state: 'running', identity: null }] }, []).safe);
});
test('original parent, child and possible descendant are all protected', () => {
  for (const rows of [[parent], [child], [{ pid: 30, parentPid: 20, startTicks: '638958000020000000' }]]) assert(!_test.proveGone(record, rows).safe);
});
test('recorded births distinguish a reused PID from the original instance', () => {
  assert(_test.proveGone(record, [{ ...parent, startTicks: '638958000100000000' }]).safe);
  assert(!_test.proveGone(record, [{ ...parent, startTicks: '638958000100000000' }, { pid: 30, parentPid: 10, startTicks: '638958000050000000' }]).safe);
  assert(_test.proveGone(record, [{ ...parent, startTicks: '638958000100000000' }, { pid: 30, parentPid: 10, startTicks: '638958000110000000' }]).safe);
});
test('missing or contradictory process identities preserve records', () => {
  assert(!_test.proveGone(record, [{ pid: 10 }]).safe);
  assert(!_test.proveGone(record, [{ ...parent, startTicks: '638957000000000000' }]).safe);
});
test('complete known parent and child death is eligible without terminating anything', () => {
  assert(_test.proveGone(record, []).safe);
  assert(_test.proveGone({ ...record, children: [{ state: 'closed', identity: null }] }, []).safe);
});
test('query failures are unknown; cached self identity does not invoke commands repeatedly', () => {
  let calls = 0; const provider = createIdentity({ pid: 10, query() { calls++; return [{ ...parent, parentPid: 1 }]; } });
  assert.deepStrictEqual(provider.self(), parent); provider.self(); assert.strictEqual(calls, 1);
  assert.strictEqual(provider.child(20), null);
  const failing = createIdentity({ query() { throw new Error('denied'); } }); assert.strictEqual(failing.self(), null); assert(!failing.inspect(record).safe);
});
console.log('T2 process: ' + count + ' pure checks passed; no OS process queried or terminated.');
