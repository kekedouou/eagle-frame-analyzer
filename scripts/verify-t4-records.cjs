'use strict';
// Small real-filesystem check. Only this isolated scratch tree is generated.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert'), { spawn } = require('child_process');
const { createStore } = require('../tests/support/t4-evidence.cjs');
const scratch = path.resolve(__dirname, '../tests/host/t4/evidence-scratch');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (process.argv[2] === 'writer-child') {
  try { const store = createStore(process.argv[3], { runId: process.argv[4] }); store.start();
    console.log(JSON.stringify(store.save('checks', { origin: 'isolated-real-filesystem', runId: process.argv[4] }))); store.close(); }
  catch (e) { console.error(e.stack); process.exitCode = 1; }
} else if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
async function writer(runId) {
  const child = spawn(process.execPath, [__filename, 'writer-child', scratch, runId], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  return await new Promise((resolve, reject) => {
    let out = '', err = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Owned record test child timed out.')); }, 5000);
    child.once('error', reject);
    child.stdout.on('data', b => { out += b; if (Buffer.byteLength(out) > 8192) { child.kill(); reject(new Error('Unexpected record child output.')); } });
    child.stderr.on('data', b => { err = (err + b).slice(-8192); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0) return reject(new Error(err || 'Record child failed.'));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
  });
}
async function main() {
  const workspace = path.resolve(__dirname, '..'), parent = path.dirname(scratch);
  if (!scratch.startsWith(workspace + path.sep) || fs.realpathSync(parent) !== parent || fs.existsSync(scratch)) throw new Error('Record scratch boundary/previous contents invalid.');
  fs.mkdirSync(scratch);
  const base = createStore(scratch, { runId: 'c'.repeat(32) }); base.start(); base.close();
  const phase = path.join(scratch, 'verification-runs/t4'), phaseFile = path.join(phase, 'phase.json');
  const phaseHash = sha(fs.readFileSync(phaseFile));
  const results = await Promise.all([writer('a'.repeat(32)), writer('b'.repeat(32))]);
  assert.notStrictEqual(results[0].file, results[1].file);
  const reader = createStore(scratch);
  for (let i = 0; i < results.length; i++) assert.deepStrictEqual(reader.readReceipt(results[i]),
    { origin: 'isolated-real-filesystem', runId: (i === 0 ? 'a' : 'b').repeat(32) });
  const empty = path.join(phase, 'slot-010'), interrupted = path.join(phase, 'slot-011');
  fs.mkdirSync(empty); fs.mkdirSync(interrupted); fs.writeFileSync(path.join(interrupted, 'record.json'), '{"interrupted":', { flag: 'wx' });
  const next = createStore(scratch); next.start(); const receipt = next.save('audit', { afterInterruptedWriter: true }); next.close();
  assert.deepStrictEqual(reader.readReceipt(receipt), { afterInterruptedWriter: true });
  assert.strictEqual(fs.readFileSync(path.join(interrupted, 'record.json'), 'utf8'), '{"interrupted":');
  assert.strictEqual(sha(fs.readFileSync(phaseFile)), phaseHash);
  const files = [phaseFile, ...results.map(r => r.file), receipt.file, path.join(interrupted, 'record.json')];
  const dirs = [...results.map(r => path.dirname(r.file)), path.dirname(receipt.file), empty, interrupted,
    phase, path.dirname(phase), scratch];
  assert.strictEqual(new Set(files).size, files.length); assert.strictEqual(new Set(dirs).size, dirs.length);
  const identities = files.map(file => {
    const stat = fs.lstatSync(file, { bigint: true }), bytes = fs.readFileSync(file);
    if (!file.startsWith(scratch + path.sep) || fs.realpathSync(file) !== file || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Owned cleanup file invalid.');
    return { file, ino: stat.ino, dev: stat.dev, bytes: bytes.length, sha256: sha(bytes) };
  });
  const totalBytes = identities.reduce((n, f) => n + f.bytes, 0); assert(totalBytes <= 2 * 1024 ** 2);
  for (const dir of dirs) {
    if (dir !== scratch && !path.resolve(dir).startsWith(scratch + path.sep) || fs.realpathSync(dir) !== dir || fs.lstatSync(dir).isSymbolicLink()) throw new Error('Owned cleanup directory invalid.');
  }
  for (const file of identities) {
    const stat = fs.lstatSync(file.file, { bigint: true });
    assert(stat.ino === file.ino && stat.dev === file.dev && sha(fs.readFileSync(file.file)) === file.sha256);
  }
  // No recursive deletion; any unexpected content makes rmdir refuse it.
  for (const file of files) fs.unlinkSync(file);
  for (const dir of dirs.sort((a, b) => b.length - a.length)) fs.rmdirSync(dir);
  console.log(JSON.stringify({ schema: 't4-real-filesystem-record-check-v1', passed: true,
    cases: ['two-process-atomic-distinct-slots', 'cross-process-verified-readback', 'empty-and-truncated-old-slot-retained', 'subsequent-writer-unblocked'],
    generatedBytes: totalBytes, cleanedOwnedScratch: !fs.existsSync(scratch), realStageEvidenceTouched: false,
    productCacheOrLibraryTouched: false, realEagleExecuted: false }));
}
