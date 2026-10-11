'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const backend = require('../tests/support/t0-media.cjs');
const reference = require('../tests/support/t0-reference.cjs');
const repo = path.resolve(__dirname, '..');
function execute(file, args) {
  const result = spawnSync(file, args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 ** 2 });
  if (result.error || result.status !== 0) throw new Error(result.error ? result.error.message : result.stderr || 'Command failed');
  return result.stdout;
}
function metadata() {
  const config = backend.getConfig();
  const list = ['plugin/frame-index.cjs', 'plugin/player.js', 'tests/support/t0-media.cjs', 'tests/support/t0-protocol.cjs', 'tests/support/t0-selection.cjs', 'tests/support/t0-reference.cjs', 'tests/host/t0/app.js'];
  return { node: process.versions.node, platform: process.platform, gitHead: execute('git', ['rev-parse', 'HEAD']).trim(),
    gitStatus: execute('git', ['status', '--short']), sourceFiles: list.map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex') })),
    ffmpegVersion: execute(config.ffmpeg, ['-version']), ffprobeVersion: execute(config.ffprobe, ['-version']) };
}
async function main() {
  const [mode, ...keys] = process.argv.slice(2);
  if (mode === 'record-checks' && !keys.length) {
    const output = execute(process.execPath, [path.join(repo, 'scripts/check.cjs')]);
    process.stdout.write(output);
    console.log('Evidence: ' + await backend.saveEvidence('local-checks', { origin: 'local-node-checks-not-eagle', executor: 'codex', environment: metadata(), output }));
    return;
  }
  if (!['reference', 'audio'].includes(mode) || !keys.length) throw new Error('Usage: node scripts/verify-t0.cjs record-checks | reference/audio baseline h264-cfr hevc-vfr vp9-silent');
  const controller = new AbortController(), stop = () => controller.abort(), results = [];
  process.once('SIGINT', stop);
  try {
    for (const key of keys) {
      let info;
      try {
        info = await backend.prepare(key, { signal: controller.signal });
        const report = mode === 'audio' ? await reference.verifyAudio(backend, info) : await reference.verify(backend, info, { signal: controller.signal });
        results.push(report);
        console.log(JSON.stringify(mode === 'audio' ? { key, ...report } : { key, frames: report.independentSourceFrameCount, ptsErrors: report.ptsErrors.length,
          checkedPixels: report.pixels.checked, pixelMismatches: report.pixels.mismatches.length,
          indeterminate: report.pixels.indeterminate || 0, passed: report.passed, evidence: report.evidenceFile }));
        if (!report.passed) throw new Error('Independent reference failed for ' + key);
      } finally { if (info) await backend.release(info); }
    }
    console.log('Evidence: ' + await backend.saveEvidence('local-' + mode + '-summary', { origin: 'local-real-media-not-eagle', environment: metadata(), results }));
  } catch (error) {
    console.error('Failure evidence: ' + await backend.saveEvidence('local-reference-failed', { origin: 'local-real-media-not-eagle', error: error.message, results }));
    throw error;
  } finally { process.removeListener('SIGINT', stop); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
