'use strict';
// Explicit T2 prerequisite: real HEVC/media/cache, simulated nonawaiting host
// close. No Eagle start/kill, metadata write, full-cache deletion or T4 claim.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { createCache } = require('../plugin/cache.cjs');
const { createStore } = require('../tests/support/t2-evidence.cjs');
const regression = require('./verify-t1-close.cjs');
const repo = path.resolve(__dirname, '..'), pluginRoot = path.join(repo, 'plugin');
const SOURCE_SHA = 'd7bbab0b425381c880adacb9f8d95d900aa162c4c5c9308cf9a3f8482ff67658';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function selectedInput(config) {
  const known = config.sources.find(value => value.key === 'baseline');
  if (!known) throw new Error('Missing existing explicitly registered library input.');
  const libraryImages = path.dirname(path.dirname(known.file));
  return { itemId: 'MV6H7OK0MBGX2', name: '喜多郁代', sha256: SOURCE_SHA,
    file: path.join(libraryImages, 'MV6H7OK0MBGX2.info', '喜多郁代.mp4') };
}
function validateInventory(value) {
  // Preserve every existing complete cache. Refuse pressure instead of letting
  // this diagnostic evict unrelated caches to make its own partial fit.
  if (!Number.isSafeInteger(value.usedBytes) || !Number.isSafeInteger(value.diskLimitBytes) ||
      value.usedBytes < 0 || !Array.isArray(value.leases) ||
      value.usedBytes + 257 * 1024 ** 2 > value.diskLimitBytes || value.leases.length)
    throw new Error('Close diagnostic requires 257MiB free cache budget and no live lease; retained.');
}
function limitedTransaction(tx, limit = 256 * 1024 ** 2) {
  let written = 0;
  function charge(data) {
    if (!Buffer.isBuffer(data) || written + data.length > limit)
      throw new Error('Diagnostic partial exceeds fixed asset budget; cancel own task, preserve complete caches.');
    written += data.length;
  }
  return { ...tx, writeAsset(name, data) { charge(data); return tx.writeAsset(name, data); },
    openAsset(name) { const stream = tx.openAsset(name); return { ...stream,
      append(data) { charge(data); return stream.append(data); } }; } };
}
async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json')));
  const input = selectedInput(config), cache = createCache({ pluginRoot });
  const store = createStore(repo), sourceHashes = Object.fromEntries([
    'scripts/verify-t2-close.cjs', 'scripts/verify-t1-close.cjs',
    ...fs.readdirSync(pluginRoot).filter(n => /\.(?:cjs|js)$/.test(n)).map(n => 'plugin/' + n)
  ].map(file => [file, sha(fs.readFileSync(path.join(repo, file)))]));
  const report = { schema: 't2-hevc-close-model-v1', at: new Date().toISOString(),
    origin: 'Codex-local-real-HEVC-cache-with-simulated-host-UI-and-player', sourceHashes,
    source: input, cases: [], passed: false, actualEagleExecuted: false, overallT2Accepted: false,
    limitations: ['Not an actual Eagle/window or browser/audio test.',
      'Existing complete-cache preservation uses file identity/stats and owner/manifest hashes, not all retained asset contents.',
      'No P-03 readiness measurement: both runs intentionally cancel before ready.',
      'Auxiliary-process/internal/GPU total peaks are not established by this regression.'] };
  let failure;
  store.start({ reserveBytes: 256 * 1024 });
  try {
    report.inventoryBefore = cache.inventory(); validateInventory(report.inventoryBefore);
    report.sourceBefore = regression.source(input); assert.equal(report.sourceBefore.sha256, SOURCE_SHA);
    for (const mode of ['first-written-frame', 'before-final-validation']) {
      const result = { mode }; report.cases.push(result);
      await regression.run(mode, result, input, { wrapTransaction: limitedTransaction, waitForCloseMs: 120000 });
      assert(result.transactionWrapped, 'Diagnostic asset guard must wrap the actual transaction.');
      assert(!result.progressTruncated, 'Close diagnostic progress record truncated; not passed.');
      console.log(JSON.stringify({ mode, passed: result.passed, closeAtProgress: result.closeAtProgress,
        nativeCloseAttempts: result.nativeCloseAttempts, transientsAfter: result.after.transient.length }));
    }
    report.sourceAfter = regression.source(input); assert.deepStrictEqual(report.sourceAfter, report.sourceBefore);
    report.inventoryAfter = cache.inventory(); validateInventory(report.inventoryAfter);
    assert.equal(report.inventoryAfter.usedBytes, report.inventoryBefore.usedBytes);
    report.passed = true;
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    report.finishedAt = new Date().toISOString();
    try { console.log('Evidence: ' + JSON.stringify(store.save('lifecycle', report))); }
    finally { store.close(); }
  }
  if (failure) throw failure;
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { _test: { selectedInput, validateInventory, limitedTransaction } };
