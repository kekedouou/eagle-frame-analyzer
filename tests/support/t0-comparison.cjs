'use strict';
// A bounded, full short-trial trace. Never a replacement for the 3 x 30s gate.
const { distribution, targets, PROTOCOL: BASE } = require('./t0-protocol.cjs');
const PROTOCOL = Object.freeze({ modes: ['baseline', 'compressed-ram', 'ready-submit'], roundMs: 6000, inputHz: 144,
  seed: BASE.seed, traceBytes: 512 * 1024, saveBytes: 2 * 1024 ** 2, preflightBytes: 3 * 1024 ** 2 });
const COLUMNS = Object.freeze({
  0: 'input: at,id,targetTime,ordinal,kind',
  1: 'request: at,epoch,requestId,inputId,frameId,workReused,kind',
  2: 'image-ready: at,epoch,frameId,readMs,decodeMs,stillTarget,assetSource',
  3: 'draw: drawAt,epoch,requestId,inputId,frameId,inputAt,rafOpportunity,stale,commitSource',
  4: 'observation: observedAt,epoch,requestId,frameId,inputAt,drawAt,rafOpportunity,distinctChanged,submissionsSinceLastObservation,latestAtObservation',
  5: 'terminal: at,inputId,status,requestId',
  6: 'task: at,activeImageTasks,phase',
  7: 'error: at,epoch,phase,message',
  8: 'memory: at,rss,external,arrayBuffers,managed'
});
function rowFor(e) {
  if (e.type === 'input') return [0, e.at, e.inputId, e.targetTime, e.frameOrdinal, e.kind];
  if (e.type === 'request' && e.phase === 'input') return [1, e.at, e.epoch, e.requestId, e.inputId, e.frameId, !!e.workReused, e.kind];
  if (e.type === 'ready' && e.phase === 'read-and-image-decode-complete') return [2, e.at, e.epoch, e.frameId, e.readMs, e.decodeMs, !!e.stillTarget, e.assetSource];
  if (e.type === 'draw') return [3, e.drawAt, e.epoch, e.requestId, e.inputId, e.frameId, e.inputAt, e.rafOpportunity, !!e.stale, e.commitSource];
  if (e.type === 'observation') return [4, e.observedAt, e.epoch, e.requestId, e.frameId, e.inputAt, e.drawAt, e.rafOpportunity,
    !!e.distinctChanged, e.submissionsSinceLastObservation, !!e.latestAtObservation];
  if (e.type === 'input-end') return [5, e.at, e.inputId, e.status, e.requestId];
  if (e.type === 'cache' && /^image-work-/.test(e.phase)) return [6, e.at, e.activeImageTasks, e.phase];
  if (e.type === 'error') return [7, e.at, e.epoch, e.phase, String(e.error || '').slice(0, 200)];
  if (e.type === 'memory') return [8, e.at, e.rss, e.external, e.arrayBuffers, e.managed];
  return null;
}
function gaps(at, begin, end) {
  const marks = [begin, ...at.filter(t => t >= begin && t < end).sort((a, b) => a - b), end];
  return marks.slice(1).reduce((maximum, stamp, n) => Math.max(maximum, stamp - marks[n]), 0);
}
class Capture {
  constructor(limit = PROTOCOL.traceBytes) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROTOCOL.traceBytes) throw new Error('对照记录限额无效');
    this.limit = limit; this.rows = []; this.bytes = 0; this.dropped = 0; this.maxImageTasks = 0; this.taskEvents = 0;
  }
  append(e) {
    if (e.type === 'cache' && /^image-work-/.test(e.phase)) {
      this.maxImageTasks = Math.max(this.maxImageTasks, e.activeImageTasks || 0); this.taskEvents++; return;
    }
    const row = rowFor(e); if (!row) return;
    // Exact encoded row bytes; the outer file is separately checked including
    // escaping and ownership. Task notifications are aggregated, never inputs.
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 2;
    if (this.bytes + size > this.limit) { this.dropped++; return; }
    this.bytes += size; this.rows.push(row);
  }
  finish(begin, end) {
    if (!(Number.isFinite(begin) && Number.isFinite(end) && end > begin)) throw new Error('对照时间窗口无效');
    const inWindow = row => row[1] >= begin && row[1] < end;
    const inputs = this.rows.filter(r => r[0] === 0 && inWindow(r) && r[5] === 'rapid');
    const ids = new Set(inputs.map(r => r[2])), inputMap = new Map(inputs.map(r => [r[2], r]));
    const terminals = this.rows.filter(r => r[0] === 5 && ids.has(r[2])), ends = new Map(terminals.map(r => [r[2], r]));
    const requests = new Map(this.rows.filter(r => r[0] === 1).map(r => [r[2] + ':' + r[3], r]));
    const draws = this.rows.filter(r => r[0] === 3 && inWindow(r) && ids.has(r[4]));
    const observations = this.rows.filter(r => r[0] === 4 && inWindow(r) && ids.has((requests.get(r[2] + ':' + r[3]) || [])[4]));
    const distinct = observations.filter(r => r[8]);
    const integrity = { duplicateInputs: inputs.length - ids.size, duplicateTerminals: terminals.length - ends.size,
      unfinished: inputs.filter(r => !ends.has(r[2])).length,
      failedOrCancelled: terminals.filter(r => !['drawn', 'reused', 'superseded'].includes(r[3])).length,
      invalidDrawLatency: draws.filter(r => !Number.isFinite(r[6]) || r[6] !== inputMap.get(r[4])[1] || r[1] < r[6]).length,
      staleDraws: draws.filter(r => r[8]).length,
      duplicateDrawInputs: draws.length - new Set(draws.map(r => r[4])).size,
      invalidDrawRequest: draws.filter(r => { const q = requests.get(r[2] + ':' + r[3]); return !q || q[4] !== r[4] || q[5] !== r[5]; }).length,
      terminalMismatch: draws.filter(r => { const t = ends.get(r[4]); return !t || t[3] !== 'drawn' || t[4] !== r[3]; }).length,
      drawnWithoutSubmit: terminals.filter(r => r[3] === 'drawn' && !this.rows.some(d => d[0] === 3 && d[4] === r[2])).length,
      repeatedObservationRaf: observations.length - new Set(observations.map(r => r[7])).size,
      imageTaskLimitViolations: this.maxImageTasks > 2 ? 1 : 0,
      errors: this.rows.filter(r => r[0] === 7).length };
    const statuses = {}; terminals.forEach(r => { statuses[r[3]] = (statuses[r[3]] || 0) + 1; });
    const valid = !this.dropped && Object.values(integrity).every(n => n === 0), seconds = (end - begin) / 1000;
    const ready = this.rows.filter(r => r[0] === 2 && inWindow(r)), memory = this.rows.filter(r => r[0] === 8);
    const peak = index => memory.reduce((maximum, r) => Math.max(maximum, Number(r[index]) || 0), 0);
    const summary = { valid, officialAcceptance: false, begin, end, inputs: inputs.length, terminal: statuses, integrity,
      counts: { submissions: draws.length, observations: observations.length, distinctObservations: distinct.length,
        overwrittenSubmissions: observations.reduce((n, r) => n + Math.max(0, r[9] - 1), 0),
        olderAtObservation: observations.filter(r => !r[10]).length },
      metrics: valid ? { submitHz: draws.length / seconds, submitLatency: distribution(draws.map(r => r[1] - r[6])),
        submitMaxGapMs: gaps(draws.map(r => r[1]), begin, end),
        observedDistinctHz: distinct.length / seconds, observedMaxGapMs: gaps(distinct.map(r => r[1]), begin, end),
        observedLatency: distribution(distinct.map(r => r[1] - r[5])),
        readMs: distribution(ready.map(r => r[4])), decodeMs: distribution(ready.map(r => r[5])),
        compressedReads: ready.filter(r => r[7] === 'compressed-ram').length, diskReads: ready.filter(r => r[7] === 'disk').length } : null,
      resources: { managedSamplePeakBytes: peak(5), rendererRssSamplePeakBytes: peak(2), memorySamples: memory.length,
        maxImageTasksObserved: this.maxImageTasks, aggregatedTaskNotifications: this.taskEvents },
      limits: ['One six-second round per mode, fixed order and warm OS file cache: not the official 3 x 30s gate.',
        'rAF observation reports the final Canvas identity at the callback, not monitor scanout or guaranteed physical presentation.',
        'Superseded requests have terminal counts; latency covers completed submissions/observations only.',
        'Managed ledger and sampled renderer RSS exclude whole Eagle/GPU and unsampled memory peaks.'] };
    return { encoding: 'short-comparison-rows-v1', columns: COLUMNS, rowsJson: JSON.stringify(this.rows),
      truncated: !!this.dropped, droppedRows: this.dropped, storedBytesEstimate: this.bytes, summary };
  }
}
module.exports = { PROTOCOL, Capture, gaps, targets, rowFor, COLUMNS };
