'use strict';
// Deterministic fake clock/canvas/audio tests. No Eagle, media generation or physical display.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const frameIndex = require('../plugin/frame-index.cjs');
const { Player, Budget, readBarcode } = require('../plugin/player.js');
const flush = async () => { for (let count = 0; count < 24; count++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function sample(key = 'sample', audio = null, count = 16, rate = 10) {
  const rows = Array.from({ length: count }, (_, ordinal) => ({ id: ordinal, ptsTicks: String(ordinal), file: 'f' + ordinal + '.jpg', bytes: 10 }));
  const built = frameIndex.buildIndex(rows, { timeBase: [1, rate], lastFrameEndTicks: String(count) });
  return { cacheDir: key, source: { key, label: key }, width: 352, height: 72,
    duration: Math.max(built.videoDuration, audio ? audio.start + audio.duration : 0), frames: built.frames, audio,
    expected: { barcodes: rows.map((_, ordinal) => ordinal), times: built.frames.map(frame => frame.time),
      barcode: { x: 32, y: 32, step: 32, sampleXOffset: 12, sampleYOffset: 16, bits: 9 } } };
}
function audio(start = 0, duration = 0.4) { return { file: 'audio.wav', start, duration, bytes: 16, sampleRate: 48000, channels: 2 }; }
function harness(options = {}) {
  let now = 0, nextRaf = 0, drawn = null, activeDecodes = 0, maxDecodes = 0, player;
  const callbacks = new Map(), events = [], changes = [], closed = [], reads = new Map(), gates = new Map(), sleepers = [], contexts = [];
  const context = { drawImage(bitmap) { drawn = bitmap; }, getImageData(x, y, width) {
    const data = new Uint8ClampedArray(width * 4);
    for (let bit = 0; bit < 9; bit++) {
      const value = drawn && ((drawn.ordinal >> bit) & 1) ? 240 : 10, at = bit * 32 * 4;
      data[at] = value; data[at + 1] = value; data[at + 2] = value; data[at + 3] = 255;
    }
    return { data };
  } };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const env = {
    now: () => now, raf: callback => { const id = ++nextRaf; callbacks.set(id, callback); return id; }, caf: id => callbacks.delete(id),
    sleep: milliseconds => new Promise(resolve => sleepers.push({ at: now + milliseconds, resolve })),
    decodeImage: async bytes => {
      const ordinal = bytes[0]; activeDecodes++; maxDecodes = Math.max(maxDecodes, activeDecodes);
      try {
        const gate = gates.get(ordinal); if (gate) { gates.delete(ordinal); await gate.promise; }
        if (options.decodeMs) await env.sleep(options.decodeMs);
        if (options.decodeFailure === ordinal) throw new Error('fake JPEG decode failure');
        return { width: bytes.readUInt16LE(1), height: bytes.readUInt16LE(3), ordinal, close() { closed.push(ordinal); } };
      } finally { activeDecodes--; }
    },
    createAudioContext: () => {
      const createdAt = now;
      const output = { state: 'suspended', sampleRate: 48000, destination: {}, sources: [], gains: [],
        get currentTime() { return (now - createdAt) / 1000; },
        getOutputTimestamp() {
          if (options.outputTimestampFailure) throw new Error('fake unsupported output timestamp');
          return { contextTime: output.currentTime, performanceTime: now };
        },
        resume() { return (options.resumeGate ? options.resumeGate.promise : Promise.resolve()).then(() => { output.state = 'running'; }); },
        close() { output.state = 'closed'; return Promise.resolve(); },
        decodeAudioData(array, resolve, reject) {
          const decode = (options.audioDecodeGate ? options.audioDecodeGate.promise : Promise.resolve()).then(() => {
            if (options.audioFailure) throw new Error('fake audio decode failure');
            const data = Buffer.from(array), duration = data.readDoubleLE(0), channels = data[8];
            return { length: Math.round(duration * 48000), numberOfChannels: channels, sampleRate: 48000, duration };
          });
          decode.then(resolve, reject); return decode;
        },
        createGain() {
          const gain = { values: [], gain: { setValueAtTime(value, at) { gain.values.push({ value, at }); } }, connect() {}, disconnect() {} };
          output.gains.push(gain); return gain;
        },
        createBufferSource() {
          const source = { stopped: false, connect() {}, disconnect() {}, start(when, offset) { source.startPlan = { when, offset }; }, stop() { source.stopped = true; } };
          output.sources.push(source); return source;
        }
      };
      contexts.push(output); return output;
    }
  };
  player = new Player({ canvas, env, frameIndex, ramBytes: options.ramBytes, budget: options.budget,
    playbackGuardMs: options.playbackGuardMs,
    emit: event => { events.push(event); if (options.onEvent) options.onEvent(event, player); },
    onChange: state => changes.push(state), readAsset: async (info, file) => {
      const key = info.source.key + ':' + file; reads.set(key, (reads.get(key) || 0) + 1);
      if (options.readFailure === file) throw new Error('fake asset read failure');
      if (file === 'audio.wav') { const bytes = Buffer.alloc(info.audio.bytes); bytes.writeDoubleLE(info.audio.duration, 0); bytes[8] = info.audio.channels; return bytes; }
      const bytes = Buffer.alloc(10); bytes[0] = Number(file.slice(1, -4)); bytes.writeUInt16LE(info.width, 1); bytes.writeUInt16LE(info.height, 3); return bytes;
    } });
  const advance = async (milliseconds, render) => {
    now += milliseconds;
    for (let index = sleepers.length - 1; index >= 0; index--) if (sleepers[index].at <= now) sleepers.splice(index, 1)[0].resolve();
    if (render) { const scheduled = Array.from(callbacks.values()); callbacks.clear(); scheduled.forEach(callback => callback(now)); }
    await flush();
  };
  const frame = (milliseconds = 16) => advance(milliseconds, true);
  const settle = async (promise, maximum = 300) => {
    let done = false, result, failure;
    promise.then(value => { done = true; result = value; }, error => { done = true; failure = error; }); await flush();
    for (let index = 0; !done && index < maximum; index++) await frame();
    if (!done) throw new Error('Fake request did not settle.'); if (failure) throw failure; return result;
  };
  const close = async () => {
    const disposing = player.dispose(); gates.forEach(gate => gate.resolve()); sleepers.splice(0).forEach(sleeper => sleeper.resolve());
    if (options.audioDecodeGate) options.audioDecodeGate.resolve(); if (options.resumeGate) options.resumeGate.resolve();
    await disposing; assert.equal(player.snapshot().cacheBytes, options.budget ? options.budget.snapshot().used : 0);
  };
  return { player, canvas, events, changes, reads, closed, contexts, frame, elapse: milliseconds => advance(milliseconds, false), settle, close, now: () => now,
    gate: ordinal => { const gate = deferred(); gates.set(ordinal, gate); return gate; },
    load: info => settle(player.load(info)), maxDecodes: () => maxDecodes };
}
async function run() {
  const passed = [], simulations = [];
  const check = async (name, test) => {
    let watchdog;
    try { await Promise.race([test(), new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Simulated test did not settle.')), 5000); })]); passed.push(name); }
    catch (error) { error.message = name + ': ' + error.message; throw error; }
    finally { clearTimeout(watchdog); }
  };
  await check('UMD exports to window and CommonJS together', async () => {
    const context = vm.createContext({ module: { exports: {} }, document: {} }); vm.runInContext('window = globalThis;', context);
    vm.runInContext(fs.readFileSync(require.resolve('../plugin/player.js'), 'utf8'), context);
    assert.equal(context.window.EVAPlayer, context.module.exports); assert.equal(typeof context.module.exports.Player, 'function');
  });
  await check('budget reservation eviction shrink and idempotent release', async () => {
    const budget = new Budget(100), first = budget.reserve(70, 'a');
    const second = budget.reserve(40, 'b', () => { budget.release(first); return true; }); budget.shrink(second, 20, 'decoded');
    assert.equal(budget.used, 20); assert.equal(budget.peak, 70); budget.release(second); budget.release(second); assert.equal(budget.used, 0);
    assert.throws(() => budget.reserve(101, 'bad'), /RAM/); assert.throws(() => new Budget(513 * 1024 ** 2), /512/);
  });
  await check('load draws first frame before resolving and idle does not manufacture draws', async () => {
    const h = harness(); const result = await h.load(sample()); assert.equal(result.status, 'drawn');
    assert.equal(h.player.snapshot().state, 'paused'); assert.equal(h.player.snapshot().frameId, 0);
    assert.equal(h.events.find(event => event.type === 'draw').barcode.ok, true);
    for (let index = 0; index < 8; index++) await h.frame(); assert.equal(h.player.snapshot().drawCount, 1); await h.close();
  });
  await check('raw inputs coalesce; every superseded request settles', async () => {
    const h = harness(); await h.load(sample()); const before = h.events.length;
    const requests = [0.7, 0.8, 0.9, 1.1, 1.2].map(time => h.player.seek(time, { kind: 'script' }));
    await h.settle(requests[4]); const results = await Promise.all(requests);
    assert.deepEqual(results.map(result => result.status), ['superseded', 'superseded', 'superseded', 'superseded', 'drawn']);
    assert.equal(h.events.slice(before).filter(event => event.type === 'request' && event.phase === 'effective-frame').length, 1);
    assert.equal(h.player.snapshot().pendingTargets, 0); await h.close();
  });
  await check('second slot serves newest target while obsolete decode remains blocked', async () => {
    const h = harness(); await h.load(sample()); const gate = h.gate(7), before = h.events.length;
    const old = h.player.seek(0.7); await h.frame(); const latest = h.player.seek(1.1, { final: true, kind: 'release' });
    assert.equal((await h.settle(latest)).frameId, 11); assert.equal((await old).status, 'superseded');
    assert.equal(h.player.snapshot().activeImageTasks, 1); assert.equal(h.maxDecodes(), 2);
    assert(!h.events.slice(before).some(event => event.type === 'draw' && event.frameId === 7));
    gate.resolve(); await flush(); await h.close();
  });
  await check('same frame reuses decode and settles prior promise without pretending it drew', async () => {
    const h = harness(); await h.load(sample()); const gate = h.gate(8);
    const first = h.player.seek(0.8); await h.frame(); const second = h.player.seek(0.85, { final: true }); await h.frame();
    assert.equal((await first).status, 'superseded'); gate.resolve(); assert.equal((await h.settle(second)).frameId, 8);
    assert.equal(h.reads.get('sample:f8.jpg'), 1); assert(!h.events.some(event => event.type === 'draw' && event.requestId === (h.events.find(event => event.type === 'request' && event.kind === 'seek')).requestId));
    await h.close();
  });
  await check('one latest pending target gets next freed slot; reservations stay until decode ends', async () => {
    const h = harness(); await h.load(sample()); const gate7 = h.gate(7), gate8 = h.gate(8);
    const first = h.player.seek(0.7); await h.frame(); const second = h.player.seek(0.8); await h.frame();
    const final = h.player.seek(1.2, { kind: 'release', final: true }); await h.frame();
    assert.equal(h.player.snapshot().activeImageTasks, 2); assert.equal(h.player.snapshot().pendingTargets, 1);
    assert.equal(h.reads.get('sample:f12.jpg'), undefined); assert(h.player.snapshot().budget.kinds['frame-inflight'] > 0);
    gate7.resolve(); await flush(); assert.equal(h.reads.get('sample:f12.jpg'), 1);
    assert.equal((await h.settle(final)).frameId, 12);
    assert.equal((await first).status, 'superseded'); assert.equal((await second).status, 'superseded');
    assert(h.player.snapshot().budget.kinds['frame-inflight'] > 0); gate8.resolve(); await flush(); await h.close();
  });
  await check('input starts resource work before rAF; drawing still waits for rAF', async () => {
    const h = harness(); await h.load(sample()); const before = h.player.snapshot().drawCount;
    const request = h.player.seek(0.7, { kind: 'drag' }); await flush();
    assert.equal(h.reads.get('sample:f7.jpg'), 1); assert.equal(h.player.snapshot().drawCount, before);
    await h.frame(0); assert.equal((await request).status, 'drawn');
    const ready = h.events.find(event => event.type === 'ready' && event.frameId === 7 && event.phase === 'read-and-image-decode-complete');
    assert.equal(ready.readMs, 0); assert.equal(ready.decodeMs, 0); assert.equal(ready.decoderServiceMs, 0); await h.close();
  });
  await check('fresh fast targets use the upcoming display opportunity instead of starting work there', async () => {
    const h = harness({ decodeMs: 5 }); await h.load(sample()); h.player.setVerifyMarkers(false);
    const before = h.player.snapshot().drawCount;
    for (let index = 7; index < 12; index++) {
      const request = h.player.seek(index / 10, { kind: 'drag' }); await flush();
      await h.elapse(6); assert.equal(h.player.snapshot().drawCount, before + index - 7);
      await h.frame(1); assert.equal((await request).status, 'drawn'); await h.elapse(1);
    }
    assert.equal(h.player.snapshot().drawCount, before + 5);
    const services = h.events.filter(event => event.type === 'ready' && ['drag', 'drag-ahead'].includes(event.kind) &&
      event.frameId >= 7 && event.frameId < 12 && event.phase === 'read-and-image-decode-complete');
    assert.equal(services.length, 5); assert(services.every(event => event.decodeMs === 6 && event.readMs === 0)); await h.close();
  });
  // A pointer event immediately before every rAF is deliberately different from
  // the old 120Hz timer test. Expected frames come from the input times, never
  // from the prediction; drawing an earlier prepared image cannot pass this.
  async function phaseLockedDrag(info, times) {
    let latest = null; const wrongDraws = [];
    const h = harness({ decodeMs: 5.6, onEvent(event) {
      // Player deliberately catches telemetry callback errors; collect the
      // observation and assert outside the callback so a failure cannot hide.
      if (event.type === 'draw' && latest !== null && event.frameOrdinal !== latest) wrongDraws.push({ actual: event.frameOrdinal, latest });
    } });
    info.width = 1280; info.height = 720;
    await h.load(info); h.player.setVerifyMarkers(false);
    for (let index = 0; index < 5; index++) await h.frame(7);
    const begin = h.now(), requests = [];
    for (const time of times) {
      latest = 0;
      for (let index = 1; index < info.frames.length && info.frames[index].time <= time; index++) latest = index;
      requests.push(h.player.seek(time, { kind: 'drag', inputAt: h.now() })); await flush();
      await h.frame(0.2); await h.elapse(5.6); await h.elapse(1.14);
    }
    const end = h.now(), draws = h.events.filter(event => event.type === 'draw' && event.at >= begin);
    const marks = [begin, ...draws.map(event => event.at), end];
    const maxGapMs = Math.max(...marks.slice(1).map((at, index) => at - marks[index]));
    assert(draws.length >= times.length * 0.75, 'Continuous cached drag must not starve when input and rAF have the same cadence.');
    assert(maxGapMs < 35, 'Phase-locked motion must not wait for release to display.');
    assert(new Set(draws.map(event => event.rafOpportunity)).size === draws.length);
    const final = await h.settle(h.player.seek(times[times.length - 1], { kind: 'release', final: true }));
    assert(['drawn', 'reused'].includes(final.status)); assert.equal(h.player.snapshot().frameOrdinal, latest);
    assert.deepEqual(wrongDraws, [], 'Only the latest pointer target may draw.');
    assert((await Promise.all(requests)).every(result => ['drawn', 'reused', 'superseded'].includes(result.status)));
    assert(h.maxDecodes() <= 2); assert(h.player.snapshot().cachePeakBytes <= 512 * 1024 ** 2);
    assert(h.events.some(event => event.type === 'cache' && event.phase === 'evict'), 'Trajectory must exceed the decoded working set.');
    const result = { source: info.source.key, inputs: times.length, simulatedWindowMs: end - begin,
      simulatedDraws: draws.length, simulatedMaxGapMs: maxGapMs, maxImageTasks: h.maxDecodes(),
      managedPeakBytes: h.player.snapshot().cachePeakBytes, realEaglePerformance: false };
    await h.close(); return result;
  }
  await check('phase-locked 144Hz forward and reverse drag stays current with a bounded RAM working set', async () => {
    const times = Array.from({ length: 480 }, (_, index) => (200 + Math.min(index, 479 - index) * 2.62) / 60);
    simulations.push(await phaseLockedDrag(sample('phase-locked-cfr', null, 1490, 60), times));
  });
  await check('motion lookahead uses timestamp mapping for variable-rate frames', async () => {
    const info = sample('phase-locked-vfr', null, 1490, 60); let ticks = 0;
    const rows = info.frames.map((frame, index) => { const row = { id: index, ptsTicks: String(ticks), file: frame.file, bytes: frame.bytes }; ticks += index % 3 === 0 ? 2 : 1; return row; });
    const built = frameIndex.buildIndex(rows, { timeBase: [1, 120], lastFrameEndTicks: String(ticks) });
    info.frames = built.frames; info.duration = built.videoDuration;
    const times = Array.from({ length: 480 }, (_, index) => 3 + Math.min(index, 479 - index) * 0.043);
    simulations.push(await phaseLockedDrag(info, times));
  });
  await check('wrong motion predictions and slow work cannot displace release or exceed two slots', async () => {
    let latest = null; const wrongDraws = [];
    const h = harness({ decodeMs: 5.6, onEvent(event) {
      if (event.type === 'draw' && latest !== null && event.frameOrdinal !== latest) wrongDraws.push({ actual: event.frameOrdinal, latest });
    } });
    const info = sample('unpredictable', null, 1490, 60); info.width = 1280; info.height = 720;
    await h.load(info); h.player.setVerifyMarkers(false); h.player.setDecodeDelay(60);
    const positions = [200, 203, 206, 700, 100, 97, 94, 900, 400, 405, 410, 408, 401], requests = [];
    for (let index = 0; index < positions.length * 3; index++) {
      latest = positions[index % positions.length]; requests.push(h.player.seek(latest / 60, { kind: 'drag' }));
      await flush(); await h.frame(0.2); await h.elapse(6.74);
    }
    latest = 800; const releaseAt = h.now();
    const final = await h.settle(h.player.seek(latest / 60, { kind: 'release', final: true }));
    assert.equal(final.frameId, latest); assert(h.now() - releaseAt < 250);
    assert((await Promise.all(requests)).every(result => ['drawn', 'reused', 'superseded'].includes(result.status)));
    assert(h.maxDecodes() <= 2); assert(h.player.snapshot().cachePeakBytes <= 512 * 1024 ** 2);
    assert(!h.events.some(event => event.type === 'error'));
    // Final release may already have started the normal bounded neighbours.
    // Advance both fake decode stages before disposal; a Promise alone is not a clock.
    for (let index = 0; index < 40 && h.player.snapshot().activeImageTasks; index++) await h.frame();
    assert.equal(h.player.snapshot().activeImageTasks, 0); assert.deepEqual(wrongDraws, []); await h.close();
  });
  await check('isolated gestures and pauses do not continue old motion predictions', async () => {
    const h = harness(); const info = sample('gestures', null, 1490, 60); await h.load(info); h.player.setVerifyMarkers(false);
    for (const ordinal of [200, 203, 206]) {
      await h.settle(h.player.seek(ordinal / 60, { kind: 'drag' })); await h.elapse(8);
    }
    await h.elapse(150); const before = h.events.length;
    assert.equal((await h.settle(h.player.seek(600 / 60, { kind: 'drag' }))).frameId, 600);
    for (let index = 0; index < 5; index++) await h.frame();
    assert(!h.events.slice(before).some(event => event.type === 'cache' && event.phase === 'image-work-start' && event.role === 'drag-ahead'));
    await h.close();
  });
  await check('continuous drag avoids neighbour work; final release restores bounded prefetch', async () => {
    const h = harness(); await h.load(sample()); await h.settle(h.player.seek(0.7, { kind: 'drag' }));
    for (let index = 0; index < 5; index++) await h.frame();
    assert.equal(h.reads.get('sample:f8.jpg'), undefined);
    assert.equal((await h.settle(h.player.seek(0.7, { final: true, kind: 'release' }))).status, 'reused');
    assert.equal(h.reads.get('sample:f8.jpg'), 1); assert(h.player.snapshot().activeImageTasks <= 2); await h.close();
  });
  await check('injected slow service finishes obsolete decodes for bounded reuse without drawing them', async () => {
    const h = harness(); await h.load(sample()); h.player.setDecodeDelay(60);
    const first = h.player.seek(0.7, { kind: 'rapid' }); await flush();
    const second = h.player.seek(0.8, { kind: 'rapid' }); await flush();
    const final = h.player.seek(1.1, { kind: 'release', final: true }); await flush();
    assert.equal(h.player.snapshot().activeImageTasks, 2); assert.equal(h.reads.get('sample:f11.jpg'), undefined);
    await h.elapse(60); assert.equal(h.reads.get('sample:f11.jpg'), 1);
    const obsolete = h.events.filter(event => event.type === 'ready' && event.phase === 'read-and-image-decode-complete' && [7, 8].includes(event.frameId));
    assert.equal(obsolete.length, 2); assert(obsolete.every(event => !event.stillTarget && event.injectedDelayMs === 60 && event.decoderServiceMs === 60));
    assert(!h.events.some(event => event.type === 'draw' && [7, 8].includes(event.frameId)));
    h.player.setDecodeDelay(0); await h.elapse(60); await h.frame(0);
    assert.equal((await final).status, 'drawn'); assert.equal((await first).status, 'superseded'); assert.equal((await second).status, 'superseded');
    assert.equal(h.player.snapshot().frameId, 11); assert(h.player.snapshot().cachePeakBytes <= 512 * 1024 ** 2); await h.close();
  });
  await check('current JPEG decode failure settles seek and releases reservation', async () => {
    const h = harness({ decodeFailure: 7 }); await h.load(sample()); const result = await h.settle(h.player.seek(0.7));
    assert.equal(result.status, 'error'); assert.match(result.error, /decode failure/); assert.equal(h.player.snapshot().state, 'error');
    await h.close(); assert.equal(h.player.snapshot().cacheBytes, 0);
  });
  await check('current asset read failure settles seek', async () => {
    const h = harness({ readFailure: 'f8.jpg' }); await h.load(sample());
    assert.equal((await h.settle(h.player.seek(0.8))).status, 'error'); await h.close();
  });
  await check('dispose settles target immediately and closes later decoded bitmap', async () => {
    const h = harness(); await h.load(sample()); const gate = h.gate(9), before = h.events.length;
    const target = h.player.seek(0.9); await h.frame(); const disposing = h.player.dispose();
    assert.equal((await target).status, 'superseded'); assert(h.player.snapshot().cacheBytes > 0);
    gate.resolve(); await disposing; assert.equal(h.player.snapshot().cacheBytes, 0);
    assert(h.closed.includes(9)); assert(!h.events.slice(before).some(event => event.type === 'draw'));
  });
  await check('material switch waits real old work and never draws stale source', async () => {
    const h = harness(); await h.load(sample('a')); const gate = h.gate(9);
    const seeking = h.player.seek(0.9); await h.frame(); const next = h.player.load(sample('b'));
    await flush(); await h.frame(); assert.equal((await seeking).status, 'superseded');
    assert.equal(h.reads.get('b:f0.jpg'), undefined); assert(h.player.snapshot().cacheBytes > 0);
    gate.resolve(); await h.settle(next); assert.deepEqual(h.events.filter(event => event.type === 'draw' && event.epoch === 2).map(event => event.frameId), [0]);
    assert(h.closed.includes(9)); await h.close();
  });
  await check('loaded asset snapshot cannot be mutated by caller', async () => {
    const h = harness(), info = sample(); await h.load(info); info.frames[7].file = 'bad.jpg'; info.frames[7].time = 9;
    assert.equal((await h.settle(h.player.seek(0.7))).frameId, 7); assert.equal(h.reads.get('sample:bad.jpg'), undefined); await h.close();
  });
  await check('duplicate PTS remain separate and step uses ordinal rather than id', async () => {
    const h = harness(), info = sample(); info.frames[0].end = 0; info.frames[1].time = 0; info.frames[1].ptsTicks = '0';
    info.frames.forEach((frame, ordinal) => { frame.id = ordinal + 100; }); await h.load(info);
    assert.equal(h.player.snapshot().frameId, 100); assert.equal((await h.settle(h.player.step(1))).frameId, 101);
    assert.equal((await h.settle(h.player.step(-1))).frameId, 100); assert.equal((await h.settle(h.player.seek(0))).frameId, 101); await h.close();
  });
  await check('negative audio start skips earlier samples with common video origin', async () => {
    const h = harness(); await h.load(sample('negative', audio(-0.3, 0.5))); await h.settle(h.player.play());
    assert(Math.abs(h.contexts[0].sources[0].startPlan.offset - 0.3) < 1e-9);
    await h.settle(h.player.pause()); assert(h.contexts[0].sources[0].stopped); await h.close();
  });
  await check('positive audio offset; seek stops sound; stale ended does not stop resumed clock', async () => {
    const h = harness(); await h.load(sample('positive', audio(0.3, 0.4))); await h.settle(h.player.play());
    const output = h.contexts[0], first = output.sources[0], start = h.events.find(event => event.type === 'clock' && event.phase === 'start');
    assert(Math.abs(first.startPlan.when - start.audioContextStart - 0.3) < 1e-9); const oldEnded = first.onended;
    await h.settle(h.player.seek(0.5, { final: true })); assert(first.stopped); assert(output.gains[0].values.some(value => value.value === 0));
    await h.settle(h.player.play()); oldEnded(); assert.equal(h.player.snapshot().state, 'playing');
    output.sources[1].onended(); for (let count = 0; count < 25; count++) await h.frame();
    assert.equal(h.player.snapshot().state, 'playing'); assert(h.player.snapshot().time >= 0.8);
    assert(h.changes.some(change => change.state === 'playing' && change.time >= 0.8)); await h.close();
  });
  await check('low source fps holding a valid image does not trigger missing-supply protection', async () => {
    const h = harness(); await h.load(sample('slow', null, 6, 2)); await h.settle(h.player.play());
    for (let count = 0; count < 12; count++) await h.frame(100);
    assert.equal(h.player.snapshot().state, 'playing'); assert(!h.events.some(event => event.code === 'UNDERRUN')); await h.close();
  });
  await check('underrun starts when next source frame is missing; final seek can recover', async () => {
    const h = harness(); await h.load(sample('missing', null, 20, 2)); await h.settle(h.player.play()); const gate = h.gate(4);
    for (let count = 0; count < 4; count++) await h.frame(500); await h.frame(40);
    assert.equal(h.player.snapshot().state, 'playing'); await h.frame(100); assert.equal(h.player.snapshot().state, 'playing');
    await h.frame(80); assert.equal(h.player.snapshot().state, 'error'); assert.equal(h.player.snapshot().lastErrorCode, 'UNDERRUN');
    const target = h.player.seek(2, { final: true }); gate.resolve(); assert.equal((await h.settle(target)).frameId, 4);
    assert.equal(h.player.snapshot().state, 'paused'); await h.close();
  });
  await check('audio callback and returned rejection both consumed; failed audio released', async () => {
    const h = harness({ audioFailure: true }); await assert.rejects(() => h.load(sample('bad', audio())), /audio decode failure/);
    await h.close(); assert.equal(h.player.snapshot().cacheBytes, 0); assert.equal(h.contexts[0].state, 'closed');
    await new Promise(resolve => setImmediate(resolve));
  });
  await check('switch during pending audio keeps reservation until real decode completion', async () => {
    const gate = deferred(), h = harness({ audioDecodeGate: gate }); const old = h.player.load(sample('a', audio())); await flush();
    assert(h.player.snapshot().cacheBytes > 0); const next = h.player.load(sample('b')); await flush();
    assert(h.player.snapshot().cacheBytes > 0); assert.equal(h.reads.get('b:f0.jpg'), undefined);
    gate.resolve(); assert.equal((await old).status, 'superseded'); await h.settle(next); await h.close();
  });
  await check('ready observer reentry cannot slip stale frame past final commit guard', async () => {
    let latest, triggered = false;
    const h = harness({ onEvent: (event, player) => {
      if (!triggered && event.type === 'ready' && event.phase === 'effective-target-available' && event.frameId === 7) {
        triggered = true; latest = player.seek(1.1, { final: true });
      }
    } });
    await h.load(sample()); assert.equal((await h.settle(h.player.seek(0.7))).status, 'superseded');
    assert.equal((await h.settle(latest)).frameId, 11); assert(!h.events.some(event => event.type === 'draw' && event.frameId === 7)); await h.close();
  });
  await check('raw request observer reentry leaves every promise settled', async () => {
    let latest, triggered = false;
    const h = harness({ onEvent: (event, player) => {
      if (!triggered && event.type === 'request' && event.phase === 'input' && event.frameId === 7) {
        triggered = true; latest = player.seek(1.2, { final: true });
      }
    } });
    await h.load(sample()); assert.equal((await h.player.seek(0.7)).status, 'superseded');
    assert.equal((await h.settle(latest)).frameId, 12); await h.close();
  });
  await check('already displayed frame settles reused without manufacturing a draw', async () => {
    const h = harness(); await h.load(sample()); const result = await h.settle(h.player.seek(0));
    assert.equal(result.status, 'reused'); assert.equal(result.drawAt, null);
    assert.equal(h.player.snapshot().drawCount, 1);
    const event = h.events.find(event => event.type === 'reused'); assert.equal(event.requestId, result.requestId); assert.equal(event.repeatedFrame, true);
    const total = h.player.snapshot().drawCount; for (let count = 0; count < 6; count++) await h.frame();
    assert.equal(h.player.snapshot().drawCount, total); await h.close();
  });
  await check('single-frame video and longer audio reach end and restart after same-frame reuse', async () => {
    const h = harness(); await h.load(sample('single', audio(0, 0.6), 1, 10)); await h.settle(h.player.play());
    const output = h.contexts[0]; output.sources[0].onended();
    for (let count = 0; count < 45; count++) await h.frame();
    assert.equal(h.player.snapshot().state, 'paused'); assert.equal(h.player.snapshot().frameId, 0);
    assert.equal(h.player.snapshot().pendingTargets, 0); assert(output.sources[0].stopped);
    assert.equal((await h.settle(h.player.play())).status, 'playing'); assert.equal(output.sources.length, 2);
    assert.equal(output.sources[1].startPlan.offset, 0); await h.close();
  });
  await check('draw observer new input does not receive an old state snapshot', async () => {
    let latest, triggered = false;
    const h = harness({ onEvent: (event, player) => {
      if (!triggered && event.type === 'draw' && event.frameId === 7) {
        triggered = true; latest = player.seek(1.2, { final: true });
      }
    } });
    await h.load(sample()); const first = await h.settle(h.player.seek(0.7)); assert.equal(first.status, 'drawn');
    assert(!h.changes.some(change => change.frameId === 7 && change.state === 'paused'));
    assert.equal((await h.settle(latest)).frameId, 12); await h.close();
  });
  await check('marker verification switch and uncertain pixels are not passes', async () => {
    const h = harness(); await h.load(sample()); h.player.setVerifyMarkers(false); await h.settle(h.player.seek(0.7));
    assert.equal(h.events.filter(event => event.type === 'draw').pop().barcode, null);
    const gray = { getImageData: (x, y, width) => ({ data: new Uint8ClampedArray(width * 4).fill(128) }) };
    assert.equal(readBarcode(gray, sample().expected, 0).ok, null); await h.close();
  });
  await check('tiny budget fails load without leaked reservations', async () => {
    const h = harness({ ramBytes: 100 }); await assert.rejects(() => h.load(sample()), /RAM/);
    assert.equal(h.player.snapshot().state, 'error'); await h.close(); assert.equal(h.player.snapshot().cacheBytes, 0);
  });
  await check('output timestamp fallback is labelled rather than claiming physical sync', async () => {
    const h = harness({ outputTimestampFailure: true }); await h.load(sample('fallback', audio())); await h.settle(h.player.play());
    await h.frame(); assert(h.events.some(event => event.type === 'clock' && /fallback/.test(event.method || ''))); await h.close();
  });
  await check('pause supersedes a pending audio resume without late playback', async () => {
    const gate = deferred(), h = harness({ resumeGate: gate }); await h.load(sample('resume', audio()));
    const playing = h.player.play(); await flush(); await h.player.pause(); gate.resolve();
    assert.equal((await playing).status, 'superseded'); assert.equal(h.player.snapshot().state, 'paused'); assert.equal(h.contexts[0].sources.length, 0); await h.close();
  });
  return { source: 'new-player-fake-unit-and-scheduler-tests', passed, count: passed.length, simulations,
    limits: ['No real JPEG/audio decoding, Eagle, FFmpeg, filesystem cache or physical display measured.',
      'These checks do not establish P-01/P-02/P-03 acceptance or physical AV synchronization.'] };
}
module.exports = { run };
if (require.main === module) run().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
