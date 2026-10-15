'use strict';
// Memory-only regressions: no new host process, file output or Eagle interaction.
const assert = require('assert'), path = require('path').win32;
const { harness, prepared, SOURCE_SHA } = require('./t1-cache.cjs');
const key = 'c'.repeat(64), owner = epoch => ({ schema: 'eva-task-owner-v1', key, epoch: epoch.repeat(32), guardPid: 123 });
const processIdentity = { self: () => ({ pid: 4242, startTicks: '639000000000000001', image: 'D:\\worker.exe' }),
  child: () => null, inspect: () => ({ safe: true, reason: 'test-model-old-owned-job-confirmed-empty' }) };
async function main() {
  {
    const h = harness({ taskOwner: owner('a'), processIdentity }), info = await prepared(h);
    const reader = h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin' }), copy = JSON.parse(JSON.stringify(info));
    reader.adoptReadLease(copy);
    assert.equal((await reader.readAsset(copy, copy.frames[0].file)).toString(), 'frame-data');
    assert.throws(() => reader.release(copy), /负责人/);
    reader.detachReadLease(copy);
    assert(h.nodes.has(path.join(h.root, 'lease-' + info.leaseId + '.json')));
    h.cache.release(info);
  }
  {
    const h = harness({ taskOwner: owner('a'), processIdentity }), info = await prepared(h);
    assert.throws(() => h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin' }).adoptReadLease(JSON.parse(JSON.stringify(info)), owner('b')), /当前任务负责人/);
    h.cache.release(info);
  }
  {
    const h = harness({ taskOwner: owner('a'), processIdentity }), info = await prepared(h), copy = JSON.parse(JSON.stringify(info));
    copy.frames[0].time = 0.1;
    assert.throws(() => h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin' }).adoptReadLease(copy)); h.cache.release(info);
  }
  for (const broken of ['ledger', 'owner', 'unregistered-output', 'missing-owner', 'empty']) {
    const h = harness({ taskOwner: owner('a'), processIdentity });
    const tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
    const before = Buffer.from(h.nodes.get(path.join(h.root, 'writer.lock')).data);
    const child = tx.beforeSpawn(); tx.childStarted(child, 9999);
    assert(before.equals(h.nodes.get(path.join(h.root, 'writer.lock')).data), 'Guarded writer metadata must be immutable across child launch');
    await tx.writeAsset('000000.jpg', Buffer.from('owned-frame'));
    const partial = [...h.nodes.keys()].find(file => path.basename(file).startsWith('partial-'));
    if (broken === 'ledger') h.nodes.get(path.join(partial, 'transaction.log')).data = Buffer.from('{interrupted');
    if (broken === 'owner') h.nodes.get(path.join(partial, 'owner.json')).data = Buffer.from('{interrupted');
    if (broken === 'unregistered-output') h.make(path.join(partial, '000001.jpg'), 'file', Buffer.from('not yet registered'));
    if (broken === 'missing-owner') h.nodes.delete(path.join(partial, 'owner.json'));
    if (broken === 'empty') for (const file of [...h.nodes.keys()]) if (path.dirname(file) === partial) h.nodes.delete(file);
    const next = h.reboot({ taskOwner: owner('b'), processIdentity });
    const replacement = next.begin({ sourceSha256: SOURCE_SHA });
    assert(!h.nodes.has(partial), 'Stopped owned task cannot block the next video: ' + broken);
    replacement.close();
  }
  for (const kind of ['complete', 'partial', 'partial-changed', 'partial-unknown']) {
    const h = harness({ taskOwner: owner('a'), processIdentity });
    let target;
    if (kind === 'complete') { const info = await prepared(h); target = info.cacheDir; h.cache.release(info); }
    else { const tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); await tx.writeAsset('000000.jpg', Buffer.from('owned-frame'));
      target = [...h.nodes.keys()].find(file => path.basename(file).startsWith('partial-')); }
    const lockPath = path.join(h.root, 'writer.lock'); let capturedWriter, removed = false;
    h.state.beforeUnlink = file => {
      if (path.dirname(file) !== target) return;
      if (!removed) { removed = true; return; }
      capturedWriter = Buffer.from(h.nodes.get(lockPath).data); throw new Error('model-process-interrupted-during-cleanup');
    };
    const attempt = h.reboot({ taskOwner: owner('b'), processIdentity });
    assert.throws(() => attempt.begin({ sourceSha256: 'b'.repeat(64), clearOthers: true }), /model-process-interrupted/);
    assert(removed && capturedWriter && h.nodes.has(target)); h.state.beforeUnlink = null;
    // Model abrupt death: the caller's finally could not remove its writer.
    if (!h.nodes.has(lockPath)) h.make(lockPath, 'file', capturedWriter);
    if (kind === 'partial-changed' || kind === 'partial-unknown') {
      if (kind === 'partial-unknown') h.make(path.join(target, 'unknown.txt'), 'file', Buffer.from('preserve'));
      else h.nodes.get([...h.nodes.keys()].find(file => path.dirname(file) === target)).data = Buffer.from('changed');
      const deleted = h.deleted.length;
      assert.throws(() => h.reboot({ taskOwner: owner('c'), processIdentity }).begin({ sourceSha256: 'b'.repeat(64) }), /清理计划与当前文件不符/);
      assert(h.nodes.has(target)); assert.equal(h.deleted.length, deleted, 'Changed or unknown outputs must be preserved'); continue;
    }
    const replacement = h.reboot({ taskOwner: owner('c'), processIdentity }).begin({ sourceSha256: 'b'.repeat(64) });
    assert(!h.nodes.has(target), 'Interrupted ' + kind + ' deletion must resume from its original strict plan'); replacement.close();
  }
  console.log('Task cache: 12 pure ownership/remote-read/interruption regressions passed; no files or processes created.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
