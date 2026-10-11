'use strict';
const assert = require('assert');
const { targets, independentTargets, distribution, summarize } = require('./support/t0-protocol.cjs');
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
console.log('t0-protocol: deterministic trajectories, P95, complete input accounting, no artificial draws, stress separation passed');
