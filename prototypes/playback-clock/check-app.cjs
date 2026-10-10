'use strict';
// 接线模拟，不加载 Eagle，也不证明浏览器媒体能力。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.main.url, 'index.html');
for (const name of ['index.html', 'logo.png', 'player.js', 'prepare.cjs']) assert(fs.statSync(path.join(root, name)).isFile(), name);
const elements = new Map();
for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
  assert(!elements.has(match[1]), `duplicate id ${match[1]}`);
  elements.set(match[1], { value: match[1] === 'delay' ? '0' : '未检查', checked: true, disabled: true, selectedIndex: 0, listeners: {}, append() {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
}
const el = id => { assert(elements.has(id), `missing DOM id ${id}`); return elements.get(id); };
let tick = 1, initialize, run, exit, interval, disposed = 0;
const saves = [], prepared = [];
const backend = {
  ROOT: root,
  async listSources() { tick += 7; return [{ key: 'h264-cfr', label: 'synthetic' }, { key: 'vp9-silent', label: 'silent' }]; },
  async prepare(key, { signal }) {
    assert(!signal.aborted); prepared.push(key); tick += 20;
    return { source: { key, label: key, codec: 'fake', width: 1280, height: 720 }, width: 1280, height: 720, duration: 1, frames: [{ id: 0, time: 0, end: 1 }], metrics: { totalMs: 20, reused: false }, audio: null };
  },
  async readAsset() { throw new Error('fake player must not read'); },
  async saveEvidence(kind, data) { saves.push({ kind, data }); return 'fake-evidence.json'; },
  async cleanup() { return { fake: true }; }
};
class Player {
  constructor(options) { this.options = options; this.s = { state: 'empty', time: 0, frameId: 0, cacheBytes: 8, cachePeakBytes: 16 }; }
  snapshot() { return { ...this.s }; }
  async load() { tick += 5; this.s.state = 'paused'; this.options.onChange(this.snapshot()); }
  setVerifyMarkers() {}
  setDecodeDelay() {}
  pause() { if (this.s.state === 'playing') this.s.state = 'paused'; }
  async play() { this.s.state = 'playing'; this.options.onChange(this.snapshot()); }
  async seek(time, options) { this.s.time = time; this.options.emit({ type: 'draw', kind: options.kind, inputAt: options.inputAt, drawAt: tick, barcode: { actual: 0, expected: 0, ok: true } }); return { status: 'drawn', frameId: 0 }; }
  async step() {}
  async dispose() { this.s.state = 'disposed'; disposed++; }
}
const fakeRequire = name => name === 'fs' ? { realpathSync: p => p } : name === 'path' ? path : name === path.join(root, 'prepare.cjs') ? backend : assert.fail(`unexpected require ${name}`);
const context = {
  document: { getElementById: el, createElement: () => ({}) },
  window: { S1Player: { Player }, addEventListener() {} },
  eagle: { app: { version: 'fake', build: 'fake' }, onPluginCreate(fn) { initialize = fn; }, onPluginRun(fn) { run = fn; }, onPluginBeforeExit(fn) { exit = fn; } },
  process: { versions: { node: 'simulated' }, platform: process.platform, memoryUsage: () => ({ rss: 100, heapUsed: 20, external: 8, arrayBuffers: 8 }) },
  performance: { now: () => ++tick }, require: fakeRequire, AbortController,
  setInterval(fn) { interval = fn; return 1; }, clearInterval() {}, setTimeout
};
(async () => {
  vm.runInNewContext(source, context, { filename: 'app.js' });
  assert.strictEqual(typeof initialize, 'function');
  await initialize({ path: root });
  assert.deepStrictEqual(prepared, ['h264-cfr']);
  assert.strictEqual(el('play').disabled, false);
  assert.strictEqual(el('timeline').max, 1);
  interval();
  await el('save').listeners.click();
  const first = saves[0].data;
  assert(first.loadMetrics.entryAndQueueMs >= 7, 'first load must include initialization');
  assert(first.loadMetrics.browserReadyMs >= 5);
  assert.strictEqual(first.snapshot.state, 'paused');
  assert.strictEqual(first.summary.physicalDisplayMs, null);
  await run(); // event wrapper is fire-and-forget; flush its serial load
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(saves[1].kind, 'window-switch');
  assert.strictEqual(saves[1].data.snapshot.state, 'paused', 'snapshot must precede disposal');
  assert(disposed >= 1);
  assert.strictEqual(typeof exit, 'function'); exit();
  console.log(JSON.stringify({ test: 'S1 app wiring simulation', passed: true, checks: ['manifest/assets/DOM', 'automatic default preparation', 'initial-load timing includes initialization', 'paused ready controls', 'save-before-dispose on reload', 'physical metrics remain null'], actualEagle: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
