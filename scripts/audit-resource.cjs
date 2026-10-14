'use strict';
// Explicit read-only recomputation of saved lifecycle samples; writes one bounded audit receipt.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib'), assert = require('assert');
const { createStore, OWNER, _test: { canonical, runPattern } } = require('../tests/support/t2-evidence.cjs');
const { PROTOCOL, _test: { trends } } = require('../tests/support/window-resource.cjs');
const entry = require('./prepare-window-host.cjs');
const repo = path.resolve(__dirname, '..'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function unpack(packed) {
  const bytes = Buffer.from(packed.data, 'base64');
  if (packed.encoding !== 'gzip-base64' || bytes.length > 48 * 1024 || sha(bytes) !== packed.sha256) throw new Error('Resource chunk digest/size mismatch.');
  const raw = zlib.gunzipSync(bytes, { maxOutputLength: 256 * 1024 }), rows = JSON.parse(raw);
  if (raw.length !== packed.rawBytes || !Array.isArray(rows) || rows.length !== packed.rows || rows.length > 650) throw new Error('Resource chunk count mismatch.');
  return rows;
}
function evaluate(summary, rows) {
  assert.deepStrictEqual(summary.protocol, PROTOCOL, 'Actual approved duration/protocol required.');
  if (summary.modelRun) throw new Error('Accelerated model cannot be a real resource receipt.');
  let previous = null, gap = 0, rss = 0, managed = 0, lastCPU = null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 12 || !['setup', 'drag', 'play', 'step', 'load', 'idle'].includes(row[1]) || ![0, 1].includes(row[2])) throw new Error('Invalid resource row.');
    for (const i of [0, 3, 5, 8, 9]) if (!Number.isFinite(row[i]) || row[i] < 0) throw new Error('Invalid numeric resource sample.');
    if (![0, 1].includes(row[10]) || ![0, 1].includes(row[11])) throw new Error('Invalid window-state sample.');
    for (const i of [4, 6, 7]) if (row[i] !== null && (!Number.isFinite(row[i]) || row[i] < 0)) throw new Error('Invalid optional resource sample.');
    if (previous !== null && row[0] < previous || lastCPU !== null && row[5] < lastCPU) throw new Error('Resource time/CPU counter moved backwards.');
    if (previous !== null) gap = Math.max(gap, row[0] - previous);
    previous = row[0]; lastCPU = row[5]; rss = Math.max(rss, row[3]); managed = Math.max(managed, row[4] || 0);
  }
  const trend = trends(rows);
  assert.deepStrictEqual(trend, summary.trend, 'Resource trend mismatch.');
  assert.strictEqual(rows.length, summary.totalSamples); assert.strictEqual(rss, summary.peakRendererRssBytes);
  assert.strictEqual(managed, summary.peakManagedBytes); assert.strictEqual(gap, summary.maxSampleGapMs);
  const durationValid = summary.workElapsedMs >= PROTOCOL.workMs && summary.idleElapsedMs >= PROTOCOL.idleMs &&
    rows.length > 0 && rows[0][0] <= PROTOCOL.sampleMs && rows[rows.length - 1][0] >= PROTOCOL.workMs + PROTOCOL.idleMs - 1000;
  const managedLimit = summary.managedLimitBytes === undefined ? 512 * 1024 ** 2 : summary.managedLimitBytes;
  if (!Number.isSafeInteger(managedLimit) || managedLimit <= 0) throw new Error('Invalid recorded RAM budget.');
  const passed = summary.complete && !summary.error && durationValid && trend.passed && rss < 1.5 * 1024 ** 3 && managed <= managedLimit &&
    summary.sourceHashesVerifiedAtEnd && summary.cleanup && summary.cleanup.verified && summary.cleanup.result === 'closed' && !summary.cleanup.error && summary.cleanup.state === 'closed' && summary.cleanup.disposedBudgetBytes === 0;
  assert.strictEqual(!!passed, summary.resourceGatePassed, 'Saved resource gate does not match independent recomputation.');
  return { passed: !!passed, durationValid, trend, samples: rows.length, maxSampleGapMs: gap,
    peakRendererRssBytes: rss, peakManagedBytes: managed, managedLimitBytes: managedLimit, workElapsedMs: summary.workElapsedMs, idleElapsedMs: summary.idleElapsedMs };
}
function audit(runId) {
  if (!runPattern.test(runId)) throw new Error('An explicit T2 resource run ID is required.');
  const root = path.join(repo, 'verification-runs'), directory = path.join(root, runId);
  for (const target of [root, directory]) { const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target).toLowerCase() !== target.toLowerCase()) throw new Error('Audit directory boundary changed.'); }
  function read(file) {
    if (path.dirname(file) !== directory) throw new Error('Resource receipt escapes its run.');
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 2 * 1024 ** 2 || fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error('Audit file boundary changed.');
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error('Audit file changed.');
    return { value: JSON.parse(bytes), bytes: bytes.length, sha256: sha(bytes), file };
  }
  const owner = read(path.join(directory, 'owner.json')).value;
  if (owner.owner !== OWNER || owner.root !== root || owner.runId !== runId || owner.kind !== 'evidence') throw new Error('Resource owner mismatch.');
  const token = runId.slice(-20), names = fs.readdirSync(directory).filter(name => new RegExp('^lifecycle-' + token + '-\\d+\\.json$').test(name));
  if (names.length > 100) throw new Error('Too many resource records.');
  const records = names.map(name => read(path.join(directory, name)));
  for (const record of records) {
    const outer = record.value;
    if (outer.schema !== 't2-evidence-v1' || outer.kind !== 'lifecycle' || outer.key !== sha(Buffer.from(canonical(outer.payload))) || outer.payload.stage !== 'T2') throw new Error('Resource envelope invalid.');
    record.payload = outer.payload;
  }
  const summaries = records.filter(record => record.payload.type === 'resource-summary');
  if (summaries.length !== 1) throw new Error('Exactly one resource summary required.');
  const summaryRecord = summaries[0], summary = summaryRecord.payload, rows = [], referenced = new Set();
  for (const [index, reference] of summary.chunks.entries()) {
    const record = records.find(item => item.file === reference.file);
    if (!record || record.bytes !== reference.bytes || record.sha256 !== reference.sha256 || record.payload.index !== index ||
      record.payload.type !== 'resource-chunk' || referenced.has(record.file)) throw new Error('Resource chunk reference mismatch.');
    referenced.add(record.file); rows.push(...unpack(record.payload.samples));
  }
  if (referenced.size !== records.length - 1) throw new Error('Resource chunks missing from summary.');
  const result = evaluate(summary, rows), hashes = summary.launchContext && summary.launchContext.sourceHashes;
  const lists = [entry.SOURCES, entry.SOURCES.filter(name => name !== 'tests/support/window-annotations.cjs')];
  if (!hashes || !lists.some(list => Object.keys(hashes).sort().join('\n') === list.slice().sort().join('\n'))) throw new Error('Resource launch source list invalid.');
  const currentSourceMatches = Object.fromEntries(Object.entries(hashes).map(([name, expected]) => [name, sha(fs.readFileSync(path.join(repo, name))) === expected]));
  return { runId, ...result, summarySha256: summaryRecord.sha256, currentSourceMatches, sources: summary.samples,
    cleanup: summary.cleanup, limitation: 'Saved renderer samples and formal close callback only. Native window destruction, other Eagle/GPU processes, source pixel accuracy and forced host exit are not proven.' };
}
async function main() {
  const ids = process.argv.slice(2);
  if (ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length) throw new Error('Supply one or two distinct explicit resource run IDs.');
  const runs = ids.map(audit), store = createStore(repo); store.start({ reserveBytes: 128 * 1024 });
  try { console.log(JSON.stringify(store.save('audit', { schema: 'window-resource-audit-v1', runs,
    twoRoundRendererGatePassed: runs.length === 2 && runs.every(run => run.passed && Object.values(run.currentSourceMatches).every(Boolean)) &&
      canonical(runs[0].sources) === canonical(runs[1].sources), overallT2Accepted: false }))); }
  finally { store.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { _test: { unpack, evaluate } };
