// 实验 B：现有 FFmpeg → 有限 JPEG 帧目录。没有 Eagle 元数据写入接口。
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const ROOT = __dirname;
const LIMITS = Object.freeze({ diskBytes: 256 * 1024 ** 2, jpegBytes: 4 * 1024 ** 2,
  frames: 3600, sourceBytes: 512 * 1024 ** 2, seconds: 30.1, metadataBytes: 8 * 1024 ** 2,
  timeoutMs: 120000, childRssBytes: 768 * 1024 ** 2 });
const OWNER = 'eagle-poc-B-owned-cache-v1';
let activeChild = null;
let working = false;
function config() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'tools-b.json'), 'utf8')); }
function dir(name = 'cache-b') {
  if (!['cache-b', 'cache-b-test'].includes(name)) throw new Error('未知缓存目录。');
  const target = path.resolve(ROOT, name);
  if (path.dirname(target) !== path.resolve(ROOT)) throw new Error('目录越界。');
  if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink()
    || fs.realpathSync(target).toLowerCase() !== target.toLowerCase())) throw new Error('缓存目录不能是链接。');
  return target;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function sourceStamp(file) {
  const st = await fsp.stat(file);
  if (!st.isFile() || st.size > LIMITS.sourceBytes) throw new Error('实验源文件必须是 512 MiB 以内的文件。');
  return { filePath: path.resolve(file), size: st.size, mtimeMs: st.mtimeMs };
}
function sameSource(a, b) { return a.filePath === b.filePath && a.size === b.size && a.mtimeMs === b.mtimeMs; }
function cancel() { if (activeChild) activeChild.kill(); }
async function collect(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, shell: false }); activeChild = child;
    const chunks = []; let bytes = 0, stderr = '', failure = null;
    const timer = setTimeout(() => { failure = new Error('工具执行超时。'); child.kill(); }, LIMITS.timeoutMs);
    child.stdout.on('data', chunk => { bytes += chunk.length;
      if (bytes > LIMITS.metadataBytes) { failure = new Error('探测输出超出上限。'); child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', error => { failure = error; });
    child.once('close', code => { clearTimeout(timer); if (activeChild === child) activeChild = null;
      if (failure || code !== 0) reject(failure || new Error(`工具退出 ${code}: ${stderr}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
function timeline(frames, startTime) {
  const origin = Number(startTime || 0);
  const timestamps = frames.map(frame => Number(frame.best_effort_timestamp_time) - origin);
  if (!timestamps.length || timestamps.length > LIMITS.frames || timestamps.some((t, i) => !Number.isFinite(t)
    || t < 0 || (i && t <= timestamps[i - 1]))) throw new Error('帧时间戳缺失、重复、倒退或帧数超过上限。');
  return timestamps;
}
function frameAt(times, time) {
  if (!times.length || !Number.isFinite(time)) throw new Error('无效时间轴。');
  let low = 0, high = times.length;
  while (low < high) { const mid = (low + high) >>> 1; if (times[mid] <= time) low = mid + 1; else high = mid; }
  return Math.max(0, low - 1);
}
async function probe(file) {
  if (working) throw new Error('已有预处理任务。'); working = true;
  try {
    const stamp = await sourceStamp(file), tools = config();
    const meta = JSON.parse(await collect(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', file]));
    const stream = meta.streams[0]; const duration = Number(meta.format.duration);
    if (!stream || !(duration >= 5 && duration <= LIMITS.seconds)) throw new Error('本实验只接受 5～30 秒短视频。');
    if (stream.width * stream.height > 7680 * 4320 || ![undefined, '1:1'].includes(stream.sample_aspect_ratio)
      || (stream.side_data_list || []).some(d => Number(d.rotation || 0) !== 0)) throw new Error('本 PoC 未覆盖超 8K、非方形像素或旋转视频。');
    const frameData = JSON.parse(await collect(tools.ffprobe, ['-v', 'error', '-threads', '2', '-select_streams', 'v:0',
      '-read_intervals', '%+31', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time', '-of', 'json', file]));
    const times = timeline(frameData.frames, stream.start_time);
    const steps = times.slice(1).map((t, i) => t - times[i]);
    return { source: stamp, sha256: await hashFile(file), codec: stream.codec_name, width: stream.width, height: stream.height,
      duration, streamDuration: Number(stream.duration), avgFrameRate: stream.avg_frame_rate, nominalFrameRate: stream.r_frame_rate,
      timeBase: stream.time_base, streamStartTime: Number(stream.start_time || 0), timestamps: times,
      frameIntervals: { min: Math.min(...steps), max: Math.max(...steps),
        note: '实际逐帧 PTS；不使用平均帧率乘时间定位。间隔差异也可能来自时间基量化。' } };
  } finally { working = false; }
}
// image2pipe 的 MJPEG 输出由本程序启动的 FFmpeg 生成；限制单帧长度和总写入量。
class JpegSplitter {
  constructor() { this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]); const images = [];
    while (this.buffer.length >= 2) {
      if (this.buffer[0] !== 255 || this.buffer[1] !== 216) throw new Error('JPEG 流边界错误。');
      const end = this.buffer.indexOf(Buffer.from([255, 217]), 2);
      if (end < 0) { if (this.buffer.length > LIMITS.jpegBytes) throw new Error('单帧超过 4 MiB。'); break; }
      if (end + 2 > LIMITS.jpegBytes) throw new Error('单帧超过 4 MiB。');
      images.push(this.buffer.subarray(0, end + 2)); this.buffer = this.buffer.subarray(end + 2);
    }
    return images;
  }
}
function childMemory(pid) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null);
    const exe = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(exe, ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue | Select-Object WorkingSet64,PeakWorkingSet64 | ConvertTo-Json -Compress`],
    { windowsHide: true, timeout: 4000 }, (error, stdout) => { try { resolve(error ? null : JSON.parse(stdout)); } catch (_) { resolve(null); } });
  });
}
async function build(info, options = {}) {
  if (working) throw new Error('已有预处理任务。');
  try { return await buildInternal(info, options); } finally { working = false; }
}
async function buildInternal(info, options = {}) {
  if (working) throw new Error('已有预处理任务。');
  const name = options.store || 'cache-b', target = dir(name), height = options.height || 720;
  if (![360, 720].includes(height)) throw new Error('仅支持 360p/720p 实验预览。');
  if (fs.existsSync(target)) throw new Error('缓存目录已存在。请先查看或清理当前实验缓存。');
  if (!sameSource(info.source, await sourceStamp(info.source.filePath))) throw new Error('源文件已变化，请重新探测。');
  const diskLimit = Math.min(options.diskBytes || LIMITS.diskBytes, LIMITS.diskBytes);
  const executable = config().ffmpeg;
  const ratio = Math.min(1, height / info.height, (height * 16 / 9) / info.width);
  const width = Math.max(2, Math.floor(info.width * ratio / 2) * 2), outHeight = Math.max(2, Math.floor(info.height * ratio / 2) * 2);
  working = true; const start = process.hrtime.bigint(); let total = 0, count = 0, peakChild = null, memoryBusy = false, stderr = '', failure = null;
  await fsp.mkdir(target); await fsp.writeFile(path.join(target, 'owner.json'), JSON.stringify({ owner: OWNER, root: ROOT }), { flag: 'wx' });
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-i', info.source.filePath, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `scale=${width}:${outHeight}:flags=bilinear,setsar=1`, '-filter_threads', '1', '-vsync', '0', '-frames:v', String(LIMITS.frames + 1),
    '-c:v', 'mjpeg', '-threads', '2', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'];
  const child = spawn(executable, args, { windowsHide: true, shell: false }); activeChild = child;
  const finish = new Promise(resolve => { child.once('error', e => { failure = e; }); child.once('close', code => resolve(code)); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  const timer = setTimeout(() => { failure = new Error('提取帧超时。'); child.kill(); }, LIMITS.timeoutMs);
  const monitor = setInterval(async () => {
    if (memoryBusy) return; memoryBusy = true;
    const memory = await childMemory(child.pid); memoryBusy = false;
    if (memory) { peakChild = Math.max(peakChild || 0, memory.PeakWorkingSet64 || memory.WorkingSet64);
      if (memory.WorkingSet64 > LIMITS.childRssBytes) { failure = new Error('FFmpeg 采样工作集超过 768 MiB。'); child.kill(); }
    }
  }, 1000);
  try {
    const parser = new JpegSplitter();
    for await (const chunk of child.stdout) {
      for (const jpeg of parser.push(chunk)) {
        if (count >= info.timestamps.length || count >= LIMITS.frames) throw new Error('实际输出帧数超出已探测帧数。');
        if (total + jpeg.length > diskLimit - Math.min(diskLimit / 2, 1024 ** 2)) throw new Error('缓存到达磁盘容量上限。');
        await fsp.writeFile(path.join(target, `${String(count).padStart(6, '0')}.jpg`), jpeg, { flag: 'wx' });
        count++; total += jpeg.length; options.onProgress?.({ count, frames: info.timestamps.length, bytes: total });
      }
    }
    const code = await finish;
    if (failure || code !== 0 || parser.buffer.length || count !== info.timestamps.length)
      throw failure || new Error(`提取失败/帧数不匹配：${count}/${info.timestamps.length}，退出 ${code} ${stderr}`);
    if (!sameSource(info.source, await sourceStamp(info.source.filePath)) || await hashFile(info.source.filePath) !== info.sha256)
      throw new Error('源文件在生成期间变化，缓存不可使用。');
    const manifest = { ...info, owner: OWNER, height: outHeight, width, sourceWidth: info.width, sourceHeight: info.height,
      previewHeight: height, format: 'jpeg-q3', frames: count, frameBytes: total, generationMs: Number(process.hrtime.bigint() - start) / 1e6,
      ffmpegPeakWorkingSetSampledBytes: peakChild, memoryNote: 'FFmpeg 独立进程每秒采样，可能漏掉末段峰值；null 表示不可获得。',
      args, complete: true, builtAt: new Date().toISOString(), limits: LIMITS };
    await fsp.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    manifest.diskBytes = (await Promise.all((await fsp.readdir(target)).map(async n => (await fsp.stat(path.join(target, n))).size))).reduce((a, b) => a + b, 0);
    return manifest;
  } catch (error) {
    child.kill(); await finish;
    await fsp.writeFile(path.join(target, 'failure.json'), JSON.stringify({ error: error.message, count, bytes: total })); throw error;
  } finally { clearTimeout(timer); clearInterval(monitor); activeChild = null; working = false; }
}
async function loadCache(info, name = 'cache-b') {
  const target = dir(name); const value = JSON.parse(await fsp.readFile(path.join(target, 'manifest.json'), 'utf8'));
  if (value.owner !== OWNER || !value.complete || value.sha256 !== info.sha256 || !sameSource(value.source, info.source)) throw new Error('缓存与当前源文件不匹配。');
  value.diskBytes = (await Promise.all((await fsp.readdir(target)).map(async n => (await fsp.stat(path.join(target, n))).size))).reduce((a, b) => a + b, 0);
  return value;
}
async function cleanup(name = 'cache-b') {
  if (working) throw new Error('请先停止预处理再清理。');
  const target = dir(name); if (!fs.existsSync(target)) return { files: 0 };
  const owner = JSON.parse(await fsp.readFile(path.join(target, 'owner.json'), 'utf8'));
  if (owner.owner !== OWNER || owner.root !== ROOT) throw new Error('不是本实验创建的缓存。');
  const files = await fsp.readdir(target, { withFileTypes: true });
  // 验证完全部文件后才删除；不递归，不跟随链接，不删除未知文件。
  for (const entry of files) if (!entry.isFile() || !/^(\d{6}\.jpg|owner\.json|manifest\.json|failure\.json)$/.test(entry.name)) throw new Error('缓存中含未知文件或链接，停止清理。');
  for (const entry of files) await fsp.unlink(path.join(target, entry.name));
  await fsp.rmdir(target); return { files: files.length };
}
module.exports = { ROOT, LIMITS, probe, build, loadCache, cleanup, cancel, frameAt, timeline, JpegSplitter, dir, hashFile };
