'use strict';
// Explicit local-only T1 checks/media regression. No Eagle, sample generation,
// T0 preparation/reset/writes or cleanup of historical files.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { isDeepStrictEqual } = require('util');
const { spawnSync } = require('child_process');
const { createStore } = require('../tests/support/t1-evidence.cjs');
const { createCache, OWNER, RECIPE } = require('../plugin/cache.cjs');
const { createMedia } = require('../plugin/media.cjs');
const { validateIndex } = require('../plugin/frame-index.cjs');
const repo = path.resolve(__dirname, '..'), pluginRoot = path.join(repo, 'plugin');
const KEYS = Object.freeze(['baseline', 'h264-cfr', 'hevc-vfr', 'vp9-silent']);
const PROFILE_KEYS = Object.freeze(['baseline', 'h264-cfr']);
const EXISTING_TARGET_REFUSAL = '完整缓存目标已存在；拒绝覆盖。';
const T0_OWNER = 'eagle-video-analysis-T0-v1', T0_RECIPE = 'T0-jpeg-q3-720p-pcm-f32-48000-v1';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const now = () => process.hrtime.bigint();
const elapsed = start => Number(now() - start) / 1e6;
function fail(message) { throw new Error(message); }
function samePath(a, b) { return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b); }
function regular(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || !samePath(fs.realpathSync(file), file)) fail('Read-only input must be a canonical regular file.');
  return stat;
}
function directory(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(fs.realpathSync(dir), dir)) fail('Read-only reference directory must be canonical.');
}
function json(file, maximum = 8 * 1024 ** 2) {
  const before = regular(file); if (before.size > maximum) fail('Read-only JSON exceeds its bounded limit.');
  const data = fs.readFileSync(file), after = regular(file);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== before.size)
    fail('Read-only JSON changed while reading.');
  return { value: JSON.parse(data.toString('utf8')), sha256: sha(data), bytes: data.length };
}
async function sourceHash(file, signal) {
  const before = regular(file), digest = crypto.createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 ** 2 })) {
    if (signal && signal.aborted) { const error = new Error('Local verification cancelled.'); error.name = 'AbortError'; throw error; }
    digest.update(chunk); bytes += chunk.length;
  }
  const after = regular(file);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size)
    fail('Source changed while reading; no verification claim was made.');
  return { sha256: digest.digest('hex'), bytes, stamp: { ino: before.ino, dev: before.dev, mtimeMs: before.mtimeMs } };
}
function config() {
  const result = json(path.join(repo, 'tests/host/t0/config.local.json'));
  const value = result.value;
  if (!Array.isArray(value.sources) || value.sources.length !== KEYS.length || new Set(value.sources.map(input => input.key)).size !== KEYS.length)
    fail('Only the four already registered T0 inputs are permitted.');
  for (const item of value.sources) {
    if (!KEYS.includes(item.key) || typeof item.file !== 'string' || !path.isAbsolute(item.file) || !/^[0-9a-f]{64}$/.test(item.sha256)) fail('Invalid registered source.');
    regular(item.file);
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    if (typeof value[name] !== 'string' || !path.isAbsolute(value[name])) fail('Existing absolute media tools are required; nothing is installed.');
    regular(value[name]);
  }
  return { ...value, registrationSha256: result.sha256 };
}
function execute(file, args, timeout = 120000) {
  const result = spawnSync(file, args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 512 * 1024 });
  return { status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '',
    error: result.error ? { code: result.error.code, message: result.error.message } : null };
}
function git(args) {
  const result = execute('git', args, 10000); if (result.error || result.status !== 0) fail('Git context could not be recorded.'); return result.stdout.trim();
}
function context(tools) {
  const names = [...fs.readdirSync(pluginRoot).filter(name => /\.(?:js|cjs|html|css|json)$/.test(name)).map(name => 'plugin/' + name),
    'scripts/check.cjs', 'scripts/verify-t1.cjs', 'scripts/prepare-window-host.cjs', 'tests/support/t1-evidence.cjs',
    'tests/host/window/bootstrap.js', 'tests/support/window-launch.cjs', 'tests/support/window-host.cjs', 'tests/window-launch.cjs', 'tests/window-host.cjs'];
  return { origin: 'local-node-not-Eagle', date: new Date().toISOString(), node: process.versions.node, platform: process.platform,
    arch: process.arch, cpu: os.cpus()[0] && os.cpus()[0].model, logicalCpus: os.cpus().length, totalRamBytes: os.totalmem(),
    gitHead: git(['rev-parse', 'HEAD']), gitStatus: git(['status', '--short']),
    sourceFiles: names.map(file => ({ file, sha256: sha(fs.readFileSync(path.join(repo, file))) })),
    tools: tools ? Object.fromEntries(['ffmpeg', 'ffprobe'].map(name => [name, { file: tools[name], version: execute(tools[name], ['-version'], 10000) }])) : null };
}
function legacy(input) {
  const root = path.join(repo, 'tests/host/t0/cache'); directory(root);
  const rootOwner = json(path.join(root, 'owner.json')).value;
  if (rootOwner.owner !== T0_OWNER || rootOwner.root !== root || rootOwner.kind !== 'root') fail('T0 cache root ownership is unknown; reference refused.');
  const dir = path.join(root, 'media-' + input.sha256 + '-' + sha(Buffer.from(T0_RECIPE)).slice(0, 12)); directory(dir);
  const owner = json(path.join(dir, 'owner.json')).value;
  if (owner.owner !== T0_OWNER || owner.root !== root || owner.kind !== 'cache') fail('T0 reference cache ownership is unknown.');
  const result = json(path.join(dir, 'manifest.json')), info = result.value;
  if (info.schema !== 1 || info.owner !== T0_OWNER || info.recipe !== T0_RECIPE || !info.source || info.source.sha256 !== input.sha256)
    fail('T0 reference content identity is wrong.');
  validateIndex(info);
  return { ...result, file: path.join(dir, 'manifest.json') };
}
function same(value, expected, label) {
  if (!isDeepStrictEqual(value, expected)) fail('Migration regression mismatch: ' + label);
}
function compare(info, old, input) {
  validateIndex(info);
  if (info.owner !== OWNER || info.recipe !== RECIPE || info.source.sha256 !== input.sha256) fail('Formal prepared content identity is wrong.');
  for (const key of ['width', 'height', 'duration']) same(info[key], old[key], key);
  for (const key of ['sha256', 'codec', 'width', 'height', 'hasAudioStream']) same(info.source[key], old.source[key], 'source.' + key);
  same(info.frames.length, old.frames.length, 'frame count');
  for (let index = 0; index < info.frames.length; index++) {
    for (const key of ['id', 'ptsTicks', 'timeBase', 'time', 'end', 'file', 'bytes', 'sha256'])
      same(info.frames[index][key], old.frames[index][key], 'frame ' + index + '.' + key);
  }
  same(info.audio, old.audio, 'audio asset, PCM bytes and source time');
}
async function verifyAssets(cache, info, signal) {
  const started = now(), digest = crypto.createHash('sha256'); let total = 0, count = 0;
  for (const asset of [...info.frames, ...(info.audio ? [info.audio] : [])]) {
    if (signal.aborted) { const error = new Error('Asset verification cancelled.'); error.name = 'AbortError'; throw error; }
    // The original registered handle is deliberately retained, never cloned.
    const data = await cache.readAsset(info, asset.file), fingerprint = sha(data);
    if (data.length !== asset.bytes || fingerprint !== asset.sha256) fail('Actual formal cache asset failed its complete hash check.');
    digest.update(asset.file + '\0' + fingerprint + '\n'); total += data.length; count++;
  }
  return { count, frameCount: info.frames.length, audioCount: info.audio ? 1 : 0, bytes: total, allAssetHashDigest: digest.digest('hex'), verificationMs: elapsed(started) };
}
function residual(root) {
  if (!fs.existsSync(root)) return { entries: [], transient: [], completeCount: 0 };
  directory(root); const entries = fs.readdirSync(root).sort(), transient = entries.filter(name => name === 'writer.lock' || /^(?:lease-|partial-)/.test(name));
  return { entries, transient, completeCount: entries.filter(name => /^media-/.test(name)).length };
}
function completeSnapshot(root) {
  const status = residual(root);
  if (status.transient.length) fail('Profile requires no existing formal transients; none are removed by preflight.');
  const marker = json(path.join(root, 'owner.json'));
  if (marker.value.owner !== OWNER || marker.value.recipe !== RECIPE || marker.value.root !== root || marker.value.kind !== 'root')
    fail('Profile formal cache root ownership is unknown.');
  const complete = [];
  for (const name of status.entries) {
    if (name === 'owner.json') continue;
    if (!/^media-[0-9a-f]{64}-[0-9a-f]{12}$/.test(name)) fail('Unknown formal cache entry prevents this profile.');
    const dir = path.join(root, name); directory(dir);
    const owner = json(path.join(dir, 'owner.json')), manifest = json(path.join(dir, 'manifest.json'));
    if (owner.value.owner !== OWNER || owner.value.recipe !== RECIPE || owner.value.root !== root || owner.value.kind !== 'cache')
      fail('Complete formal cache ownership is unknown.');
    if (manifest.value.owner !== OWNER || manifest.value.recipe !== RECIPE || !manifest.value.source ||
      name !== 'media-' + manifest.value.source.sha256 + '-' + sha(Buffer.from(RECIPE)).slice(0, 12)) fail('Complete formal manifest identity is unknown.');
    validateIndex(manifest.value);
    const names = fs.readdirSync(dir).sort(), digest = crypto.createHash('sha256'); let bytes = 0;
    for (const file of names) {
      const stat = regular(path.join(dir, file)); if (stat.nlink !== 1) fail('Profile refuses linked formal cache assets.');
      digest.update(JSON.stringify([file, stat.size, stat.ino, stat.dev, stat.mtimeMs]) + '\n'); bytes += stat.size;
    }
    complete.push({ name, fileCount: names.length, bytes, fileNamesAndStatsSha256: digest.digest('hex'), ownerSha256: owner.sha256, manifestSha256: manifest.sha256 });
  }
  return { ...status, rootOwnerSha256: marker.sha256, complete };
}
function profileCapability(cache, input, reference, result, started, finalValidation = false) {
  const completed = Object.assign(new Error(finalValidation ? 'T1 final-validation profile reached the existing-target publication refusal.'
    : 'T1 generation-only profile reached its deliberate pre-publication stop.'), { code: 'T1_PROFILE_COMPLETE' });
  let begun = false;
  return { completed, cache: {
    async begin(settings) {
      if (begun || settings.sourceSha256 !== input.sha256) fail('Profile must use one transaction for its registered source.');
      begun = true; const tx = await cache.begin(settings);
      result.realWriterAcquired = true;
      async function validateThroughFinish(manifest, currentSource) {
        const validation = now(); let returned = null;
        try {
          returned = await tx.finish(manifest, currentSource);
        } catch (error) {
          result.finalValidationMs = elapsed(validation); result.nodeThroughFinalValidationMs = elapsed(started);
          result.finalValidationError = { name: error.name, code: error.code, message: error.message };
          if (error.name !== 'Error' || error.code !== undefined || error.message !== EXISTING_TARGET_REFUSAL ||
            error.cleanupError !== undefined || error.lockReleaseError !== undefined || error.releaseError !== undefined) throw error;
          result.actualFinishRejectedExistingTarget = true;
          throw completed;
        }
        result.finalValidationMs = elapsed(validation); result.nodeThroughFinalValidationMs = elapsed(started);
        result.unexpectedFinishReturn = true;
        const failure = Object.assign(new Error('Final-validation profile unexpectedly returned from actual finish; no planned completion is claimed.'), { code: 'T1_PROFILE_UNEXPECTED_FINISH_RETURN' });
        if (returned) {
          try { await cache.release(returned); result.unexpectedHandleReleased = true; }
          catch (error) { failure.releaseError = error.message; }
        }
        throw failure;
      }
      return Object.freeze({
        readComplete() { result.existingCompleteBypassed = true; return null; },
        writeAsset: (...args) => tx.writeAsset(...args), openAsset: (...args) => tx.openAsset(...args),
        finish(manifest, currentSource) {
          result.nodeToFinishEntryMs = elapsed(started);
          result.metrics = JSON.parse(JSON.stringify(manifest.metrics));
          const validation = now(); compare(manifest, reference.value, input);
          if (!currentSource || currentSource.sha256 !== input.sha256 || !samePath(currentSource.filePath, input.file) || currentSource.itemId !== 'registered-' + input.key)
            fail('Profile generated source binding changed.');
          if (manifest.metrics.reused) fail('Generation profile unexpectedly reused a complete cache.');
          result.migrationMatch = true; result.manifestComparisonMs = elapsed(validation);
          result.frameCount = manifest.frames.length; result.audioCount = manifest.audio ? 1 : 0;
          result.generatedBytes = manifest.frames.reduce((sum, frame) => sum + frame.bytes, 0) + (manifest.audio ? manifest.audio.bytes : 0);
          result.finishReached = true;
          if (finalValidation) return validateThroughFinish(manifest, currentSource);
          // Never publish, lease or overwrite the already complete target.
          throw completed;
        },
        async abort() {
          const cleanup = now(); result.partialAbortResult = await tx.abort();
          result.partialCleanupMs = elapsed(cleanup); result.partialAbortCompleted = true; return result.partialAbortResult;
        },
        async close() {
          const close = now(); result.writerCloseResult = await tx.close();
          result.writerCloseMs = elapsed(close); result.writerCloseCompleted = true; return result.writerCloseResult;
        }
      });
    },
    release: info => cache.release(info)
  } };
}
const limitations = Object.freeze([
  'Local Node verification, not a real Eagle launch, selection, UI, sound or human experience test.',
  'Previous T0 manifest is a migration reference, not a new independent source-frame proof; all formal asset bytes are read and hashed.',
  'media.prepare time includes formal hash/probe/build or reuse/commit/lease/writer release; it excludes Eagle selection and browser/player readiness and does not pass full P-03.',
  'No P-01/P-02 presentation measurement, no RAM decoded-cache test, no long-term T2 lifecycle or crash recovery validation.',
  'FFmpeg sampled working set is taken from formal metrics; Node memory snapshots are separate and may miss peaks; GPU/whole Eagle memory is unmeasured.',
  'No OS filesystem cache flush; first preparation is not a cold-storage timing claim.'
]);
async function runMedia(keys, report, signal) {
  const cfg = config(), cache = createCache({ pluginRoot }), media = createMedia({ tools: cfg, cache });
  report.environment = context(cfg); report.registrationSha256 = cfg.registrationSha256;
  report.before = { memory: process.memoryUsage(), cache: residual(cache.root) };
  if (report.before.cache.transient.length) fail('Existing formal cache transients must be investigated; they are not deleted by this command.');
  try {
    for (const key of keys) {
      const input = cfg.sources.find(item => item.key === key), reference = legacy(input);
      const entry = { key, source: { file: input.file, registeredSha256: input.sha256 }, oldT0Reference: { file: reference.file, sha256: reference.sha256, bytes: reference.bytes }, rounds: [] };
      report.results.push(entry);
      for (let round = 0; round < 2; round++) {
        let info = null; const result = { round: round + 1, requestedRole: round ? 'reuse' : 'first-if-no-existing-complete-cache', startedAt: new Date().toISOString() };
        entry.rounds.push(result);
        try {
          result.sourceBefore = await sourceHash(input.file, signal);
          same(result.sourceBefore.sha256, input.sha256, key + ' registered source hash before');
          const started = now();
          info = await media.prepare({ id: 'registered-' + key, itemId: 'registered-' + key, name: input.label || key, ext: 'mp4', filePath: input.file }, { signal });
          result.nodePrepareMs = elapsed(started); result.reused = info.metrics.reused; result.metrics = info.metrics;
          result.actualRole = info.metrics.reused ? 'existing-complete-cache-validated-and-reused' : 'new-formal-cache-generated';
          if (round && !info.metrics.reused) fail('Second sequential preparation did not reuse its complete cache.');
          compare(info, reference.value, input); result.migrationMatch = true;
          result.assets = await verifyAssets(cache, info, signal);
          result.sourceAfter = await sourceHash(input.file, signal);
          same(result.sourceAfter, result.sourceBefore, key + ' source fingerprint/stamp after');
          same(json(reference.file).sha256, reference.sha256, key + ' old T0 manifest unchanged');
          result.passed = true;
        } catch (error) { result.passed = false; result.error = { name: error.name, code: error.code, message: error.message }; throw error; }
        finally {
          if (info) result.leaseReleased = cache.release(info);
          result.cacheAfterRelease = residual(cache.root);
          if (result.cacheAfterRelease.transient.length) fail('Formal writer/lease/partial residue remains; no cleanup was attempted.');
        }
        console.log(JSON.stringify({ key, round: result.round, reused: result.reused, frames: result.assets.frameCount, bytes: result.assets.bytes, nodePrepareMs: result.nodePrepareMs, passed: result.passed }));
      }
    }
  } finally { report.after = { memory: process.memoryUsage(), cache: residual(cache.root) }; }
}
async function runCancel(report, outerSignal) {
  const cfg = config(), input = cfg.sources.find(item => item.key === 'h264-cfr'), cache = createCache({ pluginRoot });
  report.environment = context(cfg); report.registrationSha256 = cfg.registrationSha256;
  report.before = { memory: process.memoryUsage(), cache: residual(cache.root) };
  if (report.before.cache.transient.length) fail('Existing formal transients prevent the cancellation experiment.');
  const complete = 'media-' + input.sha256 + '-' + sha(Buffer.from(RECIPE)).slice(0, 12);
  if (fs.existsSync(path.join(cache.root, complete))) {
    report.skipped = 'h264-cfr already has a complete formal cache; retained without reset. Run cancel before media when fresh.';
    report.passed = false; return;
  }
  const controller = new AbortController(), abort = () => controller.abort();
  outerSignal.addEventListener('abort', abort, { once: true });
  if (outerSignal.aborted) abort();
  const before = await sourceHash(input.file, outerSignal); same(before.sha256, input.sha256, 'cancel source before');
  const result = { key: input.key, sourceBefore: before, trigger: 'first decode progress after a written JPEG asset', startedAt: new Date().toISOString() };
  report.results.push(result); let info = null; const started = now();
  try {
    const media = createMedia({ tools: cfg, cache });
    try {
      info = await media.prepare({ id: 'registered-h264-cfr', itemId: 'registered-h264-cfr', name: input.label, ext: 'mp4', filePath: input.file }, {
        signal: controller.signal, onProgress(value) { if (value.stage === 'decode' && value.frames >= 1 && !controller.signal.aborted) { result.framesAtAbort = value.frames; result.abortAtMs = elapsed(started); controller.abort(); } }
      });
      fail('Cancellation unexpectedly returned a ready cache.');
    } catch (error) {
      result.returnedAtMs = elapsed(started); result.error = { name: error.name, code: error.code, message: error.message };
      if (error.name !== 'AbortError' || !result.framesAtAbort) throw error;
      result.prepareRejectedAfterAwait = true;
    }
  } finally {
    outerSignal.removeEventListener('abort', abort);
    if (info) cache.release(info);
    result.sourceAfter = await sourceHash(input.file, null);
    same(result.sourceAfter, before, 'cancel source unchanged');
    report.after = { memory: process.memoryUsage(), cache: residual(cache.root) };
  }
  same(report.after.cache.entries.filter(name => name !== 'owner.json'), report.before.cache.entries.filter(name => name !== 'owner.json'), 'cancel transient/output entries restored');
  result.passed = true;
  result.boundary = 'Real media.prepare was awaited through its child/stream-settlement and transaction cleanup contract; no independent process-tree observer or Eagle close test.';
}
async function runProfile(key, report, signal, finalValidation = false) {
  const cfg = config(), input = cfg.sources.find(item => item.key === key), reference = legacy(input), cache = createCache({ pluginRoot });
  report.environment = context(cfg); report.registrationSha256 = cfg.registrationSha256;
  report.before = { memory: process.memoryUsage(), cache: completeSnapshot(cache.root) };
  const target = 'media-' + input.sha256 + '-' + sha(Buffer.from(RECIPE)).slice(0, 12);
  if (!report.before.cache.complete.some(item => item.name === target)) fail('Profile requires the selected complete formal cache to exist; nothing is reset or deleted.');
  const result = { key, requestedRole: finalValidation ? 'new-generation-final-validated-until-existing-target-refusal' : 'new-generation-discarded-before-complete-publication', startedAt: new Date().toISOString(),
    source: { file: input.file, registeredSha256: input.sha256 }, oldT0Reference: { file: reference.file, sha256: reference.sha256, bytes: reference.bytes }, stages: [] };
  report.results.push(result); let unexpected = null;
  try {
    result.sourceBefore = await sourceHash(input.file, signal); same(result.sourceBefore.sha256, input.sha256, 'profile registered source before');
    const started = now(), capability = profileCapability(cache, input, reference, result, started, finalValidation);
    const media = createMedia({ tools: cfg, cache: capability.cache }); let returned = null;
    try {
      returned = await media.prepare({ id: 'registered-' + key, itemId: 'registered-' + key, name: input.label || key, ext: 'mp4', filePath: input.file }, {
        signal, onProgress(value) {
          const last = result.stages[result.stages.length - 1];
          if ((!last || last.stage !== value.stage) && result.stages.length < 64) result.stages.push({ stage: value.stage, atMs: elapsed(started) });
        }
      });
      fail('Profile unexpectedly returned a ready complete cache.');
    } catch (error) {
      result.returnedAfterCleanupMs = elapsed(started);
      result.returnedError = { name: error.name, code: error.code, message: error.message,
        cleanupError: error.cleanupError, lockReleaseError: error.lockReleaseError, releaseError: error.releaseError };
      if (error !== capability.completed || !result.finishReached || error.cleanupError || error.lockReleaseError || error.releaseError) throw error;
      if (finalValidation && !result.actualFinishRejectedExistingTarget) fail('Actual finish did not reach the exact existing-target refusal.');
      if (signal.aborted) { const aborted = new Error('Generation profile was cancelled.'); aborted.name = 'AbortError'; throw aborted; }
      if (!result.partialAbortCompleted || result.partialAbortResult !== true || !result.writerCloseCompleted || result.writerCloseResult !== true)
        fail('Profile cleanup and writer release were not confirmed.');
      result.plannedStopConfirmed = true;
    } finally { if (returned) cache.release(returned); }
  } catch (error) { unexpected = error; }
  finally {
    try {
      report.after = { memory: process.memoryUsage(), cache: residual(cache.root) };
      result.sourceAfter = await sourceHash(input.file, null);
      if (result.sourceBefore) same(result.sourceAfter, result.sourceBefore, 'profile source fingerprint/stamp unchanged');
      same(json(reference.file).sha256, reference.sha256, 'profile old T0 manifest unchanged');
      report.after.cache = completeSnapshot(cache.root);
      same(report.after.cache, report.before.cache, 'profile complete formal files/metadata and root entries unchanged');
      result.preservationVerified = true;
    } catch (error) {
      if (unexpected) unexpected.preservationError = error.message; else unexpected = error;
      result.preservationError = error.message;
    }
  }
  result.passed = !unexpected && !!result.plannedStopConfirmed && !!result.preservationVerified;
  result.boundary = finalValidation
    ? 'Actual tx.finish wrote the new manifest, inspected the partial and rehashed every generated asset, then rejected the already existing complete target before owner modification/rename. Timing includes that refusal, but no actual publication/lease or player/UI readiness; not complete first preparation or full P-03, and no old measurement arithmetic is used.'
    : 'Measured to tx.finish entry after generation, stream/process settlement and source recheck. No actual complete commit, lease or player/UI readiness; not complete first preparation or full P-03.';
  if (unexpected) throw unexpected;
  console.log(JSON.stringify({ key, profile: true, frames: result.frameCount, nodeToFinishEntryMs: result.nodeToFinishEntryMs,
    generationMs: result.metrics.generationMs, ...(finalValidation ? { profileFinal: true, finalValidationMs: result.finalValidationMs,
      nodeThroughFinalValidationMs: result.nodeThroughFinalValidationMs, actualFinishRejectedExistingTarget: result.actualFinishRejectedExistingTarget } : {}),
    returnedAfterCleanupMs: result.returnedAfterCleanupMs, passed: result.passed }));
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!['record-checks', 'media', 'cancel', 'profile', 'profile-final'].includes(mode) || (['record-checks', 'cancel'].includes(mode) && args.length) ||
    (['profile', 'profile-final'].includes(mode) && (args.length !== 1 || !PROFILE_KEYS.includes(args[0]))) || args.some(key => !KEYS.includes(key)) || new Set(args).size !== args.length)
    fail('Usage: node scripts/verify-t1.cjs record-checks | media [baseline h264-cfr hevc-vfr vp9-silent] | cancel | profile/profile-final baseline|h264-cfr');
  const store = createStore(repo), controller = new AbortController(), stop = () => controller.abort();
  const report = { schema: 1, task: 'T1', mode, executor: 'Codex', origin: 'local-node-not-Eagle', startedAt: new Date().toISOString(), limitations, results: [] };
  if (mode === 'profile') report.limitations = [
    'Local Node generation-only diagnostic, not a real Eagle/UI/sound/human experience test or full P-03 acceptance.',
    'An existing complete cache is retained. A test-only capability bypasses readComplete, then real media writes a new bounded, locked partial; finish compares generated manifest/frame/PCM hashes with old T0 and deliberately stops before publication.',
    'Timing ends at finish entry after generation and source recheck. Actual complete-asset readback/commit/lease, writer release and player/UI readiness are excluded; cleanup timings are reported separately, never subtracted from previous complete measurements.',
    'Complete-cache preservation compares directory/file names and stats plus manifest/owner hashes, not a fresh content hash of every retained asset. No independently decoded source-frame or audio-sync proof is claimed.',
    'Only the exact planned stop with confirmed partial abort/writer close and unchanged source/cache/reference is success; any tool, compare, cleanup or release error fails.',
    limitations[4], limitations[5]
  ];
  if (mode === 'profile-final') report.limitations = [
    'Local Node final-validation diagnostic, not a real Eagle/UI/sound/human experience test or full P-03 acceptance.',
    'The selected complete formal cache must already exist and is retained. Test-only readComplete bypass forces a real locked/bounded new partial; actual finish writes its manifest, inspects it and reads/hashes every generated asset.',
    'Only the exact existing-target refusal before owner modification/rename is translated to the unique planned stop. Any other error or returned handle fails; an unexpected handle is released.',
    'Timing is measured directly through actual final validation and the existing-target refusal. No publication/lease, writer-release success path or player/UI readiness is measured; no cost is added to or subtracted from old timings to fabricate a complete first-preparation value.',
    'Partial abort/writer close and unchanged source fingerprint/stamp, T0 manifest and all retained complete directories are required. Retained file preservation compares names/stats plus manifest/owner hashes, not every retained asset content hash.',
    limitations[4], limitations[5]
  ];
  let primary = null;
  store.start(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (mode === 'record-checks') {
      report.environment = context(null);
      report.checks = execute(process.execPath, [path.join(repo, 'scripts/check.cjs')]);
      process.stdout.write(report.checks.stdout);
      if (report.checks.error || report.checks.status !== 0) fail('Unified local checks failed; the failed result is retained.');
    } else if (mode === 'media') await runMedia(args.length ? args : KEYS, report, controller.signal);
    else if (mode === 'profile' || mode === 'profile-final') await runProfile(args[0], report, controller.signal, mode === 'profile-final');
    else await runCancel(report, controller.signal);
    if (!report.skipped) report.passed = true;
  } catch (error) { primary = error; report.passed = false; report.error = { name: error.name, code: error.code, message: error.message, cleanupError: error.cleanupError, lockReleaseError: error.lockReleaseError }; }
  finally {
    report.finishedAt = new Date().toISOString();
    try { console.log('Evidence: ' + JSON.stringify(store.save(mode === 'record-checks' ? 'checks' : ['profile', 'profile-final'].includes(mode) ? 'media' : mode, report))); }
    catch (error) { console.error('T1 evidence save failed: ' + error.message); primary = primary || error; }
    try { store.close(); } catch (error) { console.error('T1 evidence lock retained: ' + error.message); primary = primary || error; }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  if (primary) throw primary;
}
if (require.main === module) main().catch(error => { console.error('T1 verification failed: ' + (error.code || error.name)); process.exitCode = 1; });
module.exports = { _test: { compare, verifyAssets, residual, profileCapability } };
