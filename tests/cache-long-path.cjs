'use strict';
// Memory-only Windows long-path/canonical guard regression, not an Eagle run.
const assert = require('assert'), win = require('path').win32;
const { harness, prepared, SOURCE_SHA } = require('./t1-cache.cjs');
async function main() {
  const extended = '\\\\?\\', longRoot = win.join('D:\\fixtures\\plugin', 'deep'.repeat(42));
  const seen = [];
  const h = harness({}, memory => {
    const original = memory.api.realpathSync;
    memory.api.realpathSync.native = file => {
      seen.push(file);
      if (file.length >= 260 && !file.startsWith(extended)) throw Object.assign(Error('Old Windows native long path refusal'), { code: 'ENOENT' });
      return original(file.startsWith(extended) ? file.slice(extended.length) : file);
    };
    memory.make(longRoot, 'dir');
  });
  const cache = h.reboot({ pluginRoot: longRoot }), info = await prepared({ ...h, cache });
  const owner = win.join(info.cacheDir, 'owner.json'); assert(owner.length > 260);
  assert.equal((await cache.readAsset(info, '000000.jpg')).toString(), 'frame-data');
  assert.equal(cache.inventory().caches.length, 1); cache.release(info);
  const tx = cache.begin({ sourceSha256: SOURCE_SHA }), candidate = await tx.readComplete(); assert(candidate);
  const reused = await tx.finish(candidate, info.source); tx.close();
  assert.equal((await cache.readAsset(reused, '000000.jpg')).toString(), 'frame-data');
  const marker = h.nodes.get(owner); marker.real = win.join('D:\\fixtures', 'foreign-owner.json');
  assert.throws(() => cache.inventory(), /唯一链接|重解析/); delete marker.real;
  marker.nlink = 2; assert.throws(() => cache.inventory(), /唯一链接/); marker.nlink = 1;
  cache.release(reused); assert(seen.some(p => p.startsWith(extended) && p.length > 260));
  assert.equal(h.descriptors.size, 0);
  console.log('Cache long path: publish/reuse/read/inventory with >260-character paths; canonical alias and hardlink protections retained. Memory-only model.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
