'use strict';

// Pure memory tests. No config, real source, FFmpeg, shared cache or evidence I/O.
const assert = require('assert');
const media = require('./support/t0-media.cjs');
const { JpegParser, patchWav, safeName, addBudget, videoEnd, validateReadOnlyFilter } = media._test;
let tests = 0;
function test(name, body) { body(); tests++; console.log('ok ' + name); }
const image = Buffer.from([255, 216, 255, 224, 0, 6, 12, 255, 217, 13, 255, 218, 0, 2, 10, 255, 0, 11, 255, 208, 12, 255, 217]);
test('JPEG APP marker-looking bytes and entropy escapes are retained', () => {
  const parser = new JpegParser(), output = parser.push(image); assert.strictEqual(output.length, 1); assert.deepStrictEqual(output[0], image); assert.strictEqual(parser.buffer.length, 0);
});
test('JPEG fragmented two-frame stream', () => {
  const parser = new JpegParser(), output = [], stream = Buffer.concat([image, image]);
  for (const byte of stream) output.push(...parser.push(Buffer.from([byte])));
  assert.strictEqual(output.length, 2); output.forEach(value => assert.deepStrictEqual(value, image));
});
test('JPEG invalid SOI and segment length fail', () => {
  assert.throws(() => new JpegParser().push(Buffer.from([0, 216])));
  assert.throws(() => new JpegParser().push(Buffer.from([255, 216, 255, 224, 0, 1])));
});
test('Incomplete JPEG does not invent a frame', () => { const parser = new JpegParser(); assert.strictEqual(parser.push(image.subarray(0, image.length - 1)).length, 0); assert(parser.buffer.length > 0); });
function wav(channels = 2) {
  const value = Buffer.alloc(44); value.write('RIFF'); value.writeUInt32LE(0xffffffff, 4); value.write('WAVEfmt ', 8); value.writeUInt32LE(16, 16);
  value.writeUInt16LE(3, 20); value.writeUInt16LE(channels, 22); value.writeUInt32LE(48000, 24); value.writeUInt32LE(48000 * channels * 4, 28);
  value.writeUInt16LE(channels * 4, 32); value.writeUInt16LE(32, 34); value.write('data', 36); value.writeUInt32LE(0xffffffff, 40); return value;
}
test('WAV pipe unknown sizes patched to exact float PCM bytes', () => {
  const header = wav(), fmt = patchWav(header, 44 + 48000 * 8); assert.strictEqual(fmt.duration, 1); assert.strictEqual(header.readUInt32LE(4), 44 + 48000 * 8 - 8); assert.strictEqual(header.readUInt32LE(40), 48000 * 8);
});
test('WAV rejects truncated/unaligned/wrong-rate PCM', () => {
  assert.throws(() => patchWav(wav(), 45)); const header = wav(); header.writeUInt32LE(44100, 24); assert.throws(() => patchWav(header, 52)); assert.throws(() => patchWav(Buffer.alloc(44), 44));
});
test('Strict basename rejects traversal, protocols, drive paths', () => {
  ['../a', '..', 'a/b', 'a\\b', 'C:x', 'file:x', ''].forEach(value => assert.throws(() => safeName(value)));
  assert.strictEqual(safeName('000001.jpg'), '000001.jpg');
});
test('Budget reservation stops before writing beyond cap', () => {
  assert.strictEqual(addBudget(9, 1, 10), 10); assert.throws(() => addBudget(9, 2, 10)); assert.throws(() => addBudget(0, -1, 10)); assert.throws(() => addBudget(Number.MAX_SAFE_INTEGER, 1, Infinity));
});
test('Reliable end uses exact integer stream ticks, no nominal FPS', () => {
  const result = videoEnd({ streams: [{ codec_type: 'video', start_pts: '300', duration_ts: '4000', time_base: '1/1000', r_frame_rate: '30/1' }] });
  assert.strictEqual(result.lastFrameEndTicks, '4300'); assert.deepStrictEqual(result.timeBase, [1, 1000]);
  assert.throws(() => videoEnd({ streams: [{ codec_type: 'video', duration: '4', r_frame_rate: '30/1' }] }));
  assert.throws(() => videoEnd({ streams: [{ codec_type: 'video', start_pts: Number.MAX_SAFE_INTEGER + 1, duration_ts: 4000, time_base: '1/1000' }] }));
});
test('Readonly filter supports the independent reference chains', () => {
  validateReadOnlyFilter("select='eq(n,0)+eq(n,15)',scale=1280:720:force_original_aspect_ratio=decrease:flags=bilinear,setsar=1,pad=1280:720:(ow-iw)/2:(oh-ih)/2,scale=160:90:flags=area,format=rgb24");
  validateReadOnlyFilter('format=gray,crop=257:1:44:48');
});
test('Readonly filter refuses file-writing/external filters and extra graph', () => {
  ['movie=outside.mp4', 'libvmaf=log_path=outside.json', 'scale=160:90,drawtext=textfile=outside.txt', 'select=1;movie=outside.mp4', '[in]scale=160:90[out]', "select='eq(n,0)", 'scale=160:90,'].forEach(value => assert.throws(() => validateReadOnlyFilter(value)));
});
async function final() {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(media.prepare('baseline', { signal: controller.signal }), error => error.name === 'AbortError'); tests++;
  console.log('ok aborted prepare rejects before config/filesystem work');
  console.log('T0 media pure tests passed: ' + tests + '. No media or filesystem side effects.');
}
final().catch(error => { console.error(error.stack); process.exitCode = 1; });
