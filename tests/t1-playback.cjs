'use strict';
// Real UI/session/player/index collaboration; only host, media and browser facilities are fake.
// No files, media generation, Eagle, real JPEG/audio decoding or performance measurement.
const assert = require('assert');
const path = require('path');
const { createUI } = require('../plugin/ui.js');
const { createSession } = require('../plugin/session.cjs');
const { Player } = require('../plugin/player.js');
const frameIndex = require('../plugin/frame-index.cjs');
const flush = async () => { for (let n = 0; n < 24; n++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function element(id) {
  const listeners = new Map();
  return { id, style: {}, attributes: {}, offsetWidth: 80, hidden: false, textContent: '',
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { if (listeners.has(type)) listeners.get(type).delete(fn); },
    fire(type, values = {}) { const event = { target: this, pointerId: 1, button: 0, buttons: 1, clientX: 100,
      preventDefault() { this.prevented = true; }, ...values }; for (const fn of listeners.get(type) || []) fn(event); return event; },
    setAttribute(name, value) { this.attributes[name] = value; },
    closest(selector) { return this.attributes.role === 'slider' && selector.includes('[role="slider"]') ? this : null; },
    getBoundingClientRect() { return { left: 100, width: 200 }; },
    focus() {}, setPointerCapture(id) { this.capture = id; }, hasPointerCapture(id) { return this.capture === id; }, releasePointerCapture() { this.capture = null; } };
}
function harness() {
  let clock = 0, serial = 0, selectedId = 'A', selectionCalls = 0;
  const rafs = new Map(), gates = new Map(), contexts = [], players = [], playerChanges = [], bitmaps = [], drawings = [], events = [], released = [], leases = new Set();
  const elements = new Map(), win = element('window'), doc = { getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); } };
  const el = id => doc.getElementById(id), canvas = el('picture');
  canvas.getContext = () => ({ drawImage(bitmap) { drawings.push({ material: bitmap.material, ordinal: bitmap.ordinal }); } });
  const env = { now: () => clock, raf(callback) { const id = ++serial; rafs.set(id, callback); return id; }, caf: id => rafs.delete(id),
    sleep: () => Promise.reject(new Error('No simulated delay is configured.')),
    async decodeImage(bytes) {
      const material = String.fromCharCode(bytes[5]), ordinal = bytes[0], gate = gates.get(material + ':' + ordinal);
      if (gate) { gates.delete(material + ':' + ordinal); await gate.promise; }
      const bitmap = { width: bytes.readUInt16LE(1), height: bytes.readUInt16LE(3), material, ordinal, closed: false, close() { this.closed = true; } };
      bitmaps.push(bitmap); return bitmap;
    },
    createAudioContext() {
      const createdAt = clock, context = { state: 'suspended', sampleRate: 48000, destination: {}, sources: [],
        get currentTime() { return (clock - createdAt) / 1000; },
        getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: clock }; },
        async resume() { this.state = 'running'; }, async close() { this.state = 'closed'; },
        decodeAudioData(array, resolve) {
          const bytes = Buffer.from(array), duration = bytes.readDoubleLE(0), channels = bytes[8];
          const value = { duration, sampleRate: 48000, length: Math.round(duration * 48000), numberOfChannels: channels };
          const promise = Promise.resolve(value); promise.then(resolve); return promise;
        },
        createGain() { return { gain: { setValueAtTime() {} }, connect() {}, disconnect() {} }; },
        createBufferSource() {
          const source = { stopped: false, connect() {}, disconnect() {}, start(when, offset) { this.startPlan = { when, offset }; }, stop() { this.stopped = true; } };
          this.sources.push(source); return source;
        } };
      contexts.push(context); return context;
    } };
  const selected = () => ({ id: selectedId, itemId: selectedId, name: '中文 ' + selectedId + '.mp4', filePath: path.resolve('中文 ' + selectedId + '.mp4'), ext: 'mp4' });
  const media = { async prepare(value) {
    const rows = Array.from({ length: 20 }, (_, id) => ({ id, ptsTicks: String(id), file: 'f' + id + '.jpg', bytes: 10 }));
    const index = frameIndex.buildIndex(rows, { timeBase: [1, 10], lastFrameEndTicks: '20' });
    const info = { source: { ...value, sha256: (value.id === 'A' ? 'a' : 'b').repeat(64) }, width: 4, height: 4,
      duration: index.videoDuration, frames: index.frames, audio: { file: 'audio.wav', start: 0, duration: 2, bytes: 16, sampleRate: 48000, channels: 1 }, metrics: { reused: false } };
    leases.add(info); return info;
  } };
  const cache = { async readAsset(info, file) {
    assert(leases.has(info), 'Session must retain the original cache lease during all player reads.');
    if (file === 'audio.wav') { const bytes = Buffer.alloc(16); bytes.writeDoubleLE(info.audio.duration); bytes[8] = info.audio.channels; return bytes; }
    const bytes = Buffer.alloc(10); bytes[0] = Number(file.slice(1, -4)); bytes.writeUInt16LE(info.width, 1); bytes.writeUInt16LE(info.height, 3); bytes[5] = info.source.id.charCodeAt(0); return bytes;
  }, async release(info) { assert(leases.delete(info)); released.push(info.source.id); } };
  const ui = createUI({ document: doc, window: win, now: env.now });
  el('timeline').setAttribute('role', 'slider'); el('timeline').focus = () => { doc.activeElement = el('timeline'); };
  const session = createSession({ eagleAdapter: { captureSelected() { selectionCalls++; return selected(); } }, media, cache, now: env.now,
    createPlayer(options) { playerChanges.push(options.onChange); const player = new Player({ ...options, canvas, env, frameIndex, emit: event => events.push(event) }); players.push(player); return player; },
    onChange: value => ui.update(value) });
  ui.bindSession(session);
  async function frame() { clock += 16; const pending = Array.from(rafs.values()); rafs.clear(); pending.forEach(fn => fn(clock)); await flush(); }
  async function until(check) { await flush(); for (let n = 0; !check() && n < 100; n++) await frame(); assert(check(), 'Deterministic integration did not reach expected state.'); }
  async function settle(promise) { let done = false, value, error; promise.then(result => { done = true; value = result; }, failure => { done = true; error = failure; }); await until(() => done); if (error) throw error; return value; }
  function space(values = {}) { return win.fire('keydown', { code: 'Space', key: ' ', target: doc.activeElement || win, ...values }); }
  async function close() { await settle(session.close()); ui.destroy(); assert.strictEqual(rafs.size, 0); assert.strictEqual(leases.size, 0);
    assert(players.every(player => player.snapshot().cacheBytes === 0)); assert(contexts.every(context => context.state === 'closed'));
    assert(contexts.every(context => context.sources.every(source => source.stopped))); assert(bitmaps.every(bitmap => bitmap.closed)); }
  return { session, ui, el, win, players, playerChanges, contexts, drawings, events, bitmaps, released, frame, until, settle, space, close,
    gate(material, ordinal) { const gate = deferred(); gates.set(material + ':' + ordinal, gate); return gate; },
    select(id) { selectedId = id; }, selectionCalls: () => selectionCalls };
}
async function run() {
  const passed = [];
  async function check(name, body) { await body(); passed.push(name); console.log('ok ' + name); }
  await check('Real UI/session/player chain: first frame, Space, reverse drag, final hint and focused Space', async () => {
    const h = harness(); assert.strictEqual((await h.settle(h.session.loadSelected())).status, 'ready');
    assert.strictEqual(h.selectionCalls(), 1); assert.strictEqual(h.session.snapshot().state, 'paused');
    assert.deepStrictEqual(h.drawings[h.drawings.length - 1], { material: 'A', ordinal: 0 }); assert.strictEqual(h.el('currentTime').textContent, '0:00.000');
    h.space(); await h.until(() => h.session.snapshot().state === 'playing'); assert(h.contexts[0].sources[0].startPlan);
    h.space({ repeat: true }); assert.strictEqual(h.session.snapshot().state, 'playing');
    h.space(); await h.until(() => h.session.snapshot().state === 'paused'); assert(h.contexts[0].sources[0].stopped);
    h.el('timeline').fire('pointerdown', { clientX: 260 }); h.win.fire('pointermove', { clientX: 140 });
    h.win.fire('pointermove', { clientX: 280 }); h.win.fire('pointerup', { clientX: 150, buttons: 0 });
    await h.until(() => h.session.snapshot().state === 'paused' && h.session.snapshot().playback.frameId === 5);
    assert.deepStrictEqual(h.drawings[h.drawings.length - 1], { material: 'A', ordinal: 5 });
    assert.strictEqual(h.el('currentTime').textContent, '0:00.500'); assert.strictEqual(h.el('timeHint').textContent, '0:00.500'); assert(!h.el('timeHint').hidden);
    assert.strictEqual(h.el('thumb').style.left, '25%'); assert.strictEqual(h.el('timeline').attributes['aria-valuenow'], '0.5');
    h.space(); await h.until(() => h.session.snapshot().state === 'playing'); assert(h.el('timeHint').hidden);
    await h.close(); assert.deepStrictEqual(h.released, ['A']);
  });
  await check('Switch waits real old decode; stale player/audio callbacks cannot overwrite the next material', async () => {
    const h = harness(); await h.settle(h.session.loadSelected()); h.space(); await h.until(() => h.session.snapshot().state === 'playing');
    const oldEnded = h.contexts[0].sources[0].onended, oldChange = h.playerChanges[0], gate = h.gate('A', 15);
    const oldSeek = h.session.seek(1.5, { kind: 'rapid' }); await flush(); assert.strictEqual(h.players[0].snapshot().activeImageTasks, 1);
    h.select('B'); const switching = h.session.loadSelected(); await flush();
    assert.strictEqual(h.session.snapshot().state, 'preparing'); assert(h.contexts[0].sources[0].stopped); assert.strictEqual(h.players.length, 1);
    oldChange({ state: 'playing', time: 99, frameId: 999 }); if (oldEnded) oldEnded();
    assert.strictEqual(h.session.snapshot().state, 'preparing'); assert.strictEqual(h.el('currentTime').textContent, '0:00.000');
    gate.resolve(); assert.strictEqual((await oldSeek).status, 'superseded'); assert.strictEqual((await h.settle(switching)).status, 'ready');
    assert.strictEqual(h.selectionCalls(), 2); assert.deepStrictEqual(h.released, ['A']); assert.strictEqual(h.players[0].snapshot().cacheBytes, 0);
    assert.deepStrictEqual(h.drawings[h.drawings.length - 1], { material: 'B', ordinal: 0 });
    assert(!h.drawings.some(frame => frame.material === 'A' && frame.ordinal === 15));
    oldChange({ state: 'error', time: 88, frameId: 888, lastIssue: 'stale' }); if (oldEnded) oldEnded();
    assert.strictEqual(h.session.snapshot().source.id, 'B'); assert.strictEqual(h.el('sourceName').textContent, '中文 B.mp4');
    assert.strictEqual(h.session.snapshot().state, 'paused'); assert.strictEqual(h.el('currentTime').textContent, '0:00.000');
    h.space(); await h.until(() => h.session.snapshot().state === 'playing'); await h.close(); assert.deepStrictEqual(h.released, ['A', 'B']);
  });
  console.log('T1 real-module playback integration: ' + passed.length + ' in-memory checks; no real Eagle/media/performance acceptance.');
  return { passed, count: passed.length };
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error.stack); process.exitCode = 1; });
