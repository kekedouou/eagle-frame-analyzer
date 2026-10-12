'use strict';
// Real session + real cache, memory filesystem and selection/player substitutes.
// This checks lifecycle ownership, not Canvas, sound, RSS or the Eagle SDK.
const assert = require('assert');
const { harness } = require('./t1-cache.cjs');
const { hash } = require('./t2-lifecycle.cjs');
const { createSession } = require('../plugin/session.cjs');
function fixture() {
  const h = harness(), players = new Set(); let selection, created = 0, disposed = 0;
  const choose = (n, id = 'item-' + n) => { selection = { id, filePath: 'G:\\中文 素材\\' + id + '.mp4', name: id, ext: 'mp4', n }; };
  choose(1);
  const media = { async prepare(selected, settings) {
    const tx = h.cache.begin({ sourceSha256: hash(selected.n), signal: settings.signal });
    try {
      let info = await tx.readComplete();
      if (!info) {
        const asset = await tx.writeAsset('000000.jpg', Buffer.from('frame-' + selected.n));
        info = { source: { sha256: hash(selected.n), codec: 'h264', width: 1920, height: 1080, hasAudioStream: false },
          width: 1280, height: 720, duration: 1, frames: [{ ...asset, id: 0, time: 0, end: 1, ptsTicks: '0', timeBase: [1, 30] }], audio: null };
      }
      return await tx.finish(info, { ...info.source, ...selected, itemId: selected.id });
    } catch (error) { tx.abort(); throw error; }
    finally { tx.close(); }
  } };
  const session = createSession({ eagleAdapter: { captureSelected: () => Promise.resolve({ ...selection }) }, media, cache: h.cache,
    createPlayer(options) {
      let info, dead = false, state = 'paused'; const pending = new Set(), player = {};
      const snapshot = () => ({ state, frameId: 0, frameOrdinal: 0, time: 0 });
      const update = () => { if (!dead) options.onChange(snapshot()); };
      function read() { const job = options.readAsset(info, '000000.jpg'); pending.add(job); job.finally(() => pending.delete(job)); return job; }
      Object.assign(player, {
        async load(value) { info = value; await read(); update(); }, snapshot,
        async seek() { await read(); update(); return { status: 'displayed' }; },
        async step() { return player.seek(); }, play() { state = 'playing'; update(); }, pause() { state = 'paused'; update(); },
        async dispose() { if (dead) return; dead = true; await Promise.allSettled([...pending]); players.delete(player); disposed++; }
      });
      players.add(player); created++; return player;
    } });
  return { h, choose, session, players, counters: () => ({ created, disposed }) };
}
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('ok T2 session/cache: ' + name); }
async function main() {
  await test('120 rapid captures plus repeated real-cache reuse keep only the newest selected identity', async () => {
    const f = fixture();
    for (let batch = 0; batch < 15; batch++) {
      const jobs = []; for (let i = 0; i < 8; i++) { f.choose(i % 2 + 1, 'copy-' + (i % 2 + 1)); jobs.push(f.session.loadSelected()); }
      const results = await Promise.all(jobs); assert.strictEqual(results[7].status, 'ready', JSON.stringify(results[7]));
      assert.strictEqual(f.session.snapshot().source.id, 'copy-2'); assert.strictEqual(f.players.size, 1);
      assert.strictEqual(f.h.cache.inventory().leases.length, 1);
    }
    await f.session.close(); assert.strictEqual(f.h.cache.inventory().leases.length, 0); assert.strictEqual(f.players.size, 0);
    assert.strictEqual(f.h.descriptors.size, 0); assert.deepStrictEqual(f.counters(), { created: 15, disposed: 15 });
  });
  await test('changing libraries and 64 alternating loads releases every old player and lease without file-count growth', async () => {
    const f = fixture(); let stableFiles;
    for (let i = 0; i < 64; i++) {
      f.choose(i % 2 + 1); assert.strictEqual((await f.session.loadSelected()).status, 'ready');
      await f.session.libraryChanged(); assert.strictEqual(f.session.snapshot().state, 'empty');
      assert.strictEqual(f.players.size, 0); assert.strictEqual(f.h.cache.inventory().leases.length, 0);
      if (i === 1) stableFiles = f.h.nodes.size; if (i > 1) assert.strictEqual(f.h.nodes.size, stableFiles);
    }
    await f.session.close(); assert.strictEqual(f.h.descriptors.size, 0); assert.strictEqual(f.counters().created, f.counters().disposed);
  });
  await test('switch and close wait for actual pending cache reads; copied-content items remain independently bound', async () => {
    const f = fixture(); await f.session.loadSelected(); const pending = f.session.seek(0);
    f.choose(1, 'same-content-other-item'); const changed = await f.session.loadSelected(); await pending;
    assert.strictEqual(changed.status, 'ready'); assert.strictEqual(f.session.snapshot().source.id, 'same-content-other-item');
    assert.strictEqual(f.h.cache.inventory().caches.length, 1);
    const read = f.session.seek(0); await f.session.close(); await read;
    assert.strictEqual(f.players.size, 0); assert.strictEqual(f.h.cache.inventory().leases.length, 0); assert.strictEqual(f.h.descriptors.size, 0);
    assert.strictEqual((await f.session.loadSelected()).status, 'ignored');
  });
  console.log('T2 session/cache: ' + count + ' simulated integration checks passed; not long-run/Eagle acceptance.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
