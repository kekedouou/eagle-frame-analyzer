'use strict';
// Recorder contracts only. No real DOM, Eagle, source videos or evidence writes.
const assert = require('assert');
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { _test: api, run } = require('./support/t1-host.cjs');
const frames = [0, 1, 2].map(id => ({ id, time: id / 10, end: (id + 1) / 10 }));
const frozen = { epoch: 4, libraryEpoch: 2, sourceIdentity: { itemId: '中文', sha256: 'a'.repeat(64) } };
const binding = { sessionEpoch: 4, libraryEpoch: 2, itemId: '中文', sourceSha256: 'a'.repeat(64) };
let count = 0;
function test(name, work) { work(); count++; console.log('ok T1 host recorder: ' + name); }
function player(c, event, override) { c.accept({ type: 'player', value: { binding: override || binding, event } }); }
function request(c, id, time, inputAt = 100, kind = 'rapid', overrides = {}) {
  return c.dispatch(time, kind, () => player(c, { type: 'request', phase: 'input', at: inputAt + .5, inputAt,
    epoch: 1, requestId: id, frameId: Math.floor(time * 10), frameOrdinal: Math.floor(time * 10), targetTime: time, kind, ...overrides }));
}
function drawn(c, id, frameId, inputAt = 100, drawAt = 108) {
  player(c, { type: 'draw', at: drawAt + .5, drawAt, epoch: 1, requestId: id, frameId, inputAt, rafOpportunity: id, commitSource: 'raf' });
}
test('pointer targets use actual frame interval midpoints including final frame and duplicate PTS', () => {
  assert.strictEqual(api.midpoint(frames, 0), .05); assert.strictEqual(api.midpoint(frames, 2), .25);
  assert.strictEqual(api.midpoint([{ time: 0, end: 0 }], 0), 0); assert.throws(() => api.midpoint(frames, 10));
});
test('binding includes session, library, item and source content identity', () => {
  assert(api.bindingMatches(binding, frozen));
  for (const update of [{ sessionEpoch: 3 }, { libraryEpoch: 3 }, { itemId: 'other' }, { sourceSha256: 'b'.repeat(64) }])
    assert.strictEqual(api.bindingMatches({ ...binding, ...update }, frozen), false);
});
test('DOM press request maps UI inputAt to actual draw and terminal without fabricating timer counts', () => {
  const c = api.createCapture(frames, frozen), r = request(c, 1, .05, 100); drawn(c, 1, 0);
  assert.strictEqual(r.terminal.status, 'drawn'); assert(c.settled());
  const s = c.summary(100, 200, 'independent');
  assert.strictEqual(s.requestToDraw.n, 1); assert.strictEqual(s.requestToDraw.p95Ms, 8);
  assert.strictEqual(s.dom.domDispatched, 1); assert.strictEqual(s.terminals.drawn, 1); assert(s.valid);
});
test('reused and superseded inputs get terminals without zero-latency or extra draw samples', () => {
  const c = api.createCapture(frames, frozen); request(c, 1, .05, 100);
  player(c, { type: 'superseded', at: 102, epoch: 1, requestId: 1, status: 'superseded' });
  request(c, 2, .15, 103); player(c, { type: 'reused', at: 109, epoch: 1, requestId: 2, status: 'reused', drawAt: null });
  const s = c.summary(100, 200, 'independent');
  assert.strictEqual(s.terminals.superseded, 1); assert.strictEqual(s.terminals.reused, 1);
  assert.strictEqual(s.requestToDraw.n, 0); assert.strictEqual(s.drawSubmissions, 0); assert(c.settled());
});
test('old player events are ignored while late old request drawing fails latest-target checks', () => {
  const c = api.createCapture(frames, frozen); request(c, 1, .05, 100);
  player(c, { type: 'draw', at: 105, drawAt: 105 }, { ...binding, sessionEpoch: 3 });
  request(c, 2, .15, 101); drawn(c, 1, 0); drawn(c, 2, 1, 101, 110);
  const s = c.summary(100, 200, 'independent');
  assert.strictEqual(s.dom.ignoredOldPlayerEvents, 1); assert.strictEqual(s.staleSubmissions, 1); assert.strictEqual(s.valid, false);
});
test('a draw from an older session is a failure even when current requests finish correctly', () => {
  const c = api.createCapture(frames, frozen); request(c, 1, .05); drawn(c, 1, 0);
  player(c, { type: 'state', at: 109, state: 'disposed' }, { ...binding, sessionEpoch: 3 });
  player(c, { type: 'draw', at: 110, drawAt: 110 }, { ...binding, sessionEpoch: 3 });
  const s = c.summary(100, 200, 'independent');
  assert.strictEqual(s.dom.ignoredOldPlayerEvents, 2); assert.strictEqual(s.dom.oldPlayerDraws, 1); assert.strictEqual(s.valid, false);
});
test('wrong frame identity and out-of-band or ignored DOM requests cannot pass', () => {
  const c = api.createCapture(frames, frozen); request(c, 1, .05, 100, 'rapid', { frameId: 2, frameOrdinal: 2 }); drawn(c, 1, 2);
  const s = c.summary(100, 200, 'independent'); assert(s.frameIdentityMismatches); assert.strictEqual(s.valid, false);
  const other = api.createCapture(frames, frozen);
  assert.throws(() => other.dispatch(.05, 'rapid', () => {}), /未接纳/); assert.strictEqual(other.counts.domRejected, 1);
  player(other, { type: 'request', phase: 'input', requestId: 2 }); assert.strictEqual(other.counts.outOfBandRequests, 1);
});
test('terminal errors, duplicates and unfinished requests remain failures', () => {
  const c = api.createCapture(frames, frozen); request(c, 1, .05, 100);
  player(c, { type: 'error', at: 106, epoch: 1, requestId: 1, status: 'error', error: 'controlled failure' });
  player(c, { type: 'error', at: 107, epoch: 1, requestId: 1, status: 'error', error: 'duplicate' });
  request(c, 2, .15, 110);
  const s = c.summary(100, 200, 'independent'); assert.strictEqual(s.terminals.failed, 1); assert.strictEqual(s.terminals.unfinished, 1);
  assert.strictEqual(s.integrity.duplicateTerminals, 1); assert.strictEqual(s.valid, false); assert.strictEqual(c.settled(), false);
});
test('invalid setup is rejected before any store, DOM or host operation', () => {
  assert.throws(() => run(), /宿主验证需要/);
  assert.throws(() => run({ bridge: { snapshot: () => ({ state: 'preparing' }), subscribe() {} },
    document: {}, window: { PointerEvent() {} }, pluginRoot: 'D:/unused' }), /首帧暂停/);
});
test('unsaved evidence keeps a whole trace ahead of optional context and never exceeds 2MiB', () => {
  const limit = require('./support/t1-evidence.cjs').LIMITS.fileBytes;
  const failure = { stage: 'round', error: Object.assign(new Error('controlled capacity failure'), { code: 'ENOSPC' }) };
  const trace = { data: 'complete-small-trace', rawSha256: 'a'.repeat(64), truncated: false };
  const summary = { complete: true, earlyRegressionPassed: true, interruptedTrace: trace,
    environment: { optional: 'x'.repeat(limit) }, receipts: [] };
  const json = api.unsavedEvidenceJSON(summary, failure), retained = JSON.parse(json);
  assert(Buffer.byteLength(json) <= limit); assert.strictEqual(retained.interruptedTrace.data, trace.data);
  assert.strictEqual(retained.traceRetention.complete, true); assert.strictEqual(retained.persisted, false);
  assert.strictEqual(retained.complete, false); assert.strictEqual(retained.earlyRegressionPassed, false);
  const oversized = api.unsavedEvidenceJSON({ ...summary, interruptedTrace: { ...trace, data: 'x'.repeat(limit) } }, failure);
  const rejectedTrace = JSON.parse(oversized); assert(Buffer.byteLength(oversized) <= limit);
  assert.strictEqual(rejectedTrace.interruptedTrace, null); assert.strictEqual(rejectedTrace.traceRetention.complete, false);
  assert(/not truncated/.test(rejectedTrace.traceRetention.reason)); assert.strictEqual(rejectedTrace.earlyRegressionPassed, false);
});
function lifecycleHarness(settings = {}) {
  const pluginRoot = path.resolve('virtual-plugin'), root = path.join(pluginRoot, 'cache');
  const { OWNER, RECIPE } = require('../plugin/cache.cjs'), sourceSha = 'a'.repeat(64);
  const target = path.join(root, 'media-' + sourceSha + '-' + crypto.createHash('sha256').update(RECIPE).digest('hex').slice(0, 12));
  const files = new Map(), directories = new Set([pluginRoot, root, target]);
  const marker = kind => ({ schema: 1, owner: OWNER, recipe: RECIPE, kind, root });
  files.set(path.join(root, 'owner.json'), Buffer.from(JSON.stringify(marker('root'))));
  files.set(path.join(target, 'owner.json'), Buffer.from(JSON.stringify(marker('cache'))));
  const indexed = frames.map(frame => ({ ...frame, ptsTicks: String(frame.id), timeBase: [1, 10], file: frame.id + '.jpg', bytes: 1, sha256: 'a'.repeat(64) }));
  files.set(path.join(target, 'manifest.json'), Buffer.from(JSON.stringify({ schema: 1, owner: OWNER, recipe: RECIPE, width: 1280, height: 720,
    source: { sha256: sourceSha }, duration: .3, frames: indexed, audio: null })));
  for (const file of ['manifest.json', 'app.js', 'ui.js', 'styles.css', 'index.html', 'diagnostics.cjs', 'session.cjs', 'eagle.cjs', 'media.cjs', 'cache.cjs', 'process-identity.cjs', 'player.js', 'frame-index.cjs']) files.set(path.join(pluginRoot, file), Buffer.from('in-memory source'));
  const fakeFs = { lstatSync(file) {
    const directory = directories.has(file), data = files.get(file); if (!directory && !data) throw new Error('Unexpected fake path');
    return { isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false, nlink: 1, dev: 1, ino: 1, mtimeMs: 1, size: directory ? 0 : data.length };
  }, realpathSync: file => file, readFileSync: file => Buffer.from(files.get(file)) };
  let clock = 0, requestId = 0, pending = null, closed = 0, activePointer = false, requestObserver = null;
  const observers = new Set(), intervals = new Map(), saved = [], saveAttempts = [], store = { started: false, closed: false,
    start(options) { this.started = true; assert.strictEqual(options.reserveBytes, 3 * 1024 ** 2); return { runId: 'memory' }; },
    save(kind, value) {
      assert.strictEqual(kind, 'host'); saveAttempts.push(value.type);
      if (settings.failSave === value.type) throw Object.assign(new Error('controlled persistent save failure'), { code: 'ENOSPC' });
      saved.push(value); if (settings.onSave) settings.onSave(value, saved.length);
      return { file: 'memory-' + saved.length, bytes: 1, sha256: 'memory' };
    },
    close() { this.closed = true; } };
  function eventTarget() {
    const listeners = new Map();
    return { listeners, addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
      removeEventListener(type, callback) { if (listeners.has(type)) listeners.get(type).delete(callback); },
      dispatchEvent(event) { for (const callback of [...(listeners.get(event.type) || [])]) callback(event); return true; } };
  }
  const win = eventTarget(), doc = eventTarget(), timeline = eventTarget(), hint = { textContent: '0:00.000', hidden: false };
  timeline.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 20 });
  doc.visibilityState = 'visible'; doc.hasFocus = () => true; doc.getElementById = id => id === 'timeline' ? timeline : id === 'timeHint' ? hint : null;
  const value = { ...frozen, pluginRoot, state: 'paused', duration: .3, source: { id: '中文', name: 'memory' },
    loadMetrics: { entryAt: 0, readyAt: 1, totalMs: settings.loadMs || 1, reused: !!settings.reused, trigger: 'plugin-create' },
    playback: { frameId: 0, frameOrdinal: 0, time: 0, activeImageTasks: 0, pendingTargets: 0, cacheBytes: 1 } };
  const emit = event => { for (const observer of observers) observer({ type: 'player', value: { binding, event } }); };
  const setTimer = (callback, ms) => setImmediate(() => { clock += ms; for (const cb of intervals.values()) cb(); callback(); });
  Object.assign(win, { performance: { now: () => clock }, setTimeout: setTimer, setInterval: callback => { const id = intervals.size + 1; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id), PointerEvent: class { constructor(type, args) { Object.assign(this, { type }, args); } }, close: () => { closed++; },
    innerWidth: 1120, innerHeight: 760, devicePixelRatio: 1 });
  function pointer(event) {
    if (event.type === 'pointerdown') activePointer = true;
    if (!activePointer) return;
    if (pending) emit({ type: 'superseded', at: clock, epoch: 1, requestId: pending.id, status: 'superseded' });
    const time = (event.clientX - 10) / 100 * .3;
    const ordinal = require('../plugin/frame-index.cjs').frameAt(indexed, time), id = ++requestId;
    pending = { id, ordinal, time }; value.state = 'seeking'; value.playback.pendingTargets = 1;
    emit({ type: 'request', phase: 'input', at: clock, inputAt: clock, epoch: 1, requestId: id, frameId: ordinal, frameOrdinal: ordinal, targetTime: time,
      kind: event.type === 'pointerup' ? 'release' : 'rapid' });
    if (requestObserver) requestObserver();
    setTimer(() => {
      if (!pending || pending.id !== id) return;
      const reused = value.playback.frameId === ordinal;
      value.playback = { ...value.playback, frameId: ordinal, frameOrdinal: ordinal, time: indexed[ordinal].time, pendingTargets: 0 };
      value.state = 'paused'; pending = null; hint.textContent = require('../plugin/ui.js').formatTime(indexed[ordinal].time);
      if (reused) emit({ type: 'reused', at: clock, epoch: 1, requestId: id, status: 'reused', drawAt: null });
      else emit({ type: 'draw', at: clock, drawAt: clock, inputAt: clock - 1, epoch: 1, requestId: id, frameId: ordinal, rafOpportunity: id, commitSource: 'raf' });
    }, 1);
    if (event.type === 'pointerup') activePointer = false;
  }
  timeline.addEventListener('pointerdown', pointer); win.addEventListener('pointermove', pointer); win.addEventListener('pointerup', pointer);
  const bridge = { snapshot: () => JSON.parse(JSON.stringify(value)), subscribe(callback) {
    if (settings.rejectSubscribe) throw new Error('controlled subscribe failure'); observers.add(callback); return () => observers.delete(callback);
  } };
  const module = { exports: {} }, code = fs.readFileSync(path.join(__dirname, 'support/t1-host.cjs'), 'utf8');
  const originalProtocol = require('./support/t0-protocol.cjs');
  vm.runInNewContext(code, { module, Buffer, console, process: { ...process, memoryUsage: () => ({ rss: settings.rss || 1, external: 0, arrayBuffers: 0 }) },
    require(name) {
      if (name === 'fs') return fakeFs;
      if (name === './t1-evidence.cjs') return { createStore: () => store, LIMITS: require('./support/t1-evidence.cjs').LIMITS };
      if (name === './t0-protocol.cjs') return { ...originalProtocol, PROTOCOL: { ...originalProtocol.PROTOCOL, roundMs: 30, randomTargets: 2 } };
      return require(require('module').createRequire(path.join(__dirname, 'support/t1-host.cjs')).resolve(name));
    } }, { filename: 't1-host-memory-lifecycle' });
  return { driver: module.exports, options: { bridge, document: doc, window: win, pluginRoot }, store, saved, saveAttempts, observers, intervals,
    win, value, activePointer: () => activePointer, closed: () => closed, onRequest: callback => { requestObserver = callback; } };
}
async function lifecycle() {
  const h = lifecycleHarness(), result = await h.driver.run(h.options).done;
  assert.strictEqual(result.complete, true); assert.strictEqual(h.saved.length, 7); assert.strictEqual(h.saved[6].rounds.length, 6);
  assert(h.store.closed); assert.strictEqual(h.observers.size, 0); assert.strictEqual(h.intervals.size, 0); assert.strictEqual(h.activePointer(), false);
  count++; console.log('ok T1 host lifecycle: six bounded rounds save and release observers/timer/gesture in memory');
  const reuse = lifecycleHarness({ reused: true, loadMs: 10000 });
  reuse.options.launchContext = { kind: 'real-Eagle-formal-code-independent-entry', mappedFormalRoot: reuse.options.pluginRoot };
  reuse.options.verifyLaunch = () => {};
  const reused = await reuse.driver.run(reuse.options).done;
  assert.strictEqual(reused.p03.withinTarget, null); assert.strictEqual(reused.p03.totalMs, 10000);
  for (const receipt of reuse.saved) { assert.strictEqual(receipt.origin, 'automatic-real-Eagle-independent-entry-formal-code');
    assert.strictEqual(receipt.launchContext.mappedFormalRoot, reuse.options.pluginRoot); }
  count++; console.log('ok T1 host lifecycle: independent-entry provenance is retained and reuse never fabricates a first-load gate');
  const changedEntry = lifecycleHarness();
  changedEntry.options.launchContext = { kind: 'real-Eagle-formal-code-independent-entry', mappedFormalRoot: changedEntry.options.pluginRoot };
  changedEntry.options.verifyLaunch = () => { throw new Error('controlled entry change'); };
  const changed = await changedEntry.driver.run(changedEntry.options).done;
  assert.strictEqual(changed.complete, false); assert.strictEqual(changed.error.code, 'HOST_ENTRY_CHANGED');
  assert.strictEqual(changedEntry.saved[6].launchSourcesVerifiedAtEnd, false);
  count++; console.log('ok T1 host lifecycle: changed entry sources cannot retain a passing saved summary');
  let lastTask;
  const lastSave = lifecycleHarness({ onSave(value, length) { if (value.type === 'round' && length === 6) lastTask.cancel(); } });
  lastTask = lastSave.driver.run(lastSave.options); const lateCancelled = await lastTask.done;
  assert.strictEqual(lateCancelled.complete, false); assert.strictEqual(lateCancelled.error.code, 'HOST_USER_CANCELLED');
  assert.strictEqual(lastSave.saved[6].complete, false); assert(lastSave.store.closed);
  count++; console.log('ok T1 host lifecycle: cancellation during the final round save remains a failed summary');
  const subscription = lifecycleHarness({ rejectSubscribe: true }); assert.throws(() => subscription.driver.run(subscription.options), /subscribe failure/);
  assert(subscription.store.closed); count++; console.log('ok T1 host lifecycle: setup failure releases evidence lock');
  const resource = lifecycleHarness({ rss: 1.5 * 1024 ** 3 }); const stopped = await resource.driver.run(resource.options).done;
  assert.strictEqual(stopped.complete, false); assert.strictEqual(stopped.error.code, 'HOST_RSS_STOP');
  assert(resource.store.closed); assert.strictEqual(resource.closed(), 1); assert.strictEqual(resource.observers.size, 0);
  count++; console.log('ok T1 host lifecycle: resource stop preserves failure before requesting current-window close');
  const cancelled = lifecycleHarness(), task = cancelled.driver.run(cancelled.options);
  cancelled.onRequest(() => task.cancel()); const cancellation = await task.done;
  assert.strictEqual(cancellation.complete, false); assert.strictEqual(cancellation.error.code, 'HOST_USER_CANCELLED');
  assert(cancelled.store.closed); assert.strictEqual(cancelled.activePointer(), false); assert.strictEqual(cancelled.observers.size, 0);
  assert.strictEqual(cancelled.saved[0].cleanup.remainingTargets, 0);
  count++; console.log('ok T1 host lifecycle: mid-gesture cancellation terminates synthetic gesture and finitely waits before saving failure');
  for (const stage of ['round', 'summary']) {
    const broken = lifecycleHarness({ failSave: stage }), unfinished = broken.driver.run(broken.options);
    assert.strictEqual(unfinished.unsavedEvidence(), null);
    await assert.rejects(unfinished.done, /证据未保存/);
    const json = unfinished.unsavedEvidence(), retained = JSON.parse(json);
    assert(Buffer.byteLength(json) <= 2 * 1024 ** 2); assert.strictEqual(retained.persisted, false);
    assert.strictEqual(retained.complete, false); assert.strictEqual(retained.earlyRegressionPassed, false);
    assert.strictEqual(retained.persistenceError.stage, stage); assert.strictEqual(retained.persistenceError.code, 'ENOSPC');
    if (stage === 'round') {
      assert.strictEqual(broken.saveAttempts.length, 1); assert.strictEqual(broken.saved.length, 0);
      assert(retained.interruptedTrace.data); assert.strictEqual(retained.traceRetention.complete, true);
    } else {
      assert.strictEqual(broken.saveAttempts.length, 7); assert.strictEqual(broken.saved.length, 6);
      assert.strictEqual(retained.receipts.length, 6); assert.strictEqual(retained.traceRetention.location, 'saved-round-receipts');
    }
    retained.complete = true; assert.strictEqual(JSON.parse(unfinished.unsavedEvidence()).complete, false);
    assert(broken.store.closed); assert.strictEqual(broken.observers.size, 0); assert.strictEqual(broken.intervals.size, 0); assert.strictEqual(broken.activePointer(), false);
    count++; console.log('ok T1 host lifecycle: ' + stage + ' save failure rejects without retry, releases resources and retains bounded evidence');
  }
  const stoppedSave = lifecycleHarness({ rss: 1.5 * 1024 ** 3, failSave: 'summary' });
  const stoppedTask = stoppedSave.driver.run(stoppedSave.options); await assert.rejects(stoppedTask.done, /证据未保存/);
  assert.strictEqual(JSON.parse(stoppedTask.unsavedEvidence()).resourceStop.requested, true);
  assert(stoppedSave.store.closed); assert.strictEqual(stoppedSave.closed(), 1); assert.strictEqual(stoppedSave.observers.size, 0);
  count++; console.log('ok T1 host lifecycle: resource stop still releases lock and requests window close when saving fails');
  const cancelledSave = lifecycleHarness({ failSave: 'summary' }), cancelledTask = cancelledSave.driver.run(cancelledSave.options);
  cancelledSave.onRequest(() => cancelledTask.cancel()); await assert.rejects(cancelledTask.done, /证据未保存/);
  const cancelledEvidence = JSON.parse(cancelledTask.unsavedEvidence());
  assert.strictEqual(cancelledEvidence.error.code, 'HOST_USER_CANCELLED'); assert(cancelledEvidence.interruptedTrace.data);
  assert.strictEqual(cancelledEvidence.cleanup.remainingTargets, 0); assert(cancelledSave.store.closed);
  assert.strictEqual(cancelledSave.activePointer(), false); assert.strictEqual(cancelledSave.observers.size, 0); assert.strictEqual(cancelledSave.intervals.size, 0);
  count++; console.log('ok T1 host lifecycle: cancelled gesture and failed evidence save retain complete trace after finite cleanup');
  console.log('T1 host recorder: ' + count + ' pure checks passed; no Eagle, media or evidence writes.');
}
lifecycle().catch(error => { console.error(error.stack); process.exitCode = 1; });
