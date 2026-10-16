'use strict';
// Accelerated SDK/driver models only. Not real Eagle, media or long timing.
const assert = require('assert'), path = require('path'), { install } = require('./support/mvp-stability.cjs');
const host = path.resolve(__dirname, 'host/t4'), root = path.join(host, 'stability-scratch'), flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(settings = {}) {
  const h = { sdk: {}, records: [], marks: [], loads: 0, closes: 0, events: 0, timers: new Map(), current: null, clock: 0, restored: false };
  let serial = 0;
  const sources = [0, 1].map(i => ({ id: 'source-' + i, itemId: 'source-' + i, ext: 'mp4', filePath: 'G:\\samples\\' + i + '.mp4', sha256: String(i + 1).repeat(64), frames: 60 }));
  const ref = { root, ownerSha256: 'a'.repeat(64) }, owner = { profile: 'vp9', sources, limits: { diskBytes: 240 * 1024 ** 2 } };
  h.doc = { body: {}, getElementById() { return {}; } };
  h.win = { performance: { now: () => h.clock }, addEventListener() {}, EVADiagnostics: { snapshot: () => h.current },
    setTimeout(f, ms) { const id = ++serial; h.timers.set(id, { f, ms }); if (ms < 1000) setImmediate(() => { if (h.timers.delete(id)) { h.clock += ms; f(); } }); return id; },
    clearTimeout(id) { h.timers.delete(id); } };
  const originalSelection = async () => ['actual-original'];
  h.eagle = { item: { getSelected: originalSelection, getById: async id => sources.find(s => s.id === id) },
    onPluginCreate(f) { h.sdk.create = f; }, onPluginRun(f) { h.sdk.run = f; }, onPluginBeforeExit(f) { h.sdk.exit = f; } };
  let lastContext = { elapsedMs: 0, phase: 'drag', sample: 0 };
  const helpers = {
    verify: () => ({ host, marker: { mode: settings.changed && h.loads > 1 ? 'experience' : 'stability', stability: ref, sourceHashes: {} } }),
    runtime: { unused() { if (settings.consumed) throw Error('model-consumed'); return owner; }, verify: () => owner,
      mark(reference, name, value) { assert(!h.closedStore); h.marks.push({ name, value }); }, async verifyAssets() {},
      cleanup() { h.cleaned = true; return { removed: true }; } },
    capture: async () => ({ ...sources[0], itemId: settings.wrongSelection ? 'other' : sources[0].id }), validate: value => value,
    hashSource: async file => settings.sourceChanged ? 'f'.repeat(64) : sources.find(s => s.filePath === file).sha256,
    createStore: () => ({ start() { if (settings.noCapacity) throw Error('model-capacity'); return { runId: 'a'.repeat(32) }; },
      save(kind, payload) { assert(!h.closedStore); if (settings.saveFailure) throw Error('model-save-failed'); h.records.push(payload); return { model: h.records.length }; },
      close() { h.closedStore = true; } }),
    recorder: () => ({ append() { h.events++; }, flush() { h.flushed = true; }, summary: () => ({ pendingEvents: 0, chunks: [] }) }),
    startMonitor(options) { h.monitorOptions = options; return { issue: null, async stop() { h.stopped = true;
      return { issue: settings.observeFailure ? 'model-observer-error' : null, observer: { samples: 39200, stopReasons: [] },
        lastSample: { processes: settings.groupAlive ? [{ role: 'task-worker' }] : [{ role: 'renderer' }] } }; } }; },
    startDriver(options) {
      h.driverOptions = options;
      const done = Promise.resolve().then(async () => {
        const selections = await options.selections(); selections.choose(1); await options.reloadSelected();
        options.onSample([100, 'drag', 1, 100, 100, 100, 0, 0, 1, 1, 0, 0]);
        for (const minute of [11, 56]) for (const phase of ['drag', 'play', 'step']) for (const sample of [0, 1]) for (let i = 0; i < 30; i++) {
          lastContext = { elapsedMs: minute * 60000, phase, sample };
          h.monitorOptions.onRow({ native: {}, context: lastContext, receivedAtMs: h.clock }, { pluginRssBytes: 400 * 1024 ** 2 });
        }
        await selections.verify(); await options.closeSession(); selections.restore();
        return { complete: !settings.workIncomplete, cleanupVerified: !settings.badCleanup, resourceGatePassed: !settings.badTrend,
          summary: { complete: true, error: settings.workIncomplete ? 'model-work-incomplete' : null, modelRun: true } };
      });
      return { done, cancel() { h.driverCancelled = true; }, status: () => lastContext };
    }
  };
  h.job = install({ window: h.win, document: h.doc, eagle: h.eagle, hostRoot: host, helpers });
  let closeTask = null;
  h.eagle.onPluginCreate(load); h.eagle.onPluginRun(load); h.eagle.onPluginBeforeExit(close);
  async function load() {
    h.loads++; if (settings.holdWarm && h.loads === 1) { h.warmPending = true; return new Promise(() => {}); }
    const selected = (await h.eagle.item.getSelected())[0];
    h.current = { state: 'paused', sourceIdentity: { itemId: selected.id, sha256: selected.sha256 }, pluginRoot: root, loadMetrics: {},
      playback: { frameId: 0, budget: { limit: 1024 ** 3 }, compressed: { limitBytes: 128 * 1024 ** 2 } } };
  }
  function close() { if (!closeTask) { h.closes++; h.current = { state: 'closed' }; closeTask = Promise.resolve({ status: 'closed' }); } return closeTask; }
  h.start = () => h.sdk.create({ path: host }); h.summary = () => h.records.find(r => r.schema === 'mvp-stability-summary-v1');
  h.originalSelection = originalSelection; return h;
}
async function main() {
  const normal = fixture(); await normal.start(); assert(normal.summary().passed); assert(normal.cleaned && normal.flushed && normal.stopped);
  assert.equal(normal.loads, 4); assert.equal(normal.closes, 1); assert.equal(normal.eagle.item.getSelected, normal.originalSelection);
  assert.equal(normal.driverOptions.evidenceStage, 'T4'); assert.equal(normal.monitorOptions.long, true);
  assert.equal(normal.driverOptions.verifyActivities, true);
  const mode = require('../scripts/prepare-mvp-host.cjs')._test.entryMode;
  assert.deepEqual(mode('stability-vp9'), { mode: 'stability', profile: 'vp9' });
  assert.deepEqual(mode('stability-hevc'), { mode: 'stability', profile: 'hevc' });
  assert.throws(() => mode('stability-av1'));
  for (const settings of [{ wrongSelection: true }, { consumed: true }, { sourceChanged: true }, { noCapacity: true }]) {
    const h = fixture(settings); await h.start(); assert.equal(h.loads, 0); assert(!h.cleaned); assert(!h.summary()?.passed);
  }
  for (const settings of [{ changed: true }, { observeFailure: true }, { groupAlive: true }, { badTrend: true }, { workIncomplete: true }, { badCleanup: true }, { saveFailure: true }]) {
    const h = fixture(settings); await h.start(); assert(!h.summary()?.passed); assert.equal(h.eagle.item.getSelected, h.originalSelection);
  }
  const closed = fixture({ holdWarm: true }), pending = closed.start();
  while (!closed.warmPending) await flush(); const writes = closed.records.length;
  await closed.sdk.exit(); await pending; assert.equal(closed.records.length, writes); assert.equal(closed.marks.length, 1); assert.equal(closed.closes, 1);
  assert.equal(closed.eagle.item.getSelected, closed.originalSelection);
  const stopped = fixture({ holdWarm: true }), waiting = stopped.start(); while (!stopped.warmPending) await flush();
  stopped.monitorOptions.onStop(Error('model-resource-stop')); await waiting; assert(!stopped.summary().complete); assert(!stopped.cleaned); assert.equal(stopped.closes, 1);
  const timed = fixture({ holdWarm: true }), timeJob = timed.start(); while (!timed.warmPending) await flush();
  const timeout = [...timed.timers.values()].find(t => t.ms === 120000); assert(timeout); timeout.f(); await timeJob;
  assert.match(timed.summary().error, /120秒/); assert(!timed.summary().passed);
  console.log('mvp stability: success/failure/cancel/timeout SDK models, source binding, restore, resource and closed-group gates; not real Eagle or long timing.');
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
