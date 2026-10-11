'use strict';
// Pure measurement helpers: no timers, files, media generation or Eagle calls.
const SEED = 0x4e564130;
const PROTOCOL = Object.freeze({ seed: SEED, roundMs: 30000, inputHz: 120, repeats: 3,
  randomTargets: 200, releaseTimeoutMs: 5000, disposeTimeoutMs: 10000,
  updateHz: 55, maxGapMs: 100, p95Ms: 50, eventBytes: 12 * 1024 ** 2 });
function random(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function targets(frameCount, count, seed = SEED) {
  if (!Number.isSafeInteger(frameCount) || frameCount < 2 || !Number.isSafeInteger(count) || count < 1) throw new Error('Invalid trajectory dimensions');
  const rng = random(seed), out = []; let previous = -1;
  for (let n = 0; n < count; n++) {
    const section = Math.floor(n / 120) % 3;
    let id = section === 2 ? Math.floor(rng() * frameCount) : Math.round((n % 120) / 119 * (frameCount - 1));
    if (section === 1) id = frameCount - 1 - id;
    if (id === previous) id = (id + 1) % frameCount;
    out.push(id); previous = id;
  }
  return out;
}
function independentTargets(frameCount, count = PROTOCOL.randomTargets, seed = SEED) {
  if (frameCount < 2) throw new Error('Insufficient distinct frames');
  const rng = random(seed); let previous = -1;
  return Array.from({ length: count }, () => {
    let index = Math.floor(rng() * frameCount);
    if (index === previous) index = (index + 1) % frameCount;
    previous = index; return index;
  });
}
function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), n = sorted.length;
  const at = p => n ? sorted[Math.max(0, Math.ceil(p * n) - 1)] : null;
  return { n, meanMs: n ? sorted.reduce((s, v) => s + v, 0) / n : null, p50Ms: at(.5), p95Ms: at(.95), maxMs: n ? sorted[n - 1] : null };
}
// Preserve every raw input, request identity, actual decode-ready/draw time and
// terminal. Only duplicate notifications are aggregated; no timestamps rounded.
function compactEvent(event) {
  if (['state', 'superseded', 'reused'].includes(event.type) ||
    event.type === 'request' && event.phase === 'effective-frame' ||
    event.type === 'ready' && event.phase === 'effective-target-available' ||
    event.type === 'cache' && event.phase === 'evict') return null;
  const copy = { ...event };
  if (copy.type === 'draw') {
    for (const key of ['note', 'physicalDisplayTime', 'markerReadbackCostIncludedAfterDraw', 'markerVerificationEnabled']) delete copy[key];
    if (copy.barcode === null) delete copy.barcode;
  }
  return copy;
}
function summarize(events, begin, end, options = {}) {
  if (!(Number.isFinite(begin) && end > begin)) throw new Error('Invalid measurement window');
  const inputs = events.filter(e => e.type === 'input' && e.at >= begin && e.at < end);
  const ids = new Set(inputs.map(e => e.inputId)), inputById = new Map(inputs.map(e => [e.inputId, e]));
  const allEnds = events.filter(e => e.type === 'input-end' && ids.has(e.inputId));
  const ends = new Map(allEnds.map(e => [e.inputId, e]));
  const windowDraws = events.filter(e => e.type === 'draw' && e.at >= begin && e.at < end);
  const draws = windowDraws.filter(e => ids.has(e.inputId));
  const integrity = { duplicateInputs: inputs.length - ids.size, duplicateTerminals: allEnds.length - ends.size,
    orphanDraws: windowDraws.length - draws.length, invalidLatencies: draws.filter(e => !Number.isFinite(e.inputAt) || e.inputAt !== inputById.get(e.inputId).at || e.at < e.inputAt).length,
    duplicateDrawInputs: draws.length - new Set(draws.map(e => e.inputId)).size,
    terminalMismatch: draws.filter(e => { const terminal = ends.get(e.inputId); return !terminal || terminal.status !== 'drawn' || terminal.requestId !== e.requestId; }).length,
    missingDrawTerminals: [...ends.values()].filter(e => e.status === 'drawn' && !events.some(d => d.type === 'draw' && d.inputId === e.inputId)).length };
  const terminal = { drawn: 0, reused: 0, superseded: 0, cancelled: 0, failed: 0, unfinished: 0, other: 0 };
  for (const input of inputs) {
    const result = ends.get(input.inputId);
    if (!result) terminal.unfinished++;
    else if (Object.prototype.hasOwnProperty.call(terminal, result.status)) terminal[result.status]++;
    else terminal.other++;
  }
  const marks = [begin, ...draws.map(e => e.at).sort((a, b) => a - b), end];
  let maxGap = 0;
  for (let i = 1; i < marks.length; i++) maxGap = Math.max(maxGap, marks[i] - marks[i - 1]);
  const times = draws.filter(e => e.at >= inputById.get(e.inputId).at).map(e => e.at - inputById.get(e.inputId).at);
  const buckets = Array.from({ length: Math.ceil((end - begin) / 1000) }, () => 0);
  let duplicateDraws = 0; const rafs = new Set(); let repeatedRaf = 0, previous = null;
  for (const draw of draws) {
    buckets[Math.min(buckets.length - 1, Math.floor((draw.at - begin) / 1000))]++;
    if (draw.frameId === previous) duplicateDraws++;
    previous = draw.frameId;
    if (draw.rafOpportunity !== undefined) { if (rafs.has(draw.rafOpportunity)) repeatedRaf++; rafs.add(draw.rafOpportunity); }
  }
  const latency = distribution(times), updateHz = draws.length * 1000 / (end - begin);
  const stale = draws.filter(e => e.stale === true).length;
  const truncated = !!options.truncated;
  const normal = options.kind === 'rapid' && !options.delayMs;
  return { begin, end, durationMs: end - begin, kind: options.kind, delayMs: options.delayMs || 0,
    inputs: inputs.length, terminals: terminal, terminalTotal: Object.values(terminal).reduce((a, b) => a + b, 0),
    actualInputHz: inputs.length * 1000 / (end - begin), sameFrameWorkReused: events.filter(e => e.type === 'request' && e.workReused && ids.has(e.inputId)).length,
    drawSubmissions: draws.length, submittedUpdatesPerSecond: updateHz, perSecondSubmissions: buckets,
    duplicateFrameDraws: duplicateDraws, duplicateRafSubmissions: repeatedRaf, staleSubmissions: stale,
    longestNoSubmissionMs: maxGap, requestToDraw: latency,
    lateTerminals: [...ends.values()].filter(e => e.at >= end).length,
    lateDraws: events.filter(e => e.type === 'draw' && e.at >= end && ids.has(e.inputId)).length,
    barcodeChecks: draws.filter(e => e.barcode).length,
    barcodeErrors: draws.filter(e => e.barcode && e.barcode.ok !== true).length,
    truncated, integrity, physicalDisplayMs: null,
    normalThresholdsMet: normal ? inputs.length > 0 && !truncated && Object.values(integrity).every(n => n === 0) && updateHz >= PROTOCOL.updateHz && maxGap <= PROTOCOL.maxGapMs &&
      latency.n > 0 && latency.p95Ms <= PROTOCOL.p95Ms && terminal.failed === 0 && terminal.unfinished === 0 && terminal.cancelled === 0 && terminal.other === 0 && stale === 0 && repeatedRaf === 0 && !draws.some(e => e.barcode && e.barcode.ok !== true) : null,
    limitations: ['drawImage提交不是屏幕物理呈现', 'P95仅包含绘制完成请求，须同时审查取代/失败/未完成和停顿', '未清Windows文件缓存，不称操作系统冷缓存'] };
}
module.exports = { PROTOCOL, random, targets, independentTargets, distribution, compactEvent, summarize };
