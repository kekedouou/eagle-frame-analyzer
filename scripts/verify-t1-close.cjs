'use strict';
// Explicit side-effecting regression, never part of the default check.
// Real registered media/cache + a nonawaiting Eagle/DOM-close model.
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto'), assert = require('assert');
const { createCache } = require('../plugin/cache.cjs');
const { createStore } = require('../tests/support/t1-evidence.cjs');
const repo = path.resolve(__dirname, '..'), root = path.join(repo, 'plugin');
const code = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json'), 'utf8'));
const input = config.sources.find(value => value.key === 'h264-cfr');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function source() { const before = fs.statSync(input.file), data = fs.readFileSync(input.file), after = fs.statSync(input.file);
  assert.strictEqual(before.size, after.size); assert.strictEqual(before.mtimeMs, after.mtimeMs);
  return { sha256: sha(data), size: after.size, mtimeMs: after.mtimeMs, ino: after.ino, dev: after.dev }; }
function snapshot() {
  const dir = path.join(root, 'cache'), entries = fs.readdirSync(dir).sort();
  return { transient: entries.filter(name => /^(writer\.lock|partial-|lease-)/.test(name)), complete: entries.filter(name => name.startsWith('media-')).map(name => {
    const p = path.join(dir, name), files = fs.readdirSync(p).sort(), digest = crypto.createHash('sha256');
    for (const file of files) { const stat = fs.lstatSync(path.join(p, file)); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
      digest.update(JSON.stringify([file, stat.ino, stat.dev, stat.size, stat.mtimeMs]) + '\n'); }
    return { name, files: files.length, statsSha256: digest.digest('hex'), manifestSha256: sha(fs.readFileSync(path.join(p, 'manifest.json'))),
      ownerSha256: sha(fs.readFileSync(path.join(p, 'owner.json'))) };
  }) };
}
async function bounded(pending) {
  let timer; try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Close regression exceeded 30s; not passed.')), 30000); })]); }
  finally { clearTimeout(timer); }
}
async function run(mode, result) {
  const cache = createCache({ pluginRoot: root }), hooks = {}, states = [], blocks = [];
  let currentSession, closeTriggered = false, destroyed = false, attempts = 0, resolveClosed, releaseDispose, loadFrame;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const dispose = new Promise(resolve => { releaseDispose = resolve; });
  Object.assign(result, { mode, sourceBefore: source(), before: snapshot(), startedAt: new Date().toISOString() });
  assert.strictEqual(result.sourceBefore.sha256, input.sha256); assert.strictEqual(result.before.transient.length, 0);
  const capability = { ...cache, async begin(settings) {
    const tx = await cache.begin(settings);
    return mode === 'complete-held-lease' ? tx : { ...tx, readComplete: () => null };
  } };
  function nativeClose() {
    attempts++; if (hooks.onPluginBeforeExit) hooks.onPluginBeforeExit(); // No await, exactly the missed host behavior.
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    hooks.beforeunload(event); blocks.push(event.returnValue === false);
    if (!event.prevented && event.returnValue === undefined) { destroyed = true; hooks.pagehide(); resolveClosed(); }
  }
  const ui = { canvas: {}, bindSession(value) { currentSession = value; }, destroy() {}, update(value) {
    states.push({ state: value.state, stage: value.progress && value.progress.stage, frames: value.progress && value.progress.frames });
    if (closeTriggered || value.state !== 'preparing') return;
    if (mode === 'first-written-frame' && value.progress && value.progress.stage === 'decode' && value.progress.frames >= 1 ||
        mode === 'before-final-validation' && value.progress && value.progress.stage === 'verify') {
      closeTriggered = true; result.closeAtProgress = { ...value.progress }; nativeClose();
    }
  } };
  const eagle = Object.fromEntries(['onPluginCreate', 'onPluginRun', 'onPluginBeforeExit', 'onLibraryChanged'].map(name => [name, fn => { hooks[name] = fn; }]));
  const win = { EVAUI: { createUI: () => ui }, EVAPlayer: { Player: function () {
    this.load = async info => { loadFrame = info.frames[0]; };
    this.snapshot = () => ({ state: 'paused', frameId: loadFrame.id, frameOrdinal: 0, time: 0 });
    this.dispose = () => dispose; for (const name of ['play', 'pause', 'seek', 'step']) this[name] = () => {};
  } }, close: nativeClose, addEventListener(type, fn) { hooks[type] = fn; } };
  vm.runInNewContext(code, { window: win, eagle, performance, Promise, require(name) {
    if (name === path.join(root, 'cache.cjs')) return { createCache: () => capability };
    if (name === path.join(root, 'eagle.cjs')) return { createEagleAdapter: () => ({
      captureSelected: async () => ({ id: 'registered-h264-cfr', itemId: 'registered-h264-cfr', name: 'registered H.264', ext: 'mp4', filePath: input.file }),
      discoverTools: async () => ({ ffmpeg: config.ffmpeg, ffprobe: config.ffprobe })
    }) };
    return require(name);
  } });
  try {
    const loading = hooks.onPluginCreate({ path: root });
    if (mode === 'complete-held-lease') {
      await bounded(loading); assert.strictEqual(currentSession.snapshot().state, 'paused'); nativeClose();
      await new Promise(resolve => setImmediate(resolve));
      result.whileDisposing = snapshot().transient;
      assert(result.whileDisposing.some(name => name.startsWith('lease-'))); assert.strictEqual(destroyed, false);
      releaseDispose();
    }
    await bounded(closed); await bounded(loading);
    assert.deepStrictEqual(blocks, [true, false]); assert.strictEqual(attempts, 2);
    result.after = snapshot(); result.sourceAfter = source(); result.states = states;
    assert.deepStrictEqual(result.after, result.before); assert.deepStrictEqual(result.sourceAfter, result.sourceBefore);
    assert.strictEqual(currentSession.snapshot().state, 'closed'); result.passed = true;
    result.nativeCloseAttempts = attempts; result.closeBlocks = blocks;
    return result;
  } catch (error) { result.passed = false; result.error = error.message; throw error; }
  finally {
    releaseDispose(); if (currentSession) await currentSession.close();
    result.afterCleanup = snapshot(); result.sourceAfterCleanup = source();
  }
}
async function main() {
  const store = createStore(repo), report = { schema: 1, task: 'T1-close', executor: 'Codex', origin: 'local-real-media-nonawaiting-host-model',
    startedAt: new Date().toISOString(), appSha256: sha(Buffer.from(code)), cases: [], limitations: [
      'Real media/cache/process lifecycle; mocked Eagle selection, DOM close, UI and Player. Not a real Eagle window-close test.',
      'Two cases bypass complete reuse and cancel only their own bounded partial. Existing complete caches remain unchanged.',
      'Third case uses a real lease and a controlled asynchronous Player disposal; not real browser image decoder or sound.',
      'Complete preservation uses file stats plus owner/manifest hashes, not every retained asset hash.' ] };
  let error; store.start({ reserveBytes: 256 * 1024 });
  try { for (const mode of ['first-written-frame', 'before-final-validation', 'complete-held-lease']) {
    const result = { mode }; report.cases.push(result); await run(mode, result);
    console.log(JSON.stringify({ mode, passed: result.passed, attempts: result.nativeCloseAttempts, transientAfter: result.after.transient.length }));
  } report.passed = true;
  } catch (failure) { error = failure; report.passed = false; report.error = { message: failure.message, stack: failure.stack }; }
  finally { report.finishedAt = new Date().toISOString(); try { console.log('Evidence: ' + JSON.stringify(store.save('cancel', report))); } finally { store.close(); } }
  if (error) throw error;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
