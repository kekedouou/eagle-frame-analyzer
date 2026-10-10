'use strict';
// Only existing S1 synthetic bytes are used here. No Eagle library enumeration or new source generation.
const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const backend = require('./prepare.cjs');
function metadataChecks() {
  const probe = (duration, start = 0, formatEnd = duration + start) => ({ streams: [{ codec_type: 'video', duration: String(duration), start_time: String(start) }],
    format: { format_name: 'mov,mp4,m4a', duration: String(formatEnd) } });
  assert.strictEqual(backend._test.validateProbe(probe(30)).duration, 30);
  assert.strictEqual(backend._test.validateProbe(probe(0.1)).duration, 0.1);
  assert.strictEqual(backend._test.validateProbe(probe(4, 40, 44)).duration, 4);
  assert.throws(() => backend._test.validateProbe(probe(30.000001)), /30/);
  assert.throws(() => backend._test.validateProbe(probe(0)), /时长/);
  assert.throws(() => backend._test.validateProbe(probe(-1, 0, 0)), /时长/);
  const ticks = { streams: [{ codec_type: 'video', duration_ts: 900000, time_base: '1/30000', start_time: '40' }],
    format: { format_name: 'mov,mp4', duration: '70' } };
  assert.strictEqual(backend._test.validateProbe(ticks).duration, 30);
  const fallback = { streams: [{ codec_type: 'video', start_time: '40' }], format: { format_name: 'mov,mp4', duration: '44' } };
  assert.throws(() => backend._test.validateProbe(fallback), /安全确认/);
  assert.throws(() => backend._test.validateProbe({ streams: [{ codec_type: 'video', start_time: '2' }], format: { duration: '31' } }), /安全确认/);
  const longAudio = probe(3); longAudio.streams.push({ codec_type: 'audio', duration: '120', start_time: '0' });
  assert.throws(() => backend._test.validateProbe(longAudio), /跨度超过 30/);
  const shifted = probe(4, 40, 44.5); shifted.streams.push({ codec_type: 'audio', duration: '4', start_time: '40.5' });
  assert.strictEqual(backend._test.validateProbe(shifted).mediaSpan, 4.5);
  const audioFallback = probe(3); audioFallback.streams.push({ codec_type: 'audio', start_time: '0' }); audioFallback.format.duration = '31';
  assert.throws(() => backend._test.validateProbe(audioFallback), /跨度超过 30/);
  assert.throws(() => backend._test.validateDecodedDuration({ duration: 30.02, frames: [{ end: 30 }], audio: { start: 0, duration: 30.02 } }), /解码音画跨度/);
  assert.throws(() => backend._test.selectedSnapshot({ id: 'x', filePath: path.join(backend.ROOT, 'wrong.webm'), ext: 'mp4' }), /MP4/);
  assert.throws(() => backend._test.selectedSnapshot({ id: 'x', filePath: path.join(backend.ROOT, 'clip.mp4'), ext: 'webm' }), /MP4/);
  assert.throws(() => backend._test.selectedSnapshot([]), /快照/);
  return { strictThirtySecondBoundary: true, subFiveSeconds: true, positiveOriginNotDuration: true,
    durationTicks: true, ambiguousOffsetFallbackRejected: true, longAudioRejected: true,
    finalDecodedTailGuard: true, nonMp4Rejected: true, invalidSnapshotRejected: true,
    source: 'pure metadata validation; no >30 second video was generated' };
}
function baselinePcm() {
  const audioPath = path.join(backend._test.RUNTIME, 'cache-baseline-1482d4d245564789', 'audio.wav');
  if (!fs.existsSync(audioPath)) return { available: false, note: 'Existing baseline cache absent; no regeneration was attempted.' };
  const st = fs.lstatSync(audioPath);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16 * 1024 ** 2) throw new Error('已有 baseline 音频路径/大小异常。');
  const bytes = fs.readFileSync(audioPath), fmt = backend._test.parseWavHeader(Buffer.from(bytes.subarray(0, 4096)), bytes.length);
  let peak = 0, squared = 0, sampleCount = 0, nonzero = 0, invalid = 0;
  for (let offset = fmt.dataOffset; offset + 4 <= bytes.length; offset += 4) {
    const sample = bytes.readFloatLE(offset);
    if (!Number.isFinite(sample)) { invalid++; continue; }
    peak = Math.max(peak, Math.abs(sample)); squared += sample * sample; sampleCount++; if (sample !== 0) nonzero++;
  }
  return { available: true, sourceSha256: '1482d4d245564789866a00dcd8993a3cd3154df49b92d719962762f67e051931',
    audioPath, audioSha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    channels: fmt.channels, sampleRate: fmt.sampleRate, duration: fmt.duration,
    sampleCount, peak, rms: sampleCount ? Math.sqrt(squared / sampleCount) : null, nonzero, invalid,
    conclusion: nonzero === 0 && invalid === 0 ? 'All decoded PCM samples are digital silence; a track existing does not imply audible content.' : 'Contains nonzero PCM; listening and speaker-output behavior remain untested.' };
}
async function createCopy(source) {
  const runtime = backend._test.RUNTIME, evidence = backend._test.EVIDENCE;
  const sourceBytes = fs.statSync(source).size, id = crypto.randomBytes(8).toString('hex'), dir = path.join(runtime, 'selected-test-' + id);
  const owner = Buffer.from(JSON.stringify({ owner: backend._test.OWNER, root: backend.ROOT, kind: 'selected-test', testId: id }));
  const current = backend._test.scan(runtime, 'runtime').bytes, logs = backend._test.scan(evidence, 'evidence').bytes;
  if (current + sourceBytes + owner.length > backend.LIMITS.runtimeBytes || current + logs + sourceBytes + owner.length > backend.LIMITS.totalBytes) throw new Error('测试复制会超过 S1 限额。');
  // Fixed known paths only; do not follow reparse points or copy arbitrary source directories.
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), owner, { flag: 'wx' });
  const file = path.join(dir, '中文 空格 测试.mp4');
  try { await fsp.copyFile(source, file, fs.constants.COPYFILE_EXCL); return { dir, file }; }
  catch (error) { await backend._test.removeSelectedTestDir(dir); throw error; }
}
async function main() {
  const report = { source: 'local-node-selected-synthetic-check-not-eagle', startedAt: new Date().toISOString(),
    runtime: { node: process.versions.node, platform: process.platform }, testsPassed: false, tests: metadataChecks(),
    baselinePcm: baselinePcm() };
  let copy = null;
  try {
    const sources = await backend.listSources(); assert(sources.some(source => source.key === 'selected'));
    const cfr = path.join(backend._test.RUNTIME, 'fixtures', 'h264-cfr.mp4');
    if (!fs.existsSync(cfr)) throw new Error('需要已有 S1 H.264 合成输入，本检查不会重新生成素材。');
    const hashesBefore = { cfr: await backend._test.hash(cfr) };
    copy = await createCopy(cfr);
    const cancel = new AbortController(); let frameReached = 0;
    try {
      await backend.prepare('selected', { selected: { id: 'cancel-active', name: 'H264取消', filePath: copy.file, ext: 'mp4' },
        signal: cancel.signal, onProgress(progress) { frameReached = progress.frames || 0; if (frameReached) cancel.abort(); } });
      report.tests.cancellation = { activeDecode: false, note: 'An existing selected cache was reused, so this invocation did not exercise active cancellation.' };
    } catch (error) {
      assert.strictEqual(error.name, 'AbortError'); assert(frameReached > 0);
      report.tests.cancellation = { activeDecode: true, frameReached,
        partialRemaining: fs.readdirSync(backend._test.RUNTIME).filter(name => name.startsWith('partial-')) };
      assert.strictEqual(report.tests.cancellation.partialRemaining.length, 0);
    }
    const mutable = { id: 'S1-local-A', name: '中文 空格 测试.mp4', filePath: copy.file, ext: 'mp4' };
    const prepareFirst = backend.prepare('selected', { selected: mutable });
    mutable.id = 'CHANGED-AFTER-CLICK'; mutable.name = 'CHANGED'; mutable.filePath = path.join(copy.dir, 'changed-missing.mp4');
    const first = await prepareFirst;
    assert.strictEqual(first.source.id, 'S1-local-A'); assert.strictEqual(first.source.itemId, 'S1-local-A');
    assert.strictEqual(first.source.filePath, copy.file); assert.strictEqual(first.source.name, '中文 空格 测试.mp4');
    assert.strictEqual(first.source.sha256, hashesBefore.cfr); assert.strictEqual(first.source.hasAudioStream, true);
    assert.strictEqual(first.frames.length, 90); assert.strictEqual(first.expected, null);
    assert((await backend.readAsset(first, first.frames[0].file)).length === first.frames[0].bytes);
    const second = await backend.prepare('selected', { selected: { id: 'S1-local-B', name: '同内容第二素材', filePath: cfr, ext: 'MP4' } });
    assert.strictEqual(second.metrics.reused, true); assert.strictEqual(second.cacheDir, first.cacheDir);
    assert.strictEqual(second.source.id, 'S1-local-B'); assert.strictEqual(second.source.itemId, 'S1-local-B');
    assert.strictEqual(second.source.name, '同内容第二素材'); assert.strictEqual(second.source.label, '同内容第二素材');
    assert.strictEqual(second.source.filePath, cfr); assert.strictEqual(second.source.sha256, first.source.sha256);
    const originalManifest = JSON.parse(fs.readFileSync(path.join(second.cacheDir, 'manifest.json'), 'utf8'));
    report.tests.selected = { source: first.source, reusedSecond: second.source,
      firstWasReused: first.metrics.reused, secondWasReused: true, immutableClickSnapshot: true,
      cacheBuildProvenancePreserved: originalManifest.source.id !== second.source.id,
      generationProvenance: second.metrics.generationProvenance, firstNodeTotalMs: first.metrics.totalMs };
    await assert.rejects(backend.prepare('selected', { selected: { id: 'missing', name: 'missing.mp4', filePath: path.join(copy.dir, 'missing.mp4'), ext: 'mp4' } }), /ENOENT/);
    await assert.rejects(backend.prepare('selected', { selected: { id: 'directory', name: 'directory', filePath: copy.dir, ext: 'mp4' } }));
    const before = new AbortController(); before.abort();
    await assert.rejects(backend.prepare('selected', { selected: { id: 'cancel-before', name: 'cfr', filePath: cfr, ext: 'mp4' }, signal: before.signal }), error => error.name === 'AbortError');
    report.tests.cancellation.preAbort = true;
    assert.strictEqual(await backend._test.hash(cfr), hashesBefore.cfr);
    report.tests.sourcesUnchanged = true; report.tests.nonexistentAndDirectoryRejected = true;
    report.testsPassed = true;
  } catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
  finally {
    if (copy) report.testCopyCleanup = await backend._test.removeSelectedTestDir(copy.dir);
    report.finishedAt = new Date().toISOString();
    const evidence = await backend.saveEvidence('local-selected-check', report);
    console.log(JSON.stringify({ testsPassed: report.testsPassed, evidence, failure: report.failure || null,
      sourceSha: report.tests.selected && report.tests.selected.source.sha256,
      cancellation: report.tests.cancellation, baselinePcm: report.baselinePcm,
      limitation: 'Local synthetic checks only; real Eagle-selected material and audible playback are user tests.' }, null, 2));
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { metadataChecks, baselinePcm };
