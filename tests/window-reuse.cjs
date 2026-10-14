'use strict';
// Model events/callbacks only: no Eagle, media, settings or evidence writes.
const assert = require('assert');
const { run, SOURCE } = require('./support/window-reuse.cjs');
async function check(fault) {
  let observer, reloads = 0, closes = 0, storeClosed = 0, saved, current, clock = 10;
  const config = { schema: 'T2-ram-host-v2', ramMiB: 2048, compressedMiB: 256, rendererStopMiB: 3072 };
  function snapshot(epoch) { return { state: 'paused', epoch, libraryEpoch: 0, sourceIdentity: SOURCE,
    loadMetrics: { reused: true, totalMs: 8, entryAt: 1, readyAt: 9 },
    playback: { budget: { limit: 2 * 1024 ** 3, used: 128, peak: 160 }, compressed: { limitBytes: 256 * 1024 ** 2 },
      frameOrdinal: 0, time: 0, activeImageTasks: 0, pendingTargets: 0 } }; }
  current = snapshot(1);
  if (fault === 'new-cache') current.loadMetrics.reused = false;
  if (fault === 'wrong-budget') current.playback.budget.limit = 1024 ** 3;
  if (fault === 'pending') current.playback.pendingTargets = 1;
  if (fault === 'wrong-frame') current.playback.frameOrdinal = 5;
  if (fault === 'clock') current.loadMetrics.readyAt = NaN;
  if (['prefetch', 'prefetch-timeout', 'prefetch-identity', 'prefetch-cancel'].includes(fault)) current.playback.activeImageTasks = 1;
  const win = { performance: { now: () => clock }, clearTimeout, setInterval, clearInterval,
    setTimeout(fn, ms) { if (ms !== 10) return setTimeout(fn, ms);
      return setTimeout(() => { clock += fault === 'prefetch-timeout' ? 10001 : 10;
        if (fault === 'prefetch-cancel') job.cancel();
        else if (fault === 'prefetch-identity') current.sourceIdentity = { ...SOURCE, itemId: 'changed' };
        else current.playback.activeImageTasks = 0;
        fn(); }, 1); } };
  const release = bytes => observer({ type: 'player', value: { event: { phase: 'disposed', budgetBytes: bytes } } });
  const job = run({ window: win, pluginRoot: __dirname, launchContext: { ramDiagnostic: config },
    bridge: { snapshot: () => current, subscribe: fn => { observer = fn; return () => { observer = null; }; } },
    createStore: () => ({ start(v) { assert.equal(v.reserveBytes, 256 * 1024); }, close() { storeClosed++; },
      save(kind, value) { assert.equal(kind, 'host'); saved = value; if (fault === 'save') throw new Error('full'); return { model: true }; } }),
    captureSelected: async () => ({ itemId: fault === 'selection' ? 'different' : SOURCE.itemId }),
    verifyLaunch() { if (fault === 'source-changed') throw new Error('hash mismatch'); },
    memory: () => fault === 'rss' || fault === 'rss-after-reload' && reloads ? 3 * 1024 ** 3 : 1024 ** 3,
    reloadSelected: async () => {
      reloads++; const epoch = current.epoch; release(fault === 'release' ? 64 : 0); current = snapshot(epoch + 1);
      if (fault === 'epoch') current.epoch = epoch;
      if (fault === 'library') current.libraryEpoch = 1;
      if (fault === 'source') current.sourceIdentity = { ...SOURCE, sha256: 'wrong' };
      if (fault === 'cancel') job.cancel();
    },
    closeSession: async () => { closes++; release(fault === 'close-release' ? 64 : 0); current = { state: 'closed' }; return { status: 'closed' }; } });
  if (fault === 'save') { await assert.rejects(job.done, /full/); const pending = JSON.parse(job.unsavedEvidence());
    assert.equal(pending.persisted, false); assert.equal(pending.reuseGatePassed, false); assert.equal(pending.loads.length, 3); }
  else {
    const result = await job.done;
    const expectedPass = !fault || fault === 'prefetch';
    assert.equal(result.reuseGatePassed, expectedPass, fault);
    assert.equal(saved.complete, expectedPass, fault);
    assert.equal(saved.resourceStop.thresholdBytes, 3 * 1024 ** 3);
    if (expectedPass) { assert.equal(reloads, 2); assert.equal(saved.loads.length, 3); assert.deepEqual(saved.releases, [0, 0, 0]); }
    if (fault === 'prefetch') { assert.equal(saved.loads[0].readyPlayback.activeImageTasks, 1);
      assert.equal(saved.loads[0].settledPlayback.activeImageTasks, 0); assert.equal(saved.loads[0].settleMs, 10);
      assert.equal(saved.loads[0].loadMetrics.totalMs, 8); }
    if (['selection', 'source-changed', 'new-cache', 'wrong-budget', 'pending', 'wrong-frame', 'rss'].includes(fault)) assert.equal(reloads, 0);
    if (fault === 'rss' || fault === 'rss-after-reload') assert(saved.resourceStop.requested);
  }
  assert.equal(closes, 1); assert.equal(storeClosed, 1); assert.equal(observer, null);
}
(async () => {
  for (const fault of [undefined, 'new-cache', 'wrong-budget', 'pending', 'wrong-frame', 'selection', 'source-changed', 'epoch', 'library', 'source', 'release', 'rss', 'rss-after-reload', 'close-release', 'cancel', 'save', 'clock', 'prefetch', 'prefetch-timeout', 'prefetch-identity', 'prefetch-cancel']) await check(fault);
  console.log('Window reuse: 21 model cases passed; reload/identity/release/RSS/cancel/save guards and separate bounded prefetch drain; no Eagle or media.');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
