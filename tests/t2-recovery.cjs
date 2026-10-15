'use strict';
const assert = require('assert'), path = require('path').win32;
const { harness } = require('./t1-cache.cjs');
const { publish, hash } = require('./t2-lifecycle.cjs');
const { createIdentity } = require('../plugin/process-identity.cjs');
const newParent = { pid: 4242, parentPid: 1, startTicks: '638958000100000000', image: 'D:\\fixtures\\Eagle.exe' };
const oldParent = { ...newParent, startTicks: '638958000000000000' };
const child = { pid: 7000, parentPid: 4242, startTicks: '638958000010000000', image: 'D:\\fixtures\\ffmpeg.exe' };
const provider = rows => createIdentity({ pid: 4242, query: () => rows });
function boot(h, rows = [newParent]) { h.descriptors.clear(); return h.reboot({ processIdentity: provider(rows) }); }
function rootFiles(h) { return JSON.stringify([...h.nodes].filter(([file]) => file.startsWith(h.root)).map(([file, n]) => [file, n.ino, n.data?.toString('base64')])); }
let count = 0;
async function test(name, body) { await body(); count++; console.log('ok T2 recovery: ' + name); }
async function main() {
  await test('process identity is captured before creating an empty writer lock', () => {
    let h;
    h = harness({ processIdentity: { self() {
      assert(!h.nodes.has(path.join(h.root, 'writer.lock')), 'identity lookup must not run while an empty lock is held');
      assert.strictEqual(h.descriptors.size, 0);
      return newParent;
    }, inspect: () => ({ safe: false }) } });
    const tx = h.cache.begin({ sourceSha256: hash(1) }); tx.close(); assert.strictEqual(h.descriptors.size, 0);
  });
  await test('identity exception or cancellation during lookup leaves no writer lock or descriptor', () => {
    for (const mode of ['throw', 'abort']) {
      const controller = new AbortController();
      const h = harness({ processIdentity: { self() {
        if (mode === 'throw') throw new Error('identity unavailable');
        controller.abort(); return newParent;
      }, inspect: () => ({ safe: false }) } });
      assert.throws(() => h.cache.begin({ sourceSha256: hash(1), signal: controller.signal }));
      assert(!h.nodes.has(path.join(h.root, 'writer.lock'))); assert.strictEqual(h.descriptors.size, 0);
    }
  });
  await test('an existing empty unowned writer is retained rather than automatically unlocked', () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: hash(1) }); tx.close();
    const file = path.join(h.root, 'writer.lock'); h.make(file, 'file', '');
    const before = rootFiles(h); assert.throws(() => h.cache.begin({ sourceSha256: hash(1) }), error => error.code === 'CACHE_BUSY');
    assert.strictEqual(rootFiles(h), before); assert(h.nodes.has(file));
  });
  await test('dead registered parent and completed output ledger recover only incomplete owned files', async () => {
    const h = harness(), complete = await publish(h, 1); h.cache.release(complete);
    const tx = h.cache.begin({ sourceSha256: hash(2) }); await tx.writeAsset('000000.jpg', Buffer.from('partial'));
    const partial = [...h.nodes.keys()].find(file => path.basename(file).startsWith('partial-'));
    const cache = boot(h), next = cache.begin({ sourceSha256: hash(2) }); assert.strictEqual(await next.readComplete(), null); next.close();
    assert(!h.nodes.has(partial)); assert(h.nodes.has(complete.cacheDir));
    assert(!h.nodes.has(path.join(h.root, 'recovery.lock'))); assert(!h.nodes.has(path.join(h.root, 'writer.lock')));
    assert(cache.inventory().caches.length === 1); assert(h.deleted.every(file => file.startsWith(h.root + '\\')));
  });
  await test('64-bit NTFS file IDs survive the ledger exactly, while ambiguous legacy numbers are refused', async () => {
    for (const scenario of ['exact', 'legacy-rounded', 'adjacent-exact-id']) {
      const h = harness(), exact = 63894819713321403n;
      h.state.afterOpen = ({ file, node, flags }) => { if (file.endsWith('000000.jpg') && flags === 'wx+') { node.exactIno = exact; node.ino = Number(exact); } };
      const tx = h.cache.begin({ sourceSha256: hash(2) }); await tx.writeAsset('000000.jpg', Buffer.from('owned exact-ID output'));
      const partial = [...h.nodes.keys()].find(file => path.basename(file).startsWith('partial-'));
      const ledger = h.nodes.get(path.join(partial, 'transaction.log')), row = JSON.parse(ledger.data.toString().trim());
      assert.strictEqual(row.ino, exact.toString(), 'A file ID above 2^53 must not be persisted as a rounded JSON number');
      if (scenario === 'legacy-rounded') { row.ino = Number(exact); ledger.data = Buffer.from(JSON.stringify(row)+'\n'); }
      if (scenario === 'adjacent-exact-id') {
        assert.equal(Number(exact), Number(exact-1n));
        h.nodes.get(path.join(partial,'000000.jpg')).exactIno = exact-1n;
      }
      const cache = boot(h);
      if (scenario !== 'exact') { assert.throws(() => cache.begin({ sourceSha256: hash(2) }), /账本|身份/); assert(h.nodes.has(partial)); }
      else { const next = cache.begin({ sourceSha256: hash(2) }); next.close(); assert(!h.nodes.has(partial)); }
    }
  });
  await test('legacy safe numeric ledger IDs remain compatible', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: hash(2) }); await tx.writeAsset('000000.jpg', Buffer.from('legacy safe output'));
    const partial = [...h.nodes.keys()].find(file => path.basename(file).startsWith('partial-'));
    const ledger = h.nodes.get(path.join(partial, 'transaction.log'));
    ledger.data = Buffer.from(ledger.data.toString().trimEnd().split('\n').map(line => {
      const value=JSON.parse(line);return JSON.stringify({...value,dev:Number(value.dev),ino:Number(value.ino)});
    }).join('\n')+'\n');
    const next = boot(h).begin({ sourceSha256: hash(2) }); next.close(); assert(!h.nodes.has(partial));
  });
  await test('live parent, live child or unregistered spawn blocks recovery', async () => {
    for (const scenario of ['parent', 'child', 'starting']) {
      const h = harness(), tx = h.cache.begin({ sourceSha256: hash(2) }); await tx.writeAsset('000000.jpg', Buffer.from('partial'));
      if (scenario !== 'parent') { const token = tx.beforeSpawn(); if (scenario === 'child') tx.childStarted(token, 7000); }
      const before = rootFiles(h), cache = boot(h, scenario === 'parent' ? [oldParent] : scenario === 'child' ? [newParent, child] : [newParent]);
      assert.throws(() => cache.begin({ sourceSha256: hash(2) }), error => error.code === 'CACHE_BUSY'); assert.strictEqual(rootFiles(h), before);
    }
  });
  await test('legacy PID-only writer is retained even when the PID is absent', () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: hash(2) }), node = h.nodes.get(path.join(h.root, 'writer.lock'));
    const value = JSON.parse(node.data); delete value.processIdentity; delete value.children; node.data = Buffer.from(JSON.stringify(value));
    const before = rootFiles(h), cache = boot(h, []); assert.throws(() => cache.begin({ sourceSha256: hash(2) }), e=>e.code==='CACHE_BUSY'); assert.strictEqual(rootFiles(h), before);
  });
  await test('unknown partial file and truncated ledger are preserved before lock deletion', async () => {
    for (const scenario of ['unknown', 'truncated', 'changed-inode']) {
      const h = harness(), tx = h.cache.begin({ sourceSha256: hash(2) }); await tx.writeAsset('000000.jpg', Buffer.from('partial'));
      const partial = [...h.nodes.keys()].find(file => path.basename(file).startsWith('partial-'));
      if (scenario === 'unknown') h.make(path.join(partial, 'foreign.txt'), 'file', 'preserve');
      if (scenario === 'truncated') h.nodes.get(path.join(partial, 'transaction.log')).data = Buffer.from('{unfinished');
      if (scenario === 'changed-inode') h.nodes.get(path.join(partial, '000000.jpg')).ino++;
      const before = rootFiles(h), cache = boot(h); assert.throws(() => cache.begin({ sourceSha256: hash(2) })); assert.strictEqual(rootFiles(h), before);
    }
  });
  await test('orphan lease is reaped without deleting the complete valid cache', async () => {
    const h = harness(), complete = await publish(h, 1), oldLease = path.join(h.root, 'lease-' + complete.leaseId + '.json');
    const cache = boot(h), tx = cache.begin({ sourceSha256: hash(1) }); assert(await tx.readComplete()); tx.close();
    assert(!h.nodes.has(oldLease)); assert(h.nodes.has(complete.cacheDir)); assert.strictEqual(cache.inventory().caches.length, 1);
  });
  await test('live or unknown leases remain protection, never guessed stale', async () => {
    const h = harness(), complete = await publish(h, 1), oldLease = path.join(h.root, 'lease-' + complete.leaseId + '.json');
    const cache = boot(h, [oldParent]), tx = cache.begin({ sourceSha256: hash(2) }); tx.close(); assert(h.nodes.has(oldLease));
    assert.strictEqual(cache.inventory().caches[0].protected, true);
  });
  await test('failed recovery plan save leaves original orphan writer and outputs', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: hash(2) }); await tx.writeAsset('000000.jpg', Buffer.from('partial'));
    h.state.afterWrite = ({ file }) => { if (/reap-[0-9a-f]{24}\.json$/.test(file)) throw new Error('injected reap persistence failure'); };
    const cache = boot(h); assert.throws(() => cache.begin({ sourceSha256: hash(2) }), /injected reap/); h.state.afterWrite = null;
    assert(h.nodes.has(path.join(h.root, 'writer.lock'))); assert([...h.nodes.keys()].some(file => file.endsWith('.jpg')));
    const retry = boot(h), next = retry.begin({ sourceSha256: hash(2) }); next.close(); assert.strictEqual(retry.inventory().caches.length, 0);
  });
  await test('unknown recovery guard is retained and never taken over', () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: hash(2) }); tx.close(); h.make(path.join(h.root, 'recovery.lock'), 'file', 'unknown');
    const before = rootFiles(h), cache = boot(h); assert.throws(() => cache.begin({ sourceSha256: hash(2) }), error => error.code === 'CACHE_BUSY'); assert.strictEqual(rootFiles(h), before);
  });
  await test('writer cannot close while a registered child has not actually closed', () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: hash(2) }), token = tx.beforeSpawn(); tx.childStarted(token, 7000);
    assert.throws(() => tx.close(), /辅助进程仍未关闭/); tx.childClosed(token); tx.close(); assert.strictEqual(h.descriptors.size, 0);
  });
  console.log('T2 recovery: ' + count + ' simulated interruption checks passed; Eagle/OS processes not terminated.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
