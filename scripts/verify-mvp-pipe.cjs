'use strict';
// Selected, read-only source; discard the original production JPEG/PCM pipes.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawn } = require('child_process');
const repo = fs.realpathSync(path.resolve(__dirname, '..')), { createStore } = require('../tests/support/t4-evidence.cjs');
const { ffmpegArgs, JpegParser } = require('../plugin/media.cjs')._test;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function fileHash(file) { const hash = crypto.createHash('sha256'); for await (const data of fs.createReadStream(file)) hash.update(data); return hash.digest('hex'); }
async function main() {
  const args = process.argv.slice(2), threads = Number(args[0]), filterThreads = args[1] === undefined ? 1 : Number(args[1]);
  if (args.length < 1 || args.length > 2 || ![2, 8].includes(threads) || ![1, 2].includes(filterThreads)) throw Error('Explicit decoder threads 2/8 and optional filter threads 1/2.');
  const store = createStore(repo), startFile = path.join(repo, 'verification-runs/t4/slot-047/record.json'), raw = fs.readFileSync(startFile);
  const previous = store.readReceipt({ file: startFile, bytes: raw.length, sha256: sha(raw) }), source = previous.source;
  if (!source || source.itemId !== 'MV3FZJJ7AC1CI' || source.sha256 !== '0823a48f0d7b365163297206e8e8c66591c3aa6cf4c30253b3187d19c9644cba') throw Error('Approved Sonic source identity missing.');
  const stamp = () => { const s = fs.lstatSync(source.filePath, { bigint: true }); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || fs.realpathSync(source.filePath).toLowerCase() !== source.filePath.toLowerCase()) throw Error('Source path boundary changed.'); return ['dev', 'ino', 'size', 'mtimeNs'].map(k => String(s[k])); };
  const before = stamp(); if (await fileHash(source.filePath) !== source.sha256) throw Error('Source content changed.');
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json'))), command = ffmpegArgs(source.filePath, true, 'h264'); command[command.indexOf('-threads') + 1] = String(threads);
  command[command.indexOf('-filter_threads') + 1] = String(filterThreads);
  store.start({ reserveBytes: 1024 ** 2 });
  const result = { schema: 'mvp-h264-pipe-diagnostic-v1', at: new Date().toISOString(), source, threads, filterThreads, command,
    origin: 'owned-FFmpeg-discarded-pipes-no-cache-or-Eagle-GUI', limits: { durationMs: 60000, jpegBytes: 256 * 1024 ** 2, audioBytes: 16 * 1024 ** 2, stderrBytes: 8 * 1024 ** 2 },
    sourceHashes: Object.fromEntries(['plugin/media.cjs', 'scripts/verify-mvp-pipe.cjs'].map(f => [f, sha(fs.readFileSync(path.join(repo, f)))])),
    frames: 0, jpegBytes: 0, audioBytes: 0, passed: false, fullReadinessMeasured: false, cacheTouched: false };
  let child, monitor, failure, timer, stderr = '', stderrBytes = 0;
  const stop = error => { if (!failure) failure = error; if (child && child.exitCode === null) child.kill(); };
  const images = crypto.createHash('sha256'), audio = crypto.createHash('sha256'), parser = new JpegParser();
  try {
    monitor = require('../tests/support/mvp-monitor.cjs').start({ ramBytes: 1024 ** 3, now: () => performance.now(), snapshot: () => ({ state: 'pipe-diagnostic', threads }), onStop: stop });
    const began = performance.now();
    child = spawn(cfg.ffmpeg, command, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    timer = setTimeout(() => stop(Error('Owned FFmpeg exceeded 60 seconds.')), result.limits.durationMs);
    child.stdout.on('data', data => { try { result.jpegBytes += data.length; if (result.jpegBytes > result.limits.jpegBytes) throw Error('JPEG pipe budget exceeded.'); images.update(data); for (const image of parser.push(data)) { result.frames++; if (!result.firstFrameMs) result.firstFrameMs = performance.now() - began; } } catch (e) { stop(e); } });
    child.stdio[3].on('data', data => { result.audioBytes += data.length; if (result.audioBytes > result.limits.audioBytes) stop(Error('Audio pipe budget exceeded.')); audio.update(data); });
    child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > result.limits.stderrBytes) stop(Error('Metadata pipe budget exceeded.')); else stderr += data.toString('utf8'); });
    result.exit = await closed; result.elapsedMs = performance.now() - began;
    if (failure) throw failure;
    if (result.exit.code !== 0 || result.frames !== 1490 || parser.buffer.length || !result.audioBytes) throw Error('Incomplete 1490-frame/audio output.');
    const videoPts = [], audioPts = [];
    for (const line of stderr.split(/\r?\n/)) { const m = /n:\s*(\d+)\s+pts:\s*(-?\d+)/.exec(line); if (!m) continue; if (line.includes('showinfo@v')) videoPts.push([Number(m[1]), m[2]]); else if (line.includes('ashowinfo@a')) audioPts.push([Number(m[1]), m[2]]); }
    if (videoPts.length !== 1490 || !audioPts.length) throw Error('Missing output timing metadata.');
    result.outputHashes = { jpeg: images.digest('hex'), audio: audio.digest('hex'), videoPts: sha(JSON.stringify(videoPts)), audioPts: sha(JSON.stringify(audioPts)) };
    result.passed = true;
  } catch (e) { result.error = String(e.message || e); }
  finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
    if (monitor) { const resources = await monitor.stop(); result.observer = resources.observer; result.observerIssue = resources.issue; result.resourceChunks = [];
      for (let n = 0; n < resources.rows.length; n += 200) result.resourceChunks.push(store.save('lifecycle', { schema: 'mvp-pipe-resource-chunk-v1', threads, rows: resources.rows.slice(n, n + 200) }));
      if (resources.issue) result.passed = false;
    }
    result.sourceUnchanged = JSON.stringify(stamp()) === JSON.stringify(before) && await fileHash(source.filePath) === source.sha256;
    if (!result.sourceUnchanged) result.passed = false;
    result.limitations = ['Raw discarded generation is not full P-03; no filesystem cache commit, JPEG preload or real Eagle UI.', 'Existing observer overhead is present in both variants; no OS cold-cache claim.'];
    const receipt = store.save('audit', result); store.close(); console.log(JSON.stringify({ receipt, ...result }));
  }
  if (!result.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
