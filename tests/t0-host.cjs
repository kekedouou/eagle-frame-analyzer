'use strict';
const assert = require('assert'), vm = require('vm'), fs = require('fs'), path = require('path');
const host = path.resolve(__dirname, 'host/t0');
const code = fs.readFileSync(path.join(host, 'app.js'), 'utf8');
async function test() {
  const elements = new Map(), saved = [], inputKinds = [], inputTimes = [], prepared = [], windowHandlers = {};
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: id === 'refresh' ? '60' : '未检查', handlers: {}, disabled: true,
      addEventListener(name, callback) { this.handlers[name] = callback; }, append() {}, textContent: '' });
    return elements.get(id);
  };
  let initializer, reinvoke, constructed = 0, disposed = 0, released = 0, holdDispose = false, finishDispose, failCleanup = false, sampleTimer, memoryRss = 10;
  let selected = { id: 'audio-test', name: '中文 有声', filePath: 'G:\\测试 库\\中文 有声.mp4', ext: 'mp4' }, selectedError = null;
  let holdSelection = false, finishSelection;
  const info = { source: { key: 'baseline' }, metrics: { reused: true }, duration: 1, audio: null,
    frames: [{ id: 10, time: 0 }, { id: 20, time: .5 }], expected: null };
  const backend = { HOST_ROOT: host, CACHE_ROOT: path.join(host, 'cache'), listSources: async () => [{ key: 'baseline', label: 'baseline' }, { key: 'selected', label: 'selected' }],
    prepare: async (key, options) => { prepared.push({ key, selected: options.selected }); return key === 'selected' ? { ...info, source: { key, ...options.selected } } : info; },
    evidenceInfo: () => ({ remainingBytes: 60 * 1024 ** 2 }), release: async () => { released++; }, cleanup: async () => { if (failCleanup) throw new Error('Unknown file blocks cleanup'); },
    saveEvidence: async (kind, value) => { saved.push({ kind, value }); return 'mock-evidence-only'; } };
  let tick = 1;
  class Player {
    constructor(options) { this.options = options; this.state = 'empty'; this.time = 0; this.frameId = 10; this.request = 0; constructed++; }
    setVerifyMarkers() {}
    async load() { this.state = 'paused'; }
    snapshot() { return { state: this.state, time: this.time, frameId: this.frameId, activeImageTasks: 0, cacheBytes: 0 }; }
    async seek(time, options) {
      this.request++; inputKinds.push(options.kind); inputTimes.push(time);
      this.options.emit({ type: 'request', epoch: 1, requestId: this.request, phase: 'input', frameId: 20, inputAt: options.inputAt, at: tick++ });
      this.time = time; this.frameId = 20;
      this.options.emit({ type: 'draw', epoch: 1, requestId: this.request, frameId: 20, inputAt: options.inputAt, at: tick++ });
      return { status: 'drawn', requestId: this.request };
    }
    async dispose() { disposed++; if (holdDispose) await new Promise(resolve => { finishDispose = resolve; }); }
    pause() { this.state = 'paused'; }
    async play() { this.state = 'playing'; }
    async step() {}
  }
  const fakeFs = { realpathSync: fs.realpathSync, readFileSync: () => Buffer.from('mock-code-fingerprint') };
  const context = { document: { getElementById: element, createElement: () => ({}), activeElement: null },
    window: { EVAPlayer: { Player }, addEventListener(name, callback) { windowHandlers[name] = callback; } }, performance: { now: () => tick++ },
    setTimeout: (callback, ms) => setTimeout(callback, holdDispose && ms === 10000 ? 1 : ms), clearTimeout,
    setInterval: callback => { sampleTimer = callback; return 1; }, AbortController, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    process: { versions: { node: '16.17.1', chrome: '108' }, platform: 'win32', pid: 123, memoryUsage: () => ({ rss: memoryRss }) },
    eagle: { onPluginCreate(callback) { initializer = callback; }, onPluginRun(callback) { reinvoke = callback; }, onPluginBeforeExit() {} },
    require(name) {
      if (name.endsWith('t0-media.cjs')) return backend;
      if (name.endsWith('t0-selection.cjs')) return { captureSelected: async () => { if (holdSelection) await new Promise(resolve => { finishSelection = resolve; }); if (selectedError) throw selectedError; return Object.freeze({ ...selected }); } };
      if (name.endsWith('t0-protocol.cjs')) return require('./support/t0-protocol.cjs');
      if (name.endsWith('frame-index.cjs')) return require('../plugin/frame-index.cjs');
      if (name === 'fs') return fakeFs;
      return require(name);
    }
  };
  vm.runInNewContext(code, context, { filename: 't0-app.js' });
  await initializer({ path: host });
  assert.strictEqual(constructed, 1);
  assert.strictEqual(element('timeline').disabled, false);
  assert.strictEqual(saved[0].kind, 'host-initial-ready');
  element('timeline').value = '.5';
  await element('timeline').handlers.input();
  await element('save').handlers.click();
  const evidence = saved[saved.length - 1].value;
  const input = evidence.events.find(e => e.type === 'input'), terminal = evidence.events.find(e => e.type === 'input-end'), draw = evidence.events.find(e => e.type === 'draw');
  assert.strictEqual(input.inputId, terminal.inputId);
  assert.strictEqual(input.inputId, draw.inputId);
  assert.strictEqual(draw.stale, false);
  assert.strictEqual(inputKinds[0], 'drag');
  assert.strictEqual(evidence.manual.executor, 'user-entered-observation');
  assert.strictEqual(evidence.manual.drag, '未检查');
  // Eagle need not focus a range while pointer dragging. Polling must not push
  // its displayed frame back into the user's still-moving target.
  if (element('timeline').handlers.pointerdown) element('timeline').handlers.pointerdown({ pointerId: 4 });
  element('timeline').value = '.9'; sampleTimer();
  assert.strictEqual(element('timeline').value, '.9', 'polling overwrote an active pointer drag');
  const beforeRelease = inputKinds.filter(kind => kind === 'release').length;
  await windowHandlers.pointerup({ pointerId: 4 });
  await element('timeline').handlers.change();
  assert.strictEqual(inputTimes[inputTimes.length - 1], .9, 'release must use last target, not polled frame');
  assert.strictEqual(inputKinds.filter(kind => kind === 'release').length, beforeRelease + 1, 'pointerup and change must not duplicate final seek');
  element('timeline').handlers.pointerdown({ pointerId: 5 });
  element('timeline').value = '.7'; await element('timeline').handlers.input();
  await windowHandlers.pointerup({ pointerId: 99 }); // A different pointer cannot end this drag.
  element('timeline').value = '.8'; sampleTimer();
  assert.strictEqual(element('timeline').value, '.8');
  await element('timeline').handlers.pointercancel({ pointerId: 5 });
  assert.strictEqual(inputTimes[inputTimes.length - 1], .7, 'cancel settles last real input, not an unrelated range mutation');
  element('timeline').value = '.4'; await element('timeline').handlers.input(); await element('timeline').handlers.change();
  assert.strictEqual(inputTimes[inputTimes.length - 1], .4, 'keyboard range input also receives final seek');
  await element('reload').handlers.click();
  assert.strictEqual(disposed, 1); assert.strictEqual(released, 1);
  holdDispose = true;
  await element('reload').handlers.click(); // Forced simulated timeout, not a real 10s wait.
  assert.strictEqual(released, 1); assert.strictEqual(constructed, 2);
  assert.strictEqual(element('reload').disabled, false);
  await element('reload').handlers.click();
  assert.strictEqual(released, 1); assert.strictEqual(disposed, 2); // same actual disposal promise retained
  holdDispose = false; finishDispose(); await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(released, 2);
  await element('reload').handlers.click(); assert.strictEqual(constructed, 3);
  failCleanup = true;
  await element('preparation').handlers.click();
  assert.strictEqual(element('reload').disabled, false); // fresh cleanup failure cannot trap busy=true
  assert(saved.some(record => record.kind === 'host-failed'));
  failCleanup = false; await element('reload').handlers.click();
  element('manualSync').value = '相符'; await element('selected').handlers.click();
  assert.strictEqual(prepared[prepared.length - 1].key, 'selected');
  assert.strictEqual(prepared[prepared.length - 1].selected.id, 'audio-test');
  assert(Object.isFrozen(prepared[prepared.length - 1].selected));
  assert.strictEqual(element('manualSync').value, '未检查', 'human observation cannot carry across videos');
  selected = { ...selected, id: 'second-video', filePath: 'G:\\测试 库\\第二条.mp4' };
  await element('reload').handlers.click();
  assert.strictEqual(prepared[prepared.length - 1].selected.id, 'audio-test', 'reload must not reread a changed Eagle selection');
  await reinvoke();
  assert.strictEqual(prepared[prepared.length - 1].selected.id, 'second-video', 'explicit re-invoke captures current selected MP4');
  const prepareCount = prepared.length, previousDisposed = disposed;
  selectedError = new Error('只选中一个 MP4'); await element('selected').handlers.click();
  assert.strictEqual(prepared.length, prepareCount); assert.strictEqual(disposed, previousDisposed);
  assert.strictEqual(element('timeline').disabled, false, 'failed selection capture preserves usable current player');
  assert(element('error').textContent.includes('只选中一个'));
  element('sample').value = 'baseline'; await element('sample').handlers.change();
  element('sample').value = 'selected'; await element('sample').handlers.change();
  assert.strictEqual(element('sample').value, 'baseline', 'failed selected capture must restore actual source in dropdown');
  selectedError = null; holdSelection = true;
  const countBeforeCancel = prepared.length, pendingSelection = element('selected').handlers.click();
  element('cancel').handlers.click(); finishSelection(); await pendingSelection;
  assert.strictEqual(prepared.length, countBeforeCancel, 'cancelled selection must not start media preparation after API response');
  holdSelection = false; await element('reload').handlers.click();
  holdDispose = true; finishDispose = null;
  const countBeforeDisposeCancel = prepared.length, loadingDuringDispose = element('reload').handlers.click();
  for (let n = 0; n < 5; n++) await Promise.resolve();
  assert.strictEqual(typeof finishDispose, 'function');
  element('cancel').handlers.click();
  holdDispose = false; finishDispose(); await loadingDuringDispose;
  assert.strictEqual(prepared.length, countBeforeDisposeCancel, 'cancel during real disposal must stop the subsequent preparation');
  await element('reload').handlers.click();
  selectedError = null;
  element('sample').value = 'baseline';
  const beforePreflight = prepared.length;
  await element('performance').handlers.click(); // The full protocol cannot fit remaining evidence; fail before media work.
  assert.strictEqual(prepared.length, beforePreflight);
  assert(saved.some(record => record.kind === 'host-failed' && record.value.failedTask === 'performance'));
  await element('reload').handlers.click();
  memoryRss = 1.5 * 1024 ** 3; sampleTimer(); sampleTimer();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(saved.filter(record => record.kind === 'host-resource-stop').length, 1);
  console.log('t0-host: mock wiring, pointer ownership/release, explicit selection snapshots/reinvoke, raw trace, evidence preflight, lease retention, cleanup recovery, RSS and no human autofill passed (not real Eagle)');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
