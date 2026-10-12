'use strict';
// Pure file/lifecycle models: no generated files, Eagle or media are touched.
const assert = require('assert'), path = require('path'), fs = require('fs'), vm = require('vm');
const { pathToFileURL } = require('url');
const entry = require('../scripts/prepare-t1-host.cjs');
const { install, PREPARE_MS, WORK_MS } = require('./support/t1-launch.cjs');
let count = 0;
function ok(name) { count++; console.log('ok T1 automatic entry: ' + name); }
function fileModel() {
  const root = path.resolve('虚拟项目 有空格'), host = path.join(root, 'tests/host/t1');
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
  const m = fileModel(), result = entry.prepare(m.root, m.io);
  assert(result.bytes <= entry.LIMIT); assert.strictEqual(m.writes.length, 4);
  const html = m.files.get(path.join(m.host, 'index.local.html')).toString();
  const manifest = JSON.parse(m.files.get(path.join(m.host, 'manifest.json')));
  const actual = fs.readFileSync(path.join(__dirname, '../plugin/index.html'), 'utf8');
  assert.strictEqual(html.slice(html.indexOf('<body>'), html.indexOf('  <script')),
    actual.slice(actual.indexOf('<body>'), actual.indexOf('  <script')));
  assert(html.includes(pathToFileURL(path.join(result.plugin, 'app.js')).href + '?t1='));
  assert(html.indexOf('bootstrap.js?t1=') < html.indexOf('plugin/app.js'));
  assert.notStrictEqual(manifest.id, JSON.parse(fs.readFileSync(path.join(__dirname, '../plugin/manifest.json'))).id);
  assert.strictEqual(manifest.main.multiple, false); assert.strictEqual(manifest.main.runAfterInstall, false);
  entry.prepare(m.root, m.io); assert.strictEqual(m.writes.length, 8);
  ok('bounded idempotent entry retains formal body and uses escaped file URLs for Chinese/space paths');
  const source = path.join(m.root, 'plugin/app.js'); m.files.set(source, Buffer.from('changed source'));
  assert.throws(() => entry.verify(m.root, m.io), /重新准备/);
  entry.prepare(m.root, m.io); entry.verify(m.root, m.io);
  ok('changed source stops measurement until known generated entry is prepared again');
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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/t1/bootstrap.js'), 'utf8'), { URL, window: win, document: {}, eagle: {},
    require(name) { return name.endsWith('t1-launch.cjs') ? { install(options) { installed = options; return {}; } } : require(name); } });
  assert.strictEqual(installed.hostRoot, m.host); assert(win.EVAT1Automatic);
  installed = null;
  const eagleUrl = pathToFileURL(path.join(m.host, 'index.local.html')).href.replace('file://', 'eagleplugin://EVAT1AUTO20261012/') + '?theme=DARK&locale=zh_CN#test';
  const eagleWin = { location: { href: eagleUrl } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/t1/bootstrap.js'), 'utf8'), { URL, window: eagleWin, document: {}, eagle: {},
    require(name) { return name.endsWith('t1-launch.cjs') ? { install(options) { installed = options; return {}; } } : require(name); } });
  assert.strictEqual(installed.hostRoot, m.host); assert.strictEqual(installed.entryScheme, 'eagleplugin:'); assert(eagleWin.EVAT1Automatic);
  ok('Windows Eagle main-process eagleplugin URL reaches the test launcher with Chinese/space paths');
  for (const address of ['https://invalid.test', 'eagleplugin://id/remote/path']) {
    const failedWin = { location: { href: address } }, nodes = { error: { hidden: true }, status: {}, notice: {} };
    let registered = false; const sdk = { onPluginCreate() { registered = true; } }, original = sdk.onPluginCreate;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/t1/bootstrap.js'), 'utf8'),
      { URL, window: failedWin, document: { getElementById: id => nodes[id] }, eagle: sdk, require });
    sdk.onPluginCreate(() => { throw new Error('product must not start'); });
    assert.strictEqual(registered, false); assert.strictEqual(sdk.onPluginCreate, original);
    assert(!failedWin.EVAT1Automatic); assert.strictEqual(nodes.error.hidden, false); assert(/未开始测量/.test(nodes.error.textContent));
  }
  ok('remote/invalid addresses visibly fail and block product startup against the test directory');
  const missing = { location: { href: eagleUrl } }, missingNodes = { error: { hidden: true } };
  let wronglyRegistered = false;
  const missingSdk = { onPluginCreate() { wronglyRegistered = true; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/t1/bootstrap.js'), 'utf8'),
    { URL, window: missing, document: { getElementById: id => missingNodes[id] }, eagle: missingSdk,
      require(name) { if (name.endsWith('t1-launch.cjs')) throw new Error('controlled launcher module failure'); return require(name); } });
  missingSdk.onPluginCreate(() => {}); assert.strictEqual(wronglyRegistered, false);
  assert(/launcher module failure/.test(missingNodes.error.textContent));
  ok('launcher module failure preserves the original error without secondary product module loading');
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function launchModel(settings = {}) {
  const listeners = new Map(), timers = new Map(), saved = [], nodes = { status: { hidden: false }, error: { hidden: true } };
  const host = path.resolve('虚拟项目 有空格/tests/host/t1'), plugin = path.resolve(host, '../../../plugin');
  let sdkCallback, verificationCalls = 0, preparedCalls = 0, driverCalls = 0, stopCalls = 0, closes = 0, clock = 10, timerId = 0, storeCloses = 0;
  const jobDone = deferred();
  const win = { performance: { now: () => clock },
    addEventListener(type, cb) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(cb); },
    removeEventListener(type, cb) { if (listeners.has(type)) listeners.get(type).delete(cb); },
    setTimeout(cb, ms) { timers.set(++timerId, { cb, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); }, close() { closes++; },
    EVADiagnostics: { snapshot: () => settings.snapshot || { state: 'paused', loadMetrics: { entryAt: 12, readyAt: 112, totalMs: 100, reused: true } } } };
  const register = callback => { sdkCallback = callback; }, eagle = { onPluginCreate: register };
  const doc = { title: '', getElementById: id => nodes[id] || null };
  const options = { window: win, document: doc, eagle, hostRoot: host,
    verify() { verificationCalls++; clock += 2; if (settings.invalidEntry) throw new Error('Entry source changed');
      return { host, plugin, marker: { sourceHashes: { 'plugin/app.js': 'a'.repeat(64) } } }; },
    run(args) { driverCalls++; options.lastDriver = args; if (settings.startFailure) throw new Error('controlled driver setup failure');
      return { done: jobDone.promise, cancel() { stopCalls++; }, unsavedEvidence: () => 'retained-driver-evidence' }; },
    createStore() { return { start(value) { assert.strictEqual(value.reserveBytes, 64 * 1024); },
      save(kind, value) { if (settings.saveFailure) throw new Error('controlled evidence full');
        saved.push({ kind, value }); return { file: 'memory-failure' }; }, close() { storeCloses++; } }; }
  };
  let controller;
  if (settings.bootstrap) {
    win.location = { href: pathToFileURL(path.join(host, 'index.local.html')).href.replace('file://', 'eagleplugin://EVAT1AUTO20261012/') + '?theme=DARK&locale=zh_CN' };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'host/t1/bootstrap.js'), 'utf8'), { URL, window: win, document: doc, eagle,
      require(name) { return name.endsWith('t1-launch.cjs') ? { install: input => install({ ...options, ...input }) } : require(name); } });
    controller = win.EVAT1Automatic; assert(controller);
  } else controller = install(options);
  eagle.onPluginCreate(async value => { preparedCalls++; assert.strictEqual(value.path, plugin); assert.strictEqual(value.extra, 'unchanged');
    if (settings.prepare) await settings.prepare.promise; clock += 100; });
  assert.strictEqual(eagle.onPluginCreate, register);
  return { win, doc, nodes, options, controller, timers, saved, host, plugin, jobDone,
    launch: () => sdkCallback({ path: settings.wrongSdkPath ? path.resolve('unrelated') : host, extra: 'unchanged' }),
    fire(ms) { const found = [...timers].find(([, t]) => t.ms === ms); assert(found, 'expected timer ' + ms);
      timers.delete(found[0]); found[1].cb(); },
    unload() { const event = { returnValue: undefined, preventDefault() { this.prevented = true; } };
      for (const cb of [...(listeners.get('beforeunload') || [])]) cb(event); return event; },
    counts: () => ({ verificationCalls, preparedCalls, driverCalls, stopCalls, closes, storeCloses,
      unloadListeners: (listeners.get('beforeunload') || new Set()).size }) };
}
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
async function launchTests() {
  const m = launchModel({ bootstrap: true }), done = m.launch(); await tick();
  assert.strictEqual(m.counts().driverCalls, 1); assert.strictEqual(m.controller.snapshot().state, 'measuring');
  const args = m.options.lastDriver;
  assert.strictEqual(args.bridge, m.win.EVADiagnostics); assert.strictEqual(args.pluginRoot, m.plugin);
  assert.strictEqual(args.launchContext.entryScheme, 'eagleplugin:');
  assert.strictEqual(args.launchContext.callbackToReadyMs, 102); assert.strictEqual(args.launchContext.appEntryToReadyMs, 100);
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
}
(async () => { fileTests(); await launchTests(); console.log('T1 automatic entry: ' + count + ' pure checks passed; no Eagle, media or evidence writes.'); })()
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
