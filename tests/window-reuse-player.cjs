'use strict';
// Actual product Player, fake images/canvas/RAF. No media, Eagle or large allocation.
const assert = require('assert');
const { Player } = require('../plugin/player.js');
const index = require('../plugin/frame-index.cjs');
const { run, SOURCE } = require('./support/window-reuse.cjs');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function main() {
  let clock = 0, nextRaf = 0, observer, player, releaseNeighbour, epoch = 0, saved, closed = false;
  let reloads = 0, metrics, initialActiveTasks, storeCloses = 0;
  const raf = new Map();
  const info = { source: { sha256: SOURCE.sha256 }, width: 16, height: 16, duration: .4,
    frames: index.buildIndex(Array.from({ length: 4 }, (_, i) => ({ id: i, ptsTicks: String(i), file: 'f'+i+'.jpg', bytes: 8 })),
      { timeBase: [1, 10], lastFrameEndTicks: '4' }).frames, audio: null };
  async function tick() { clock += 16; const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(fn => fn(clock)); await flush(); }
  const snapshot = () => closed ? { state: 'closed' } : { state: 'paused', epoch, libraryEpoch: 0,
    sourceIdentity: SOURCE, playback: player.snapshot(), loadMetrics: metrics };
  async function load() {
    const startedAt = clock;
    if (player) { releaseNeighbour(); await player.dispose(); }
    epoch++; closed = false;
    const gate = new Promise(resolve => { releaseNeighbour = resolve; });
    player = new Player({ frameIndex: index, experimentMode: 'compressed-ram', ramBytes: 2*1024**3, compressedRamBytes: 256*1024**2,
      canvas: { getContext: () => ({ drawImage() {} }) },
      readAsset: async (_info, file) => { const bytes = Buffer.alloc(8); bytes[0] = Number(file[1]); return bytes; },
      env: { now: () => clock, raf: fn => { const id=++nextRaf; raf.set(id,fn); return id; }, caf: id => raf.delete(id),
        decodeImage: async bytes => { if (bytes[0] === 1) await gate; return { width: 16, height: 16, close() {} }; } },
      emit: event => { if (observer) observer({ type: 'player', value: { event } }); } });
    let done = false, failure;
    const promise = player.load(info).then(() => { done = true; }, error => { done = true; failure = error; });
    for (let i=0; !done && i<20; i++) { await flush(); await tick(); }
    assert(done, 'actual Player load must finish while neighbour decode is held'); await promise; if (failure) throw failure;
    metrics = { entryAt: startedAt, readyAt: clock, totalMs: clock-startedAt, reused: true };
    assert.equal(player.snapshot().state, 'paused'); assert.equal(player.snapshot().frameOrdinal, 0);
    assert.equal(player.snapshot().pendingTargets, 0); assert.equal(player.snapshot().activeImageTasks, 1);
  }
  await load(); initialActiveTasks = player.snapshot().activeImageTasks;
  const win = { performance: { now: () => clock }, setInterval, clearInterval, clearTimeout,
    setTimeout(fn, ms) { return setTimeout(() => {
      if (ms === 10) { releaseNeighbour(); tick().then(fn, error => { throw error; }); }
      else fn();
    }, ms); } };
  const job = run({ window: win, pluginRoot: __dirname, launchContext: { ramDiagnostic: {
    schema: 'T2-ram-host-v2', ramMiB: 2048, compressedMiB: 256, rendererStopMiB: 3072 } },
    bridge: { snapshot, subscribe: fn => { observer=fn; return () => { observer=null; }; } },
    createStore: () => ({ start() {}, save(_kind,value) { saved=value; return {}; }, close() { storeCloses++; } }),
    memory: () => 1024**3, verifyLaunch() {}, captureSelected: async () => ({ itemId: SOURCE.itemId }),
    reloadSelected: async () => { reloads++; await load(); },
    closeSession: async () => { releaseNeighbour(); await player.dispose(); closed=true; return { status: 'closed' }; } });
  const result = await job.done;
  assert.equal(result.reuseGatePassed, true, saved.error);
  assert.equal(reloads, 2); assert.equal(saved.loads.length, 3); assert.equal(initialActiveTasks, 1);
  assert(saved.loads.every(value => value.readyPlayback.activeImageTasks === 1 && value.settledPlayback.activeImageTasks === 0));
  assert(saved.loads.every(value => value.loadMetrics.totalMs === value.settledLoadMetrics.totalMs));
  assert.deepEqual(saved.releases, [0,0,0]); assert.equal(player.snapshot().budget.used, 0);
  assert.equal(storeCloses, 1); assert.equal(observer, null);
  console.log('Window reuse actual Player integration: first frame paused with one gated neighbour task; three loads wait separately and retain original ready times; disposal ledger zero. Fake decoding/RAF, not Eagle.');
}
main().catch(error => { console.error(error.stack); process.exitCode=1; });
