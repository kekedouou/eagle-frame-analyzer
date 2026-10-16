'use strict';
// Actual owned guard/Eagle-Node/media/cache; no real Eagle GUI or library write.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { createTaskClient, verifyGuard } = require('../plugin/task-client.cjs'), { createCache } = require('../plugin/cache.cjs');
const { createMedia } = require('../plugin/media.cjs'), { createStore } = require('../tests/support/t4-evidence.cjs');
const { rootIdentity } = require('./verify-resource-sampler.cjs');
const repo = fs.realpathSync(path.resolve(__dirname, '..')), scratch = path.join(repo, 'tests/host/t4/packed-runtime-scratch');
const runtime = process.env.EVA_EAGLE_EXECUTABLE, MIB = 1024 ** 2, sha = b => crypto.createHash('sha256').update(b).digest('hex');
function stat(file) { const s = fs.lstatSync(file, { bigint: true }); assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && fs.realpathSync(file).toLowerCase() === file.toLowerCase());
  return { ino: String(s.ino), dev: String(s.dev), bytes: Number(s.size), modified: String(s.mtimeNs) }; }
async function fileHash(file) { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
async function main() {
  assert(runtime && path.isAbsolute(runtime), 'Set EVA_EAGLE_EXECUTABLE for this explicit developer check.');
  const resume = process.argv.slice(2).join(' ') === '--resume-owned';
  assert(process.argv.length === 2 || resume); assert(resume ? fs.existsSync(scratch) : !fs.existsSync(scratch), 'Inspect retained owned runtime scratch before retry.');
  assert.equal(fs.realpathSync(path.dirname(scratch)), path.dirname(scratch)); verifyGuard(path.join(repo, 'plugin'));
  const store = createStore(repo), sf = path.join(repo, 'verification-runs/t4/slot-047/record.json'), sb = fs.readFileSync(sf);
  const source = store.readReceipt({ file: sf, bytes: sb.length, sha256: sha(sb) }).source;
  assert.equal(source.itemId, 'MV3FZJJ7AC1CI');
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json')));
  const sources = [{ key: source.itemId, file: source.filePath, sha256: source.sha256 }, ...['h264-cfr', 'hevc-vfr', 'vp9-silent'].map(key => config.sources.find(s => s.key === key))];
  const originals = []; for (const s of sources) { assert(s); const stamp = stat(s.file); assert.equal(await fileHash(s.file), s.sha256); originals.push({ file: s.file, ...stamp, sha256: s.sha256 }); }
  const saved = n => { const file = path.join(repo, 'verification-runs/t4/slot-' + n + '/record.json'), b = fs.readFileSync(file); return store.readReceipt({ file, bytes: b.length, sha256: sha(b) }); };
  let prior, priorSnapshot;
  if (resume) {
    prior = saved('109'); priorSnapshot = saved('110');
    assert(!prior.passed && prior.scratchRetained && prior.originalsUnchanged && priorSnapshot.root === scratch);
    for (const leaf of priorSnapshot.leaves) {
      assert(leaf.file.startsWith(scratch + path.sep)); assert.deepStrictEqual(stat(leaf.file), { ino: leaf.ino, dev: leaf.dev, bytes: leaf.bytes, modified: leaf.modified });
      assert.equal(await fileHash(leaf.file), leaf.sha256);
    }
  }
  store.start({ reserveBytes: 2 * MIB });
  const owner = resume ? JSON.parse(fs.readFileSync(path.join(scratch, 'diagnostic-owner.json'))) :
    { schema: 'mvp-packed-runtime-check-v1', root: scratch, nonce: crypto.randomBytes(12).toString('hex') };
  assert(owner.schema === 'mvp-packed-runtime-check-v1' && owner.root === scratch && /^[0-9a-f]{24}$/.test(owner.nonce));
  if (!resume) { fs.mkdirSync(scratch); fs.mkdirSync(path.join(scratch, 'native'));
    fs.writeFileSync(path.join(scratch, 'diagnostic-owner.json'), JSON.stringify(owner), { flag: 'wx' }); }
  const files = ['task-worker.cjs', 'cache.cjs', 'frame-pack.cjs', 'frame-index.cjs', 'media.cjs', 'process-identity.cjs',
    'native/task-host.cs', 'native/task-host.local.exe', 'native/task-host.local.json'];
  if (!resume) for (const file of files) fs.writeFileSync(path.join(scratch, file), fs.readFileSync(path.join(repo, 'plugin', file)), { flag: 'wx' });
  else fs.writeFileSync(path.join(scratch, 'cache.cjs'), fs.readFileSync(path.join(repo, 'plugin/cache.cjs'))); // Known copied module, snapshot verified above.
  const result = { schema: 'mvp-real-packed-runtime-check-v1', at: new Date().toISOString(), source, codeHashes: Object.fromEntries(files.map(f => [f, sha(fs.readFileSync(path.join(scratch, f)))])),
    cases: [], passed: false, realEagleGuiExecuted: false, productCacheTouched: false, resumedOwnedFailure: resume,
    ...(resume ? { priorFailure: 'slot-109', preservedSnapshot: 'slot-110', priorSuccessfulCases: prior.cases } : {}),
    limits: { scratchBytes: 256 * MIB, diskBytes: 240 * MIB, eachPrepareMs: 60000 } };
  const tools = { ffmpeg: config.ffmpeg, ffprobe: config.ffprobe }, allClients = [], caches = createCache({ pluginRoot: scratch, diskBytes: result.limits.diskBytes });
  // Worker product cache uses 5GiB normally; this verification wrapper tightens
  // its physical allowance without changing source or production defaults.
  const workerFile = path.join(scratch, 'task-worker.cjs'), worker = fs.readFileSync(workerFile, 'utf8');
  const originalConfig = 'processIdentity: identity, packFrames: true'; assert(worker.includes(originalConfig));
  if (!resume) fs.writeFileSync(workerFile, worker.replace(originalConfig, 'processIdentity: identity, packFrames: true, diskBytes: 240 * 1024 ** 2'));
  else assert.equal(sha(fs.readFileSync(workerFile)), prior.testOnlyWorkerBudgetPatch.toSha256);
  result.testOnlyWorkerBudgetPatch = { fromSha256: resume ? prior.testOnlyWorkerBudgetPatch.fromSha256 : result.codeHashes['task-worker.cjs'], toSha256: sha(fs.readFileSync(workerFile)), diskBytes: result.limits.diskBytes };
  const client = () => { const c = createTaskClient({ pluginRoot: scratch, runtime, discoverTools: async () => tools }); allClients.push(c); return c; };
  const snapshot = s => ({ id: s.key, itemId: s.key, name: s.key, filePath: s.file, ext: 'mp4' });
  let monitor, activeAbort = null, failure = null, cleanup = null;
  const stop = e => { failure = failure || e; if (activeAbort) activeAbort.abort(); };
  async function prepare(c, s, progress) {
    activeAbort = new AbortController(); const timer = setTimeout(() => stop(Error('Owned preparation exceeded 60 seconds.')), 60000);
    try { const info = await c.media.prepare(snapshot(s), { signal: activeAbort.signal, onProgress: progress }); if (failure) throw failure; return info; }
    finally { clearTimeout(timer); activeAbort = null; }
  }
  function noTransient() { assert(!fs.readdirSync(path.join(scratch, 'cache')).some(n => /^(?:partial-|writer\.lock|recovery\.lock|lease-)/.test(n))); }
  async function read(c, info) { const group = info.frames.slice(0, 3); const buffers = info.framePack ? await c.cache.readFrameBatch(info, group.map(f => f.file)) : await Promise.all(group.map(f => c.cache.readAsset(info, f.file)));
    group.forEach((f, i) => assert.equal(sha(buffers[i]), f.sha256)); }
  try {
    monitor = require('../tests/support/mvp-monitor.cjs').start({ ramBytes: 1024 ** 3, now: () => performance.now(), snapshot: () => ({ state: 'packed-runtime', cases: result.cases.length }), onStop: stop });
    if (!resume) {
    let c = client(), info = await prepare(c, sources[0]); assert(info.framePack && !info.metrics.reused); await read(c, info);
    result.cases.push({ name: 'real-owned-worker-packed-first-generation-and-local-batch', frames: info.frames.length, mediaMs: info.metrics.preparationMs });
    await c.cache.release(info); await c.close(); noTransient();
    c = client(); info = await prepare(c, sources[0]); assert(info.framePack && info.metrics.reused); await read(c, info);
    result.cases.push({ name: 'complete-close-new-worker-reopen-preserves-and-reuses-pack', reused: true });
    for (const stage of ['decode', 'verify']) {
      let cancelled = false;
      await assert.rejects(prepare(c, sources[1], p => { if (p.stage === stage) { cancelled = true; activeAbort.abort(); } }), e => e.code === 'MEDIA_CANCELLED');
      assert(cancelled); result.cases.push({ name: 'packed-' + stage + '-cancel-settles-before-next-task' });
      const inventory = caches.inventory(); assert.equal(inventory.leases.length, 1); assert.equal(inventory.caches.length, 1);
    }
    for (const s of sources.slice(1)) { const added = await prepare(c, s); assert(added.framePack && !added.metrics.reused); await read(c, added); await c.cache.release(added);
      result.cases.push({ name: 'existing-short-codec-packed-generation', key: s.key, codec: added.source.codec, frames: added.frames.length, audioStart: added.audio && added.audio.start }); }
    const cleared = await c.cache.clearOther({ sourceSha256: source.sha256 }); assert.equal(cleared.cleared, 3);
    await c.cache.release(info); await c.close(); noTransient();
    c = client(); info = await prepare(c, sources[0]); assert(info.metrics.reused); await read(c, info); await c.cache.release(info); await c.close(); noTransient();
    result.cases.push({ name: 'clear-other-completes-close-and-reopen-retains-current-pack', cleared: 3 });
    // A legacy cache is generated ONLY here, inside this fresh owned root.
    const legacy = createMedia({ tools, cache: caches }); activeAbort = new AbortController();
    const legacyInfo = await legacy.prepare(snapshot(sources[1]), { signal: activeAbort.signal }); activeAbort = null;
    assert(!legacyInfo.framePack); caches.release(legacyInfo);
    c = client(); const old = await prepare(c, sources[1]); assert(old.metrics.reused && !old.framePack); await read(c, old); await c.cache.release(old); await c.close(); noTransient();
    result.cases.push({ name: 'current-guard-reuses-legacy-layout-without-conversion' });
    // Make this OWN Sonic cache absent for one interrupted-write recovery case.
    // Normal product caches and old evidence are never opened by this script.
    c = client(); const clearedOwn = await c.cache.clearOther({ sourceSha256: sources[1].sha256 }); assert.equal(clearedOwn.cleared, 1);
    const ping = await c.ping(), identity = rootIdentity(ping.pid); assert.equal(identity.image.toLowerCase(), runtime.toLowerCase()); assert.notEqual(identity.pid, process.pid);
    let killed = false;
    await assert.rejects(prepare(c, sources[0], p => {
      if (!killed && p.stage === 'decode') { const current = rootIdentity(ping.pid); assert.deepStrictEqual(current, identity); killed = true; result.interruptedOwnedWorker = identity; process.kill(identity.pid); }
    }), e => e.code === 'TASK_OWNER_EXITED'); assert(killed); await c.close().catch(() => {});
    c = client(); info = await prepare(c, sources[0]); assert(info.framePack && !info.metrics.reused); await read(c, info); await c.cache.release(info); await c.close(); noTransient();
    result.cases.push({ name: 'owned-worker-interruption-recovers-packed-partial-without-blocking-next-owner', killedOwnedIdentity: identity });
    } else {
      const legacyLeaves = priorSnapshot.leaves.filter(f => f.file.includes(path.sep + 'media-' + sources[1].sha256 + '-'));
      let c = client(), info = await prepare(c, sources[0]); assert(info.framePack && !info.metrics.reused); await read(c, info);
      await c.cache.release(info); await c.close(); noTransient();
      for (const f of legacyLeaves) assert.equal(await fileHash(f.file), f.sha256);
      result.cases.push({ name: 'actual-retained-packed-partial-recovered-by-next-owned-guard', retainedLegacyFilesUnchanged: legacyLeaves.length });
      c = client(); info = await prepare(c, sources[2]); assert(info.framePack && !info.metrics.reused); await read(c, info); await c.cache.release(info);
      const pack = path.join(info.cacheDir, info.framePack.file), original = stat(pack), fd = fs.openSync(pack, 'r+'), byte = Buffer.alloc(1);
      try { assert.deepStrictEqual(stat(pack), original); fs.readSync(fd, byte, 0, 1, 0); byte[0] ^= 1; fs.writeSync(fd, byte, 0, 1, 0); } finally { fs.closeSync(fd); }
      info = await prepare(c, sources[2]); assert(info.framePack && !info.metrics.reused); await read(c, info); await c.cache.release(info); await c.close(); noTransient();
      result.cases.push({ name: 'same-size-packed-corruption-is-detected-and-regenerated-before-reuse' });
      c = client(); info = await prepare(c, sources[0]); assert(info.metrics.reused); await read(c, info); await c.cache.release(info); await c.close(); noTransient();
      result.cases.push({ name: 'recovered-complete-pack-closes-and-reopens-normally' });
    }
    const inventory = caches.inventory(); assert.equal(inventory.leases.length, 0); assert.equal(inventory.caches.length, resume ? 3 : 2);
    const leaves = [], dirs = [];
    function walk(dir) { assert(dir === scratch || dir.startsWith(scratch + path.sep)); assert.equal(fs.realpathSync(dir), dir);
      const s = fs.lstatSync(dir, { bigint: true }); assert(s.isDirectory() && !s.isSymbolicLink()); dirs.push({ dir, ino: String(s.ino), dev: String(s.dev) });
      for (const name of fs.readdirSync(dir)) { const f = path.join(dir, name); if (fs.lstatSync(f).isDirectory()) walk(f); else leaves.push({ file: f, ...stat(f), sha256: sha(fs.readFileSync(f)) }); } }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(scratch, 'diagnostic-owner.json'))), owner); walk(scratch);
    result.scratchBytes = leaves.reduce((n, f) => n + f.bytes, 0); assert(result.scratchBytes < result.limits.scratchBytes);
    cleanup = { leaves, dirs }; if (failure) throw failure; result.passed = true;
  } catch (e) { result.error = String(e.stack || e); }
  finally {
    for (const c of allClients) if (!c.stopped) { try { await c.close(); } catch (e) { result.passed = false; result.closeError = e.message; } }
    if (monitor) { const resources = await monitor.stop(); result.observer = resources.observer; result.observerIssue = resources.issue; result.resourceChunks = [];
      for (let n = 0; n < resources.rows.length; n += 200) result.resourceChunks.push(store.save('lifecycle', { schema: 'mvp-packed-runtime-resource-chunk-v1', rows: resources.rows.slice(n, n + 200) }));
      if (resources.issue) result.passed = false;
    }
    result.originalsUnchanged = true;
    for (const s of originals) if (JSON.stringify(stat(s.file)) !== JSON.stringify({ ino: s.ino, dev: s.dev, bytes: s.bytes, modified: s.modified }) || await fileHash(s.file) !== s.sha256) result.originalsUnchanged = false;
    if (!result.originalsUnchanged) result.passed = false;
    if (result.passed && cleanup) {
      result.cleanupPlan = store.save('audit', { schema: 'mvp-packed-runtime-cleanup-v1', owner, ...cleanup });
      for (const f of cleanup.leaves) { assert.deepStrictEqual(stat(f.file), { ino: f.ino, dev: f.dev, bytes: f.bytes, modified: f.modified }); assert.equal(await fileHash(f.file), f.sha256); }
      for (const d of cleanup.dirs) { const s = fs.lstatSync(d.dir, { bigint: true }); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(String(s.ino), d.ino); assert.equal(String(s.dev), d.dev); }
      for (const f of cleanup.leaves) fs.unlinkSync(f.file); for (const d of cleanup.dirs.reverse()) fs.rmdirSync(d.dir); result.scratchRemoved = !fs.existsSync(scratch);
    } else result.scratchRetained = fs.existsSync(scratch);
    result.limitations = ['Real own guard/Node16/media/cache and copied runtime with test-only 240MiB disk budget; not real Eagle GUI or P-03 acceptance.',
      'No physical canvas/audio or manual experience, no drag loop, no long-run resource claim.'];
    const receipt = store.save('audit', result); store.close(); console.log(JSON.stringify({ receipt, ...result }));
  }
  if (!result.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
