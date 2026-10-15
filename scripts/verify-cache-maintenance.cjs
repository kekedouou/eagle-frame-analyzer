'use strict';
// Explicit real Windows filesystem test. Generated cache bytes are NOT media;
// no Eagle GUI, FFmpeg, library, original or production cache is accessed.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { spawnSync } = require('child_process'), { createCache } = require('../plugin/cache.cjs');
const { publish, reuse, hash } = require('../tests/t2-lifecycle.cjs');
const root = path.resolve(__dirname, '../tests/host/t2/maintenance-scratch');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (process.argv[2] === '--read-child') {
  const cache = createCache({ pluginRoot: root }); const before = cache.inventory();
  const tx = cache.begin({ sourceSha256: hash(2) }); tx.close();
  console.log(JSON.stringify({ caches: before.caches.length, leases: before.leases.length }));
} else main().catch(error => { console.error(error.stack); process.exitCode = 1; });
async function main() {
  assert(process.platform === 'win32' && !/^c:/i.test(root));
  assert(fs.realpathSync(path.dirname(root)) === path.dirname(root));
  if (fs.existsSync(root)) {
    assert(process.argv.includes('--resume-owned'), 'Inspect retained scratch instead of overwriting.');
    assert(fs.realpathSync(root) === root && !fs.lstatSync(root).isSymbolicLink());
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'owner.json')));
    assert(marker.owner === 'eva-cache-maintenance-check-v1' && marker.root === root);
    const recovery = createCache({ pluginRoot: root }).begin({ sourceSha256: hash(2) }); recovery.close();
  } else { fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ owner: 'eva-cache-maintenance-check-v1', root }), { flag: 'wx' }); }
  const boot = options => ({ cache: createCache({ pluginRoot: root, ...options }) });
  const results = []; let current = boot(), retained;
  const childRead = () => {
    const child = spawnSync(process.execPath, [__filename, '--read-child'], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 20000 });
    assert(!child.error && child.status === 0, child.stderr || String(child.error)); return JSON.parse(child.stdout);
  };
  for (let round = 0; round < 3; round++) {
    const present = current.cache.inventory().caches;
    current.cache.release(await (present.some(c => c.sourceSha256 === hash(1)) ? reuse(current, 1) : publish(current, 1, 1024)));
    retained = await (present.some(c => c.sourceSha256 === hash(2)) ? reuse(current, 2) : publish(current, 2, 1024));
    assert.equal(current.cache.clearOther({ sourceSha256: hash(2) }).cleared, 1);
    assert(fs.existsSync(retained.cacheDir)); current.cache.release(retained);
    assert.deepStrictEqual(childRead(), { caches: 1, leases: 0 });
    current = boot(); const reused = await reuse(current, 2); current.cache.release(reused);
  }
  results.push('three-manual-clear-complete-fresh-process-read-and-reuse-cycles');
  const cacheRoot = path.join(root, 'cache'), plans = fs.readdirSync(cacheRoot).filter(n => /^cleanup-[0-9a-f]{24}\.json$/.test(n));
  for (const name of plans) assert(JSON.parse(fs.readFileSync(path.join(cacheRoot, name))).directoryIdentity.every(n => typeof n === 'string'));
  const planPath = path.join(cacheRoot, plans[0]), resultPath = planPath.replace('.json', '.result.json');
  const legacy = JSON.parse(fs.readFileSync(planPath)), receipt = JSON.parse(fs.readFileSync(resultPath));
  legacy.directoryIdentity = [477229185, 10977524091718208];
  fs.writeFileSync(planPath, JSON.stringify(legacy)); receipt.planSha256 = sha(fs.readFileSync(planPath)); fs.writeFileSync(resultPath, JSON.stringify(receipt));
  const before = sha(fs.readFileSync(planPath)); childRead(); assert.equal(sha(fs.readFileSync(planPath)), before);
  results.push('rounded-completed-legacy-plan-read-only-compatibility');
  const frame = path.join(retained.cacheDir, '000000.jpg'), bytes = fs.readFileSync(frame); bytes[0] ^= 1; fs.writeFileSync(frame, bytes);
  const tx = current.cache.begin({ sourceSha256: hash(2) }); assert.equal(await tx.readComplete(), null); tx.close();
  const repaired = await publish(current, 2, 1024); current.cache.release(repaired); childRead(); results.push('damaged-cache-cleanup-regeneration-and-fresh-process-read');
  const inventory = current.cache.inventory(); assert.equal(inventory.leases.length, 0);
  const files = [], dirs = [root];
  function scan(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), stat = fs.lstatSync(file, { bigint: true });
      assert(!stat.isSymbolicLink() && fs.realpathSync(file) === file);
      if (stat.isDirectory()) { assert(file === cacheRoot || dir === cacheRoot && /^media-[0-9a-f]{64}-[0-9a-f]{12}$/.test(name)); dirs.push(file); scan(file); }
      else { assert(stat.isFile() && stat.nlink === 1n && /^(?:owner\.json|manifest\.json|000000\.jpg|(?:cleanup|reap)-[0-9a-f]{24}(?:\.result)?\.json)$/.test(name));
        files.push({ file, ino: stat.ino.toString(), bytes: Number(stat.size), sha256: sha(fs.readFileSync(file)) }); }
    }
  }
  scan(root); const temporaryBytes = files.reduce((n, f) => n + f.bytes, 0); assert(temporaryBytes <= 2 * 1024 ** 2);
  for (const f of files) { const stat = fs.lstatSync(f.file, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.ino.toString() === f.ino && Number(stat.size) === f.bytes && sha(fs.readFileSync(f.file)) === f.sha256); }
  for (const f of files) fs.unlinkSync(f.file);
  for (const dir of dirs.reverse()) fs.rmdirSync(dir);
  console.log(JSON.stringify({ protocol: 'eva-real-cache-maintenance-v1', passed: true, results, temporaryBytes,
    scratchRemoved: !fs.existsSync(root), originalOrProductionCacheAccessed: false, eagleGuiExecuted: false,
    boundary: 'Real Windows disk, fresh Node processes and production cache module; generated cache bytes, no image decoding or Eagle window.' }));
}
