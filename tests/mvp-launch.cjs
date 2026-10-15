'use strict';
const assert = require('assert'), path = require('path');
const { install } = require('./support/mvp-launch.cjs');
const plugin = path.resolve(__dirname, '../plugin'), host = path.resolve(__dirname, 'host/t4');
const flush = () => new Promise(r => setImmediate(r));
function fixture(settings = {}) {
  const h = { records: [], timers: new Map(), events: new Map(), sdk: {}, closed: 0, cancelled: 0, driverCalls: 0, storeCloses: 0 };
  let serial = 0, complete;
  h.win = { performance: { now: () => 0 }, addEventListener: (n, f) => h.events.set(n, f),
    setTimeout: f => { h.timers.set(++serial, f); return serial; }, clearTimeout: n => h.timers.delete(n),
    EVADiagnostics: { snapshot: () => ({ state: 'paused', playback: { budget: { limit: 1024 ** 3 } },
      sourceIdentity: { itemId: 'model', sha256: 'a'.repeat(64) }, loadMetrics: { totalMs: 10 } }) } };
  h.nodes = Object.fromEntries(['status', 'notice', 'error'].map(id => [id, { textContent: '正在关闭…', hidden: false }]));
  h.doc = { title: '', getElementById: id => h.nodes[id] };
  h.eagle = { onPluginCreate(f) { h.sdk.create = f; }, onPluginBeforeExit(f) { h.sdk.exit = f; } };
  const monitor = { issue: null, async stop() { return { issue: null, rows: [1, 2],
    observer: { samples: 15, stopReasons: [] }, limitations: ['model only'] }; } };
  h.job = install({ window: h.win, document: h.doc, eagle: h.eagle, hostRoot: host, helpers: {
    verify: () => ({ host, plugin, marker: { sourceHashes: {} } }), memory: () => ({ ramBytes: 1024 ** 3 }),
    createStore: () => ({ start() { if (settings.recordFailure) throw Error('record capacity unavailable'); return { runId: 'a'.repeat(32) }; },
      save(kind, payload) { h.records.push({ kind, payload }); return { file: 'model/' + h.records.length }; }, close() { h.storeCloses++; } }),
    startMonitor(options) { h.monitorOptions = options; return monitor; },
    startDriver(options) { h.driverCalls++; h.driverOptions = options; return { cancel() { h.cancelled++; }, done: new Promise(r => { complete = r; }) }; }
  } });
  h.eagle.onPluginCreate(info => { h.createdPath = info.path; return 'formal-create-result'; });
  h.eagle.onPluginBeforeExit(() => { h.closed++; return settings.close ? settings.close() : 'formal-close-result'; });
  h.ready = () => { const first = h.timers.entries().next().value; if (first) { h.timers.delete(first[0]); first[1](); } };
  h.complete = value => complete(value); return h;
}
async function main() {
  const failed = fixture({ recordFailure: true });
  assert(failed.job.status().disabled); assert.strictEqual(failed.sdk.create({ path: host }), 'formal-create-result');
  assert.strictEqual(failed.createdPath, plugin); assert.strictEqual(failed.driverCalls, 0);
  assert.strictEqual(failed.sdk.exit(), 'formal-close-result'); assert.strictEqual(failed.closed, 1);
  const cancelled = fixture(), initial = cancelled.records.length, late = cancelled.timers.values().next().value;
  cancelled.sdk.exit(); late(); await flush();
  assert(cancelled.job.status().closing); assert.strictEqual(cancelled.driverCalls, 0); assert.strictEqual(cancelled.records.length, initial);
  const success = fixture(); success.ready(); assert.strictEqual(success.driverOptions.evidenceStage, 'T4');
  assert(success.driverOptions.extraFingerprints.includes('native/task-host.local.exe'));
  success.complete({ earlyRegressionPassed: true }); await flush();
  assert(success.job.status().finished);
  const summary = success.records.find(r => r.payload.schema === 'mvp-current-runtime-regression-summary-v1').payload;
  assert(summary.currentRegressionPassed); assert.strictEqual(summary.overallT2Accepted, false); assert.strictEqual(summary.overallT4Accepted, false);
  assert.strictEqual(summary.userObservations, 'not-recorded');
  const stopped = fixture(); stopped.ready(); stopped.monitorOptions.onStop(new Error('plugin-observation-stop-line'));
  assert.strictEqual(stopped.cancelled, 1); assert.strictEqual(stopped.closed, 1);
  stopped.complete({ earlyRegressionPassed: false }); await flush();
  assert(!stopped.records.find(r => r.payload.schema === 'mvp-current-runtime-regression-summary-v1').payload.currentRegressionPassed);
  assert(stopped.nodes.status.textContent.includes('资源已释放'));
  let release;
  const pending = fixture({ close: () => new Promise(resolve => { release = resolve; }) });
  pending.monitorOptions.onStop(Error('owned-observation-incomplete')); pending.ready(); await flush();
  assert.strictEqual(pending.nodes.status.textContent, '正在关闭…'); assert(!pending.job.status().finished);
  release({ status: 'closed' }); await flush();
  assert(pending.nodes.status.textContent.includes('资源已释放'));
  assert.strictEqual(pending.records.find(r => r.payload.schema === 'mvp-current-runtime-regression-summary-v1').payload.observationCleanup.status, 'completed');
  const cleanupFailure = fixture({ close: () => Promise.reject(Error('model cleanup failure')) });
  cleanupFailure.monitorOptions.onStop(Error('owned-observation-incomplete')); cleanupFailure.ready(); await flush();
  assert(cleanupFailure.nodes.status.textContent.includes('清理失败')); assert.strictEqual(cleanupFailure.nodes.error.textContent, 'model cleanup failure');
  const exiting = fixture({ close: () => Promise.resolve({ status: 'closed' }) });
  exiting.monitorOptions.onStop(Error('owned-observation-incomplete')); exiting.ready(); exiting.sdk.exit(); await flush();
  assert(!exiting.job.status().finished); assert(!exiting.records.some(r => r.payload.schema === 'mvp-current-runtime-regression-summary-v1'));
  console.log('MVP launch models: record failure leaves formal startup/path/close intact; close cancels without late failures; current T4 evidence/stop scope wired; not real Eagle.');
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
