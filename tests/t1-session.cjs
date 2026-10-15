'use strict';
// Session ownership/ordering in memory; no Eagle, files, tools or media output.
const assert = require('assert');
const path = require('path');
const { createSession } = require('../plugin/session.cjs');
let tests = 0;
async function test(name, body) { await body(); tests++; console.log('ok ' + name); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = () => new Promise(resolve => setImmediate(resolve));
const selected = id => Object.freeze({ id, itemId: id, name: '中文 ' + id, filePath: path.resolve('中文 ' + id + '.mp4'), ext: 'mp4' });
function harness(settings = {}) {
  const h = { selection: selected('A'), calls: 0, prepared: [], released: [], players: [], reads: [], changes: [], events: [], clock: 100 };
  h.makeInfo = value => ({ source: { ...value, file: value.filePath, sha256: 'a'.repeat(64) }, duration: 3,
    frames: [0, 1, 2].map(id => ({ id, time: id, file: String(id) + '.jpg' })), metrics: { reused: false } });
  const eagleAdapter = { captureSelected() { h.calls++; return settings.capture ? settings.capture(h) : h.selection; } };
  const media = { async prepare(value, options) {
    h.prepared.push({ selected: value, options }); h.events.push('prepare-' + value.id);
    return settings.prepare ? settings.prepare(value, options, h) : h.makeInfo(value);
  } };
  const cache = { async readAsset(info, file) { h.reads.push({ info, file }); return Buffer.from('registered asset'); },
    clearOther: settings.clearOther,
    async release(info) { if (settings.release) await settings.release(info, h); h.released.push(info); h.events.push('release-' + info.source.id); } };
  function createPlayer(options) {
    const player = { options, info: null, disposed: false, disposeDone: false,
      value: { state: 'loading', time: 0, frameId: null, frameOrdinal: null },
      change(value) { this.value = { ...this.value, ...value }; options.onChange({ ...this.value }); },
      snapshot() { return { ...this.value }; },
      async load(info) {
        this.info = info; this.change({ state: 'loading' });
        await options.readAsset({ ...info }, info.frames[0].file);
        if (settings.load) await settings.load(this, info, h);
        this.change({ state: 'paused', time: 0, frameId: info.frames[0].id, frameOrdinal: 0 });
      },
      async dispose() {
        this.disposed = true; h.events.push('stop-' + (this.info && this.info.source.id));
        if (settings.dispose) await settings.dispose(this, h);
        this.disposeDone = true; this.change({ state: 'disposed' }); h.events.push('disposed-' + (this.info && this.info.source.id));
      },
      async play() { this.change({ state: 'playing' }); return { status: 'playing' }; },
      async pause() { this.change({ state: 'paused' }); return { status: 'paused' }; },
      async seek(time, options) {
        this.change({ state: 'seeking' }); if (settings.seek) await settings.seek(this, time, options, h);
        const index = Math.max(0, Math.min(2, Math.floor(time))); this.change({ state: 'paused', time: index, frameId: index, frameOrdinal: index });
        return { status: 'drawn', frameId: index };
      },
      async step(delta) { return this.seek(Math.max(0, Math.min(2, this.value.frameOrdinal + delta)), { final: true }); }
    };
    h.players.push(player); return player;
  }
  h.session = createSession({ eagleAdapter, media, cache, createPlayer, now: () => h.clock, memoryPreferences: settings.memoryPreferences,
    onChange(value) { h.changes.push(value); if (settings.onChange) settings.onChange(value, h); } });
  return h;
}
async function main() {
  await test('Closing while cache clearing is pending suppresses its late result', async () => {
    const issued = deferred(), finish = deferred();
    const h = harness({ clearOther() { issued.resolve(); return finish.promise; } });
    await h.session.loadSelected(); const cleaning = h.session.clearOtherCaches(); await issued.promise;
    await h.session.close(); const changes = h.changes.length;
    finish.resolve({ cleared: 1, freedBytes: 123 }); assert.equal((await cleaning).status, 'superseded');
    assert.equal(h.session.snapshot().state, 'closed'); assert.equal(h.changes.length, changes); assert.equal(h.released.length, 1);
  });
  await test('Closing during a seek ignores the old picture result and never restores playback', async () => {
    const gate = deferred(), issued = deferred();
    const h = harness({ seek: async () => { issued.resolve(); await gate.promise; } });
    await h.session.loadSelected(); const locating = h.session.seek(2); await issued.promise;
    await h.session.close(); const changes = h.changes.length; gate.resolve(); await locating;
    assert.equal(h.session.snapshot().state, 'closed'); assert.equal(h.changes.length, changes); assert.equal(h.released.length, 1);
  });
  await test('Manual cache clearing pauses and protects the loaded source rather than a new Eagle selection',async()=>{
    let request;const h=harness({clearOther(value){request=value;return {cleared:2,freedBytes:400};}});
    await h.session.loadSelected();await h.session.seek(2,{final:true});await h.session.toggle();h.selection=selected('B');
    const r=await h.session.clearOtherCaches();assert.equal(request.sourceSha256,'a'.repeat(64));assert.equal(r.cleared,2);
    assert.equal(h.session.snapshot().state,'paused');assert.equal(h.session.snapshot().playback.time,2);assert.equal(h.calls,1);await h.session.close();
    await assert.rejects(()=>h.session.clearOtherCaches(),/等待视频/);
  });
  await test('Ready metrics separate media preparation and Player initialization without changing the readiness boundary',async()=>{
    const h=harness({prepare(value,_options,model){model.clock+=20;return {...model.makeInfo(value),metrics:{reused:true,phaseMs:{existingCacheValidationMs:12}}};},
      load(_p,_info,model){model.clock+=30;}});
    const r=await h.session.loadSelected({startedAt:100});const m=r.snapshot.loadMetrics;
    assert.equal(m.totalMs,50);assert.equal(m.mediaPrepareMs,20);assert.equal(m.playerLoadMs,30);
    assert.deepEqual(m.mediaPhaseMs,{existingCacheValidationMs:12});assert(m.reused);await h.session.close();
  });
  await test('RAM apply pins current source/position, pauses, persists and disposes before replacement', async () => {
    let ramMiB = 1024, saves = 0;
    const h = harness({ memoryPreferences: { snapshot: () => ({ ramMiB }), preview(value) { if (!(value > 0)) throw new Error('invalid tier'); },
      save(value) { ramMiB = value; saves++; } } });
    await h.session.loadSelected(); await h.session.seek(2, { final: true }); await h.session.toggle();
    const source = h.session.snapshot().source.id; h.selection = selected('B');
    const result = await h.session.setMemoryMiB(2048);
    assert.equal(result.status, 'ready'); assert.equal(saves, 1); assert.equal(ramMiB, 2048);
    assert.equal(h.session.snapshot().source.id, source); assert.equal(h.session.snapshot().playback.time, 2);
    assert.equal(h.session.snapshot().state, 'paused'); assert.equal(h.players.length, 2); assert.equal(h.calls, 1);
    await h.session.close();
  });
  await test('Invalid RAM tier or failed persistence cannot invalidate the current video', async () => {
    const h = harness({ memoryPreferences: { snapshot: () => ({ ramMiB: 1024 }), preview(value) { if (!(value > 0)) throw new Error('invalid tier'); },
      save() { throw new Error('disk refused'); } } });
    await h.session.loadSelected(); await h.session.seek(2, { final: true });
    await assert.rejects(() => h.session.setMemoryMiB(0), /invalid tier/);
    await assert.rejects(() => h.session.setMemoryMiB(2048), /disk refused/);
    assert.equal(h.players.length, 1); assert.equal(h.session.snapshot().playback.time, 2);
    await h.session.close();
  });
  for (const action of ['switch', 'close']) await test('RAM apply waits old disposal and cannot override a later ' + action, async () => {
    const gate = deferred(); let disposed = 0;
    const h = harness({ memoryPreferences: { snapshot: () => ({}), preview() {}, save() {} },
      async dispose() { if (!disposed++) await gate.promise; } });
    await h.session.loadSelected(); const apply = h.session.setMemoryMiB(2048); await flush();
    assert.equal(h.players.length, 1); assert(h.players[0].disposed); assert.equal(h.released.length, 0);
    h.selection = selected('B'); const next = action === 'switch' ? h.session.loadSelected() : h.session.close();
    await flush(); assert.equal(h.players.length, 1); gate.resolve(); await Promise.all([apply, next]);
    assert.equal(h.session.snapshot().state, action === 'switch' ? 'paused' : 'closed');
    if (action === 'switch') { assert.equal(h.session.snapshot().source.id, 'B'); await h.session.close(); }
  });
  await test('Insufficient RAM load can be retried at the original displayed position', async () => {
    let reject = true;
    const h = harness({ memoryPreferences: { snapshot: () => ({}), preview() {}, save() {} },
      load: async (_p, _info, model) => { if (model.players.length === 2 && reject) throw new Error('RAM insufficient'); } });
    await h.session.loadSelected(); await h.session.seek(2, { final: true });
    assert.equal((await h.session.setMemoryMiB(512)).status, 'error');
    reject = false; assert.equal((await h.session.setMemoryMiB(2048)).status, 'ready');
    assert.equal(h.session.snapshot().playback.time, 2); assert.equal(h.session.snapshot().state, 'paused');
    await h.session.close();
  });
  await test('A selection made synchronously during RAM notification wins over the retained source', async () => {
    let ramMiB = 1024, switching = null;
    const h = harness({ memoryPreferences: { snapshot: () => ({ ramMiB }), preview() {}, save(v) { ramMiB = v; } },
      onChange(value, model) { if (ramMiB === 2048 && !switching && value.state === 'paused') {
        switching = true; model.selection = selected('B'); switching = model.session.loadSelected();
      } } });
    await h.session.loadSelected(); assert.equal((await h.session.setMemoryMiB(2048)).status, 'superseded');
    await switching; assert.equal(h.session.snapshot().source.id, 'B'); await h.session.close();
  });
  await test('Read-only snapshots follow completed background work without UI notifications', async () => {
    const h = harness(); await h.session.loadSelected(); const player = h.players[0];
    player.change({ activeImageTasks: 1, cacheBytes: 100, rafOpportunity: 20 });
    const observed = h.session.snapshot(), changes = h.changes.length;
    player.value = { ...player.value, activeImageTasks: 0, cacheBytes: 80, rafOpportunity: 23 };
    const current = h.session.snapshot();
    assert.strictEqual(observed.playback.activeImageTasks, 1);
    assert.strictEqual(current.playback.activeImageTasks, 0);
    assert.strictEqual(current.playback.cacheBytes, 80); assert.strictEqual(current.playback.rafOpportunity, 23);
    assert.strictEqual(h.changes.length, changes, 'Observation must not notify or draw UI');
    await h.session.close(); assert.strictEqual(h.session.snapshot().playback, null);
  });
  await test('A changing or closing session never borrows the old player live snapshot', async () => {
    const gate = deferred(), h = harness({ capture: value => value.calls === 2 ? gate.promise : value.selection });
    await h.session.loadSelected(); const old = h.players[0]; old.value = { ...old.value, activeImageTasks: 1 };
    const loading = h.session.loadSelected(); assert.strictEqual(h.session.snapshot().playback, null);
    gate.resolve(selected('B')); await loading;
    old.value = { ...old.value, activeImageTasks: 99, frameId: 99 };
    assert.strictEqual(h.session.snapshot().playback.frameId, 0); await h.session.close();
  });
  await test('Selection starts once at entry; load uses adopted mode and original cache handle', async () => {
    const h = harness(); const pending = h.session.loadSelected({ startedAt: 10 });
    assert.strictEqual(h.calls, 1); assert.strictEqual(h.session.snapshot().state, 'preparing');
    assert.strictEqual((await pending).status, 'ready'); const state = h.session.snapshot();
    assert.strictEqual(state.state, 'paused'); assert.strictEqual(state.playback.frame, 0); assert.strictEqual(state.sourceIdentity.itemId, 'A');
    assert.strictEqual(state.loadMetrics.totalMs, 90); assert.strictEqual(h.players[0].options.experimentMode, 'compressed-ram');
    assert.strictEqual(h.reads[0].info, h.players[0].info); assert(Object.isFrozen(state.source));
    assert(h.changes.filter(value => value.playback && value.playback.frameId === 0).slice(0, -1).every(value => value.state === 'preparing'));
    await h.session.close(); assert.strictEqual(h.released.length, 1);
  });
  await test('Cancelled slow selection does not block latest invocation or become old media', async () => {
    const old = deferred(); const h = harness({ capture: value => value.calls === 1 ? old.promise : value.selection });
    const first = h.session.loadSelected(); await flush(); h.selection = selected('B'); const second = h.session.loadSelected();
    assert.strictEqual(h.calls, 2); assert.strictEqual((await first).status, 'superseded'); assert.strictEqual((await second).status, 'ready');
    old.resolve(selected('A')); await flush(); assert.deepStrictEqual(h.prepared.map(value => value.selected.id), ['B']);
    assert.strictEqual(h.session.snapshot().source.id, 'B'); await h.session.close();
  });
  await test('Switch aborts preparation but waits its real exit and releases before new preparation', async () => {
    const old = deferred(); const h = harness({ prepare: async (value, options, state) => value.id === 'A' ? old.promise : state.makeInfo(value) });
    const first = h.session.loadSelected(); await flush(); h.selection = selected('B'); const second = h.session.loadSelected();
    assert.strictEqual(h.prepared[0].options.signal.aborted, true); assert.strictEqual(h.prepared.length, 1);
    old.resolve(h.makeInfo(selected('A'))); await first; await second;
    assert(h.events.indexOf('release-A') < h.events.indexOf('prepare-B')); assert.strictEqual(h.released[0].source.id, 'A'); await h.session.close();
  });
  await test('Switch stops player synchronously and holds lease through real load and dispose completion', async () => {
    const loading = deferred(), disposing = deferred();
    const h = harness({ load: (player, info) => info.source.id === 'A' ? loading.promise : undefined,
      dispose: player => player.info.source.id === 'A' ? disposing.promise : undefined });
    const first = h.session.loadSelected(); await flush(); h.selection = selected('B'); const second = h.session.loadSelected();
    assert.strictEqual(h.players[0].disposed, true); assert.strictEqual(h.released.length, 0); assert.strictEqual(h.prepared.length, 1);
    loading.resolve(); await flush(); assert.strictEqual(h.released.length, 0); disposing.resolve(); await first; await second;
    assert(h.events.indexOf('disposed-A') < h.events.indexOf('release-A')); assert(h.events.indexOf('release-A') < h.events.indexOf('prepare-B'));
    await h.session.close();
  });
  await test('Old player/progress callbacks cannot replace newer source or displayed frame', async () => {
    const h = harness(); await h.session.loadSelected(); const old = h.players[0], progress = h.prepared[0].options.onProgress;
    h.selection = selected('B'); await h.session.loadSelected(); old.options.onChange({ state: 'playing', frameId: 999, time: 999 }); progress({ stage: 'wrong' });
    assert.strictEqual(h.session.snapshot().source.id, 'B'); assert.strictEqual(h.session.snapshot().playback.frame, 0); assert.strictEqual(h.session.snapshot().progress, null);
    await h.session.close();
  });
  await test('Controls enforce ready/seek gates; latest displayed frame drives state', async () => {
    const seek = deferred(), h = harness({ seek: () => seek.promise });
    await assert.rejects(h.session.play(), error => error.code === 'SESSION_NOT_READY'); await h.session.loadSelected();
    await h.session.toggle(); assert.strictEqual(h.session.snapshot().state, 'playing'); await h.session.toggle();
    const pending = h.session.seek(2.9, { kind: 'drag', final: false });
    assert.strictEqual(h.session.snapshot().state, 'seeking'); assert.strictEqual(h.session.snapshot().playback.time, 0);
    await assert.rejects(h.session.play(), error => error.code === 'SESSION_NOT_READY'); seek.resolve(); await pending;
    assert.strictEqual(h.session.snapshot().playback.time, 2); await h.session.step(-1); assert.strictEqual(h.session.snapshot().playback.frame, 1); await h.session.close();
  });
  await test('Library change clears without reading selection; closed session cannot load again', async () => {
    const h = harness(); await h.session.loadSelected(); const old = h.players[0];
    const cleared = h.session.libraryChanged(); assert.strictEqual(old.disposed, true); assert.strictEqual(h.session.snapshot().source, null);
    await cleared; assert.strictEqual(h.calls, 1); assert.strictEqual(h.session.snapshot().libraryEpoch, 1); assert.strictEqual(h.session.snapshot().state, 'empty');
    h.selection = selected('B'); await h.session.retry(); assert.strictEqual(h.calls, 2); await h.session.close(); await h.session.close();
    assert.strictEqual((await h.session.loadSelected()).status, 'ignored'); assert.strictEqual(h.calls, 2); assert.strictEqual(h.session.snapshot().state, 'closed');
  });
  await test('Selection failure preserves typed error and retry captures a fresh selection', async () => {
    const failure = new Error('请单选MP4'); failure.code = 'SELECTION_EMPTY';
    const h = harness({ capture: value => value.calls === 1 ? Promise.reject(failure) : value.selection });
    assert.strictEqual((await h.session.loadSelected()).status, 'error'); assert.strictEqual(h.prepared.length, 0);
    assert.strictEqual(h.session.snapshot().error.code, 'SELECTION_EMPTY'); h.selection = selected('B'); await h.session.retry();
    assert.strictEqual(h.session.snapshot().source.id, 'B'); await h.session.close();
  });
  await test('Prepared source mismatch releases original handle and never creates a player', async () => {
    let prepared; const h = harness({ prepare: (value, options, state) => { prepared = state.makeInfo(selected('wrong')); return prepared; } });
    const result = await h.session.loadSelected(); assert.strictEqual(result.status, 'error'); assert.strictEqual(result.error.code, 'PREPARED_IDENTITY_MISMATCH');
    assert.strictEqual(h.players.length, 0); assert.strictEqual(h.released[0], prepared); await h.session.close();
  });
  await test('Disposal failure retains handle and blocks the next video', async () => {
    const h = harness({ dispose: () => Promise.reject(new Error('decoder still active')) }); await h.session.loadSelected();
    h.selection = selected('B'); const result = await h.session.loadSelected(); assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.error.code, 'SESSION_RELEASE_FAILED'); assert.strictEqual(h.prepared.length, 1); assert.strictEqual(h.released.length, 0);
    assert.strictEqual((await h.session.close()).status, 'error');
  });
  await test('Close during preparation stops immediately and waits before releasing late result', async () => {
    const gate = deferred(), h = harness({ prepare: () => gate.promise }); const pending = h.session.loadSelected(); await flush();
    const close = h.session.close(); assert.strictEqual(h.session.snapshot().state, 'closed'); assert.strictEqual(h.prepared[0].options.signal.aborted, true);
    assert.strictEqual(h.released.length, 0); gate.resolve(h.makeInfo(selected('A'))); await pending; await close;
    assert.strictEqual(h.players.length, 0); assert.strictEqual(h.released.length, 1); assert.strictEqual(h.session.snapshot().state, 'closed');
  });
  await test('Display cannot become interactive before actual player load resolves', async () => {
    const gate = deferred(); const h = harness({ load: async player => { player.change({ state: 'paused', time: 0, frameId: 0, frameOrdinal: 0 }); await gate.promise; } });
    const load = h.session.loadSelected(); await flush(); assert.strictEqual(h.session.snapshot().state, 'preparing');
    await assert.rejects(h.session.play(), error => error.code === 'SESSION_NOT_READY'); gate.resolve(); await load;
    assert.strictEqual(h.session.snapshot().state, 'paused'); await h.session.close();
  });
  await test('P03 includes final synchronous ready UI initialization before recording endpoint', async () => {
    let readyCalls = 0;
    const h = harness({ onChange: (value, state) => { if (value.state === 'paused') { readyCalls++; state.clock += 25; } } });
    const result = await h.session.loadSelected({ startedAt: 10 });
    assert.strictEqual(readyCalls, 1); assert.strictEqual(result.snapshot.loadMetrics.readyAt, 125);
    assert.strictEqual(h.session.snapshot().loadMetrics.totalMs, 115); await h.session.close();
  });
  await test('Reentrant latest load cannot be disposed by an older queued invocation', async () => {
    let switched = false;
    const h = harness({ onChange: (value, state) => {
      if (!switched && value.state === 'preparing') { switched = true; state.selection = selected('B'); state.newLoad = state.session.loadSelected(); }
    } });
    const old = h.session.loadSelected(); await old; await h.newLoad;
    assert.deepStrictEqual(h.prepared.map(value => value.selected.id), ['B']);
    assert.strictEqual(h.players[0].disposed, false); await h.session.play(); await h.session.close();
  });
  await test('Library-change notification can load a new source without stale cleanup disposing it', async () => {
    let switched = false;
    const h = harness({ onChange: (value, state) => {
      if (!switched && value.state === 'empty' && value.libraryEpoch === 1) {
        switched = true; state.selection = selected('B'); state.newLoad = state.session.loadSelected();
      }
    } });
    await h.session.loadSelected(); const cleared = h.session.libraryChanged(); await cleared; await h.newLoad;
    assert.strictEqual(h.session.snapshot().source.id, 'B'); assert.strictEqual(h.players[1].disposed, false);
    assert.strictEqual(h.released.length, 1); await h.session.close();
  });
  await test('Synchronous selection-side library change cannot restore obsolete preparing state', async () => {
    const h = harness({ capture: state => { state.clear = state.session.libraryChanged(); return selected('A'); } });
    assert.strictEqual((await h.session.loadSelected()).status, 'superseded'); await h.clear;
    assert.strictEqual(h.session.snapshot().state, 'empty'); assert.strictEqual(h.prepared.length, 0);
    assert.strictEqual(h.calls, 1); await h.session.close();
  });
  await test('Cache-release failure prevents new preparation and remains visible on repeated close', async () => {
    const h = harness({ release: () => { throw new Error('lease still held'); } }); await h.session.loadSelected();
    h.selection = selected('B'); const result = await h.session.loadSelected();
    assert.strictEqual(result.error.code, 'SESSION_RELEASE_FAILED'); assert.strictEqual(h.prepared.length, 1);
    assert.strictEqual(h.released.length, 0); assert.strictEqual((await h.session.close()).status, 'error');
    assert.strictEqual((await h.session.close()).status, 'error'); assert.strictEqual(h.session.snapshot().state, 'closed');
  });
  await test('Preparation cleanup failure survives cancellation and prevents false close success', async () => {
    const started = deferred();
    const h = harness({ prepare: (value, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('partial cleanup failed'), { code: 'MEDIA_CLEANUP_FAILED' })), { once: true });
      started.resolve();
    }) });
    const load = h.session.loadSelected(); await started.promise;
    const closed = h.session.close();
    assert.equal((await load).status, 'error');
    assert.equal((await closed).status, 'error');
    assert.equal((await h.session.close()).error.code, 'MEDIA_CLEANUP_FAILED');
  });
  await test('Current-video memory is observable during loading and invalidated before switching or closing', async () => {
    const gate = deferred();
    const h = harness({ load: async player => { player.value.budget = { used: 32, limit: 512 }; await gate.promise; } });
    assert.equal(h.session.memorySnapshot(), null);
    const pending = h.session.loadSelected(); await flush();
    assert.deepStrictEqual(h.session.memorySnapshot(), { used: 32, limit: 512 });
    const copy = h.session.memorySnapshot(); copy.used = 99; assert.equal(h.session.memorySnapshot().used, 32);
    gate.resolve(); await pending;
    const closing = h.session.close(); assert.equal(h.session.memorySnapshot(), null); await closing;
  });
  console.log('T1 session memory tests passed: ' + tests + '. Not real Eagle, media, Canvas or performance verification.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
