'use strict';
// Pure file/lifecycle models: no generated files, Eagle or media are touched.
const assert = require('assert'), path = require('path'), fs = require('fs'), vm = require('vm');
const { pathToFileURL } = require('url');
const entry = require('../scripts/prepare-window-host.cjs');
const { install, PREPARE_MS, WORK_MS } = require('./support/window-launch.cjs');
let count = 0;
{
  const node = { hidden: true }, doc = { title: '', getElementById: () => node };
  let registered = 0;
  const eagle = { onPluginCreate() { registered++; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/t1/bootstrap.js'), 'utf8'), { document: doc, eagle });
  eagle.onPluginCreate(() => { throw new Error('Legacy entry must not start'); });
  assert.strictEqual(registered, 0); assert.match(node.textContent, /tests\/host\/window/);
  assert.strictEqual(node.hidden, false); assert.match(doc.title, /已迁移/);
  count++;
}
function ok(name) { count++; console.log('ok Window automatic entry: ' + name); }
function fileModel() {
  const root = path.resolve('虚拟项目 有空格'), host = path.join(root, 'tests/host/window');
  const files = new Map(), dirs = new Set([root, path.join(root, 'plugin'), path.join(root, 'tests'), path.join(root, 'tests/host'), host]);
  const links = new Set(), hardlinks = new Set(), writes = [];
  for (const name of entry.SOURCES) files.set(path.join(root, name), Buffer.from('memory source ' + name));
  files.set(path.join(root, 'plugin/index.html'), fs.readFileSync(path.join(__dirname, '../plugin/index.html')));
  files.set(path.join(root, 'plugin/manifest.json'), fs.readFileSync(path.join(__dirname, '../plugin/manifest.json')));
  const io = {
    existsSync: file => files.has(file) || dirs.has(file), realpathSync: file => file,
    lstatSync(file) { const dir = dirs.has(file), data = files.get(file); if (!dir && !data) throw new Error('Missing memory path');
      return { isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => links.has(file), nlink: hardlinks.has(file) ? 2 : 1,
        dev: 1, ino: 1, mtimeMs: 1, size: dir ? 0 : data.length }; },
    readFileSync: file => Buffer.from(files.get(file)),
    writeFileSync(file, bytes, options) { if (options.flag === 'wx' && files.has(file)) throw new Error('EEXIST');
      writes.push(file); files.set(file, Buffer.from(bytes)); }
  };
  return { root, host, files, links, hardlinks, io, writes };
}
function fileTests() {
  {
    const ram = fileModel(), config = { schema: 'T2-ram-host-v1', ramMiB: 1024, compressedMiB: 128 };
    const prepared = entry.prepare(ram.root, ram.io, 'performance', null, config);
    assert.deepStrictEqual(prepared.marker.ramDiagnostic, config);
    assert.throws(() => entry.prepare(ram.root, ram.io, 'resource', null, config));
    assert.throws(() => entry.prepare(ram.root, ram.io, 'performance', null, { ...config, ramMiB: 2048 }));
    assert.throws(() => entry.prepare(ram.root, ram.io, 'performance', null, { ...config, extra: true }));
    const reset = entry.prepare(ram.root, ram.io); assert.strictEqual(reset.marker.ramDiagnostic, undefined);
    const host2={schema:'T2-ram-host-v2',ramMiB:2048,compressedMiB:256,rendererStopMiB:3072};
    assert.deepStrictEqual(entry.prepare(ram.root,ram.io,'performance',null,host2).marker.ramDiagnostic,host2);
    for(const mode of ['resource','annotations','preferences'])assert.throws(()=>entry.prepare(ram.root,ram.io,mode,null,host2));
    for(const patch of [{rendererStopMiB:4096},{rendererStopMiB:1536},{ramMiB:4096},{compressedMiB:128},{extra:true}])assert.throws(()=>entry.prepare(ram.root,ram.io,'performance',null,{...host2,...patch}));
    assert.strictEqual(entry.prepare(ram.root,ram.io).marker.ramDiagnostic,undefined);
    ok('RAM candidate is explicitly bounded, isolated from long/annotation modes and cleared by ordinary preparation');
  }
  {
    const m = fileModel(), p = entry.prepare(m.root, m.io, 'preferences');
    assert.equal(p.marker.mode, 'preferences'); assert.equal(p.marker.ramDiagnostic, undefined);
    assert.equal(p.marker.writeApproval, undefined);
    assert(JSON.parse(m.files.get(path.join(m.host, 'manifest.json'))).name.includes('内存设置'));
    ok('Memory settings observation reuses neutral entry and excludes RAM capture/annotation grant');
  }
  const m = fileModel(), result = entry.prepare(m.root, m.io);
  assert(result.bytes <= entry.LIMIT); assert.strictEqual(m.writes.length, 4);
  const html = m.files.get(path.join(m.host, 'index.local.html')).toString();
  const manifest = JSON.parse(m.files.get(path.join(m.host, 'manifest.json')));
  const actual = fs.readFileSync(path.join(__dirname, '../plugin/index.html'), 'utf8');
  assert.strictEqual(html.slice(html.indexOf('<body>'), html.indexOf('  <script')),
    actual.slice(actual.indexOf('<body>'), actual.indexOf('  <script')));
  assert(html.includes(pathToFileURL(path.join(result.plugin, 'app.js')).href + '?verify='));
  assert(html.indexOf('bootstrap.js?verify=') < html.indexOf('plugin/app.js'));
  assert.notStrictEqual(manifest.id, JSON.parse(fs.readFileSync(path.join(__dirname, '../plugin/manifest.json'))).id);
  assert.notStrictEqual(manifest.id, 'EVAT1AUTO20261012', 'new entry must not collide with retained legacy registration');
  assert.strictEqual(manifest.main.multiple, false); assert.strictEqual(manifest.main.runAfterInstall, false);
  entry.prepare(m.root, m.io); assert.strictEqual(m.writes.length, 8);
  const id = manifest.id;
  entry.prepare(m.root, m.io, 'resource');
  assert.strictEqual(entry.verify(m.root, m.io).marker.mode, 'resource');
  assert.strictEqual(JSON.parse(m.files.get(path.join(m.host, 'manifest.json'))).id, id);
  entry.prepare(m.root, m.io, 'performance');
  entry.prepare(m.root, m.io, 'annotations');
  const annotationEntry = entry.verify(m.root, m.io);
  assert.strictEqual(annotationEntry.marker.mode, 'annotations'); assert.strictEqual(annotationEntry.marker.writeApproval, null);
  assert.match(JSON.parse(m.files.get(path.join(m.host, 'manifest.json'))).name, /T3/);
  assert.match(m.files.get(path.join(m.host, 'index.local.html')).toString(), /<title>T3 标注验收/);
  assert.strictEqual(JSON.parse(m.files.get(path.join(m.host, 'manifest.json'))).id, id);
  entry.prepare(m.root, m.io, 'performance');
  const ram2 = { schema: 'T2-ram-host-v2', ramMiB: 2048, compressedMiB: 256, rendererStopMiB: 3072 };
  entry.prepare(m.root, m.io, 'reuse', null, ram2);
  assert.equal(entry.verify(m.root, m.io).marker.mode, 'reuse');
  assert.throws(() => entry.prepare(m.root, m.io, 'reuse'), /approved 2GiB/);
  assert.throws(() => entry.prepare(m.root, m.io, 'reuse', null, { schema: 'T2-ram-host-v1', ramMiB: 1024, compressedMiB: 128 }), /approved 2GiB/);
  entry.prepare(m.root, m.io, 'window-checks');
  assert.match(JSON.parse(m.files.get(path.join(m.host, 'manifest.json'))).name, /T2 窗口验收/);
  assert.equal(entry.verify(m.root, m.io).marker.ramDiagnostic, undefined);
  assert.throws(() => entry.prepare(m.root, m.io, 'window-checks', null, ram2), /bounded performance/);
  entry.prepare(m.root, m.io, 'performance');
  ok('bounded idempotent entry retains formal body and uses escaped file URLs for Chinese/space paths');
  const source = path.join(m.root, 'plugin/app.js'); m.files.set(source, Buffer.from('changed source'));
  assert.throws(() => entry.verify(m.root, m.io), /重新准备/);
  entry.prepare(m.root, m.io); entry.verify(m.root, m.io);
  ok('changed source stops measurement until known generated entry is prepared again');
  const legacy = fileModel(); entry.prepare(legacy.root, legacy.io);
  const legacyPath = path.join(legacy.host, 'prepared.local.json'), old = JSON.parse(legacy.files.get(legacyPath));
  delete old.sourceHashes['plugin/process-identity.cjs']; legacy.files.set(legacyPath, Buffer.from(JSON.stringify(old)));
  assert.throws(() => entry.verify(legacy.root, legacy.io), /ownership or file list/);
  entry.prepare(legacy.root, legacy.io); assert(entry.verify(legacy.root, legacy.io).marker.sourceHashes['plugin/process-identity.cjs']);
  ok('known preceding source list can be migrated only by explicit preparation, never accepted for measurement');
  const foreign = fileModel(); foreign.files.set(path.join(foreign.host, 'manifest.json'), Buffer.from('unrelated file'));
  assert.throws(() => entry.prepare(foreign.root, foreign.io)); assert.strictEqual(foreign.writes.length, 0);
  const modified = fileModel(); entry.prepare(modified.root, modified.io);
  modified.files.set(path.join(modified.host, 'manifest.json'), Buffer.from('modified entry'));
  assert.throws(() => entry.prepare(modified.root, modified.io), /changed/); assert.strictEqual(modified.writes.length, 4);
  ok('foreign or modified generated files are refused without overwrite');
  for (const type of ['links', 'hardlinks']) {
    const linked = fileModel(); linked[type].add(path.join(linked.root, 'plugin/app.js'));
    assert.throws(() => entry.prepare(linked.root, linked.io), /single-link/); assert.strictEqual(linked.writes.length, 0);
  }
  const large = fileModel(); large.files.set(path.join(large.root, 'plugin/logo.png'), Buffer.alloc(entry.LIMIT));
  assert.throws(() => entry.prepare(large.root, large.io), /256KiB/); assert.strictEqual(large.writes.length, 0);
  ok('link and capacity guards refuse preparation before any writes');
  let installed = null;
  const win = { location: { href: pathToFileURL(path.join(m.host, 'index.local.html')).href + '?cache=1#test' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/window/bootstrap.js'), 'utf8'), { URL, window: win, document: {}, eagle: {},
    require(name) { return name.endsWith('window-launch.cjs') ? { WINDOW_OBSERVER_VERSION: "eva-window-observer-v5", install(options) { installed = options; return {}; } } : require(name); } });
  assert.strictEqual(installed.hostRoot, m.host); assert(win.EVAWindowAutomatic);
  installed = null;
  const eagleUrl = pathToFileURL(path.join(m.host, 'index.local.html')).href.replace('file://', 'eagleplugin://EVAWINDOWVERIFY20261013/') + '?theme=DARK&locale=zh_CN#test';
  const eagleWin = { location: { href: eagleUrl } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/window/bootstrap.js'), 'utf8'), { URL, window: eagleWin, document: {}, eagle: {},
    require(name) { return name.endsWith('window-launch.cjs') ? { WINDOW_OBSERVER_VERSION: "eva-window-observer-v5", install(options) { installed = options; return {}; } } : require(name); } });
  assert.strictEqual(installed.hostRoot, m.host); assert.strictEqual(installed.entryScheme, 'eagleplugin:'); assert(eagleWin.EVAWindowAutomatic);
  ok('Windows Eagle main-process eagleplugin URL reaches the test launcher with Chinese/space paths');
  for (const address of ['https://invalid.test', 'eagleplugin://id/remote/path']) {
    const failedWin = { location: { href: address } }, nodes = { error: { hidden: true }, status: {}, notice: {} };
    let registered = false; const sdk = { onPluginCreate() { registered = true; } }, original = sdk.onPluginCreate;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/window/bootstrap.js'), 'utf8'),
      { URL, window: failedWin, document: { getElementById: id => nodes[id] }, eagle: sdk, require });
    sdk.onPluginCreate(() => { throw new Error('product must not start'); });
    assert.strictEqual(registered, false); assert.strictEqual(sdk.onPluginCreate, original);
    assert(!failedWin.EVAWindowAutomatic); assert.strictEqual(nodes.error.hidden, false); assert(/未开始测量/.test(nodes.error.textContent));
  }
  ok('remote/invalid addresses visibly fail and block product startup against the test directory');
  const missing = { location: { href: eagleUrl } }, missingNodes = { error: { hidden: true } };
  let wronglyRegistered = false;
  const missingSdk = { onPluginCreate() { wronglyRegistered = true; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/window/bootstrap.js'), 'utf8'),
    { URL, window: missing, document: { getElementById: id => missingNodes[id] }, eagle: missingSdk,
      require(name) { if (name.endsWith('window-launch.cjs')) throw new Error('controlled launcher module failure'); return require(name); } });
  missingSdk.onPluginCreate(() => {}); assert.strictEqual(wronglyRegistered, false);
  assert(/launcher module failure/.test(missingNodes.error.textContent));
  ok('launcher module failure preserves the original error without secondary product module loading');
  const staleNodes = { error: {}, status: {} }, staleSdk = { onPluginCreate() { throw new Error('stale launcher must not register'); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/window/bootstrap.js'), 'utf8'), {
    URL, window: { location: { href: eagleUrl } }, document: { getElementById: id => staleNodes[id] || null }, eagle: staleSdk,
    require(name) { return name.endsWith('window-launch.cjs') ? { WINDOW_OBSERVER_VERSION: 'old', install() { throw new Error('stale install called'); } } : require(name); } });
  staleSdk.onPluginCreate(() => { throw new Error('product must not start'); });
  assert.match(staleNodes.error.textContent, /版本不匹配/);
  ok('Bootstrap rejects stale launcher version visibly without clearing module cache or initializing product');
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function launchModel(settings = {}) {
  const listeners = new Map(), timers = new Map(), saved = [], observers = new Set(), nodes = { status: { hidden: false }, error: { hidden: true } };
  const host = path.resolve('虚拟项目 有空格/tests/host/window'), plugin = path.resolve(host, '../../../plugin');
  let sdkCallback, verificationCalls = 0, preparedCalls = 0, driverCalls = 0, stopCalls = 0, closes = 0, clock = 10, timerId = 0, storeCloses = 0;
  const jobDone = deferred(), mediaReady = deferred();
  const win = { performance: { now: () => clock },
    addEventListener(type, cb) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(cb); },
    removeEventListener(type, cb) { if (listeners.has(type)) listeners.get(type).delete(cb); },
    setTimeout(cb, ms) { timers.set(++timerId, { cb, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); }, close() { closes++; },
    EVADiagnostics: { snapshot: () => settings.snapshot || { state: 'paused', loadMetrics: { entryAt: 12, readyAt: 112, totalMs: 100, reused: true } },
      subscribe(callback) { observers.add(callback); return () => observers.delete(callback); } } };
  let runCallback, sdkExitCallback;
  const register = callback => { sdkCallback = callback; }, eagle = { onPluginCreate: register,
    onPluginRun(callback) { runCallback = callback; }, onLibraryChanged() {}, onPluginBeforeExit(callback) { sdkExitCallback = callback; } };
  const doc = { title: '', getElementById: id => nodes[id] || null };
  const options = { window: win, document: doc, eagle, hostRoot: host,
    verify() { verificationCalls++; clock += 2; if (settings.invalidEntry) throw new Error('Entry source changed');
      return { host, plugin, marker: { mode: settings.mode, sourceHashes: { 'plugin/app.js': 'a'.repeat(64) } } }; },
    run(args) { driverCalls++; options.lastDriver = args; if (settings.startFailure) throw new Error('controlled driver setup failure');
      return { done: jobDone.promise, cancel() { stopCalls++; }, unsavedEvidence: () => 'retained-driver-evidence' }; },
    createStore() { return { start(value) { assert.strictEqual(value.reserveBytes, 64 * 1024); },
      save(kind, value) { if (settings.saveFailure || settings.closeSaveFailure && value.schema === 'window-lifecycle-cleanup-result-v1') throw new Error('controlled evidence full');
        saved.push({ kind, value }); return { file: 'memory-failure' }; }, close() { storeCloses++; } }; }
  };
  let controller;
  if (settings.bootstrap) {
    win.location = { href: pathToFileURL(path.join(host, 'index.local.html')).href.replace('file://', 'eagleplugin://EVAWINDOWVERIFY20261013/') + '?theme=DARK&locale=zh_CN' };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/window/bootstrap.js'), 'utf8'), { URL, window: win, document: doc, eagle,
      require(name) { return name.endsWith('window-launch.cjs') ? { WINDOW_OBSERVER_VERSION: "eva-window-observer-v5", install: input => install({ ...options, ...input }) } : require(name); } });
    controller = win.EVAWindowAutomatic;
    if (settings.expectBootstrapFailure) assert.equal(controller, undefined); else assert(controller);
  } else controller = install(options);
  if (settings.formal) {
    const ui = { canvas: {}, bindSession() {}, update() {}, destroy() {} };
    win.EVAUI = { createUI: () => ui };
    win.EVAPlayer = { Player: function () { return { async load() {},
      snapshot: () => ({ state: 'paused', frameId: 0, frameOrdinal: 0, time: 0, budget: { used: 0, limit: 1024 ** 3 } }),
      async dispose() {}, async play() {}, async pause() {}, async seek() {}, async step() {} }; } };
    const modules = {
      'cache.cjs': { createCache: () => ({ readAsset() {}, release() { return settings.releaseGate ? settings.releaseGate.promise : undefined; } }) },
      'eagle.cjs': { createEagleAdapter: () => ({ captureSelected: () => ({ id: 'selected', filePath: path.join(plugin, '中文 视频.mp4') }),
        discoverTools: () => ({ ffmpeg: 'memory-only' }) }) },
      'media.cjs': { createMedia: () => ({ async prepare(value) { await mediaReady.promise; clock += 100;
        return { source: { ...value, sha256: 'a'.repeat(64) }, duration: 3, frames: [{ id: 0 }], metrics: { reused: true } }; } }) },
      'session.cjs': require('../plugin/session.cjs'), 'diagnostics.cjs': require('../plugin/diagnostics.cjs'), 'frame-index.cjs': {}
    };
    modules['preferences.cjs'] = { createMemoryPreferences: () => ({ snapshot: () => ({ ramBytes: 1024 ** 3, compressedRamBytes: 128 * 1024 ** 2, percent: 2.5 }) }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugin/app.js'), 'utf8'), {
      window: win, eagle, performance: win.performance, Promise, setTimeout: win.setTimeout,
      require(name) { if (name === 'path') return path; if (name === 'fs') return { realpathSync: value => value };
        assert.strictEqual(path.dirname(name), plugin); return modules[path.basename(name)]; }
    });
  } else {
    eagle.onPluginCreate(async value => { preparedCalls++; assert.strictEqual(value.path, plugin); assert.strictEqual(value.extra, 'unchanged');
      if (settings.prepare) await settings.prepare.promise; clock += 100; });
    if (settings.mode === 'window-checks') eagle.onPluginBeforeExit(() => {
      settings.snapshot = { state: 'closed', error: null };
      for (const callback of [...observers]) callback({ type: 'close-result', value: { status: 'closed' } });
      return Promise.resolve({ status: 'closed' });
    });
  }
  assert.strictEqual(eagle.onPluginCreate, register);
  return { win, doc, nodes, options, controller, timers, saved, host, plugin, jobDone, mediaReady,
    runSDK: () => runCallback(),
    exitSDK: () => sdkExitCallback(),
    publish(value) { settings.snapshot = value; for (const callback of [...observers]) callback({ type: 'load-result' }); },
    emit(type, value) { for (const callback of [...observers]) callback({ type, value }); },
    launch: () => sdkCallback({ path: settings.wrongSdkPath ? path.resolve('unrelated') : host, extra: 'unchanged' }),
    fire(ms) { const found = [...timers].find(([, t]) => t.ms === ms); assert(found, 'expected timer ' + ms);
      timers.delete(found[0]); found[1].cb(); },
    unload() { const event = { returnValue: undefined, preventDefault() { this.prevented = true; } };
      for (const cb of [...(listeners.get('beforeunload') || [])]) cb(event); return event; },
    counts: () => ({ verificationCalls, preparedCalls, driverCalls, stopCalls, closes, storeCloses,
      unloadListeners: (listeners.get('beforeunload') || new Set()).size, observers: observers.size }) };
}
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
async function launchTests() {
  const resource = launchModel({ mode: 'resource' }), resourceDone = resource.launch();
  await tick(); await tick();
  assert(resource.doc.title.includes('65') || resource.doc.title.includes('60分钟'));
  resource.fire(require('./support/window-launch.cjs').RESOURCE_MS);
  assert.strictEqual(resource.counts().stopCalls, 1);
  resource.jobDone.resolve({ complete: false, resourceGatePassed: false, cleanupVerified: true, receipts: [] });
  await resourceDone; assert.strictEqual(resource.counts().closes, 0);
  ok('resource mode uses its independent long-run deadline and preserves a failed resource window even after cleanup is confirmed');
  const hostSequence = launchModel({ formal: true }), hostDone = hostSequence.launch();
  // Installed Eagle dispatches create then run without awaiting either callback.
  const runDone = hostSequence.runSDK(); await tick(); await tick();
  assert.strictEqual(hostSequence.controller.snapshot().state, 'preparing', 'Superseded create is not a readiness failure');
  assert.strictEqual(hostSequence.counts().driverCalls, 0);
  hostSequence.mediaReady.resolve(); await runDone; await tick(); await tick();
  assert.strictEqual(hostSequence.counts().driverCalls, 1, 'Wait for the actual formal app/session current run to become ready');
  assert.strictEqual(hostSequence.options.lastDriver.bridge.snapshot().epoch, 2);
  assert.strictEqual(hostSequence.options.lastDriver.bridge.snapshot().loadMetrics.trigger, 'plugin-run');
  assert.strictEqual(hostSequence.options.lastDriver.launchContext.initialCreateResult, 'superseded');
  assert.strictEqual(hostSequence.options.lastDriver.launchContext.readyEpoch, 2);
  assert.strictEqual(hostSequence.options.lastDriver.launchContext.readyTrigger, 'plugin-run');
  hostSequence.jobDone.resolve({ complete: true, earlyRegressionPassed: true, p03: { withinTarget: null } }); await hostDone;
  assert.strictEqual(hostSequence.saved.length, 0); assert.strictEqual(hostSequence.timers.size, 0);
  ok('nonawaiting SDK create/run with actual formal app/session waits for current epoch readiness exactly once');
  const waiting = launchModel({ snapshot: { state: 'preparing', epoch: 2 } }), waitingDone = waiting.launch(); await tick(); await tick();
  waiting.publish({ state: 'paused', epoch: 2 }); await tick();
  assert.strictEqual(waiting.counts().driverCalls, 0, 'Paused notification without readiness timing is not ready');
  waiting.publish({ state: 'paused', epoch: 2, loadMetrics: { readyAt: 112, totalMs: 100, trigger: 'plugin-run' } }); await tick();
  assert.strictEqual(waiting.counts().driverCalls, 1); assert.strictEqual(waiting.counts().observers, 0);
  waiting.jobDone.resolve({ complete: true, earlyRegressionPassed: true, p03: { withinTarget: null } }); await waitingDone;
  ok('waits through paused notification until metrics exist and removes readiness observer before measuring');
  for (const terminal of ['error', 'closed', 'empty']) {
    const failure = launchModel({ snapshot: { state: 'preparing', epoch: 2 } }), failureDone = failure.launch(); await tick(); await tick();
    failure.publish({ state: terminal, epoch: 2, error: terminal === 'error' ? { message: 'controlled media failure' } : null });
    await failureDone; assert.strictEqual(failure.counts().driverCalls, 0); assert.strictEqual(failure.saved.length, 1);
    assert.strictEqual(failure.saved[0].value.context.lastPreparation.state, terminal);
    assert.strictEqual(failure.counts().observers, 0); assert.strictEqual(failure.timers.size, 0);
  }
  ok('actual preparation failure/close/library clear stop waiting and retain diagnostic state without measuring');
  for (const action of ['timeout', 'cancel', 'close']) {
    const pending = launchModel({ snapshot: { state: 'preparing', epoch: 2 } }), pendingDone = pending.launch(); await tick(); await tick();
    if (action === 'timeout') pending.fire(PREPARE_MS);
    else if (action === 'cancel') pending.controller.cancel(); else pending.unload();
    await pendingDone;
    assert.strictEqual(pending.counts().driverCalls, 0); assert.strictEqual(pending.counts().observers, 0);
    assert.strictEqual(pending.timers.size, 0); assert.strictEqual(pending.saved.length, 1);
    pending.publish({ state: 'paused', loadMetrics: { readyAt: 112, totalMs: 100 } }); await tick();
    assert.strictEqual(pending.counts().driverCalls, 0, 'Late ready cannot revive a cancelled measurement');
  }
  ok('readiness deadline/cancel/close clean up observers and late ready cannot restart measurement');
  const never = launchModel({ prepare: deferred() }), neverDone = never.launch(); never.fire(PREPARE_MS); await neverDone;
  assert.strictEqual(never.counts().driverCalls, 0); assert.strictEqual(never.saved.length, 1); assert.strictEqual(never.timers.size, 0);
  ok('preparation deadline settles even when the initial SDK callback never resolves');
  const m = launchModel({ bootstrap: true }), done = m.launch(); await tick();
  assert.strictEqual(m.counts().driverCalls, 1); assert.strictEqual(m.controller.snapshot().state, 'measuring');
  const args = m.options.lastDriver;
  assert.strictEqual(args.bridge, m.win.EVADiagnostics); assert.strictEqual(args.pluginRoot, m.plugin);
  assert.strictEqual(args.launchContext.entryScheme, 'eagleplugin:');
  assert.strictEqual(args.launchContext.callbackToReadyMs, 112 - args.launchContext.sdkCallbackAt); assert.strictEqual(args.launchContext.appEntryToReadyMs, 100);
  assert.strictEqual(args.launchContext.sdkPluginRoot, m.host); args.verifyLaunch();
  assert.strictEqual(m.launch(), done); // Duplicate SDK create cannot start another measurement.
  m.jobDone.resolve({ complete: true, earlyRegressionPassed: true, p03: { withinTarget: null }, receipts: ['summary'] });
  await done; assert.strictEqual(m.controller.snapshot().state, 'saved'); assert.strictEqual(m.saved.length, 0);
  assert.strictEqual(m.timers.size, 0); assert.strictEqual(m.counts().unloadListeners, 0);
  ok('one real SDK callback maps path only and automatically measures after actual ready with distinct timing boundaries');
  for (const settings of [{ invalidEntry: true }, { wrongSdkPath: true }, { snapshot: { state: 'error', error: { message: 'bad selection' } } }]) {
    const bad = launchModel(settings); const result = await bad.launch();
    assert.strictEqual(result.complete, false); assert.strictEqual(bad.counts().driverCalls, 0);
    assert.strictEqual(bad.saved.length, settings.snapshot ? 1 : 0); assert.strictEqual(bad.timers.size, 0);
    if (!settings.snapshot) assert.strictEqual(bad.counts().preparedCalls, 0);
  }
  ok('invalid entry/directory or failed ready cannot start measurements or claim pass');
  const early = launchModel({ startFailure: true }); await early.launch();
  assert.strictEqual(early.saved.length, 1); assert.strictEqual(early.counts().storeCloses, 1);
  assert.strictEqual(early.saved[0].value.complete, false);
  const full = launchModel({ startFailure: true, saveFailure: true }); await full.launch();
  assert(/回执未保存/.test(full.nodes.error.textContent)); assert.strictEqual(full.counts().storeCloses, 1);
  ok('pre-driver failures save one bounded failure or visibly report persistence failure and release store');
  const broken = launchModel(); const failed = broken.launch(); await tick();
  broken.jobDone.reject(new Error('driver receipt failure')); await failed;
  assert.strictEqual(broken.saved.length, 0); assert.strictEqual(broken.controller.unsavedEvidence(), 'retained-driver-evidence');
  assert.strictEqual(broken.controller.snapshot().state, 'failed'); assert.strictEqual(broken.timers.size, 0);
  ok('driver save failure is never retried or replaced by a launcher success receipt');
  const closing = launchModel(); const closed = closing.launch(); await tick();
  assert.strictEqual(closing.unload().returnValue, false); closing.unload(); assert.strictEqual(closing.counts().closes, 0);
  closing.jobDone.resolve({ complete: false, earlyRegressionPassed: false, p03: {}, receipts: ['cancel-failure'] });
  await closed; await tick(); assert.strictEqual([...closing.timers.values()].filter(t => t.ms === 0).length, 1);
  closing.fire(0); assert.strictEqual(closing.counts().closes, 1); assert.strictEqual(closing.unload().returnValue, undefined);
  ok('close cancels and preserves driver completion before one next-task native close');
  const slowPrepare = deferred(), preparing = launchModel({ prepare: slowPrepare }); const prepared = preparing.launch();
  preparing.fire(PREPARE_MS); assert.strictEqual(preparing.counts().closes, 1);
  slowPrepare.resolve(); await prepared; assert.strictEqual(preparing.counts().driverCalls, 0); assert.strictEqual(preparing.saved.length, 1);
  const overtime = launchModel(); const timed = overtime.launch(); await tick(); overtime.fire(WORK_MS);
  assert.strictEqual(overtime.counts().stopCalls, 1); overtime.jobDone.resolve({ complete: false, earlyRegressionPassed: false, p03: {} }); await timed;
  assert.strictEqual(overtime.controller.snapshot().state, 'failed'); assert.strictEqual(overtime.timers.size, 0);
  ok('bounded preparation and measurement timeout stop work rather than reporting partial pass');
  const gate = launchModel(); const gateDone = gate.launch(); await tick();
  gate.jobDone.resolve({ complete: true, earlyRegressionPassed: true, p03: { withinTarget: false } }); await gateDone;
  assert.strictEqual(gate.nodes.error.hidden, false); assert(/未通过/.test(gate.nodes.error.textContent));
  ok('failed readiness gate remains visible even when all six pointer rounds complete');
  const annotations = launchModel({ mode: 'annotations' }), annotationsDone = annotations.launch(); await tick();
  assert.match(annotations.doc.title, /T3 标注验收/); assert(annotations.timers.size && [...annotations.timers.values()].some(t => t.ms === 20 * 60000));
  assert.strictEqual(annotations.options.lastDriver.launchContext.annotationApproval, null);
  annotations.jobDone.resolve({ complete: true, observationSaved: true, overallT3Accepted: false, receipts: ['T3-model'] }); await annotationsDone;
  assert.match(annotations.nodes.status.textContent, /不代表T3整体验收通过/); assert.strictEqual(annotations.counts().closes, 0);
  ok('T3 uses one neutral entry with explicit read-only mode, short observation deadline and no automatic long workload/close');
  const settingsReady = { state: 'paused', loadMetrics: { entryAt: 12, readyAt: 112, totalMs: 100, reused: true },
    memorySettings: { ramBytes: 1024 ** 3, percent: 2.5, persisted: true },
    playback: { budget: { limit: 1024 ** 3 }, frameId: 0, time: 0 } };
  const memory = launchModel({ mode: 'preferences', snapshot: settingsReady }); await memory.launch();
  assert.equal(memory.counts().driverCalls, 0); assert.equal(memory.timers.size, 0);
  assert.equal(memory.saved.length, 1); assert.equal(memory.saved[0].value.performanceVerified, false);
  assert.equal(memory.saved[0].value.memorySettings.persisted, true); assert.match(memory.doc.title, /内存设置验收/);
  assert.equal(memory.unload().returnValue, undefined);
  const memoryFailed = launchModel({ mode: 'preferences', snapshot: settingsReady, saveFailure: true }); await memoryFailed.launch();
  assert.equal(memoryFailed.saved.length, 0); assert.equal(memoryFailed.counts().storeCloses, 1);
  assert.match(memoryFailed.nodes.error.textContent, /就绪证据未保存/);
  ok('Settings observation records actual configuration without workload and never retries failed evidence writes');
  const windowCheck = launchModel({ mode: 'window-checks', snapshot: settingsReady }); await windowCheck.launch();
  assert.equal(windowCheck.counts().driverCalls, 0); assert.equal(windowCheck.saved[0].value.schema, 'window-lifecycle-ready-v1');
  assert.match(windowCheck.doc.title, /T2 窗口验收/); assert.equal(windowCheck.counts().unloadListeners, 1);
  const savedBeforeUnload = windowCheck.saved.length;
  const unloadEvent = windowCheck.unload();
  assert.equal(unloadEvent.returnValue, false, 'Test close must be blocked before recording starts');
  assert.equal(windowCheck.saved.length, savedBeforeUnload, 'beforeunload must not perform blocking filesystem scans');
  windowCheck.fire(0); await windowCheck.controller.closingDone;
  assert.equal(windowCheck.saved[1].value.schema, 'window-lifecycle-unload-request-v1');
  assert.equal(windowCheck.saved[1].value.state, 'paused'); assert.equal(windowCheck.saved[1].value.nativeWindowDestroyedVerified, false);
  windowCheck.unload(); assert.equal(windowCheck.saved.length, 3);
  assert(!windowCheck.saved.some(x => x.value.schema === 'window-lifecycle-preparation-cancelled-v1'));
  assert.equal(windowCheck.nodes.error.hidden, true);
  ok('Window witness retains one unload observer after readiness, records one request, never claims native destruction or starts workload');
  for (const status of ['closed', 'error']) {
    const settings = { mode: 'window-checks', snapshot: settingsReady };
    const observed = launchModel(settings); await observed.launch(); observed.unload();
    settings.snapshot = { state: 'closed', error: status === 'error' ? { message: 'release failed' } : null };
    assert.equal(observed.saved.filter(x => x.value.schema === 'window-lifecycle-cleanup-result-v1').length, 0);
    observed.emit('close-result', { status, error: settings.snapshot.error });
    assert.equal(observed.saved.length, 1, 'Cleanup notification must only capture memory, not write during SDK exit');
    observed.fire(0); await observed.controller.closingDone.catch(() => {});
    const result = observed.saved.at(-1).value;
    assert.equal(result.schema, 'window-lifecycle-cleanup-result-v1');
    assert.equal(result.sessionCleanupCompleted, status === 'closed'); assert.equal(result.nativeWindowDestroyedVerified, false);
    assert.equal(result.unloadRequestObserved, true);
    const countBefore = observed.saved.length; observed.emit('close-result', { status: 'closed' });
    assert.equal(observed.saved.length, countBefore); assert.equal(observed.counts().observers, 0);
  }
  ok('Close witness waits for actual settled result, preserves errors once, and never treats early closed state as cleanup or native destruction');
  const saveStopped = launchModel({ mode: 'window-checks', snapshot: settingsReady, closeSaveFailure: true }); await saveStopped.launch();
  saveStopped.unload(); saveStopped.emit('close-result', { status: 'closed' });
  saveStopped.fire(0); await saveStopped.controller.closingDone.catch(() => {}); await tick();
  assert.match(saveStopped.nodes.error.textContent, /记录保存失败/); assert.equal(saveStopped.counts().closes, 0);
  assert.equal(saveStopped.unload().returnValue, undefined, 'After formal cleanup succeeds, user may close the visible save-error window without auto-retrying');
  const storesBefore = saveStopped.counts().storeCloses; saveStopped.emit('close-result', { status: 'closed' });
  assert.equal(saveStopped.counts().storeCloses, storesBefore);
  ok('Close result persistence failure is visible and not retried or mislabeled as saved');
  const brokenObservation = launchModel({ mode: 'window-checks', snapshot: settingsReady }); await brokenObservation.launch();
  brokenObservation.win.EVADiagnostics.snapshot = () => { throw new Error('controlled observation failure'); };
  assert.equal((await brokenObservation.exitSDK()).status, 'closed', 'An observer exception cannot suppress the real SDK cleanup callback');
  ok('Failed diagnostic snapshot does not prevent the actual SDK exit callback');
  const releaseGate = deferred(), actualClose = launchModel({ formal: true, mode: 'window-checks', releaseGate });
  const actualReady = actualClose.launch(); actualClose.mediaReady.resolve(); await actualReady;
  assert.equal(actualClose.saved[0].value.schema, 'window-lifecycle-ready-v1');
  actualClose.unload(); await tick(); await tick();
  actualClose.fire(0);
  assert.equal(actualClose.win.EVADiagnostics.snapshot().state, 'closed');
  assert(!actualClose.saved.some(x => x.value.schema === 'window-lifecycle-cleanup-result-v1'));
  assert.equal(actualClose.counts().closes, 0);
  releaseGate.resolve(); await actualClose.controller.closingDone;
  const actualReceipt = actualClose.saved.find(x => x.value.schema === 'window-lifecycle-cleanup-result-v1');
  assert(actualReceipt); assert.equal(actualReceipt.value.sessionCleanupCompleted, true);
  assert.equal(actualReceipt.value.nativeWindowDestroyedVerified, false);
  actualClose.fire(0); assert.equal(actualClose.counts().closes, 1);
  ok('Actual app/session and witness integration cannot save cleanup success or request native exit while cache release is gated');
  const cancelledClose = launchModel({ formal: true, mode: 'window-checks' });
  const cancelledReady = cancelledClose.launch(); await tick(); await tick();
  cancelledClose.unload(); await cancelledReady;
  cancelledClose.fire(0);
  assert(!cancelledClose.saved.some(x => x.value.schema === 'window-lifecycle-cleanup-result-v1'));
  cancelledClose.mediaReady.resolve(); await cancelledClose.controller.closingDone;
  const cancelledReceipt = cancelledClose.saved.find(x => x.value.schema === 'window-lifecycle-cleanup-result-v1');
  assert(cancelledReceipt); assert.equal(cancelledReceipt.value.sessionCleanupCompleted, true);
  assert.equal(cancelledClose.counts().driverCalls, 0);
  assert.equal(cancelledClose.nodes.error.hidden, true, 'Closing preparation is an expected cancellation, not a red test failure');
  assert.equal(cancelledClose.controller.snapshot().state, 'cancelled');
  assert(!cancelledClose.saved.some(x => x.value.schema === 'window-automatic-entry-failure-v1'));
  assert(cancelledClose.saved.some(x => x.value.schema === 'window-lifecycle-preparation-cancelled-v1' && x.value.expected));
  assert(cancelledClose.saved.some(x => x.value.schema === 'window-lifecycle-unload-request-v1' && x.value.state === 'preparing'));
  ok('Actual preparing session records cleanup only after the cancelled media task settles; late media cannot restart playback or measurement');
  const exitFirst = launchModel({ formal: true, mode: 'window-checks' });
  const exitFirstReady = exitFirst.launch(); await tick(); await tick();
  const exitFirstPending = exitFirst.exitSDK(); exitFirst.mediaReady.resolve();
  await exitFirstPending; await exitFirstReady;
  assert.equal(exitFirst.nodes.error.hidden, true, 'The observed Eagle exit-first order must not flash a preparation failure');
  assert.equal(exitFirst.controller.snapshot().state, 'cancelled');
  assert.equal(exitFirst.saved.length, 0, 'SDK exit preceding beforeunload must not acquire an evidence writer in cancellation microtasks');
  assert.equal(exitFirst.counts().storeCloses, 0);
  assert.equal(exitFirst.unload().returnValue, false);
  assert.equal(exitFirst.saved.length, 0); exitFirst.fire(0);
  exitFirst.unload(); assert.equal(exitFirst.saved.length, 0, 'Repeated close stays blocked until the record batch drains');
  await exitFirst.controller.closingDone;
  const exitNotice = exitFirst.saved.find(x => x.value.schema === 'window-lifecycle-unload-request-v1').value;
  assert.equal(exitNotice.state, 'closed'); assert.equal(exitNotice.sdkExitNotice.state, 'preparing');
  assert(exitFirst.saved.some(x => x.value.schema === 'window-lifecycle-cleanup-result-v1' && x.value.sessionCleanupCompleted));
  assert.equal(exitFirst.saved.length, 3); assert.equal(exitFirst.counts().storeCloses, 1);
  assert.equal(exitFirst.counts().closes, 0, 'Final native close is scheduled only after the batch writer has closed');
  assert(!exitFirst.saved.some(x => x.value.schema === 'window-automatic-entry-failure-v1'));
  assert.equal(exitFirst.saved.filter(x => x.value.schema === 'window-lifecycle-preparation-cancelled-v1').length, 1);
  exitFirst.fire(0); assert.equal(exitFirst.counts().closes, 1);
  ok('Actual Eagle exit-IPC-first ordering defers cancellation evidence, captures pre-exit state and drains one batch before final native close');
  const repeatedOpen = launchModel({ formal: true, mode: 'window-checks' });
  const repeatedCreate = repeatedOpen.launch(), repeatedRun = repeatedOpen.runSDK();
  await tick(); await tick();
  assert.equal(repeatedOpen.controller.snapshot().state, 'preparing');
  const repeatedExit = repeatedOpen.exitSDK(); repeatedOpen.mediaReady.resolve();
  await Promise.all([repeatedCreate, repeatedRun, repeatedExit]);
  assert.equal(repeatedOpen.nodes.error.hidden, true);
  assert.equal(repeatedOpen.controller.snapshot().state, 'cancelled');
  repeatedOpen.unload(); repeatedOpen.unload(); repeatedOpen.fire(0);
  await repeatedOpen.controller.closingDone;
  const cancelledObservation = repeatedOpen.saved.find(x => x.value.schema === 'window-lifecycle-preparation-cancelled-v1').value;
  assert.equal(cancelledObservation.context.initialCreateResult, 'superseded');
  assert.equal(cancelledObservation.context.lastPreparation.state, 'closed');
  assert.equal(repeatedOpen.saved.length, 3); assert.equal(repeatedOpen.counts().storeCloses, 1);
  assert.equal(repeatedOpen.counts().driverCalls, 0);
  assert(!repeatedOpen.saved.some(x => x.value.schema === 'window-automatic-entry-failure-v1'));
  ok('Saved real-Eagle create/run-superseded then SDK-close sequence cancels once without flashing an error or restarting measurement');
  const gatePreparation = deferred(), beforeReady = launchModel({ mode: 'window-checks', snapshot: { state: 'preparing', progress: { stage: 'decode' } }, prepare: gatePreparation });
  const preparingDone = beforeReady.launch(); await tick(); beforeReady.unload(); await preparingDone;
  beforeReady.fire(0); await beforeReady.controller.closingDone;
  assert.equal(beforeReady.counts().driverCalls, 0);
  assert(beforeReady.saved.some(item => item.value.schema === 'window-lifecycle-unload-request-v1' && item.value.state === 'preparing'));
  assert(beforeReady.saved.some(item => item.value.schema === 'window-lifecycle-preparation-cancelled-v1' && item.value.expected));
  assert.equal(beforeReady.nodes.error.hidden, true);
  gatePreparation.resolve(); await tick(); assert.equal(beforeReady.counts().driverCalls, 0);
  ok('Manual preparation cancellation records the pre-close stage and retains cancellation separately; late ready cannot restart');
  const genuineFailure = launchModel({ mode: 'window-checks', snapshot: { state: 'preparing' } });
  const genuineDone = genuineFailure.launch(); await tick();
  genuineFailure.publish({ state: 'error', error: { message: 'controlled FFmpeg preparation failure' } });
  await genuineDone;
  assert.equal(genuineFailure.nodes.error.hidden, false);
  assert.match(genuineFailure.nodes.error.textContent, /FFmpeg preparation failure/);
  genuineFailure.unload(); genuineFailure.fire(0); await genuineFailure.controller.closingDone;
  assert.equal(genuineFailure.saved.filter(x => x.value.schema === 'window-automatic-entry-failure-v1').length, 1);
  assert(!genuineFailure.saved.some(x => x.value.schema === 'window-lifecycle-preparation-cancelled-v1'));
  ok('A real preparation failure remains visible and saved even if the user closes afterwards');
  const timeoutGate = deferred(), timedClose = launchModel({ mode: 'window-checks', snapshot: { state: 'preparing' }, prepare: timeoutGate });
  const timedDone = timedClose.launch(); timedClose.fire(PREPARE_MS); await timedDone;
  assert.match(timedClose.nodes.error.textContent, /120秒/);
  timedClose.unload(); timedClose.fire(0); await timedClose.controller.closingDone;
  assert.equal(timedClose.saved.filter(x => x.value.schema === 'window-automatic-entry-failure-v1').length, 1);
  assert(!timedClose.saved.some(x => x.value.schema === 'window-lifecycle-preparation-cancelled-v1'));
  timeoutGate.resolve(); await tick(); assert.equal(timedClose.counts().driverCalls, 0);
  ok('Preparation timeout is not relabeled as an expected close cancellation and late completion cannot start work');
  const startObserved = launchModel({ bootstrap: true, mode: 'window-checks', snapshot: settingsReady });
  assert.equal(startObserved.saved.length, 1); assert.equal(startObserved.saved[0].value.schema, 'window-lifecycle-start-v2');
  assert.equal(startObserved.saved[0].value.sdkCreateObserved, false); assert.equal(startObserved.counts().preparedCalls, 0);
  await startObserved.launch(); assert.equal(startObserved.saved[1].value.schema, 'window-lifecycle-ready-v1');
  startObserved.unload(); startObserved.fire(0); await startObserved.controller.closingDone;
  assert.equal(startObserved.saved[2].value.schema, 'window-lifecycle-unload-request-v1');
  const witness = startObserved.saved[0].value.witnessId;
  assert.match(witness, /^[0-9a-f]{20}$/);
  assert(startObserved.saved.every(x => x.value.witnessId === witness));
  const otherLaunch = launchModel({ bootstrap: true, mode: 'window-checks', snapshot: settingsReady });
  assert.notEqual(otherLaunch.saved[0].value.witnessId, witness, 'Independent windows must not share a witness identity');
  assert.equal(startObserved.counts().driverCalls, 0);
  ok('Real bootstrap model saves window startup before SDK create, then ready/close separately; performance mode adds no startup writes');
  const startFailed = launchModel({ bootstrap: true, mode: 'window-checks', snapshot: settingsReady, saveFailure: true, expectBootstrapFailure: true });
  assert.equal(startFailed.saved.length, 0); assert.equal(startFailed.counts().preparedCalls, 0);
  assert.equal(startFailed.counts().unloadListeners, 0, 'Failed bootstrap must not leave an exit blocker on the empty error window');
  assert.match(startFailed.nodes.error.textContent, /入口启动记录未保存/);
  ok('Window startup persistence failure blocks product initialization visibly rather than proceeding with no evidence');
}
(async () => { fileTests(); let deadline;
  try { await Promise.race([launchTests(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Window entry model tests did not finish within 5 seconds.')), 5000); })]); }
  finally { clearTimeout(deadline); }
  console.log('Window automatic entry: ' + count + ' pure checks passed; no Eagle, media or evidence writes.'); })()
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
