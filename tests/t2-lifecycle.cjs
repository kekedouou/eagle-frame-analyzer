'use strict';
// Capacity and deletion fault injection exercise the actual production cache
// against an in-memory Windows filesystem. Never delete a real cache here.
const assert = require('assert'), path = require('path').win32, crypto = require('crypto');
const { harness } = require('./t1-cache.cjs');
let count = 0;
const hash = n => crypto.createHash('sha256').update(String(n)).digest('hex');
const source = n => ({ sha256: hash(n), codec: 'h264', width: 1920, height: 1080, hasAudioStream: false, itemId: 'item-' + n });
async function publish(h, n, size = 20000) {
  const tx = h.cache.begin({ sourceSha256: hash(n) }), asset = await tx.writeAsset('000000.jpg', Buffer.alloc(size, n));
  const info = await tx.finish({ source: source(n), width: 1280, height: 720, duration: 1,
    frames: [{ ...asset, id: 0, ptsTicks: '0', timeBase: [1, 30], time: 0, end: 1 }], audio: null }, source(n));
  tx.close(); return info;
}
async function reuse(h, n) {
  const tx = h.cache.begin({ sourceSha256: hash(n) }), old = await tx.readComplete(), info = await tx.finish(old, source(n));
  tx.close(); return info;
}
async function three() {
  const h = harness({ diskBytes: 128 * 1024 }); const list = [];
  for (const n of [1, 2, 3]) { const item = await publish(h, n); list.push(item); h.cache.release(item); }
  return { h, list };
}
function results(h) { return [...h.nodes].filter(([name]) => /cleanup-.*\.result\.json$/.test(name)).map(([, n]) => JSON.parse(n.data)); }
async function demand(h) {
  const tx = h.cache.begin({ sourceSha256: hash(4) });
  try { await tx.writeAsset('000000.jpg', Buffer.alloc(56000)); }
  catch (error) { tx.abort(); tx.close(); throw error; }
  tx.abort(); tx.close();
}
async function test(name, work) { await work(); count++; console.log('ok T2 lifecycle: ' + name); }
async function main() {
  await test('manual clear with a large Windows directory ID can be read on next boot', async () => {
    const h = harness(), item = await publish(h, 1); h.cache.release(item);
    const dir = h.nodes.get(item.cacheDir); dir.exactIno = 10977524091718209n; dir.ino = Number(dir.exactIno);
    const cleared = h.cache.clearOther({ sourceSha256: hash(2) }); assert.equal(cleared.cleared, 1);
    const plan = [...h.nodes].find(([file]) => /cleanup-[0-9a-f]{24}\.json$/.test(file));
    assert.equal(JSON.parse(plan[1].data).directoryIdentity[1], '10977524091718209');
    assert(!h.nodes.has(item.cacheDir)); assert.equal(h.reboot().inventory().caches.length, 0);
    const next = h.reboot().begin({ sourceSha256: hash(2) }); next.close();
  });
  for (const action of ['idle', 'capacity', 'damaged', 'orphan']) await test('large directory IDs remain readable after ' + action + ' cleanup', async () => {
    const h = harness({ diskBytes: 128 * 1024 }), at = Date.now() + 1000;
    const first = await publish(h, 1); h.cache.release(first);
    const dir = h.nodes.get(first.cacheDir); dir.exactIno = 10977524091718209n; dir.ino = Number(dir.exactIno);
    if (action === 'idle') {
      const marker = h.nodes.get(path.join(first.cacheDir, 'owner.json')), value = JSON.parse(marker.data);
      marker.data = Buffer.from(JSON.stringify({ ...value, lastUsedAt: at - 86400000 }));
      const tx = h.reboot({ now: () => at }).begin({ sourceSha256: hash(2) }); tx.close();
    } else if (action === 'capacity') {
      for (const n of [2, 3]) h.cache.release(await publish(h, n)); await demand(h);
    } else if (action === 'damaged') {
      h.nodes.get(path.join(first.cacheDir, '000000.jpg')).data[0] ^= 1;
      const tx = h.cache.begin({ sourceSha256: hash(1) }); assert.equal(await tx.readComplete(), null); tx.close();
    } else {
      const tx = h.cache.begin({ sourceSha256: hash(2) }); await tx.writeAsset('000000.jpg', Buffer.from('partial'));
      const partial = [...h.nodes.keys()].find(file => path.basename(file).startsWith('partial-'));
      h.nodes.get(partial).exactIno = 10977524091718209n; h.nodes.get(partial).ino = Number(10977524091718209n);
      const next = h.reboot({ processIdentity: { self: () => ({ pid: 4242, startTicks: '639000000000000001', image: 'D:\\worker.exe' }),
        inspect: () => ({ safe: true }) } }).begin({ sourceSha256: hash(2) }); next.close(); assert(!h.nodes.has(partial));
    }
    for (const [file, node] of h.nodes) if (/cleanup-[0-9a-f]{24}\.json$/.test(file))
      assert(JSON.parse(node.data).directoryIdentity.every(n => typeof n === 'string'));
    h.reboot().inventory(); const next = h.reboot().begin({ sourceSha256: hash(5) }); next.close();
  });
  for (const scenario of ['valid', 'recreated', 'missing-receipt', 'wrong-hash', 'wrong-owner', 'blocked'])
    await test('rounded completed legacy cleanup history: ' + scenario, async () => {
      const h = harness(), first = await publish(h, 1); h.cache.release(first); h.cache.clearOther({ sourceSha256: hash(2) });
      const [file, node] = [...h.nodes].find(([file]) => /cleanup-[0-9a-f]{24}\.json$/.test(file)), plan = JSON.parse(node.data);
      const receiptFile = file.replace('.json', '.result.json'), receipt = h.nodes.get(receiptFile), done = JSON.parse(receipt.data);
      plan.directoryIdentity = [1, Number(10977524091718209n)]; node.data = Buffer.from(JSON.stringify(plan));
      done.planSha256 = scenario === 'wrong-hash' ? 'f'.repeat(64) : crypto.createHash('sha256').update(node.data).digest('hex');
      if (scenario === 'wrong-owner') done.owner = 'unknown';
      if (scenario === 'blocked') { done.status = 'blocked'; done.freedBytes = 0; }
      receipt.data = Buffer.from(JSON.stringify(done)); if (scenario === 'missing-receipt') h.nodes.delete(receiptFile);
      const original = Buffer.from(node.data);
      if (scenario === 'valid' || scenario === 'recreated') {
        if (scenario === 'recreated') h.cache.release(await publish(h, 1));
        h.reboot().inventory(); const next = h.reboot().begin({ sourceSha256: hash(1) }); next.close();
        if (scenario === 'recreated') assert(h.nodes.has(path.join(first.cacheDir, '000000.jpg')), 'Completed history cannot delete a newly created cache at the same path');
      } else assert.throws(() => h.reboot().inventory(), /清理计划路径或文件清单不明/);
      assert(node.data.equals(original), 'Do not rewrite historical plans or fabricate a precise ID');
    });
  await test('interrupted large-ID cleanup refuses a replacement directory even when numeric IDs round equal', async () => {
    const h = harness(), first = await publish(h, 1); h.cache.release(first);
    const dir = h.nodes.get(first.cacheDir); dir.exactIno = 10977524091718209n; dir.ino = Number(dir.exactIno); let removed = false;
    h.state.beforeUnlink = file => { if (path.dirname(file) !== first.cacheDir) return;
      if (!removed) { removed = true; return; } throw new Error('interrupted-cleanup'); };
    assert.throws(() => h.cache.clearOther({ sourceSha256: hash(2) }), /interrupted-cleanup/); h.state.beforeUnlink = null;
    const prior = h.deleted.filter(file => path.dirname(file) === first.cacheDir).length;
    dir.exactIno--; assert.equal(Number(dir.exactIno), dir.ino);
    assert.throws(() => h.reboot().begin({ sourceSha256: hash(2) }), /目录身份已变化/);
    assert.equal(h.deleted.filter(file => path.dirname(file) === first.cacheDir).length, prior);
  });
  await test('one-day expiration uses recorded non-use and protects current/active caches',async()=>{
    const {h,list}=await three(),held=await reuse(h,3),at=Date.now()+1000;
    for(const item of list){const n=h.nodes.get(path.join(item.cacheDir,'owner.json')),v=JSON.parse(n.data);v.lastUsedAt=at-86400000;n.data=Buffer.from(JSON.stringify(v));}
    const tx=h.reboot({now:()=>at}).begin({sourceSha256:hash(2)});assert.equal(tx.cleanup.cleared,1);tx.close();
    assert(!h.nodes.has(list[0].cacheDir));assert(h.nodes.has(list[1].cacheDir));assert(h.nodes.has(list[2].cacheDir));h.cache.release(held);
  });
  await test('recent/future/missing recency is not silently treated as expired',async()=>{
    const {h,list}=await three(),at=Date.now()+1000;
    for(const [i,item] of list.entries()){const n=h.nodes.get(path.join(item.cacheDir,'owner.json')),v=JSON.parse(n.data);
      if(i===0)v.lastUsedAt=at-86400000+1;if(i===1)v.lastUsedAt=at+1000;if(i===2){delete v.lastUsedAt;delete v.useSequence;}n.data=Buffer.from(JSON.stringify(v));}
    const tx=h.reboot({now:()=>at}).begin({sourceSha256:hash(4)});assert.equal(tx.cleanup.cleared,0);tx.close();list.forEach(i=>assert(h.nodes.has(i.cacheDir)));
  });
  await test('explicit other-cache clearing preserves current and every active lease',async()=>{
    const {h,list}=await three(),held=await reuse(h,2);
    const r=h.cache.clearOther({sourceSha256:hash(1)});assert.equal(r.cleared,1);assert(r.freedBytes>20000);
    assert(h.nodes.has(list[0].cacheDir));assert(h.nodes.has(list[1].cacheDir));assert(!h.nodes.has(list[2].cacheDir));h.cache.release(held);
    assert.equal(h.cache.clearOther({sourceSha256:hash(1)}).cleared,1);assert.equal(h.cache.clearOther({sourceSha256:hash(1)}).cleared,0);
  });
  await test('manual clearing cannot delete siblings when any cache contains unknown files',async()=>{
    const {h,list}=await three();h.make(path.join(list[2].cacheDir,'unknown.txt'),'file','protect');
    assert.throws(()=>h.cache.clearOther({sourceSha256:hash(1)}));list.forEach(i=>assert(h.nodes.has(i.cacheDir)));
  });
  await test('persisted recency changes on reuse and is independent of metadata file modification time', async () => {
    const { h, list } = await three(), old = h.cache.inventory().caches.find(c => c.sourceSha256 === hash(1));
    const again = await reuse(h, 1); h.cache.release(again);
    const current = h.cache.inventory().caches.find(c => c.sourceSha256 === hash(1));
    assert(current.useSequence > old.useSequence); assert(current.lastUsedAt >= old.lastUsedAt);
    await demand(h); assert(h.nodes.has(list[0].cacheDir)); assert(!h.nodes.has(list[1].cacheDir)); assert(h.nodes.has(list[2].cacheDir));
    const done = results(h).find(r => r.status === 'completed'); assert(done && done.freedBytes > 20000);
    const planFile = [...h.nodes].find(([name]) => /cleanup-[0-9a-f]{24}\.json$/.test(name));
    assert.strictEqual(done.planSha256, crypto.createHash('sha256').update(planFile[1].data).digest('hex'));
    assert.strictEqual(h.descriptors.size, 0); assert(h.cache.inventory().usedBytes <= 128 * 1024);
  });
  await test('active lease is protected while oldest unoccupied cache is removed', async () => {
    const { h, list } = await three(), held = await reuse(h, 1); await demand(h);
    assert(h.nodes.has(list[0].cacheDir)); assert(!h.nodes.has(list[1].cacheDir)); h.cache.release(held);
    assert(h.deleted.every(file => file.startsWith(h.root + '\\')));
  });
  await test('current validation target is protected before acquiring its lease', async () => {
    const { h, list } = await three(), tx = h.cache.begin({ sourceSha256: hash(1) });
    // Force the internal charge path without claiming a complete-cache
    // candidate as a writable partial. It must preserve its target directory.
    const stream = tx.openAsset('other.jpg'); stream.append(Buffer.alloc(56000)); await stream.close(); tx.abort(); tx.close();
    assert(h.nodes.has(list[0].cacheDir)); assert(!h.nodes.has(list[1].cacheDir));
  });
  await test('all protected capacity refusal saves zero deletion and retains assets', async () => {
    const { h, list } = await three(), held = [];
    for (const n of [1, 2, 3]) held.push(await reuse(h, n));
    await assert.rejects(() => demand(h), /容量不足/); list.forEach(item => assert(h.nodes.has(item.cacheDir)));
    assert(results(h).some(r => r.status === 'blocked' && r.freedBytes === 0)); held.forEach(item => h.cache.release(item));
  });
  await test('unknown target content blocks preflight without removing any existing cache', async () => {
    const { h, list } = await three(); h.make(path.join(list[0].cacheDir, 'unknown.txt'), 'file', 'preserve');
    assert.throws(() => h.cache.begin({ sourceSha256: hash(4) }), /未登记/); list.forEach(item => assert(h.nodes.has(item.cacheDir)));
    assert(!h.deleted.includes(path.join(list[0].cacheDir, '000000.jpg')));
  });
  await test('replaced candidate after plan durability is rejected before first asset deletion', async () => {
    const { h, list } = await three(); let replaced = false;
    h.state.afterWrite = ({ file }) => {
      if (!replaced && /cleanup-[0-9a-f]{24}\.json$/.test(file)) { replaced = true; h.nodes.get(path.join(list[0].cacheDir, '000000.jpg')).ino += 10000; }
    };
    await assert.rejects(() => demand(h), /指纹或身份/); h.state.afterWrite = null;
    assert(replaced); list.forEach(item => assert(h.nodes.has(path.join(item.cacheDir, '000000.jpg'))));
    assert.throws(() => h.cache.inventory(), /未完成/);
  });
  await test('failed plan persistence never deletes candidates', async () => {
    const { h, list } = await three(); const write = h.state.afterWrite;
    h.state.afterWrite = ({ file }) => { if (/cleanup-[0-9a-f]{24}\.json$/.test(file)) throw new Error('injected plan failure'); };
    await assert.rejects(() => demand(h), /injected plan/); h.state.afterWrite = write;
    list.forEach(item => assert(h.nodes.has(path.join(item.cacheDir, '000000.jpg'))));
  });
  await test('tampered recency and linked candidates cannot become eviction authority', async () => {
    for (const mutation of ['recency', 'link', 'hardlink']) {
      const { h, list } = await three(), item = list[0];
      if (mutation === 'recency') {
        const node = h.nodes.get(path.join(item.cacheDir, 'owner.json')), value = JSON.parse(node.data); value.useSequence = 'old'; node.data = Buffer.from(JSON.stringify(value));
        assert.throws(() => h.cache.begin({ sourceSha256: hash(2) }), /最近使用/);
      } else {
        const node = h.nodes.get(path.join(item.cacheDir, '000000.jpg')); if (mutation === 'link') node.kind = 'link'; else node.nlink = 2;
        assert.throws(() => h.cache.begin({ sourceSha256: hash(4) }), /普通文件/);
      }
      assert(h.nodes.has(path.join(item.cacheDir, '000000.jpg')));
    }
  });
  await test('a pending asset read retains its lease until the actual handle closes', async () => {
    const h = harness(), item = await publish(h, 1), read = h.cache.readAsset(item, '000000.jpg');
    assert.throws(() => h.cache.release(item), /读取尚未结束/);
    assert(h.nodes.has(path.join(h.root, 'lease-' + item.leaseId + '.json'))); await read;
    assert.strictEqual(h.cache.release(item), true); assert.strictEqual(h.descriptors.size, 0);
  });
  await test('interrupted deletion resumes only the recorded remaining files under a new writer', async () => {
    const { h, list } = await three(), unlink = h.api;
    // Fault after one asset unlink, before manifest/owner removal. This is
    // filesystem failure, not termination of Eagle or an operating process.
    const original = h.nodes.get(path.join(list[0].cacheDir, 'manifest.json'));
    let failed = false; const oldHook = h.state.afterOpen;
    h.state.afterOpen = ({ file, flags }) => {
      if (!failed && flags === 'r' && file === path.join(list[0].cacheDir, 'manifest.json') &&
        !h.nodes.has(path.join(list[0].cacheDir, '000000.jpg'))) { failed = true; throw new Error('injected unlink interval'); }
    };
    await assert.rejects(() => demand(h), /injected unlink/); h.state.afterOpen = oldHook;
    assert(failed); assert.strictEqual(h.nodes.get(path.join(list[0].cacheDir, 'manifest.json')), original);
    const tx = h.cache.begin({ sourceSha256: hash(1) }); assert.strictEqual(await tx.readComplete(), null); tx.close();
    assert(!h.nodes.has(list[0].cacheDir)); assert(results(h).some(r => r.recovered));
    assert(h.nodes.has(list[1].cacheDir) && h.nodes.has(list[2].cacheDir)); h.cache.inventory();
  });
  await test('normal recency rename failure retains original cache and removes only own temporary marker', async () => {
    const h = harness(), item = await publish(h, 1); h.cache.release(item);
    const old = Buffer.from(h.nodes.get(path.join(item.cacheDir, 'owner.json')).data), tx = h.cache.begin({ sourceSha256: hash(1) });
    const candidate = await tx.readComplete(); h.state.failRename = true;
    await assert.rejects(() => tx.finish(candidate, source(1)), /EACCES/); h.state.failRename = false; tx.close();
    assert(h.nodes.get(path.join(item.cacheDir, 'owner.json')).data.equals(old));
    assert(!h.nodes.has(path.join(item.cacheDir, 'owner.next.json'))); h.cache.inventory();
  });
  await test('known damaged content or length is cleared with receipts before returning regeneration miss', async () => {
    for (const mutation of ['content', 'length']) {
      const h = harness(), item = await publish(h, 1); h.cache.release(item);
      const frame = h.nodes.get(path.join(item.cacheDir, '000000.jpg'));
      if (mutation === 'content') frame.data[0] ^= 1; else frame.data = Buffer.from('truncated');
      const tx = h.cache.begin({ sourceSha256: hash(1) }); assert.strictEqual(await tx.readComplete(), null); tx.close();
      assert(!h.nodes.has(item.cacheDir)); assert(results(h).some(record => record.status === 'completed'));
      const next = await publish(h, 1); h.cache.release(next); assert(h.nodes.has(next.cacheDir)); h.cache.inventory();
    }
  });
  await test('corrupt manifest or unknown content is preserved rather than guessed regenerable', async () => {
    const h = harness(), item = await publish(h, 1); h.cache.release(item);
    h.nodes.get(path.join(item.cacheDir, 'manifest.json')).data = Buffer.from('{broken');
    assert.throws(() => h.cache.begin({ sourceSha256: hash(1) })); assert(h.nodes.has(path.join(item.cacheDir, '000000.jpg')));
  });
  console.log('T2 lifecycle: ' + count + ' model checks passed; no actual cache or Eagle changes.');
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { publish, reuse, three, demand, hash, source, results };
