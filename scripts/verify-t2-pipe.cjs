'use strict';
// Same media args, discard bounded image/audio pipes. No generated files,
// cache transactions or Eagle access; not P-03/browser readiness evidence.
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const { createStore } = require('../tests/support/t2-evidence.cjs');
const { _test: { ffmpegArgs, JpegParser } } = require('../plugin/media.cjs');
const { _test: { selectedInput } } = require('./verify-t2-close.cjs');
const repo = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json'))), source = selectedInput(cfg);
  const store = createStore(repo), report = { schema: 't2-hevc-pipe-diagnostic-v1', at: new Date().toISOString(),
    origin: 'local-same-FFmpeg-args-drained-pipes-no-cache-writes', source, args: ffmpegArgs(source.file, true, 'hevc'),
    sourceHashes: Object.fromEntries(['plugin/media.cjs', 'scripts/verify-t2-pipe.cjs'].map(f => [f, sha(fs.readFileSync(path.join(repo, f)))])),
    frames: 0, jpegBytes: 0, audioBytes: 0, peakRssBytes: null, rssSamples: 0, firstImageAtMs: null,
    passed: false, actualEagleExecuted: false, performanceGatePassed: false,
    limits: { milliseconds: 60000, jpegBytes: 256 * 1024 ** 2, audioBytes: 16 * 1024 ** 2, ffmpegRssBytes: 1024 ** 3 },
    limitations: ['Discarded outputs: no cache transaction, final validation, browser/UI/audio readiness.',
      'Same args and parser, sampler startup included but no formal process registration.',
      'Warm source/OS cache; sampled FFmpeg peak can be missed. Not a cold-disk or physical display measurement.'] };
  const override = process.argv.find(x => x.startsWith('--decoder-threads='));
  if (override) {
    const threads = Number(override.split('=')[1]);
    if (![2, 4, 8].includes(threads)) throw new Error('Diagnostic decoder threads must be 2, 4 or 8.');
    const at = report.args.indexOf('-threads');
    if (at < 0 || at > report.args.indexOf('-i')) throw new Error('Decoder thread argument missing.');
    report.args[at + 1] = String(threads); report.experimentalDecoderThreads = threads;
  }
  let child, childClosed, monitor, monitorClosed, timer, error, started, stderrBytes = 0, pending = '', log = '';
  const jpegHash = crypto.createHash('sha256'), audioHash = crypto.createHash('sha256');
  const videoPts = [], audioPts = [];
  store.start({ reserveBytes: 64 * 1024 });
  const stop = message => { if (!error) error = new Error(message); if (child) child.kill(); };
  try {
    report.sourceBefore = sha(fs.readFileSync(source.file));
    if (report.sourceBefore !== source.sha256) throw new Error('Source SHA differs from registered input.');
    started = performance.now();
    child = cp.spawn(cfg.ffmpeg, report.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    childClosed = new Promise(resolve => { child.once('error', e => { error = e; resolve({ spawnError: e.message }); }); child.once('close', (code, signal) => resolve({ code, signal })); });
    const parser = new JpegParser();
    const script = '$ErrorActionPreference="Stop";try{$p=[Diagnostics.Process]::GetProcessById(' + child.pid +
      ');while(!$p.HasExited){$p.Refresh();[Console]::WriteLine(([string]$p.WorkingSet64)+","+([string]$p.PeakWorkingSet64));Start-Sleep -Milliseconds 100}}catch{}';
    monitor = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    monitorClosed = new Promise(resolve => { monitor.once('close', resolve); monitor.once('error', resolve); });
    monitor.stdout.on('data', b => {
      pending += b.toString('ascii'); const rows = pending.split(/\r?\n/); pending = rows.pop();
      if (pending.length > 1024) { stop('Resource sampler record bound exceeded.'); return; }
      for (const line of rows) { const m = /^(\d+),(\d+)$/.exec(line); if (!m) continue;
        const used = Math.max(+m[1], +m[2]); report.rssSamples++;
        report.peakRssBytes = Math.max(report.peakRssBytes || 0, used);
        if (used >= report.limits.ffmpegRssBytes) stop('Owned FFmpeg reached 1GiB observation stop.'); }
    });
    child.stdout.on('data', b => {
      report.jpegBytes += b.length;
      jpegHash.update(b);
      if (report.jpegBytes > report.limits.jpegBytes) { stop('JPEG diagnostic bound exceeded.'); return; }
      try { for (const _ of parser.push(b)) { report.frames++;
        if (report.firstImageAtMs === null) report.firstImageAtMs = performance.now() - started; } }
      catch (e) { stop(e.message); }
    });
    child.stdio[3].on('data', b => { report.audioBytes += b.length; audioHash.update(b);
      if (report.audioBytes > report.limits.audioBytes) stop('Audio diagnostic bound exceeded.'); });
    child.stderr.on('data', b => { stderrBytes += b.length; log += b.toString('utf8');
      if (stderrBytes > 1024 ** 2) stop('Diagnostic stderr bound exceeded.'); });
    timer = setTimeout(() => stop('Owned FFmpeg exceeded 60s diagnostic limit.'), report.limits.milliseconds);
    report.exit = await childClosed; report.elapsedMs = performance.now() - started;
    if (error) throw error;
    if (report.exit.code !== 0 || parser.buffer.length || report.frames !== 1596) throw new Error('Incomplete expected 1596-frame pipe.');
    for (const line of log.split(/\r?\n/)) {
      const m = /n:\s*(\d+)\s+pts:\s*(-?\d+)/.exec(line);
      if (!m) continue;
      if (line.includes('ashowinfo@a')) audioPts.push([+m[1], m[2]]);
      else if (line.includes('showinfo@v')) videoPts.push([+m[1], m[2]]);
    }
    if (videoPts.length !== report.frames || !audioPts.length) throw new Error('Missing output timestamp evidence.');
    report.outputHashes = { jpeg: jpegHash.digest('hex'), audio: audioHash.digest('hex'),
      videoPts: sha(JSON.stringify(videoPts)), audioPts: sha(JSON.stringify(audioPts)),
      videoPtsCount: videoPts.length, audioPtsCount: audioPts.length };
    report.passed = true;
  } catch (e) { error = e; report.error = { message: e.message, stack: e.stack }; }
  finally {
    clearTimeout(timer); if (child && !report.exit) child.kill(); if (childClosed) await childClosed;
    if (monitor) monitor.kill(); if (monitorClosed) await monitorClosed;
    report.sourceUnchanged = sha(fs.readFileSync(source.file)) === source.sha256;
    if (!report.sourceUnchanged) report.passed = false;
    try { console.log(JSON.stringify({ report, receipt: store.save('audit', report) })); }
    finally { store.close(); }
  }
  if (!report.passed) throw error || new Error('Source changed during diagnostic.');
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
