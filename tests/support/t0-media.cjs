'use strict';

// T0-only, bounded media preparation. This module never imports a PoC module.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { buildIndex, validateIndex } = require('../../plugin/frame-index.cjs');
const { validateSnapshot } = require('./t0-selection.cjs');
const REPO = path.resolve(__dirname, '../..');
const HOST_ROOT = path.join(REPO, 'tests/host/t0');
const CACHE_ROOT = path.join(HOST_ROOT, 'cache');
const RUNS_ROOT = path.join(REPO, 'verification-runs');
const OWNER = 'eagle-video-analysis-T0-v1';
const RECIPE = 'T0-jpeg-q3-720p-pcm-f32-48000-v1';
const MIB = 1024 * 1024;
const LIMITS = Object.freeze({ cacheBytes: 1024 * MIB, referenceBytes: 256 * MIB,
  evidenceBytes: 128 * MIB, evidenceFileBytes: 16 * MIB, ramBytes: 512 * MIB,
  ffmpegRssBytes: 1024 * MIB, metadataBytes: 8 * MIB, jpegBytes: 8 * MIB,
  pipeBufferBytes: 32 * MIB, frames: 2000, duration: 30, timeoutMs: 180000 });
const runId = 't0-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(5).toString('hex');
const runDir = path.join(RUNS_ROOT, runId);
const liveInfos = new WeakMap();
let active = null, evidenceQueue = Promise.resolve();

function fail(message) { throw new Error(message); }
function nonce() { return crypto.randomBytes(12).toString('hex'); }
function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function safeName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === '.' || name === '..') fail('Invalid asset basename.');
  return name;
}
function check(job) {
  if (job && job.failure) throw job.failure;
  if (job && job.signal && job.signal.aborted) { const error = new Error('T0 operation cancelled.'); error.name = 'AbortError'; throw error; }
}
function addBudget(used, delta, maximum) {
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(delta) || !Number.isSafeInteger(used + delta) || delta < 0 || used + delta > maximum) fail('T0 disk/buffer budget exceeded.');
  return used + delta;
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== path.resolve(file)) fail('File must be a regular canonical file: ' + file);
  return stat;
}
function directory(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(dir) !== path.resolve(dir)) fail('Directory links/reparse paths are not allowed: ' + dir);
}
function nonC(dir) {
  if (/^c:/i.test(path.resolve(dir)) || path.parse(path.resolve(dir)).root.toLowerCase() !== path.parse(HOST_ROOT).root.toLowerCase()) fail('T0 outputs must stay on the non-C test-plugin drive.');
}
function readJSON(file, maximum) {
  const size = regular(file).size;
  if (size > maximum) fail('JSON exceeds bounded metadata limit.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function getConfig() {
  const value = readJSON(path.join(HOST_ROOT, 'config.local.json'), LIMITS.metadataBytes);
  for (const kind of ['ffmpeg', 'ffprobe']) {
    if (typeof value[kind] !== 'string' || !path.isAbsolute(value[kind])) fail('Tool requires an explicit absolute path.');
    regular(value[kind]);
  }
  const expected = ['baseline', 'h264-cfr', 'hevc-vfr', 'vp9-silent'];
  if (!Array.isArray(value.sources) || value.sources.length !== expected.length) fail('T0 requires exactly its four existing registered inputs.');
  const keys = new Set();
  for (const input of value.sources) {
    if (!expected.includes(input.key) || keys.has(input.key) || typeof input.file !== 'string' || !path.isAbsolute(input.file) || !/^[0-9a-f]{64}$/.test(input.sha256)) fail('Invalid T0 source registration.');
    keys.add(input.key);
    if (input.expectedFile && !path.isAbsolute(input.expectedFile)) fail('Expected input requires absolute path.');
  }
  return value;
}
async function listSources() { return [{ key: 'selected', label: 'Eagle 当前选中的 MP4', kind: 'explicit-selected-readonly' },
  ...getConfig().sources.map(value => ({ key: value.key, label: value.label, available: fs.existsSync(value.file) }))]; }
async function hashFile(file, job) {
  check(job); regular(file);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: MIB })) { check(job); hash.update(chunk); }
  check(job); return hash.digest('hex');
}
function ownerValue(kind, extra) { return { owner: OWNER, root: CACHE_ROOT, kind, ...extra }; }
function verifyOwner(dir, kind) {
  directory(dir);
  const value = readJSON(path.join(dir, 'owner.json'), LIMITS.metadataBytes);
  if (value.owner !== OWNER || value.root !== CACHE_ROOT || value.kind !== kind) fail('Ownership marker mismatch; no cleanup performed.');
  return value;
}
function ensureCache() {
  directory(HOST_ROOT); nonC(HOST_ROOT);
  if (!fs.existsSync(CACHE_ROOT)) {
    fs.mkdirSync(CACHE_ROOT);
    fs.writeFileSync(path.join(CACHE_ROOT, 'owner.json'), JSON.stringify(ownerValue('root')), { flag: 'wx' });
  }
  verifyOwner(CACHE_ROOT, 'root'); nonC(fs.realpathSync(CACHE_ROOT));
}
function cacheUsage() {
  verifyOwner(CACHE_ROOT, 'root'); let bytes = 0;
  for (const name of fs.readdirSync(CACHE_ROOT)) {
    const file = path.join(CACHE_ROOT, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      if (!/^(?:media-[0-9a-f]{64}-[0-9a-f]{12}|partial-[0-9a-f]{24})$/.test(name)) fail('Unknown cache directory.');
      verifyOwner(file, name.startsWith('media-') ? 'cache' : 'partial');
      for (const child of fs.readdirSync(file)) bytes = addBudget(bytes, regular(path.join(file, child)).size, LIMITS.cacheBytes);
    } else {
      if (!/^(?:owner\.json|writer\.lock|lease-[0-9a-f]{24}\.json)$/.test(name)) fail('Unknown cache root file.');
      bytes = addBudget(bytes, regular(file).size, LIMITS.cacheBytes);
    }
  }
  return bytes;
}
function claim(job) {
  check(job); if (active) fail('Another T0 operation is active in this process.');
  ensureCache(); job.disk = cacheUsage(); job.token = nonce();
  const value = Buffer.from(JSON.stringify(ownerValue('writer', { token: job.token, pid: process.pid })));
  job.disk = addBudget(job.disk, value.length, LIMITS.cacheBytes);
  fs.writeFileSync(path.join(CACHE_ROOT, 'writer.lock'), value, { flag: 'wx' });
  active = job;
  job.abort = () => { for (const child of job.children) child.kill(); };
  if (job.signal) job.signal.addEventListener('abort', job.abort, { once: true });
  check(job);
}
async function unclaim(job) {
  for (const child of job.children) child.kill();
  await Promise.allSettled([...job.finishes]);
  if (job.signal && job.abort) job.signal.removeEventListener('abort', job.abort);
  if (active !== job) return;
  const file = path.join(CACHE_ROOT, 'writer.lock');
  const value = readJSON(file, LIMITS.metadataBytes);
  if (value.owner !== OWNER || value.token !== job.token || value.pid !== process.pid) fail('Writer lock identity changed; refusing deletion.');
  fs.unlinkSync(file); active = null;
}
function newJob(signal) { return { signal, children: new Set(), finishes: new Set(), disk: 0, failure: null }; }
function charge(job, bytes) { check(job); job.disk = addBudget(job.disk, bytes, LIMITS.cacheBytes); }
async function writeAll(job, handle, data, position) {
  let at = 0;
  while (at < data.length) { check(job); const result = await handle.write(data, at, data.length - at, position === undefined ? null : position + at); if (!result.bytesWritten) fail('Zero-byte write.'); at += result.bytesWritten; }
  check(job);
}
async function put(job, dir, name, data) {
  check(job); safeName(name); charge(job, data.length);
  const handle = await fsp.open(path.join(dir, name), 'wx');
  try { await writeAll(job, handle, data); } finally { await handle.close(); }
  check(job);
}
function ownedPartial(job) {
  const dir = path.join(CACHE_ROOT, 'partial-' + nonce());
  const value = Buffer.from(JSON.stringify(ownerValue('partial', { token: job.token })));
  charge(job, value.length); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), value, { flag: 'wx' }); return dir;
}
function removeExact(dir, kind, names) {
  verifyOwner(dir, kind); const actual = fs.readdirSync(dir), expected = new Set(['owner.json', ...names]);
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) fail('Unregistered file prevents cleanup; nothing deleted.');
  // Validate every path before performing the first deletion. Keep owner until last.
  for (const name of actual) { safeName(name); regular(path.join(dir, name)); }
  for (const name of actual) if (name !== 'owner.json') fs.unlinkSync(path.join(dir, name));
  fs.unlinkSync(path.join(dir, 'owner.json')); fs.rmdirSync(dir);
}

// JPEG segment lengths protect marker-looking APP/COM bytes. Entropy FF00 and
// restart markers are not end-of-image. The limits also bound fragmented input.
class JpegParser {
  constructor() { this.buffer = Buffer.alloc(0); }
  push(chunk) {
    addBudget(this.buffer.length, chunk.length, LIMITS.pipeBufferBytes);
    this.buffer = Buffer.concat([this.buffer, chunk]); const output = [];
    while (this.buffer.length) { const end = this.findEnd(); if (end === null) break; output.push(this.buffer.subarray(0, end)); this.buffer = this.buffer.subarray(end); }
    if (this.buffer.length > LIMITS.jpegBytes) fail('JPEG exceeds T0 limit.'); return output;
  }
  findEnd() {
    const b = this.buffer; if (b.length < 2) return null;
    if (b[0] !== 255 || b[1] !== 216) fail('Invalid JPEG SOI.');
    let i = 2, entropy = false;
    while (i < b.length) {
      if (entropy) { while (i < b.length && b[i] !== 255) i++; if (i >= b.length) return null; }
      if (b[i] !== 255) fail('Invalid JPEG marker boundary.');
      let j = i + 1; while (j < b.length && b[j] === 255) j++; if (j >= b.length) return null;
      const marker = b[j];
      if (entropy && (marker === 0 || marker >= 208 && marker <= 215)) { i = j + 1; continue; }
      if (marker === 217) { if (j + 1 > LIMITS.jpegBytes) fail('JPEG exceeds T0 limit.'); return j + 1; }
      if (marker === 216 || marker === 0) fail('Unexpected JPEG marker.');
      if (marker === 1 || marker >= 208 && marker <= 215) { i = j + 1; entropy = false; continue; }
      if (j + 2 >= b.length) return null;
      const length = b.readUInt16BE(j + 1); if (length < 2) fail('Invalid JPEG segment length.');
      const next = j + 1 + length; if (next > b.length) return null;
      entropy = marker === 218; i = next;
    }
    return null;
  }
}
function patchWav(header, total) {
  if (total < 44 || total > 0xffffffff || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') fail('Invalid streamed RIFF/WAVE.');
  let cursor = 12, fmt = null, dataOffset = null, factOffset = null;
  while (cursor + 8 <= header.length) {
    const id = header.toString('ascii', cursor, cursor + 4), size = header.readUInt32LE(cursor + 4);
    if (id === 'data') { dataOffset = cursor + 8; header.writeUInt32LE(total - dataOffset, cursor + 4); break; }
    if (cursor + 8 + size > header.length) fail('WAV header exceeds bounded prefix.');
    if (id === 'fmt ') {
      if (size < 16) fail('WAV fmt chunk too short.');
      fmt = { format: header.readUInt16LE(cursor + 8), channels: header.readUInt16LE(cursor + 10), sampleRate: header.readUInt32LE(cursor + 12), blockAlign: header.readUInt16LE(cursor + 20), bits: header.readUInt16LE(cursor + 22) };
    }
    if (id === 'fact') { if (size < 4) fail('Invalid WAV fact chunk.'); factOffset = cursor + 8; }
    cursor += 8 + size + (size & 1);
  }
  if (!fmt || dataOffset === null || !fmt.channels || fmt.channels > 8 || fmt.sampleRate !== 48000 || fmt.blockAlign !== fmt.channels * 4 || fmt.bits !== 32 || ![3, 65534].includes(fmt.format) || total <= dataOffset || (total - dataOffset) % fmt.blockAlign) fail('Incomplete PCM float WAV header.');
  header.writeUInt32LE(total - 8, 4);
  if (factOffset !== null) header.writeUInt32LE((total - dataOffset) / fmt.blockAlign, factOffset);
  return { ...fmt, dataOffset, dataBytes: total - dataOffset, duration: (total - dataOffset) / fmt.blockAlign / fmt.sampleRate };
}

function rssMonitor(job, child, metrics) {
  if (process.platform !== 'win32') { metrics.rssNote = 'Windows working-set sampler unavailable on this platform.'; return async () => {}; }
  // One helper samples the owned FFmpeg PID. Startup/100ms sampling can miss peaks.
  const script = '$ErrorActionPreference="Stop"; try {$p=[Diagnostics.Process]::GetProcessById(' + child.pid + '); while(!$p.HasExited){$p.Refresh(); [Console]::WriteLine(([string]$p.WorkingSet64)+","+([string]$p.PeakWorkingSet64)); Start-Sleep -Milliseconds 100}} catch {}';
  const monitor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = '', count = 0; metrics.rssSamples = 0; metrics.peakRssBytes = null;
  const finished = new Promise(resolve => { monitor.once('close', resolve); monitor.once('error', resolve); });
  monitor.stdout.on('data', chunk => {
    count += chunk.length;
    if (count > 1024 * 1024) { job.failure = job.failure || new Error('RSS sampling log exceeded bound.'); child.kill(); monitor.kill(); return; }
    pending += chunk.toString('ascii'); const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines) {
      const pair = /^(\d+),(\d+)$/.exec(line); if (!pair) continue;
      const peak = Math.max(Number(pair[1]), Number(pair[2])); metrics.rssSamples++; metrics.peakRssBytes = Math.max(metrics.peakRssBytes || 0, peak);
      if (peak >= LIMITS.ffmpegRssBytes) { job.failure = job.failure || new Error('FFmpeg observed RSS reached the 1GiB stop line.'); child.kill(); }
    }
  });
  metrics.rssNote = 'Owned FFmpeg working set/OS-reported peak; ~100ms requested samples after helper startup. Short jobs/instantaneous peaks may be missed; not total plugin RAM or a hard OS cap.';
  return async () => { monitor.kill(); await finished; };
}
function childProcess(job, tool, args, stdio, sample) {
  check(job); const metrics = { pid: null, startedAt: new Date().toISOString() }, started = process.hrtime.bigint();
  const child = spawn(tool, args, { windowsHide: true, shell: false, stdio });
  metrics.pid = child.pid || null; job.children.add(child); let spawnError = null;
  child.once('error', error => { spawnError = error; });
  const close = new Promise(resolve => child.once('close', (code, signal) => { job.children.delete(child); resolve({ code, signal, error: spawnError }); }));
  const stopMonitor = sample && child.pid ? rssMonitor(job, child, metrics) : async () => {};
  const timer = setTimeout(() => { job.failure = job.failure || new Error('T0 tool timeout.'); child.kill(); }, LIMITS.timeoutMs);
  const finish = close.then(async result => { clearTimeout(timer); await stopMonitor(); metrics.totalMs = Number(process.hrtime.bigint() - started) / 1e6; return { ...result, metrics }; });
  job.finishes.add(finish); finish.finally(() => job.finishes.delete(finish));
  check(job); return { child, finish, metrics };
}
async function capture(job, tool, args, maximum, sample) {
  const { child, finish } = childProcess(job, tool, args, ['ignore', 'pipe', 'pipe'], sample);
  const chunks = [], errors = []; let bytes = 0, errorBytes = 0;
  child.stdout.on('data', chunk => { try { check(job); bytes = addBudget(bytes, chunk.length, maximum); chunks.push(chunk); } catch (error) { job.failure = job.failure || error; child.kill(); } });
  child.stderr.on('data', chunk => { try { errorBytes = addBudget(errorBytes, chunk.length, LIMITS.metadataBytes); errors.push(chunk); } catch (error) { job.failure = job.failure || error; child.kill(); } });
  const exit = await finish; check(job);
  const stderr = Buffer.concat(errors).toString('utf8');
  if (exit.error || exit.code !== 0) throw exit.error || new Error('Tool exited ' + exit.code + ': ' + stderr.slice(-8000));
  return { stdout: Buffer.concat(chunks, bytes), stderr, metrics: { ...exit.metrics, stdoutBytes: bytes, stderrBytes: errorBytes } };
}
function videoEnd(probe) {
  const stream = probe.streams.find(value => value.codec_type === 'video');
  if (!stream || !/^-?\d+$/.test(String(stream.start_pts)) || !/^\d+$/.test(String(stream.duration_ts)) || BigInt(stream.duration_ts) <= 0n || !/^\d+\/\d+$/.test(String(stream.time_base))) fail('T0 requires reliable video start_pts + duration_ts; no nominal-frame fallback.');
  for (const value of [stream.start_pts, stream.duration_ts]) if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('ffprobe numeric timestamp exceeded exact JSON integer precision.');
  const timeBase = stream.time_base.split('/').map(Number);
  if (timeBase.some(value => !Number.isSafeInteger(value) || value <= 0)) fail('Invalid source video time base.');
  return { stream, timeBase, lastFrameEndTicks: String(BigInt(stream.start_pts) + BigInt(stream.duration_ts)) };
}
function ratio(ticks, base) { return { n: BigInt(ticks) * BigInt(base[0]), d: BigInt(base[1]) }; }
function decimalRatio(value, label) {
  const text = String(value), match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || !Number.isFinite(Number(text))) fail('无法可靠确认' + label + '。');
  const fraction = match[3] || '', denominator = 10n ** BigInt(fraction.length);
  return { n: BigInt((match[1] || '') + match[2] + fraction), d: denominator };
}
function ratioAdd(a, b) { return { n: a.n * b.d + b.n * a.d, d: a.d * b.d }; }
function ratioSubtract(a, b) { return { n: a.n * b.d - b.n * a.d, d: a.d * b.d }; }
function ratioCompare(a, b) { const value = a.n * b.d - b.n * a.d; return value < 0n ? -1 : value > 0n ? 1 : 0; }
function ratioSeconds(value) { const result = Number(value.n / value.d) + Number(value.n % value.d) / Number(value.d); if (!Number.isFinite(result)) fail('媒体时间无法表示。'); return result; }
function streamRatio(stream, field, fallback) {
  const integer = stream[field], base = String(stream.time_base || '').split('/').map(Number);
  if (integer != null && /^-?\d+$/.test(String(integer)) && base.length === 2 && base.every(value => Number.isSafeInteger(value) && value > 0)) {
    if (typeof integer === 'number' && !Number.isSafeInteger(integer)) fail('音频时间戳超过 JSON 整数精度。');
    return ratio(integer, base);
  }
  if (stream[fallback] != null && stream[fallback] !== 'N/A') return decimalRatio(stream[fallback], '音频' + fallback);
  return null;
}
function validateSelectedProbe(probe) {
  if (!probe || !Array.isArray(probe.streams)) fail('选中视频的探测数据无效。');
  const formats = String(probe.format && probe.format.format_name || '').split(',');
  if (!formats.includes('mp4') && !formats.includes('mov')) fail('选中文件内容不是 MP4 容器。');
  const end = videoEnd(probe), video = end.stream;
  if (!(video.width > 0 && video.height > 0) || video.disposition && video.disposition.attached_pic) fail('首视频流不是可播放的视频画面。');
  const start = ratio(video.start_pts, end.timeBase), videoDuration = ratio(video.duration_ts, end.timeBase);
  if (videoDuration.n <= 0n || videoDuration.n > BigInt(LIMITS.duration) * videoDuration.d) fail('T0 当前只支持不超过 30 秒的视频。');
  let first = start, last = ratioAdd(start, videoDuration);
  const audio = probe.streams.find(value => value.codec_type === 'audio');
  if (audio) {
    const audioStart = streamRatio(audio, 'start_pts', 'start_time');
    if (!audioStart) fail('首音频流的时间原点不明确，不能安全确认 30 秒上限。');
    let audioDuration = streamRatio(audio, 'duration_ts', 'duration');
    if (!audioDuration) {
      // format.duration may mean a span or an absolute end. Only a zero-origin
      // input can use it as a conservative bound; never subtract a guessed start.
      if (audioStart.n !== 0n || start.n !== 0n || !probe.format || probe.format.duration == null) fail('首音频流时长缺失，不能安全确认 30 秒上限。');
      audioDuration = decimalRatio(probe.format.duration, '音频保守时长上界');
    }
    if (audioDuration.n <= 0n) fail('首音频流没有可确认的正时长。');
    const audioEnd = ratioAdd(audioStart, audioDuration);
    if (ratioCompare(audioStart, first) < 0) first = audioStart;
    if (ratioCompare(audioEnd, last) > 0) last = audioEnd;
  }
  const span = ratioSubtract(last, first);
  if (span.n <= 0n || span.n > BigInt(LIMITS.duration) * span.d) fail('首音视频的实际跨度超过 30 秒，T0 暂不处理。');
  return { videoDuration: ratioSeconds(videoDuration), mediaSpan: ratioSeconds(span), hasAudioStream: !!audio };
}
function validateDecodedSpan(info) {
  const first = Math.min(0, info.audio ? info.audio.start : 0);
  const last = Math.max(info.duration, info.frames[info.frames.length - 1].end, info.audio ? info.audio.start + info.audio.duration : 0);
  const span = last - first;
  if (!Number.isFinite(span) || !(span > 0 && span <= LIMITS.duration)) fail('实际解码音视频跨度超过 30 秒（含音频尾部填充），不提交该缓存。');
  return span;
}
function currentSource(cached, input) {
  // A cache is content-owned; Eagle identity belongs only to this load request.
  const { id, itemId, name, ...base } = cached;
  return { ...base, key: input.key, label: input.label, file: input.file, filePath: input.file,
    ...(input.selected ? { id: input.selected.id, itemId: input.selected.id, name: input.selected.name } : {}) };
}
async function build(job, input, probe, partial, onProgress, generated) {
  const end = videoEnd(probe), hasAudio = probe.streams.some(value => value.codec_type === 'audio');
  const config = getConfig();
  const args = ['-hide_banner', '-loglevel', 'info', '-nostdin', '-copyts', '-threads', '2', '-i', input.file,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', 'showinfo@v=checksum=0,scale=1280:720:force_original_aspect_ratio=decrease:flags=bilinear,setsar=1,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-filter_threads', '1', '-fps_mode', 'passthrough', '-c:v', 'mjpeg', '-threads', '2', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'];
  if (hasAudio) args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'aresample=48000,ashowinfo@a', '-c:a', 'pcm_f32le', '-f', 'wav', 'pipe:3');
  const { child, finish } = childProcess(job, config.ffmpeg, args, ['ignore', 'pipe', 'pipe', hasAudio ? 'pipe' : 'ignore'], true);
  const parser = new JpegParser(), files = [], pts = []; let timeBase = null, audioFirst = null, stderrBytes = 0, pending = '', tail = '';
  function line(value) {
    if (value.includes('showinfo@v')) {
      const base = /config in time_base:\s*(\d+)\/(\d+)/.exec(value);
      if (base) timeBase = [Number(base[1]), Number(base[2])];
      const frame = /n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/.exec(value);
      if (frame) { if (pts.length >= LIMITS.frames || Number(frame[1]) !== pts.length) fail('Video PTS count/order exceeds T0 boundary.'); pts.push({ id: Number(frame[1]), ptsTicks: frame[2] }); }
    }
    if (value.includes('ashowinfo@a') && audioFirst === null) { const first = /n:\s*0\s+pts:\s*(-?\d+)\s+pts_time:/.exec(value); if (first) audioFirst = first[1]; }
  }
  child.stderr.on('data', chunk => {
    try { stderrBytes = addBudget(stderrBytes, chunk.length, LIMITS.metadataBytes); tail = (tail + chunk.toString('utf8')).slice(-8000); pending += chunk.toString('utf8'); const lines = pending.split(/\r?\n/); pending = lines.pop(); for (const value of lines) line(value); }
    catch (error) { job.failure = job.failure || error; child.kill(); }
  });
  const video = (async () => {
    for await (const chunk of child.stdout) {
      check(job);
      for (const jpeg of parser.push(chunk)) {
        const id = files.length; if (id >= LIMITS.frames) fail('T0 frame count limit.');
        const file = String(id).padStart(6, '0') + '.jpg'; generated.add(file);
        await put(job, partial, file, jpeg); files.push({ id, file, bytes: jpeg.length, sha256: sha(jpeg) });
        if (onProgress && id % 20 === 0) onProgress({ stage: 'decode', frames: files.length, cacheBytes: job.disk });
      }
    }
  })();
  const audio = (async () => {
    if (!hasAudio) return null;
    generated.add('audio.wav'); const handle = await fsp.open(path.join(partial, 'audio.wav'), 'wx+'); let bytes = 0;
    try {
      for await (const chunk of child.stdio[3]) { check(job); charge(job, chunk.length); await writeAll(job, handle, chunk); bytes += chunk.length; }
      const header = Buffer.alloc(Math.min(bytes, 4096)); const read = await handle.read(header, 0, header.length, 0); check(job);
      if (read.bytesRead !== header.length) fail('Truncated WAV header read.');
      const fmt = patchWav(header, bytes); await writeAll(job, handle, header.subarray(0, fmt.dataOffset), 0);
      return { file: 'audio.wav', bytes, sampleRate: fmt.sampleRate, channels: fmt.channels, duration: fmt.duration, dataOffset: fmt.dataOffset, dataBytes: fmt.dataBytes };
    } finally { await handle.close(); }
  })();
  const guarded = [video, audio].map(value => value.catch(error => { job.failure = job.failure || error; child.kill(); throw error; }));
  const results = await Promise.allSettled(guarded), exit = await finish; check(job);
  if (pending) line(pending);
  if (exit.error || exit.code !== 0) throw exit.error || new Error('Media tool exited ' + exit.code + ': ' + tail);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  if (!timeBase || !pts.length || pts.length !== files.length || parser.buffer.length) fail('Incomplete PTS/JPEG output.');
  const indexed = buildIndex(pts.map((value, i) => ({ ...value, ...files[i] })), { timeBase, lastFrameEndTicks: end.lastFrameEndTicks, endTimeBase: end.timeBase });
  const origin = Number(BigInt(indexed.originPtsTicks)) * timeBase[0] / timeBase[1];
  let mediaAudio = results[1].value;
  if (mediaAudio) {
    if (audioFirst === null) fail('Decoded audio first PTS missing.');
    // Rational subtraction before Number preserves small cross-time-base offsets.
    const numerator = BigInt(audioFirst) * BigInt(timeBase[1]) - BigInt(indexed.originPtsTicks) * BigInt(timeBase[0]) * 48000n;
    const denominator = 48000n * BigInt(timeBase[1]);
    mediaAudio = { ...mediaAudio, start: Number(numerator / denominator) + Number(numerator % denominator) / Number(denominator), sourceFirstPts: audioFirst, sourceTimeBase: [1, 48000], sha256: await hashFile(path.join(partial, 'audio.wav'), job) };
  }
  const duration = Math.max(indexed.videoDuration, mediaAudio ? mediaAudio.start + mediaAudio.duration : 0);
  if (!(duration > 0 && duration <= LIMITS.duration)) fail('Decoded media exceeds the strict 30 second T0 limit.');
  let expected = null;
  if (input.expectedFile) { const value = readJSON(input.expectedFile, LIMITS.metadataBytes); if (value.sha256 !== input.sha256 || !value.expected) fail('Author expected-input fingerprint mismatch.'); expected = value.expected; }
  const source = currentSource({ sha256: input.sha256, codec: end.stream.codec_name, width: end.stream.width,
    height: end.stream.height, hasAudioStream: hasAudio }, input);
  const info = { schema: 1, owner: OWNER, recipe: RECIPE, source, width: 1280, height: 720, duration, frames: indexed.frames, audio: mediaAudio, expected,
    metrics: { reused: false, generationMs: exit.metrics.totalMs, tool: exit.metrics, sourceVideoOrigin: origin,
      lastFrameEnd: 'source first-video start_pts + duration_ts (rational time-base conversion)', singleVideoDecode: true,
      audioMapping: 'First decoded/resampled audio PTS minus first displayed video PTS. AAC edit/preroll behavior beyond the registered specimens remains a T0 limitation.',
      frameBytes: files.reduce((sum, value) => sum + value.bytes, 0), audioBytes: mediaAudio ? mediaAudio.bytes : 0, stderrBytes, args, limits: LIMITS } };
  validateIndex(info); info.metrics.decodedMediaSpanSeconds = validateDecodedSpan(info); return info;
}
function assets(info) { return [...info.frames, ...(info.audio ? [info.audio] : [])]; }
async function validateCache(dir, job, kind = 'cache') {
  verifyOwner(dir, kind); const info = readJSON(path.join(dir, 'manifest.json'), LIMITS.metadataBytes);
  if (info.owner !== OWNER || info.recipe !== RECIPE || info.schema !== 1 || !(info.duration > 0 && info.duration <= LIMITS.duration)) fail('Invalid T0 complete cache.');
  validateIndex(info);
  validateDecodedSpan(info);
  const names = new Set(['owner.json', 'manifest.json', ...assets(info).map(value => safeName(value.file))]);
  const actual = fs.readdirSync(dir);
  if (actual.length !== names.size || actual.some(name => !names.has(name))) fail('Unregistered complete-cache files.');
  for (const value of assets(info)) {
    check(job); if (regular(path.join(dir, value.file)).size !== value.bytes || await hashFile(path.join(dir, value.file), job) !== value.sha256) fail('Cache asset size/hash mismatch.');
  }
  check(job); return info;
}
function addLease(job, info) {
  const id = nonce(), file = path.join(CACHE_ROOT, 'lease-' + id + '.json');
  const value = Buffer.from(JSON.stringify(ownerValue('lease', { token: id, pid: process.pid, cacheDir: info.cacheDir })));
  charge(job, value.length); fs.writeFileSync(file, value, { flag: 'wx' });
  // Keep an independent canonical registration. Callers may clone or change
  // their info, but cannot grant themselves a new file/size/hash through it.
  const assetMap = new Map(assets(info).map(value => [value.file, Object.freeze({ file: value.file, bytes: value.bytes, sha256: value.sha256 })]));
  info.leaseId = id; liveInfos.set(info, { id, file, cacheDir: info.cacheDir, assetMap, active: true,
    source: Object.freeze({ key: info.source.key, sha256: info.source.sha256, file: info.source.file }) }); return info;
}
async function prepare(key, options = {}) {
  const job = newJob(options.signal), started = process.hrtime.bigint(); check(job);
  // Copy before the first await. Later Eagle selection changes cannot redirect
  // this job or its evidence to a different material.
  const selection = key === 'selected' ? validateSnapshot(options.selected) : null;
  let partial = null, generated = new Set();
  try {
    claim(job); check(job);
    const config = getConfig();
    const input = selection ? { key: 'selected', label: selection.name, file: selection.filePath,
      sha256: await hashFile(selection.filePath, job), selected: selection } : config.sources.find(value => value.key === key);
    if (!input) fail('Unknown registered T0 source.');
    if (path.extname(input.file).toLowerCase() !== '.mp4') fail('T0 input must be MP4.');
    if (!selection && await hashFile(input.file, job) !== input.sha256) fail('Registered input SHA256 changed; no media prepared.');
    let probe = null, selectedMetadata = null;
    if (selection) {
      const captured = await capture(job, config.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input.file], LIMITS.metadataBytes, false); check(job);
      probe = JSON.parse(captured.stdout.toString('utf8')); selectedMetadata = validateSelectedProbe(probe);
    }
    const target = path.join(CACHE_ROOT, 'media-' + input.sha256 + '-' + sha(Buffer.from(RECIPE)).slice(0, 12));
    let info;
    if (fs.existsSync(target)) {
      info = await validateCache(target, job); check(job);
      if (info.source.sha256 !== input.sha256) fail('Complete-cache source fingerprint mismatch.');
      if (await hashFile(input.file, job) !== input.sha256) fail('Input changed while validating the reusable cache.');
      info.source = currentSource(info.source, input);
      info.metrics = { ...info.metrics, reused: true, generationProvenance: { generationMs: info.metrics.generationMs, args: info.metrics.args }, totalMs: Number(process.hrtime.bigint() - started) / 1e6 };
    } else {
      if (options.reuseOnly) fail('本次定向对照只复用现有完整缓存；缓存缺失，不重新生成媒体。');
      if (!probe) { const captured = await capture(job, config.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input.file], LIMITS.metadataBytes, false); check(job); probe = JSON.parse(captured.stdout.toString('utf8')); }
      videoEnd(probe);
      partial = ownedPartial(job); info = await build(job, input, probe, partial, options.onProgress, generated); check(job);
      if (await hashFile(input.file, job) !== input.sha256) fail('Input changed during preparation.');
      info.metrics.totalMs = Number(process.hrtime.bigint() - started) / 1e6;
      generated.add('manifest.json'); await put(job, partial, 'manifest.json', Buffer.from(JSON.stringify(info, null, 2))); check(job);
      await validateCache(partial, job, 'partial'); check(job);
      // No asynchronous cancellation boundary between marker change and same-volume publish.
      const ownerBytes = Buffer.from(JSON.stringify(ownerValue('cache', { token: job.token })));
      const oldBytes = regular(path.join(partial, 'owner.json')).size;
      if (ownerBytes.length > oldBytes) charge(job, ownerBytes.length - oldBytes);
      fs.writeFileSync(path.join(partial, 'owner.json'), ownerBytes);
      fs.renameSync(partial, target); partial = null;
    }
    if (selectedMetadata) info.metrics = { ...info.metrics, selectedMetadata };
    info.cacheDir = target; check(job); return addLease(job, info);
  } catch (error) {
    for (const child of job.children) child.kill(); await Promise.allSettled([...job.finishes]);
    if (partial && fs.existsSync(partial)) {
      try { const owner = readJSON(path.join(partial, 'owner.json'), LIMITS.metadataBytes); if (owner.token !== job.token) fail('Partial ownership token changed.'); removeExact(partial, owner.kind, [...generated].filter(name => fs.existsSync(path.join(partial, name)))); }
      catch (cleanupError) { error.cleanupError = cleanupError.message; }
    }
    throw error;
  } finally { await unclaim(job); }
}
async function readAsset(info, file) {
  const lease = liveInfos.get(info); if (!lease || !lease.active || lease.cacheDir !== info.cacheDir) fail('A live canonical T0 cache lease is required.');
  safeName(file); verifyOwner(lease.cacheDir, 'cache');
  const value = lease.assetMap.get(file); if (!value || value.bytes > LIMITS.referenceBytes) fail('Unregistered or oversized asset.');
  const absolute = path.join(lease.cacheDir, file); const pathStat = regular(absolute);
  const handle = await fsp.open(absolute, 'r');
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size !== value.bytes || before.ino !== pathStat.ino || before.dev !== pathStat.dev) fail('Asset identity/size changed before read.');
    const data = Buffer.alloc(value.bytes); let at = 0;
    while (at < data.length) { const result = await handle.read(data, at, data.length - at, at); if (!result.bytesRead) fail('Truncated asset read.'); at += result.bytesRead; }
    const after = await handle.stat();
    if (after.size !== value.bytes || before.mtimeMs !== after.mtimeMs || sha(data) !== value.sha256) fail('Asset changed during read.');
    return data;
  } finally { await handle.close(); }
}
function release(info) {
  const lease = liveInfos.get(info); if (!lease || !lease.active) return false;
  const value = readJSON(lease.file, LIMITS.metadataBytes);
  if (value.owner !== OWNER || value.token !== lease.id || value.pid !== process.pid || value.cacheDir !== lease.cacheDir) fail('Lease identity changed; refusing deletion.');
  fs.unlinkSync(lease.file); lease.active = false; return true;
}
async function cleanup(infoOrKey) {
  const job = newJob();
  try {
    claim(job); let target;
    if (typeof infoOrKey === 'string') {
      const input = getConfig().sources.find(value => value.key === infoOrKey); if (!input) fail('Cleanup requires one registered key.');
      target = path.join(CACHE_ROOT, 'media-' + input.sha256 + '-' + sha(Buffer.from(RECIPE)).slice(0, 12));
    } else if (infoOrKey && liveInfos.has(infoOrKey)) {
      const lease = liveInfos.get(infoOrKey);
      if (infoOrKey.cacheDir !== lease.cacheDir) fail('Caller cache identity changed; cleanup refused.');
      target = lease.cacheDir;
    }
    else fail('Cleanup requires one explicit T0 cache; global reset is not provided.');
    if (path.dirname(target) !== CACHE_ROOT || !/^media-[0-9a-f]{64}-[0-9a-f]{12}$/.test(path.basename(target))) fail('Cleanup target out of bounds.');
    for (const name of fs.readdirSync(CACHE_ROOT).filter(value => /^lease-/.test(value))) {
      const lease = readJSON(path.join(CACHE_ROOT, name), LIMITS.metadataBytes);
      if (lease.owner !== OWNER || lease.kind !== 'lease' || lease.root !== CACHE_ROOT || !lease.cacheDir) fail('Unknown lease blocks cleanup.');
      if (lease.cacheDir === target) fail('Live or unproven-stale cache lease blocks cleanup. Dispose/release first; T0 does not guess stale ownership.');
    }
    if (!fs.existsSync(target)) return { removed: false };
    const info = await validateCache(target, job);
    removeExact(target, 'cache', ['manifest.json', ...assets(info).map(value => value.file)]); return { removed: true };
  } finally { await unclaim(job); }
}

function evidenceInfo() {
  const usageBytes = evidenceUsage();
  return { runId, runDir, limits: LIMITS, usageBytes, remainingBytes: LIMITS.evidenceBytes - usageBytes };
}
function evidenceUsage() {
  if (!fs.existsSync(RUNS_ROOT)) return 0; directory(RUNS_ROOT); let bytes = 0;
  for (const name of fs.readdirSync(RUNS_ROOT).filter(value => value.startsWith('t0-'))) {
    const dir = path.join(RUNS_ROOT, name); directory(dir);
    const marker = readJSON(path.join(dir, 'owner.json'), LIMITS.metadataBytes);
    if (marker.owner !== OWNER || marker.kind !== 'evidence' || marker.root !== CACHE_ROOT) fail('Unknown T0 evidence directory.');
    for (const child of fs.readdirSync(dir)) { if (child !== 'owner.json' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(child)) fail('Unknown T0 evidence file.'); bytes = addBudget(bytes, regular(path.join(dir, child)).size, LIMITS.evidenceBytes); }
  }
  return bytes;
}
function saveEvidence(kind, value) {
  const task = evidenceQueue.then(async () => {
    const job = newJob();
    try {
    claim(job); safeName(kind); nonC(HOST_ROOT);
    const bytes = Buffer.from(JSON.stringify({ ...value, owner: OWNER, savedAt: new Date().toISOString() }, null, 2));
    if (bytes.length > LIMITS.evidenceFileBytes) fail('Evidence file exceeds 16MiB; old evidence is never evicted.');
    let used = evidenceUsage();
    if (!fs.existsSync(RUNS_ROOT)) fs.mkdirSync(RUNS_ROOT);
    directory(RUNS_ROOT);
    if (!fs.existsSync(runDir)) {
      const marker = Buffer.from(JSON.stringify(ownerValue('evidence', { runId })));
      used = addBudget(used, marker.length, LIMITS.evidenceBytes); fs.mkdirSync(runDir); fs.writeFileSync(path.join(runDir, 'owner.json'), marker, { flag: 'wx' });
    }
    directory(runDir); addBudget(used, bytes.length, LIMITS.evidenceBytes);
    const file = path.join(runDir, kind + '-' + Date.now() + '-' + nonce().slice(0, 8) + '.json');
    await fsp.writeFile(file, bytes, { flag: 'wx' }); return file;
    } finally { await unclaim(job); }
  });
  evidenceQueue = task.catch(() => {}); return task;
}
function inputAllowlist(config) {
  const result = new Set(config.sources.map(value => path.resolve(value.file)));
  if (fs.existsSync(CACHE_ROOT)) for (const name of fs.readdirSync(CACHE_ROOT).filter(value => /^media-/.test(value))) {
    const dir = path.join(CACHE_ROOT, name); verifyOwner(dir, 'cache');
    const info = readJSON(path.join(dir, 'manifest.json'), LIMITS.metadataBytes); validateIndex(info);
    for (const asset of assets(info)) result.add(path.join(dir, safeName(asset.file)));
    result.add(path.join(dir, '%06d.jpg'));
  }
  return result;
}
function validateReadOnlyFilter(value) {
  // These six built-ins neither open external inputs nor write logs/files.
  // Split only unquoted/unescaped commas: select expressions contain commas.
  if (typeof value !== 'string' || !value || /[;\[\]\r\n]/.test(value)) fail('Readonly reference accepts only a simple video filter chain.');
  const filters = []; let part = '', quote = null, escaped = false;
  for (const character of value) {
    if (escaped) { part += character; escaped = false; continue; }
    if (character === '\\') { part += character; escaped = true; continue; }
    if (quote) { part += character; if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; part += character; continue; }
    if (character === ',') { filters.push(part.trim()); part = ''; } else part += character;
  }
  if (quote || escaped) fail('Unterminated readonly filter quoting.');
  filters.push(part.trim());
  for (const filter of filters) if (!/^(?:select|scale|setsar|pad|format|crop)(?:=|$)/.test(filter)) fail('Unsupported readonly filter; only select/scale/setsar/pad/format/crop are permitted.');
}
async function runReadOnlyTool(kind, args, options = {}) {
  if (!['ffmpeg', 'ffprobe'].includes(kind) || !Array.isArray(args) || args.some(value => typeof value !== 'string')) fail('Invalid readonly tool call.');
  const config = getConfig(), allowed = inputAllowlist(config), inputs = options.inputFiles;
  if (!Array.isArray(inputs) || !inputs.length || inputs.some(file => !allowed.has(path.resolve(file)))) fail('Readonly tools require explicitly registered inputFiles.');
  if (args.some(value => ['-report', '-o', '-y', '-n', '-progress', '-filter_script', '-filter_complex_script', '-attach', '-dump_attachment'].includes(value))) fail('Readonly tool cannot write output/report files.');
  if (kind === 'ffmpeg') {
    if (args[args.length - 1] !== 'pipe:1') fail('Readonly FFmpeg output must be pipe:1.');
    const actual = args.filter((value, i) => i > 0 && args[i - 1] === '-i');
    if (!actual.length || actual.length !== inputs.length || actual.some(file => !inputs.some(input => path.resolve(input) === path.resolve(file)))) fail('Tool inputs differ from explicit registered list.');
    // A trusted T0 reference caller supplies one output only; reject additional protocols/targets.
    if (args.slice(0, -1).some(value => /^(?:pipe:|https?:|concat:|file:)/i.test(value))) fail('Unexpected reference protocol.');
    // Explicit option arity prevents another positional filename becoming a
    // second FFmpeg output. Filters are authored by the trusted T0 reference test.
    const flags = new Set(['-hide_banner', '-nostdin', '-copyts']);
    const valued = new Set(['-loglevel', '-v', '-threads', '-filter_threads', '-filter_complex_threads', '-i', '-map', '-vf', '-filter:v', '-filter_complex', '-an', '-sn', '-dn', '-vsync', '-fps_mode', '-pix_fmt', '-f', '-frames:v', '-vframes', '-start_number', '-pattern_type', '-framerate', '-c:v', '-codec:v']);
    for (let i = 0; i < args.length - 1; i++) {
      const option = args[i];
      if (flags.has(option) || ['-an', '-sn', '-dn'].includes(option)) continue;
      if (!valued.has(option) || i + 1 >= args.length - 1) fail('Unsupported readonly FFmpeg option/output: ' + option);
      if (['-vf', '-filter:v', '-filter_complex'].includes(option)) validateReadOnlyFilter(args[i + 1]);
      i++;
    }
  } else if (args[args.length - 1] !== inputs[0] || inputs.length !== 1) fail('Readonly ffprobe requires one explicit final input.');
  for (const input of inputs) if (!input.includes('%06d.jpg')) regular(input);
  const maximum = options.maxBytes === undefined ? LIMITS.referenceBytes : options.maxBytes;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > LIMITS.referenceBytes) fail('Invalid reference output buffer limit.');
  const job = newJob(options.signal); check(job);
  try { claim(job); return await capture(job, config[kind], args, maximum, kind === 'ffmpeg'); }
  finally { await unclaim(job); }
}

module.exports = { HOST_ROOT, CACHE_ROOT, LIMITS, listSources, prepare, readAsset, cleanup, release,
  saveEvidence, evidenceInfo, getConfig, runReadOnlyTool,
  _test: { JpegParser, patchWav, safeName, addBudget, videoEnd, validateSelectedProbe, validateDecodedSpan, currentSource, validateReadOnlyFilter, OWNER, RECIPE } };
