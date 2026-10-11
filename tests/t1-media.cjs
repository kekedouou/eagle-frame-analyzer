'use strict';

// Memory-only algorithms/orchestration. No media executable, filesystem write or Eagle call.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const frameIndex = require('../plugin/frame-index.cjs');
const source = fs.readFileSync(path.join(__dirname, '../plugin/media.cjs'), 'utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const image = Buffer.from([255, 216, 255, 224, 0, 6, 12, 255, 217, 13, 255, 218, 0, 2, 10, 255, 0, 11, 255, 208, 12, 255, 217]);
const sourcePath = path.resolve('虚拟素材 中文 空格.mp4');
const tools = { ffmpeg: path.resolve('existing-ffmpeg.exe'), ffprobe: path.resolve('existing-ffprobe.exe') };
const tick = () => new Promise(resolve => setImmediate(resolve));
function wav(samples = 480, channels = 1) {
  const bytes = Buffer.alloc(44 + samples * channels * 4); bytes.write('RIFF'); bytes.writeUInt32LE(0xffffffff, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(48000 * channels * 4, 28); bytes.writeUInt16LE(channels * 4, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(0xffffffff, 40);
  return bytes;
}
function extendedWav() {
  const value = Buffer.alloc(80 + 480 * 8); value.write('RIFF'); value.writeUInt32LE(0xffffffff, 4); value.write('WAVEfmt ', 8);
  value.writeUInt32LE(40, 16); value.writeUInt16LE(65534, 20); value.writeUInt16LE(2, 22); value.writeUInt32LE(48000, 24);
  value.writeUInt32LE(48000 * 8, 28); value.writeUInt16LE(8, 32); value.writeUInt16LE(32, 34); value.writeUInt16LE(22, 36);
  value.writeUInt16LE(32, 38); value.writeUInt32LE(3, 40); Buffer.from('0300000000001000800000aa00389b71', 'hex').copy(value, 44);
  value.write('fact', 60); value.writeUInt32LE(4, 64); value.write('data', 72); value.writeUInt32LE(0xffffffff, 76); return value;
}
function probe(audio = false) {
  return { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3' }, streams: [
    { codec_type: 'video', codec_name: 'h264', start_pts: '1000', duration_ts: '3000', time_base: '1/1000', width: 3840, height: 2160 },
    ...(audio ? [{ codec_type: 'audio', start_pts: '72000', duration_ts: '480', time_base: '1/48000' }] : [])] };
}
function harness(settings = {}) {
  const events = [], processes = [], assets = new Map(), state = { content: Buffer.from('read-only source bytes'), stamp: 1, acquired: false, aborted: false, closed: false };
  const snapshot = { id: 'CURRENT', itemId: 'CURRENT', name: '当前素材 中文 空格', filePath: sourcePath, ext: 'mp4', libraryEpoch: 7 };
  const stats = () => ({ isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 2, size: state.content.length, mtimeMs: state.stamp, ctimeMs: state.stamp });
  const fakeFs = {
    lstatSync(file) { assert([sourcePath, tools.ffmpeg, tools.ffprobe].includes(file), 'unexpected file access'); return stats(); },
    realpathSync(file) { return file; },
    promises: {
      async open(file, mode) {
        assert.strictEqual(file, sourcePath); assert.strictEqual(mode, 'r'); events.push('source-open');
        return { stat: async () => stats(), async read(buffer, offset, length, position) {
          const part = state.content.subarray(position, position + length); part.copy(buffer, offset); return { bytesRead: part.length };
        }, close: async () => { events.push('source-close'); } };
      }
    }
  };
  function closeProcess(child, code = 0) {
    if (child.closed) return; child.closed = true;
    if (!child.stdout.writableEnded) child.stdout.end(); if (!child.stderr.writableEnded) child.stderr.end();
    if (child.stdio[3] && !child.stdio[3].writableEnded) child.stdio[3].end();
    events.push(child.kind + '-close'); child.emit('close', code, child.killed ? 'SIGTERM' : null);
  }
  function spawn(tool, args, options) {
    assert.strictEqual(options.shell, false); assert.strictEqual(options.windowsHide, true);
    const child = new EventEmitter(); child.pid = 400 + processes.length;
    child.kind = tool === tools.ffprobe ? 'probe' : tool === tools.ffmpeg ? 'decode' : 'monitor';
    child.args = args; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdio = [null, child.stdout, child.stderr, options.stdio[3] === 'pipe' ? new PassThrough() : null];
    child.kill = () => {
      if (child.closed) return false;
      child.killed = true; events.push(child.kind + '-kill');
      if (!settings.holdClose) setImmediate(() => closeProcess(child, 1));
      return true;
    };
    processes.push(child); events.push(child.kind + '-spawn');
    setImmediate(() => {
      if (child.killed || child.closed) return;
      if (child.kind === 'probe') {
        child.stdout.end(settings.invalidProbe ? '{invalid' : JSON.stringify(settings.probe || probe(settings.audio)));
        child.stderr.end(); setImmediate(() => closeProcess(child, settings.probeExit || 0)); return;
      }
      if (child.kind === 'monitor') return;
      const stamps = settings.stamps || ['1000', '1250'];
      const rows = ['[showinfo@v] config in time_base: 1/1000, frame_rate: 60/1',
        ...stamps.map((stamp, n) => '[showinfo@v] n: ' + n + ' pts: ' + stamp + ' pts_time: 1.0'),
        ...(settings.audio ? ['[ashowinfo@a] n: 0 pts: 72000 pts_time: 1.5'] : [])];
      if (!settings.holdDecode) {
        child.stdout.end(Buffer.concat(stamps.map(() => image)));
        child.stderr.end(settings.omitPts ? '' : rows.join('\n') + '\n');
        if (child.stdio[3]) child.stdio[3].end(wav());
        setImmediate(() => { if (settings.changeSource) state.stamp++; closeProcess(child, settings.decodeExit || 0); });
      }
    });
    return child;
  }
  let complete = settings.reuse || null;
  const tx = {
    async readComplete() { events.push('read-complete'); return complete; },
    async writeAsset(name, bytes) {
      events.push('asset-write-start');
      if (settings.failWrite) throw new Error('controlled write failure');
      if (settings.holdWrite && !state.writeReleased) await new Promise(resolve => { state.releaseWrite = () => { state.writeReleased = true; resolve(); }; });
      const value = { file: name, bytes: bytes.length, sha256: sha(bytes) }; assets.set(name, Buffer.from(bytes)); events.push('asset-write-end'); return value;
    },
    async openAsset(name) {
      events.push('audio-open'); let data = Buffer.alloc(0), closed = false;
      return {
        async append(bytes) { assert(!closed); data = Buffer.concat([data, bytes]); events.push('audio-append'); },
        async readPrefix(maximum) { assert(maximum <= 4096); return Buffer.from(data.subarray(0, maximum)); },
        async patch(offset, bytes) { assert(offset + bytes.length <= data.length); bytes.copy(data, offset); events.push('audio-patch'); },
        async close() { assert(!closed); closed = true; assets.set(name, data); events.push('audio-close'); return { file: name, bytes: data.length, sha256: sha(data) }; }
      };
    },
    async finish(manifest, currentSource) {
      assert(!state.aborted); assert.strictEqual(currentSource.sha256, sha(state.content));
      if (settings.reuse) assert.strictEqual(manifest, settings.reuse);
      else {
        frameIndex.validateIndex(manifest);
        assert.strictEqual(manifest.source.id, undefined, 'content manifest must not retain an item binding');
        for (const asset of [...manifest.frames, ...(manifest.audio ? [manifest.audio] : [])]) {
          assert.strictEqual(asset.bytes, assets.get(asset.file).length); assert.strictEqual(asset.sha256, sha(assets.get(asset.file)));
        }
      }
      events.push('finish'); state.acquired = true;
      if (settings.abortAtFinish) settings.abortAtFinish.abort();
      return { ...manifest, source: currentSource, cacheDir: '/virtual-cache', leaseId: 'lease' };
    },
    async abort() { events.push('cache-abort'); state.aborted = true; },
    async close() { events.push('cache-close'); state.closed = true; if (settings.failClose) throw new Error('controlled lock close failure'); }
  };
  const cache = {
    async begin(value) { assert.strictEqual(value.sourceSha256, sha(state.content)); events.push('cache-begin'); return tx; },
    async release(handle) { assert(handle.leaseId); events.push('lease-release'); state.acquired = false; }
  };
  const module = { exports: {} };
  const context = { module, Buffer, setTimeout, clearTimeout, console,
    process: { platform: settings.windows ? 'win32' : 'linux', hrtime: process.hrtime },
    require(name) {
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path;
      if (name === 'crypto') return crypto;
      if (name === 'child_process') return { spawn };
      if (name === './frame-index.cjs') return frameIndex;
      if (name === './cache.cjs') return { OWNER: 'eagle-video-analysis-plugin-v1', RECIPE: 'jpeg-q3-720p-pcm-f32-48000-v1' };
      throw new Error('unexpected require: ' + name);
    } };
  vm.runInNewContext(source, context, { filename: 'plugin/media.cjs' });
  const api = module.exports, media = api.createMedia({ tools, cache });
  return { api, media, cache, snapshot, events, processes, assets, state,
    closeProcesses() { for (const child of processes) if (!child.closed) closeProcess(child, 1); },
    setComplete(value) { complete = value; } };
}
let tests = 0;
async function test(name, body) { await body(); tests++; console.log('ok ' + name); }
async function main() {
  const pure = harness().api._test;
  await test('T1 JPEG fragmented frames preserve escaped bytes', () => {
    const parser = new pure.JpegParser(), output = [];
    for (const byte of Buffer.concat([image, image])) output.push(...parser.push(Buffer.from([byte])));
    assert.strictEqual(output.length, 2); output.forEach(value => assert.deepStrictEqual(value, image)); assert.strictEqual(parser.buffer.length, 0);
  });
  await test('T1 JPEG parser rejects invalid markers and bounded buffer overflow', () => {
    assert.throws(() => new pure.JpegParser().push(Buffer.from([0, 216])));
    assert.throws(() => new pure.JpegParser().push(Buffer.from([255, 216, 255, 224, 0, 1])));
    assert.throws(() => pure.boundedAdd(32 * 1024 ** 2, 1, 32 * 1024 ** 2));
    assert.throws(() => pure.boundedAdd(-1, 1, 5));
    assert.strictEqual(new pure.JpegParser().push(image.subarray(0, -1)).length, 0);
  });
  await test('T1 PCM header patch uses exact sample count without payload growth', () => {
    const bytes = wav(480, 2), before = Buffer.from(bytes.subarray(44));
    const fmt = pure.patchWav(bytes.subarray(0, 44), bytes.length);
    assert.strictEqual(fmt.duration, .01); assert.strictEqual(fmt.channels, 2);
    assert.strictEqual(bytes.readUInt32LE(4), bytes.length - 8); assert.strictEqual(bytes.readUInt32LE(40), bytes.length - 44);
    assert.deepStrictEqual(bytes.subarray(44), before);
  });
  await test('T1 PCM rejects truncated, unaligned and non-float formats', () => {
    assert.throws(() => pure.patchWav(Buffer.alloc(44), 48));
    assert.throws(() => pure.patchWav(wav().subarray(0, 44), 45));
    const header = wav().subarray(0, 44); header.writeUInt16LE(1, 20); assert.throws(() => pure.patchWav(header, 48));
    header.writeUInt16LE(65534, 20); assert.throws(() => pure.patchWav(header, 48));
  });
  await test('T1 extensible float PCM patches fact samples and RIFF/data sizes exactly', () => {
    const value = extendedWav(), fmt = pure.patchWav(value.subarray(0, 80), value.length);
    assert.strictEqual(fmt.dataOffset, 80); assert.strictEqual(fmt.duration, .01); assert.strictEqual(value.readUInt32LE(68), 480);
    assert.strictEqual(value.readUInt32LE(76), 480 * 8); assert.strictEqual(value.readUInt32LE(4), value.length - 8);
    value[44] = 1; assert.throws(() => pure.patchWav(value.subarray(0, 80), value.length));
  });
  await test('T1 reliable final source time uses integer ticks with no FPS fallback', () => {
    const info = probe(); info.streams[0].start_pts = '90071992547409930';
    assert.strictEqual(pure.videoEnd(info).lastFrameEndTicks, '90071992547412930');
    delete info.streams[0].duration_ts; info.streams[0].r_frame_rate = '60/1'; assert.throws(() => pure.videoEnd(info));
  });
  await test('T1 product duration checks full audio/video span and exact 30s boundary', () => {
    const value = probe(); value.streams[0].duration_ts = '30000'; assert.strictEqual(pure.validateProbe(value).mediaSpan, 30);
    value.streams[0].duration_ts = '30001'; assert.throws(() => pure.validateProbe(value), /30/);
    const audio = probe(true); audio.streams[1].start_pts = '-1440000'; assert.throws(() => pure.validateProbe(audio), /30/);
  });
  await test('T1 audio fallback cannot guess an unknown nonzero time origin', () => {
    const value = probe(true); delete value.streams[1].duration_ts; value.streams[1].duration = 'N/A';
    assert.throws(() => pure.validateProbe(value)); value.streams[1].start_pts = 0; value.streams[0].start_pts = 0;
    assert.strictEqual(pure.validateProbe(value).mediaSpan, 3);
  });
  await test('T1 snapshots are plain frozen current identity with optional library epoch', () => {
    const h = harness(), copied = pure.snapshotCopy(h.snapshot); h.snapshot.name = 'later'; assert.notStrictEqual(copied.name, h.snapshot.name);
    assert(Object.isFrozen(copied)); assert.strictEqual(copied.libraryEpoch, 7);
    assert.throws(() => pure.snapshotCopy({ ...h.snapshot, itemId: 'OTHER' }));
    assert.throws(() => pure.snapshotCopy({ ...h.snapshot, libraryEpoch: -1 }));
  });
  await test('T1 recipe has one input, unchanged 720p q3 frames and optional PCM pipe', () => {
    const args = pure.ffmpegArgs(sourcePath, true);
    assert.strictEqual(args.filter(value => value === '-i').length, 1); assert.strictEqual(args[args.indexOf('-i') + 1], sourcePath);
    assert.strictEqual(args[args.indexOf('-q:v') + 1], '3'); assert.strictEqual(args[args.indexOf('-fps_mode') + 1], 'passthrough');
    assert(args.includes('pcm_f32le')); assert(args.includes('pipe:3')); assert(!pure.ffmpegArgs(sourcePath, false).includes('pipe:3'));
    assert(args[args.indexOf('-vf') + 1].includes('showinfo@v=checksum=0,scale=1280:720'));
  });
  await test('T1 media receives explicit existing tools and never offers installation', () => {
    const h = harness(); assert.throws(() => h.api.createMedia({ tools: { ffmpeg: '', ffprobe: tools.ffprobe }, cache: h.cache }));
    assert.throws(() => h.api.createMedia({ tools, cache: {} }));
    assert.strictEqual(Object.keys(h.media).join(','), 'prepare');
  });
  await test('T1 source snapshot is captured before async preparation and content identity stays separate', async () => {
    const h = harness(), promise = h.media.prepare(h.snapshot); h.snapshot.id = 'LATER'; h.snapshot.filePath = path.resolve('later.mp4');
    const info = await promise;
    assert.strictEqual(info.source.itemId, 'CURRENT'); assert.strictEqual(info.source.filePath, sourcePath); assert.strictEqual(info.source.libraryEpoch, 7);
    assert.strictEqual(info.frames.length, 2); assert.strictEqual(info.frames[1].time, .25); assert.strictEqual(info.frames[1].end, 3);
    assert.deepStrictEqual(h.processes.map(value => value.kind), ['probe', 'decode']);
    assert(h.events.indexOf('source-close') < h.events.indexOf('cache-begin')); assert(h.events.indexOf('finish') < h.events.indexOf('cache-close'));
    assert(info.metrics.preparationMs >= info.metrics.beforeCommitMs);
    assert(info.metrics.phaseMs.commitAndLeaseMs >= 0 && info.metrics.phaseMs.writerReleaseMs >= 0);
  });
  await test('T1 audio extraction shares video decode and applies actual PTS offset after exact patch', async () => {
    const h = harness({ audio: true }), info = await h.media.prepare(h.snapshot);
    assert.strictEqual(info.audio.start, .5); assert.strictEqual(info.audio.duration, .01);
    assert.strictEqual(info.audio.sha256, sha(h.assets.get('audio.wav'))); assert.strictEqual(h.assets.get('audio.wav').readUInt32LE(40), 480 * 4);
    assert(h.events.indexOf('audio-patch') < h.events.indexOf('audio-close')); assert(h.events.indexOf('audio-close') < h.events.indexOf('finish'));
    assert.strictEqual(h.processes.filter(value => value.kind === 'decode').length, 1);
  });
  await test('T1 duplicate PTS retain ordinal frames and VFR intervals', async () => {
    const h = harness({ stamps: ['1000', '1000', '1300'] }), info = await h.media.prepare(h.snapshot);
    assert.deepStrictEqual(Array.from(info.frames, value => value.id), [0, 1, 2]); assert.strictEqual(info.frames[0].end, 0);
    assert.strictEqual(info.frames[1].end, .3); assert.strictEqual(frameIndex.frameAt(info.frames, 0), 1);
  });
  await test('T1 does not inherit the experimental 2000-frame input cap', async () => {
    const h = harness({ stamps: Array.from({ length: 2101 }, (_, i) => String(1000 + i)) });
    assert.strictEqual((await h.media.prepare(h.snapshot)).frames.length, 2101);
  });
  await test('T1 validated reuse retains candidate identity and rebinds only current source', async () => {
    const initial = harness(), generated = await initial.media.prepare(initial.snapshot);
    const saved = { ...generated, source: { sha256: sha(Buffer.from('read-only source bytes')), codec: 'h264', width: 3840, height: 2160, hasAudioStream: false } };
    const h = harness({ reuse: saved }); h.snapshot.id = h.snapshot.itemId = 'SECOND'; h.snapshot.name = '同内容新素材';
    const info = await h.media.prepare(h.snapshot);
    assert.strictEqual(info.source.itemId, 'SECOND'); assert.strictEqual(info.metrics.reused, true);
    assert.strictEqual(h.processes.length, 1); assert.strictEqual(h.processes[0].kind, 'probe'); assert.strictEqual(h.assets.size, 0);
  });
  await test('T1 cancellation waits for actual process close before transaction cleanup', async () => {
    const h = harness({ holdDecode: true, holdClose: true }), controller = new AbortController();
    const promise = h.media.prepare(h.snapshot, { signal: controller.signal }); const rejection = assert.rejects(promise, error => error.name === 'AbortError');
    for (let i = 0; i < 20 && !h.processes.some(value => value.kind === 'decode'); i++) await tick();
    controller.abort(); await tick(); assert(!h.events.includes('cache-abort')); assert(h.events.includes('decode-kill'));
    h.closeProcesses(); await rejection; assert(h.events.indexOf('decode-close') < h.events.indexOf('cache-abort')); assert(h.state.closed);
  });
  await test('T1 cancellation waits for pending output write even after process close', async () => {
    const h = harness({ holdWrite: true }), controller = new AbortController();
    const promise = h.media.prepare(h.snapshot, { signal: controller.signal }); const rejection = assert.rejects(promise, error => error.name === 'AbortError');
    for (let i = 0; i < 30 && (!h.state.releaseWrite || !h.events.includes('decode-close')); i++) await tick();
    controller.abort(); await tick(); assert(!h.events.includes('cache-abort'));
    h.state.releaseWrite(); await rejection; assert(h.events.indexOf('asset-write-end') < h.events.indexOf('cache-abort'));
  });
  await test('T1 Windows sampler is owned and must exit before cancellation cleanup', async () => {
    const h = harness({ windows: true, holdDecode: true, holdClose: true }), controller = new AbortController();
    const promise = h.media.prepare(h.snapshot, { signal: controller.signal }); const rejection = assert.rejects(promise, error => error.name === 'AbortError');
    for (let i = 0; i < 30 && !h.processes.some(value => value.kind === 'monitor'); i++) await tick();
    controller.abort(); await tick(); assert(h.events.includes('monitor-kill')); assert(!h.events.includes('cache-abort'));
    h.closeProcesses(); await rejection; assert(h.events.indexOf('monitor-close') < h.events.indexOf('cache-abort'));
  });
  await test('T1 invalid probe fails with writer cleanup without generating outputs', async () => {
    const h = harness({ invalidProbe: true }); await assert.rejects(h.media.prepare(h.snapshot), /JSON/);
    assert.strictEqual(h.processes.length, 1); assert(h.state.aborted && h.state.closed); assert(!h.state.acquired);
  });
  await test('T1 source changes or incomplete PTS never publish a complete cache', async () => {
    for (const settings of [{ changeSource: true }, { omitPts: true }]) {
      const h = harness(settings); await assert.rejects(h.media.prepare(h.snapshot)); assert(!h.events.includes('finish')); assert(h.state.aborted && h.state.closed);
    }
  });
  await test('T1 write failure stops owned tools and settles consumers before cleanup', async () => {
    const h = harness({ audio: true, failWrite: true }); await assert.rejects(h.media.prepare(h.snapshot), /controlled write failure/);
    assert(h.events.indexOf('audio-close') < h.events.indexOf('cache-abort')); assert(h.events.indexOf('decode-close') < h.events.indexOf('cache-abort'));
    assert(!h.events.includes('finish'));
  });
  await test('T1 same media instance rejects overlap until cancelled work truly exits', async () => {
    const h = harness({ holdDecode: true, holdClose: true }), controller = new AbortController();
    const promise = h.media.prepare(h.snapshot, { signal: controller.signal }); const rejection = assert.rejects(promise);
    await assert.rejects(h.media.prepare(h.snapshot), error => error.code === 'MEDIA_BUSY');
    controller.abort(); h.closeProcesses(); await rejection;
    assert(h.state.closed || !h.events.includes('cache-begin'));
  });
  await test('T1 late cancellation releases acquired lease and never removes complete output', async () => {
    const controller = new AbortController(), h = harness({ abortAtFinish: controller });
    await assert.rejects(h.media.prepare(h.snapshot, { signal: controller.signal }), error => error.name === 'AbortError');
    assert(h.events.indexOf('finish') < h.events.indexOf('lease-release')); assert(!h.state.acquired); assert(h.state.closed);
  });
  await test('T1 writer release failure is reported and owned lease is released', async () => {
    const h = harness({ failClose: true }); await assert.rejects(h.media.prepare(h.snapshot), /controlled lock close failure/);
    assert(h.events.includes('lease-release')); assert(!h.state.acquired);
  });
  await test('T1 callback errors cannot escape media event handling', async () => {
    const h = harness(), info = await h.media.prepare(h.snapshot, { onProgress() { throw new Error('observer only'); } });
    assert.strictEqual(info.metrics.progressObserverError, 'observer only'); assert(h.state.acquired);
  });
  console.log(`t1-media: ${tests} memory-only checks passed; no real media/filesystem writes/Eagle executed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
