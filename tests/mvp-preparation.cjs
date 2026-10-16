'use strict';
// Memory-only SDK/window/runtime models; no files, media or real Eagle writes.
const assert = require('assert'), path = require('path'), fs = require('fs'), vm = require('vm');
const { install } = require('./support/mvp-preparation.cjs');
const runtime = require('./support/preparation-runtime.cjs'), host = path.resolve(__dirname, 'host/t4');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(settings = {}) {
  const profile = runtime.PROFILES[settings.profile || 'sonic'], frames = profile.frames;
  const source = { itemId: profile.id, sha256: profile.sha256, filePath: 'G:\\素材\\' + profile.name + '.mp4' };
  const h = { sdk: {}, records: [], marks: [], timers: new Map(), calls: 0, closes: 0, clears: [], disposed: 0, subscribers: new Set(), current: null, clock: 100, consumed: settings.consumed };
  let serial = 0, closeTask = null;
  const reference = { root: runtime.ROOT, ownerSha256: 'a'.repeat(64) };
  h.nodes = Object.fromEntries(['status', 'notice', 'error'].map(id => [id, { hidden: true, textContent: '' }]));
  h.doc = { body: { inert: false }, getElementById: id => h.nodes[id] };
  h.win = { performance: { now: () => h.clock }, addEventListener() {},
    setTimeout(f, ms) { h.timers.set(++serial, { f, ms }); return serial; }, clearTimeout(n) { h.timers.delete(n); },
    EVADiagnostics: { snapshot: () => h.current, subscribe(f) { h.subscribers.add(f); return () => h.subscribers.delete(f); } } };
  h.eagle = { onPluginCreate(f) { h.sdk.create = f; if (settings.immediateCreate) h.immediate = f({ path: host }); }, onPluginRun(f) { h.sdk.run = f; }, onPluginBeforeExit(f) { h.sdk.exit = f; } };
  h.job = install({ window: h.win, document: h.doc, eagle: h.eagle, hostRoot: host, helpers: {
    verify: () => { if (settings.verifyFailure) throw Error('model-fingerprint-changed'); return { host, marker: { mode: settings.entryChanged && h.calls ? 'performance' : 'preparation', preparation: reference, sourceHashes: {} } }; },
    runtime: {
      verify: () => ({ source, limits: { diskBytes: 240 * 1024 ** 2 }, original: {}, copied: {}, verifyFrames: !!settings.verifyFrames, expectedFrames: frames }),
      mark(ref, name, value) { if (name === 'started.json') { if (h.consumed) throw Error('model-already-started'); h.consumed = true; }
        h.marks.push({ name, value }); },
      clear(ref, store, reason) { assert.equal(h.current.state, 'closed'); assert(!settings.holdClose || h.released); h.clears.push(reason); },
      async cleanup() { h.cleaned = true; return { removed: true, bytes: 1 }; }
    },
    select: async () => settings.wrongSelection ? { ...source, itemId: 'other' } : source,
    async verifySourceFrames(options) { assert.equal(h.calls, 6); assert.equal(h.current.state, 'paused'); assert(!options.signal.aborted);
      h.sourceFramesChecked = true; h.clock += 1000; return { passed: !settings.failSourceFrames }; },
    async verifyNumberedFrames(options) { assert.equal(h.calls, 6); assert.equal(h.closes, 6); assert.equal(h.current.state, 'closed');
      h.numberedFramesChecked = true; if (settings.holdNumbered) {
        options.onActive({ backend: { beginClose() { h.fixtureCloseArmed = true; } }, player: { dispose() { h.fixtureDisposed = true; return Promise.resolve(); } } });
        await new Promise((resolve, reject) => { h.numberedPending = true;
          options.signal.addEventListener('abort', () => reject(Error('model-numbered-aborted')), { once: true }); }); }
      return { passed: !settings.failNumberedFrames }; },
    createStore: () => ({ start() { if (settings.recordFailure) throw Error('model-record-capacity'); return { runId: 'a'.repeat(32) }; },
      save(kind, payload) { assert(!h.storeClosed); h.records.push({ kind, payload }); return { file: 'model/' + h.records.length }; }, close() { h.storeClosed = true; } }),
    manifest: () => ({ manifestSha256: 'b'.repeat(64), info: { framePack: { schema: 1, file: 'frames.pack', bytes: frames, sha256: 'a'.repeat(64) },
      frames: Array.from({ length: frames }, (_, n) => ({ id: n, file: String(n).padStart(6, '0') + '.jpg', offset: n, bytes: 1, sha256: 'a'.repeat(64) })), audio: { file: 'audio.wav' } } }),
    startMonitor(options) { h.monitorOptions = options; return { issue: settings.resourceIssue || null, async stop() { return { rows: [1, 2], issue: settings.resourceIssue || null,
      observer: { samples: 15, stopReasons: settings.resourceIssue ? ['model-resource-incomplete'] : [] } }; } }; }
  } });
  async function load() {
    h.calls++; closeTask = null; h.clock += 5;
    if (settings.holdAt === h.calls) { h.current = { state: 'preparing' }; return new Promise(() => {}); }
    const entryAt = h.clock; h.clock += settings.slow ? 30000 : 40;
    const reused = settings.badReuse ? false : h.calls % 2 === 0;
    h.current = { state: 'paused', pluginRoot: reference.root, duration: 24.845, sourceIdentity: source,
      playback: { state: 'paused', frameId: 0, drawCount: 1, pendingTargets: 0, audioAvailable: !settings.noAudio,
        budget: { limit: settings.badBudget ? 512 * 1024 ** 2 : 1024 ** 3, used: 5000 }, compressed: { limitBytes: 128 * 1024 ** 2 } },
      loadMetrics: { entryAt, readyAt: h.clock, totalMs: h.clock - entryAt, reused, trigger: h.calls === 1 ? 'plugin-create' : 'plugin-run' } };
  }
  function close() {
    if (!closeTask) {
      h.closes++;
      closeTask = (async () => {
        if (settings.holdClose && !h.released) await new Promise(resolve => { h.release = () => { h.released = true; resolve(); }; });
        if (settings.closeFailure) throw Error('model-release-failure');
        h.current = { state: 'closed' }; h.disposed++;
        for (const f of h.subscribers) f({ type: 'player', value: { event: { phase: 'disposed', budgetBytes: settings.badDispose ? 1 : 0 } } });
        return { status: 'closed' };
      })();
    }
    return closeTask;
  }
  h.eagle.onPluginCreate(load); h.eagle.onPluginRun(load); h.eagle.onPluginBeforeExit(close);
  h.start = () => h.sdk.create({ path: host });
  h.summary = () => h.records.find(r => r.payload.schema === 'mvp-p03-window-summary-v1')?.payload;
  return h;
}
async function main() {
  let count = 0; async function test(name, body) { await body(); count++; console.log('ok P03 ' + name); }
  await test('explicit VP9 profile binds all 828 frames without repeating accepted Canvas checks', async () => {
    const h = fixture({ profile: 'vp9' }); await h.start(); assert(h.summary().passed);
    assert.equal(h.calls, 6); assert.equal(h.closes, 6); assert.equal(h.clears.length, 3);
    assert(h.summary().rows.every(r => r.frames === 828 && r.sourceIdentity.itemId === runtime.PROFILES.vp9.id));
    assert(!h.sourceFramesChecked && !h.numberedFramesChecked);
    const { entryMode } = require('../scripts/prepare-mvp-host.cjs')._test;
    assert.deepEqual(entryMode('preparation-vp9'), { mode: 'preparation', profile: 'vp9' });
    assert.deepEqual(entryMode('preparation-hevc'), { mode: 'preparation', profile: 'hevc' });
    assert.deepEqual(entryMode('preparation'), { mode: 'preparation', profile: 'sonic' });
    for (const mode of ['__proto__', 'preparation-h264', '--preparation-vp9']) assert.throws(() => entryMode(mode));
  });
  await test('six complete loads, alternate real generation/reuse, explicit readiness boundaries and release-before-reset', async () => {
    const h = fixture(); await h.start(); const s = h.summary();
    assert(s.complete && s.passed); assert.equal(h.calls, 6); assert.equal(h.closes, 6); assert.equal(h.disposed, 6);
    assert.deepEqual(s.rows.map(r => r.kind), ['first', 'reuse', 'first', 'reuse', 'first', 'reuse']);
    assert.deepEqual(h.clears, ['before-first-2', 'before-first-3', 'protocol-finished']); assert(h.cleaned);
    assert(s.rows.every(r => r.callbackToReadyMs > r.appLoadMetrics.totalMs));
    assert.equal(s.rows[0].entry, 'real-SDK-create'); assert.equal(s.rows[1].entry, 'controlled-registered-formal-run');
    assert.equal(s.overallT4Accepted, false); assert.equal(s.userObservations, 'not-recorded'); assert.equal(h.marks.length, 2);
    h.sdk.run(); assert.equal(h.calls, 6); assert(h.job.status().finished); assert.equal(h.subscribers.size, 0);
  });
  await test('explicit frame profile checks source before close and numbered Canvas after all formal resources release, outside readiness timing', async () => {
    const h = fixture({ verifyFrames: true }); await h.start(); assert(h.summary().passed); assert(h.sourceFramesChecked && h.numberedFramesChecked);
    assert(h.summary().rows.every(r => r.callbackToReadyMs < 100)); assert(h.summary().sourceFrameChecks.passed && h.summary().numberedFrameChecks.passed);
  });
  for (const extra of [{ failSourceFrames: true }, { failNumberedFrames: true }]) await test('failed extra Canvas checks cannot produce acceptance ' + JSON.stringify(extra), async () => {
    const h = fixture({ verifyFrames: true, ...extra }); await h.start(); assert(!h.summary().passed); assert(!h.cleaned); assert.equal(h.closes, 6);
  });
  await test('SDK exit during numbered Canvas cancels it without late records or failure popup', async () => {
    const h = fixture({ verifyFrames: true, holdNumbered: true }), job = h.start();
    for (let n = 0; !h.numberedPending && n < 40; n++) await flush(); assert(h.numberedPending);
    const records = h.records.length; await h.sdk.exit(); await job; assert.equal(h.records.length, records); assert(!h.summary());
    assert(h.fixtureCloseArmed && h.fixtureDisposed);
  });
  for (const settings of [{ noAudio: true }, { badBudget: true }, { badReuse: true }, { badDispose: true }, { closeFailure: true }])
    await test('refuse readiness/reuse/release violation ' + JSON.stringify(settings), async () => {
      const h = fixture(settings); await h.start(); assert(!h.summary().passed); assert(!h.summary().complete); assert(!h.cleaned); assert(h.calls <= 2);
    });
  await test('slow first loads complete but fail the unchanged duration limit; reuse has no invented limit', async () => {
    const h = fixture({ slow: true }); await h.start(); assert(h.summary().complete); assert(!h.summary().passed);
    assert(h.summary().rows.filter(r => r.kind === 'reuse').every(r => r.firstRequirementPassed === null));
  });
  for (const settings of [{ consumed: true }, { wrongSelection: true }, { verifyFailure: true }, { recordFailure: true }])
    await test('preflight never starts product or resets cache ' + JSON.stringify(settings), async () => {
      const h = fixture(settings); await h.start(); assert.equal(h.calls, 0); assert.equal(h.clears.length, 0); assert(!h.cleaned);
      assert(h.job.status().finished); h.sdk.run(); assert(h.doc.title.includes('本项已结束'));
    });
  await test('cannot start next load or clear cache until actual close resolves', async () => {
    const h = fixture({ holdClose: true }), done = h.start(); await flush();
    assert.equal(h.calls, 1); assert.equal(h.clears.length, 0); assert(!h.job.status().finished);
    h.release(); await done; assert(h.summary().passed); assert.equal(h.calls, 6);
  });
  await test('resource stop aborts a pending preparation, closes once, saves failure and preserves cache', async () => {
    const h = fixture({ holdAt: 1 }), done = h.start(); await flush();
    h.monitorOptions.onStop(Error('model-resource-stop')); await done;
    assert(!h.summary().passed); assert(h.summary().error.includes('model-resource-stop')); assert.equal(h.closes, 1); assert(!h.cleaned);
  });
  await test('timeout stops without retrying a preparation', async () => {
    const h = fixture({ holdAt: 1 }), done = h.start(); await flush();
    [...h.timers.values()].find(t => t.ms === 60000).f(); await done;
    assert(!h.summary().passed); assert.equal(h.calls, 1); assert(!h.cleaned);
  });
  await test('SDK close during preparation makes no late measurement writes or failure popup', async () => {
    const h = fixture({ holdAt: 1 }), done = h.start(); await flush(); const before = h.records.length;
    await h.sdk.exit(); await done; assert(h.job.status().closing); assert.equal(h.records.length, before); assert(!h.summary()); assert(!h.cleaned);
  });
  await test('missing resource completeness cannot produce P03 acceptance', async () => {
    const h = fixture({ resourceIssue: 'model-resource-incomplete' }); await h.start(); assert(!h.summary().complete); assert(!h.summary().passed); assert(!h.cleaned);
  });
  await test('synchronous SDK create waits for normal run/close registration without losing its entry clock', async () => {
    const h = fixture({ immediateCreate: true }); await h.immediate; assert(h.summary().passed); assert.equal(h.calls, 6);
  });
  await test('duplicate create during async preflight starts only one six-load sequence', async () => {
    const h = fixture(); await Promise.all([h.start(), h.start()]); assert(h.summary().passed); assert.equal(h.calls, 6);
    assert.equal(h.marks.filter(m => m.name === 'started.json').length, 1);
  });
  await test('SDK exit before deferred create writes no late records or starts a product', async () => {
    const h = fixture(), done = h.start(); await h.sdk.exit(); await done; assert.equal(h.records.length, 0); assert.equal(h.calls, 0);
  });
  await test('real bootstrap routes file/eagleplugin URLs by explicit mode without starting the other driver', async () => {
    const source = fs.readFileSync(path.join(host, 'bootstrap.js'), 'utf8');
    const fileUrl = require('url').pathToFileURL(path.join(host, 'index.local.html')).href;
    const eagleUrl = 'eagleplugin:///' + new URL(fileUrl).pathname.replace(/^\/+/, '');
    for (const mode of ['preparation', 'performance', 'stability']) for (const href of [fileUrl, eagleUrl]) {
      let loaded = null;
      vm.runInNewContext(source, { window: { location: { href } }, document: {}, eagle: {}, require(name) {
        if (name === 'path' || name === 'url') return require(name);
        if (name === path.resolve(host, '../../../scripts/prepare-mvp-host.cjs')) return { verify: () => ({ marker: { mode } }) };
        if (name === path.resolve(host, '../../support', mode === 'preparation' ? 'mvp-preparation.cjs' : mode === 'stability' ? 'mvp-stability.cjs' : 'mvp-launch.cjs')) return { install(options) { assert.equal(options.hostRoot, host); loaded = mode; } };
        throw Error('Unexpected bootstrap module: ' + name);
      } }); assert.equal(loaded, mode);
    }
  });
  await test('changing the configured mode cannot silently switch a running protocol or keep old fingerprints', async () => {
    const h = fixture({ entryChanged: true }); await h.start(); assert(!h.summary().passed); assert.equal(h.calls, 1); assert(!h.cleaned);
  });
  console.log('P03 preparation: ' + count + ' memory-only coordinator checks passed; not real Eagle or performance evidence.');
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
