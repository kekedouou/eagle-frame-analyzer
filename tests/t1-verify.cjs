'use strict';
// Pure generation-profile capability checks. No files, media, evidence or Eagle.
const assert = require('assert');
const path = require('path');
const { profileCapability } = require('../scripts/verify-t1.cjs')._test;
const { OWNER, RECIPE } = require('../plugin/cache.cjs');
const { buildIndex } = require('../plugin/frame-index.cjs');
function fixture(options = {}) {
  const input = { key: 'baseline', sha256: 'a'.repeat(64), file: path.resolve('registered-source.mp4') };
  const source = { sha256: input.sha256, codec: 'vp9', width: 1920, height: 1080, hasAudioStream: false };
  const rows = [0, 1].map(id => ({ id, ptsTicks: String(id), file: id + '.jpg', bytes: 10, sha256: 'b'.repeat(64) }));
  const built = buildIndex(rows, { timeBase: [1, 10], lastFrameEndTicks: '2' });
  const manifest = { owner: OWNER, recipe: RECIPE, source, width: 1280, height: 720, duration: built.videoDuration, frames: built.frames, audio: null,
    metrics: { reused: false, generationMs: 4, phaseMs: { generationAndStreamsMs: 5, sourceRecheckMs: 1 } } };
  const current = { ...source, filePath: input.file, itemId: 'registered-baseline' };
  const calls = [], result = {}, stream = {}, expectedAsset = {}, cache = {
    async begin(settings) {
      calls.push(['begin', settings]); if (options.beginError) throw options.beginError;
      return { readComplete() { throw new Error('Must not inspect the existing reuse candidate.'); },
        writeAsset(...args) { calls.push(['writeAsset', ...args]); return expectedAsset; },
        openAsset(name) { calls.push(['openAsset', name]); return stream; },
        async finish(manifest, current) { calls.push(['finish', manifest, current]); if (options.finishError) throw options.finishError;
          if (Object.prototype.hasOwnProperty.call(options, 'finishReturn')) return options.finishReturn;
          throw new Error('Must not publish or lease the existing complete target.'); },
        abort() { calls.push(['abort']); if (options.abortError) throw options.abortError; return options.abortResult === undefined ? true : options.abortResult; },
        close() { calls.push(['close']); if (options.closeError) throw options.closeError; return options.closeResult === undefined ? true : options.closeResult; } };
    }, release(info) { calls.push(['release', info]); if (options.releaseError) throw options.releaseError; return true; }
  };
  const reference = { value: JSON.parse(JSON.stringify(manifest)) };
  const capability = profileCapability(cache, input, reference, result, process.hrtime.bigint(), !!options.finalValidation);
  return { input, current, manifest, calls, result, stream, expectedAsset, capability,
    begin: () => capability.cache.begin({ sourceSha256: input.sha256 }) };
}
async function run() {
  const passed = [];
  async function check(name, body) { await body(); passed.push(name); console.log('ok ' + name); }
  await check('Profile bypasses reuse only; write/open retain the original transaction capability', async () => {
    const h = fixture(), tx = await h.begin(), bytes = Buffer.from('in-memory JPEG bytes');
    assert.strictEqual(tx.readComplete(), null); assert(h.result.realWriterAcquired && h.result.existingCompleteBypassed);
    assert.strictEqual(tx.writeAsset('a.jpg', bytes), h.expectedAsset); assert.strictEqual(tx.openAsset('audio.wav'), h.stream);
    assert.strictEqual(h.calls[1][2], bytes); assert.deepStrictEqual(h.calls[2], ['openAsset', 'audio.wav']);
  });
  await check('Matching newly generated manifest throws the exact planned sentinel before publication', async () => {
    const h = fixture(), tx = await h.begin(); tx.readComplete();
    assert.throws(() => tx.finish(h.manifest, h.current), error => error === h.capability.completed && error.code === 'T1_PROFILE_COMPLETE');
    assert(h.result.finishReached && h.result.migrationMatch); assert.strictEqual(h.result.frameCount, 2); assert.strictEqual(h.result.generatedBytes, 20);
    assert.strictEqual(h.result.metrics.phaseMs.sourceRecheckMs, 1); assert(h.result.nodeToFinishEntryMs >= 0);
    h.manifest.metrics.phaseMs.sourceRecheckMs = 99; assert.strictEqual(h.result.metrics.phaseMs.sourceRecheckMs, 1);
    assert.deepStrictEqual(h.calls.map(call => call[0]), ['begin']);
  });
  await check('Wrong source is rejected before acquiring any real transaction', async () => {
    const h = fixture(); await assert.rejects(h.capability.cache.begin({ sourceSha256: 'c'.repeat(64) }), /registered source/);
    assert.deepStrictEqual(h.calls, []); assert.strictEqual(h.result.realWriterAcquired, undefined);
  });
  await check('A second transaction is refused even after the first writer closes', async () => {
    const h = fixture(), tx = await h.begin(); await tx.abort(); await tx.close();
    await assert.rejects(h.begin(), /one transaction/); assert.strictEqual(h.calls.filter(call => call[0] === 'begin').length, 1);
  });
  await check('Frame manifest mismatch cannot become the planned completion error', async () => {
    const h = fixture(), tx = await h.begin(); h.manifest.frames[1].sha256 = 'c'.repeat(64);
    assert.throws(() => tx.finish(h.manifest, h.current), error => error !== h.capability.completed && /mismatch/.test(error.message));
    assert.strictEqual(h.result.finishReached, undefined); assert.strictEqual(h.result.migrationMatch, undefined);
  });
  await check('Wrong current source binding and unexpected reuse cannot become planned completion', async () => {
    for (const currentChange of [{ itemId: 'registered-other' }, { filePath: path.resolve('another-source.mp4') }]) {
      const h = fixture(), tx = await h.begin();
      assert.throws(() => tx.finish(h.manifest, { ...h.current, ...currentChange }), error => error !== h.capability.completed && /binding/.test(error.message));
      assert.strictEqual(h.result.finishReached, undefined);
    }
    const h = fixture(), tx = await h.begin(); h.manifest.metrics.reused = true;
    assert.throws(() => tx.finish(h.manifest, h.current), error => error !== h.capability.completed && /unexpectedly reused/.test(error.message));
    assert.strictEqual(h.result.finishReached, undefined);
  });
  await check('Abort and writer close report actual completion and true/false return values', async () => {
    for (const completed of [true, false]) {
      const h = fixture({ abortResult: completed, closeResult: completed }), tx = await h.begin();
      assert.strictEqual(await tx.abort(), completed); assert.strictEqual(await tx.close(), completed);
      assert.strictEqual(h.result.partialAbortResult, completed); assert.strictEqual(h.result.writerCloseResult, completed);
      assert(h.result.partialAbortCompleted && h.result.writerCloseCompleted); assert(h.result.partialCleanupMs >= 0 && h.result.writerCloseMs >= 0);
      assert.deepStrictEqual(h.calls.map(call => call[0]), ['begin', 'abort', 'close']);
    }
  });
  await check('Cleanup failure propagates and never records cleanup as completed', async () => {
    const failure = new Error('owned partial cleanup failed'), h = fixture({ abortError: failure }), tx = await h.begin();
    assert.throws(() => tx.finish(h.manifest, h.current), error => error === h.capability.completed);
    await assert.rejects(tx.abort(), error => error === failure && error !== h.capability.completed);
    assert.strictEqual(h.result.partialAbortCompleted, undefined); assert.strictEqual(h.result.partialAbortResult, undefined);
    assert.strictEqual(h.result.plannedStopConfirmed, undefined); await tx.close();
  });
  await check('Writer-release failure propagates and never records writer close as completed', async () => {
    const failure = new Error('writer release failed'), h = fixture({ closeError: failure }), tx = await h.begin();
    assert.throws(() => tx.finish(h.manifest, h.current), error => error === h.capability.completed); await tx.abort();
    await assert.rejects(tx.close(), error => error === failure && error !== h.capability.completed);
    assert.strictEqual(h.result.writerCloseCompleted, undefined); assert.strictEqual(h.result.writerCloseResult, undefined);
    assert.strictEqual(h.result.plannedStopConfirmed, undefined);
  });
  await check('Unexpected acquisition error with the same code is still not the planned sentinel', async () => {
    const failure = Object.assign(new Error('unexpected writer error'), { code: 'T1_PROFILE_COMPLETE' });
    const h = fixture({ beginError: failure });
    await assert.rejects(h.begin(), error => error === failure && error !== h.capability.completed);
    assert.strictEqual(h.result.realWriterAcquired, undefined); assert.strictEqual(h.result.finishReached, undefined);
    assert.strictEqual(h.result.plannedStopConfirmed, undefined);
  });
  await check('Final profile awaits actual finish and only translates the exact existing-target refusal', async () => {
    const h = fixture({ finalValidation: true, finishError: new Error('完整缓存目标已存在；拒绝覆盖。') }), tx = await h.begin(); tx.readComplete();
    await assert.rejects(tx.finish(h.manifest, h.current), error => error === h.capability.completed && error.code === 'T1_PROFILE_COMPLETE');
    assert(h.result.actualFinishRejectedExistingTarget); assert(h.result.finalValidationMs >= 0);
    assert(h.result.nodeThroughFinalValidationMs >= h.result.nodeToFinishEntryMs);
    assert.strictEqual(h.calls[1][0], 'finish'); assert.strictEqual(h.calls[1][1], h.manifest); assert.strictEqual(h.calls[1][2], h.current);
    await tx.abort(); await tx.close(); assert(h.result.partialAbortCompleted && h.result.writerCloseCompleted);
  });
  await check('Final profile preserves every other actual-finish error without declaring target refusal', async () => {
    for (const failure of [new Error('完整缓存目标已存在；拒绝覆盖。 extra'), new Error('asset fingerprint changed'),
      Object.assign(new Error('完整缓存目标已存在；拒绝覆盖。'), { code: 'UNEXPECTED_OTHER_FAILURE' }),
      Object.assign(new Error('完整缓存目标已存在；拒绝覆盖。'), { cleanupError: 'partial cleanup failed' })]) {
      const h = fixture({ finalValidation: true, finishError: failure }), tx = await h.begin();
      await assert.rejects(tx.finish(h.manifest, h.current), error => error === failure && error !== h.capability.completed);
      assert.strictEqual(h.result.actualFinishRejectedExistingTarget, undefined); assert.strictEqual(h.result.plannedStopConfirmed, undefined);
      await tx.abort(); await tx.close();
    }
  });
  await check('Any actual-finish return fails; an unexpected original handle is released once', async () => {
    for (const handle of [{ leaseId: 'unexpected-original-handle' }, null]) {
      const h = fixture({ finalValidation: true, finishReturn: handle }), tx = await h.begin();
      await assert.rejects(tx.finish(h.manifest, h.current), error => error !== h.capability.completed && error.code === 'T1_PROFILE_UNEXPECTED_FINISH_RETURN');
      assert(h.result.unexpectedFinishReturn); assert.strictEqual(h.result.actualFinishRejectedExistingTarget, undefined);
      const releases = h.calls.filter(call => call[0] === 'release'); assert.strictEqual(releases.length, handle ? 1 : 0);
      if (handle) { assert.strictEqual(releases[0][1], handle); assert(h.result.unexpectedHandleReleased); }
      await tx.abort(); await tx.close();
    }
  });
  await check('Unexpected-handle release failure remains a failure rather than a planned stop', async () => {
    const h = fixture({ finalValidation: true, finishReturn: { leaseId: 'unexpected' }, releaseError: new Error('lease release failed') }), tx = await h.begin();
    await assert.rejects(tx.finish(h.manifest, h.current), error => error !== h.capability.completed && error.releaseError === 'lease release failed');
    assert.strictEqual(h.result.unexpectedHandleReleased, undefined); assert.strictEqual(h.result.actualFinishRejectedExistingTarget, undefined);
    await tx.abort(); await tx.close();
  });
  console.log('T1 verification capability: ' + passed.length + ' pure checks; no real profile/media/cleanup/evidence executed.');
  return { count: passed.length, passed };
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error.stack); process.exitCode = 1; });
