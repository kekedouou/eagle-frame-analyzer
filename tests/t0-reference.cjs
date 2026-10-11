'use strict';
const assert = require('assert');
const { meanDelta, barcode, selectedIndices, analyzePcm, compareJpegPair } = require('./support/t0-reference.cjs');
assert.strictEqual(meanDelta(Buffer.from([0, 10]), Buffer.from([2, 6])), 3);
assert.throws(() => meanDelta(Buffer.from([1]), Buffer.from([])));
assert.strictEqual(selectedIndices(828).length, 102);
assert.strictEqual(selectedIndices(828)[101], 827);
assert.deepStrictEqual(selectedIndices(1), [0]);
const expected = { barcode: { bits: 3, step: 2 }, barcodes: [5, 2] };
assert(barcode(Buffer.from([255, 0, 0, 0, 255, 0, 0, 255, 0, 0]), expected).every(r => r.ok));
assert.strictEqual(barcode(Buffer.from([128, 0, 0, 0, 255, 0, 0, 255, 0, 0]), expected)[0].ok, false);
assert.throws(() => barcode(Buffer.from([1]), expected));
const pcm = Buffer.alloc(16); pcm.writeFloatLE(.1, 8);
const sound = analyzePcm(pcm, { channels: 1, sampleRate: 1000, start: -.001, dataOffset: 0, dataBytes: 16 }, { beepTime: .001 });
assert.strictEqual(sound.errorMs, 0); assert.strictEqual(sound.passed, true);
assert.strictEqual(analyzePcm(Buffer.alloc(0), null, { authoredAudioRelativeStart: null }).passed, true);
assert.strictEqual(analyzePcm(pcm, { channels: 1, sampleRate: 1000, start: 1, dataOffset: 0, dataBytes: 16 }, { beepTime: .001 }).passed, false);
const jpegTarget = Buffer.from('reference-target'), jpegAdjacent = Buffer.from('reference-adjacent');
const matched = compareJpegPair(1, jpegTarget, Buffer.from(jpegTarget), [{ index: 0, bytes: jpegAdjacent }]);
assert.strictEqual(matched.matched, true); assert.strictEqual(matched.classification, 'identical-target-reference-adjacent-distinct');
const wrongPair = compareJpegPair(1, jpegTarget, jpegAdjacent, [{ index: 0, bytes: jpegAdjacent }]);
assert.strictEqual(wrongPair.matched, false); assert.strictEqual(wrongPair.classification, 'mismatch');
const repeated = compareJpegPair(1, jpegTarget, jpegTarget, [{ index: 0, bytes: Buffer.from(jpegTarget) }]);
assert.strictEqual(repeated.matched, true); assert.strictEqual(repeated.classification, 'identical-target-reference-adjacent-indistinguishable');
assert.strictEqual(repeated.adjacent[0].identicalToReferenceTarget, true);
assert.strictEqual(compareJpegPair(0, jpegTarget, Buffer.concat([jpegTarget, Buffer.from([0])]), []).matched, false);
assert.throws(() => compareJpegPair(0, Buffer.alloc(0), jpegTarget, []), /Invalid/);
async function selectedSourceForwarding() {
  const fs = require('fs'), path = require('path'), vm = require('vm'), { createHash } = require('crypto');
  const file = path.join(__dirname, 'support/t0-reference.cjs'), ownRequire = require('module').createRequire(file);
  const pixels = Buffer.from('in-memory dedicated source'), sourceFile = path.resolve('专用 测试.mp4');
  const hash = createHash('sha256').update(pixels).digest('hex'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
    require: name => name === 'fs' ? { readFileSync: input => { assert.strictEqual(input, sourceFile); return pixels; } } : ownRequire(name),
    Buffer, __dirname: path.dirname(file), __filename: file }, { filename: file });
  for (const selected of [true, false]) {
    const source = { key: selected ? 'selected' : 'baseline', file: sourceFile, sha256: hash };
    const info = { source: { key: source.key, file: 'caller-rebound.mp4', sha256: 'b'.repeat(64) } };
    const stop = new Error('Stop after checking readonly reference input');
    let calls = 0, configCalls = 0, grantCalls = 0;
    const backend = {
      getConfig() { configCalls++; assert(!selected); return { sources: [source] }; },
      referenceSource(value) { grantCalls++; assert(selected); assert.strictEqual(value, info); return Object.freeze({ ...source }); },
      async runReadOnlyTool(kind, args, options) {
        calls++; assert.strictEqual(kind, 'ffprobe'); assert.strictEqual(args[args.length - 1], sourceFile);
        assert.strictEqual(options.inputFiles.length, 1); assert.strictEqual(options.inputFiles[0], sourceFile);
        if (selected) assert.strictEqual(options.sourceInfo, info); else assert(!('sourceInfo' in options));
        throw stop;
      }
    };
    await assert.rejects(module.exports.verify(backend, info, { save: false }), error => error === stop);
    assert.strictEqual(calls, 1); assert.strictEqual(configCalls, selected ? 0 : 1); assert.strictEqual(grantCalls, selected ? 1 : 0);
  }
  // Structurally delimited test bytes, not real JPEG decoding or media output.
  const frames = [1, 2, 3].map(value => Buffer.from([255, 216, 255, 218, 0, 2, value, 255, 217]));
  const info = { source: { key: 'selected' }, frames: frames.map((bytes, index) => ({ file: String(index) + '.jpg' })) };
  let jpegToolCalls = 0, jpegReadCalls = 0;
  const backend = {
    referenceSource(value) { assert.strictEqual(value, info); return { key: 'selected', file: sourceFile, sha256: hash }; },
    async runReadOnlyTool(kind, args, options) {
      jpegToolCalls++; assert.strictEqual(kind, 'ffmpeg'); assert.strictEqual(options.sourceInfo, info);
      assert.strictEqual(options.maxBytes, 32 * 1024 ** 2); assert.strictEqual(options.inputFiles[0], sourceFile);
      assert.strictEqual(args[args.indexOf('-q:v') + 1], '3'); assert.strictEqual(args[args.length - 1], 'pipe:1');
      assert(args[args.indexOf('-vf') + 1].startsWith("select='eq(n,0)+eq(n,1)+eq(n,2)',scale=1280:720"));
      assert(!args.some(value => value.includes('showinfo'))); return { stdout: Buffer.concat(frames) };
    },
    async readAsset(value, file) { jpegReadCalls++; assert.strictEqual(value, info); return frames[Number(file.split('.')[0])]; }
  };
  const paired = await module.exports.verifyJpegReference(backend, info, { save: false });
  assert.strictEqual(paired.checked, 3); assert.strictEqual(paired.passed, true); assert.strictEqual(paired.adjacentIndistinguishable, 0);
  assert.strictEqual(paired.sourceUnchanged, true); assert.strictEqual(paired.referenceDiskBytes, 0);
  assert.strictEqual(jpegToolCalls, 1); assert.strictEqual(jpegReadCalls, 3);
  backend.readAsset = async () => frames[0];
  const mismatched = await module.exports.verifyJpegReference(backend, info, { save: false });
  assert.strictEqual(mismatched.passed, false); assert.strictEqual(mismatched.mismatches.length, 2);
  backend.runReadOnlyTool = async () => ({ stdout: Buffer.concat(frames.slice(0, 2)) });
  await assert.rejects(module.exports.verifyJpegReference(backend, info, { save: false }), /frame count/);
}
selectedSourceForwarding().then(() => {
  console.log('t0-reference: independent sampling, pixel metric, ambiguous barcode and live selected source forwarding passed');
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
