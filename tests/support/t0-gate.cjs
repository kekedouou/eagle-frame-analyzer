'use strict';
// Separate full acceptance recording. Old short-trial and legacy protocols stay unchanged.
const crypto = require('crypto');
const { promisify } = require('util');
const zlib = require('zlib');
const gzip = promisify(zlib.gzip);
const protocol = require('./t0-protocol.cjs');
const { rowFor, COLUMNS } = require('./t0-comparison.cjs');
const GATE_COLUMNS = Object.freeze({ ...COLUMNS,
  2: COLUMNS[2] + ',readStartedAt,readEndedAt,decodeStartedAt,decodeEndedAt,requestId,kind,inputAt,injectedDelayMs,decoderServiceMs',
  3: COLUMNS[3] + ',readyAt,kind',
  5: COLUMNS[5] + ',reason,error',
  9: 'effective-ready: at,epoch,requestId,frameId,inputAt,readyAt,cachedDecodeReadyAt,cacheHit,kind' });
const MIB = 1024 ** 2;
const LIMITS = Object.freeze({ rawBytes: 3 * MIB, fileBytes: MIB / 2, sessionBytes: 4 * MIB, preflightBytes: 4.5 * MIB });
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function eventFor(r) {
  const at = r[1];
  switch (r[0]) {
    case 0: return { type: 'input', at, inputId: r[2], targetTime: r[3], frameOrdinal: r[4], kind: r[5] };
    case 1: return { type: 'request', phase: 'input', at, epoch: r[2], requestId: r[3], inputId: r[4], frameId: r[5], workReused: r[6], kind: r[7] };
    case 2: return { type: 'ready', phase: 'read-and-image-decode-complete', at, epoch: r[2], frameId: r[3], readMs: r[4], decodeMs: r[5], stillTarget: r[6], assetSource: r[7],
      readStartedAt: r[8], readEndedAt: r[9], decodeStartedAt: r[10], decodeEndedAt: r[11], requestId: r[12], kind: r[13], inputAt: r[14], injectedDelayMs: r[15], decoderServiceMs: r[16] };
    case 3: return { type: 'draw', at, drawAt: at, epoch: r[2], requestId: r[3], inputId: r[4], frameId: r[5], inputAt: r[6], rafOpportunity: r[7], stale: r[8], commitSource: r[9], readyAt: r[10], kind: r[11] };
    case 4: return { type: 'observation', at, observedAt: at, epoch: r[2], requestId: r[3], frameId: r[4], inputAt: r[5], drawAt: r[6], rafOpportunity: r[7], distinctChanged: r[8] };
    case 5: return { type: 'input-end', at, inputId: r[2], status: r[3], requestId: r[4], reason: r[5], error: r[6] };
    case 7: return { type: 'error', at, epoch: r[2], phase: r[3], error: r[4] };
    case 8: return { type: 'memory', at, rss: r[2], external: r[3], arrayBuffers: r[4], managed: r[5] };
    case 9: return { type: 'ready', phase: 'effective-target-available', at, epoch: r[2], requestId: r[3], frameId: r[4], inputAt: r[5], readyAt: r[6], cachedDecodeReadyAt: r[7], cacheHit: r[8], kind: r[9] };
    default: throw new Error('Unknown full-gate row');
  }
}
class Capture {
  constructor(frameIds) {
    if (frameIds && (!Array.isArray(frameIds) || !frameIds.length || frameIds.length > 2000 ||
      frameIds.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(frameIds).size !== frameIds.length))
      throw new Error('Invalid bounded source-frame identity list');
    this.frameIds = frameIds ? Object.freeze(frameIds.slice()) : null;
    this.rows = []; this.bytes = 2; this.dropped = 0; this.maxTasks = 0; this.taskNotifications = 0;
  }
  append(e) {
    if (e.type === 'cache' && /^image-work-/.test(e.phase)) {
      this.maxTasks = Math.max(this.maxTasks, e.activeImageTasks || 0); this.taskNotifications++; return;
    }
    const row = e.type === 'ready' && e.phase === 'effective-target-available' ?
      [9, e.at, e.epoch, e.requestId, e.frameId, e.inputAt, e.readyAt, e.cachedDecodeReadyAt, !!e.cacheHit, e.kind] : rowFor(e);
    if (!row) return;
    if (row[0] === 2) row.push(e.readStartedAt, e.readEndedAt, e.decodeStartedAt, e.decodeEndedAt, e.requestId, e.kind, e.inputAt, e.injectedDelayMs, e.decoderServiceMs);
    if (row[0] === 3) row.push(e.readyAt, e.kind);
    if (row[0] === 5) row.push(e.reason, e.error);
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (this.bytes + bytes > LIMITS.rawBytes) { this.dropped++; return; }
    this.bytes += bytes; this.rows.push(row);
  }
  summarize(begin, end, options) {
    const events = this.rows.map(eventFor);
    const summary = protocol.summarize(events, begin, end, { ...options, truncated: this.dropped > 0 });
    const requests = new Map(events.filter(e => e.type === 'request').map(e => [e.epoch + ':' + e.requestId, e]));
    const inputMap = new Map(events.filter(e => e.type === 'input').map(e => [e.inputId, e]));
    summary.frameIdentityMismatches = this.frameIds ? [...requests.values()].filter(q => {
      const input = inputMap.get(q.inputId);
      return input && (!Number.isSafeInteger(input.frameOrdinal) || this.frameIds[input.frameOrdinal] !== q.frameId);
    }).length : null;
    const draws = events.filter(e => e.type === 'draw');
    summary.invalidDrawRequests = draws.filter(d => {
      const q = requests.get(d.epoch + ':' + d.requestId); return !q || q.inputId !== d.inputId || q.frameId !== d.frameId;
    }).length;
    summary.errors = events.filter(e => e.type === 'error').length;
    summary.maxImageTasksObserved = this.maxTasks;
    summary.valid = summary.inputs > 0 && !this.dropped && !summary.errors && !summary.invalidDrawRequests && !summary.frameIdentityMismatches && this.maxTasks <= 2 &&
      Object.values(summary.integrity).every(n => n === 0) && !summary.staleSubmissions &&
      !summary.duplicateRafSubmissions && ['failed', 'cancelled', 'unfinished', 'other'].every(k => !summary.terminals[k]);
    if (summary.normalThresholdsMet !== null) summary.normalThresholdsMet = summary.normalThresholdsMet && summary.valid;
    const ready = events.filter(e => e.type === 'ready' && e.phase === 'read-and-image-decode-complete' && e.at >= begin && e.at < end);
    summary.readMs = protocol.distribution(ready.map(e => e.readMs));
    summary.decodeMs = protocol.distribution(ready.map(e => e.decodeMs));
    summary.compressedReads = ready.filter(e => e.assetSource === 'compressed-ram').length;
    summary.diskReads = ready.filter(e => e.assetSource === 'disk').length;
    const memory = events.filter(e => e.type === 'memory');
    summary.resources = { managedSamplePeakBytes: Math.max(0, ...memory.map(e => e.managed || 0)),
      rendererRssSamplePeakBytes: Math.max(0, ...memory.map(e => e.rss || 0)), samples: memory.length };
    return summary;
  }
  async pack() {
    const raw = Buffer.from(JSON.stringify(this.rows));
    const frozen = { rows: this.rows.length, truncated: this.dropped > 0, droppedRows: this.dropped,
      maxImageTasks: this.maxTasks, taskNotifications: this.taskNotifications };
    if (raw.length > LIMITS.rawBytes) throw new Error('完整记录超过未压缩上限。');
    const compressed = await gzip(raw, { level: 9 });
    return { encoding: 'full-gate-rows-gzip-base64-v1', columns: GATE_COLUMNS, data: compressed.toString('base64'),
      rawBytes: raw.length, rawSha256: sha(raw), compressedBytes: compressed.length, frameIds: this.frameIds, ...frozen,
      omitted: 'duplicate notifications only; task notifications aggregated; input/request/ready/draw/terminal timestamps retained exactly',
      physicalPresentation: 'drawImage submission only; monitor scanout not measured' };
  }
}
function unpack(trace) {
  if (!trace || trace.encoding !== 'full-gate-rows-gzip-base64-v1' || !Number.isSafeInteger(trace.rawBytes) ||
    trace.rawBytes < 2 || trace.rawBytes > LIMITS.rawBytes || typeof trace.data !== 'string' || trace.data.length > LIMITS.fileBytes)
    throw new Error('Invalid bounded full-gate trace');
  const raw = zlib.gunzipSync(Buffer.from(trace.data, 'base64'), { maxOutputLength: LIMITS.rawBytes });
  if (raw.length !== trace.rawBytes || sha(raw) !== trace.rawSha256) throw new Error('Full-gate trace integrity mismatch');
  const rows = JSON.parse(raw); if (!Array.isArray(rows) || rows.length !== trace.rows) throw new Error('Full-gate row count mismatch');
  return rows.map(eventFor);
}
function fileSize(payload) { return Buffer.byteLength(JSON.stringify(payload, null, 2)) + 4096; }
module.exports = { LIMITS, Capture, unpack, fileSize };
