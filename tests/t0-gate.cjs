'use strict';
const assert = require('assert');
const { Capture, LIMITS, unpack, fileSize } = require('./support/t0-gate.cjs');
let passed = 0;
async function test(name, work) { await work(); passed++; console.log('ok gate ' + name); }
function request(c, id, at, index = id, kind = 'rapid') {
  c.append({ type: 'input', at, inputId: id, targetTime: index / 60, frameOrdinal: index, kind });
  c.append({ type: 'request', phase: 'input', at, epoch: 1, requestId: id, inputId: id, frameId: index, kind });
}
function draw(c, id, at, index = id, inputAt = at - 4) {
  c.append({ type: 'draw', at, drawAt: at, inputAt, epoch: 1, requestId: id, inputId: id, frameId: index, rafOpportunity: id, commitSource: 'raf' });
  c.append({ type: 'input-end', at: at + .1, inputId: id, requestId: id, status: 'drawn' });
}
(async () => {
  await test('lossless timestamps and original terminal identities', async () => {
    const c = new Capture(), stamp = 12345.70000000298;
    request(c, 1, stamp); draw(c, 1, stamp + 4, 1, stamp);
    const packed = await c.pack(), events = unpack(packed);
    assert.strictEqual(events[0].at, stamp); assert.strictEqual(events[3].status, 'drawn');
    const summary = c.summarize(stamp, stamp + 100, { kind: 'rapid', delayMs: 0 });
    assert(summary.valid); assert.strictEqual(summary.terminals.drawn, 1); assert.strictEqual(summary.requestToDraw.p95Ms, 4);
    assert.strictEqual(summary.normalThresholdsMet, false, 'single fast draw is not sufficient update rate');
    assert.throws(() => unpack({ ...packed, rawSha256: 'bad' }), /integrity/);
    assert.throws(() => unpack({ ...packed, rows: 500 }), /row count/);
    assert.throws(() => unpack({ ...packed, rawBytes: LIMITS.rawBytes + 1 }), /bounded/);
  });
  await test('incomplete, stale, wrong request and duplicate refresh fail', async () => {
    const c = new Capture(); request(c, 1, 0); draw(c, 1, 4, 2);
    c.append({ type: 'draw', drawAt: 5, inputAt: 0, epoch: 1, requestId: 1, inputId: 1, frameId: 2, rafOpportunity: 1, stale: true });
    request(c, 2, 8);
    const s = c.summarize(0, 30, { kind: 'rapid' });
    assert(!s.valid); assert(s.invalidDrawRequests); assert(s.staleSubmissions); assert(s.duplicateRafSubmissions); assert(s.terminals.unfinished);
  });
  await test('pressure cannot receive normal-rate pass and retains cancellations', async () => {
    const c = new Capture(); request(c, 1, 0);
    c.append({ type: 'input-end', at: 3, inputId: 1, status: 'cancelled', requestId: 1 });
    c.append({ type: 'cache', phase: 'image-work-start', activeImageTasks: 3 });
    const s = c.summarize(0, 30, { kind: 'rapid', delayMs: 60 });
    assert.strictEqual(s.normalThresholdsMet, null); assert(!s.valid); assert.strictEqual(s.maxImageTasksObserved, 3);
    assert.strictEqual(s.terminals.cancelled, 1);
  });
  await test('requested source ordinal cannot be remapped to another cached frame', async () => {
    const c = new Capture([50, 60]); request(c, 1, 0, 0); draw(c, 1, 4, 0, 0);
    const s = c.summarize(0, 10, { kind: 'rapid' });
    assert.strictEqual(s.frameIdentityMismatches, 1); assert(!s.valid);
  });
  await test('async compression freezes the exact row snapshot before awaiting', async () => {
    const c = new Capture(); request(c, 1, 0); draw(c, 1, 4, 1, 0);
    const pending = c.pack(); request(c, 2, 10); const trace = await pending;
    assert.strictEqual(trace.rows, 4); assert.strictEqual(unpack(trace).length, 4);
    assert.strictEqual(unpack(trace).filter(e => e.type === 'input').length, 1);
  });
  await test('independent kind, reused inputs and separate resource scopes', async () => {
    const c = new Capture(); request(c, 1, 0, 10, 'random-seek'); draw(c, 1, 4, 10, 0);
    request(c, 2, 10, 10, 'random-seek'); c.append({ type: 'input-end', at: 10.1, inputId: 2, status: 'reused', requestId: 2 });
    c.append({ type: 'memory', at: 5, rss: 700, managed: 512 });
    const s = c.summarize(0, 20, { kind: 'independent' });
    assert(s.valid); assert.strictEqual(s.inputs, 2); assert.strictEqual(s.terminals.reused, 1);
    assert.strictEqual(s.requestToDraw.n, 1); assert.strictEqual(s.resources.rendererRssSamplePeakBytes, 700);
    assert.strictEqual(s.resources.managedSamplePeakBytes, 512);
  });
  await test('bounded raw trace never silently becomes passing', async () => {
    const c = new Capture();
    for (let n = 0; n < 10000; n++) c.append({ type: 'error', at: n, phase: 'test', error: '长'.repeat(200) });
    const packed = await c.pack(); assert(packed.truncated); assert(packed.rawBytes <= LIMITS.rawBytes);
    assert(!c.summarize(0, 10000, { kind: 'rapid' }).valid);
  });
  await test('3600 inputs with two decodes each fit per-round compressed envelope', async () => {
    const c = new Capture(), begin = 123456.70000000298;
    for (let n = 0; n < 3600; n++) {
      const at = begin + n * 1000 / 120, id = 10000 + n;
      request(c, id, at, n % 1490);
      for (let j = 0; j < 2; j++) c.append({ type: 'ready', phase: 'read-and-image-decode-complete', at: at + 2.70000000298,
        epoch: 1, frameId: n % 1490 + j, readMs: 0, decodeMs: 3.10000000149, stillTarget: true, assetSource: 'compressed-ram',
        readStartedAt: at, readEndedAt: at, decodeStartedAt: at, decodeEndedAt: at + 3.10000000149,
        requestId: id, kind: 'rapid', inputAt: at, injectedDelayMs: 0, decoderServiceMs: 3.10000000149 });
      c.append({ type: 'ready', phase: 'effective-target-available', at: at + 4, epoch: 1, requestId: id,
        frameId: n % 1490, inputAt: at, readyAt: at + 3.10000000149, cachedDecodeReadyAt: at + 3.10000000149, cacheHit: false, kind: 'rapid' });
      draw(c, id, at + 4, n % 1490, at);
      c.append({ type: 'cache', phase: 'image-work-start', activeImageTasks: 2 });
    }
    const trace = await c.pack(), size = fileSize({ trace, metadataAllowance: 'x'.repeat(32768) });
    assert(!trace.truncated); assert.strictEqual(unpack(trace).filter(e => e.type === 'input').length, 3600);
    assert(size <= LIMITS.fileBytes); assert(size * 9 + 300000 <= LIMITS.sessionBytes, 'nine full traces plus small prepare/random summaries fit session sizing fixture');
    console.log('sizing-only 30s synthetic trace: ' + size + ' bytes; no Eagle performance measurement');
  });
  console.log('T0 full-gate pure tests passed: ' + passed);
})().catch(error => { console.error(error); process.exitCode = 1; });
