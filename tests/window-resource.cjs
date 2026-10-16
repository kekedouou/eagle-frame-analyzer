'use strict';
// Accelerated model only: no Eagle, video reads, waits of 65 minutes, or evidence writes.
const assert = require('assert'), zlib = require('zlib');
const { _test: api, PROTOCOL } = require('./support/window-resource.cjs');
const MODEL = { ...PROTOCOL, workMs: 2000, idleMs: 300, cycleMs: 200, sampleMs: 10, actionMs: 5, loadTimeoutMs: 100, settleMs: 40 };
const MIB = 1024 ** 2;
let count = 0;
function model(settings = {}) {
  let clock = 0, next = 0, epoch = 1, state = 'paused', source = 0, selected = 0, closed = false, restored = false, storeClosed = false;
  let sampleCount = 0, writes = 0, reloaded = 0, frame = 0;
  const observers = new Set(), timers = new Map(), intervals = new Map(), saved = [];
  const samples = [0, 1].map(i => ({ id: 'item-' + i, sha256: String(i).repeat(64) }));
  const snapshot = () => ({ state, epoch, libraryEpoch: 0, loadMetrics: { reused: true }, sourceIdentity: { itemId: samples[source].id, sha256: samples[source].sha256 },
    playback: { frameId: frame, frameCount: 60, budget: { used: 100 * MIB, limit: 512 * MIB }, pendingTargets: 0, activeImageTasks: 0 } });
  function emit(event) { for (const observer of observers) observer({ type: 'player', value: { event } }); }
  const win = { performance: { now: () => clock }, PointerEvent: class { constructor(type, value) { this.type = type; Object.assign(this, value); } },
    dispatchEvent(event) { if (closed) return; if (settings.playbackError && event.type === 'pointermove') emit({ type: 'error', error: 'test decoder failure', code: 'TEST_DECODE', phase: 'background-image' }); if (event.type === 'pointerup') state = 'paused'; if (!settings.noDraws) emit({ type: 'draw' }); },
    setTimeout(callback, ms) {
      const id = ++next; timers.set(id, true);
      setImmediate(() => {
        if (!timers.delete(id)) return;
        const end = clock + ms;
        for (let at = clock + 1; at <= end; at++) {
          clock = at;
          if (state === 'playing' && clock % 10 === 0 && !settings.noPlayDraws) { frame = (frame + 1) % 60; emit({ type: 'draw' }); }
          for (const interval of intervals.values()) if (clock >= interval.next) { interval.next += interval.ms; interval.callback(); }
        }
        clock = end; callback();
      }); return id;
    }, clearTimeout: id => timers.delete(id),
    setInterval(callback, ms) { const id = ++next; intervals.set(id, { callback, ms, next: clock + ms }); return id; },
    clearInterval: id => intervals.delete(id) };
  const timeline = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 10 }), dispatchEvent: win.dispatchEvent };
  const nodes = { timeline, play: { click() { state = state === 'playing' ? 'paused' : 'playing'; } },
    previous: { click() { if (!settings.badStep) frame = Math.max(0, frame - 1); } }, next: { click() { if (!settings.badStep) frame = Math.min(59, frame + 1); } } };
  const options = { bridge: { snapshot, subscribe(observer) { observers.add(observer); return () => observers.delete(observer); } }, window: win,
    document: { visibilityState: settings.hidden ? 'hidden' : 'visible', hasFocus: () => !settings.hidden, getElementById: id => nodes[id] }, pluginRoot: 'D:/model/plugin',
    memory() { sampleCount++; return settings.rssStop && sampleCount > 3 ? 2 * 1024 ** 3 : 400 * MIB; }, cpu: () => ({ user: clock * 10, system: 0 }),
    verifyLaunch() { if (settings.changed) throw new Error('source changed'); },
    async selections() { return { samples, choose: i => { selected = i; }, async verify() {}, restore() { restored = true; } }; },
    reloadSelected() { reloaded++; if (settings.hangLoad) return new Promise(() => {});
      emit({ phase: 'disposed', budgetBytes: 0 }); epoch++; source = selected; state = 'paused'; return Promise.resolve(); },
    async closeSession() { closed = true; state = 'closed'; if (!settings.missingFinalEvent) emit({ phase: 'disposed', budgetBytes: settings.remainingBudget ? 1 : 0 }); return { status: settings.closeFailure ? 'error' : 'closed' }; },
    createStore: () => ({ start(value) { assert.strictEqual(value.reserveBytes, 4 * MIB); },
      save(kind, value) { writes++; if (settings.saveFailure || settings.summarySaveFailure && value.type === 'resource-summary') throw new Error('evidence full'); saved.push(value); return { file: 'model-' + writes }; },
      close() { storeClosed = true; } }) };
  return { options, saved, inspect: () => ({ closed, restored, storeClosed, observers: observers.size, intervals: intervals.size, reloaded, writes }) };
}
async function test(name, work) { await work(); count++; console.log('ok Window resource: ' + name); }
async function main() {
  await test('fixed-source SDK wrapper verifies both existing caches and restores the exact original getter', async () => {
    const first = { source: { id: 'current', ext: 'mp4', filePath: 'D:/current.mp4' }, sourceIdentity: { itemId: 'current', sha256: 'c'.repeat(64) } };
    const original = async () => ['original'];
    const eagle = { item: { getSelected: original, getById: async id => ({ id, ext: 'mp4', filePath: 'D:/other.mp4' }) } };
    let assets = 0;
    const dependencies = { hashSource: async file => file.includes('current') ? 'c'.repeat(64) : '0823a48f0d7b365163297206e8e8c66591c3aa6cf4c30253b3187d19c9644cba',
      manifest: () => ({ info: {} }), verifyAssets: async () => { assets++; } };
    const selection = await api.selections(eagle, first, 'D:/plugin', dependencies);
    assert.strictEqual(assets, 2); selection.choose(1);
    assert.strictEqual((await eagle.item.getSelected())[0].id, 'MV3FZJJ7AC1CI');
    selection.restore(); assert.strictEqual(eagle.item.getSelected, original);
    await assert.rejects(api.selections(eagle, first, 'D:/plugin', { ...dependencies, manifest() { throw new Error('missing cache'); } }), /missing cache/);
    assert.strictEqual(eagle.item.getSelected, original);
  });
  await test('compressed samples round-trip exactly and retain bounded segment identity', () => {
    const rows = [[100, 'drag', 0, 500, 100, 20, 0, 0, 1, 1]], packed = api.packRows(rows);
    assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(Buffer.from(packed.data, 'base64'))), rows);
    assert.throws(() => api.packRows(['x'.repeat(256 * 1024)]), /256KiB/);
  });
  await test('T4 streams every renderer sample to one bounded sink without writing old T2 chunks', async () => {
    const f = model(), rows = []; f.options.evidenceStage = 'T4'; f.options.onSample = row => rows.push(row);
    const job = api.execute(f.options, MODEL), result = await job.done;
    assert(result.complete); assert.equal(result.summary.stage, 'T4'); assert.equal(result.summary.totalSamples, rows.length);
    assert.equal(result.summary.externalTrace, true); assert(!f.saved.some(r => r.type === 'resource-chunk'));
    assert.equal(job.status().elapsedMs, null); assert.equal(result.summary.modelRun, true);
  });
  await test('a failed unified sink stops workload and preserves the original failure', async () => {
    const f = model(); f.options.onSample = () => { throw Error('model-unified-sink-full'); };
    const result = await api.execute(f.options, MODEL).done; assert(!result.complete);
    assert.match(result.summary.error, /model-unified-sink-full/); assert(f.inspect().closed);
  });
  await test('T4 requires actual play draws and accurate adjacent steps, rather than timer activity', async () => {
    const good = model(); good.options.verifyActivities = true;
    const result = await api.execute(good.options, MODEL).done; assert(result.complete); assert(result.summary.activities.length > 0);
    for (const settings of [{ noPlayDraws: true }, { badStep: true }]) {
      const bad = model(settings); bad.options.verifyActivities = true;
      const stopped = await api.execute(bad.options, MODEL).done; assert(!stopped.complete);
    }
  });
  await test('independent auditor recomputes real-duration sample groups and detects tampering/model provenance', () => {
    const audit = require('../scripts/audit-resource.cjs')._test;
    const rows = [];
    for (let t = 0; t <= 3900000; t += 100) {
      const second = t / 1000 % 60, phase = t >= 3600000 ? 'idle' : second < 20 ? 'drag' : second < 35 ? 'play' : second < 40 ? 'step' : 'load';
      rows.push([t, phase, Math.floor(t / 60000) % 2, 400 * MIB, 100 * MIB, t, 0, 0, t / 100, Math.floor(t / 60000), 1, 1]);
    }
    const summary = { protocol: PROTOCOL, modelRun: false, complete: true, resourceGatePassed: true,
      workElapsedMs: 3600000, idleElapsedMs: 300000, trend: api.trends(rows), totalSamples: rows.length,
      peakRendererRssBytes: 400 * MIB, peakManagedBytes: 100 * MIB, maxSampleGapMs: 100,
      sourceHashesVerifiedAtEnd: true, cleanup: { verified: true, result: 'closed', state: 'closed', disposedBudgetBytes: 0 } };
    assert(audit.evaluate(summary, rows).passed);
    assert.throws(() => audit.evaluate({ ...summary, modelRun: true }, rows), /model/);
    assert.throws(() => audit.evaluate({ ...summary, peakManagedBytes: 0 }, rows));
    const packed = api.packRows(rows.slice(0, 600)); assert.deepStrictEqual(audit.unpack(packed), rows.slice(0, 600));
    assert.throws(() => audit.unpack({ ...packed, sha256: '0'.repeat(64) }), /digest/);
  });
  await test('trend compares identical phase/source groups and refuses missing groups or excessive growth', () => {
    const rows = [];
    for (const minute of [11, 56]) for (const phase of ['drag', 'play', 'step']) for (const sample of [0, 1]) for (let i = 0; i < 30; i++)
      rows.push([minute * 60000, phase, sample, 400 * MIB]);
    assert(api.trends(rows).passed);
    assert(!api.trends(rows.filter(r => r[2] === 0)).passed);
    assert(!api.trends(rows.map(r => [r[0], r[1], r[2], r[3] + (r[0] > 55 * 60000 ? 70 * MIB : 0)])).passed);
  });
  await test('accelerated cycle exercises DOM, fixed-source reload, idle, cleanup and evidence without claiming real long-run pass', async () => {
    const f = model(), result = await api.execute(f.options, MODEL).done;
    assert(result.complete); assert.strictEqual(result.resourceGatePassed, false);
    const summary = f.saved.find(v => v.type === 'resource-summary');
    assert(summary.modelRun); assert(summary.totalSamples > 100); assert(summary.loads.length > 1); assert(summary.cleanup.verified);
    assert(f.saved.some(v => v.type === 'resource-chunk'));
    assert.deepStrictEqual({ ...f.inspect(), writes: 0, reloaded: 0 }, { closed: true, restored: true, storeClosed: true, observers: 0, intervals: 0, writes: 0, reloaded: 0 });
  });
  for (const [name, settings] of [['RSS stop', { rssStop: true }], ['source change', { changed: true }], ['load timeout', { hangLoad: true }]]) {
    await test(name + ' preserves failed summary and releases callbacks, selection wrapper and evidence lock', async () => {
      const f = model(settings), result = await api.execute(f.options, MODEL).done;
      assert(!result.complete); const summary = f.saved.find(v => v.type === 'resource-summary'); assert(summary.error); assert(summary.cleanup.verified);
      const state = f.inspect(); assert(state.closed && state.restored && state.storeClosed); assert.strictEqual(state.observers + state.intervals, 0);
    });
  }
  await test('background/focus loss keeps the resource workload running and retains explicit window-state samples', async () => {
    const f = model({ hidden: true }); const result = await api.execute(f.options, MODEL).done;
    assert(result.complete);
    const chunk = f.saved.find(v => v.type === 'resource-chunk');
    const rows = JSON.parse(zlib.gunzipSync(Buffer.from(chunk.samples.data, 'base64')));
    assert(rows.length > 0); assert(rows.every(row => row[10] === 0 && row[11] === 0));
    assert(f.inspect().reloaded > 0);
  });
  await test('suspended background drawing cannot be reported as completed resource workload', async () => {
    const f = model({ hidden: true, noDraws: true }); const result = await api.execute(f.options, MODEL).done;
    assert(!result.complete); assert.match(f.saved.find(v => v.type === 'resource-summary').error, /实际画面提交/);
  });
  await test('player failure preserves its original code/message/phase before the session is released', async () => {
    const f = model({ playbackError: true }); const result = await api.execute(f.options, MODEL).done;
    assert(!result.complete); const summary = f.saved.find(v => v.type === 'resource-summary');
    assert.match(summary.error, /test decoder failure/);
    assert.strictEqual(summary.playerFailures[0].code, 'TEST_DECODE');
    assert.strictEqual(summary.playerFailures[0].eventPhase, 'background-image');
  });
  await test('a previous video disposal event cannot stand in for the final current-video release', async () => {
    const f = model({ missingFinalEvent: true }); await api.execute(f.options, MODEL).done;
    assert(f.inspect().reloaded > 0); assert(!f.saved.find(v => v.type === 'resource-summary').cleanup.verified);
  });
  await test('zero RAM and closed UI state do not hide a failed formal cache-release result', async () => {
    const f = model({ closeFailure: true }); await api.execute(f.options, MODEL).done;
    const summary = f.saved.find(v => v.type === 'resource-summary');
    assert.strictEqual(summary.cleanup.disposedBudgetBytes, 0); assert.strictEqual(summary.cleanup.state, 'closed'); assert(!summary.cleanup.verified);
  });
  await test('nonzero disposed budget cannot pass resource cleanup', async () => {
    const f = model({ remainingBudget: true }); await api.execute(f.options, MODEL).done;
    assert(!f.saved.find(v => v.type === 'resource-summary').cleanup.verified);
  });
  await test('load cancellation preserves its root cause and does not wait for load timeout or invent a zero budget', async () => {
    const f = model({ hangLoad: true, missingFinalEvent: true }), job = api.execute(f.options, MODEL);
    while (!f.inspect().reloaded) await new Promise(resolve => setImmediate(resolve));
    job.cancel(Error('native-query-access-denied'));
    const result = await job.done, summary = f.saved.find(v => v.type === 'resource-summary');
    assert(!result.complete); assert.match(summary.error, /native-query-access-denied/);
    assert.equal(summary.cleanup.closePhase, 'load'); assert.equal(summary.cleanup.budgetObservation, 'not-observed-during-load');
    assert.equal(summary.cleanup.sessionCloseVerified, true); assert.equal(summary.cleanup.disposedBudgetBytes, null);
    assert(!summary.cleanup.verified); assert.equal(f.inspect().observers, 0); assert.equal(f.inspect().intervals, 0);
  });
  await test('final summary write failure preserves existing chunks and exposes a failed in-memory receipt', async () => {
    const f = model({ summarySaveFailure: true }), job = api.execute(f.options, MODEL);
    await assert.rejects(job.done, /evidence full/);
    assert(f.saved.length > 0); const last = JSON.parse(job.unsavedEvidence());
    assert.strictEqual(last.persisted, false); assert.strictEqual(last.resourceGatePassed, false); assert(f.inspect().storeClosed);
  });
  await test('failed evidence write is never retried and retains bounded unsaved summary', async () => {
    const f = model({ saveFailure: true }), job = api.execute(f.options, MODEL);
    await assert.rejects(job.done, /保存失败/); assert.strictEqual(f.inspect().writes, 1);
    assert(job.unsavedEvidence()); assert(Buffer.byteLength(job.unsavedEvidence()) < 2 * MIB); assert(f.inspect().storeClosed);
  });
  console.log('Window resource: ' + count + ' accelerated/pure checks passed; real 2x65-minute Eagle runs not executed.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
