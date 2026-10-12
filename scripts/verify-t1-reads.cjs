'use strict';
// Explicit bounded, local-only diagnosis for the user-named UE clip. This is
// not a default check. It leases an existing cache; it never generates media,
// resets caches, removes another lease or writes the source/Eagle library.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { monitorEventLoopDelay } = require('perf_hooks');
const { createCache, OWNER, RECIPE } = require('../plugin/cache.cjs');
const { createStore } = require('../tests/support/t1-evidence.cjs');
const repo = path.resolve(__dirname, '..'), pluginRoot = path.join(repo, 'plugin'), cacheRoot = path.join(pluginRoot, 'cache');
const input = Object.freeze({ sha256: 'aabf057017744c38737f65c4e7a983a1f8d9e5258c178bcc3e723dcdb56ccc53',
  filePath: process.env.EVA_T1_DIAGNOSTIC_SOURCE,
  itemId: 'MV3FZ0Z86KYBH', name: 'UE特效练习 [BV1dKpe61EGD]' });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const now = () => process.hrtime.bigint(), milliseconds = start => Number(now() - start) / 1e6;
function regular(file) {
  const stat = fs.lstatSync(file), actual = fs.realpathSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Expected a single-link regular file.');
  assert.strictEqual(actual.toLowerCase(), path.resolve(file).toLowerCase(), 'Noncanonical file refused.'); return stat;
}
function directory(dir) {
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected a nonlinked directory.');
  assert.strictEqual(fs.realpathSync(dir).toLowerCase(), path.resolve(dir).toLowerCase(), 'Noncanonical directory refused.');
}
function stamp(stat) { return { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs }; }
function json(file) {
  const before = regular(file); assert(before.size <= 8 * 1024 ** 2, 'Metadata exceeds 8MiB.');
  const data = fs.readFileSync(file); assert.deepStrictEqual(stamp(regular(file)), stamp(before));
  assert.strictEqual(data.length, before.size); return { value: JSON.parse(data.toString('utf8')), sha256: sha(data) };
}
async function sourceHash(signal, check) {
  const before = regular(input.filePath), digest = crypto.createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(input.filePath, { highWaterMark: 1024 ** 2 })) {
    check(); if (signal.aborted) throw new Error('Read diagnosis cancelled.'); digest.update(chunk); bytes += chunk.length;
  }
  assert.deepStrictEqual(stamp(regular(input.filePath)), stamp(before)); assert.strictEqual(bytes, before.size);
  return { sha256: digest.digest('hex'), ...stamp(before) };
}
function snapshot(check) {
  directory(cacheRoot); const names = fs.readdirSync(cacheRoot).sort(), rootOwner = json(path.join(cacheRoot, 'owner.json'));
  assert.strictEqual(rootOwner.value.owner, OWNER); assert.strictEqual(rootOwner.value.recipe, RECIPE);
  assert.strictEqual(rootOwner.value.root, cacheRoot); assert.strictEqual(rootOwner.value.kind, 'root');
  const complete = [];
  for (const name of names.filter(value => value.startsWith('media-'))) {
    check(); assert(/^media-[0-9a-f]{64}-[0-9a-f]{12}$/.test(name));
    const dir = path.join(cacheRoot, name); directory(dir);
    const owner = json(path.join(dir, 'owner.json')), manifest = json(path.join(dir, 'manifest.json'));
    assert.strictEqual(owner.value.owner, OWNER); assert.strictEqual(owner.value.recipe, RECIPE); assert.strictEqual(owner.value.root, cacheRoot);
    assert.strictEqual(owner.value.kind, 'cache'); assert.strictEqual(manifest.value.owner, OWNER); assert.strictEqual(manifest.value.recipe, RECIPE);
    const files = fs.readdirSync(dir).sort(), digest = crypto.createHash('sha256'); let bytes = 0;
    for (const file of files) { check(); const stat = regular(path.join(dir, file));
      digest.update(JSON.stringify([file, stat.ino, stat.dev, stat.size, stat.mtimeMs]) + '\n'); bytes += stat.size; }
    complete.push({ name, files: files.length, bytes, statsSha256: digest.digest('hex'), ownerSha256: owner.sha256, manifestSha256: manifest.sha256 });
  }
  return { entries: names, transient: names.filter(name => /^(?:writer\.lock|partial-|lease-)/.test(name)), rootOwnerSha256: rootOwner.sha256, complete };
}
function distribution(values) {
  if (!values.length) return null; const sorted = values.slice().sort((a, b) => a - b);
  return { count: values.length, meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted[sorted.length - 1], minMs: sorted[0] };
}
function selectFrames(frames, start, end, seed) {
  const candidates = frames.map((frame, ordinal) => ({ frame, ordinal })).filter(item => item.frame.time >= start && item.frame.time < end);
  assert(candidates.length >= 30, 'Segment has fewer than 30 source frames.'); let random = seed >>> 0;
  for (let index = candidates.length - 1; index > 0; index--) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    const other = (random >>> 0) % (index + 1), item = candidates[index]; candidates[index] = candidates[other]; candidates[other] = item;
  }
  return candidates.slice(0, 30);
}
async function main() {
  assert(typeof input.filePath === 'string' && path.isAbsolute(input.filePath),
    'Set EVA_T1_DIAGNOSTIC_SOURCE to the user-named clip; no library search or fallback is performed.');
  const store = createStore(repo), cache = createCache({ pluginRoot }), controller = new AbortController(), started = now();
  const check = () => { if (milliseconds(started) > 30000 || controller.signal.aborted) { controller.abort(); throw new Error('Read diagnosis exceeded its 30s work deadline; not passed.'); } };
  const report = { schema: 1, task: 'T1-user-clip-reads', executor: 'Codex', origin: 'local-node-real-formal-cache-not-Eagle',
    startedAt: new Date().toISOString(), node: process.versions.node, platform: process.platform, input, segments: [],
    sourceFiles: ['plugin/cache.cjs', 'plugin/player.js', 'scripts/verify-t1-reads.cjs'].map(file => ({ file, sha256: sha(fs.readFileSync(path.join(repo, file))) })),
    limitations: [
      'Local Node readAsset wall time only: all ownership/path/content guards, file read, SHA256 and handle close are included. No JPEG decoding, canvas, real Eagle UI or physical display measurement.',
      'readComplete hashes all target assets before timing, so these are OS-cache-conditioned reads, not a cold-disk protocol. Segment order rotates across three rounds.',
      'Event-loop delay is a separate 1ms-resolution local Node sampling histogram; it is not input-to-display latency and can miss short stalls. RSS is this Node process only.',
      'Preserved complete caches are compared by leaf names/stats and owner/manifest hashes, not all retained asset contents. The target cache is fully hashed by actual readComplete.',
      'The 30s work deadline is cooperative; cleanup is awaited even after timeout and is never abandoned to enforce a hard process kill.' ] };
  let tx = null, info = null, failure = null, timer = null, peakRss = process.memoryUsage().rss;
  const delay = monitorEventLoopDelay({ resolution: 1 });
  store.start({ reserveBytes: 256 * 1024 });
  try {
    report.before = snapshot(check); assert(!report.before.transient.includes('writer.lock'), 'Existing writer is retained; diagnosis refused.');
    report.sourceBefore = await sourceHash(controller.signal, check); assert.strictEqual(report.sourceBefore.sha256, input.sha256);
    check(); tx = cache.begin({ sourceSha256: input.sha256, signal: controller.signal });
    const reused = await tx.readComplete(); assert(reused, 'Required complete cache is absent; nothing is generated.'); check();
    info = await tx.finish(reused, { ...reused.source, ...input }); tx.close(); tx = null;
    report.duration = info.duration; report.frameCount = info.frames.length; report.frameBytes = info.frames.reduce((sum, frame) => sum + frame.bytes, 0);
    let prefixBytes = 0, prefixCount = 0;
    for (const frame of info.frames) { if (prefixBytes + frame.bytes > 64 * 1024 ** 2) break; prefixBytes += frame.bytes; prefixCount++; }
    report.prefix64MiB = { frames: prefixCount, bytes: prefixBytes, endTime: prefixCount ? info.frames[prefixCount - 1].end : null };
    delay.enable(); delay.reset(); timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
    const ranges = [[2, 6], [10, 14], [14, 18]];
    for (let round = 0; round < 3; round++) {
      for (let position = 0; position < ranges.length; position++) {
        check(); const range = ranges[(position + round) % ranges.length], seed = (0x4e564158 + round * 65537 + range[0] * 257) >>> 0;
        const result = { round: round + 1, start: range[0], end: range[1], seed, samples: [] }; report.segments.push(result);
        for (const { frame, ordinal } of selectFrames(info.frames, range[0], range[1], seed)) {
          check(); const readStart = now(), bytes = await cache.readAsset(info, frame.file), readMs = milliseconds(readStart);
          assert.strictEqual(bytes.length, frame.bytes); result.samples.push({ ordinal, time: frame.time, bytes: frame.bytes, readMs, outsideInitialPrefix: ordinal >= prefixCount });
        }
        result.readAsset = distribution(result.samples.map(value => value.readMs)); await new Promise(resolve => setImmediate(resolve));
      }
    }
    clearInterval(timer); timer = null; delay.disable(); peakRss = Math.max(peakRss, process.memoryUsage().rss);
    report.eventLoopDelay = { resolutionMs: 1, meanMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : null,
      p95Ms: delay.percentile(95) / 1e6, maxMs: delay.max / 1e6 }; report.localNodePeakRss = peakRss;
    report.summary = ranges.map(range => ({ start: range[0], end: range[1], readAsset: distribution(report.segments
      .filter(segment => segment.start === range[0]).flatMap(segment => segment.samples.map(sample => sample.readMs))) }));
    report.passed = true;
  } catch (error) { failure = error; report.passed = false; report.error = { name: error.name, message: error.message }; }
  finally {
    if (timer) clearInterval(timer); delay.disable();
    const cleanupErrors = [];
    try { if (info) report.ownLeaseReleased = cache.release(info); } catch (error) { cleanupErrors.push(error.message); }
    try { if (tx) { tx.abort(); tx.close(); } } catch (error) { cleanupErrors.push(error.message); }
    // Preservation checks still run after a work deadline. They never delete an
    // unknown file, lease, writer or pre-existing complete cache.
    try { report.after = snapshot(() => {}); if (report.before) assert.deepStrictEqual(report.after, report.before); }
    catch (error) { cleanupErrors.push('Cache preservation: ' + error.message); }
    try { report.sourceAfter = await sourceHash({ aborted: false }, () => {}); if (report.sourceBefore) assert.deepStrictEqual(report.sourceAfter, report.sourceBefore); }
    catch (error) { cleanupErrors.push('Source preservation: ' + error.message); }
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.passed = false; failure = failure || new Error(cleanupErrors.join('; ')); }
    report.finishedAt = new Date().toISOString(); report.totalMs = milliseconds(started);
    try { console.log('Evidence: ' + JSON.stringify(store.save('media', report))); } finally { store.close(); }
  }
  console.log(JSON.stringify({ passed: report.passed, totalMs: report.totalMs, frameCount: report.frameCount,
    prefix64MiB: report.prefix64MiB, summary: report.summary, eventLoopDelay: report.eventLoopDelay }));
  if (failure) throw failure;
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { _test: { distribution, selectFrames } };
