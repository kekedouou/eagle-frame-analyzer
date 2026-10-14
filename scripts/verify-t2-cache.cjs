'use strict';
// Explicit, bounded side effects. Not invoked by the default check command.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { createCache } = require('../plugin/cache.cjs');
const { createStore } = require('../tests/support/t2-evidence.cjs');
const { publish, reuse, demand, hash } = require('../tests/t2-lifecycle.cjs');
const repo = path.resolve(__dirname, '..'), scratch = path.join(repo, 'tests/host/t2/cache-scratch');
const OWNER = 'eva-t2-isolated-filesystem-v1', LIMIT = 2 * 1024 ** 2;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const assert = require('assert');
function directory(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('Scratch path must be canonical and without links.');
  return stat;
}
function files(dir, depth = 0, output = []) {
  directory(dir); if (depth > 4) throw new Error('Scratch depth exceeds ownership boundary.');
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) files(file, depth + 1, output);
    else {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file).toLowerCase() !== file.toLowerCase() || stat.size > 512 * 1024)
        throw new Error('Unknown scratch leaf identity or size; retained.');
      const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
      if (bytes.length !== stat.size || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs) throw new Error('Scratch changed while reading.');
      output.push({ relative: path.relative(scratch, file), dev: stat.dev, ino: stat.ino, bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: sha(bytes) });
    }
  }
  if (output.reduce((n, item) => n + item.bytes, 0) > LIMIT) throw new Error('Scratch exceeds 2MiB; stop without broad cleanup.');
  return output;
}
function codeHashes() {
  return Object.fromEntries(['plugin/cache.cjs', 'plugin/process-identity.cjs', 'plugin/media.cjs', 'plugin/player.js', 'plugin/session.cjs', 'plugin/ui.js', 'tests/support/t2-evidence.cjs',
    'scripts/verify-t2-cache.cjs'].map(file => [file, sha(fs.readFileSync(path.join(repo, file)))]));
}
function worker(root, keepChild) {
  const parent = path.dirname(root);
  if (!(parent === scratch || path.dirname(parent) === scratch && /^attempt-[0-9a-f]{24}$/.test(path.basename(parent))) ||
    !/^case-[0-9a-f]{24}$/.test(path.basename(root))) throw new Error('Invalid owned worker root.');
  directory(root); const marker = JSON.parse(fs.readFileSync(path.join(root, 'owner.json')));
  if (marker.owner !== OWNER || marker.root !== scratch || marker.case !== path.basename(root)) throw new Error('Unknown worker owner.');
  return (async () => {
    const cache = createCache({ pluginRoot: root, diskBytes: 512 * 1024 }), tx = cache.begin({ sourceSha256: hash(2) });
    await tx.writeAsset('000000.jpg', Buffer.from('owned incomplete output'));
    let childPid = null;
    if (keepChild) {
      const token = tx.beforeSpawn(), child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),15000)'], { windowsHide: true, shell: false, detached: true, stdio: 'ignore' });
      childPid = child.pid; tx.childStarted(token, childPid); child.unref();
    }
    process.stdout.write(JSON.stringify({ root, childPid, writer: JSON.parse(fs.readFileSync(path.join(cache.root, 'writer.lock'))) }) + '\n');
    // Intentional exit of this owned test process, not Eagle or a real media
    // tool. OS closes its ledger handle; no cleanup callback is run.
    process.exit(0);
  })();
}
async function runWorker(root, keepChild) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, keepChild ? 'worker-child' : 'worker', root], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; const timeout = setTimeout(() => reject(new Error('Owned worker exceeded 20 seconds; no external process terminated.')), 20000);
    child.stdout.on('data', b => { out += b; if (out.length > 32768) reject(new Error('Worker output limit exceeded.')); });
    child.stderr.on('data', b => { err = (err + b).slice(-8192); }); child.once('error', reject);
    child.once('close', code => { clearTimeout(timeout); if (code !== 0) reject(new Error('Owned worker failed: ' + err)); else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } } });
  });
}
async function filesystem() {
  const store = createStore(repo), results = [], sourceHashes = codeHashes(); store.start({ reserveBytes: 512 * 1024 });
  let owned = false;
  try {
    directory(repo); const host = path.join(repo, 'tests/host/t2');
    if (!fs.existsSync(host)) fs.mkdirSync(host); directory(host);
    if (fs.existsSync(scratch)) {
      if (!process.argv.includes('--retry-retained')) throw new Error('Previous scratch exists; retain it for review rather than deleting.');
      directory(scratch); const old = JSON.parse(fs.readFileSync(path.join(scratch, 'owner.json')));
      if (old.schema !== 1 || old.owner !== OWNER || old.root !== scratch || old.quota !== LIMIT) throw new Error('Unknown retained scratch owner.');
      files(scratch); // Existing failures remain inside the same 2MiB budget.
    } else {
      fs.mkdirSync(scratch);
      fs.writeFileSync(path.join(scratch, 'owner.json'), JSON.stringify({ schema: 1, owner: OWNER, root: scratch, quota: LIMIT }), { flag: 'wx' });
    }
    const attempt = path.join(scratch, 'attempt-' + crypto.randomBytes(12).toString('hex')); fs.mkdirSync(attempt); owned = true;
    fs.writeFileSync(path.join(attempt, 'owner.json'), JSON.stringify({ schema: 1, owner: OWNER, root: scratch, attempt: path.basename(attempt) }), { flag: 'wx' });
    const cases = [];
    function newCase() {
      const name = 'case-' + crypto.randomBytes(12).toString('hex'), root = path.join(attempt, name); fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ schema: 1, owner: OWNER, root: scratch, case: name }), { flag: 'wx' });
      cases.push(root); return root;
    }
    const capacityRoot = newCase(), h = { cache: createCache({ pluginRoot: capacityRoot, diskBytes: 128 * 1024 }) }, list = [];
    for (const n of [1, 2, 3]) { const item = await publish(h, n); h.cache.release(item); list.push(item); }
    const held = await reuse(h, 1); await demand(h);
    assert(fs.existsSync(list[0].cacheDir)); assert(!fs.existsSync(list[1].cacheDir)); assert(fs.existsSync(list[2].cacheDir)); h.cache.release(held);
    results.push({ test: 'real-Windows-LRU-and-live-lease', passed: true, inventory: h.cache.inventory() }); files(scratch);
    for (const keepChild of [false, true]) {
      const root = newCase(), child = await runWorker(root, keepChild), cache = createCache({ pluginRoot: root, diskBytes: 512 * 1024 });
      const result = { test: keepChild ? 'real-parent-gone-child-alive-then-natural-exit' : 'real-parent-exit-owned-partial-recovery',
        passed: false, child }; results.push(result);
      if (keepChild) {
        const identity = require('../plugin/process-identity.cjs').createIdentity();
        result.beforeRecovery = identity.inspect(child.writer);
        assert.strictEqual(result.beforeRecovery.safe, false, 'Owned test child must be verified alive before exercising recovery.');
        assert.throws(() => cache.begin({ sourceSha256: hash(2) }), error => error.code === 'CACHE_BUSY');
        // Owned helper naturally exits after 15 seconds. No kill command,
        // arbitrary PID termination or manipulation of Eagle is performed.
        await new Promise(resolve => setTimeout(resolve, 15500));
      }
      const tx = cache.begin({ sourceSha256: hash(2) }); assert.strictEqual(await tx.readComplete(), null); tx.close();
      assert(!fs.readdirSync(cache.root).some(name => /^partial-/.test(name)));
      result.passed = true; result.inventory = cache.inventory(); files(scratch);
    }
    // Only exact, newly created case paths are eligible for final cleanup.
    assert.deepStrictEqual(fs.readdirSync(attempt).sort(), ['owner.json', ...cases.map(dir => path.basename(dir))].sort());
    const manifest = files(attempt), plan = store.save('cleanup', { protocol: 't2-isolated-filesystem-v1', at: new Date().toISOString(), sourceHashes,
      scratch, attempt, budgetBytes: LIMIT, cases, files: manifest, results, phase: 'before-scratch-cleanup' });
    assert.deepStrictEqual(files(attempt), manifest);
    for (const item of manifest.filter(item => path.basename(item.relative) !== 'owner.json').concat(manifest.filter(item => path.basename(item.relative) === 'owner.json'))) {
      const file = path.resolve(scratch, item.relative);
      if (!file.startsWith(scratch + path.sep)) throw new Error('Scratch cleanup target escapes its root.');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.ino !== item.ino || stat.dev !== item.dev || stat.size !== item.bytes || sha(fs.readFileSync(file)) !== item.sha256)
        throw new Error('Scratch cleanup target changed; retained.');
      fs.unlinkSync(file);
    }
    function removeEmpty(dir) {
      directory(dir);
      for (const name of fs.readdirSync(dir)) { const target = path.join(dir, name); if (!fs.lstatSync(target).isDirectory()) throw new Error('Unknown cleanup residue.'); removeEmpty(target); }
      fs.rmdirSync(dir);
    }
    removeEmpty(attempt); owned = false;
    const saved = store.save('cache', { protocol: 't2-isolated-filesystem-v1', at: new Date().toISOString(), sourceHashes, passed: true,
      results, cleanupPlan: plan, cleanedFiles: manifest.length, cleanedBytes: manifest.reduce((n, f) => n + f.bytes, 0), attemptRemoved: true,
      retainedScratchBytes: files(scratch).reduce((n, f) => n + f.bytes, 0),
      limitation: 'Real filesystem/process identity only; generated byte assets are not JPEG decoding, Eagle interaction, performance or long-run acceptance.' });
    console.log(JSON.stringify(saved));
  } catch (error) {
    console.log(JSON.stringify(store.save('cache', { protocol: 't2-isolated-filesystem-v1', at: new Date().toISOString(), sourceHashes,
      passed: false, results, scratchRetained: owned, error: String(error.stack).slice(0, 8192) })));
    throw error;
  } finally { store.close(); }
}
function checks() {
  const store = createStore(repo); store.start({ reserveBytes: 256 * 1024 });
  try {
    const output = spawnSync(process.execPath, [path.join(repo, 'scripts/check.cjs')], { cwd: repo, windowsHide: true, encoding: 'utf8', maxBuffer: 192 * 1024, timeout: 120000 });
    const saved = store.save('checks', { protocol: 't2-default-check-v1', at: new Date().toISOString(), sourceHashes: codeHashes(),
      passed: !output.error && output.status === 0, status: output.status, error: output.error?.message || null, stdout: output.stdout, stderr: output.stderr });
    console.log(JSON.stringify(saved)); if (output.error || output.status !== 0) throw new Error(output.stderr || output.error?.message || 'Default checks failed.');
  } finally { store.close(); }
}
async function reuseIntegration() {
  const store = createStore(repo); store.start({ reserveBytes: 128 * 1024 });
  let handle, cache;
  const sourceHashes = codeHashes();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json'))), input = config.sources.find(item => item.key === 'h264-cfr');
    if (!input || input.sha256 !== '2275abc6a31d82870e53510019edbc16b6b8cd10b8f0d9b75f3b02abb9a1f79e') throw new Error('Known H264 fixture registration changed; no generation attempted.');
    const fingerprint = () => {
      const stat = fs.lstatSync(input.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 ** 2 || fs.realpathSync(input.file).toLowerCase() !== input.file.toLowerCase()) throw new Error('Fixture identity or bound changed.');
      const bytes = fs.readFileSync(input.file), after = fs.lstatSync(input.file);
      if (stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || bytes.length !== stat.size || sha(bytes) !== input.sha256) throw new Error('Fixture SHA mismatch.');
      return { bytes: bytes.length, sha256: sha(bytes), ino: stat.ino, mtimeMs: stat.mtimeMs };
    };
    const before = fingerprint(); cache = createCache({ pluginRoot: path.join(repo, 'plugin') });
    const initial = cache.inventory(); if (!initial.caches.some(item => item.sourceSha256 === input.sha256)) throw new Error('Existing complete fixture cache missing; no generation permitted.');
    const guarded = { ...cache, begin(options) {
      const tx = cache.begin(options);
      return { ...tx, async readComplete() { const value = await tx.readComplete(); if (!value) throw new Error('Reuse-only validation cache miss; generation prohibited.'); return value; } };
    } };
    const media = require('../plugin/media.cjs').createMedia({ tools: { ffmpeg: config.ffmpeg, ffprobe: config.ffprobe }, cache: guarded });
    const at = process.hrtime.bigint(); handle = await media.prepare({ id: 't2-known-h264-fixture', filePath: input.file, name: 'T2既有H264合成输入', ext: 'mp4' });
    assert.strictEqual(handle.metrics.reused, true); let bytes = 0, assets = 0;
    for (const item of [...handle.frames, ...(handle.audio ? [handle.audio] : [])]) {
      const read = await cache.readAsset(handle, item.file); assert.strictEqual(sha(read), item.sha256); bytes += read.length; assets++;
    }
    cache.release(handle); handle = null; assert.deepStrictEqual(fingerprint(), before);
    const final = cache.inventory(); assert.strictEqual(initial.caches.length, final.caches.length); assert.strictEqual(final.leases.length, initial.leases.length);
    const saved = store.save('cache', { protocol: 't2-local-reuse-integration-v1', at: new Date().toISOString(), sourceHashes,
      passed: true, source: before, fixtureKey: input.key, assets, assetBytes: bytes, totalMs: Number(process.hrtime.bigint() - at) / 1e6,
      cacheCountBefore: initial.caches.length, cacheCountAfter: final.caches.length, noGeneration: true, recencyMetadataUpdated: true,
      limitation: 'Local Node runtime, existing FFprobe and real cache; not Eagle window/Canvas/audio/performance acceptance.' });
    console.log(JSON.stringify(saved));
  } catch (error) {
    console.log(JSON.stringify(store.save('cache', { protocol: 't2-local-reuse-integration-v1', at: new Date().toISOString(), sourceHashes,
      passed: false, error: String(error.stack).slice(0, 8192) }))); throw error;
  } finally { try { if (handle) cache.release(handle); } finally { store.close(); } }
}
function unwrapHost(outer) {
  const canonical = require('../tests/support/t2-evidence.cjs')._test.canonical;
  if (outer.schema !== 't2-evidence-v1' || outer.kind !== 'host' || outer.key !== sha(Buffer.from(canonical(outer.payload))) || outer.payload.stage !== 'T2') throw new Error('T2 host envelope mismatch.');
  return outer.payload;
}
function recordedFrames(summary, records) {
  if (!/^[0-9a-f]{64}$/.test(summary.manifestSha256 || '') || !Number.isSafeInteger(summary.manifestBytes) || summary.manifestBytes<1 || summary.manifestBytes>8*1024**2)
    throw new Error('Invalid saved manifest digest/length.');
  const traces = records.filter(r=>r.value.type==='round').map(r=>r.value.trace).concat(summary.interruptedTrace || []).filter(Boolean);
  const ids = traces[0] && traces[0].frameIds;
  if (!Array.isArray(ids) || ids.length !== summary.frames || ids.some(n=>!Number.isSafeInteger(n)) || new Set(ids).size !== ids.length ||
    traces.some(t=>JSON.stringify(t.frameIds)!==JSON.stringify(ids))) throw new Error('No consistent complete recorded frame IDs; saved-only audit refused.');
  return {info:{frames:ids.map(id=>({id}))},manifestSha256:summary.manifestSha256,manifestBytes:summary.manifestBytes,liveVerified:false};
}
module.exports = { _test: { unwrapHost, recordedFrames } };
async function auditHost(runId, allowRecordedFrames = false) {
  if (typeof runId !== 'string' || !/^t[12]-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{20}$/.test(runId)) throw new Error('An explicit T1/T2 host run ID is required.');
  const dir = path.join(repo, 'verification-runs', runId), gate = require('../tests/support/t0-gate.cjs');
  const { _test: { registeredManifest } } = require('../tests/support/window-host.cjs');
  const read = file => {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 2 * 1024 ** 2 ||
      fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('Host audit file boundary changed.');
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error('Host receipt changed during audit.');
    return { value: JSON.parse(bytes), bytes: bytes.length, sha256: sha(bytes) };
  };
  const owner = read(path.join(dir, 'owner.json')).value;
  if (owner.owner !== require(runId.startsWith('t2-') ? '../tests/support/t2-evidence.cjs' : '../tests/support/t1-evidence.cjs').OWNER || owner.runId !== runId || owner.root !== path.join(repo, 'verification-runs')) throw new Error('Host receipt owner mismatch.');
  const files = fs.readdirSync(dir).filter(n => /^host-[0-9a-f]{20}-\d+\.json$/.test(n));
  const records = files.map(n => ({ file: path.join(dir, n), ...read(path.join(dir, n)) }));
  if (runId.startsWith('t2-')) for (const record of records) {
    record.value = unwrapHost(record.value);
  }
  const summaries = records.filter(r => r.value.type === 'summary'); if (summaries.length !== 1) throw new Error('Exactly one final host summary required.');
  const saved = summaries[0], summary = saved.value;
  const formalFiles = ['manifest.json', 'app.js', 'ui.js', 'styles.css', 'index.html', 'diagnostics.cjs', 'session.cjs', 'eagle.cjs', 'media.cjs', 'cache.cjs', 'process-identity.cjs', 'player.js', 'frame-index.cjs'];
  const recordedFiles = JSON.stringify(Object.keys(summary.sourceFingerprints || {}).sort());
  if (![formalFiles, [...formalFiles, 'preferences.cjs']].some(names => recordedFiles === JSON.stringify(names.sort())) ||
    Object.values(summary.sourceFingerprints).some(value => !/^[0-9a-f]{64}$/.test(value))) throw new Error('Measured formal source list is invalid.');
  if (summary.schema !== (runId.startsWith('t2-') ? 'window-formal-dom-regression-v1' : 't1-formal-dom-regression-v1') || !summary.sourceFingerprintsUnchanged || !summary.launchSourcesVerifiedAtEnd ||
    JSON.stringify(summary.initialSourceFingerprints) !== JSON.stringify(summary.sourceFingerprints)) throw new Error('Measured source fingerprint consistency failed.');
  const ram = summary.launchContext && summary.launchContext.ramDiagnostic;
  const expectedStop = require('../tests/support/ram-diagnostic.cjs').hostRssLimit(ram);
  if (summary.resourceStop && summary.resourceStop.thresholdBytes !== expectedStop) throw new Error('Recorded renderer stop does not match the approved RAM configuration.');
  if (ram && ram.schema === 'T2-ram-host-v2' && (!summary.resourceStop || summary.initialSnapshot.playback.budget.limit !== 2*1024**3 ||
    summary.initialSnapshot.playback.compressed.limitBytes !== 256*1024**2)) throw new Error('Measured 2GiB/256MiB configuration mismatch.');
  let manifest;
  try { manifest = { ...registeredManifest(path.join(repo, 'plugin'), summary.initialSnapshot), liveVerified:true }; }
  catch(error) {
    const expected = path.join(repo,'plugin/cache','media-'+summary.source.sha256+'-'+sha(Buffer.from(require('../plugin/cache.cjs').RECIPE)).slice(0,12));
    if (!allowRecordedFrames || error.code!=='ENOENT' || fs.existsSync(expected)) throw error;
    manifest = recordedFrames(summary, records);
  }
  if (manifest.manifestSha256 !== summary.manifestSha256 || manifest.manifestBytes !== summary.manifestBytes) throw new Error('Measured manifest changed.');
  const protocol = require('../tests/support/t0-protocol.cjs'), rounds = [];
  for (const record of records.filter(r => r.value.type === 'round')) {
    const item = record.value, s = item.summary, trace = item.trace;
    if (!require('util').isDeepStrictEqual(item.protocol, protocol.PROTOCOL) || JSON.stringify(item.source) !== JSON.stringify(summary.source)) throw new Error('Measured protocol/source mismatch.');
    const reference = summary.receipts.find(r => r.file === record.file);
    if (!reference || reference.bytes !== record.bytes || reference.sha256 !== record.sha256) throw new Error('Summary receipt reference mismatch.');
    const events = gate.unpack(trace), capture = new gate.Capture(manifest.info.frames.map(f => f.id));
    for (const event of events) capture.append(event); capture.maxTasks = trace.maxImageTasks;
    const computed = capture.summarize(s.begin, s.end, { kind: s.kind, delayMs: s.delayMs });
    for (const key of Object.keys(computed)) if (!require('util').isDeepStrictEqual(computed[key], s[key])) throw new Error('Round recomputation mismatch: ' + key);
    if (s.final.expectedFrameId !== s.final.snapshot.playback.frameId || s.final.hint.text !== s.final.hint.expected || !s.final.correct) throw new Error('Final displayed frame/hint mismatch.');
    let releaseToDraw = null;
    if (s.kind === 'independent') {
      const releases = events.filter(e => e.type === 'input' && e.kind === 'release');
      const ids = new Set(releases.map(e => e.inputId));
      releaseToDraw = protocol.distribution(events.filter(e => e.type === 'draw' && ids.has(e.inputId)).map(e => e.at - e.inputAt));
      if (releases.length !== protocol.PROTOCOL.randomTargets || !require('util').isDeepStrictEqual(releaseToDraw, s.releaseToDraw))
        throw new Error('Random release count/statistics mismatch.');
    }
    const roundGateMet = s.valid && s.final.correct && (s.kind === 'rapid' ? computed.normalThresholdsMet :
      releaseToDraw && releaseToDraw.n > 0 && releaseToDraw.p95Ms <= protocol.PROTOCOL.p95Ms);
    if (!!roundGateMet !== s.roundGateMet) throw new Error('Round gate recomputation mismatch.');
    const draws = events.filter(e => e.type === 'draw' && e.at >= s.begin && e.at < s.end);
    const longGaps = draws.slice(1).map((to, i) => ({ from: draws[i], to, ms: to.at - draws[i].at }))
      .filter(gap => gap.ms > protocol.PROTOCOL.maxGapMs).slice(0, 8).map(gap => {
        const inside = events.filter(e => e.at > gap.from.at && e.at < gap.to.at);
        return { fromAt: gap.from.at, toAt: gap.to.at, ms: gap.ms,
          rafOpportunitiesBetweenDraws: gap.to.rafOpportunity - gap.from.rafOpportunity,
          inputs: inside.filter(e => e.type === 'input').length,
          ready: inside.filter(e => e.type === 'ready' && e.phase === 'read-and-image-decode-complete')
            .map(e => ({ at: e.at, frameId: e.frameId, assetSource: e.assetSource, readMs: e.readMs, decodeMs: e.decodeMs, stillTarget: e.stillTarget })) };
      });
    rounds.push({ file: record.file, sha256: record.sha256, round: s.round, kind: s.kind, valid: s.valid,
      roundGateMet: s.roundGateMet, submittedUpdatesPerSecond: s.submittedUpdatesPerSecond, longestNoSubmissionMs: s.longestNoSubmissionMs,
      requestToDraw: s.requestToDraw, releaseToDraw, longGaps, terminals: s.terminals, resources: s.resources, diskReads: s.diskReads, compressedReads: s.compressedReads });
  }
  if (summary.complete && (rounds.length !== 6 || summary.earlyRegressionPassed !== rounds.every(r => r.roundGateMet)))
    throw new Error('Complete host gate mismatch.');
  const interrupted = summary.interruptedTrace ? gate.unpack(summary.interruptedTrace) : null;
  const original = summary.source.filePath, before = fs.lstatSync(original);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 ** 3 || fs.realpathSync(original).toLowerCase() !== original.toLowerCase()) throw new Error('Selected source boundary changed.');
  const hash = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(original, { highWaterMark: 1024 ** 2 })) hash.update(bytes);
  const after = fs.lstatSync(original), sourceSha = hash.digest('hex');
  if (sourceSha !== summary.source.sha256 || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Selected source changed.');
  const currentSourceMatches = Object.fromEntries(Object.entries(summary.sourceFingerprints).map(([file, expected]) => [file, sha(fs.readFileSync(path.join(repo, 'plugin', file))) === expected]));
  const store = createStore(repo); store.start({ reserveBytes: 128 * 1024 });
  try {
    const result = store.save('audit', { protocol: 't2-saved-host-audit-v2', runId, receiptSha256: saved.sha256, source: summary.source,
      evidenceIntegrityPassed: true, complete: summary.complete, earlyRegressionPassed: summary.earlyRegressionPassed, error: summary.error || null,
      ramDiagnostic: ram || null, expectedRendererStopBytes: expectedStop,
      currentSourceMatches, sourceShaVerified: true, manifestSha256: manifest.manifestSha256, liveManifestVerified:manifest.liveVerified,
      manifestReferenceSource:manifest.liveVerified?'current-live-cache':'saved-digest-and-trace-frame-ids-only', allAssetHashesVerified: false,
      rounds, interruptedTraceEvents: interrupted ? interrupted.length : 0,
      interruptedDraws: interrupted ? interrupted.filter(e => e.type === 'draw').length : 0,
      interruptedInputs: interrupted ? interrupted.filter(e => e.type === 'input').length : 0,
      interruptedLastActivityAt: interrupted ? Math.max(...interrupted.filter(e => e.type !== 'memory').map(e => e.at)) : null,
      finalObservedPlayback: summary.finalSnapshot.playback, existingP03: summary.existingP03,
      limitation: 'Independent integrity/statistics audit only; task counts are saved observations, not proof of actual resource release. Long-gap context lists up to eight internal gaps and does not replace the full-window maximum. No physical monitor presentation or new host run.' +
        (manifest.liveVerified ? '' : ' Cache removed: only saved digest/frame IDs are referenced; current manifest, source PTS mapping and pixel accuracy are not independently verified.') });
    console.log(JSON.stringify(result));
  } finally { store.close(); }
}
if (require.main === module) {
  const command = process.argv[2];
  Promise.resolve().then(() => command === 'filesystem' ? filesystem() : command === 'checks' ? checks() : command === 'reuse' ? reuseIntegration() :
    command === 'audit-host' ? auditHost(process.argv[3], process.argv.includes('--recorded-frames')) :
      command === 'worker' || command === 'worker-child' ? worker(path.resolve(process.argv[3]), command === 'worker-child') :
      Promise.reject(new Error('Use explicit filesystem, reuse, checks or audit-host command.'))).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
