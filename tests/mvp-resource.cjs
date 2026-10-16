'use strict';
const assert = require('assert');
const { createAggregation, sample, approvedLimits } = require('./support/mvp-resource.cjs');
assert.strictEqual(approvedLimits(1024 ** 3).pluginRssStopBytes, 1.5 * 1024 ** 3);
assert.strictEqual(approvedLimits(2 * 1024 ** 3).pluginRssStopBytes, 3 * 1024 ** 3);
assert.strictEqual(approvedLimits(2 * 1024 ** 3).ffmpegRssStopBytes, 1024 ** 3);
assert.throws(() => approvedLimits(10 * 1024 ** 3), /approved/);
const ticks = '638960000000000001';
const processRow = (pid, role, rssBytes, cpuMs = 0, startTicks = ticks) => ({ pid, startTicks, role,
  root: role === 'observer' ? '9:' + ticks : '1:' + ticks, image: 'fixture.exe', rssBytes, cpuMs });
const make = (atMs, rows, errors = []) => ({ schema: 'mvp-process-sample-v1', atMs, sampleDurationMs: 2, errors,
  processes: rows, roots: [{ pid: 1, startTicks: ticks, role: 'renderer', alive: rows.some(r => r.pid === 1) },
    { pid: 9, startTicks: ticks, role: 'observer', alive: rows.some(r => r.pid === 9) }] });
const a = createAggregation({ pluginRssStopBytes: 1000, ffmpegRssStopBytes: 500 });
const x = a.add(make(0, [processRow(1, 'renderer', 300), processRow(2, 'task-worker', 50), processRow(9, 'observer', 600)]));
assert.strictEqual(x.pluginRssBytes, 350); assert.strictEqual(x.observerRssBytes, 600); assert(!x.stopRequested);
const y = a.add(make(100, [processRow(1, 'renderer', 100, 50), processRow(2, 'task-worker', 200, 20), processRow(9, 'observer', 600, 5)]));
assert.deepStrictEqual(y.cpuCorePercent, { plugin: 70, preprocessing: 0, observer: 5 }); assert(y.cpuIntervalComplete);
assert.strictEqual(a.summary().peaks.pluginRssBytes, 350); // Not 300+200 historical maxima.
const reused = a.add(make(200, [processRow(1, 'renderer', 100, 60), processRow(2, 'task-worker', 200, 0, '638960000000000002')]));
assert(!reused.cpuIntervalComplete); assert.strictEqual(reused.cpuCorePercent.plugin, 10);
assert.throws(() => a.add(make(200, [])), /advance/);
assert.throws(() => sample(make(300, [processRow(1, 'renderer', 10), processRow(1, 'task-worker', 20)])), /duplicate/);
assert.throws(() => sample(make(300, [{ ...processRow(1, 'renderer', 10), startTicks: 638960000000000001 }])), /creation/);
assert.throws(() => sample(make(300, [{ ...processRow(1, 'renderer', 10), root: 'wrong' }])), /Invalid/);
assert.throws(() => sample(make(300, [{ ...processRow(1, 'renderer', 10), role: 'observer' }])), /scope/);
assert.throws(() => sample(make(300, [{ ...processRow(9, 'observer', 10), role: 'task-worker' }])), /scope/);
const line = createAggregation({ pluginRssStopBytes: 1000, ffmpegRssStopBytes: 500 });
assert(line.add(make(0, [processRow(1, 'renderer', 1000)])).stopRequested);
assert(line.summary().stopReasons.includes('plugin-observation-stop-line'));
const ff = createAggregation({ pluginRssStopBytes: 1000, ffmpegRssStopBytes: 500 });
assert(ff.add(make(0, [processRow(1, 'renderer', 1), processRow(3, 'ffmpeg', 500)])).stopRequested);
assert.strictEqual(ff.summary().peaks.pluginRssBytes, 1);
const unknown = createAggregation();
assert(unknown.add(make(0, [processRow(1, 'renderer', 1), processRow(3, 'owned-unclassified', 100)])).stopRequested);
assert.strictEqual(unknown.summary().peaks.pluginRssBytes, 101);
const consoleHost = createAggregation({ pluginRssStopBytes: 1000, ffmpegRssStopBytes: 500 });
assert(consoleHost.add(make(0, [processRow(1, 'renderer', 900), processRow(3, 'console-host', 100)])).stopRequested);
assert.strictEqual(consoleHost.summary().peaks.pluginRssBytes, 1000);
const helper = createAggregation({ pluginRssStopBytes: 1000, ffmpegRssStopBytes: 500 });
assert(helper.add(make(0, [processRow(1, 'renderer', 800), { ...processRow(4, 'system-helper', 200), imagePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }])).stopRequested);
assert.strictEqual(helper.summary().peaks.pluginRssBytes, 1000);
assert.throws(() => sample(make(0, [{ ...processRow(1, 'renderer', 1), imagePath: 'relative.exe' }])), /Invalid/);
const incomplete = createAggregation();
assert(incomplete.add(make(0, [], [{ pid: 1, reason: 'AccessDenied' }])).stopRequested);
const liveDenied = createAggregation();
assert(liveDenied.add(make(0, [processRow(1, 'renderer', 1)], [{ pid: 2, operation: 'child-image',
  nativeErrorCode: 5, parentPid: 1, startTicks: ticks, exitCheck: 'alive', exitCheckErrorCode: null }])).stopRequested);
assert.deepStrictEqual(liveDenied.summary().stopReasons, ['owned-observation-incomplete']);
const cpu = createAggregation(); cpu.add(make(0, [processRow(1, 'renderer', 1, 100)]));
assert.throws(() => cpu.add(make(100, [processRow(1, 'renderer', 1, 99)])), /counter/);
const multicore = createAggregation(), detached = make(0, [processRow(1, 'renderer', 1, 0)]);
multicore.add(detached); detached.processes[0].cpuMs = 1000;
assert.strictEqual(multicore.add(make(100, [processRow(1, 'renderer', 1, 250)])).cpuCorePercent.plugin, 250);
assert.strictEqual(a.summary().completeProtocolPassed, false);
console.log('MVP resource analysis: aligned RSS, separate helpers/FFmpeg, CPU deltas, PID reuse, incomplete scope and inclusive stop lines verified; no real-host claim.');
