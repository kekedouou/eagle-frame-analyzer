'use strict';

// Memory fixtures; only this module's own source is read to isolate its private
// registrations in a VM. No config, real media, FFmpeg, cache or evidence I/O.
const assert = require('assert');
const media = require('./support/t0-media.cjs');
const { JpegParser, patchWav, safeName, addBudget, videoEnd, validateSelectedProbe, validateDecodedSpan, currentSource, validateReadOnlyFilter } = media._test;
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
function selectedProbe(duration = '3000', audio = null) {
  return { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3' }, streams: [
    { codec_type: 'video', start_pts: '0', duration_ts: duration, time_base: '1/1000', width: 1280, height: 720 }, ...(audio ? [audio] : [])] };
}
test('Selected strict duration accepts <=30s and rejects >30s', () => {
  assert.strictEqual(validateSelectedProbe(selectedProbe('30000')).mediaSpan, 30);
  assert.throws(() => validateSelectedProbe(selectedProbe('30001')), /30/);
  assert.throws(() => validateSelectedProbe(selectedProbe('0')));
});
test('Selected time offsets are spans; delayed or negative long audio is rejected', () => {
  const probe = selectedProbe('4000', { codec_type: 'audio', start_pts: '500', duration_ts: '4000', time_base: '1/1000' });
  probe.streams[0].start_pts = '300'; assert.strictEqual(validateSelectedProbe(probe).mediaSpan, 4.2);
  assert.throws(() => validateSelectedProbe(selectedProbe('3000', { codec_type: 'audio', start_pts: '0', duration_ts: '120000', time_base: '1/1000' })), /30/);
  assert.throws(() => validateSelectedProbe(selectedProbe('30000', { codec_type: 'audio', start_pts: '-1', duration_ts: '1000', time_base: '1/1000' })), /30/);
});
test('Selected unknown-offset format fallback cannot underestimate a long track', () => {
  const audio = { codec_type: 'audio', start_time: '2' }, probe = selectedProbe('3000', audio); probe.format.duration = '31';
  assert.throws(() => validateSelectedProbe(probe));
  audio.start_time = '0'; assert.throws(() => validateSelectedProbe(probe), /30/);
  probe.format.format_name = 'matroska'; assert.throws(() => validateSelectedProbe(probe), /MP4/);
});
test('Decoded span includes negative audio start and PCM tail', () => {
  assert.strictEqual(validateDecodedSpan({ duration: 3, frames: [{ end: 3 }], audio: { start: -.2, duration: 3 } }), 3.2);
  assert.throws(() => validateDecodedSpan({ duration: 30, frames: [{ end: 30 }], audio: { start: 0, duration: 30.02 } }), /30/);
});
test('Same content reused under another item returns only current identity', () => {
  const file = require('path').resolve('中文 空格.mp4');
  const cached = { sha256: 'same', id: 'old', itemId: 'old', name: 'old', codec: 'h264' };
  const input = { key: 'selected', label: 'new', file, selected: { id: 'new', name: 'new' } };
  const result = currentSource(cached, input); assert.strictEqual(result.id, 'new'); assert.strictEqual(result.itemId, 'new'); assert.strictEqual(result.filePath, file);
  const fixed = currentSource(result, { key: 'baseline', label: 'baseline', file }); assert(!('id' in fixed)); assert(!('itemId' in fixed));
});
function referenceLeaseHarness(configured = false) {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const file = path.join(__dirname, 'support/t0-media.cjs'), registered = new WeakMap();
  const ownRequire = require('module').createRequire(file), module = { exports: {} };
  const noFileSystem = new Proxy({ promises: {} }, { get(target, key) {
    if (key === 'promises') return target.promises;
    throw new Error('VM reference guard unexpectedly accessed filesystem: ' + String(key));
  } });
  const source = Object.freeze({ key: 'selected', sha256: 'a'.repeat(64), file: path.resolve('专用 测试.mp4') });
  const configFile = path.join(__dirname, 'host/t0/config.local.json');
  const config = { ffmpeg: path.resolve('virtual-ffmpeg.exe'), ffprobe: path.resolve('virtual-ffprobe.exe'),
    sources: ['baseline', 'h264-cfr', 'hevc-vfr', 'vp9-silent'].map(key => ({ key, file: path.resolve(key + '.mp4'), sha256: source.sha256 })) };
  const configBytes = Buffer.from(JSON.stringify(config));
  const files = new Set([configFile, config.ffmpeg, config.ffprobe, source.file, ...config.sources.map(value => value.file)]);
  const virtualFileSystem = { promises: {},
    lstatSync(input) { assert(files.has(input)); return { isSymbolicLink: () => false, isFile: () => true, size: configBytes.length }; },
    realpathSync(input) { assert(files.has(input)); return path.resolve(input); },
    readFileSync(input) { assert.strictEqual(input, configFile); return configBytes; },
    existsSync(input) { assert.strictEqual(input, path.join(__dirname, 'host/t0/cache')); return false; }
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
    require: name => name === 'fs' ? configured ? virtualFileSystem : noFileSystem : ownRequire(name), __dirname: path.dirname(file), __filename: file,
    Buffer, process, console, WeakMap: function () { return registered; } }, { filename: file });
  const info = { cacheDir: path.resolve('memory-only-cache'), source: { ...source } };
  const lease = { active: true, cacheDir: info.cacheDir, source };
  registered.set(info, lease); return { api: module.exports, source, info, lease };
}
test('Source reference uses immutable live registration, not caller source fields', () => {
  const { api, source, info } = referenceLeaseHarness();
  info.source.file = require('path').resolve('unapproved.mp4'); info.source.sha256 = 'b'.repeat(64);
  const captured = api.referenceSource(info);
  assert.deepStrictEqual({ ...captured }, source); assert.notStrictEqual(captured, source); assert(Object.isFrozen(captured));
  assert.throws(() => { captured.file = info.source.file; }, TypeError);
  assert.deepStrictEqual({ ...api.referenceSource(info) }, source);
});
test('Source reference rejects absent and cloned handles before filesystem access', () => {
  const { api, info } = referenceLeaseHarness();
  for (const value of [null, undefined, {}, { ...info }]) assert.throws(() => api.referenceSource(value), /live canonical/);
});
test('Source reference rejects released or cache-rebound handles before filesystem access', () => {
  const { api, info, lease } = referenceLeaseHarness();
  lease.active = false; assert.throws(() => api.referenceSource(info), /live canonical/);
  lease.active = true; info.cacheDir = require('path').resolve('another-cache');
  assert.throws(() => api.referenceSource(info), /live canonical/);
});
async function final() {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(media.prepare('baseline', { signal: controller.signal }), error => error.name === 'AbortError'); tests++;
  console.log('ok aborted prepare rejects before config/filesystem work');
  const { api, info, lease } = referenceLeaseHarness();
  for (const value of [null, {}, { ...info }]) await assert.rejects(api.runReadOnlyTool('ffprobe', ['unapproved.mp4'], {
    sourceInfo: value, inputFiles: ['unapproved.mp4'] }), /live canonical/);
  lease.active = false;
  await assert.rejects(api.runReadOnlyTool('ffprobe', [info.source.file], { sourceInfo: info, inputFiles: [info.source.file] }), /live canonical/);
  tests++; console.log('ok readonly tool rejects invalid source grants before config/filesystem work');
  const allowed = referenceLeaseHarness(true), args = ['-i', allowed.source.file, '-q:v', '3', '-f', 'image2pipe', 'pipe:1'];
  const options = { sourceInfo: allowed.info, inputFiles: [allowed.source.file], signal: controller.signal };
  await assert.rejects(allowed.api.runReadOnlyTool('ffmpeg', args, options), error => error.name === 'AbortError');
  await assert.rejects(allowed.api.runReadOnlyTool('ffmpeg', ['-i', allowed.source.file, '-q:v', 'pipe:1'], options), /Unsupported readonly/);
  const unapproved = require('path').resolve('unapproved.mp4'); allowed.info.source.file = unapproved;
  await assert.rejects(allowed.api.runReadOnlyTool('ffmpeg', ['-i', unapproved, 'pipe:1'], { ...options, inputFiles: [unapproved] }), /explicitly registered/);
  tests++; console.log('ok readonly JPEG quality takes one value and live grant never authorizes rebound input');
  console.log('T0 media pure tests passed: ' + tests + '. No media or filesystem side effects.');
}
final().catch(error => { console.error(error.stack); process.exitCode = 1; });
