'use strict';
const assert = require('assert');
const { Capture, PROTOCOL, targets } = require('./support/t0-comparison.cjs');
let count = 0;
function test(name, body) { body(); count++; console.log('ok ' + name); }
function input(c, id, at, frame) {
  c.append({ type: 'input', at, inputId: id, targetTime: frame / 60, frameOrdinal: frame, kind: 'rapid' });
  c.append({ type: 'request', phase: 'input', at, epoch: 1, requestId: id, inputId: id, frameId: frame, kind: 'rapid' });
}
function draw(c, id, inputAt, at, frame, raf, extra = {}) {
  c.append({ type: 'draw', drawAt: at, epoch: 1, requestId: id, inputId: id, frameId: frame,
    inputAt, rafOpportunity: raf, commitSource: 'ready', ...extra });
}
function observe(c, id, inputAt, drawAt, at, frame, raf, distinct, submissions = 1) {
  c.append({ type: 'observation', observedAt: at, epoch: 1, requestId: id, frameId: frame, inputAt, drawAt,
    rafOpportunity: raf, distinctChanged: distinct, submissionsSinceLastObservation: submissions, latestAtObservation: true });
}
function end(c, id, at, status = 'drawn') { c.append({ type: 'input-end', at, inputId: id, requestId: id, status }); }
test('same seed fixes trajectory and source ordinals; no product thresholds changed', () => {
  assert.deepStrictEqual(targets(1490, 864), targets(1490, 864)); assert.equal(PROTOCOL.roundMs, 6000);
  assert.deepStrictEqual(PROTOCOL.modes, ['baseline', 'compressed-ram', 'ready-submit']);
  assert.equal(require('./support/t0-protocol.cjs').PROTOCOL.roundMs, 30000);
});
test('submissions overwritten before observation cannot inflate effective update rate', () => {
  const c = new Capture(); input(c, 1, 1, 7); draw(c, 1, 1, 4, 7, 1); end(c, 1, 4);
  input(c, 2, 5, 9); draw(c, 2, 5, 7, 9, 2); end(c, 2, 7); observe(c, 2, 5, 7, 8, 9, 2, true, 2);
  input(c, 3, 9, 7); draw(c, 3, 9, 10, 7, 3); end(c, 3, 10);
  input(c, 4, 11, 9); draw(c, 4, 11, 12, 9, 4); end(c, 4, 12); observe(c, 4, 11, 12, 16, 9, 4, false, 2);
  const r = c.finish(0, 20); assert(r.summary.valid); assert.equal(r.summary.counts.submissions, 4);
  assert.equal(r.summary.counts.distinctObservations, 1); assert.equal(r.summary.counts.overwrittenSubmissions, 2);
  assert.equal(r.summary.metrics.observedDistinctHz, 50); assert.equal(r.summary.metrics.submitLatency.p95Ms, 3);
  assert.equal(r.summary.metrics.observedLatency.p95Ms, 3); assert.equal(r.summary.officialAcceptance, false);
  assert.equal(JSON.parse(r.rowsJson).filter(row => row[0] === 0).length, 4);
});
test('coalesced and unfinished inputs reported separately; incomplete trace has no performance metrics', () => {
  const c = new Capture(); input(c, 1, 0, 1); input(c, 2, 1, 2); end(c, 1, 1, 'superseded');
  const r = c.finish(0, 6); assert.equal(r.summary.terminal.superseded, 1); assert.equal(r.summary.integrity.unfinished, 1);
  assert.equal(r.summary.valid, false); assert.equal(r.summary.metrics, null);
  const tiny = new Capture(30); input(tiny, 1, 1, 1); const tail = tiny.finish(0, 6);
  assert(tail.truncated); assert(tail.droppedRows > 0); assert.equal(tail.summary.metrics, null);
});
test('stale draw, duplicate refresh observations and duplicate terminals invalidate comparison', () => {
  const c = new Capture(); input(c, 1, 0, 1); draw(c, 1, 0, 1, 1, 1, { stale: true }); end(c, 1, 1); end(c, 1, 2);
  observe(c, 1, 0, 1, 3, 1, 1, true); observe(c, 1, 0, 1, 4, 1, 1, true);
  const r = c.finish(0, 6); assert(!r.summary.valid); assert.equal(r.summary.integrity.staleDraws, 1);
  assert.equal(r.summary.integrity.repeatedObservationRaf, 1); assert.equal(r.summary.integrity.duplicateTerminals, 1);
});
test('resource scopes and image read/decode distributions remain independent', () => {
  const c = new Capture(); input(c, 1, 0, 1); end(c, 1, 1, 'superseded');
  c.append({ type: 'ready', phase: 'read-and-image-decode-complete', at: 1, frameId: 1, readMs: 0, decodeMs: 4.5, assetSource: 'compressed-ram' });
  c.append({ type: 'ready', phase: 'read-and-image-decode-complete', at: 2, frameId: 2, readMs: 3, decodeMs: 6, assetSource: 'disk' });
  c.append({ type: 'memory', at: 1, rss: 800, external: 5, arrayBuffers: 3, managed: 512 });
  c.append({ type: 'cache', phase: 'image-work-start', at: 1, activeImageTasks: 2 });
  const r = c.finish(0, 6); assert(r.summary.valid); assert.equal(r.summary.metrics.readMs.meanMs, 1.5);
  assert.equal(r.summary.metrics.decodeMs.p95Ms, 6); assert.equal(r.summary.metrics.compressedReads, 1);
  assert.equal(r.summary.resources.rendererRssSamplePeakBytes, 800); assert.equal(r.summary.resources.managedSamplePeakBytes, 512);
  assert.equal(r.summary.resources.maxImageTasksObserved, 2);
});
test('full 864-input trace, two ready images per input and 144 observations per second fit bounded evidence', () => {
  const c = new Capture(), begin = 123456.70000000298, sequence = targets(1490, 864);
  for (let n = 0; n < sequence.length; n++) {
    const at = begin + n * 1000 / 144, id = n + 30000; input(c, id, at, sequence[n]);
    for (let t = 0; t < 2; t++) {
      c.append({ type: 'ready', phase: 'read-and-image-decode-complete', at: at + 3.40000000596,
        epoch: 1, frameId: sequence[n] + t, readMs: 2.70000000298, decodeMs: 4.5000000149,
        stillTarget: true, assetSource: 'compressed-ram' });
      c.append({ type: 'cache', phase: 'image-work-start', at, activeImageTasks: 2 });
    }
    draw(c, id, at, at + 4, sequence[n], n + 1); end(c, id, at + 4);
    observe(c, id, at, at + 4, at + 5, sequence[n], n + 1, true);
  }
  const r = c.finish(begin, begin + 6000); assert(!r.truncated); assert(r.summary.valid);
  assert.equal(r.summary.inputs, 864); assert.equal(JSON.parse(r.rowsJson).filter(row => row[0] === 0).length, 864);
  const bytes = Buffer.byteLength(JSON.stringify({ reports: [r, r, r] }, null, 2));
  assert(bytes + 32 * 1024 < PROTOCOL.saveBytes, 'three rounds + metadata must fit 2MiB file bound');
  console.log('sizing-only synthetic rows: ' + bytes + ' bytes; no Eagle/performance result');
});
console.log('T0 comparison pure tests passed: ' + count + '. No Eagle, media or file writes.');
