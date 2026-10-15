'use strict';
// Pure analysis of external Windows samples. No files, timers or process control.
const ROLES = Object.freeze(['renderer', 'task-guard', 'task-worker', 'console-host', 'system-helper', 'ffmpeg', 'ffprobe', 'observer', 'observer-child', 'owned-unclassified']);
const PLUGIN = new Set(['renderer', 'task-guard', 'task-worker', 'console-host', 'system-helper', 'owned-unclassified']);
function approvedLimits(ramBytes) {
  if (![512 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3].includes(ramBytes)) throw new Error('No approved process stop line for this RAM test tier.');
  return Object.freeze({ pluginRssStopBytes: (ramBytes === 2 * 1024 ** 3 ? 3 : 1.5) * 1024 ** 3,
    ffmpegRssStopBytes: 1024 ** 3 });
}
function identity(row) {
  if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.startTicks !== 'string' || !/^\d{16,20}$/.test(row.startTicks))
    throw new Error('Resource process requires PID and exact creation time.');
  return row.pid + ':' + row.startTicks;
}
function sample(value) {
  if (!value || value.schema !== 'mvp-process-sample-v1' || !Number.isFinite(value.atMs) || value.atMs < 0 ||
      !Number.isFinite(value.sampleDurationMs) || value.sampleDurationMs < 0 || !Array.isArray(value.processes) || value.processes.length > 64 ||
      !Array.isArray(value.roots) || value.roots.length < 1 || value.roots.length > 9 || !Array.isArray(value.errors) || value.errors.length > 64)
    throw new Error('Invalid resource sample.');
  const roots = new Map(), rootPids = new Set(), pids = new Set();
  for (const root of value.roots) {
    const key = identity(root);
    if (roots.has(key) || rootPids.has(root.pid) || !['renderer', 'task-guard', 'observer'].includes(root.role) || typeof root.alive !== 'boolean') throw new Error('Invalid root scope.');
    roots.set(key, root); rootPids.add(root.pid);
  }
  for (const row of value.processes) {
    identity(row);
    if (pids.has(row.pid) || !roots.has(row.root) || !ROLES.includes(row.role) || !Number.isSafeInteger(row.rssBytes) || row.rssBytes < 0 ||
        !Number.isFinite(row.cpuMs) || row.cpuMs < 0 || typeof row.image !== 'string' || row.image.length > 260 ||
        row.imagePath !== undefined && (typeof row.imagePath !== 'string' || row.imagePath.length > 32768 || !/^[A-Za-z]:\\/.test(row.imagePath)))
      throw new Error('Invalid/duplicate resource process.');
    const declared = roots.get(identity(row)), owner = roots.get(row.root);
    if (declared && (row.root !== identity(row) || row.role !== declared.role) ||
        (owner.role === 'observer') !== (row.role === 'observer' || row.role === 'observer-child'))
      throw new Error('Process cannot change its declared observation scope.');
    pids.add(row.pid);
  }
  return value;
}
function createAggregation(options = {}) {
  const limits = { pluginRssStopBytes: options.pluginRssStopBytes ?? 1.5 * 1024 ** 3, ffmpegRssStopBytes: options.ffmpegRssStopBytes ?? 1024 ** 3 };
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('Invalid observation stop line.');
  let prior = null, count = 0, firstAt = null, lastAt = null, maxGapMs = 0, maxSampleDurationMs = 0;
  const peaks = { pluginRssBytes: 0, preprocessingRssBytes: 0, observerRssBytes: 0, observedCombinedRssBytes: 0 };
  const perRolePeaks = {}, stopReasons = new Set();
  function add(input) {
    const value = sample(input);
    if (lastAt !== null && value.atMs <= lastAt) throw new Error('Resource sample time must advance.');
    if (lastAt !== null) maxGapMs = Math.max(maxGapMs, value.atMs - lastAt);
    maxSampleDurationMs = Math.max(maxSampleDurationMs, value.sampleDurationMs);
    if (firstAt === null) firstAt = value.atMs;
    lastAt = value.atMs; count++;
    const sums = { pluginRssBytes: 0, preprocessingRssBytes: 0, observerRssBytes: 0, observedCombinedRssBytes: 0 }, roles = {};
    if (value.errors.length) stopReasons.add('owned-observation-incomplete');
    for (const root of value.roots) if (root.alive && !value.processes.some(p => identity(p) === identity(root))) stopReasons.add('live-root-sample-missing');
    for (const row of value.processes) {
      if (row.role === 'owned-unclassified') stopReasons.add('owned-process-role-unclassified');
      if (PLUGIN.has(row.role)) sums.pluginRssBytes += row.rssBytes;
      if (row.role === 'ffmpeg' || row.role === 'ffprobe') sums.preprocessingRssBytes += row.rssBytes;
      if (row.role === 'observer' || row.role === 'observer-child') sums.observerRssBytes += row.rssBytes;
      sums.observedCombinedRssBytes += row.rssBytes;
      roles[row.role] = (roles[row.role] || 0) + row.rssBytes;
      if (row.role === 'ffmpeg' && row.rssBytes >= limits.ffmpegRssStopBytes) stopReasons.add('ffmpeg-observation-stop-line');
    }
    if (sums.pluginRssBytes >= limits.pluginRssStopBytes) stopReasons.add('plugin-observation-stop-line');
    if (Object.values(sums).some(n => !Number.isSafeInteger(n))) throw new Error('Resource sums exceed exact numeric range.');
    for (const key of Object.keys(peaks)) peaks[key] = Math.max(peaks[key], sums[key]);
    for (const [role, bytes] of Object.entries(roles)) perRolePeaks[role] = Math.max(perRolePeaks[role] || 0, bytes);
    let cpu = null, cpuIntervalComplete = false;
    if (prior) {
      const previous = new Map(prior.processes.map(p => [identity(p), p]));
      const intervalMs = value.atMs - prior.atMs, totals = { plugin: 0, preprocessing: 0, observer: 0 };
      cpuIntervalComplete = value.errors.length === 0 && prior.errors.length === 0 && previous.size === value.processes.length;
      let matched = 0;
      for (const row of value.processes) {
        const last = previous.get(identity(row));
        if (!last) { cpuIntervalComplete = false; continue; }
        if (last.role !== row.role || last.root !== row.root || row.cpuMs < last.cpuMs) throw new Error('Process scope/CPU counter changed.');
        matched++;
        const percent = (row.cpuMs - last.cpuMs) / intervalMs * 100;
        if (PLUGIN.has(row.role)) totals.plugin += percent;
        else if (row.role === 'ffmpeg' || row.role === 'ffprobe') totals.preprocessing += percent;
        else totals.observer += percent;
      }
      if (matched) cpu = totals;
      if (matched !== previous.size) cpuIntervalComplete = false;
    }
    const result = { atMs: value.atMs, ...sums, cpuCorePercent: cpu, cpuIntervalComplete, stopRequested: stopReasons.size > 0 };
    // No unbounded trace: caller owns bounded raw recording, not this analyzer.
    prior = { atMs: value.atMs, errors: value.errors.slice(), processes: value.processes.map(row => ({ ...row })) }; return result;
  }
  function summary() {
    return { schema: 'mvp-resource-observation-summary-v1', samples: count, firstAtMs: firstAt, lastAtMs: lastAt,
      maxGapMs, maxSampleDurationMs, peaks: { ...peaks }, perRolePeaks: { ...perRolePeaks }, limits: { ...limits },
      stopReasons: [...stopReasons], completeProtocolPassed: false,
      limitations: ['RSS sums align one polling window; individual process reads are not simultaneous.',
        'Approximate 100ms polling may miss short processes/peaks and final CPU before exit.',
        'CPU percentages use one logical core as 100%; partial intervals omit unobserved work and remain marked incomplete.',
        'Shared Eagle/GPU ownership and managed cache/disk budgets require separate evidence.',
        'This summary alone proves neither long-run trend, performance nor real-Eagle acceptance.'] };
  }
  return Object.freeze({ add, summary });
}
module.exports = { createAggregation, sample, identity, approvedLimits, ROLES };
