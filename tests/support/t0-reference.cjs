'use strict';
// Independent source probe/decode: never uses prepared frame times to construct expectations.
const path = require('path');
const fs = require('fs');
const { createHash } = require('crypto');
const { JpegParser } = require('./t0-media.cjs')._test;
const SCALE = 'scale=1280:720:force_original_aspect_ratio=decrease:flags=bilinear,setsar=1,pad=1280:720:(ow-iw)/2:(oh-ih)/2';
function meanDelta(a, b) {
  if (a.length !== b.length || !a.length) throw new Error('Invalid reference pixels');
  let error = 0; for (let i = 0; i < a.length; i++) error += Math.abs(a[i] - b[i]);
  return error / a.length;
}
function barcode(bytes, expected) {
  const spec = expected.barcode, width = (spec.bits - 1) * spec.step + 1;
  if (bytes.length !== expected.barcodes.length * width) throw new Error('Barcode frame count mismatch');
  return expected.barcodes.map((wanted, i) => {
    let actual = 0, uncertain = false;
    for (let bit = 0; bit < spec.bits; bit++) {
      const value = bytes[i * width + bit * spec.step];
      if (value > 175) actual += 2 ** bit; else if (value >= 80) uncertain = true;
    }
    return { index: i, wanted, actual, uncertain, ok: !uncertain && wanted === actual };
  });
}
function selectedIndices(count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid frame count');
  const indices = new Set([0, count - 1]);
  for (let i = 0; i < Math.min(102, count); i++) indices.add(Math.round(i * (count - 1) / (Math.min(102, count) - 1 || 1)));
  return [...indices].sort((a, b) => a - b);
}
function analyzePcm(bytes, audio, expected) {
  if (!audio) return { present: false, passed: !expected || expected.authoredAudioRelativeStart === null };
  const stride = audio.channels * 4, count = audio.dataBytes / stride;
  if (!Number.isSafeInteger(count) || audio.dataOffset + audio.dataBytes > bytes.length) throw new Error('Invalid reference PCM layout');
  let peak = 0, firstStrong = null;
  for (let n = 0; n < count; n++) for (let channel = 0; channel < audio.channels; channel++) {
    const value = Math.abs(bytes.readFloatLE(audio.dataOffset + n * stride + channel * 4));
    if (!Number.isFinite(value)) throw new Error('Invalid PCM sample');
    peak = Math.max(peak, value); if (firstStrong === null && value > .02) firstStrong = n;
  }
  const firstStrongMediaTime = firstStrong === null ? null : audio.start + firstStrong / audio.sampleRate;
  const expectedBeepTime = expected && expected.beepTime;
  const errorMs = Number.isFinite(expectedBeepTime) && firstStrongMediaTime !== null ? (firstStrongMediaTime - expectedBeepTime) * 1000 : null;
  return { present: true, samplesPerChannel: count, channels: audio.channels, sampleRate: audio.sampleRate,
    pcmStartRelativeToVideo: audio.start, peakAbsoluteAmplitude: peak, firstStrongMediaTime, expectedBeepTime, errorMs,
    diagnosticAmplitudeThreshold: .02, diagnosticAuthoredBeepToleranceMs: 25,
    passed: Number.isFinite(expectedBeepTime) ? errorMs !== null && Math.abs(errorMs) <= 25 : true,
    limitations: ['波形与作者提示音时间的内容核对，不是扬声器/屏幕物理同步测量', 'PCM首样本可含AAC预滚或静音，不能直接当作可听声音起点'] };
}
async function verifyAudio(backend, info) {
  const report = analyzePcm(info.audio ? await backend.readAsset(info, info.audio.file) : Buffer.alloc(0), info.audio, info.expected);
  const evidenceFile = await backend.saveEvidence('local-pcm-reference', { origin: 'local-decoded-PCM-not-speaker-output', source: info.source, report });
  return { ...report, evidenceFile };
}
async function verify(backend, info, options = {}) {
  const selected = info.source.key === 'selected';
  const source = selected ? backend.referenceSource(info) : backend.getConfig().sources.find(s => s.key === info.source.key);
  if (!source) throw new Error('Unregistered reference source');
  const hashBefore = createHash('sha256').update(fs.readFileSync(source.file)).digest('hex');
  if (hashBefore !== source.sha256) throw new Error('Reference source SHA mismatch');
  let peakBufferBytes = 0;
  const tool = async (kind, args, inputFiles, maxBytes = 32 * 1024 ** 2) => {
    const result = await backend.runReadOnlyTool(kind, args, { signal: options.signal, inputFiles, maxBytes,
      ...(selected ? { sourceInfo: info } : {}) });
    peakBufferBytes = Math.max(peakBufferBytes, result.stdout.length); return result.stdout;
  };
  const probe = JSON.parse((await tool('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames',
    '-show_entries', 'stream=time_base,start_pts,duration_ts:frame=pts,best_effort_timestamp,pkt_duration', '-of', 'json', source.file], [source.file])).toString('utf8'));
  const reference = probe.frames || [], stream = probe.streams && probe.streams[0];
  if (!stream || reference.length !== info.frames.length) throw new Error('Independent source frame count mismatch');
  const tb = stream.time_base.split('/').map(BigInt), ownTb = info.frames[0].timeBase || info.timeBase;
  const referenceOrigin = BigInt(reference[0].pts === undefined ? reference[0].best_effort_timestamp : reference[0].pts);
  const ownOrigin = BigInt(info.frames[0].ptsTicks);
  const ptsErrors = [];
  reference.forEach((frame, i) => {
    const value = frame.pts === undefined ? frame.best_effort_timestamp : frame.pts;
    const dt = BigInt(value) - referenceOrigin, prepared = BigInt(info.frames[i].ptsTicks) - ownOrigin;
    const ownTimeBase = info.frames[i].timeBase || ownTb;
    if (!ownTimeBase || dt * tb[0] * BigInt(ownTimeBase[1]) !== prepared * BigInt(ownTimeBase[0]) * tb[1]) ptsErrors.push(i);
  });
  const firstFile = path.basename(info.frames[0].file), start = Number(firstFile.replace(/\.jpg$/i, ''));
  const pattern = path.join(info.cacheDir, '%06d.jpg');
  const cacheInput = ['-framerate', '1', '-start_number', String(start), '-i', pattern];
  const output = ['-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'];
  let pixels;
  if (info.expected && info.expected.barcode) {
    const spec = info.expected.barcode;
    const crop = `format=gray,crop=${(spec.bits - 1) * spec.step + 1}:1:${spec.x + spec.sampleXOffset}:${spec.y + spec.sampleYOffset}`;
    const data = await tool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...cacheInput,
      '-vf', crop, '-pix_fmt', 'gray', ...output], [pattern]);
    const results = barcode(data, info.expected);
    pixels = { method: 'all-authored-barcode-frames-from-decoded-JPEG-pixels', checked: results.length,
      mismatches: results.filter(r => !r.ok), results, accepted: results.every(r => r.ok) };
  } else {
    const indices = selectedIndices(reference.length), expanded = [...new Set(indices.flatMap(i => [Math.max(0, i - 1), i, Math.min(reference.length - 1, i + 1)]))].sort((a, b) => a - b);
    const select = list => `select='${list.map(i => 'eq(n,' + i + ')').join('+')}'`;
    const small = 'scale=160:90:flags=area,format=rgb24', bytesPerFrame = 160 * 90 * 3;
    const originals = await tool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source.file,
      '-vf', `${select(expanded)},${SCALE},${small}`, '-pix_fmt', 'rgb24', ...output], [source.file]);
    const cached = await tool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...cacheInput,
      '-vf', `${select(indices)},${small}`, '-pix_fmt', 'rgb24', ...output], [pattern]);
    if (originals.length !== expanded.length * bytesPerFrame || cached.length !== indices.length * bytesPerFrame) throw new Error('Reference decode count mismatch');
    peakBufferBytes = Math.max(peakBufferBytes, originals.length + cached.length);
    const checks = indices.map((index, n) => {
      const a = cached.subarray(n * bytesPerFrame, (n + 1) * bytesPerFrame);
      const candidates = [index - 1, index, index + 1].filter(i => i >= 0 && i < reference.length).map(id => {
        const pos = expanded.indexOf(id); return { id, error: meanDelta(a, originals.subarray(pos * bytesPerFrame, (pos + 1) * bytesPerFrame)) };
      });
      const target = candidates.find(c => c.id === index), adjacent = candidates.filter(c => c.id !== index);
      // A conservative diagnostic threshold, not a new product visual-quality contract.
      const indistinguishable = adjacent.some(c => Math.abs(c.error - target.error) < .1);
      return { index, meanAbsoluteRgbError: target.error, adjacentCandidates: adjacent,
        classification: target.error > 12 || adjacent.some(c => c.error + .5 < target.error) ? 'mismatch' : indistinguishable ? 'indeterminate-adjacent-similarity' : 'consistent' };
    });
    pixels = { method: 'independent-source-decode-vs-JPEG-160x90-RGB-with-neighbor-candidates', checked: checks.length,
      mismatches: checks.filter(c => c.classification === 'mismatch'), indeterminate: checks.filter(c => c.classification.startsWith('indeterminate')).length,
      diagnosticRgbThreshold: 12, checks, accepted: checks.every(c => c.classification !== 'mismatch') };
  }
  const hashAfter = createHash('sha256').update(fs.readFileSync(source.file)).digest('hex');
  const report = { schema: 'eva-t0-independent-reference-v1', origin: 'local-real-media-tools', executor: 'codex',
    source: { key: source.key, sha256: source.sha256 }, sourceUnchanged: hashAfter === hashBefore,
    independentSourceFrameCount: reference.length, indexedFrameCount: info.frames.length, ptsErrors,
    pixels, referenceDiskBytes: 0, peakReturnedBuffersBytes: peakBufferBytes,
    passed: ptsErrors.length === 0 && pixels.accepted && hashAfter === hashBefore,
    limitations: ['真实源画面仅抽样；有损JPEG与相似相邻帧不能证明每个像素逐帧唯一', 'FFmpeg判图不替代真实Canvas提交、物理显示或人工声画验收', '参考直接使用内存管道，未生成参考媒体文件'] };
  if (options.save !== false) report.evidenceFile = await backend.saveEvidence('local-reference', report);
  return report;
}
function compareJpegPair(index, reference, cached, adjacent) {
  const fingerprint = bytes => {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('Invalid JPEG pairing buffer');
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const target = fingerprint(reference), actual = fingerprint(cached);
  const identical = (a, b) => a.bytes === b.bytes && a.sha256 === b.sha256;
  const neighbors = adjacent.map(value => {
    const candidate = fingerprint(value.bytes);
    return { index: value.index, ...candidate, identicalToReferenceTarget: identical(candidate, target) };
  });
  const matched = identical(target, actual), indistinguishable = neighbors.some(value => value.identicalToReferenceTarget);
  return { index, reference: target, cached: actual, adjacent: neighbors, matched,
    classification: !matched ? 'mismatch' : indistinguishable ? 'identical-target-reference-adjacent-indistinguishable' : 'identical-target-reference-adjacent-distinct' };
}
async function verifyJpegReference(backend, info, options = {}) {
  const selected = info.source.key === 'selected';
  const source = selected ? backend.referenceSource(info) : backend.getConfig().sources.find(value => value.key === info.source.key);
  if (!source) throw new Error('Unregistered JPEG reference source');
  const sourceHash = () => createHash('sha256').update(fs.readFileSync(source.file)).digest('hex');
  const before = sourceHash(); if (before !== source.sha256) throw new Error('JPEG reference source SHA mismatch');
  const indices = options.indices === undefined ? selectedIndices(info.frames.length) : options.indices;
  if (!Array.isArray(indices) || !indices.length || indices.length > 102 || new Set(indices).size !== indices.length ||
      indices.some(n => !Number.isSafeInteger(n) || n < 0 || n >= info.frames.length)) throw new Error('Invalid bounded source reference ordinals');
  const expanded = [...new Set(indices.flatMap(index => [Math.max(0, index - 1), index, Math.min(info.frames.length - 1, index + 1)]))].sort((a, b) => a - b);
  const select = `select='${expanded.map(index => 'eq(n,' + index + ')').join('+')}'`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts', '-threads', '2', '-i', source.file,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `${select},${SCALE}`, '-filter_threads', '1', '-fps_mode', 'passthrough',
    '-c:v', 'mjpeg', '-threads', '2', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'];
  const maximum = 32 * 1024 ** 2;
  const result = await backend.runReadOnlyTool('ffmpeg', args, { signal: options.signal, inputFiles: [source.file], maxBytes: maximum,
    ...(selected ? { sourceInfo: info } : {}) });
  if (result.stdout.length > maximum) throw new Error('JPEG reference output exceeds bounded limit');
  const parser = new JpegParser(), decoded = parser.push(result.stdout);
  if (parser.buffer.length || decoded.length !== expanded.length) throw new Error('JPEG reference frame count or stream termination mismatch');
  const byOrdinal = new Map(expanded.map((index, position) => [index, decoded[position]])), checks = [];
  let largestCachedBytes = 0;
  for (const index of indices) {
    const cached = await backend.readAsset(info, info.frames[index].file);
    largestCachedBytes = Math.max(largestCachedBytes, cached.length);
    checks.push(compareJpegPair(index, byOrdinal.get(index), cached,
      [index - 1, index + 1].filter(value => byOrdinal.has(value)).map(value => ({ index: value, bytes: byOrdinal.get(value) }))));
  }
  const after = sourceHash(), mismatches = checks.filter(value => !value.matched);
  const report = { schema: 'eva-t0-independent-jpeg-pair-reference-v1', origin: 'local-real-media-tools', executor: 'codex',
    source: { key: source.key, sha256: source.sha256 }, sourceUnchanged: before === after,
    method: 'fresh-source-ordinal-selection-720p-q3-JPEG-bytes-and-SHA-vs-registered-cache',
    checked: checks.length, independentSelectedOrdinals: expanded, mismatches,
    adjacentIndistinguishable: checks.filter(value => value.classification === 'identical-target-reference-adjacent-indistinguishable').length,
    checks, referenceOutputBytes: result.stdout.length, referenceOutputLimitBytes: maximum, referenceDiskBytes: 0,
    peakReturnedBuffersBytes: result.stdout.length * 2 + largestCachedBytes,
    resourceScope: 'returned pipe bytes + JPEG parser copy + largest registered cache read; excludes process/GPU/internal FFmpeg buffers',
    passed: before === after && !mismatches.length,
    limitations: ['独立从源按呈现编号重解码与缓存JPEG配对，不从缓存像素生成期望',
      '与缓存生成共享FFmpeg、JPEG解析器和720p/q3配方，不是独立解码器实现或最终逐像素正确性证明',
      '相邻参考JPEG完全一致时仍无法用图像区分对应源帧，需结合原PTS/编号证据',
      '不替代原RGB抽查、全量PTS、真实Canvas、物理显示或人工声画验证',
      '仅固定抽查目标及相邻编号被重解码比较，不宣称全体源帧或任意帧唯一'] };
  if (options.save !== false) report.evidenceFile = await backend.saveEvidence('local-jpeg-pair-reference', report);
  return report;
}
module.exports = { verify, verifyJpegReference, verifyAudio, analyzePcm, meanDelta, barcode, selectedIndices, compareJpegPair };
