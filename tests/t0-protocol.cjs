'use strict';
const assert = require('assert');
const { targets, independentTargets, distribution, compactEvent, summarize } = require('./support/t0-protocol.cjs');
assert.deepStrictEqual(targets(828, 3600), targets(828, 3600));
for (const sequence of [targets(30, 3600), independentTargets(30)]) {
  assert(sequence.every((n, i) => n >= 0 && n < 30 && (i === 0 || n !== sequence[i - 1])));
}
assert.strictEqual(distribution([1, 4, 2, 3]).p95Ms, 4);
assert.strictEqual(distribution([]).p95Ms, null);
const events = [
  { type: 'input', at: 0, inputId: 1 }, { type: 'input', at: 2, inputId: 2 },
  { type: 'input', at: 4, inputId: 3 }, { type: 'input', at: 6, inputId: 4 },
  { type: 'input-end', at: 3, inputId: 1, status: 'superseded' },
  { type: 'draw', at: 10, inputAt: 2, inputId: 2, frameId: 2, rafOpportunity: 1 },
  { type: 'input-end', at: 10, inputId: 2, status: 'drawn' },
  { type: 'input-end', at: 12, inputId: 3, status: 'reused' }
];
const result = summarize(events, 0, 1000, { kind: 'rapid' });
assert.strictEqual(result.inputs, 4);
assert.strictEqual(result.terminalTotal, 4);
assert.strictEqual(result.terminals.unfinished, 1);
assert.strictEqual(result.drawSubmissions, 1);
assert.strictEqual(result.longestNoSubmissionMs, 990);
assert.strictEqual(result.requestToDraw.n, 1); // reuse/input counts cannot manufacture draws
assert.strictEqual(result.normalThresholdsMet, false);
const stress = summarize(events, 0, 1000, { kind: 'rapid', delayMs: 60 });
assert.strictEqual(stress.normalThresholdsMet, null);
assert.strictEqual(summarize(events, 0, 1000, { kind: 'rapid', truncated: true }).normalThresholdsMet, false);
const stale = summarize([...events, { type: 'draw', at: 20, inputAt: 4, inputId: 3, frameId: 0, stale: true, rafOpportunity: 1 }], 0, 1000, { kind: 'rapid' });
assert.strictEqual(stale.staleSubmissions, 1);
assert.strictEqual(stale.duplicateRafSubmissions, 1);
const invented = summarize(Array.from({ length: 60 }, (_, i) => ({ type: 'draw', at: i * 16 + 1, inputAt: i * 16, frameId: i })), 0, 1000, { kind: 'rapid' });
assert.strictEqual(invented.normalThresholdsMet, false);
assert.strictEqual(invented.integrity.orphanDraws, 60);
const corrupt = summarize([...events, events[0], { ...events[4] }, { type: 'draw', inputId: 2, at: 15, inputAt: -10 }], 0, 1000, { kind: 'rapid' });
assert.strictEqual(corrupt.integrity.duplicateInputs, 1);
assert.strictEqual(corrupt.integrity.duplicateTerminals, 1);
assert.strictEqual(corrupt.integrity.invalidLatencies, 1);
assert.strictEqual(corrupt.normalThresholdsMet, false);
const delayedOrigin = summarize([{ type: 'input', at: 0, inputId: 1 }, { type: 'draw', at: 100, inputAt: 99, inputId: 1 }], 0, 1000, { kind: 'rapid' });
assert.strictEqual(delayedOrigin.requestToDraw.p95Ms, 100);
assert.strictEqual(delayedOrigin.integrity.invalidLatencies, 1);
const artificial = summarize([{ type: 'input', at: 0, inputId: 1 }, { type: 'input-end', at: 100, inputId: 1, status: 'drawn' },
  ...Array.from({ length: 60 }, (_, i) => ({ type: 'draw', at: i * 16 + 1, inputAt: 0, inputId: 1, frameId: 1, rafOpportunity: i }))], 0, 1000, { kind: 'rapid' });
assert.strictEqual(artificial.integrity.duplicateDrawInputs, 59);
assert.strictEqual(artificial.normalThresholdsMet, false);
const compact = events.map(compactEvent).filter(Boolean);
assert.deepStrictEqual(summarize(compact, 0, 1000, { kind: 'rapid' }), result);
assert.strictEqual(compactEvent({ type: 'superseded', at: 10 }), null);
assert.strictEqual(compactEvent({ type: 'ready', phase: 'effective-target-available' }), null);
const actualDraw = { type: 'draw', at: 1.234567, drawAt: 1.234567, inputAt: .234567, readyAt: 1.1, requestId: 2,
  inputId: 1, frameId: 1, note: 'constant', barcode: null, physicalDisplayTime: null };
assert.deepStrictEqual(compactEvent(actualDraw), { type: 'draw', at: 1.234567, drawAt: 1.234567, inputAt: .234567, readyAt: 1.1, requestId: 2, inputId: 1, frameId: 1 });
assert.strictEqual(actualDraw.note, 'constant', 'compaction must not mutate the player event');
const fixture = [];
for (let i = 0; i < 3601; i++) {
  const inputAt = i * 8.333333333;
  fixture.push({ type: 'input', at: inputAt, inputAt, inputId: i, kind: 'rapid', targetTime: 13.5, frameOrdinal: 810 },
    { type: 'request', phase: 'input', at: inputAt, epoch: 1, inputId: i, requestId: i, inputAt, frameId: 810, frameOrdinal: 810, targetTime: 13.5, workReused: false, final: false },
    { type: 'cache', phase: 'image-work-start', at: inputAt, epoch: 1, frameId: 810, role: 'target', activeImageTasks: 2 },
    { type: 'ready', phase: 'read-and-image-decode-complete', at: inputAt + 5, epoch: 1, inputId: i, requestId: i, kind: 'rapid', frameId: 810,
      readyAt: inputAt + 5, inputAt, readStartedAt: inputAt, readEndedAt: inputAt + 1, readMs: 1,
      decodeStartedAt: inputAt + 1, decodeEndedAt: inputAt + 5, decodeMs: 4, injectedDelayMs: 0, decoderServiceMs: 4,
      delayModel: 'non-cancellable-service-after-decode-entry-v2', stillTarget: true, budgetBytes: 536299000 },
    { type: 'cache', phase: 'image-work-ended', at: inputAt + 5, epoch: 1, frameId: 810, activeImageTasks: 1, budgetBytes: 536299000 },
    { ...actualDraw, at: inputAt + 6, inputAt, readyAt: inputAt + 5, drawAt: inputAt + 6, inputId: i, requestId: i,
      epoch: 1, kind: 'rapid', frameOrdinal: 810, time: 13.5, targetTime: 13.5, mediaTime: 13.5, responseMs: 6,
      budgetBytes: 536299000, cachePeakBytes: 536299000, rafOpportunity: i, repeatedFrame: false, sincePreviousDrawMs: 8.3333, stale: false },
    { type: 'input-end', at: inputAt + 6, inputId: i, requestId: i, status: 'drawn' });
}
const compactFixture = fixture.map(compactEvent).filter(Boolean);
assert(compactFixture.reduce((bytes, event) => bytes + JSON.stringify(event).length * 2, 0) < 12 * 1024 ** 2, 'representative high-volume 30s/120Hz trace must fit existing 12MiB log estimate');
assert(Buffer.byteLength(JSON.stringify({ events: compactFixture }, null, 2)) < 16 * 1024 ** 2, 'saved trace must fit existing single-evidence cap');
console.log('t0-protocol: deterministic trajectories, P95, complete input accounting, compact complete trace budget, no artificial draws, stress separation passed');
