'use strict';
const assert = require('assert'), vm = require('vm'), fs = require('fs'), path = require('path');
const host = path.resolve(__dirname, 'host/t0');
const code = fs.readFileSync(path.join(host, 'app.js'), 'utf8');
const selection = require('./support/t0-selection.cjs');
const item = (id = 'audio-test') => ({ id, name: '中文 有声 ' + id, filePath: path.resolve('中文 空格 ' + id + '.mp4'), ext: 'mp4' });
const flush = async () => { for (let n = 0; n < 6; n++) await new Promise(resolve => setImmediate(resolve)); };
async function until(predicate, message) {
  for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setImmediate(resolve));
  assert(predicate(), message);
}

// All media/Player/host doubles are in memory. The real selection adapter is
// used; this never starts Eagle, reads a video or writes cache/evidence files.
function harness(options = {}) {
  const elements = new Map(), saved = [], prepared = [], cleaned = [], released = [], inputKinds = [], inputTimes = [], windowHandlers = {};
  const infos = new Set(), liveInfos = new Set(), sources = [{ key: 'baseline', label: 'old fixed source' },
    { key: 'selected', label: 'selected' }, { key: 'h264-cfr', label: 'numbered test' }];
  const state = { response: options.response === undefined ? [item()] : options.response, apiError: null, apiCalls: 0,
    holdSources: !!options.holdSources, finishSources: null, holdSelection: false, finishSelection: null,
    holdDispose: false, finishDispose: null, forceDisposeTimeout: false, prepareError: null, playerLoadError: null,
    holdPrepare: false, finishPrepare: null, prepareActive: 0, peakPrepareActive: 0,
    failCleanup: false, memoryRss: 10, constructed: 0, disposed: 0, peakLiveInfos: 0, remainingBytes: 60 * 1024 ** 2,
    quantizeSeek: false, timelineRect: { left: 100, width: 200 }, captured: null, captureFailure: false,
    modes: [], changeFingerprintAt: null };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: id === 'refresh' ? '60' : '未检查', handlers: {}, children: [], disabled: true,
      addEventListener(name, callback) { this.handlers[name] = callback; }, append(child) { this.children.push(child); }, textContent: '',
      getBoundingClientRect() { return state.timelineRect; }, focus() {},
      setPointerCapture(id) { if (state.captureFailure) throw new Error('mock capture loss'); state.captured = id; },
      hasPointerCapture(id) { return state.captured === id; }, releasePointerCapture(id) { if (state.captured === id) state.captured = null; } });
    return elements.get(id);
  };
  let initializer, reinvoke, exit, sampleTimer, tick = 1;
  const backend = { HOST_ROOT: host, CACHE_ROOT: path.join(host, 'cache'),
    async listSources() { if (state.holdSources) await new Promise(resolve => { state.finishSources = resolve; }); return sources; },
    async prepare(key, value) {
      prepared.push({ key, selected: value.selected, signal: value.signal, reuseOnly: value.reuseOnly });
      const prepareError = state.prepareError;
      state.prepareActive++; state.peakPrepareActive = Math.max(state.peakPrepareActive, state.prepareActive);
      try {
        if (state.holdPrepare) await new Promise(resolve => { state.finishPrepare = resolve; });
        if (prepareError) throw prepareError;
        if (value.signal.aborted) { const error = new Error('mock preparation aborted'); error.name = 'AbortError'; throw error; }
        const source = key === 'selected' ? { key, ...value.selected, label: value.selected.name, sha256: 'mock-' + value.selected.id } : { key, label: key, sha256: 'mock-' + key };
        if (state.changeFingerprintAt === prepared.length) source.sha256 += '-changed';
        const info = { source, metrics: { reused: true }, duration: 1, audio: null, width: 1280, height: 720,
          frames: [{ id: 10, time: 0, end: .5 }, { id: 20, time: .5, end: 1 }], expected: null };
        infos.add(info); liveInfos.add(info); state.peakLiveInfos = Math.max(state.peakLiveInfos, liveInfos.size); return info;
      } finally { state.prepareActive--; }
    },
    evidenceInfo: () => ({ remainingBytes: state.remainingBytes }),
    async release(info) { assert(infos.has(info), 'release must receive original cache handle'); liveInfos.delete(info); released.push(info); },
    async cleanup(info) {
      cleaned.push(info);
      if (state.failCleanup) throw new Error('Unknown file blocks cleanup');
      assert(infos.has(info), 'selected fresh preparation must clean by original info handle, not key/copy');
      assert(!liveInfos.has(info), 'active cache lease must not be cleaned');
    },
    async saveEvidence(kind, value) { saved.push({ kind, value }); return 'mock-evidence-only'; }
  };
  class Player {
    constructor(value) { this.options = value; this.state = 'empty'; this.time = 0; this.frameId = 10; this.request = 0; state.constructed++; state.modes.push(value.experimentMode); }
    setVerifyMarkers() {}
    setDecodeDelay(value) { this.decodeDelayMs = value; }
    async load() { if (state.playerLoadError) { this.state = 'error'; throw state.playerLoadError; } this.state = 'paused'; }
    snapshot() { return { state: this.state, time: this.time, frameId: this.frameId, activeImageTasks: 0, pendingTargets: 0, cacheBytes: 0, experimentMode: this.options.experimentMode }; }
    async seek(time, value) {
      this.request++; inputKinds.push(value.kind); inputTimes.push(time);
      this.time = state.quantizeSeek ? (time < .5 ? 0 : .5) : time; this.frameId = time < .5 ? 10 : 20;
      this.options.emit({ type: 'request', epoch: 1, requestId: this.request, phase: 'input', frameId: this.frameId, inputAt: value.inputAt, at: tick++ });
      this.options.emit({ type: 'draw', epoch: 1, requestId: this.request, frameId: this.frameId, inputAt: value.inputAt, at: tick++ });
      return { status: 'drawn', requestId: this.request };
    }
    async dispose() { state.disposed++; if (state.holdDispose) await new Promise(resolve => { state.finishDispose = resolve; }); }
    pause() { this.state = 'paused'; }
    async play() { this.state = 'playing'; }
    async step() {}
  }
  const fakeFs = { realpathSync: fs.realpathSync, readFileSync: () => Buffer.from('mock-code-fingerprint') };
  const eagle = { item: { getSelected() {
    state.apiCalls++; if (state.apiError) throw state.apiError;
    const response = state.response;
    if (state.holdSelection) return new Promise(resolve => { state.finishSelection = () => resolve(response); });
    return response;
  } }, onPluginCreate(callback) { initializer = callback; }, onPluginRun(callback) { reinvoke = callback; }, onPluginBeforeExit(callback) { exit = callback; } };
  const context = { document: { getElementById: element, createElement: () => ({}), activeElement: null },
    window: { EVAPlayer: { Player }, addEventListener(name, callback) { windowHandlers[name] = callback; } }, performance: { now: () => tick++ },
    setTimeout: (callback, ms) => setTimeout(callback, state.forceDisposeTimeout && ms === 10000 ? 1 : ms), clearTimeout,
    setInterval: callback => { sampleTimer = callback; return 1; }, AbortController, Buffer, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    process: { versions: { node: '16.17.1', chrome: '108' }, platform: 'win32', pid: 123, memoryUsage: () => ({ rss: state.memoryRss }) },
    eagle, require(name) {
      if (name.endsWith('t0-media.cjs')) return backend;
      if (name.endsWith('t0-selection.cjs')) return selection;
      if (name.endsWith('t0-manual-trace.cjs')) return require('./support/t0-manual-trace.cjs');
      if (name.endsWith('t0-gate.cjs')) return require('./support/t0-gate.cjs');
      if (name.endsWith('t0-comparison.cjs')) {
        const comparison = require('./support/t0-comparison.cjs');
        return options.shortComparison ? { ...comparison, PROTOCOL: { ...comparison.PROTOCOL, roundMs: 24 } } : comparison;
      }
      if (name.endsWith('t0-protocol.cjs')) {
        const protocol = require('./support/t0-protocol.cjs');
        // Only shorten the mocked host's wait; these statistics never represent
        // real performance or change the production measurement protocol.
        return options.shortProtocol ? { ...protocol, PROTOCOL: { ...protocol.PROTOCOL, roundMs: 24 } } : protocol;
      }
      if (name.endsWith('frame-index.cjs')) return require('../plugin/frame-index.cjs');
      if (name === 'fs') return fakeFs;
      return require(name);
    }
  };
  vm.runInNewContext(code, context, { filename: 't0-app.js' });
  return { state, element, saved, prepared, cleaned, released, liveInfos, inputKinds, inputTimes, windowHandlers,
    initialize: () => initializer({ path: host }), run: value => reinvoke(value), close: () => exit ? exit() : windowHandlers.pagehide(),
    sample: () => sampleTimer(), click: id => element(id).handlers.click(), change: () => element('sample').handlers.change() };
}

async function playbackAndLeaseRegression() {
  const h = harness(); await h.initialize();
  assert.strictEqual(h.prepared.length, 1); assert.strictEqual(h.prepared[0].key, 'selected');
  assert.strictEqual(h.prepared[0].selected.id, 'audio-test'); assert(Object.isFrozen(h.prepared[0].selected));
  assert(!h.element('sample').children.some(option => option.value === 'baseline'), 'historical baseline must not appear in host UI');
  assert.strictEqual(h.element('timeline').disabled, false); assert.strictEqual(h.saved[0].kind, 'host-initial-ready');
  h.element('timeline').value = '.5'; await h.element('timeline').handlers.input(); await h.click('save');
  const evidence = h.saved[h.saved.length - 1].value, input = evidence.events.find(e => e.type === 'input');
  const terminal = evidence.events.find(e => e.type === 'input-end'), draw = evidence.events.find(e => e.type === 'draw');
  assert.strictEqual(input.inputId, terminal.inputId); assert.strictEqual(input.inputId, draw.inputId); assert.strictEqual(draw.stale, false);
  assert.strictEqual(evidence.manual.executor, 'user-entered-observation'); assert.strictEqual(evidence.manual.drag, '未检查');
  h.element('timeline').handlers.pointerdown({ pointerId: 4 }); h.element('timeline').value = '.9'; h.sample();
  assert.strictEqual(h.element('timeline').value, '.9', 'polling overwrote active pointer drag');
  const beforeRelease = h.inputKinds.filter(kind => kind === 'release').length;
  await h.windowHandlers.pointerup({ pointerId: 4 }); await h.element('timeline').handlers.change();
  assert.strictEqual(h.inputTimes[h.inputTimes.length - 1], .9);
  assert.strictEqual(h.inputKinds.filter(kind => kind === 'release').length, beforeRelease + 1);
  h.element('timeline').handlers.pointerdown({ pointerId: 5 }); h.element('timeline').value = '.7'; await h.element('timeline').handlers.input();
  await h.windowHandlers.pointerup({ pointerId: 99 }); h.element('timeline').value = '.8'; h.sample();
  assert.strictEqual(h.element('timeline').value, '.8'); await h.element('timeline').handlers.pointercancel({ pointerId: 5 });
  assert.strictEqual(h.inputTimes[h.inputTimes.length - 1], .7);
  h.element('timeline').value = '.4'; await h.element('timeline').handlers.input(); await h.element('timeline').handlers.change();
  assert.strictEqual(h.inputTimes[h.inputTimes.length - 1], .4);
  await h.click('reload'); const releases = h.released.length, constructed = h.state.constructed;
  h.state.holdDispose = true; h.state.forceDisposeTimeout = true;
  await h.click('reload'); await h.click('reload');
  assert.strictEqual(h.released.length, releases, 'timeout cannot release a real live lease');
  assert.strictEqual(h.state.constructed, constructed, 'timeout cannot create replacement Player');
  h.state.holdDispose = false; h.state.forceDisposeTimeout = false; h.state.finishDispose(); await flush();
  assert.strictEqual(h.released.length, releases + 1); await h.click('reload');
  h.state.holdDispose = true; h.state.finishDispose = null;
  const beforeCancel = h.prepared.length, loading = h.click('reload');
  await until(() => !!h.state.finishDispose, 'reload did not await real disposal'); h.click('cancel');
  h.state.holdDispose = false; h.state.finishDispose(); await loading;
  assert.strictEqual(h.prepared.length, beforeCancel, 'cancel during disposal must prevent new preparation');
  await h.click('reload'); assert.strictEqual(h.state.peakLiveInfos, 1);
  h.state.memoryRss = 1.5 * 1024 ** 3; h.sample(); h.sample(); await flush();
  assert.strictEqual(h.saved.filter(record => record.kind === 'host-resource-stop').length, 1);
}

async function selectionAndFailureRegression() {
  const h = harness(); await h.initialize();
  h.state.response = [item('second-video')]; await h.click('reload');
  assert.strictEqual(h.prepared[h.prepared.length - 1].selected.id, 'audio-test', 'reload must retain current snapshot');
  h.element('manualSync').value = '相符'; await h.run({ path: 'C:\\untrusted-run-argument' });
  assert.strictEqual(h.prepared[h.prepared.length - 1].selected.id, 'second-video'); assert.strictEqual(h.element('manualSync').value, '未检查');
  const beforeFailure = h.prepared.length, priorDisposed = h.state.disposed;
  h.state.response = []; await h.click('selected');
  assert.strictEqual(h.prepared.length, beforeFailure); assert.strictEqual(h.state.disposed, priorDisposed);
  assert.strictEqual(h.element('timeline').disabled, false, 'selection API failure must retain usable current player');
  const failed = h.saved[h.saved.length - 1]; assert.strictEqual(failed.kind, 'host-selection-failed');
  assert.strictEqual(failed.value.source, null); assert.strictEqual(failed.value.selectionAttempt.stage, 'selection-api');
  assert.strictEqual(failed.value.selectionAttempt.attempted, null); assert.strictEqual(failed.value.selectionAttempt.retainedSource.itemId, 'second-video');
  assert.strictEqual(failed.value.events.length, 0, 'old playback trace cannot diagnose a failed different selection');
  assert(failed.value.selectionAttempt.diagnostics.length > 0, 'real adapter must emit selection diagnostics');
  assert.strictEqual(failed.value.selectionAttempt.error.code, 'SELECTION_EMPTY');
  h.state.response = [item('media-failure')]; h.state.prepareError = new Error('mock ffprobe failure');
  await h.click('selected'); const mediaFailure = h.saved[h.saved.length - 1].value;
  assert.strictEqual(mediaFailure.selectionAttempt.stage, 'media-prepare');
  assert.strictEqual(mediaFailure.source.id, 'media-failure'); assert.strictEqual(mediaFailure.selectionAttempt.attempted.id, 'media-failure');
  assert.strictEqual(mediaFailure.selectionAttempt.retainedSource, null); assert.strictEqual(h.element('timeline').disabled, true);
  h.state.prepareError = null; await h.click('reload'); assert.strictEqual(h.prepared[h.prepared.length - 1].selected.id, 'media-failure');
  h.state.response = [item('player-failure')]; h.state.playerLoadError = new Error('mock AudioContext failure');
  await h.click('selected'); assert.strictEqual(h.saved[h.saved.length - 1].value.selectionAttempt.stage, 'player-initialize');
  assert.strictEqual(h.liveInfos.size, 0, 'failed Player initialization must release its own prepared lease');
  h.state.playerLoadError = null; h.state.response = [item('after-player-failure')]; await h.click('reload');
  assert.strictEqual(h.prepared[h.prepared.length - 1].selected.id, 'after-player-failure', 'empty reload must recapture instead of using previously successful video');
  assert.strictEqual(h.element('timeline').disabled, false);
  await h.close(); await flush(); assert.strictEqual(h.liveInfos.size, 0);
}

async function pointerOwnershipRegression() {
  const h = harness(); await h.initialize(); h.state.quantizeSeek = true;
  const range = h.element('timeline');
  range.handlers.pointerdown({ pointerId: 7 }); range.value = '.7'; await range.handlers.input();
  await range.handlers.lostpointercapture({ pointerId: 7 });
  range.value = '.8'; await range.handlers.input(); h.sample();
  assert.strictEqual(Number(range.value), .8, 'loss of capture must not let frame-quantized polling push the active thumb backwards');
  await h.windowHandlers.pointerup({ pointerId: 7 }); h.sample();
  assert.strictEqual(Number(range.value), .8, 'paused polling must preserve the requested thumb value after release');
  let prevented = 0;
  await range.handlers.pointerdown({ pointerId: 8, button: 0, clientX: 108, preventDefault() { prevented++; } });
  assert.strictEqual(h.state.captured, 8); assert.strictEqual(Number(range.value), 0);
  await h.windowHandlers.pointermove({ pointerId: 99, buttons: 1, clientX: 292 });
  assert.strictEqual(Number(range.value), 0, 'another pointer cannot own this drag');
  await h.windowHandlers.pointermove({ pointerId: 8, buttons: 1, clientX: 269 }); h.sample();
  assert.strictEqual(Number(range.value), .875); assert.strictEqual(h.inputTimes[h.inputTimes.length - 1], .875);
  await range.handlers.lostpointercapture({ pointerId: 8 }); h.state.captured = null;
  await h.windowHandlers.pointermove({ pointerId: 8, buttons: 1, clientX: 400 });
  assert.strictEqual(Number(range.value), 1, 'window fallback must continue outside the track after capture loss');
  const releases = h.inputKinds.filter(kind => kind === 'release').length;
  await h.windowHandlers.pointerup({ pointerId: 8, clientX: 108 }); await range.handlers.change();
  assert.strictEqual(h.inputKinds.filter(kind => kind === 'release').length, releases + 1);
  assert.strictEqual(h.inputTimes[h.inputTimes.length - 1], 0, 'release must honor a newer final up coordinate');
  h.state.captureFailure = true;
  await range.handlers.pointerdown({ pointerId: 9, button: 0, clientX: 108, preventDefault() { prevented++; } });
  await h.windowHandlers.pointermove({ pointerId: 9, buttons: 1, clientX: 200 });
  assert.strictEqual(Number(range.value), .5); await h.windowHandlers.blur();
  h.sample(); assert.strictEqual(Number(range.value), .5); assert.strictEqual(prevented, 2);
  range.value = '.4'; await range.handlers.input(); await range.handlers.change(); h.sample();
  assert.strictEqual(Number(range.value), .4, 'keyboard/native input must not be overwritten by source-frame quantization');
  await range.handlers.pointerdown({ pointerId: 10, button: 0, clientX: 200, preventDefault() {} });
  await h.windowHandlers.pointermove({ pointerId: 10, buttons: 2, clientX: 292 });
  const final = h.inputTimes[h.inputTimes.length - 1]; assert.strictEqual(final, 1);
  await h.windowHandlers.pointermove({ pointerId: 10, buttons: 1, clientX: 108 });
  assert.strictEqual(h.inputTimes[h.inputTimes.length - 1], final, 'released primary button must end dragging even when another button remains down');
  await h.click('save'); const diagnostics = h.saved[h.saved.length - 1].value.events.filter(event => event.type === 'ui');
  assert(diagnostics.some(event => event.phase === 'lostpointercapture'));
  assert(diagnostics.some(event => event.phase === 'capture-failed'));
  await h.close(); await flush();
}

async function manualTailAndQuotaRegression() {
  const h = harness(); await h.initialize();
  for (let n = 0; n < 1200; n++) {
    h.element('timeline').value = String(n % 2 ? .25 : .75); await h.element('timeline').handlers.input();
  }
  for (let n = 0; n < 250; n++) h.sample();
  await h.click('save');
  const record = h.saved[h.saved.length - 1].value;
  assert.strictEqual(record.trace.encoding, 'manual-tail-v3'); assert(record.truncated);
  assert.strictEqual(record.trace.lifetimeEventCounts.input, 1200);
  assert.strictEqual(record.events[record.events.length - 1].inputId, 1200, 'overflow must retain the latest terminal instead of an old prefix');
  assert.strictEqual(record.memorySamples.length, 200); assert(record.trace.coverage.partialChainsPossible);
  assert(Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8') + 4096 < 2 * 1024 ** 2);
  const before = h.saved.length, original = JSON.stringify(record); h.state.remainingBytes = 0;
  await h.click('save'); assert.strictEqual(h.saved.length, before, 'quota failure must not write, replace or clear evidence');
  assert(h.element('error').textContent.includes('配额不足')); assert.strictEqual(JSON.stringify(record), original);
  await h.close(); await flush();
}

async function emptyAndMalformedRegression() {
  for (const response of [[], { id: 'not-an-array' }]) {
    const h = harness({ response }); await h.initialize();
    assert.strictEqual(h.prepared.length, 0, 'invalid startup selection cannot silently prepare fixed baseline');
    assert.strictEqual(h.element('timeline').disabled, true); assert.strictEqual(h.element('reload').disabled, false);
    const failed = h.saved.find(record => record.kind === 'host-selection-failed');
    assert(failed); assert.strictEqual(failed.value.source, null); assert.strictEqual(failed.value.selectionAttempt.retainedSource, null);
    h.state.response = [item('recovered')]; await h.click('reload');
    assert.strictEqual(h.prepared[0].selected.id, 'recovered'); await h.close(); await flush();
  }
  const h = harness(); h.state.apiError = new Error('mock getSelected API rejection'); await h.initialize();
  assert.strictEqual(h.prepared.length, 0); assert(h.saved[0].value.selectionAttempt.error.message.includes('API rejection'));
  h.state.apiError = null; await h.click('selected'); assert.strictEqual(h.prepared[0].key, 'selected'); await h.close();
}

async function initializationAndCancellationRegression() {
  const h = harness({ holdSources: true }), initializing = h.initialize();
  await until(() => !!h.state.finishSources, 'initialization did not reach source listing');
  h.state.response = [item('during-init-b')]; const first = h.run();
  const firstReadCount = h.state.apiCalls; assert.strictEqual(firstReadCount, 1, 'run must capture before dependencies finish');
  h.state.response = [item('during-init-c')]; const second = h.run({ ignored: true });
  assert.strictEqual(h.state.apiCalls, firstReadCount + 1); assert.strictEqual(h.prepared.length, 0);
  h.state.holdSources = false; h.state.finishSources(); await initializing; await first; await second; await flush();
  assert.strictEqual(h.prepared.length, 1); assert.strictEqual(h.prepared[0].selected.id, 'during-init-c');
  assert.strictEqual(h.state.peakLiveInfos, 1); await h.close();
  const stopped = harness({ holdSources: true }), pending = stopped.initialize();
  await until(() => !!stopped.state.finishSources, 'cancel scenario did not reach initialization');
  assert.strictEqual(stopped.element('cancel').disabled, false, 'dependency initialization must expose stop control');
  stopped.click('cancel'); stopped.state.finishSources(); await pending; await flush();
  assert.strictEqual(stopped.prepared.length, 0, 'initialization completion cannot undo explicit stop');
  const late = harness(); await late.initialize(); late.state.response = [item('late')]; late.state.holdSelection = true;
  const lateSelection = late.click('selected'); assert.strictEqual(typeof late.state.finishSelection, 'function');
  const beforeCancel = late.prepared.length; late.click('cancel'); late.state.holdSelection = false; late.state.finishSelection(); await lateSelection;
  assert.strictEqual(late.prepared.length, beforeCancel, 'cancelled API result cannot load later');
  await late.click('reload'); late.state.holdSelection = true; const beforeClose = late.prepared.length, closedSelection = late.run();
  await late.close(); late.state.holdSelection = false; late.state.finishSelection(); await closedSelection; await flush();
  assert.strictEqual(late.prepared.length, beforeClose, 'closed window cannot prepare late API result'); assert.strictEqual(late.liveInfos.size, 0);
}

async function interruptedPreparationRegression() {
  const h = harness(); await h.initialize();
  h.state.holdPrepare = true; h.state.prepareError = new Error('late old media failure');
  const oldReload = h.click('reload'); await until(() => !!h.state.finishPrepare, 'old reload did not enter media prepare');
  const oldCallCount = h.prepared.length, oldApiCalls = h.state.apiCalls;
  h.state.response = [item('new-after-old-failure')]; const switchToNew = h.run();
  assert.strictEqual(h.state.apiCalls, oldApiCalls + 1, 'new invocation must capture immediately while old media runs');
  await flush(); assert.strictEqual(h.prepared.length, oldCallCount, 'new preparation cannot overlap old process completion');
  h.state.holdPrepare = false; h.state.prepareError = null; h.state.finishPrepare();
  await oldReload; await switchToNew; await flush();
  assert.strictEqual(h.state.peakPrepareActive, 1); assert.strictEqual(h.state.peakLiveInfos, 1);
  assert.strictEqual(h.prepared[h.prepared.length - 1].selected.id, 'new-after-old-failure');
  assert.strictEqual(h.element('timeline').disabled, false, 'late old failure cannot dispose successful new Player');
  assert.strictEqual(h.element('error').textContent, ''); await h.close(); await flush();
}

async function currentVideoProtocolRegression() {
  const h = harness(); await h.initialize(); h.state.response = [item('not-part-of-current-test')];
  const start = h.prepared.length; await h.click('preparation');
  assert.strictEqual(h.cleaned.length, 3); assert.strictEqual(h.prepared.length - start, 6);
  assert(h.prepared.slice(start).every(value => value.key === 'selected' && value.selected.id === 'audio-test'), 'three rounds must keep original selected identity');
  assert.strictEqual(h.state.apiCalls, 1, 'protocol must not reread changing Eagle selection');
  h.state.failCleanup = true; await h.click('preparation');
  assert(h.saved.some(record => record.kind === 'host-failed')); assert.strictEqual(h.element('reload').disabled, false);
  h.state.failCleanup = false; await h.click('reload');
  h.element('timeline').value = '.75'; await h.element('timeline').handlers.input();
  const beforePreflight = h.prepared.length, beforeSaved = h.saved.length, beforeDisposed = h.state.disposed; await h.click('performance');
  assert.strictEqual(h.prepared.length, beforePreflight, 'evidence preflight must reject before any media work');
  assert.strictEqual(h.state.disposed, beforeDisposed, 'preflight refusal must retain current Player');
  assert.strictEqual(h.saved.length, beforeSaved, 'preflight refusal must not consume quota for an empty failed run');
  assert.strictEqual(h.element('timeline').disabled, false); await h.click('save');
  assert(h.saved[h.saved.length - 1].value.events.some(event => event.type === 'input' && event.targetTime === .75),
    'preflight refusal must preserve the unsaved manual tail');
  assert(!h.prepared.some(value => value.key === 'baseline')); await h.close(); await flush();
}

async function currentVideoPerformanceWiringRegression() {
  const h = harness({ shortProtocol: true }); await h.initialize();
  h.state.response = [item('changed-in-Eagle-during-test')]; const start = h.prepared.length;
  await h.click('retest');
  assert.strictEqual(h.prepared.length - start, 6, 'normal protocol must execute three rapid plus three independent rounds');
  assert(h.prepared.slice(start).every(value => value.key === 'selected' && value.selected.id === 'audio-test'));
  assert.strictEqual(h.state.apiCalls, 1, 'performance must retain captured test identity');
  assert.strictEqual(h.saved.filter(record => record.kind === 'host-rapid').length, 3);
  assert.strictEqual(h.saved.filter(record => record.kind === 'host-random').length, 3);
  assert(h.saved.filter(record => ['host-rapid', 'host-random'].includes(record.kind))
    .every(record => record.value.trace.encoding === 'compact-v2'), 'manual tail must never replace a full automated protocol');
  const summary = h.saved[h.saved.length - 1];
  assert.strictEqual(summary.kind, 'host-protocol-summary'); assert.strictEqual(summary.value.reports.length, 6);
  assert.strictEqual(summary.value.source.itemId, 'audio-test');
  assert(!h.prepared.some(value => value.key === 'baseline')); await h.close(); await flush();
}

async function failedVideoManualObservationRegression() {
  const h = harness(); await h.initialize();
  h.element('manualDrag').value = '跟手'; h.element('manualSync').value = '相符'; h.element('manualFrames').value = '与目标相符';
  h.state.response = [item('failed-video-b')]; h.state.playerLoadError = new Error('B image initialization failed');
  await h.click('selected');
  assert.strictEqual(h.element('save').disabled, true, 'failed B cannot accept observations for old A');
  for (const id of ['manualDrag', 'manualSync', 'manualFrames'])
    assert.strictEqual(h.element(id).value, '未检查', 'leaving A must clear its human observation');
  const beforeSave = h.saved.length; await h.click('save');
  assert.strictEqual(h.saved.length, beforeSave, 'save handler must reject empty/error state even if called directly');
  const failed = h.saved[h.saved.length - 1]; assert.strictEqual(failed.kind, 'host-selection-failed');
  assert.strictEqual(failed.value.source.id, 'failed-video-b'); assert.strictEqual(failed.value.manual, undefined);
  assert.strictEqual(failed.value.loadMetrics, null); assert.strictEqual(h.liveInfos.size, 0); await h.close();
}

async function comparisonModeAndQuotaRegression() {
  const h = harness({ shortComparison: true }); await h.initialize();
  h.element('variant').value = 'compressed-ram'; await h.element('variant').handlers.change();
  assert.strictEqual(h.state.modes[h.state.modes.length - 1], 'compressed-ram');
  const before = h.prepared.length; await h.click('retest');
  assert.strictEqual(h.prepared.length, before, 'old full protocol must reject experimental mode without reloading');
  assert.match(h.element('error').textContent, /基线/);
  h.element('timeline').value = '.75'; await h.element('timeline').handlers.input();
  const beforeSaved = h.saved.length, beforeDispose = h.state.disposed; h.state.remainingBytes = 3 * 1024 ** 2 - 1;
  await h.click('comparison'); assert.strictEqual(h.saved.length, beforeSaved); assert.strictEqual(h.state.disposed, beforeDispose);
  await h.click('save'); const manual = h.saved[h.saved.length - 1].value;
  assert.strictEqual(manual.snapshot.experimentMode, 'compressed-ram'); assert(manual.events.some(e => e.type === 'input'));
  h.state.remainingBytes = 6 * 1024 ** 2; h.state.response = [item('unrelated-Eagle-selection')];
  const start = h.prepared.length; await h.click('comparison');
  assert.strictEqual(h.prepared.length - start, 3); assert.strictEqual(h.state.apiCalls, 1);
  assert(h.prepared.slice(start).every(p => p.selected.id === 'audio-test' && p.reuseOnly === true));
  assert.deepStrictEqual(h.state.modes.slice(-3), ['baseline', 'compressed-ram', 'ready-submit']);
  const saved = h.saved[h.saved.length - 1]; assert.strictEqual(saved.kind, 'host-comparison');
  assert.strictEqual(saved.value.reports.length, 3); assert.strictEqual(saved.value.officialAcceptance, false);
  assert.strictEqual(saved.value.events.length, 0); assert.strictEqual(saved.value.trace.encoding, 'three-short-rounds-in-reports');
  assert(saved.value.reports.every(r => r.source.fingerprint === 'mock-audio-test' && r.final.correct));
  assert.strictEqual(new Set(saved.value.reports.map(r => r.trajectorySha256)).size, 1);
  assert(Buffer.byteLength(JSON.stringify(saved.value, null, 2)) + 4096 <= 2 * 1024 ** 2);
  assert.strictEqual(h.state.peakLiveInfos, 1); assert.strictEqual(h.element('timeline').disabled, false);
  await h.click('save'); assert.strictEqual(h.saved[h.saved.length - 1].value.trace.encoding, 'manual-tail-v3');
  await h.close(); await flush();
}

async function comparisonIdentityFailureRegression() {
  const h = harness({ shortComparison: true }); await h.initialize();
  h.state.changeFingerprintAt = h.prepared.length + 2; await h.click('comparison');
  assert(!h.saved.some(s => s.kind === 'host-comparison'));
  const failed = h.saved[h.saved.length - 1]; assert.strictEqual(failed.kind, 'host-failed');
  assert.strictEqual(failed.value.failedTask, 'short-comparison'); assert.strictEqual(failed.value.reports.length, 1);
  assert.strictEqual(failed.value.officialAcceptance, false); assert.strictEqual(h.liveInfos.size, 0);
  assert.match(failed.value.error.message, /身份发生变化/); await h.close();
}

async function comparisonCancellationRegression() {
  const h = harness({ shortComparison: true }); await h.initialize(); h.state.holdPrepare = true;
  const running = h.click('comparison'); await until(() => !!h.state.finishPrepare, 'comparison did not start reuse preparation');
  await h.click('cancel'); h.state.holdPrepare = false; h.state.finishPrepare(); await running;
  assert(!h.saved.some(r => r.kind === 'host-comparison'));
  const failed = h.saved[h.saved.length - 1]; assert.strictEqual(failed.kind, 'host-failed');
  assert.strictEqual(failed.value.failedTask, 'short-comparison'); assert.strictEqual(failed.value.sampleBinding.fingerprint, 'mock-audio-test');
  assert.strictEqual(h.liveInfos.size, 0); assert.strictEqual(h.state.peakPrepareActive, 1);
  assert.strictEqual(h.element('variant').disabled, false); await h.close();
}

async function adoptedGateWiringRegression() {
  const h = harness({ shortProtocol: true }); await h.initialize();
  h.state.response = [item('selection-changed-outside-plugin')];
  const start = h.prepared.length; await h.click('gate');
  assert.strictEqual(h.cleaned.length, 3);
  assert.strictEqual(h.prepared.length - start, 18, 'six preparation, nine drag and three random loads');
  assert(h.state.modes.slice(-18).every(mode => mode === 'compressed-ram'));
  assert.strictEqual(h.state.apiCalls, 1); assert(h.prepared.slice(start).every(p => p.selected.id === 'audio-test'));
  assert(h.prepared.slice(start + 6).every(p => p.reuseOnly));
  const records = h.saved.filter(s => s.kind.startsWith('host-gate'));
  assert.strictEqual(records.length, 19); assert.strictEqual(records.at(-1).kind, 'host-gate-summary');
  assert.strictEqual(records.at(-1).value.summary.resultComplete, true);
  // This mock intentionally lacks real Canvas timestamps: completion never equals passing.
  assert.strictEqual(records.at(-1).value.summary.measuredGateMet, false);
  const traces = records.filter(r => r.value.trace); assert.strictEqual(traces.length, 12);
  const gate = require('./support/t0-gate.cjs');
  assert(traces.every(r => gate.unpack(r.value.trace).some(e => e.type === 'input')));
  assert(records.every(r => gate.fileSize(r.value) <= gate.LIMITS.fileBytes));
  assert(records.reduce((n, r) => n + gate.fileSize(r.value), 0) <= gate.LIMITS.sessionBytes);
  assert.strictEqual(h.state.peakLiveInfos, 1); assert.strictEqual(h.state.peakPrepareActive, 1);
  await h.close(); await flush();
}
async function adoptedGateFailureRegression() {
  const h = harness({ shortProtocol: true }); await h.initialize();
  h.element('timeline').value = '.75'; await h.element('timeline').handlers.input();
  h.state.remainingBytes = 4.5 * 1024 ** 2 - 1; const disposed = h.state.disposed, saved = h.saved.length;
  await h.click('gate'); assert.strictEqual(h.state.disposed, disposed); assert.strictEqual(h.saved.length, saved);
  await h.click('save'); assert(h.saved.at(-1).value.events.some(e => e.type === 'input'));
  h.state.remainingBytes = 5 * 1024 ** 2; h.state.changeFingerprintAt = h.prepared.length + 2;
  await h.click('gate');
  assert(!h.saved.some(r => r.kind === 'host-gate-summary'));
  const failed = h.saved.at(-1); assert.strictEqual(failed.kind, 'host-gate-failed');
  assert.strictEqual(failed.value.resultComplete, false); assert.match(failed.value.error.message, /身份发生变化/);
  assert.strictEqual(h.liveInfos.size, 0); assert.strictEqual(h.element('gate').disabled, true);
  assert.strictEqual(h.element('reload').disabled, false); await h.close();
}
async function adoptedGateCancellationAndCleanupRegression() {
  const h = harness({ shortProtocol: true }); await h.initialize(); h.state.holdPrepare = true;
  const running = h.click('gate'); await until(() => !!h.state.finishPrepare, 'gate preparation did not start');
  await h.click('cancel'); h.state.holdPrepare = false; h.state.finishPrepare(); await running;
  assert(!h.saved.some(r => r.kind === 'host-gate-summary'));
  assert.strictEqual(h.saved.at(-1).kind, 'host-gate-failed'); assert.strictEqual(h.liveInfos.size, 0);
  assert.strictEqual(h.saved.at(-1).value.cancellation.cause, 'stop-button');
  assert.strictEqual(h.saved.at(-1).value.interruptedPhase.kind, 'first');
  assert.match(h.element('error').textContent, /停止当前测试/);
  assert.match(h.element('status').textContent, /已停止.*本组未完成/);
  assert.strictEqual(h.state.peakPrepareActive, 1);
  await h.click('reload'); h.state.failCleanup = true;
  const before = h.prepared.length; await h.click('gate');
  assert.strictEqual(h.prepared.length, before, 'unknown cache ownership must stop before generation');
  assert.match(h.saved.at(-1).value.error.message, /Unknown file/);
  assert.strictEqual(h.saved.at(-1).value.cancellation, null, 'old cancellation cause must not leak into a new failure');
  assert.strictEqual(h.saved.at(-1).value.resultComplete, false); await h.close();
}

async function adoptedGateBlurDiagnosticRegression() {
  const h = harness({ shortProtocol: true }); await h.initialize(); h.state.holdPrepare = true;
  const running = h.click('gate'); await until(() => !!h.state.finishPrepare, 'gate preparation did not start');
  h.element('status').textContent = '{"stage":"decode","frames":281}';
  await h.windowHandlers.blur(); await h.click('cancel');
  h.state.holdPrepare = false; h.state.finishPrepare(); await running;
  const failure = h.saved.at(-1).value;
  assert.strictEqual(h.saved.at(-1).kind, 'host-gate-failed');
  assert.strictEqual(failure.cancellation.cause, 'window-blur', 'later stop must retain the first trigger');
  assert.match(failure.cancellation.statusAtStop, /decode/);
  assert.strictEqual(failure.cancellation.phase.kind, 'first');
  assert.strictEqual(failure.cancellation.phase.round, 1);
  assert.strictEqual(failure.resultComplete, false); assert.strictEqual(failure.trace, null);
  assert.match(h.element('error').textContent, /窗口失去焦点/);
  assert.match(h.element('status').textContent, /已停止.*本组未完成/);
  assert(!h.element('status').textContent.includes('decode'), 'cancelled run must not keep stale decode status');
  assert(!h.saved.some(r => r.kind === 'host-gate-summary')); assert.strictEqual(h.liveInfos.size, 0);
  await h.click('reload'); assert.strictEqual(h.element('reload').disabled, false); await h.close();
}

async function test() {
  for (const scenario of [playbackAndLeaseRegression, pointerOwnershipRegression, manualTailAndQuotaRegression, selectionAndFailureRegression, emptyAndMalformedRegression,
    initializationAndCancellationRegression, interruptedPreparationRegression, currentVideoProtocolRegression,
    currentVideoPerformanceWiringRegression, failedVideoManualObservationRegression, comparisonModeAndQuotaRegression,
    comparisonIdentityFailureRegression, comparisonCancellationRegression, adoptedGateWiringRegression, adoptedGateFailureRegression,
    adoptedGateCancellationAndCleanupRegression, adoptedGateBlurDiagnosticRegression]) {
    await scenario(); console.log('ok ' + scenario.name);
  }
  console.log('t0-host: real selection adapter in mocked Eagle, current-video startup/protocol, lifecycle interleavings, failure evidence, pointer/lease/resource regression passed (not real Eagle)');
}

test().catch(error => { console.error(error); process.exitCode = 1; });
