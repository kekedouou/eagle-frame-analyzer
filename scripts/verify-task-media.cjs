'use strict';
// Explicit actual guard/Node/media/cache verification, never a UI measurement.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { createTaskClient } = require('../plugin/task-client.cjs'), { createCache } = require('../plugin/cache.cjs');
const repo = path.resolve(__dirname, '..'), root = path.join(repo, 'plugin'), runtime = process.env.EVA_EAGLE_EXECUTABLE;
const cancelOnly = process.argv.includes('--cancel-only');
const config = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json')));
const baseline = config.sources.find(s => s.key === 'baseline'), fixture = config.sources.find(s => s.key === 'h264-cfr');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const inventory = () => createCache({ pluginRoot: root }).inventory();
const snapshot = s => ({ id: s.key, itemId: s.key, name: s.name || s.key, ext: 'mp4', filePath: s.file });
const client = () => createTaskClient({ pluginRoot: root, runtime, discoverTools: async () => ({ ffmpeg: config.ffmpeg, ffprobe: config.ffprobe }) });
function originals() { return (cancelOnly ? [fixture] : [baseline, fixture]).map(s => { const stat = fs.lstatSync(s.file, { bigint: true });
  assert(stat.isFile() && !stat.isSymbolicLink()); const digest = sha(fs.readFileSync(s.file)); assert.equal(digest, s.sha256);
  return { sha256: digest, ino: stat.ino.toString(), bytes: stat.size.toString(), modified: stat.mtimeNs.toString() }; }); }
async function main() {
  assert(runtime && path.isAbsolute(runtime), 'Set EVA_EAGLE_EXECUTABLE for this explicit developer check.');
  const before = inventory(); assert.equal(before.leases.length, 0, 'Close real player windows before this isolated technical check.');
  if (!cancelOnly) assert(before.caches.some(c => c.sourceSha256 === baseline.sha256), 'Baseline complete cache is absent; do not rebuild it just for a historical reuse test.');
  assert(!before.caches.some(c => c.sourceSha256 === fixture.sha256), 'Existing fixture complete cache must be preserved, not reset to force a test.');
  const sources = originals(), old = before.caches.map(c => ({ directory: c.directory, bytes: c.bytes })), results = [];
  if (!cancelOnly) { const a = client();
  try { const info = await a.media.prepare(snapshot(baseline)), bytes = await a.cache.readAsset(info, info.frames[0].file);
    assert.equal(sha(bytes), info.frames[0].sha256); await a.cache.release(info);
    results.push({ case: 'existing-complete-local-read', reused: info.metrics.reused, frames: info.frames.length, firstFrameSha256: sha(bytes) });
  } finally { await a.close(); } }
  for (const stage of ['decode', 'verify']) {
    const c = client(), controller = new AbortController(); let cancelled = false, peak = 0, exceeded = false;
    const monitor = setInterval(() => {
      let bytes = 0;
      for (const name of fs.readdirSync(path.join(root, 'cache')).filter(n => /^partial-/.test(n)))
        for (const f of fs.readdirSync(path.join(root, 'cache', name))) bytes += fs.statSync(path.join(root, 'cache', name, f)).size;
      peak = Math.max(peak, bytes); if (bytes > 256 * 1024 ** 2) { exceeded = true; controller.abort(); }
    }, 250);
    try {
      await assert.rejects(c.media.prepare(snapshot(fixture), { signal: controller.signal, onProgress: value => {
        if (value.stage === stage) { cancelled = true; controller.abort(); }
      } }), error => error.code === 'MEDIA_CANCELLED');
      assert(cancelled && !exceeded); results.push({ case: stage + '-cancel-waits-real-tool-and-write-exit', peakObservedTemporaryBytes: peak });
    } finally { clearInterval(monitor); await c.close(); }
    assert.equal(inventory().leases.length, 0);
  }
  if (!cancelOnly) { const broken = client(), worker = await broken.ping(); let killed = false;
  try {
    await assert.rejects(broken.media.prepare(snapshot(fixture), { onProgress: value => {
      if (!killed && value.stage === 'decode') { killed = true; process.kill(worker.pid); } // This connected, owned Node worker only, never Eagle GUI.
    } }), error => error.code === 'TASK_OWNER_EXITED');
    assert(killed); await assert.rejects(broken.close());
  } finally { await broken.close().catch(() => {}); }
  const replacement = client();
  try { const info = await replacement.media.prepare(snapshot(baseline)); await replacement.cache.release(info);
    results.push({ case: 'worker-interrupted-during-media-next-owner-recovers', reused: info.metrics.reused });
  } finally { await replacement.close(); } }
  const after = inventory();
  assert.equal(after.leases.length, 0); assert.deepStrictEqual(after.caches.map(c => ({ directory: c.directory, bytes: c.bytes })), old);
  assert.deepStrictEqual(originals(), sources);
  console.log(JSON.stringify({ protocol: 'eva-real-guard-media-v1', mode: cancelOnly ? 'cancel-only' : 'complete', passed: true, results, originalsUnchanged: true,
    completeCachesPreserved: old.length, transientAbsent: !fs.readdirSync(path.join(root, 'cache')).some(n => /^(?:partial-|writer\.lock|lease-|recovery\.lock)/.test(n)),
    eagleGuiOrLibraryExecuted: false, boundary: 'Real owned Windows guard, Eagle Node16, FFmpeg and disk cache; no actual Eagle window or performance acceptance.' }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
