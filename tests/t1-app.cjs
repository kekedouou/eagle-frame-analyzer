'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '../plugin/app.js'), 'utf8');
function harness(settings = {}) {
  const hooks = {}, log = [], updates = [], root = path.resolve(__dirname, '../plugin'), discoveries = [];
  let config, discovered = 0, prepared = 0, closed = 0, destroyed = 0;
  const ui = { canvas: {}, bindSession() {}, update(value) { updates.push(value); }, destroy() { destroyed++; } };
  const session = {
    loadSelected(options) { log.push({ type: 'selected', options }); return Promise.resolve(); },
    libraryChanged() { log.push({ type: 'library' }); return Promise.resolve(); },
    close() { closed++; return Promise.resolve(); },
    snapshot() { return { epoch: 3, libraryEpoch: 1, sourceIdentity: { itemId: 'fixed', sha256: 'a'.repeat(64) } }; }
  };
  const adapter = {
    captureSelected() { return Promise.resolve({ id: 'fixed', filePath: path.join(root, 'video.mp4') }); },
    discoverTools() { discovered++; return new Promise((resolve, reject) => { discoveries.push({ resolve, reject }); }); }
  };
  const modules = {
    'cache.cjs': { createCache(options) { assert.strictEqual(options.pluginRoot, root); return { readAsset() {}, release() {} }; } },
    'eagle.cjs': { createEagleAdapter() { return adapter; } },
    'session.cjs': { createSession(options) { config = options; return settings.realSession ? require('../plugin/session.cjs').createSession(options) : session; } },
    'diagnostics.cjs': { createDiagnostics: require('../plugin/diagnostics.cjs').createDiagnostics },
    'media.cjs': { createMedia(options) { assert.strictEqual(options.tools.ffmpeg, 'existing-only'); return { prepare(snapshot, options) { prepared++; assert.strictEqual(snapshot.id, 'fixed'); return { snapshot, options }; } }; } },
    'frame-index.cjs': {}
  };
  const eagle = Object.fromEntries(['onPluginCreate', 'onPluginRun', 'onLibraryChanged', 'onPluginBeforeExit'].map(name => [name, callback => { hooks[name] = callback; }]));
  const win = { EVAUI: { createUI: () => ui }, EVAPlayer: { Player: function (options) { this.options = options; } }, addEventListener(type, fn) { hooks[type] = fn; } };
  vm.runInNewContext(code, { window: win, eagle, performance: { now: () => 100 }, require(name) {
    if (name === 'path') return path; if (name === 'fs') return { realpathSync: file => file };
    assert.strictEqual(path.dirname(name), root); assert(modules[path.basename(name)], name); return modules[path.basename(name)];
  }, Promise });
  return { hooks, log, updates, root, ui, discoveries, win, get config() { return config; },
    counts: () => ({ discovered, prepared, closed, destroyed }) };
}
async function bounded(pending) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation remained blocked by tool discovery')), 1000); })]); }
  finally { clearTimeout(timer); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function main() {
  const h = harness();
  await h.hooks.onPluginCreate({ path: h.root });
  assert.strictEqual(h.log[0].type, 'selected'); assert.strictEqual(h.log[0].options.startedAt, 100);
  assert.strictEqual(h.counts().discovered, 0, 'Selection must not wait for tools');
  const signal = new AbortController().signal, pending = h.config.media.prepare({ id: 'fixed' }, { signal });
  await tick(); assert.strictEqual(h.counts().discovered, 1); assert.strictEqual(h.counts().prepared, 0);
  h.discoveries[0].resolve({ ffmpeg: 'existing-only' }); await pending;
  await h.config.media.prepare({ id: 'fixed' }, { signal }); assert.strictEqual(h.counts().discovered, 1);
  const player = h.config.createPlayer({ experimentMode: 'compressed-ram' });
  assert.strictEqual(player.options.canvas, h.ui.canvas); assert.strictEqual(player.options.experimentMode, 'compressed-ram');
  assert(Object.isFrozen(h.win.EVADiagnostics));
  assert.strictEqual(h.win.EVADiagnostics.snapshot().epoch, 3);
  assert.strictEqual(h.win.EVADiagnostics.snapshot().pluginRoot, h.root);
  const events = [], unsubscribe = h.win.EVADiagnostics.subscribe(event => events.push(event));
  player.options.emit({ type: 'draw', frameId: 0 });
  assert.strictEqual(events[0].type, 'player'); assert.strictEqual(events[0].value.binding.sessionEpoch, 3);
  assert.strictEqual(events[0].value.event.frameId, 0); unsubscribe();
  await h.hooks.onPluginCreate({ path: h.root }); assert.strictEqual(h.log.length, 1);
  await h.hooks.onPluginRun(); assert.strictEqual(h.log[1].options.trigger, 'plugin-run');
  await h.hooks.onLibraryChanged(); assert.strictEqual(h.log[2].type, 'library');
  await h.hooks.onPluginBeforeExit(); h.hooks.pagehide();
  assert.strictEqual(h.counts().closed, 1); assert.strictEqual(h.counts().destroyed, 1);
  await h.hooks.onPluginRun(); assert.strictEqual(h.log.length, 3); assert.strictEqual(h.updates.length, 0);
  console.log('T1 app: lifecycle/selected-entry/tool-discovery/assembly/close simulation passed');

  for (const lateReject of [false, true]) {
    const h = harness(); await h.hooks.onPluginCreate({ path: h.root });
    const controller = new AbortController(), pending = h.config.media.prepare({ id: 'fixed' }, { signal: controller.signal });
    const rejection = assert.rejects(pending, error => error.name === 'AbortError');
    await tick(); controller.abort(); await bounded(rejection);
    assert.strictEqual(h.counts().prepared, 0, 'Cancelled wait must settle before SDK returns');
    if (lateReject) h.discoveries[0].reject(new Error('late discovery failure'));
    else h.discoveries[0].resolve({ ffmpeg: 'existing-only' });
    await tick(); assert.strictEqual(h.counts().prepared, 0, 'Late SDK result cannot start old media work');
    console.log('T1 app: cancelled discovery wait and late ' + (lateReject ? 'rejection' : 'success') + ' passed');
  }
  {
    const h = harness(); await h.hooks.onPluginCreate({ path: h.root });
    const first = new AbortController(), second = new AbortController();
    const old = h.config.media.prepare({ id: 'fixed' }, { signal: first.signal });
    const rejected = assert.rejects(old, error => error.name === 'AbortError');
    await tick(); first.abort(); await bounded(rejected);
    const current = h.config.media.prepare({ id: 'fixed' }, { signal: second.signal });
    h.discoveries[0].resolve({ ffmpeg: 'existing-only' }); await current;
    assert.deepStrictEqual(h.counts(), { discovered: 1, prepared: 1, closed: 0, destroyed: 0 });
    console.log('T1 app: new session shares discovery without running cancelled session passed');
  }
  {
    const h = harness(); await h.hooks.onPluginCreate({ path: h.root });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.config.media.prepare({ id: 'fixed' }, { signal: controller.signal }), error => error.name === 'AbortError');
    assert.strictEqual(h.counts().discovered, 0);
    const failed = h.config.media.prepare({ id: 'fixed' }, {});
    const rejection = assert.rejects(failed, /discovery failed/);
    await tick(); h.discoveries[0].reject(new Error('discovery failed')); await rejection;
    const retry = h.config.media.prepare({ id: 'fixed' }, {});
    await tick(); h.discoveries[1].resolve({ ffmpeg: 'existing-only' }); await retry;
    assert.strictEqual(h.counts().prepared, 1); assert.strictEqual(h.counts().discovered, 2);
    console.log('T1 app: pre-aborted entry and discovery failure retry passed');
  }
  {
    const h = harness({ realSession: true });
    const loading = h.hooks.onPluginCreate({ path: h.root });
    await tick(); assert.strictEqual(h.counts().discovered, 1);
    await bounded(h.hooks.onPluginBeforeExit()); await bounded(loading);
    assert.strictEqual(h.counts().prepared, 0); assert.strictEqual(h.counts().destroyed, 1);
    assert.strictEqual(h.updates.at(-1).state, 'closed');
    console.log('T1 app: real session closes while SDK discovery never returns passed; Eagle not executed');
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
