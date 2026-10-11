'use strict';

const assert = require('assert');
const { ManualTrace } = require('./support/t0-manual-trace.cjs');
let passed = 0;
function test(name, work) { work(); passed++; console.log('ok ' + name); }
function accounting(value) {
  const n = value.retained + value.evictedByTime + value.evictedByBytes + value.evictedByCount + value.rejectedOversize + value.rejectedInvalid;
  assert.strictEqual(n, value.seen);
}
test('Defaults and independent input/output snapshots', () => {
  const trace = new ManualTrace(), original = { type: 'input', at: 5, inputId: 1, nested: { target: 8 } };
  trace.append(original); original.nested.target = 100;
  const first = trace.snapshot(10); assert.strictEqual(first.events[0].nested.target, 8);
  first.events[0].nested.target = -1; first.trace.eventCounts.input = -1;
  assert.strictEqual(trace.snapshot(11).events[0].nested.target, 8);
  trace.append({ type: 'draw', at: 12 }); assert.strictEqual(first.events.length, 1);
  assert.strictEqual(first.trace.limits.eventBytes, 384 * 1024);
});
test('Idle save and memory sampling do not remove the last interaction', () => {
  const trace = new ManualTrace({ windowMs: 100 }); trace.reset(10);
  trace.append({ type: 'input', at: 20, inputId: 1 });
  trace.sample({ at: 10000, rss: 100 });
  const saved = trace.snapshot(20000); assert.strictEqual(saved.events.length, 1);
  assert.strictEqual(saved.trace.coverage.windowEnd, 20); assert.strictEqual(saved.trace.coverage.savedAt, 20000);
});
test('Time expiry records omitted history without stopping the tail', () => {
  const trace = new ManualTrace({ windowMs: 100 });
  for (let at = 0; at <= 1000; at += 10) trace.append({ type: 'input', at, inputId: at });
  const saved = trace.snapshot(1001); assert(saved.truncated); assert.strictEqual(saved.events[0].at, 900);
  assert.strictEqual(saved.events[saved.events.length - 1].at, 1000); assert(saved.trace.coverage.tailComplete);
  assert.strictEqual(saved.trace.counters.events.evictedByTime, 90); accounting(saved.trace.counters.events);
});
test('Byte expiry retains the newest records and bounds long recordings', () => {
  const trace = new ManualTrace({ windowMs: 1000000, eventBytes: 1024 });
  for (let at = 0; at < 20000; at++) trace.append({ type: 'input', at, inputId: at, payload: 'x'.repeat(40) });
  const saved = trace.snapshot(20000); assert(saved.trace.storedBytesEstimate <= 1024);
  assert.strictEqual(saved.events[saved.events.length - 1].at, 19999);
  assert(trace.events.rows.length < 300); assert(saved.trace.counters.events.evictedByBytes > 19000); accounting(saved.trace.counters.events);
});
test('Oversized or invalid records are counted and do not disable later recording', () => {
  const trace = new ManualTrace({ eventBytes: 512 });
  trace.append({ type: 'input', at: 1 });
  assert.strictEqual(trace.append({ type: 'input', at: 2, large: 'x'.repeat(1000) }), false);
  assert.strictEqual(trace.snapshot(3).trace.coverage.tailComplete, false);
  const circular = { at: 3 }; circular.self = circular;
  assert.strictEqual(trace.append(circular), false); assert.strictEqual(trace.append({ at: NaN }), false);
  assert.strictEqual(trace.append({ type: 'draw', at: 4 }), true);
  const saved = trace.snapshot(5); assert(saved.trace.coverage.tailComplete); assert.strictEqual(saved.trace.counters.events.rejectedOversize, 1);
  assert.strictEqual(saved.trace.counters.events.rejectedInvalid, 2); accounting(saved.trace.counters.events);
});
test('Memory has independent count and byte caps, with lifetime peaks', () => {
  const trace = new ManualTrace({ sampleLimit: 2, sampleBytes: 512 });
  trace.sample({ at: 1, rss: 900, managed: 800 }); trace.sample({ at: 2, rss: 500, managed: 400 }); trace.sample({ at: 3, rss: 300, managed: 200 });
  const saved = trace.snapshot(4); assert.deepStrictEqual(saved.memorySamples.map(row => row.at), [2, 3]);
  assert.strictEqual(saved.trace.peaks.rendererRssBytes.bytes, 900); assert.strictEqual(saved.trace.peaks.managedSampleBytes.bytes, 800);
  assert.strictEqual(saved.trace.counters.memorySamples.evictedByCount, 1); accounting(saved.trace.counters.memorySamples);
  assert.strictEqual(trace.sample({ at: 4, large: 'x'.repeat(1000) }), false);
  accounting(trace.snapshot(5).trace.counters.memorySamples);
});
test('Late timestamps cannot hide expired interior rows', () => {
  const trace = new ManualTrace({ windowMs: 100 });
  [100, 80, 190].forEach(at => trace.append({ type: 'input', at }));
  assert.deepStrictEqual(trace.snapshot(195).events.map(row => row.at), [100, 190]);
  trace.reset(0);
  [100, 80, 150, 225].forEach(at => trace.append({ type: 'input', at }));
  const saved = trace.snapshot(230); assert.deepStrictEqual(saved.events.map(row => row.at), [150, 225]);
  assert.strictEqual(saved.trace.counters.events.evictedByTime, 2); accounting(saved.trace.counters.events);
});
test('Cut request chains are labelled rather than reported as complete-run failures', () => {
  const trace = new ManualTrace({ windowMs: 10 });
  trace.append({ type: 'input', at: 0, inputId: 1 }); trace.append({ type: 'input-end', at: 20, inputId: 1, status: 'drawn' });
  const saved = trace.snapshot(21); assert.strictEqual(saved.trace.coverage.boundary.terminalsWithoutRetainedInput, 1);
  assert(saved.trace.coverage.partialChainsPossible); assert(!('normalThresholdsMet' in saved));
});
test('Counter names and default payload estimate remain bounded', () => {
  const trace = new ManualTrace();
  for (let at = 0; at < 10000; at++) trace.append({ type: 'dynamic-' + at, at, payload: 'x'.repeat(300) });
  for (let at = 0; at < 1000; at++) trace.sample({ at, rss: at, managed: at });
  const saved = trace.snapshot(10001); assert(saved.trace.storedBytesEstimate <= 480 * 1024);
  assert(Object.keys(saved.trace.eventCounts).length <= 65); assert(Buffer.byteLength(JSON.stringify(saved, null, 2), 'utf8') < 2 * 1024 ** 2);
  accounting(saved.trace.counters.events); accounting(saved.trace.counters.memorySamples);
});
test('Reset clears counters and peaks, without mutating earlier snapshots', () => {
  const trace = new ManualTrace(); trace.append({ type: 'draw', at: 1, cachePeakBytes: 100 }); trace.sample({ at: 2, rss: 200 });
  const before = trace.snapshot(3); trace.reset(50); const after = trace.snapshot(51);
  assert.strictEqual(after.events.length, 0); assert.strictEqual(after.memorySamples.length, 0); assert.deepStrictEqual(after.trace.peaks, {});
  assert.strictEqual(after.trace.coverage.sessionBegin, 50); assert.strictEqual(before.trace.peaks.rendererRssBytes.bytes, 200);
  assert.throws(() => new ManualTrace({ sampleLimit: 0 })); assert.throws(() => trace.reset(NaN));
});
console.log('T0 manual trace pure tests passed: ' + passed + '. No filesystem/Eagle access.');
