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
const saves = [], prepared = [], prepareCalls = [];
let selectedCalls = 0, selectionProvider = () => [], prepareGate = null, prepareFailure = null;
const waitTurn = () => new Promise(resolve => setTimeout(resolve, 0));
const selectedItem = (id, name = '中文 空格视频', filePath = 'G:\\Eagle 素材库\\中文 目录\\测试 视频.mp4') => ({ id, name, filePath, ext: 'mp4' });
const backend = {
  ROOT: root,
  async listSources() { tick += 7; return [{ key: 'h264-cfr', label: 'synthetic' }, { key: 'vp9-silent', label: 'silent' }, { key: 'selected', label: 'selected' }]; },
  async prepare(key, { signal, selected }) {
    assert(!signal.aborted); prepared.push(key); tick += 20;
    prepareCalls.push({ key, selected, signal });
    const gate = prepareGate; prepareGate = null; if (gate) await gate;
    if (prepareFailure) { const error = prepareFailure; prepareFailure = null; throw error; }
    return { source: { key, label: selected ? selected.name : key, itemId: selected ? selected.id : null,
      filePath: selected ? selected.filePath : null, codec: 'fake', width: 1280, height: 720 },
      width: 1280, height: 720, duration: 1, frames: [{ id: 0, time: 0, end: 1 }], metrics: { totalMs: 20, reused: false }, audio: null };
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
  eagle: { app: { version: 'fake', build: 'fake' }, item: { getSelected() { selectedCalls++; return selectionProvider(); } },
    onPluginCreate(fn) { initialize = fn; }, onPluginRun(fn) { run = fn; }, onPluginBeforeExit(fn) { exit = fn; } },
  process: { versions: { node: 'simulated' }, platform: process.platform, memoryUsage: () => ({ rss: 100, heapUsed: 20, external: 8, arrayBuffers: 8 }) },
  performance: { now: () => ++tick }, require: fakeRequire, AbortController,
  setInterval(fn) { interval = fn; return 1; }, clearInterval() {}, setTimeout
};
(async () => {
  vm.runInNewContext(source, context, { filename: 'app.js' });
  assert.strictEqual(typeof initialize, 'function');
  await initialize({ path: root });
  assert.deepStrictEqual(prepared, ['h264-cfr']);
  assert.strictEqual(selectedCalls, 0, 'default startup must not read or preprocess selected library material');
  assert.strictEqual(el('play').disabled, false);
  assert.strictEqual(el('timeline').max, 1);
  interval();
  await el('save').listeners.click();
  const first = saves[0].data;
  assert(first.loadMetrics.entryAndQueueMs >= 7, 'first load must include initialization');
  assert(first.loadMetrics.browserReadyMs >= 5);
  assert.strictEqual(first.snapshot.state, 'paused');
  assert.strictEqual(first.summary.physicalDisplayMs, null);
  await run();
  assert.strictEqual(saves[1].kind, 'window-switch');
  assert.strictEqual(saves[1].data.snapshot.state, 'paused', 'snapshot must precede disposal');
  assert(disposed >= 1);
  const invalid = [
    { items: [], message: /先在 Eagle 中选中/ },
    { items: [selectedItem('one'), selectedItem('two')], message: /多个素材/ },
    { items: [{ ...selectedItem('one'), ext: 'png' }], message: /不是 MP4/ },
    { items: [{ ...selectedItem('one'), filePath: '' }], message: /缺少本地文件路径/ },
    { items: [{ ...selectedItem('one'), id: '' }], message: /缺少素材 ID/ }
  ];
  for (const test of invalid) {
    const before = prepared.length;
    selectionProvider = () => test.items;
    await el('selected').listeners.click();
    assert.strictEqual(prepared.length, before, 'invalid selection must not enter FFmpeg backend');
    const failed = saves[saves.length - 1];
    assert.strictEqual(failed.kind, 'window-load-failed');
    assert.strictEqual(failed.data.source, null, 'selection failure cannot carry previous material identity');
    assert.strictEqual(failed.data.loadRequest.key, 'selected');
    assert(test.message.test(failed.data.loadRequest.error.message));
  }
  const original = selectedItem('固定-A'); selectionProvider = () => [original];
  let before = selectedCalls;
  const captured = el('selected').listeners.click();
  assert.strictEqual(selectedCalls, before + 1, 'getSelected must be invoked in the click handler, not after the preparation queue');
  await Promise.resolve(); original.id = 'later-mutation'; original.filePath = 'G:\\other.mp4';
  await captured;
  const fixed = prepareCalls[prepareCalls.length - 1];
  assert.strictEqual(fixed.selected.id, '固定-A');
  assert.strictEqual(fixed.selected.filePath, 'G:\\Eagle 素材库\\中文 目录\\测试 视频.mp4');
  assert(Object.isFrozen(fixed.selected), 'only fixed plain identity fields enter backend');
  await el('save').listeners.click();
  assert.strictEqual(saves[saves.length - 1].data.source.itemId, '固定-A');
  assert.strictEqual(saves[saves.length - 1].data.loadRequest.selected.id, '固定-A');
  selectionProvider = () => [selectedItem('不自动跟随')]; before = selectedCalls; interval(); await waitTurn();
  assert.strictEqual(selectedCalls, before, 'memory timer must not follow selection changes');
  assert.strictEqual(prepareCalls[prepareCalls.length - 1].selected.id, '固定-A');
  const invoked = run();
  assert.strictEqual(selectedCalls, before + 1, 'explicit plugin re-invocation captures the then-current selection immediately');
  await invoked; assert.strictEqual(prepareCalls[prepareCalls.length - 1].selected.id, '不自动跟随');
  selectionProvider = () => [selectedItem('下拉-B')]; el('sample').value = 'selected';
  await el('sample').listeners.change(); assert.strictEqual(prepareCalls[prepareCalls.length - 1].selected.id, '下拉-B');
  selectionProvider = () => [selectedItem('重载-C')]; await el('reload').listeners.click();
  assert.strictEqual(prepareCalls[prepareCalls.length - 1].selected.id, '重载-C');
  let resolveSlow; selectionProvider = () => new Promise(resolve => { resolveSlow = resolve; });
  const slow = el('selected').listeners.click(); await waitTurn();
  el('sample').value = 'vp9-silent'; await el('sample').listeners.change();
  resolveSlow([selectedItem('过时的慢返回')]); await slow; await waitTurn();
  assert.strictEqual(prepared[prepared.length - 1], 'vp9-silent');
  assert(!prepareCalls.some(call => call.selected && call.selected.id === '过时的慢返回'), 'stale API response must never enter backend or replace new source');
  await el('save').listeners.click(); assert.strictEqual(saves[saves.length - 1].data.source.key, 'vp9-silent');
  let unblock; prepareGate = new Promise(resolve => { unblock = resolve; });
  el('sample').value = 'h264-cfr'; const preparing = el('sample').listeners.change(); await waitTurn();
  selectionProvider = () => [selectedItem('排队前-D')]; before = selectedCalls;
  const queued = el('selected').listeners.click(); assert.strictEqual(selectedCalls, before + 1);
  await Promise.resolve(); selectionProvider = () => [selectedItem('排队后不应读取')]; unblock();
  await preparing; await queued;
  assert.strictEqual(prepareCalls[prepareCalls.length - 1].selected.id, '排队前-D');
  selectionProvider = () => [selectedItem('超时长-E')]; prepareFailure = new Error('视频超过30秒，本实验不支持。');
  await el('reload').listeners.click();
  const rejected = saves[saves.length - 1]; assert.strictEqual(rejected.kind, 'window-load-failed');
  assert.strictEqual(rejected.data.source, null); assert.strictEqual(rejected.data.loadRequest.selected.id, '超时长-E');
  assert(/超过30秒/.test(rejected.data.loadRequest.error.message));
  assert.strictEqual(typeof exit, 'function'); exit();
  console.log(JSON.stringify({ test: 'S1 app wiring simulation', passed: true,
    checks: ['manifest/assets/DOM', 'automatic synthetic default without library reads', 'initial-load timing includes initialization',
      'paused ready controls', 'save-before-dispose on reload', 'physical metrics remain null',
      'empty/multiple/non-MP4/path/ID selection validation', 'failed selection evidence contains no previous source',
      'Chinese/space path and frozen identity snapshot', 'button/dropdown/reload/plugin-run share explicit capture',
      'selection changes do not auto-follow', 'slow obsolete selection cannot override a newer load',
      'capture occurs before a blocked preparation queue', 'backend duration failure remains explicit'], actualEagle: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
