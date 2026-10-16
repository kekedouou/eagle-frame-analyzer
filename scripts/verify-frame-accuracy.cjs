'use strict';
// Explicit real guard/Eagle-Node/media + independent source checks. No Eagle GUI.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert'), { spawn } = require('child_process');
const { createTaskClient, verifyGuard } = require('../plugin/task-client.cjs'), { createStore } = require('../tests/support/t4-evidence.cjs');
const { compare } = require('../tests/support/frame-reference.cjs'), reference = require('../tests/support/t0-reference.cjs');
const repo = fs.realpathSync(path.resolve(__dirname, '..')), scratch = path.join(repo, 'tests/host/t4/accuracy-scratch'), MIB = 1024 ** 2;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function stamp(file) { const s = fs.lstatSync(file, { bigint: true });
  assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && fs.realpathSync(file).toLowerCase() === file.toLowerCase());
  return { ino: String(s.ino), dev: String(s.dev), bytes: Number(s.size), modified: String(s.mtimeNs) }; }
async function digest(file) { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
function capture(tool, args, settings = {}) {
  return new Promise((resolve, reject) => {
    if (settings.signal && settings.signal.aborted) return reject(Error('Independent reference cancelled.'));
    const child = spawn(tool, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0, error = null, stderr = '';
    const stop = e => { error = error || e; child.kill(); };
    const aborted = () => stop(Error('Independent reference cancelled.'));
    if (settings.signal) settings.signal.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => stop(Error('Independent reference exceeded 60 seconds.')), 60000);
    child.on('error', e => { error = error || e; }); child.stdin.on('error', e => { error = error || e; });
    child.stdout.on('data', b => { bytes += b.length; if (bytes > (settings.maxBytes || 32 * MIB)) stop(Error('Reference output exceeded bound.')); else chunks.push(b); });
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-8192); });
    child.on('close', code => { clearTimeout(timer); if (settings.signal) settings.signal.removeEventListener('abort', aborted);
      if (error || code) reject(error || Error(stderr)); else resolve({ stdout: Buffer.concat(chunks, bytes) }); });
    child.stdin.end(settings.input);
  });
}
async function main() {
  const remaining = process.argv.slice(2).join(' ') === '--remaining-formats';
  assert(process.argv.length === 2 || remaining, 'Use no arguments or --remaining-formats.'); assert(!fs.existsSync(scratch), 'Inspect retained scratch before retry.');
  assert.equal(fs.realpathSync(path.dirname(scratch)), path.dirname(scratch)); verifyGuard(path.join(repo, 'plugin'));
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json'))), store = createStore(repo);
  const input = { key: 'MV86BTRC4CVVG', file: 'G:\\Assets\\Eagle\\库\\设计素材.library\\images\\MV86BTRC4CVVG.info\\2026-10-14 21-54-41.mp4',
    sha256: '679691666daf5038e8316978cfac4916e5aa8ef1906919f07b5fa400921093db', label: '2026-10-14 21-54-41' };
  let sources = [input, ...config.sources.filter(s => ['h264-cfr', 'hevc-vfr', 'vp9-silent'].includes(s.key))];
  if (remaining) {
    const baseline = config.sources.find(s => s.key === 'baseline'), images = path.dirname(path.dirname(baseline.file));
    const extra = [['MV6H7OK0MBGX2', 'd7bbab0b425381c880adacb9f8d95d900aa162c4c5c9308cf9a3f8482ff67658'],
      ['MV6H46XZIFUFI', 'a35814395cc39b73c1d705b0d4cca7096ffb1974e6b85f9243815079195f1042']].map(([key, sha256]) => {
      const dir = path.join(images, key + '.info'), names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.mp4'));
      assert.equal(names.length, 1); return { key, sha256, file: path.join(dir, names[0]), label: names[0] };
    }); sources = [baseline, ...extra];
  }
  const originals = []; for (const s of sources) { assert.equal(await digest(s.file), s.sha256); originals.push({ file: s.file, ...stamp(s.file), sha256: s.sha256 }); }
  store.start({ reserveBytes: 2 * MIB }); fs.mkdirSync(scratch);
  const owner = { schema: 'mvp-frame-accuracy-runtime-v1', root: scratch, nonce: crypto.randomBytes(12).toString('hex') };
  fs.writeFileSync(path.join(scratch, 'owner.json'), JSON.stringify(owner), { flag: 'wx' }); fs.mkdirSync(path.join(scratch, 'native'));
  const files = ['task-worker.cjs', 'cache.cjs', 'frame-pack.cjs', 'frame-index.cjs', 'media.cjs', 'process-identity.cjs', 'native/task-host.cs', 'native/task-host.local.exe', 'native/task-host.local.json'];
  for (const file of files) fs.writeFileSync(path.join(scratch, file), fs.readFileSync(path.join(repo, 'plugin', file)), { flag: 'wx' });
  const workerFile = path.join(scratch, 'task-worker.cjs'), originalWorker = fs.readFileSync(workerFile);
  assert(originalWorker.toString().includes('processIdentity: identity, packFrames: true'));
  fs.writeFileSync(workerFile, originalWorker.toString().replace('processIdentity: identity, packFrames: true', 'processIdentity: identity, packFrames: true, diskBytes: 240 * 1024 ** 2'));
  const result = { schema: 'mvp-real-frame-reference-v1', at: new Date().toISOString(), runtime: process.versions, owner, originals, cases: [], passed: false,
    codeHashes: Object.fromEntries([...files.map(f => 'plugin/' + f), 'plugin/player.js', 'plugin/ui.js', 'scripts/verify-frame-accuracy.cjs', 'tests/support/frame-reference.cjs'].map(f => [f, sha(fs.readFileSync(path.join(repo, f)))])),
    testWorkerPatch: { fromSha256: sha(originalWorker), toSha256: sha(fs.readFileSync(workerFile)), diskBytes: 240 * MIB },
    limits: { scratchBytes: 256 * MIB, managedRamBytes: 1024 ** 3 }, realEagleGuiExecuted: false, normalCacheTouched: false };
  let monitor, failure = null, client = null, controller = null, referenceAbort = null, info = null, cleanup = null;
  const stop = error => { failure = failure || error; if (controller) controller.abort(); if (referenceAbort) referenceAbort.abort(); };
  try {
    monitor = require('../tests/support/mvp-monitor.cjs').start({ ramBytes: 1024 ** 3, now: () => performance.now(), onStop: stop,
      snapshot: () => ({ protocol: 'independent-source-frames', case: result.cases.length }) });
    for (const s of sources) {
      if (failure) throw failure;
      const row = { key: s.key, source: s, passed: false }; result.cases.push(row);
      client = createTaskClient({ pluginRoot: scratch, runtime: 'G:\\Assets\\Eagle\\Eagle.exe', discoverTools: async () => config });
      controller = new AbortController(); const timer = setTimeout(() => stop(Error('Media preparation exceeded 60 seconds.')), 60000);
      try { info = await client.media.prepare({ id: s.key, itemId: s.key, name: s.label || s.key, filePath: s.file, ext: 'mp4' }, { signal: controller.signal }); }
      finally { clearTimeout(timer); controller = null; }
      if (failure) throw failure;
      referenceAbort = new AbortController();
      const probe = JSON.parse((await capture(config.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames',
        '-show_entries', 'stream=time_base,start_pts,duration_ts:frame=pts,best_effort_timestamp,duration,pkt_duration', '-of', 'json', s.file], { maxBytes: 4 * MIB, signal: referenceAbort.signal })).stdout);
      row.timeline = compare(info, probe); row.frames = info.frames.length; row.duration = info.duration; row.lastFrame = info.frames[info.frames.length - 1]; row.metrics = info.metrics;
      const current = info, withKey = { ...info, source: { ...info.source, key: s.key } };
      const backend = { getConfig: () => ({ sources }), readAsset: (_, name) => client.cache.readAsset(current, name),
        runReadOnlyTool: (kind, args, settings) => capture(config[kind], args, { ...settings, signal: referenceAbort.signal }) };
      const indices = reference.selectedIndices(info.frames.length), chunks = []; let group = [];
      function bytes(list) { return [...new Set(list.flatMap(n => [Math.max(0, n - 1), n, Math.min(info.frames.length - 1, n + 1)]))].reduce((sum, n) => sum + info.frames[n].bytes, 0); }
      for (const n of indices) { if (group.length && bytes([...group, n]) > 16 * MIB) { chunks.push(group); group = []; } group.push(n); }
      if (group.length) chunks.push(group);
      row.jpegReference = { checked: 0, passed: true, chunks: [] };
      for (const ordinals of chunks) { const r = await reference.verifyJpegReference(backend, withKey, { save: false, indices: ordinals });
        assert(r.passed); row.jpegReference.checked += r.checked; row.jpegReference.chunks.push(r); }
      if (s.expectedFile) {
        const expected = JSON.parse(fs.readFileSync(s.expectedFile)).expected, buffers = [];
        for (const f of info.frames) buffers.push(await client.cache.readAsset(info, f.file));
        const spec = expected.barcode, width = (spec.bits - 1) * spec.step + 1;
        const crop = 'format=gray,crop=' + width + ':1:' + (spec.x + spec.sampleXOffset) + ':' + (spec.y + spec.sampleYOffset);
        const decoded = await capture(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0',
          '-an', '-vf', crop, '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { input: Buffer.concat(buffers), maxBytes: MIB });
        row.numberedFrames = reference.barcode(decoded.stdout, expected); assert(row.numberedFrames.every(f => f.ok));
      } else if (s.key === input.key) {
        assert.equal(info.frames.length, 582); assert.equal(info.frames[581].ptsTicks, '873000');
        assert.equal(info.frames[581].end, 874500 / 90000); assert(info.metrics.lastFrameEnd.startsWith('decoded final PTS'));
      }
      await client.cache.release(info); info = null;
      const cleared = await client.cache.clearOther({ sourceSha256: '0'.repeat(64) });
      await client.close(); client = null; row.cleared = cleared; row.passed = true;
      referenceAbort = null;
      console.log(JSON.stringify({ case: s.key, frames: row.frames, matchedReferencePictures: row.jpegReference.checked, passed: true }));
    }
    const leaves = [], dirs = [];
    function walk(dir) { assert(dir === scratch || dir.startsWith(scratch + path.sep)); assert.equal(fs.realpathSync(dir), dir);
      const s = fs.lstatSync(dir, { bigint: true }); assert(s.isDirectory() && !s.isSymbolicLink()); dirs.push({ dir, ino: String(s.ino), dev: String(s.dev) });
      for (const n of fs.readdirSync(dir)) { const f = path.join(dir, n); if (fs.lstatSync(f).isDirectory()) walk(f); else leaves.push({ file: f, ...stamp(f), sha256: sha(fs.readFileSync(f)) }); } }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(scratch, 'owner.json'))), owner); walk(scratch);
    assert(leaves.reduce((n, f) => n + f.bytes, 0) <= result.limits.scratchBytes); cleanup = { leaves, dirs };
    if (failure) throw failure; result.passed = true;
  } catch (e) { result.error = String(e.stack || e); }
  finally {
    if (client) { try { if (info) await client.cache.release(info); await client.close(); } catch (e) { result.passed = false; result.closeError = e.message; } }
    if (monitor) { const r = await monitor.stop(); result.observer = r.observer; result.observerIssue = r.issue; result.resourceChunks = [];
      for (let n = 0; n < r.rows.length; n += 200) result.resourceChunks.push(store.save('lifecycle', { schema: 'mvp-frame-reference-resources-v1', rows: r.rows.slice(n, n + 200) }));
      if (r.issue) result.passed = false; }
    result.originalsUnchanged = true;
    for (const f of originals) if (JSON.stringify(stamp(f.file)) !== JSON.stringify({ ino: f.ino, dev: f.dev, bytes: f.bytes, modified: f.modified }) || await digest(f.file) !== f.sha256) result.originalsUnchanged = false;
    if (!result.originalsUnchanged) result.passed = false;
    if (result.passed && cleanup) {
      result.cleanupReceipt = store.save('audit', { schema: 'mvp-frame-reference-cleanup-v1', owner, ...cleanup });
      for (const f of cleanup.leaves) { assert.deepStrictEqual(stamp(f.file), { ino: f.ino, dev: f.dev, bytes: f.bytes, modified: f.modified }); assert.equal(await digest(f.file), f.sha256); }
      for (const d of cleanup.dirs) { const s = fs.lstatSync(d.dir, { bigint: true }); assert(s.isDirectory() && !s.isSymbolicLink() && String(s.ino) === d.ino && String(s.dev) === d.dev); }
      for (const f of cleanup.leaves) fs.unlinkSync(f.file); for (const d of cleanup.dirs.reverse()) fs.rmdirSync(d.dir); result.scratchRemoved = !fs.existsSync(scratch);
    } else result.scratchRetained = fs.existsSync(scratch);
    result.limitations = ['Actual independent source decoding, all PTS and numbered JPEG contents; no real Canvas/physical screen or GUI keyboard/step responsiveness acceptance.',
      'Fresh JPEG references share the media decoder/recipe; identical neighboring pictures remain explicitly indistinguishable.',
      'One generation per existing input, not P-03 repeated full-window or long stability acceptance.'];
    const receipt = store.save('audit', result); store.close(); console.log(JSON.stringify({ receipt, passed: result.passed, error: result.error, scratchRemoved: result.scratchRemoved, originalsUnchanged: result.originalsUnchanged }));
  }
  if (!result.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { capture };
