'use strict';
// Read-only HEVC bottleneck diagnosis. Streams are hashed/discarded, never saved.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert'), { spawn } = require('child_process');
const repo = fs.realpathSync(path.resolve(__dirname, '..')), MIB = 1024 ** 2;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function digest(file) { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
async function main() {
  assert(process.argv.length === 2); const store = require('../tests/support/t4-evidence.cjs').createStore(repo);
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json')));
  const images = path.dirname(path.dirname(config.sources.find(s => s.key === 'baseline').file)), dir = path.join(images, 'MV6H7OK0MBGX2.info');
  const names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.mp4')); assert.equal(names.length, 1);
  const file = path.join(dir, names[0]), sourceSha256 = 'd7bbab0b425381c880adacb9f8d95d900aa162c4c5c9308cf9a3f8482ff67658';
  const before = fs.lstatSync(file, { bigint: true }); assert(before.isFile() && !before.isSymbolicLink() && fs.realpathSync(file) === file); assert.equal(await digest(file), sourceSha256);
  store.start({ reserveBytes: 2 * MIB });
  const result = { schema: 'mvp-hevc-readonly-pipeline-parallel-v1', at: new Date().toISOString(), source: { file, sha256: sourceSha256 },
    codeHashes: Object.fromEntries(['plugin/media.cjs', 'scripts/verify-media-parallel.cjs'].map(f => [f, sha(fs.readFileSync(path.join(repo, f)))])),
    order: [2, 1, 4], cases: [], passed: false, mediaFilesWritten: 0, fullWindowReadinessMeasured: false };
  let monitor, active = null, failed = null;
  function stop(e) { failed = failed || e; if (active) active.kill(); }
  try {
    monitor = require('../tests/support/mvp-monitor.cjs').start({ ramBytes: 1024 ** 3, now: () => performance.now(), onStop: stop,
      snapshot: () => ({ protocol: 'HEVC-readonly-pipeline', variant: result.cases.length }) });
    for (const threads of result.order) {
      if (failed) throw failed;
      const args = require('../plugin/media.cjs')._test.ffmpegArgs(file, true, 'hevc'); args[args.indexOf('-filter_threads') + 1] = String(threads);
      const row = { filterThreads: threads, args, jpegBytes: 0, pcmBytes: 0, frames: 0, firstPts: null, finalPts: null, timeBase: null };
      const jpeg = crypto.createHash('sha256'), pcm = crypto.createHash('sha256'), times = crypto.createHash('sha256');
      let pending = '', stderrBytes = 0, issue = null; const begin = performance.now();
      const child = active = spawn(config.ffmpeg, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => stop(Error('Pipeline case exceeded 60 seconds.')), 60000);
      child.on('error', e => { issue = e; });
      for (const [channel, key, hash] of [[child.stdout, 'jpegBytes', jpeg], [child.stdio[3], 'pcmBytes', pcm]]) {
        channel.on('error', stop); channel.on('data', bytes => { row[key] += bytes.length; if (row[key] > 256 * MIB) stop(Error('Read-only output exceeded stream bound.')); hash.update(bytes); });
      }
      function line(value) {
        if (value.includes('showinfo@v')) {
          const tb = /config in time_base:\s*(\d+\/\d+)/.exec(value); if (tb) row.timeBase = tb[1];
          const f = /n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/.exec(value);
          if (f) { if (Number(f[1]) !== row.frames) stop(Error('Non-contiguous reference frame order.')); row.frames++;
            row.firstPts = row.firstPts ?? f[2]; row.finalPts = f[2]; times.update(f[1] + ':' + f[2] + '\n'); }
        }
      }
      child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 4 * MIB) return stop(Error('Pipeline log exceeded bound.'));
        pending += bytes.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop(); lines.forEach(line); });
      const exit = await new Promise(resolve => child.on('close', code => resolve(code))); clearTimeout(timer); active = null;
      if (pending) line(pending); if (failed || issue || exit) throw failed || issue || Error('FFmpeg exited ' + exit);
      row.elapsedMs = performance.now() - begin; row.jpegSha256 = jpeg.digest('hex'); row.pcmSha256 = pcm.digest('hex'); row.ptsSha256 = times.digest('hex');
      assert.equal(row.frames, 1596); result.cases.push(row);
      console.log(JSON.stringify({ threads, elapsedMs: row.elapsedMs, jpegBytes: row.jpegBytes, frames: row.frames }));
    }
    const a = result.cases[0];
    for (const b of result.cases) for (const key of ['jpegBytes', 'pcmBytes', 'frames', 'firstPts', 'finalPts', 'timeBase', 'jpegSha256', 'pcmSha256', 'ptsSha256']) assert.equal(b[key], a[key], 'Content/time changed: ' + key);
    result.passed = true;
  } catch (e) { result.error = String(e.stack || e); }
  finally {
    if (active) { active.kill(); await new Promise(resolve => active.on('close', resolve)); }
    if (monitor) { const r = await monitor.stop(); result.observer = r.observer; result.observerIssue = r.issue; result.resourceChunks = [];
      for (let n = 0; n < r.rows.length; n += 200) result.resourceChunks.push(store.save('lifecycle', { schema: 'mvp-hevc-pipeline-resources-v1', rows: r.rows.slice(n, n + 200) }));
      if (r.issue) result.passed = false; }
    const after = fs.lstatSync(file, { bigint: true }); result.originalUnchanged = ['dev', 'ino', 'size', 'mtimeNs'].every(k => before[k] === after[k]) && await digest(file) === sourceSha256;
    if (!result.originalUnchanged) result.passed = false;
    result.limitations = ['One read-only run per variant, fixed order 2/1/4, no OS cache flush or repetitions.',
      'Source decode/scale/JPEG/PCM pipe only; filesystem cache publication, source analysis, window/JPEG/audio initialization are excluded.',
      'Identical bytes/time and diagnostic elapsed times do not constitute complete P-03 or a guaranteed final speedup.'];
    const receipt = store.save('audit', result); store.close(); console.log(JSON.stringify({ receipt, passed: result.passed, error: result.error }));
  }
  if (!result.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
