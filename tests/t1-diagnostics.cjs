'use strict';
const assert = require('assert');
const vm = require('vm');
const { createDiagnostics, LIMITS } = require('../plugin/diagnostics.cjs');
let count = 0;
function test(name, work) { work(); count++; console.log('ok T1 diagnostics: ' + name); }
test('public API is frozen and exposes observation only', () => {
  const d = createDiagnostics({ snapshot: () => null });
  assert(Object.isFrozen(d)); assert(Object.isFrozen(d.public));
  assert.deepStrictEqual(Object.keys(d.public), ['snapshot', 'subscribe']);
  assert.strictEqual(d.public.snapshot(), null); assert.throws(() => createDiagnostics());
});
test('unsubscribed lazy publication never evaluates or copies values', () => {
  const d = createDiagnostics({ snapshot: () => null }); let calls = 0;
  assert.strictEqual(d.publish('player', () => { calls++; throw new Error('must not run'); }), false);
  assert.strictEqual(calls, 0);
});
test('snapshot and publications are detached deeply frozen data', () => {
  const source = { source: { id: '中文 空格' }, items: [{ time: 1 }] }, d = createDiagnostics({ snapshot: () => source });
  const result = d.public.snapshot(); source.items[0].time = 2;
  assert.strictEqual(result.items[0].time, 1); assert(Object.isFrozen(result.items[0]));
  let event; d.public.subscribe(value => { event = value; }); d.publish('state', source);
  assert(Object.isFrozen(event)); assert(Object.isFrozen(event.value.source)); assert.strictEqual(event.value.items[0].time, 2);
  assert.throws(() => { event.value.items[0].time = 3; }); assert.strictEqual(source.items[0].time, 2);
});
test('unsubscribe and subscriber exceptions are isolated', () => {
  const d = createDiagnostics({ snapshot: () => null }); let seen = 0;
  const bad = d.public.subscribe(() => { throw new Error('observer failure'); });
  const off = d.public.subscribe(() => { seen++; });
  assert(d.publish('player', { event: { at: 1 } })); assert.strictEqual(seen, 1);
  off(); off(); bad(); assert.strictEqual(d.publish('state', null), false); assert.strictEqual(seen, 1);
});
test('oversized, cyclic, executable and instance values are refused safely', () => {
  const d = createDiagnostics({ snapshot: () => ({}) }); let seen = 0; d.public.subscribe(() => { seen++; });
  const cycle = {}; cycle.self = cycle;
  for (const value of [cycle, { action() {} }, new Date(), { text: 'x'.repeat(LIMITS.stringBytes + 1) }, { value: Infinity }, Array(LIMITS.nodes + 1).fill(1)])
    assert.strictEqual(d.publish('player', value), false);
  assert.strictEqual(d.publish('invalid type', {}), false); assert.strictEqual(seen, 0);
  assert.strictEqual(d.publish('state', { valid: true }), true); assert.strictEqual(seen, 1);
});
test('subscribe limit and removal during publication remain bounded', () => {
  const d = createDiagnostics({ snapshot: () => null }), unsub = [];
  for (let n = 0; n < LIMITS.subscribers; n++) unsub.push(d.public.subscribe(() => {}));
  assert.throws(() => d.public.subscribe(() => {})); unsub.forEach(off => off());
  let calls = 0, offLater;
  d.public.subscribe(() => offLater()); offLater = d.public.subscribe(() => { calls++; });
  d.publish('state', {}); assert.strictEqual(calls, 0);
});
test('property named proto cannot mutate output prototype', () => {
  const source = JSON.parse('{"__proto__":{"x":1},"constructor":"data"}');
  const result = createDiagnostics({ snapshot: () => source }).public.snapshot();
  assert.strictEqual(Object.getPrototypeOf(result), Object.prototype); assert.strictEqual(result.__proto__.x, 1);
  assert.strictEqual({}.x, undefined);
});
test('renderer-realm plain objects are copied without exporting their prototypes', () => {
  const source = vm.runInNewContext('({state:"paused", frame:{time:1}, values:[1,2]})');
  const value = createDiagnostics({ snapshot: () => source }).public.snapshot();
  assert.strictEqual(value.frame.time, 1); assert.strictEqual(Object.getPrototypeOf(value), Object.prototype);
  assert(Object.isFrozen(value.values));
});
console.log('T1 diagnostics: ' + count + ' pure checks passed; no Eagle or media executed.');
