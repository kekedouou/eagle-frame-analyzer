'use strict';
// Real local FFmpeg checks; these are not Eagle/window/audio-listening tests.
const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const backend = require('./prepare.cjs');
async function gray(jpeg) {
  const child = spawn(backend._test.tools().ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', 'pipe:1'],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', length = 0; const chunks = [];
  const finish = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`JPEG 参考解码失败 ${code}: ${stderr}`))); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
  child.stdout.on('data', data => { length += data.length; if (length > 1280 * 720) { child.kill(); } else chunks.push(data); });
  child.stdin.on('error', () => {}); child.stdin.end(jpeg);
  await finish; assert.strictEqual(length, 1280 * 720); return Buffer.concat(chunks);
}
function barcode(pixels, expected) {
  const b = expected.barcode; let n = 0;
  for (let bit = 0; bit < b.bits; bit++) if (pixels[(b.y + b.sampleYOffset) * 1280 + b.x + bit * b.step + b.sampleXOffset] >= 128) n |= 1 << bit;
  return n;
}
function parserCheck() {
  // Embedded FFD9 belongs to an APP payload, so it must not split a JPEG.
  const bytes = Buffer.from([255,216,255,225,0,6,1,255,217,2,255,218,0,2,9,255,0,217,255,208,9,255,217]);
  const parser = new backend._test.JpegParser(), output = [];
  for (const byte of bytes) output.push(...parser.push(Buffer.from([byte])));
  assert.strictEqual(output.length, 1); assert(output[0].equals(bytes)); assert.strictEqual(parser.buffer.length, 0);
  return { embeddedMarkerInSegment: true, stuffedEntropy: true, restartMarker: true, oneByteChunks: true };
}
async function inspect(info) {
  assert(info.expected && info.frames.length === info.expected.barcodes.length);
  const times = info.expected.times;
  for (let i = 0; i < info.frames.length; i++) {
    assert(Math.abs(info.frames[i].time - times[i]) <= 1 / info.frames[i].timeBase[1] + 1e-7,
      `${info.source.key} frame ${i}: ${info.frames[i].time} != authored ${times[i]}`);
    assert.strictEqual(backend.frameAt(info.frames, info.frames[i].time), i);
    if (i) assert.strictEqual(backend.frameAt(info.frames, info.frames[i].time - 1e-7), i - 1);
  }
  const indices = [...new Set([0, Math.floor(info.frames.length / 2), info.frames.length - 1])], checks = [];
  for (const i of indices) {
    const pixels = await gray(await backend.readAsset(info, info.frames[i].file));
    const actual = barcode(pixels, info.expected); assert.strictEqual(actual, info.expected.barcodes[i]);
    checks.push({ frame: i, actual, expected: info.expected.barcodes[i], sourceTime: info.frames[i].time });
  }
  assert.strictEqual(backend.frameAt(info.frames, -1), 0);
  assert.strictEqual(backend.frameAt(info.frames, info.duration + 1), info.frames.length - 1);
  await assert.rejects(backend.readAsset(info, '../owner.json'));
  if (info.audio) {
    const wav = await backend.readAsset(info, info.audio.file);
    assert.strictEqual(wav.readUInt32LE(4), wav.length - 8);
    assert.strictEqual(wav.readUInt32LE(info.audio.dataOffset - 4), wav.length - info.audio.dataOffset);
    assert(Math.abs(info.audio.duration - info.audio.dataBytes / info.audio.sampleRate / info.audio.channels / 4) < 1e-9);
  }
  return { key: info.source.key, codec: info.source.codec, frames: info.frames.length,
    authoredTimesChecked: times.length, independentJpegBarcodes: checks, audio: info.audio,
    origin: info.metrics.sourceVideoOrigin, metrics: info.metrics,
    limitations: '3 JPEGs were independently pixel-checked; all authored PTS checked. Actual Eagle canvas/audio perception not tested.' };
}
async function main() {
  const report = { source: 'local-node-ffmpeg-not-eagle', runtime: { node: process.versions.node, platform: process.platform },
    startedAt: new Date().toISOString(), parser: parserCheck(), samples: [], cancellation: null, cleanupSafety: null,
    peakNodeRssSampled: process.memoryUsage().rss, testsPassed: false };
  const monitor = setInterval(() => { report.peakNodeRssSampled = Math.max(report.peakNodeRssSampled, process.memoryUsage().rss); }, 100);
  try {
    if (process.argv.includes('--reset')) report.reset = await backend.cleanup();
    // Pre-aborted requests cannot spawn a child or begin writes.
    const before = new AbortController(); before.abort();
    await assert.rejects(backend.prepare('h264-cfr', { signal: before.signal }), error => error.name === 'AbortError');
    const cfr = await backend.prepare('h264-cfr'); report.samples.push(await inspect(cfr));
    const reused = await backend.prepare('h264-cfr'); assert.strictEqual(reused.metrics.reused, true);
    report.reuse = { source: 'h264-cfr', reused: true, totalMs: reused.metrics.totalMs };
    const vfr = await backend.prepare('hevc-vfr'); report.samples.push(await inspect(vfr));
    assert(Math.abs(vfr.metrics.sourceVideoOrigin - vfr.expected.sourceVideoStart) < 1e-5, '生成的合成容器改变了作者视频起点。');
    assert(vfr.audio && vfr.audio.start > 0.1, 'VFR 偏移音频未保留独立起点。');
    const cancel = new AbortController(); let reachedFrames = 0;
    try {
      await backend.prepare('vp9-silent', { signal: cancel.signal, onProgress(progress) { reachedFrames = progress.frames || 0; if (reachedFrames >= 1) cancel.abort(); } });
      // Existing valid cache makes no decode progress; record that and still test pre-aborted behavior.
      report.cancellation = { preAborted: true, midDecode: false, note: 'vp9-silent cache already existed; rerun after safe cleanup for active decode cancellation.' };
    } catch (error) {
      assert.strictEqual(error.name, 'AbortError');
      assert(reachedFrames >= 1);
      report.cancellation = { preAborted: true, midDecode: true, reachedFrames, partialRemaining: fs.readdirSync(backend._test.RUNTIME).filter(n => n.startsWith('partial-')) };
      assert.strictEqual(report.cancellation.partialRemaining.length, 0);
    }
    const silent = await backend.prepare('vp9-silent'); assert.strictEqual(silent.audio, null); report.samples.push(await inspect(silent));
    const sentinel = path.join(backend._test.RUNTIME, 's1-unknown-sentinel.txt');
    fs.writeFileSync(sentinel, 'created only by check-prepare safety test', { flag: 'wx' });
    try {
      await assert.rejects(backend.cleanup(), /未知/);
      assert(fs.existsSync(sentinel)); assert(fs.existsSync(path.join(backend._test.RUNTIME, 'owner.json')));
      report.cleanupSafety = { unknownFileRejected: true, noFilesDeletedBeforeValidation: true };
    } finally { if (fs.existsSync(sentinel)) await fsp.unlink(sentinel); }
    if (process.argv.includes('--baseline')) {
      const original = await backend.prepare('baseline');
      assert.strictEqual(original.source.sha256, '1482d4d245564789866a00dcd8993a3cd3154df49b92d719962762f67e051931');
      report.baseline = { source: original.source, frames: original.frames.length, duration: original.duration,
        audio: original.audio, metrics: original.metrics,
        limitation: 'Original source identity checked; its pixels not independently annotated or frame-verified.' };
    }
    report.disk = { runtime: backend._test.scan(backend._test.RUNTIME, 'runtime').bytes,
      evidence: backend._test.scan(backend._test.EVIDENCE, 'evidence').bytes };
    assert(report.disk.runtime <= backend.LIMITS.runtimeBytes);
    assert(report.disk.evidence <= backend.LIMITS.evidenceBytes);
    report.testsPassed = true;
  } catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
  finally {
    clearInterval(monitor); report.finishedAt = new Date().toISOString();
    const evidence = await backend.saveEvidence('local-prepare-check', report);
    console.log(JSON.stringify({ testsPassed: report.testsPassed, evidence, failure: report.failure || null,
      samples: report.samples.map(s => ({ key: s.key, frames: s.frames, totalMs: s.metrics.totalMs, audioStart: s.audio && s.audio.start })),
      cancellation: report.cancellation, disk: report.disk, baseline: report.baseline && { frames: report.baseline.frames, totalMs: report.baseline.metrics.totalMs } }, null, 2));
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { parserCheck, barcode, inspect };
