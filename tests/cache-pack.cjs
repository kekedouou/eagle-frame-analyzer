'use strict';
// Pure in-memory Windows filesystem, not real media or Eagle.
const assert = require('assert'), path = require('path').win32, crypto = require('crypto');
const { harness, prepared, SOURCE_SHA } = require('./t1-cache.cjs');
const layout = require('../plugin/frame-pack.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const source = { sha256: SOURCE_SHA, codec: 'h264', width: 1920, height: 1080, hasAudioStream: false, itemId: 'packed', filePath: 'G:\\原视频.mp4' };
async function packed(h, values = ['first', 'second', 'last'], sourceSha = SOURCE_SHA) {
  const selected = { ...source, sha256: sourceSha };
  const tx = h.cache.begin({ sourceSha256: sourceSha }), frames = [];
  for (let n = 0; n < values.length; n++) {
    const asset = await tx.writeFrame(String(n).padStart(6, '0') + '.jpg', Buffer.from(values[n]));
    frames.push({ ...asset, id: n, ptsTicks: String(n), timeBase: [1, 30], time: n / 30, end: n === values.length - 1 ? 1 : (n + 1) / 30 });
  }
  const framePack = await tx.finishFrames();
  const info = await tx.finish({ source: selected, width: 1280, height: 720, duration: 1, frames, audio: null, framePack }, selected); tx.close(); return info;
}
async function main() {
  let count = 0;
  async function test(name, body) { await body(); count++; console.log('ok ' + name); }
  await test('packed publish retains individual bytes, timestamps and physical accounting', async () => {
    const h = harness({ packFrames: true }), info = await packed(h);
    assert.deepEqual(h.api.RECIPE, info.recipe); assert.equal(info.framePack.bytes, 15);
    assert.deepEqual(h.api.LIMITS.assetBytes, 256 * 1024 ** 2);
    assert.deepEqual(h.cache.inventory().caches[0].assetCount, 1);
    assert.deepEqual(h.api.OWNER, info.owner);
    assert.deepEqual(h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin' }).inventory().caches.length, 1);
    assert.deepEqual(h.nodes.get(path.join(info.cacheDir, layout.FILE)).data.toString(), 'firstsecondlast');
    assert(!h.nodes.has(path.join(info.cacheDir, info.frames[0].file)));
    for (const frame of info.frames) assert.equal(hash(await h.cache.readAsset(info, frame.file)), frame.sha256);
    h.state.shortRead = 2; assert.deepEqual((await h.cache.readFrameBatch(info, info.frames.map(f => f.file))).map(b => b.toString()), ['first', 'second', 'last']);
    assert.equal(h.descriptors.size, 0); h.cache.release(info);
  });
  await test('legacy complete caches remain valid when new writing selects packed layout', async () => {
    const h = harness(), old = await prepared(h); h.cache.release(old);
    const next = h.reboot({ packFrames: true }), tx = next.begin({ sourceSha256: SOURCE_SHA }), candidate = await tx.readComplete();
    assert(!candidate.framePack); const info = await tx.finish(candidate, source); tx.close();
    assert.equal((await next.readAsset(info, info.frames[0].file)).toString(), 'frame-data'); next.release(info);
  });
  await test('offset overlaps, holes, duplicate logical frames and unversioned layouts are refused', async () => {
    const h = harness({ packFrames: true }), info = await packed(h);
    for (const mutate of [v => v.frames[1].offset--, v => v.frames[1].offset++, v => v.frames[1].file = v.frames[0].file,
      v => v.framePack.bytes++, v => v.framePack.schema++, v => v.framePack.extra = true]) {
      const bad = JSON.parse(JSON.stringify(info)); mutate(bad); assert.throws(() => layout.validate(bad, 5 * 1024 ** 3));
    }
    await assert.rejects(h.cache.readFrameBatch(info, [info.frames[0].file, info.frames[2].file]), /连续/);
    await assert.rejects(h.cache.readFrameBatch(info, [info.frames[0].file, info.frames[0].file]), /批次/);
    await assert.rejects(h.cache.readAsset(info, layout.FILE), /资产表/);
    await assert.rejects(h.cache.readFrameBatch({ ...info }, [info.frames[0].file]), /原始有效/); h.cache.release(info);
  });
  await test('batch outputs own separate buffers, so evicting one frame never hides a shared allocation', async () => {
    const h = harness({ packFrames: true }), info = await packed(h), bytes = await h.cache.readFrameBatch(info, info.frames.map(f => f.file));
    assert.equal(bytes[0].length, 5); assert.equal(bytes[1].length, 6); bytes[0][0] = 0; assert.equal(bytes[1].toString(), 'second');
    assert.notStrictEqual(bytes[0].buffer, bytes[1].buffer); assert.equal(bytes[0].buffer.byteLength, bytes[0].length);
    assert.equal((await h.cache.readAsset(info, info.frames[0].file)).toString(), 'first'); h.cache.release(info);
  });
  await test('exact large file IDs and same-size corruption cannot pass packed reads', async () => {
    const h = harness({ packFrames: true }), info = await packed(h), file = path.join(info.cacheDir, layout.FILE), node = h.nodes.get(file);
    node.exactIno = 10977524091718208n;
    h.state.afterOpen = ({ file: opened, flags }) => { if (opened === file && flags === 'r') node.exactIno++; };
    await assert.rejects(h.cache.readAsset(info, info.frames[0].file), /身份/); h.state.afterOpen = null;
    node.data[5] ^= 1; await assert.rejects(h.cache.readFrameBatch(info, info.frames.map(f => f.file)), /指纹/); node.data[5] ^= 1;
    assert.equal(h.descriptors.size, 0); h.cache.release(info);
  });
  await test('cancelled packed streams settle before owned partial cleanup and release', async () => {
    const controller = new AbortController(), h = harness({ packFrames: true }), tx = h.cache.begin({ sourceSha256: SOURCE_SHA, signal: controller.signal });
    await tx.writeFrame('000000.jpg', Buffer.from('jpeg')); controller.abort();
    assert.throws(() => tx.close(), /仍未关闭/); await tx.finishFrames(); assert(tx.abort()); tx.close();
    assert.equal(h.descriptors.size, 0); assert(![...h.nodes.keys()].some(f => /partial-/.test(f)));
  });
  await test('packed content corruption is rejected before publish, not blessed with a new frame hash', async () => {
    const h = harness({ packFrames: true }), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); await tx.writeFrame('000000.jpg', Buffer.from('jpeg'));
    const file = [...h.nodes.keys()].find(f => f.endsWith('frames.pack')); h.nodes.get(file).data[0] ^= 1;
    await assert.rejects(tx.finishFrames(), /实际内容/); assert(tx.abort()); tx.close(); assert.equal(h.descriptors.size, 0);
  });
  await test('in-flight batch holds its lease until real read completion', async () => {
    const h = harness({ packFrames: true }), info = await packed(h), reading = h.cache.readFrameBatch(info, info.frames.map(f => f.file));
    assert.throws(() => h.cache.release(info), /读取尚未结束/); await reading; h.cache.release(info);
    await assert.rejects(h.cache.readFrameBatch(info, [info.frames[0].file]), /原始有效/);
  });
  await test('batch size stops before allocation; individual large frames remain readable', async () => {
    const h = harness({ packFrames: true }), info = await packed(h, [Buffer.alloc(600000, 1), Buffer.alloc(600000, 2)]);
    await assert.rejects(h.cache.readFrameBatch(info, info.frames.map(f => f.file)), /超过1MiB/);
    assert.equal((await h.cache.readAsset(info, info.frames[1].file)).length, 600000); h.cache.release(info);
  });
  await test('remote packed lease reads locally and detaches without deleting worker ownership', async () => {
    const taskOwner = { schema: 'eva-task-owner-v1', key: 'c'.repeat(64), epoch: 'a'.repeat(32), guardPid: 123 };
    const h = harness({ packFrames: true, taskOwner }), info = await packed(h), copy = JSON.parse(JSON.stringify(info));
    const reader = h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin' }); reader.adoptReadLease(copy, taskOwner);
    assert.equal((await reader.readFrameBatch(copy, copy.frames.map(f => f.file)))[2].toString(), 'last');
    assert.throws(() => reader.release(copy), /负责人/); reader.detachReadLease(copy);
    assert(h.nodes.has(path.join(h.root, 'lease-' + info.leaseId + '.json'))); h.cache.release(info);
  });
  await test('damaged packed cache is rejected, removed safely and regenerated on next preparation', async () => {
    const h = harness({ packFrames: true }), info = await packed(h), directory = info.cacheDir;
    h.cache.release(info); h.nodes.get(path.join(directory, layout.FILE)).data[0] ^= 1;
    const tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); assert.equal(await tx.readComplete(), null); tx.close();
    assert(!h.nodes.has(directory)); const replacement = await packed(h); h.cache.release(replacement); assert.equal(h.cache.inventory().caches.length, 1);
  });
  await test('clear other caches uses physical packed files and preserves the active source', async () => {
    const h = harness({ packFrames: true }), active = await packed(h), other = await packed(h, ['other'], 'b'.repeat(64));
    h.cache.release(other); const result = h.cache.clearOther({ sourceSha256: SOURCE_SHA });
    assert.equal(result.cleared, 1); assert(h.nodes.has(active.cacheDir)); assert(!h.nodes.has(other.cacheDir));
    assert.equal((await h.cache.readAsset(active, active.frames[0].file)).toString(), 'first'); h.cache.release(active);
  });
  await test('new owned task recovers a packed partial after verified previous job exit, preserving unknown files', async () => {
    for (const unknown of [false, true]) {
      const owner = epoch => ({ schema: 'eva-task-owner-v1', key: 'c'.repeat(64), epoch: epoch.repeat(32), guardPid: 123 });
      const identity = { self: () => ({ pid: 4242, startTicks: '639000000000000001', image: 'D:\\worker.exe' }),
        child: () => null, inspect: () => ({ safe: true, reason: 'model-owned-job-empty' }) };
      const h = harness({ packFrames: true, taskOwner: owner('a'), processIdentity: identity }), tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
      await tx.writeFrame('000000.jpg', Buffer.from('partial-packed-frame'));
      const partial = [...h.nodes.keys()].find(f => path.basename(f).startsWith('partial-'));
      if (unknown) h.make(path.join(partial, 'foreign.pack'), 'file', Buffer.from('preserve'));
      h.descriptors.clear(); // Model OS closing all handles on process death.
      const next = h.reboot({ taskOwner: owner('b'), processIdentity: identity });
      if (unknown) { assert.throws(() => next.begin({ sourceSha256: SOURCE_SHA }), /未知文件/); assert(h.nodes.has(partial)); }
      else { const replacement = next.begin({ sourceSha256: SOURCE_SHA }); assert(!h.nodes.has(partial)); replacement.close(); }
    }
  });
  await test('legacy ownership ledger also recovers a registered packed partial after confirmed process exit', async () => {
    const identity = { self: () => ({ pid: 4242, startTicks: '639000000000000001', image: 'D:\\worker.exe' }),
      child: () => null, inspect: () => ({ safe: true, reason: 'model-confirmed-process-exit' }) };
    const h = harness({ packFrames: true, processIdentity: identity }), tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
    await tx.writeFrame('000000.jpg', Buffer.from('partial-pack'));
    const partial = [...h.nodes.keys()].find(f => path.basename(f).startsWith('partial-')); h.descriptors.clear();
    const next = h.reboot(), replacement = next.begin({ sourceSha256: SOURCE_SHA }); assert(!h.nodes.has(partial)); replacement.close();
  });
  await test('interrupted cleanup of a pack resumes only its remaining registered files and retains the active cache', async () => {
    const h = harness({ packFrames: true }), active = await packed(h), other = await packed(h, ['other'], 'b'.repeat(64)); h.cache.release(other);
    let removed = false;
    h.state.beforeUnlink = file => { if (path.dirname(file) !== other.cacheDir) return;
      if (!removed) { removed = true; return; } throw Error('model-packed-cleanup-interrupted'); };
    assert.throws(() => h.cache.clearOther({ sourceSha256: SOURCE_SHA }), /model-packed-cleanup-interrupted/);
    h.state.beforeUnlink = null; const tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); tx.close();
    assert(!h.nodes.has(other.cacheDir)); assert(h.nodes.has(active.cacheDir));
    assert.equal((await h.cache.readAsset(active, active.frames[0].file)).toString(), 'first'); h.cache.release(active);
  });
  await test('one-day expiry removes unused packed caches while retaining the current live pack', async () => {
    let at = 1800000000000;
    const h = harness({ packFrames: true, now: () => at }), active = await packed(h), other = await packed(h, ['other'], 'b'.repeat(64)); h.cache.release(other);
    at += 86400001; const tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); assert.equal(tx.cleanup.cleared, 1); tx.close();
    assert(!h.nodes.has(other.cacheDir)); assert(h.nodes.has(active.cacheDir));
    assert.equal((await h.cache.readAsset(active, active.frames[0].file)).toString(), 'first'); h.cache.release(active);
  });
  await test('capacity eviction charges physical pack bytes and drops the oldest unleased pack first', async () => {
    const h = harness({ packFrames: true, diskBytes: 160 * 1024 }), bytes = Buffer.alloc(48 * 1024, 7);
    const first = await packed(h, [bytes]); h.cache.release(first);
    const second = await packed(h, [bytes], 'b'.repeat(64)); h.cache.release(second);
    const current = await packed(h, [bytes], 'c'.repeat(64));
    assert(!h.nodes.has(first.cacheDir)); assert(h.nodes.has(second.cacheDir)); assert(h.nodes.has(current.cacheDir));
    assert(h.cache.inventory().usedBytes <= 160 * 1024); assert.equal((await h.cache.readAsset(current, current.frames[0].file)).length, bytes.length); h.cache.release(current);
  });
  console.log('Packed cache: ' + count + ' pure cases passed; no real files, media or Eagle.');
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { packed, source };
