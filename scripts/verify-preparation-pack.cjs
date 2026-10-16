'use strict';
// Explicit actual-media comparison, not an Eagle GUI or drag benchmark.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { createCache } = require('../plugin/cache.cjs'), { createMedia } = require('../plugin/media.cjs');
const { Budget } = require('../plugin/player.js'), { createStore } = require('../tests/support/t4-evidence.cjs');
const repo = fs.realpathSync(path.resolve(__dirname, '..')), scratch = path.join(repo, 'tests/host/t4/preparation-scratch'), MIB = 1024 ** 2;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function stamp(file) {
  const s = fs.lstatSync(file, { bigint: true });
  assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && fs.realpathSync(file).toLowerCase() === file.toLowerCase());
  return { ino: String(s.ino), dev: String(s.dev), bytes: Number(s.size), modified: String(s.mtimeNs) };
}
async function digest(file) { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
async function main() {
  const args = process.argv.slice(2); assert(args[0] === 'compare' && args.length <= 2 && (!args[1] || args[1] === '--reverse'), 'Explicit compare [--reverse] required.');
  const store = createStore(repo), baseFile = path.join(repo, 'verification-runs/t4/slot-047/record.json'), raw = fs.readFileSync(baseFile);
  const source = store.readReceipt({ file: baseFile, bytes: raw.length, sha256: sha(raw) }).source;
  assert.equal(source.itemId, 'MV3FZJJ7AC1CI'); assert.equal(source.sha256, '0823a48f0d7b365163297206e8e8c66591c3aa6cf4c30253b3187d19c9644cba');
  const before = stamp(source.filePath); assert.equal(await digest(source.filePath), source.sha256);
  assert(!fs.existsSync(scratch), 'Inspect retained scratch before retry.'); assert.equal(fs.realpathSync(path.dirname(scratch)), path.dirname(scratch));
  store.start({ reserveBytes: 2 * MIB }); fs.mkdirSync(scratch);
  const owner = { schema: 'mvp-packed-preparation-diagnostic-v1', root: scratch, nonce: crypto.randomBytes(12).toString('hex'), sourceSha256: source.sha256 };
  fs.writeFileSync(path.join(scratch, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json'))), roots = ['loose', 'packed'];
  for (const n of roots) fs.mkdirSync(path.join(scratch, n));
  const result = { schema: 'mvp-packed-preparation-comparison-v1', at: new Date().toISOString(), source, runtime: process.versions,
    codeHashes: Object.fromEntries(['plugin/cache.cjs', 'plugin/media.cjs', 'plugin/frame-pack.cjs', 'scripts/verify-preparation-pack.cjs'].map(f => [f, sha(fs.readFileSync(path.join(repo, f)))])),
    limits: { combinedScratchBytes: 256 * MIB, eachCacheBytes: 120 * MIB, eachCaseMs: 60000, ramBytes: 1024 ** 3, compressedBytes: 128 * MIB },
    order: args[1] ? ['packed', 'loose'] : roots, cases: [], passed: false, fullEagleReadinessMeasured: false, productCacheTouched: false };
  let monitor, currentAbort, failure, timer, cleanup;
  const stop = e => { failure = failure || e; if (currentAbort) currentAbort.abort(); };
  try {
    monitor = require('../tests/support/mvp-monitor.cjs').start({ ramBytes: 1024 ** 3, now: () => performance.now(), snapshot: () => ({ state: 'preparation-comparison', kind: result.cases.length }), onStop: stop });
    for (const kind of result.order) {
      const cache = createCache({ pluginRoot: path.join(scratch, kind), diskBytes: result.limits.eachCacheBytes, packFrames: kind === 'packed' });
      const media = createMedia({ tools: cfg, cache }); currentAbort = new AbortController(); let info;
      timer = setTimeout(() => stop(Error('Preparation case exceeded 60 seconds.')), result.limits.eachCaseMs);
      const began = performance.now(), item = { kind }; result.cases.push(item);
      try {
        info = await media.prepare({ id: source.itemId, itemId: source.itemId, name: '索尼克', filePath: source.filePath, ext: 'mp4' }, { signal: currentAbort.signal });
        assert(!info.metrics.reused && info.frames.length === 1490 && info.audio); item.media = info.metrics;
        assert.equal(!!info.framePack, kind === 'packed');
        const budget = new Budget(result.limits.ramBytes), resident = [], tokens = [], hash = crypto.createHash('sha256');
        let bytes = 0, batches = 0; const warmAt = performance.now();
        try {
          for (let n = 0; n < info.frames.length;) {
            if (failure) throw failure;
            const frames = []; let batchBytes = 0;
            while (n < info.frames.length && (kind === 'loose' ? frames.length < 2 : batchBytes + info.frames[n].bytes <= MIB)) {
              const frame = info.frames[n++]; frames.push(frame); batchBytes += frame.bytes;
            }
            assert(frames.length && bytes + batchBytes <= result.limits.compressedBytes);
            const pending = frames.map(f => budget.reserve(f.bytes * 2, 'compressed-loading')); tokens.push(...pending);
            const buffers = kind === 'packed' ? await cache.readFrameBatch(info, frames.map(f => f.file)) : await Promise.all(frames.map(f => cache.readAsset(info, f.file)));
            buffers.forEach((data, i) => { assert.equal(sha(data), frames[i].sha256); budget.shrink(pending[i], data.length, 'compressed-jpeg'); resident.push(data); hash.update(data); bytes += data.length; }); batches++;
          }
          item.preload = { elapsedMs: performance.now() - warmAt, frames: resident.length, bytes, batches, jpegStreamSha256: hash.digest('hex'), budget: budget.snapshot() };
          assert.equal(item.preload.jpegStreamSha256, 'f6e66907db085942b9ae259c161b463bb34153960e77ba704188858026482715');
          item.throughJpegPreloadMs = performance.now() - began;
        } finally { resident.length = 0; for (const token of tokens) budget.release(token); assert.equal(budget.used, 0); }
        item.frameDirectorySha256 = sha(JSON.stringify(info.frames.map(f => [f.id, f.ptsTicks, f.timeBase, f.time, f.end, f.bytes, f.sha256])));
        item.audio = { sha256: info.audio.sha256, bytes: info.audio.bytes, duration: info.audio.duration, start: info.audio.start };
        await cache.release(info); info = null; item.inventory = cache.inventory(); assert.equal(item.inventory.leases.length, 0);
        if (failure) throw failure; item.passed = true;
        console.log(JSON.stringify({ phase: 'case-complete', kind, mediaMs: item.media.preparationMs, generationMs: item.media.generationMs, preloadMs: item.preload.elapsedMs, throughJpegPreloadMs: item.throughJpegPreloadMs, batches: item.preload.batches }));
      } finally { clearTimeout(timer); if (info) await cache.release(info); currentAbort = null; }
    }
    assert.equal(result.cases[0].frameDirectorySha256, result.cases[1].frameDirectorySha256); assert.deepStrictEqual(result.cases[0].audio, result.cases[1].audio);
    const leaves = [], dirs = [];
    function walk(dir) {
      assert(dir === scratch || dir.startsWith(scratch + path.sep)); assert.equal(fs.realpathSync(dir), dir); const s = fs.lstatSync(dir, { bigint: true });
      assert(s.isDirectory() && !s.isSymbolicLink()); dirs.push({ dir, ino: String(s.ino), dev: String(s.dev) });
      for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name), value = fs.lstatSync(file);
        if (value.isDirectory()) walk(file); else leaves.push({ file, ...stamp(file), sha256: sha(fs.readFileSync(file)) }); }
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(scratch, 'owner.json'))), owner); walk(scratch);
    result.actualScratchBytes = leaves.reduce((n, f) => n + f.bytes, 0); assert(result.actualScratchBytes <= result.limits.combinedScratchBytes);
    cleanup = { leaves, dirs }; if (failure) throw failure; result.passed = true;
  } catch (e) { result.error = String(e.stack || e); }
  finally {
    clearTimeout(timer);
    if (monitor) { const resources = await monitor.stop(); result.observer = resources.observer; result.observerIssue = resources.issue; result.resourceChunks = [];
      for (let n = 0; n < resources.rows.length; n += 200) result.resourceChunks.push(store.save('lifecycle', { schema: 'mvp-preparation-pack-resource-chunk-v1', rows: resources.rows.slice(n, n + 200) }));
      if (resources.issue) result.passed = false;
    }
    result.sourceUnchanged = JSON.stringify(stamp(source.filePath)) === JSON.stringify(before) && await digest(source.filePath) === source.sha256;
    if (!result.sourceUnchanged) result.passed = false;
    if (result.passed && cleanup) {
      result.cleanupPlanReceipt = store.save('audit', { schema: 'mvp-packed-preparation-cleanup-v1', owner, ...cleanup });
      for (const leaf of cleanup.leaves) { assert.deepStrictEqual(stamp(leaf.file), { ino: leaf.ino, dev: leaf.dev, bytes: leaf.bytes, modified: leaf.modified }); assert.equal(await digest(leaf.file), leaf.sha256); }
      for (const d of cleanup.dirs) { const st = fs.lstatSync(d.dir, { bigint: true }); assert(st.isDirectory() && !st.isSymbolicLink()); assert.equal(String(st.ino), d.ino); assert.equal(String(st.dev), d.dev); }
      for (const leaf of cleanup.leaves) fs.unlinkSync(leaf.file);
      for (const d of cleanup.dirs.reverse()) fs.rmdirSync(d.dir);
      result.scratchRemoved = !fs.existsSync(scratch);
    } else result.scratchRetained = fs.existsSync(scratch);
    result.limitations = ['Production media/cache with real disk and JPEG preload; no Eagle window, decoded image, Web Audio initialization or first draw endpoint.',
      'One paired comparison per invocation, fixed order; OS file cache not cleared. Through-preload is not full P-03.',
      'Managed budget here covers compressed preloading only; native sampler separately observes process resources.'];
    const receipt = store.save('audit', result); store.close(); console.log(JSON.stringify({ receipt, ...result }));
  }
  if (!result.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
