'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '../plugin/app.js'), 'utf8');
async function main() {
  const hooks = {}, log = [], updates = [], root = path.resolve(__dirname, '../plugin');
  let config, discovered = 0, prepared = 0, closed = 0, destroyed = 0, releaseDiscovery;
  const ui = { canvas: {}, bindSession() {}, update(value) { updates.push(value); }, destroy() { destroyed++; } };
  const session = {
    loadSelected(options) { log.push({ type: 'selected', options }); return Promise.resolve(); },
    libraryChanged() { log.push({ type: 'library' }); return Promise.resolve(); },
    close() { closed++; return Promise.resolve(); }
  };
  const adapter = { discoverTools() { discovered++; return new Promise(resolve => { releaseDiscovery = resolve; }); } };
  const modules = {
    'cache.cjs': { createCache(options) { assert.strictEqual(options.pluginRoot, root); return {}; } },
    'eagle.cjs': { createEagleAdapter() { return adapter; } },
    'session.cjs': { createSession(options) { config = options; return session; } },
    'media.cjs': { createMedia(options) { assert.strictEqual(options.tools.ffmpeg, 'existing-only'); return { prepare(snapshot, settings) { prepared++; assert.strictEqual(snapshot.id, 'fixed'); return { snapshot, settings }; } }; } },
    'frame-index.cjs': {}
  };
  const eagle = Object.fromEntries(['onPluginCreate', 'onPluginRun', 'onLibraryChanged', 'onPluginBeforeExit'].map(name => [name, callback => { hooks[name] = callback; }]));
  const win = { EVAUI: { createUI: () => ui }, EVAPlayer: { Player: function (options) { this.options = options; } }, addEventListener(type, fn) { hooks[type] = fn; } };
  vm.runInNewContext(code, { window: win, eagle, performance: { now: () => 100 }, require(name) {
    if (name === 'path') return path; if (name === 'fs') return { realpathSync: file => file };
    assert.strictEqual(path.dirname(name), root); assert(modules[path.basename(name)], name); return modules[path.basename(name)];
  }, Promise });
  await hooks.onPluginCreate({ path: root });
  assert.strictEqual(log[0].type, 'selected'); assert.strictEqual(log[0].options.startedAt, 100);
  assert.strictEqual(discovered, 0, 'Selection must not wait for tools');
  const signal = new AbortController().signal, pending = config.media.prepare({ id: 'fixed' }, { signal });
  await Promise.resolve(); assert.strictEqual(discovered, 1); assert.strictEqual(prepared, 0);
  releaseDiscovery({ ffmpeg: 'existing-only' }); await pending; assert.strictEqual(prepared, 1);
  await config.media.prepare({ id: 'fixed' }, { signal }); assert.strictEqual(discovered, 1);
  const player = config.createPlayer({ experimentMode: 'compressed-ram' });
  assert.strictEqual(player.options.canvas, ui.canvas); assert.strictEqual(player.options.experimentMode, 'compressed-ram');
  await hooks.onPluginCreate({ path: root }); assert.strictEqual(log.length, 1);
  await hooks.onPluginRun(); assert.strictEqual(log[1].options.trigger, 'plugin-run');
  await hooks.onLibraryChanged(); assert.strictEqual(log[2].type, 'library');
  await hooks.onPluginBeforeExit(); hooks.pagehide(); assert.strictEqual(closed, 1); assert.strictEqual(destroyed, 1);
  await hooks.onPluginRun(); assert.strictEqual(log.length, 3); assert.strictEqual(updates.length, 0);
  console.log('T1 app: lifecycle/selected-entry/tool-discovery/assembly/close simulation passed; Eagle not executed.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
