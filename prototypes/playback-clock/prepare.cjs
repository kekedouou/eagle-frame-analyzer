'use strict';
// Isolated S1 backend. Node 16 compatible; no Eagle metadata API and no original-file writes.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const fixtures = require('./fixtures.cjs');
const ROOT = __dirname, RUNTIME = path.join(ROOT, 'runtime'), EVIDENCE = path.join(ROOT, 'evidence');
const OWNER = 'eagle-video-analysis-S1-v1';
const BASELINE_SHA = '1482d4d245564789866a00dcd8993a3cd3154df49b92d719962762f67e051931';
const LIMITS = Object.freeze({ totalBytes: 512 * 1024 ** 2, runtimeBytes: 480 * 1024 ** 2,
  evidenceBytes: 32 * 1024 ** 2, evidenceFileBytes: 8 * 1024 ** 2, jpegBytes: 8 * 1024 ** 2,
  pipeBufferBytes: 32 * 1024 ** 2, metadataBytes: 8 * 1024 ** 2, frames: 2400, timeoutMs: 120000 });
let activeJob = null;
let savingEvidence = false;
const registered = new Map();
function abortError() { const error = new Error('S1 任务已取消。'); error.name = 'AbortError'; return error; }
function check(job) { if (job && (job.cancelled || job.signal && job.signal.aborted)) throw abortError(); }
function realDirectory(dir) {
  const resolved = path.resolve(dir), st = fs.lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(resolved).toLowerCase() !== resolved.toLowerCase())
    throw new Error('拒绝链接或重解析目录：' + dir);
  return resolved;
}
function safeFile(dir, name) {
  realDirectory(dir);
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('无效的实验文件名。');
  const target = path.join(dir, name);
  if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error('拒绝链接或非普通文件。');
  return target;
}
function ensureRoot(dir, kind) {
  realDirectory(ROOT);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ owner: OWNER, kind, root: ROOT }), { flag: 'wx' }); }
  realDirectory(dir);
  const owner = JSON.parse(fs.readFileSync(safeFile(dir, 'owner.json'), 'utf8'));
  if (owner.owner !== OWNER || owner.root !== ROOT || owner.kind !== kind) throw new Error('实验目录所有权不符。');
}
function scan(dir, kind) {
  if (!fs.existsSync(dir)) return { bytes: 0, files: [] };
  realDirectory(dir);
  const owner = JSON.parse(fs.readFileSync(safeFile(dir, 'owner.json'), 'utf8'));
  if (owner.owner !== OWNER || owner.root !== ROOT || owner.kind !== kind) throw new Error('目录所有权不符：' + dir);
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (kind !== 'runtime' || !/^(fixtures|partial-[a-f0-9]{16}|cache-(baseline|h264-cfr|hevc-vfr|vp9-silent)-[a-f0-9]{16})$/.test(entry.name)) throw new Error('含未知子目录，停止操作。');
      files.push(...scan(target, entry.name === 'fixtures' ? 'fixtures' : 'cache').files);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('含链接或未知文件类型，停止操作。');
    const allowed = entry.name === 'owner.json' || kind === 'fixtures' && /^(h264-cfr|hevc-vfr|vp9-silent)\.(mp4|json)$/.test(entry.name)
      || kind === 'cache' && /^(\d{6}\.jpg|audio\.wav|manifest\.json)$/.test(entry.name)
      || kind === 'evidence' && /^[a-z][a-z0-9-]*-\d{4}-\d{2}-\d{2}T[a-zA-Z0-9.-]+-[a-f0-9]{8}\.json$/.test(entry.name);
    if (!allowed) throw new Error('含未知文件，停止操作：' + entry.name);
    safeFile(dir, entry.name); files.push({ path: target, bytes: fs.statSync(target).size });
  }
  return { bytes: files.reduce((n, f) => n + f.bytes, 0), files };
}
function budget(job) {
  check(job); ensureRoot(RUNTIME, 'runtime'); ensureRoot(EVIDENCE, 'evidence');
  const runtime = scan(RUNTIME, 'runtime').bytes, evidence = scan(EVIDENCE, 'evidence').bytes;
  if (runtime > LIMITS.runtimeBytes || evidence > LIMITS.evidenceBytes || runtime + evidence > LIMITS.totalBytes) throw new Error('已有 S1 数据超出实验限额；未开始生成。');
  return { runtime, evidence };
}
function charge(job, bytes, area = 'runtime') {
  check(job); const next = job.disk[area] + bytes;
  if (next > LIMITS[area + 'Bytes'] || next + job.disk[area === 'runtime' ? 'evidence' : 'runtime'] > LIMITS.totalBytes) throw new Error('S1 产物到达共同磁盘限额，停止写入。');
  job.disk[area] = next;
}
async function put(job, dir, name, bytes) {
  check(job); charge(job, bytes.length);
  await fsp.writeFile(safeFile(dir, name), bytes, { flag: 'wx' }); check(job);
}
async function hash(file, job) {
  const value = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) { check(job); value.update(bytes); }
  check(job); return value.digest('hex');
}
function tools() {
  const current = path.join(ROOT, 'tools-s1.json'), old = path.join(ROOT, '..', 'window-player', 'tools-b.json');
  const data = JSON.parse(fs.readFileSync(fs.existsSync(current) ? current : old, 'utf8'));
  if (!path.isAbsolute(data.ffmpeg || '') || !path.isAbsolute(data.ffprobe || '') || !fs.existsSync(data.ffmpeg) || !fs.existsSync(data.ffprobe)) throw new Error('需要本机已有 FFmpeg/ffprobe 配置；不会安装。');
  return data;
}
async function listSources() {
  return [{ key: 'baseline', label: '原 B 专用 VP9 / 4K 样本（SHA256 核对）', kind: 'dedicated-original' },
    ...Object.entries(fixtures.SPECS).map(([key, spec]) => ({ key, label: spec.label, kind: 'synthetic', seconds: spec.seconds }))];
}
async function baseline(tool, job) {
  const dir = path.dirname(tool.sourcePath || '');
  if (!path.isAbsolute(dir) || path.basename(dir) !== 'MUXL6QI4AJIAG.info' || tool.testItemId && tool.testItemId !== 'MUXL6QI4AJIAG') throw new Error('配置不属于获准的专用素材目录。');
  realDirectory(dir);
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    check(job);
    if (!entry.isFile() || !/\.mp4$/i.test(entry.name)) continue;
    const file = path.join(dir, entry.name), st = await fsp.lstat(file); check(job);
    if (st.isSymbolicLink() || st.size !== 18476311) continue;
    if (await hash(file, job) === BASELINE_SHA) return { file, sha256: BASELINE_SHA, expected: null };
  }
  throw new Error('专用目录中未找到与原 B SHA256 匹配的视频；不会改用其他素材。');
}
function createChild(job, exe, args, stdio) {
  check(job);
  const child = spawn(exe, args, { windowsHide: true, shell: false, stdio });
  job.children.add(child);
  const finish = new Promise(resolve => { child.once('error', error => { child.s1Error = error; }); child.once('close', (code, signal) => { job.children.delete(child); resolve({ code, signal, error: child.s1Error }); }); });
  const timer = setTimeout(() => { job.failure = new Error('S1 工具执行超时。'); child.kill(); }, LIMITS.timeoutMs);
  finish.then(() => clearTimeout(timer));
  return { child, finish };
}
async function writeAll(job, handle, bytes, position = null) {
  let offset = 0;
  while (offset < bytes.length) {
    check(job);
    const result = await handle.write(bytes, offset, bytes.length - offset, position === null ? null : position + offset);
    if (!result.bytesWritten) throw new Error('实验文件写入没有进展。');
    offset += result.bytesWritten; check(job);
  }
}
function childMemory(pid) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const exe = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object WorkingSet64,PeakWorkingSet64 | ConvertTo-Json -Compress`],
    { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      try { resolve(error ? null : JSON.parse(stdout)); } catch (_) { resolve(null); }
    });
  });
}
async function collect(job, exe, args) {
  const { child, finish } = createChild(job, exe, args, ['ignore', 'pipe', 'pipe']);
  let bytes = 0, stderr = ''; const chunks = [];
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  try {
    for await (const chunk of child.stdout) { check(job); bytes += chunk.length; if (bytes > LIMITS.metadataBytes) throw new Error('S1 元数据输出超限。'); chunks.push(chunk); }
    const result = await finish; check(job);
    if (job.failure || result.error || result.code !== 0) throw job.failure || result.error || new Error(`工具退出 ${result.code}: ${stderr}`);
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) { child.kill(); await finish; throw error; }
}
// JPEG marker parser: lengths protect marker-like bytes in APP/COM/table payloads.
// In entropy data only unstuffed markers end a scan; FF00 and restart markers stay inside it.
class JpegParser {
  constructor() { this.buffer = Buffer.alloc(0); }
  push(chunk) {
    if (this.buffer.length + chunk.length > LIMITS.pipeBufferBytes) throw new Error('JPEG 管道缓冲超限。');
    this.buffer = Buffer.concat([this.buffer, chunk]); const output = [];
    while (this.buffer.length) {
      const end = this.findEnd(); if (end === null) break;
      output.push(this.buffer.subarray(0, end)); this.buffer = this.buffer.subarray(end);
    }
    if (this.buffer.length > LIMITS.jpegBytes) throw new Error('单 JPEG 超过 S1 实验上限。');
    return output;
  }
  findEnd() {
    const b = this.buffer;
    if (b.length < 2) return null;
    if (b[0] !== 255 || b[1] !== 216) throw new Error('JPEG SOI 错误。');
    let i = 2, entropy = false;
    while (i < b.length) {
      if (entropy) { while (i < b.length && b[i] !== 255) i++; if (i >= b.length) return null; }
      if (b[i] !== 255) throw new Error('JPEG 标记边界错误。');
      let j = i + 1; while (j < b.length && b[j] === 255) j++; if (j >= b.length) return null;
      const marker = b[j];
      if (entropy && (marker === 0 || marker >= 208 && marker <= 215)) { i = j + 1; continue; }
      if (marker === 217) { if (j + 1 > LIMITS.jpegBytes) throw new Error('单 JPEG 超过上限。'); return j + 1; }
      if (marker === 216 || marker === 0) throw new Error('意外 JPEG 标记。');
      if (marker === 1 || marker >= 208 && marker <= 215) { i = j + 1; entropy = false; continue; }
      if (j + 2 >= b.length) return null;
      const length = b.readUInt16BE(j + 1); if (length < 2) throw new Error('JPEG 段长度错误。');
      const next = j + 1 + length; if (next > b.length) return null;
      entropy = marker === 218; i = next;
    }
    return null;
  }
}
async function createOwned(job, dir, kind) {
  check(job);
  const owner = Buffer.from(JSON.stringify({ owner: OWNER, root: ROOT, kind, jobId: job.id }));
  charge(job, owner.length);
  // No asynchronous cancellation boundary may leave a new directory without its owner marker.
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), owner, { flag: 'wx' });
  check(job);
}
async function runFixture(job, tool, key, args, expected) {
  const dir = path.join(RUNTIME, 'fixtures');
  if (!fs.existsSync(dir)) await createOwned(job, dir, 'fixtures');
  scan(dir, 'fixtures');
  const file = safeFile(dir, key + '.mp4'), meta = safeFile(dir, key + '.json');
  if (fs.existsSync(file) && fs.existsSync(meta)) {
    const old = JSON.parse(await fsp.readFile(meta, 'utf8')); check(job);
    if (old.owner !== OWNER || old.sha256 !== await hash(file, job) || JSON.stringify(old.expected) !== JSON.stringify(expected)) throw new Error('合成输入校验失败；请先安全清理 S1 产物。');
    return { file, sha256: old.sha256, expected };
  }
  if (fs.existsSync(file) || fs.existsSync(meta)) throw new Error('合成输入不完整；请先安全清理 S1 产物。');
  const { child, finish } = createChild(job, tool.ffmpeg, args, ['ignore', 'pipe', 'pipe']);
  let stderr = '', handle, bytes = 0;
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  try {
    handle = await fsp.open(file, 'wx'); check(job);
    for await (const chunk of child.stdout) { check(job); charge(job, chunk.length); await writeAll(job, handle, chunk); bytes += chunk.length; }
    await handle.close(); handle = null;
    const result = await finish; check(job);
    if (job.failure || result.error || result.code !== 0) throw job.failure || result.error || new Error(`合成工具退出 ${result.code}: ${stderr}`);
    const sha256 = await hash(file, job);
    await put(job, dir, key + '.json', Buffer.from(JSON.stringify({ owner: OWNER, sha256, bytes, expected }, null, 2)));
    return { file, sha256, expected };
  } catch (error) {
    child.kill(); await finish; if (handle) await handle.close();
    // These exact two paths were exclusively created by this attempt; never remove other fixtures.
    for (const owned of [meta, file]) if (fs.existsSync(owned)) { safeFile(dir, path.basename(owned)); await fsp.unlink(owned); }
    throw error;
  }
}
function parseWavHeader(header, total) {
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('音频未生成 RIFF/WAVE。');
  let cursor = 12, fmt = null, dataOffset = null, factOffset = null;
  while (cursor + 8 <= header.length) {
    const id = header.toString('ascii', cursor, cursor + 4), size = header.readUInt32LE(cursor + 4);
    if (id === 'fmt ') fmt = { format: header.readUInt16LE(cursor + 8), channels: header.readUInt16LE(cursor + 10), sampleRate: header.readUInt32LE(cursor + 12), blockAlign: header.readUInt16LE(cursor + 20), bits: header.readUInt16LE(cursor + 22) };
    if (id === 'fact') factOffset = cursor + 8;
    if (id === 'data') { dataOffset = cursor + 8; header.writeUInt32LE(total - dataOffset, cursor + 4); break; }
    if (size > header.length) throw new Error('WAV 头部范围错误。');
    cursor += 8 + size + (size & 1);
  }
  if (!fmt || dataOffset === null || fmt.bits !== 32 || ![3, 65534].includes(fmt.format) || (total - dataOffset) % fmt.blockAlign) throw new Error('WAV PCM float 头部不完整。');
  header.writeUInt32LE(total - 8, 4);
  if (factOffset !== null) header.writeUInt32LE((total - dataOffset) / fmt.blockAlign, factOffset);
  return { ...fmt, dataOffset, dataBytes: total - dataOffset, duration: (total - dataOffset) / fmt.blockAlign / fmt.sampleRate };
}
async function build(job, tool, input, source, probe, partial, onProgress) {
  const stream = probe.streams.find(s => s.codec_type === 'video');
  const audioStream = probe.streams.find(s => s.codec_type === 'audio');
  const args = ['-hide_banner', '-loglevel', 'info', '-nostdin', '-copyts', '-threads', '2', '-i', input.file,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', 'showinfo@v=checksum=0,scale=1280:720:force_original_aspect_ratio=decrease:flags=bilinear,setsar=1,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-filter_threads', '1', '-fps_mode', 'passthrough', '-c:v', 'mjpeg', '-threads', '2', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'];
  if (audioStream) args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'aresample=48000,ashowinfo@a', '-c:a', 'pcm_f32le', '-f', 'wav', 'pipe:3');
  const { child, finish } = createChild(job, tool.ffmpeg, args, ['ignore', 'pipe', 'pipe', audioStream ? 'pipe' : 'ignore']);
  const rows = [], files = [], parser = new JpegParser(); let tb = null, audioFirst = null, stderr = '', pending = '', stderrBytes = 0, peakRss = null, rssSamples = 0, memoryBusy = false;
  const memoryChecks = new Set();
  const monitor = () => {
    if (memoryBusy || !job.children.has(child)) return;
    memoryBusy = true;
    const sample = childMemory(child.pid).then(value => {
      if (value) { rssSamples++; peakRss = Math.max(peakRss || 0, value.PeakWorkingSet64 || value.WorkingSet64 || 0); }
    }).finally(() => { memoryBusy = false; memoryChecks.delete(sample); });
    memoryChecks.add(sample);
  };
  const memoryTimer = setInterval(monitor, 1000); monitor();
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > LIMITS.metadataBytes) { job.failure = new Error('时间戳日志超过 S1 限额。'); child.kill(); return; }
    stderr = (stderr + chunk).slice(-10000); pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines) {
      if (line.includes('showinfo@v')) {
        const base = /config in time_base:\s*(\d+)\/(\d+)/.exec(line);
        if (base) tb = [Number(base[1]), Number(base[2])];
        const frame = /n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*([\d.eE+-]+)/.exec(line);
        if (frame) { if (rows.length >= LIMITS.frames) { job.failure = new Error('S1 帧数上限。'); child.kill(); } else rows.push({ id: Number(frame[1]), ptsTicks: frame[2], absoluteTime: Number(frame[3]) }); }
      }
      if (line.includes('ashowinfo@a') && audioFirst === null) {
        const audio = /n:\s*0\s+pts:\s*(-?\d+)\s+pts_time:\s*([\d.eE+-]+)/.exec(line);
        if (audio) audioFirst = { ptsTicks: audio[1], absoluteTime: Number(audio[2]), timeBase: [1, 48000] };
      }
    }
  });
  const started = process.hrtime.bigint();
  const videoTask = (async () => {
    for await (const chunk of child.stdout) {
      check(job);
      for (const jpeg of parser.push(chunk)) {
        const id = files.length; if (id >= LIMITS.frames) throw new Error('S1 帧数上限。');
        const file = String(id).padStart(6, '0') + '.jpg';
        await put(job, partial, file, jpeg);
        files.push({ id, file, bytes: jpeg.length, sha256: crypto.createHash('sha256').update(jpeg).digest('hex') });
        if (onProgress && (id % 20 === 0)) onProgress({ stage: 'decode', frames: files.length, bytes: job.disk.runtime });
      }
    }
  })();
  const audioTask = (async () => {
    if (!audioStream) return null;
    const file = safeFile(partial, 'audio.wav'); let handle, bytes = 0;
    try {
      handle = await fsp.open(file, 'wx+'); check(job);
      for await (const chunk of child.stdio[3]) { check(job); charge(job, chunk.length); await writeAll(job, handle, chunk); bytes += chunk.length; }
      if (bytes < 44) throw new Error('音频流为空或不完整。');
      const header = Buffer.alloc(Math.min(bytes, 4096)); await handle.read(header, 0, header.length, 0); check(job);
      const fmt = parseWavHeader(header, bytes); await writeAll(job, handle, header.subarray(0, fmt.dataOffset), 0); check(job);
      return { file: 'audio.wav', bytes, sampleRate: fmt.sampleRate, channels: fmt.channels, duration: fmt.duration, dataOffset: fmt.dataOffset, dataBytes: fmt.dataBytes };
    } finally { if (handle) await handle.close(); }
  })();
  // A failing consumer must terminate the producer and release the other pipe before awaiting all.
  const guarded = [videoTask, audioTask].map(promise => promise.catch(error => { job.failure = job.failure || error; child.kill(); throw error; }));
  const results = await Promise.allSettled(guarded); const exit = await finish;
  clearInterval(memoryTimer); await Promise.allSettled([...memoryChecks]); check(job);
  if (job.failure || exit.error || exit.code !== 0) throw job.failure || exit.error || new Error(`预处理退出 ${exit.code}: ${stderr}`);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  if (!tb || !rows.length || rows.length !== files.length || parser.buffer.length) throw new Error(`PTS/JPEG 不完整：${rows.length}/${files.length}`);
  const origin = Number(BigInt(rows[0].ptsTicks)) * tb[0] / tb[1];
  const frames = rows.map((row, i) => {
    const time = (Number(BigInt(row.ptsTicks) - BigInt(rows[0].ptsTicks)) * tb[0]) / tb[1];
    if (row.id !== i || time < 0 || i && time <= (Number(BigInt(rows[i - 1].ptsTicks) - BigInt(rows[0].ptsTicks)) * tb[0]) / tb[1]) throw new Error('S1 未覆盖缺失、重复或倒退 PTS。');
    return { ...files[i], time, end: null, ptsTicks: row.ptsTicks, timeBase: tb };
  });
  const last = frames[frames.length - 1], streamEnd = Number(stream.start_time || 0) + Number(stream.duration || 0) - origin;
  const rate = String(stream.r_frame_rate || '30/1').split('/').map(Number);
  const fallbackStep = rate[0] > 0 && rate[1] > 0 ? rate[1] / rate[0] : 1 / 30;
  for (let i = 0; i < frames.length; i++) frames[i].end = i + 1 < frames.length ? frames[i + 1].time : streamEnd > last.time ? streamEnd : last.time + fallbackStep;
  let audio = results[1].value;
  if (audio) {
    if (!audioFirst) throw new Error('未取得解码音频首 PTS。');
    audio = { ...audio, start: Number(BigInt(audioFirst.ptsTicks)) / 48000 - origin,
      sourceFirstPts: audioFirst.ptsTicks, sourceTimeBase: audioFirst.timeBase };
    audio.sha256 = await hash(safeFile(partial, audio.file), job);
  }
  const duration = Math.max(last.end, audio ? audio.start + audio.duration : 0);
  return { schema: 1, owner: OWNER, recipe: 'S1-jpeg-q3-wav-f32-720p-v1', cacheDir: null, source,
    width: 1280, height: 720, duration, frames, audio, expected: input.expected,
    metrics: { reused: false, generationMs: Number(process.hrtime.bigint() - started) / 1e6,
      sourceVideoOrigin: origin, lastFrameEnd: streamEnd > last.time ? 'video stream duration' : 'nominal frame-duration fallback (S1 limitation)',
      audioMapping: 'Decoded/resampled first audio PTS minus first displayed video PTS; MP4 edits/AAC preroll beyond these specimens not guaranteed.',
      singleVideoDecode: true, stderrBytes, frameBytes: files.reduce((n, f) => n + f.bytes, 0), audioBytes: audio ? audio.bytes : 0, ffmpegPeakRss: peakRss,
      ffmpegRssSamples: rssSamples, ffmpegMemoryNote: 'FFmpeg process working-set peak observed by 1-second samples; short jobs may return null, samples may miss peaks. Node/browser/GPU are separate.',
      limits: LIMITS, args } };
}
async function validateCache(dir, job) {
  scan(dir, 'cache'); const value = JSON.parse(await fsp.readFile(safeFile(dir, 'manifest.json'), 'utf8')); check(job);
  if (value.owner !== OWNER || value.schema !== 1 || value.recipe !== 'S1-jpeg-q3-wav-f32-720p-v1' || !Array.isArray(value.frames) || !value.frames.length) throw new Error('缓存 manifest 无效。');
  const entries = [...value.frames, ...(value.audio ? [value.audio] : [])];
  const actual = fs.readdirSync(dir).sort(), expectedNames = ['owner.json', 'manifest.json', ...entries.map(e => e.file)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedNames)) throw new Error('缓存文件清单不匹配。');
  for (const entry of entries) {
    const file = safeFile(dir, entry.file);
    if (fs.statSync(file).size !== entry.bytes || await hash(file, job) !== entry.sha256) throw new Error('缓存文件尺寸或内容损坏。');
  }
  value.cacheDir = dir; registered.set(dir, value); return value;
}
async function removeOwned(dir, kind) {
  const listing = scan(dir, kind); // Validate every entry before deleting anything.
  const dirs = [...new Set(listing.files.map(f => path.dirname(f.path)))].sort((a, b) => b.length - a.length);
  for (const nested of dirs) {
    // Keep each owner marker until its other files are gone, preserving recovery information.
    const files = listing.files.filter(file => path.dirname(file.path) === nested)
      .sort((a, b) => Number(path.basename(a.path) === 'owner.json') - Number(path.basename(b.path) === 'owner.json'));
    for (const file of files) { safeFile(nested, path.basename(file.path)); await fsp.unlink(file.path); }
    await fsp.rmdir(nested);
  }
  registered.delete(dir);
  return { files: listing.files.length, bytes: listing.bytes };
}
async function prepare(key, options = {}) {
  if (!['baseline', ...Object.keys(fixtures.SPECS)].includes(key)) throw new Error('仅允许 S1 样本列表。');
  if (activeJob) throw new Error('已有 S1 生成任务；请取消并等待结束。');
  const start = process.hrtime.bigint(), job = { id: crypto.randomBytes(8).toString('hex'), signal: options.signal,
    cancelled: false, children: new Set(), disk: null, failure: null };
  activeJob = job; let partial = null;
  const cancel = () => { job.cancelled = true; for (const child of job.children) child.kill(); };
  if (job.signal) job.signal.addEventListener('abort', cancel, { once: true });
  try {
    check(job); job.disk = budget(job); const tool = tools();
    const input = key === 'baseline' ? await baseline(tool, job) : await fixtures.generate(key,
      { runFixture: (fixtureKey, args, exp) => runFixture(job, tool, fixtureKey, args, exp) }); check(job);
    const sourceHash = input.sha256; const cache = path.join(RUNTIME, `cache-${key}-${sourceHash.slice(0, 16)}`);
    if (fs.existsSync(cache)) {
      const info = await validateCache(cache, job); check(job);
      if (info.source.sha256 !== sourceHash || info.source.key !== key) throw new Error('缓存源身份不符。');
      info.metrics = { ...info.metrics, reused: true, totalMs: Number(process.hrtime.bigint() - start) / 1e6,
        diskBytesTotal: scan(RUNTIME, 'runtime').bytes, evidenceBytes: scan(EVIDENCE, 'evidence').bytes };
      return info;
    }
    const probe = JSON.parse(await collect(job, tool.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input.file])); check(job);
    const video = probe.streams.find(s => s.codec_type === 'video');
    if (!video || !(Number(probe.format.duration) > 0 && Number(probe.format.duration) <= 31)) throw new Error('S1 样本元数据异常。');
    const source = { key, label: (await listSources()).find(s => s.key === key).label, sha256: sourceHash,
      codec: video.codec_name, width: video.width, height: video.height };
    partial = path.join(RUNTIME, 'partial-' + job.id); await createOwned(job, partial, 'cache'); check(job);
    const info = await build(job, tool, input, source, probe, partial, options.onProgress); check(job);
    if (await hash(input.file, job) !== sourceHash) throw new Error('源文件生成期间发生改变，不提交缓存。');
    info.cacheDir = cache; info.metrics.totalMs = Number(process.hrtime.bigint() - start) / 1e6;
    info.metrics.totalMsNote = 'Node preparation only; caller must add browser audio/image initialization through ready.';
    await put(job, partial, 'manifest.json', Buffer.from(JSON.stringify(info, null, 2))); check(job);
    await fsp.rename(partial, cache); partial = null; check(job);
    info.metrics.totalMs = Number(process.hrtime.bigint() - start) / 1e6;
    info.metrics.diskBytesTotal = scan(RUNTIME, 'runtime').bytes; info.metrics.evidenceBytes = scan(EVIDENCE, 'evidence').bytes;
    registered.set(cache, info); return info;
  } catch (error) {
    if (job.cancelled || job.signal && job.signal.aborted) throw abortError();
    throw error;
  } finally {
    for (const child of job.children) child.kill();
    if (job.signal) job.signal.removeEventListener('abort', cancel);
    try { if (partial && fs.existsSync(partial)) await removeOwned(partial, 'cache'); }
    finally { if (activeJob === job) activeJob = null; }
  }
}
async function readAsset(info, relativeName) {
  if (!info || !registered.has(info.cacheDir)) throw new Error('缓存未登记。');
  const canonical = registered.get(info.cacheDir), entry = canonical.frames.find(f => f.file === relativeName) || canonical.audio && canonical.audio.file === relativeName && canonical.audio;
  if (!entry) throw new Error('拒绝读取未登记缓存文件。');
  const file = safeFile(info.cacheDir, relativeName), handle = await fsp.open(file, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size !== entry.bytes) throw new Error('缓存文件尺寸已改变。');
    // The caller reserves entry.bytes; never let readFile allocate from a newly grown file.
    const bytes = Buffer.alloc(entry.bytes); let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error('缓存读取不完整。'); offset += read.bytesRead; }
    if ((await handle.stat()).size !== entry.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('缓存内容校验失败。');
    return bytes;
  } finally { await handle.close(); }
}
async function saveEvidence(kind, data) {
  if (savingEvidence) throw new Error('正在保存一份 S1 证据，请等待完成。');
  savingEvidence = true;
  try {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(kind)) throw new Error('无效的证据类别。');
  ensureRoot(EVIDENCE, 'evidence'); ensureRoot(RUNTIME, 'runtime');
  const bytes = Buffer.from(JSON.stringify({ schema: 1, owner: OWNER, createdAt: new Date().toISOString(), data }, null, 2));
  if (bytes.length > LIMITS.evidenceFileBytes) throw new Error('单份证据超过 S1 限额。');
  const disk = budget(null);
  if (disk.evidence + bytes.length > LIMITS.evidenceBytes || disk.runtime + disk.evidence + bytes.length > LIMITS.totalBytes) throw new Error('证据写入到达 S1 总限额。');
  // Evidence saved during a live job is included in the same writer ledger before its next write.
  if (activeJob && activeJob.disk) charge(activeJob, bytes.length, 'evidence');
  const name = `${kind}-${new Date().toISOString().replace(/:/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json`;
  const file = safeFile(EVIDENCE, name); await fsp.writeFile(file, bytes, { flag: 'wx' }); return file;
  } finally { savingEvidence = false; }
}
async function cleanup() {
  if (activeJob) throw new Error('先取消并等待 S1 任务结束，再清理。');
  if (!fs.existsSync(RUNTIME)) return { files: 0, bytes: 0, evidencePreserved: true };
  const result = await removeOwned(RUNTIME, 'runtime'); registered.clear();
  return { ...result, evidencePreserved: true };
}
function frameAt(frames, time) {
  if (!Array.isArray(frames) || !frames.length || !Number.isFinite(time)) throw new Error('无效帧索引或时间。');
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (frames[mid].time <= time) lo = mid + 1; else hi = mid; }
  return Math.max(0, lo - 1);
}
module.exports = { ROOT, LIMITS, listSources, prepare, readAsset, saveEvidence, cleanup, frameAt,
  // S1 local checks only; not an additional product API.
  _test: { JpegParser, parseWavHeader, tools, hash, scan, RUNTIME, EVIDENCE } };
