'use strict';

// Test-host diagnostics only. Unlike the full performance protocol, this keeps
// a bounded tail; omissions are explicit and can never count as a full run.
const DEFAULTS = Object.freeze({ windowMs: 15000, eventBytes: 384 * 1024, sampleLimit: 200, sampleBytes: 96 * 1024 });
function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(name + ' must be a positive safe integer.');
  return value;
}
function timestamp(value) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Trace time must be finite and non-negative.');
  return value;
}
function counters() { return { seen: 0, evictedByTime: 0, evictedByBytes: 0, evictedByCount: 0, rejectedOversize: 0, rejectedInvalid: 0 }; }
function omitted(count) { return count.evictedByTime + count.evictedByBytes + count.evictedByCount + count.rejectedOversize + count.rejectedInvalid; }
function tag(value) {
  const type = typeof value.type === 'string' ? value.type : 'unknown';
  return (type + (typeof value.phase === 'string' ? ':' + value.phase : '')).slice(0, 80);
}
function countType(map, key) {
  // Test events have a fixed vocabulary; unexpected dynamic names cannot grow
  // the lifetime counters without limit.
  const own = Object.prototype.hasOwnProperty.call(map, key);
  if (!own && Object.keys(map).length >= 64) key = '[other]';
  map[key] = (map[key] || 0) + 1;
}
class Queue {
  constructor() { this.rows = []; this.head = 0; this.bytes = 0; }
  get length() { return this.rows.length - this.head; }
  first() { return this.rows[this.head]; }
  last() { return this.rows[this.rows.length - 1]; }
  push(row) { this.rows.push(row); this.bytes += row.bytes; }
  drop() {
    const row = this.rows[this.head]; this.rows[this.head++] = null; this.bytes -= row.bytes;
    if (this.head >= 256 && this.head * 2 >= this.rows.length) {
      this.rows = this.rows.slice(this.head); this.head = 0;
    }
  }
  active() { return this.rows.slice(this.head); }
}
class ManualTrace {
  constructor(options = {}) {
    this.limits = {};
    for (const key of Object.keys(DEFAULTS)) this.limits[key] = positive(options[key] === undefined ? DEFAULTS[key] : options[key], key);
    this.reset(0);
  }
  reset(at) {
    this.sessionBegin = timestamp(at); this.events = new Queue(); this.samples = new Queue();
    this.eventCounters = counters(); this.sampleCounters = counters(); this.eventTypes = Object.create(null);
    this.lastEventAt = null; this.firstEventAt = null; this.lastSampleAt = null; this.firstSampleAt = null;
    this.eventSequence = 0; this.sampleSequence = 0; this.outOfOrder = false; this.peaks = {};
  }
  _row(value, sequence) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    try {
      const json = JSON.stringify(value); if (typeof json !== 'string') return null;
      const copy = JSON.parse(json); timestamp(copy.at);
      return { json, at: copy.at, bytes: json.length * 2, sequence, tag: tag(copy), value: copy };
    } catch (_) { return null; }
  }
  _peak(name, value, at) {
    if (Number.isFinite(value) && value >= 0 && (!this.peaks[name] || value > this.peaks[name].bytes)) this.peaks[name] = { bytes: value, at };
  }
  _pruneEvents() {
    if (this.lastEventAt === null) return;
    const cutoff = Math.max(this.sessionBegin, this.lastEventAt - this.limits.windowMs);
    if (this.outOfOrder) {
      // Rare late timestamps must not hide expired rows behind a newer head.
      const kept = new Queue(); let prior = -Infinity, ordered = true;
      for (const row of this.events.active()) {
        if (row.at < cutoff) this.eventCounters.evictedByTime++;
        else { kept.push(row); if (row.at < prior) ordered = false; prior = row.at; }
      }
      this.events = kept; this.outOfOrder = !ordered;
    } else while (this.events.length && this.events.first().at < cutoff) {
      this.events.drop(); this.eventCounters.evictedByTime++;
    }
  }
  append(event) {
    const count = this.eventCounters; count.seen++;
    const row = this._row(event, ++this.eventSequence);
    if (!row) { count.rejectedInvalid++; countType(this.eventTypes, '[invalid]'); return false; }
    countType(this.eventTypes, row.tag);
    if (this.firstEventAt === null) this.firstEventAt = row.at;
    const previousWatermark = this.lastEventAt;
    this.lastEventAt = Math.max(this.lastEventAt === null ? row.at : this.lastEventAt, row.at);
    this._peak('managedEventBytes', row.value.budgetBytes, row.at);
    this._peak('managedLedgerBytes', row.value.cachePeakBytes, row.at);
    delete row.value;
    this._pruneEvents();
    if (row.bytes > this.limits.eventBytes) { count.rejectedOversize++; return false; }
    if (row.at < Math.max(this.sessionBegin, this.lastEventAt - this.limits.windowMs)) { count.evictedByTime++; return false; }
    while (this.events.length && this.events.bytes + row.bytes > this.limits.eventBytes) { this.events.drop(); count.evictedByBytes++; }
    this.events.push(row);
    if (previousWatermark !== null && row.at < previousWatermark) this.outOfOrder = true;
    return true;
  }
  sample(sample) {
    const count = this.sampleCounters; count.seen++;
    const row = this._row(sample, ++this.sampleSequence);
    if (!row) { count.rejectedInvalid++; return false; }
    if (this.firstSampleAt === null) this.firstSampleAt = row.at;
    this.lastSampleAt = Math.max(this.lastSampleAt === null ? row.at : this.lastSampleAt, row.at);
    for (const [field, name] of [['rss', 'rendererRssBytes'], ['managed', 'managedSampleBytes'], ['external', 'externalBytes'], ['arrayBuffers', 'arrayBufferBytes']]) this._peak(name, row.value[field], row.at);
    delete row.value;
    if (row.bytes > this.limits.sampleBytes) { count.rejectedOversize++; return false; }
    while (this.samples.length && this.samples.length >= this.limits.sampleLimit) { this.samples.drop(); count.evictedByCount++; }
    while (this.samples.length && this.samples.bytes + row.bytes > this.limits.sampleBytes) { this.samples.drop(); count.evictedByBytes++; }
    this.samples.push(row); return true;
  }
  snapshot(at) {
    timestamp(at);
    const eventRows = this.events.active(), sampleRows = this.samples.active();
    const events = eventRows.map(row => JSON.parse(row.json)), memorySamples = sampleRows.map(row => JSON.parse(row.json));
    const retainedTypes = Object.create(null); for (const row of eventRows) countType(retainedTypes, row.tag);
    const eventCount = { ...this.eventCounters, retained: events.length }, sampleCount = { ...this.sampleCounters, retained: memorySamples.length };
    const range = rows => rows.length ? { first: Math.min(...rows.map(row => row.at)), last: Math.max(...rows.map(row => row.at)) } : { first: null, last: null };
    const er = range(eventRows), sr = range(sampleRows);
    const inputs = new Set(events.filter(event => event.type === 'input').map(event => event.inputId));
    const terminals = events.filter(event => event.type === 'input-end');
    const terminalIds = new Set(terminals.map(event => event.inputId));
    const truncated = omitted(eventCount) > 0 || omitted(sampleCount) > 0;
    return { events, memorySamples, truncated, trace: {
      encoding: 'manual-tail-v3', purpose: 'manual diagnostic tail; never a complete performance-protocol result',
      limits: { ...this.limits }, storedBytesEstimate: this.events.bytes + this.samples.bytes,
      bytesScope: 'JSON string length times two for retained payloads; excludes JS overhead and the save envelope; writer must check final UTF-8 file size',
      coverage: { sessionBegin: this.sessionBegin, savedAt: at,
        windowBegin: this.lastEventAt === null ? this.sessionBegin : Math.max(this.sessionBegin, this.lastEventAt - this.limits.windowMs),
        windowEnd: this.lastEventAt, firstRetainedAt: er.first, lastRetainedAt: er.last,
        retainedSpanMs: er.first === null ? 0 : er.last - er.first,
        lastSeenEventAt: this.lastEventAt, firstSeenEventAt: this.firstEventAt,
        tailComplete: !this.eventSequence || !!eventRows.length && eventRows[eventRows.length - 1].sequence === this.eventSequence,
        omittedEvents: omitted(eventCount), omittedSamples: omitted(sampleCount),
        memoryFirstRetainedAt: sr.first, memoryLastRetainedAt: sr.last,
        countsScope: 'since reset, only records delivered to append/sample; upstream filtered notifications excluded; retained counts describe this tail only',
        idlePolicy: 'snapshot time and memory sampling never advance or trim the event window',
        partialChainsPossible: truncated,
        boundary: { terminalsWithoutRetainedInput: terminals.filter(event => !inputs.has(event.inputId)).length,
          retainedInputsWithoutTerminal: [...inputs].filter(id => !terminalIds.has(id)).length,
          meaning: 'window boundaries/omissions can split a request; these counts are not full-run orphan or unfinished failures' }
      }, counters: { events: eventCount, memorySamples: sampleCount }, eventCounts: { ...this.eventTypes }, retainedEventCounts: { ...retainedTypes },
      peaks: JSON.parse(JSON.stringify(this.peaks)), peaksScope: 'all valid delivered records since reset, including rows later evicted; renderer RSS excludes shared Eagle/GPU',
      physicalPresentation: 'not measured; draw events are canvas submission only'
    } };
  }
}
module.exports = { ManualTrace };
