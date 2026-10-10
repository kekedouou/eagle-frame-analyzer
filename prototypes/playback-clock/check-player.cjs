'use strict';
// Local fake dependencies only. This does not load Eagle or prove audio/display performance.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { Player, frameAt, audioStartPlan, Budget, readBarcode } = require('./player.js');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function sample(key = 'sample', audio = null) {
  const times = Array.from({ length: 16 }, (_, index) => index / 10);
  return { cacheDir: key, source: { key, label: key }, width: 352, height: 72, duration: 1.6,
    frames: times.map((time, index) => ({ id: index, time, end: time + 0.1, ptsTicks: String(index), timeBase: [1, 10], file: 'f' + index + '.jpg', bytes: 10 })),
    audio, expected: { barcodes: times.map((_, index) => index), times,
      barcode: { x: 32, y: 32, step: 32, sampleXOffset: 12, sampleYOffset: 16, bits: 9 } } };
}
function harness(options = {}) {
  let now = 0, nextRaf = 1, drawn = null, contexts = []; const callbacks = new Map(), events = [], changes = [], closed = [], reads = new Map(), gates = new Map();
  const context = {
    drawImage(bitmap) { drawn = bitmap; },
    getImageData(x, y, width) {
      const data = new Uint8ClampedArray(width * 4);
      for (let bit = 0; bit < 9; bit++) {
        const value = drawn && ((drawn.index >> bit) & 1) ? 240 : 10;
        const at = bit * 32 * 4; data[at] = value; data[at + 1] = value; data[at + 2] = value; data[at + 3] = 255;
      }
      return { data };
    }
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  let activeInfo;
  const env = {
    now: () => now, raf: callback => { const id = nextRaf++; callbacks.set(id, callback); return id; }, caf: id => callbacks.delete(id),
    sleep: async () => {},
    decodeImage: async bytes => {
      const index = bytes[0], gate = gates.get(index); if (gate) { gates.delete(index); await gate.promise; }
      return { width: activeInfo.width, height: activeInfo.height, index,
        close() { closed.push(index); } };
    },
    createAudioContext: () => {
      const createdAt = now;
      const audio = {
        state: 'suspended', sampleRate: 48000, destination: {}, sources: [], gains: [],
        get currentTime() { return (now - createdAt) / 1000; },
        getOutputTimestamp() { return { contextTime: audio.currentTime, performanceTime: now }; },
        resume() { audio.state = 'running'; return Promise.resolve(); }, close() { audio.state = 'closed'; return Promise.resolve(); },
        decodeAudioData(array, resolve, reject) {
          if (options.audioFailure) { const error = new Error('fake audio decode failure'); reject(error); return Promise.reject(error); }
          const duration = activeInfo.audio.duration;
          const buffer = { length: Math.round(duration * 48000), numberOfChannels: 2, sampleRate: 48000, duration };
          resolve(buffer); return Promise.resolve(buffer);
        },
        createGain() {
          const gain = { values: [], gain: { setValueAtTime(value, at) { gain.values.push({ value, at }); } }, connect() {}, disconnect() {} };
          audio.gains.push(gain); return gain;
        },
        createBufferSource() {
          const source = { stopped: false, connect() {}, disconnect() {}, start(when, offset) { source.startPlan = { when, offset }; }, stop() { source.stopped = true; } };
          audio.sources.push(source); return source;
        }
      };
      contexts.push(audio); return audio;
    }
  };
  const player = new Player({ canvas, env, ramBytes: options.ramBytes, onChange: state => changes.push(state), emit: event => events.push(event), readAsset: async (info, file) => {
    reads.set(info.source.key + ':' + file, (reads.get(info.source.key + ':' + file) || 0) + 1);
    const bytes = Buffer.alloc(10); bytes[0] = file === 'audio.wav' ? 255 : Number(file.slice(1, -4)); return bytes;
  } });
  const frame = async (milliseconds = 16) => {
    now += milliseconds; const pending = Array.from(callbacks.values()); callbacks.clear(); pending.forEach(callback => callback(now)); await flush();
  };
  const settle = async promise => {
    let done = false, result, failure; promise.then(value => { result = value; done = true; }, error => { failure = error; done = true; });
    await flush();
    for (let i = 0; i < 150 && !done; i++) await frame();
    if (!done) throw new Error('Fake test did not settle.'); if (failure) throw failure; return result;
  };
  return { player, canvas, context, events, changes, closed, reads, gates, frame, settle, contexts,
    now: () => now, load: info => { activeInfo = info; return settle(player.load(info)); },
    gate: index => { const gate = deferred(); gates.set(index, gate); return gate; },
    setInfo: info => { activeInfo = info; } };
}
async function run() {
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); };
  await check('UMD exports to Eagle window even when CommonJS module also exists', async () => {
    const context = vm.createContext({ module: { exports: {} }, document: {} });
    vm.runInContext('window = globalThis;', context);
    vm.runInContext(fs.readFileSync(require.resolve('./player.js'), 'utf8'), context);
    assert.equal(context.window.S1Player, context.module.exports); assert.equal(typeof context.window.S1Player.Player, 'function');
  });
  await check('VFR boundary lookup and last frame', async () => {
    const frames = [{ time: 0 }, { time: 0.04 }, { time: 0.12 }, { time: 0.3 }];
    assert.equal(frameAt(frames, -1), 0); assert.equal(frameAt(frames, 0.119), 1);
    assert.equal(frameAt(frames, 0.12), 2); assert.equal(frameAt(frames, 99), 3);
  });
  await check('positive/negative audio start offsets and ended audio', async () => {
    assert.deepEqual(audioStartPlan(0.2, 0.5, 1, 10), { when: 10.3, offset: 0 });
    assert.deepEqual(audioStartPlan(0.2, -0.3, 1, 10), { when: 10, offset: 0.5 });
    assert.equal(audioStartPlan(1.5, 0.2, 1, 10), null);
  });
  await check('budget reservations, shrink, eviction and idempotent return', async () => {
    const budget = new Budget(100), first = budget.reserve(70, 'first');
    const second = budget.reserve(40, 'second', () => { budget.release(first); return true; });
    budget.shrink(second, 20, 'decoded'); assert.equal(budget.used, 20); assert.equal(budget.peak, 70);
    budget.release(second); budget.release(second); assert.equal(budget.used, 0);
    assert.throws(() => budget.reserve(101, 'too-large'), /超过/);
  });
  await check('load resolves only after first source frame drawn and stays paused', async () => {
    const h = harness(); await h.load(sample());
    assert.equal(h.player.snapshot().state, 'paused'); assert.equal(h.player.snapshot().frameId, 0);
    const draw = h.events.find(event => event.type === 'draw'); assert.equal(draw.barcode.ok, true);
    assert(h.events.some(event => event.type === 'request' && event.phase === 'effective-frame'));
    await h.player.dispose(); assert.equal(h.player.snapshot().cacheBytes, 0);
  });
  await check('old in-flight frame cannot draw after newer effective target; final target settles', async () => {
    const h = harness(); await h.load(sample()); const gate = h.gate(7);
    const old = h.player.seek(0.7, { kind: 'drag' }); await h.frame();
    const latest = h.player.seek(1.1, { kind: 'release', final: true }); await h.frame();
    assert.equal((await old).status, 'superseded'); gate.resolve();
    assert.equal((await h.settle(latest)).frameId, 11);
    assert(!h.events.filter(event => event.type === 'draw').some(event => event.frameId === 7));
    await h.player.dispose(); assert.equal(h.player.snapshot().cacheBytes, 0);
  });
  await check('same target frame reuses in-flight decode; old promise is settled', async () => {
    const h = harness(); await h.load(sample()); const gate = h.gate(8);
    const first = h.player.seek(0.8); await h.frame();
    const latest = h.player.seek(0.85, { final: true }); await h.frame();
    assert.equal((await first).status, 'superseded'); gate.resolve();
    assert.equal((await h.settle(latest)).frameId, 8); assert.equal(h.reads.get('sample:f8.jpg'), 1);
    await h.player.dispose();
  });
  await check('rapid raw inputs coalesce to one effective target per opportunity', async () => {
    const h = harness(); await h.load(sample()); const before = h.events.length;
    const requests = [0.7, 0.8, 0.9, 1, 1.2].map(time => h.player.seek(time, { kind: 'script' }));
    await h.settle(requests[requests.length - 1]); const outcomes = await Promise.all(requests);
    assert.equal(outcomes.filter(outcome => outcome.status === 'drawn').length, 1);
    const events = h.events.slice(before); assert.equal(events.filter(event => event.type === 'request' && event.phase === 'input').length, 5);
    assert.equal(events.filter(event => event.type === 'request' && event.phase === 'effective-frame').length, 1);
    await h.player.dispose();
  });
  await check('slow obsolete work reveals a no-update interval and still reaches the final target', async () => {
    const h = harness(); await h.load(sample()); const gate = h.gate(7), before = h.events.length;
    const first = h.player.seek(0.7, { kind: 'script' }); await h.frame(16);
    for (const time of [1.4, 0.5, 1.2]) { h.player.seek(time, { kind: 'script' }); await h.frame(20); }
    assert.equal(h.events.slice(before).filter(event => event.type === 'draw').length, 0);
    const final = h.player.seek(1.1, { final: true, kind: 'release' }); gate.resolve();
    assert.equal((await first).status, 'superseded'); assert.equal((await h.settle(final)).frameId, 11);
    assert(h.player.snapshot().maxDrawGapMs >= 76);
    await h.player.dispose();
  });
  await check('dispose settles targets and closes decoded results completing afterward', async () => {
    const h = harness(); await h.load(sample()); const gate = h.gate(9), before = h.events.length;
    const seeking = h.player.seek(0.9); await h.frame(); const disposing = h.player.dispose(); gate.resolve();
    await disposing; assert.equal((await seeking).status, 'superseded');
    assert.equal(h.events.slice(before).filter(event => event.type === 'draw').length, 0);
    assert.equal(h.player.snapshot().cacheBytes, 0); assert.equal(h.player.snapshot().state, 'disposed');
  });
  await check('switching materials blocks stale decoded results and returns reservations', async () => {
    const h = harness(); await h.load(sample('a')); const gate = h.gate(9);
    const old = h.player.seek(0.9); await h.frame(); const second = sample('b'); h.setInfo(second);
    const loaded = h.player.load(second); await flush(); await h.frame(); gate.resolve();
    assert.equal((await old).status, 'superseded'); await h.settle(loaded);
    const draws = h.events.filter(event => event.type === 'draw' && event.epoch === 2);
    assert.deepEqual(draws.map(event => event.frameId), [0]);
    await h.player.dispose(); assert.equal(h.player.snapshot().cacheBytes, 0);
  });
  await check('duplicate PTS remain separately accessible by ordinal step', async () => {
    const h = harness(), info = sample(); info.frames[1].time = 0; await h.load(info);
    assert.equal((await h.settle(h.player.step(1))).frameId, 1);
    assert.equal((await h.settle(h.player.step(-1))).frameId, 0);
    await h.player.dispose();
  });
  await check('audio startup offset, silence on seek, stale onended and video clock beyond audio', async () => {
    const h = harness(), info = sample('audio', { file: 'audio.wav', start: 0.3, bytes: 10, sampleRate: 48000, channels: 2, duration: 0.4 });
    await h.load(info); assert.equal(h.player.snapshot().audioAvailable, true);
    await h.settle(h.player.play()); const audio = h.contexts[0], first = audio.sources[0];
    const startClock = h.events.find(event => event.type === 'clock' && event.phase === 'start');
    assert(Math.abs(first.startPlan.when - startClock.audioContextStart - 0.3) < 1e-8);
    const oldEnded = first.onended; await h.settle(h.player.seek(0.5, { final: true }));
    assert(first.stopped); assert(audio.gains[0].values.some(value => value.value === 0));
    await h.settle(h.player.play()); oldEnded(); assert.equal(h.player.snapshot().state, 'playing');
    for (let i = 0; i < 30; i++) await h.frame(16);
    assert.equal(h.player.snapshot().state, 'playing'); assert(h.player.snapshot().time >= 0.8);
    assert(h.changes.some(state => state.state === 'playing' && state.time >= 0.8), 'playing drawings must update window time');
    await h.settle(h.player.pause()); assert.equal(h.player.snapshot().state, 'paused');
    await h.player.dispose(); assert.equal(audio.state, 'closed'); assert.equal(h.player.snapshot().cacheBytes, 0);
  });
  await check('audio callback and rejected Promise are both consumed; failed resources released', async () => {
    const h = harness({ audioFailure: true });
    await assert.rejects(() => h.load(sample('bad-audio', { file: 'audio.wav', start: 0, bytes: 10, sampleRate: 48000, channels: 2, duration: 0.4 })), /fake audio decode failure/);
    await h.player.dispose(); assert.equal(h.contexts[0].state, 'closed'); assert.equal(h.player.snapshot().cacheBytes, 0);
    await new Promise(resolve => setImmediate(resolve)); // unhandled rejected decode Promise would fail Node
  });
  await check('marker verification can be disabled and uncertain pixels are not passes', async () => {
    const h = harness(); await h.load(sample()); h.player.setVerifyMarkers(false);
    await h.settle(h.player.seek(0.7)); assert.equal(h.events.filter(event => event.type === 'draw').pop().barcode, null);
    const gray = { getImageData: (x, y, width) => ({ data: new Uint8ClampedArray(width * 4).fill(128) }) };
    const result = readBarcode(gray, sample().expected, 0); assert.equal(result.ok, null); assert.equal(result.uncertain, true);
    await h.player.dispose();
  });
  await check('budget failure reports error and all reservations are reclaimed', async () => {
    const h = harness({ ramBytes: 100 }); await assert.rejects(() => h.load(sample()), /RAM/);
    assert.equal(h.player.snapshot().state, 'error'); await h.player.dispose(); assert.equal(h.player.snapshot().cacheBytes, 0);
  });
  console.log(JSON.stringify({ source: 'local-fake-player-unit-tests', passed, count: passed.length,
    limits: ['No real JPEG decode, audio output, Eagle runtime, FFmpeg or physical display measured.',
      'No FPS/P95/AV-sync product acceptance is inferred from these checks.'] }, null, 2));
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
