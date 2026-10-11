'use strict';

// Pure local assertions. No media generation, Eagle, cache deletion or files.
const assert = require('assert');
const { buildIndex, validateIndex, frameAt, stepIndex, audioStartPlan } = require('../plugin/frame-index.cjs');

const checks = [];
function test(name, action) { action(); checks.push(name); }
function rows(values, base, ids) {
  return values.map((value, index) => ({ id: ids ? ids[index] : index,
    ptsTicks: String(value), timeBase: base, file: String(index).padStart(6, '0') + '.jpg', bytes: 64, sha256: 'reference-' + index }));
}
function info(result, audio) {
  return { width: 1280, height: 720, duration: Math.max(result.videoDuration, audio ? audio.start + audio.duration : 0),
    frames: result.frames, audio: audio || null };
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }

test('CFR uses original integer PTS, independent presented ids and explicit final end', () => {
  const input = rows([1000, 1001, 1002], [1, 25], [7, 11, 19]);
  const before = copy(input);
  const built = buildIndex(input, { timeBase: [1, 25], lastFrameEndTicks: '1003' });
  assert.deepStrictEqual(built.frames.map(frame => frame.time), [0, 0.04, 0.08]);
  assert.deepStrictEqual(built.frames.map(frame => frame.end), [0.04, 0.08, 0.12]);
  assert.deepStrictEqual(built.frames.map(frame => frame.id), [7, 11, 19]);
  assert.strictEqual(built.videoDuration, 0.12); assert.strictEqual(built.originPtsTicks, '1000');
  assert.deepStrictEqual(input, before); assert.notStrictEqual(built.frames[0], input[0]);
  const value = info(built); assert.strictEqual(validateIndex(value), value);
});

test('VFR boundaries choose the last source PTS not after the target', () => {
  const built = buildIndex(rows([0, 40, 160, 170], [1, 1000]), { lastFrameEndTicks: '400' });
  const frames = built.frames;
  assert.strictEqual(frameAt(frames, -1), 0); assert.strictEqual(frameAt(frames, 0), 0);
  assert.strictEqual(frameAt(frames, 0.03999), 0); assert.strictEqual(frameAt(frames, 0.04), 1);
  assert.strictEqual(frameAt(frames, 0.15999), 1); assert.strictEqual(frameAt(frames, 0.16), 2);
  assert.strictEqual(frameAt(frames, 0.17), 3); assert.strictEqual(frameAt(frames, 0.4), 3);
  assert.strictEqual(frameAt(frames, 99), 3); validateIndex(info(built));
});

test('duplicate PTS are separate ordinal frames and time seek uses the final duplicate', () => {
  const built = buildIndex(rows([10, 10, 20, 20, 40], [1, 1000], [2, 8, 12, 13, 21]), { lastFrameEndTicks: '50' });
  assert.deepStrictEqual(built.frames.map(frame => frame.time), [0, 0, 0.01, 0.01, 0.03]);
  assert.deepStrictEqual(built.frames.map(frame => frame.end), [0, 0.01, 0.01, 0.03, 0.04]);
  assert.strictEqual(frameAt(built.frames, 0), 1); assert.strictEqual(frameAt(built.frames, 0.01), 3);
  let ordinal = 0; const visited = [built.frames[ordinal].id];
  for (let i = 0; i < 4; i++) { ordinal = stepIndex(built.frames, ordinal, 1); visited.push(built.frames[ordinal].id); }
  assert.deepStrictEqual(visited, [2, 8, 12, 13, 21]);
  assert.strictEqual(stepIndex(built.frames, 3, -1), 2); validateIndex(info(built));
});

test('timestamps above Number safe range retain one-tick differences and JSON strings', () => {
  const origin = 9007199254740993n;
  const built = buildIndex(rows([origin, origin + 1n, origin + 4n], [1, 1000]), { lastFrameEndTicks: (origin + 5n).toString() });
  assert.deepStrictEqual(built.frames.map(frame => frame.time), [0, 0.001, 0.004]);
  assert.strictEqual(built.frames[0].ptsTicks, '9007199254740993');
  assert.strictEqual(copy(built).frames[1].ptsTicks, '9007199254740994');
  validateIndex(info(built));
});

test('negative source origin is normalized without changing persisted original PTS', () => {
  const built = buildIndex(rows([-1000, -800, -100], [1, 1000]), { lastFrameEndTicks: '0' });
  assert.deepStrictEqual(built.frames.map(frame => frame.time), [0, 0.2, 0.9]);
  assert.strictEqual(built.videoDuration, 1); assert.strictEqual(built.frames[0].ptsTicks, '-1000');
  validateIndex(info(built));
});

test('final end can use a different stream time base with exact rational subtraction', () => {
  const built = buildIndex(rows([27000, 36000], [1, 90000]), {
    timeBase: [1, 90000], lastFrameEndTicks: '24000', endTimeBase: [1, 48000]
  });
  assert.deepStrictEqual(built.frames.map(frame => frame.time), [0, 0.1]);
  assert.strictEqual(built.videoDuration, 0.2); validateIndex(info(built));
});

test('per-frame rational time bases preserve source order and duplicate instants', () => {
  const input = rows([10, 20, 30], [1, 10]); input[1].timeBase = [1, 20];
  const built = buildIndex(input, { lastFrameEndTicks: '40', endTimeBase: [1, 10] });
  assert.deepStrictEqual(built.frames.map(frame => frame.time), [0, 0, 2]);
  assert.deepStrictEqual(built.frames[1].timeBase, [1, 20]); validateIndex(info(built));
});

test('single source frame requires an explicit positive display interval', () => {
  const built = buildIndex(rows([5], [1, 30]), { lastFrameEndTicks: '6' });
  assert.strictEqual(built.frames.length, 1); assert.strictEqual(built.frames[0].end, 1 / 30);
  assert.strictEqual(stepIndex(built.frames, 0, 1), 0); assert.strictEqual(stepIndex(built.frames, 0, -1), 0);
  validateIndex(info(built));
});

test('missing, nonpositive or contradictory final end is rejected without FPS fallback', () => {
  const input = rows([0, 1], [1, 30]);
  assert.throws(() => buildIndex(input), /end information/);
  assert.throws(() => buildIndex(input, {}), /integer decimal string/);
  assert.throws(() => buildIndex(input, { lastFrameEndTicks: '1' }), /later than/);
  assert.throws(() => buildIndex(input, { lastFrameEndTicks: '0' }), /later than/);
  assert.throws(() => buildIndex(input, { lastFrameEndTicks: '1', endTimeBase: [1, 60] }), /later than/);
});

test('invalid integer timestamps, time bases and descending PTS are rejected', () => {
  for (const value of ['1.5', '1e3', '', '+1', 1, NaN, null]) {
    const input = rows([0, 1], [1, 30]); input[0].ptsTicks = value;
    assert.throws(() => buildIndex(input, { lastFrameEndTicks: '2' }));
  }
  for (const base of [[0, 30], [1, 0], [-1, 30], [1.5, 30], [1, Number.MAX_SAFE_INTEGER + 1], [1], null]) {
    assert.throws(() => buildIndex(rows([0, 1], base), { lastFrameEndTicks: '2' }));
  }
  assert.throws(() => buildIndex(rows([0, 2, 1], [1, 30]), { lastFrameEndTicks: '3' }), /backwards/);
  assert.throws(() => buildIndex([], { lastFrameEndTicks: '3' }), /nonempty/);
});

test('duplicate ids and missing frame resources fail before caching or playback', () => {
  assert.throws(() => buildIndex(rows([0, 1], [1, 30], [7, 7]), { lastFrameEndTicks: '2' }), /own nonnegative/);
  const input = rows([0], [1, 30]); input[0].bytes = 0;
  assert.throws(() => buildIndex(input, { lastFrameEndTicks: '1' }), /bytes/);
  input[0].bytes = 64; input[0].file = '';
  assert.throws(() => buildIndex(input, { lastFrameEndTicks: '1' }), /resource/);
});

test('collapsed distinct timestamps and unrepresentable final intervals fail explicitly', () => {
  const base = [1, Number.MAX_SAFE_INTEGER];
  const atTwenty = BigInt(Number.MAX_SAFE_INTEGER) * 20n;
  assert.throws(() => buildIndex(rows([0n, atTwenty, atTwenty + 1n], base), { lastFrameEndTicks: (atTwenty + 100n).toString() }), /collapse/);
  assert.throws(() => buildIndex(rows([0n, atTwenty], base), { lastFrameEndTicks: (atTwenty + 1n).toString() }), /final display interval/);
});

test('validation rejects changed interval, PTS, duration, dimensions and resource metadata', () => {
  const valid = info(buildIndex(rows([0, 10, 30], [1, 100]), { lastFrameEndTicks: '50' }));
  const bad = edit => { const value = copy(valid); edit(value); assert.throws(() => validateIndex(value)); };
  bad(value => { value.frames[1].time = 0.2; });
  bad(value => { value.frames[0].end = 0.09; });
  bad(value => { value.frames[2].end = value.frames[2].time; });
  bad(value => { value.frames[0].ptsTicks = 0; });
  bad(value => { value.frames[1].ptsTicks = '-1'; });
  bad(value => { value.frames[2].id = value.frames[0].id; });
  bad(value => { value.frames[1].bytes = -1; });
  bad(value => { value.duration = 0.1; });
  bad(value => { value.width = 0; }); bad(value => { value.height = 0.5; });
  bad(value => { value.width = Number.MAX_SAFE_INTEGER; });
});

test('validation permits only numerical roundoff rather than incorrect time intervals', () => {
  const value = info(buildIndex(rows([0, 1, 2, 3], [1, 10]), { lastFrameEndTicks: '4' }));
  value.frames[2].end = 0.2 + 0.1;
  validateIndex(value);
  value.frames[2].end = 0.301;
  assert.throws(() => validateIndex(value), /intervals/);
});

test('audio metadata supports negative offsets and tails beyond the last video frame', () => {
  const built = buildIndex(rows([0, 1], [1, 10]), { lastFrameEndTicks: '2' });
  const audio = { file: 'audio.wav', start: -0.1, duration: 1, bytes: 4096, channels: 2, sampleRate: 48000 };
  const value = info(built, audio); assert.strictEqual(value.duration, 0.9); validateIndex(value);
  const bad = edit => { const other = copy(value); edit(other); assert.throws(() => validateIndex(other)); };
  bad(other => { other.audio.channels = 0; }); bad(other => { other.audio.sampleRate = 0; });
  bad(other => { other.audio.bytes = NaN; }); bad(other => { other.audio.start = Infinity; });
  bad(other => { other.audio.duration = 0; }); bad(other => { other.duration = 0.2; });
});

test('stepping clamps source-frame boundaries without assuming contiguous frame ids', () => {
  const frames = buildIndex(rows([0, 1, 2], [1, 10], [3, 40, 99]), { lastFrameEndTicks: '3' }).frames;
  assert.strictEqual(stepIndex(frames, 1, 1), 2); assert.strictEqual(stepIndex(frames, 1, -1), 0);
  assert.strictEqual(stepIndex(frames, 1, Number.MAX_SAFE_INTEGER), 2);
  assert.strictEqual(stepIndex(frames, 1, -Number.MAX_SAFE_INTEGER), 0);
  assert.strictEqual(stepIndex(frames, 1, 0), 1);
  for (const current of [-1, 3, 1.1, null]) assert.throws(() => stepIndex(frames, current, 1));
  for (const delta of [0.1, Infinity, '1']) assert.throws(() => stepIndex(frames, 1, delta));
  assert.throws(() => frameAt(frames, NaN)); assert.throws(() => frameAt([], 0));
});

test('audio scheduling keeps late starts and skips elapsed early audio without invented silence', () => {
  assert.deepStrictEqual(audioStartPlan(0.2, 0.5, 1, 10), { when: 10.3, offset: 0 });
  assert.deepStrictEqual(audioStartPlan(0.2, -0.3, 1, 10), { when: 10, offset: 0.5 });
  assert.deepStrictEqual(audioStartPlan(0.5, 0.5, 1, 10), { when: 10, offset: 0 });
  assert.strictEqual(audioStartPlan(1.5, 0.5, 1, 10), null);
  assert.strictEqual(audioStartPlan(2, -0.3, 1, 10), null);
  for (const args of [[NaN, 0, 1, 0], [-1, 0, 1, 0], [0, Infinity, 1, 0], [0, 0, 0, 0], [0, 0, 1, -1]]) {
    assert.throws(() => audioStartPlan(...args));
  }
});

console.log(JSON.stringify({ source: 'local-frame-index-unit-tests-not-eagle', passed: true, count: checks.length, checks: checks }, null, 2));
