'use strict';
// Actual cache module against a memory filesystem. No real files are mutated.
const assert = require('assert'), path = require('path').win32;
const { harness, prepared, SOURCE_SHA } = require('./t1-cache.cjs');
let count = 0;
async function test(name, work) { await work(); count++; console.log('ok T2 inventory: ' + name); }
function unchanged(h) { return JSON.stringify([...h.nodes].map(([file, value]) => [file, value.ino, value.mtimeMs, value.data && value.data.toString('base64')])); }
async function main() {
  await test('absent cache is reported without creating root, locks or output', () => {
    const h = harness(), before = unchanged(h), result = h.cache.inventory();
    assert.strictEqual(result.exists, false); assert.strictEqual(result.usedBytes, 0); assert.strictEqual(result.caches.length, 0);
    assert.strictEqual(result.deletionAuthorized, false); assert.strictEqual(unchanged(h), before); assert.strictEqual(h.deleted.length, 0);
  });
  await test('counts actual metadata/assets/leases, protects all recorded leases without guessing process death', async () => {
    const h = harness(), info = await prepared(h), before = unchanged(h), result = h.cache.inventory();
    const expected = [...h.nodes].filter(([file, value]) => file.startsWith(h.root + '\\') && value.kind === 'file').reduce((n, [, value]) => n + value.data.length, 0);
    assert.strictEqual(result.usedBytes, expected); assert.strictEqual(result.caches.length, 1);
    assert.strictEqual(result.caches[0].sourceSha256, SOURCE_SHA); assert.strictEqual(result.caches[0].protected, true);
    assert.strictEqual(result.caches[0].leaseCount, 1); assert(result.caches[0].lastUsedAt > 0); assert.strictEqual(result.caches[0].useSequence, 1);
    assert.strictEqual(result.leases[0].liveness, 'not-checked'); assert.strictEqual(result.assetHashesVerified, false);
    assert(Object.isFrozen(result) && Object.isFrozen(result.caches[0])); assert.strictEqual(unchanged(h), before);
    h.cache.release(info); const after = h.cache.inventory(); assert.strictEqual(after.caches[0].protected, false); assert.strictEqual(after.leases.length, 0);
  });
  await test('writer present rejects inventory and does not clear the lock', () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), before = unchanged(h);
    assert.throws(() => h.cache.inventory(), error => error.code === 'CACHE_BUSY'); assert.strictEqual(unchanged(h), before); tx.close();
  });
  await test('foreign files, unknown partials, links and hardlinks are retained', async () => {
    for (const kind of ['unknown', 'partial', 'link', 'hardlink']) {
      const h = harness(), info = await prepared(h); h.cache.release(info);
      if (kind === 'unknown') h.make(path.join(h.root, 'notes.txt'), 'file', 'preserve');
      else if (kind === 'partial') h.make(path.join(h.root, 'partial-unknown'), 'dir');
      else { const asset = h.nodes.get(path.join(info.cacheDir, '000000.jpg')); if (kind === 'link') asset.kind = 'link'; else asset.nlink = 2; }
      const before = unchanged(h), deleted = h.deleted.length;
      assert.throws(() => h.cache.inventory()); assert.strictEqual(unchanged(h), before); assert.strictEqual(h.deleted.length, deleted);
    }
  });
  await test('invalid lease source or target cannot report an unprotected cache', async () => {
    for (const field of ['sourceSha256', 'cacheDir']) {
      const h = harness(), info = await prepared(h), marker = h.nodes.get(path.join(h.root, 'lease-' + info.leaseId + '.json'));
      const value = JSON.parse(marker.data); value[field] = field === 'cacheDir' ? 'G:\\foreign-cache' : 'b'.repeat(64); marker.data = Buffer.from(JSON.stringify(value));
      const before = unchanged(h); assert.throws(() => h.cache.inventory()); assert.strictEqual(unchanged(h), before);
    }
  });
  await test('over-budget inventory is a refusal rather than an eviction', async () => {
    const h = harness(), info = await prepared(h); h.cache.release(info);
    const smaller = h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin', diskBytes: 300 }), before = unchanged(h), deleted = h.deleted.length;
    assert.throws(() => smaller.inventory(), /预算/); assert.strictEqual(unchanged(h), before); assert.strictEqual(h.deleted.length, deleted);
  });
  await test('file mutation during scan invalidates snapshot without modifying cache', async () => {
    const h = harness(), info = await prepared(h); h.cache.release(info); const asset = h.nodes.get(path.join(info.cacheDir, '000000.jpg'));
    let changed = false; h.state.afterOpen = ({ file, flags }) => { if (!changed && flags === 'r' && file === path.join(info.cacheDir, 'manifest.json')) { changed = true; asset.data = Buffer.from('length changed externally'); asset.mtimeMs++; } };
    const deleted = h.deleted.length; assert.throws(() => h.cache.inventory()); assert(changed); assert.strictEqual(h.deleted.length, deleted);
  });
  await test('writer appearing during final recheck invalidates snapshot and remains untouched', async () => {
    const h = harness(), info = await prepared(h); h.cache.release(info);
    // Inject a concurrent writer after the first root listing, before final listing.
    let inserted = false;
    h.state.afterOpen = ({ file }) => { if (!inserted && file === path.join(info.cacheDir, 'manifest.json')) { inserted = true; h.make(path.join(h.root, 'writer.lock'), 'file', 'external writer'); } };
    assert.throws(() => h.cache.inventory(), /根已变化/); assert(inserted);
    assert(h.nodes.has(path.join(h.root, 'writer.lock')));
  });
  console.log('T2 inventory: ' + count + ' memory checks passed; no media, host, real cache cleanup or crash recovery executed.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
