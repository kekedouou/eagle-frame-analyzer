'use strict';
const assert = require('assert'), { compactDecoder, encode, decode, recorder, MAX } = require('./support/long-trace.cjs');
const ticks = '639277190890972699';
function native(atMs = 0) { return { schema: 'mvp-process-sample-v1', atMs, sampleDurationMs: 1.2345, errors: [],
  roots: [{ pid: 1, startTicks: ticks, role: 'renderer', alive: true }],
  processes: [{ pid: 1, startTicks: ticks, role: 'renderer', root: '1:' + ticks, image: 'Eagle.exe', imagePath: 'G:\\Assets\\Eagle\\Eagle.exe', rssBytes: 409600000, cpuMs: 234.375 }] }; }
const first = native(), wire = { schema: 'mvp-process-compact-v1', atMs: first.atMs, sampleDurationMs: first.sampleDurationMs, errors: [],
  additions: [[0, 1, ticks, 'renderer', '1:' + ticks, 'Eagle.exe', 'G:\\Assets\\Eagle\\Eagle.exe']], roots: [[0, true]], processes: [[0, 409600000, 234.375]] };
const expand = compactDecoder(); assert.deepStrictEqual(expand(wire), first);
assert.deepStrictEqual(expand({ ...wire, atMs: 100.1234, additions: [] }), { ...first, atMs: 100.1234 });
assert.throws(() => expand(wire), /catalogue/); assert.throws(() => compactDecoder()({ ...wire, processes: [[2, 1, 0]] }), /Unknown/);
assert.throws(() => compactDecoder()({ ...wire, additions: [[0, 1, Number(ticks), 'renderer', '1:' + ticks, 'Eagle.exe', 'G:\\Eagle.exe']] }), /creation/);
const events = [{ kind: 'native', native: first, receivedAtMs: 100.300000001, context: { elapsedMs: null, phase: 'warm', sample: 0 } },
  { kind: 'renderer', row: [123.4000000001, 'drag', 1, 409600000, null, 15625.25, 2, 1, 123, 3, 0, 0] }];
assert.deepStrictEqual(decode(encode(events, 0)), events);
// Fixed payload written by the old v1 writer; do not regenerate with v2.
const old = { schema: 'mvp-long-resource-chunk-v1', index: 0,
  processes: [[1, ticks, 'renderer', '1:' + ticks, 'Eagle.exe', 'G:\\Assets\\Eagle\\Eagle.exe']], roots: [[1, ticks, 'renderer']],
  encoding: 'lossless-binary-base64-v1', events: 1, data: 'AAQURjQzMxNZQAEABHdhcm0BAAEABfLAAQEAAALAmgwDsOoBAQABAA==' };
assert.deepStrictEqual(decode(old), [events[0]]);
const diagnostic = { pid: 2, reason: 'Win32Exception', operation: 'child-image', message: 'Process image query failed.',
  nativeErrorCode: 5, parentPid: 1, startTicks: ticks, exitCheck: 'alive', exitCheckErrorCode: null };
const withContext = { ...events[0], native: { ...first, errors: [diagnostic] } };
assert.deepStrictEqual(decode(encode([withContext], 0)), [withContext]);
assert.deepStrictEqual(compactDecoder()({ ...wire, errors: [diagnostic] }).errors, [diagnostic]);
for (const value of [0.0001, 123.4567, 1.000000000000001, 3900000.1234]) {
  const data = { ...events[0], native: { ...first, atMs: value, sampleDurationMs: value, processes: [{ ...first.processes[0], cpuMs: value }] }, receivedAtMs: value,
    context: { elapsedMs: value, phase: 'drag', sample: 1 } };
  assert.deepStrictEqual(decode(encode([data, { ...data, native: { ...data.native, atMs: value + 100 } }], 0)), [data, { ...data, native: { ...data.native, atMs: value + 100 } }]);
}
const bad = encode(events, 0); bad.processes = []; assert.throws(() => decode(bad));
assert.throws(() => decode({ ...encode(events, 0), data: '!!!!' }));
assert.throws(() => decode({ ...encode(events, 0), data: encode(events, 0).data.slice(0, -4) }));
const saved = [], records = recorder({ save(kind, payload) { saved.push(payload); return { index: saved.length }; } });
for (const event of events) records.append(event); records.flush(); assert.equal(saved.length, 1); assert.deepStrictEqual(decode(saved[0]), events);
assert.equal(records.summary().pendingEvents, 0);
const delayedPayloads = [], delayed = recorder({ save(kind, payload) { delayedPayloads.push(payload); return { index: delayedPayloads.length }; } }, { deferred: true });
const zlib = require('zlib'), originalCompress = zlib.brotliCompressSync; let compressCalls = 0;
try {
  zlib.brotliCompressSync = (...args) => { compressCalls++; return originalCompress(...args); };
  for (let i = 0; i < 4000; i++) delayed.append(events[0]);
  assert.equal(compressCalls, 0); assert.equal(delayedPayloads.length, 0);
  assert.throws(() => delayed.append(events[0]), /短回归记录超过/);
  assert.equal(delayed.summary().pendingEvents, 4000); assert.equal(delayed.summary().limits.chunks, 2);
  delayed.flush(); assert(compressCalls > 0); assert.equal(delayed.summary().pendingEvents, 0);
  assert.equal(delayedPayloads.reduce((n, p) => n + decode(p).length, 0), 4000);
} finally { zlib.brotliCompressSync = originalCompress; }
let attempts = 0; const broken = recorder({ save() { attempts++; throw Error('model-full'); } }); broken.append(events[0]);
assert.throws(() => broken.flush(), /model-full/); assert.throws(() => broken.flush(), /model-full/); assert.equal(attempts, 1); assert.equal(broken.summary().pendingEvents, 1);
let cappedSlots = 0; const capped = recorder({ save() { return { slot: ++cappedSlots }; } });
for (let i = 0; i < MAX.chunks; i++) { capped.append(events[0]); capped.flush(); }
capped.append(events[0]); assert.throws(() => capped.flush(), /11槽/); assert.equal(cappedSlots, 11); assert.equal(capped.summary().pendingEvents, 1);
// Capacity simulation only: no timers, OS sampling, files or real 65-minute test.
// Plausible independently varying counters make the compression test nontrivial.
let seed = 12345, slots = 0, rawNative = 0, rawRenderer = 0;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const long = recorder({ save(kind, payload) {
  slots++; for (const e of decode(payload)) { if (e.kind === 'native') rawNative++; else rawRenderer++; }
  return { slot: slots };
} });
for (let i = 0; i < 39200; i++) {
  const row = native(i * 100 + (random() % 1000) / 10000); row.sampleDurationMs = 3 + (random() % 10000) / 10000;
  row.processes[0].rssBytes += (random() % 16) * 4096; row.processes[0].cpuMs += i * 15.625;
  for (let id = 2; id <= 6; id++) row.processes.push({ ...row.processes[0], pid: id, startTicks: String(BigInt(ticks) + BigInt(id)),
    role: id === 2 ? 'task-guard' : id === 3 ? 'task-worker' : 'console-host', image: id === 2 ? 'task-host.local.exe' : id === 3 ? 'Eagle.exe' : 'conhost.exe',
    rssBytes: 20 * 1024 ** 2 + random() % 16 * 4096, cpuMs: i * 15.625 + id * 31.25 });
  const phase = i >= 36000 ? 'idle' : i % 600 < 200 ? 'drag' : i % 600 < 350 ? 'play' : i % 600 < 400 ? 'step' : 'load', sample = Math.floor(i / 600) % 2;
  long.append({ kind: 'native', native: row, receivedAtMs: row.atMs + 10.3000000001, context: { elapsedMs: i * 100, phase, sample } });
  long.append({ kind: 'renderer', row: [i * 100 + .5000000001, phase, sample, row.processes[0].rssBytes, 100000000 + random() % 10000,
    i * 15625.25, i % 2, i % 2, i * 3, Math.floor(i / 600), 1, 0] });
}
long.flush(); assert.equal(rawNative, 39200); assert.equal(rawRenderer, 39200); assert(slots <= MAX.chunks);
console.log('long trace: v1 compatibility, v2 exact counters/identities, malformed catalogue rejection, bounded no-retry persistence and 39200+39200 synthetic rows fit ' + slots + '/11 slots; capacity model only.');
