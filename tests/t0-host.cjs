'use strict';
const assert = require('assert'), vm = require('vm'), fs = require('fs'), path = require('path');
const host = path.resolve(__dirname, 'host/t0');
const code = fs.readFileSync(path.join(host, 'app.js'), 'utf8');
async function test() {
  const elements = new Map(), saved = [], inputKinds = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: id === 'refresh' ? '60' : '未检查', handlers: {}, disabled: true,
      addEventListener(name, callback) { this.handlers[name] = callback; }, append() {}, textContent: '' });
    return elements.get(id);
  };
  let initializer, constructed = 0, disposed = 0, released = 0, holdDispose = false, finishDispose, failCleanup = false, sampleTimer, memoryRss = 10;
  const info = { source: { key: 'baseline' }, metrics: { reused: true }, duration: 1, audio: null,
    frames: [{ id: 10, time: 0 }, { id: 20, time: .5 }], expected: null };
  const backend = { HOST_ROOT: host, CACHE_ROOT: path.join(host, 'cache'), listSources: async () => [{ key: 'baseline', label: 'baseline' }],
    prepare: async () => info, release: async () => { released++; }, cleanup: async () => { if (failCleanup) throw new Error('Unknown file blocks cleanup'); },
    saveEvidence: async (kind, value) => { saved.push({ kind, value }); return 'mock-evidence-only'; } };
  let tick = 1;
  class Player {
    constructor(options) { this.options = options; this.state = 'empty'; this.time = 0; this.frameId = 10; this.request = 0; constructed++; }
    setVerifyMarkers() {}
    async load() { this.state = 'paused'; }
    snapshot() { return { state: this.state, time: this.time, frameId: this.frameId, activeImageTasks: 0, cacheBytes: 0 }; }
    async seek(time, options) {
      this.request++; inputKinds.push(options.kind);
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
    window: { EVAPlayer: { Player }, addEventListener() {} }, performance: { now: () => tick++ },
    setTimeout: (callback, ms) => setTimeout(callback, holdDispose && ms === 10000 ? 1 : ms), clearTimeout,
    setInterval: callback => { sampleTimer = callback; return 1; }, AbortController, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    process: { versions: { node: '16.17.1', chrome: '108' }, platform: 'win32', pid: 123, memoryUsage: () => ({ rss: memoryRss }) },
    eagle: { onPluginCreate(callback) { initializer = callback; }, onPluginBeforeExit() {} },
    require(name) {
      if (name.endsWith('t0-media.cjs')) return backend;
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
  memoryRss = 1.5 * 1024 ** 3; sampleTimer(); sampleTimer();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(saved.filter(record => record.kind === 'host-resource-stop').length, 1);
  console.log('t0-host: mock wiring, raw input association, timeout lease retention, cleanup recovery, one-shot RSS shutdown and no human autofill passed (not real Eagle)');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
