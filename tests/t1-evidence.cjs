'use strict';
// An in-memory filesystem exercises real writer checks without generating
// evidence/media files as a side effect of the default check command.
const assert = require('assert'), path = require('path'), crypto = require('crypto');
const { createStore, OWNER, LIMITS, _test } = require('./support/t1-evidence.cjs');
const verify = require('../scripts/verify-t1.cjs')._test;
const { buildIndex } = require('../plugin/frame-index.cjs');
const { OWNER: CACHE_OWNER, RECIPE } = require('../plugin/cache.cjs');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const repo = path.resolve(__dirname, '..');
function memoryFS() {
  const entries = new Map(), norm = file => path.resolve(file); let ino = 1;
  function entry(file) { const value = entries.get(norm(file)); if (!value) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return value; }
  function put(file, type, data = Buffer.alloc(0), extra = {}) { entries.set(norm(file), { type, data: Buffer.from(data), ino: ino++, dev: 1, nlink: 1, mtimeMs: 1, ...extra }); }
  const io = {
    existsSync: file => entries.has(norm(file)), realpathSync: file => entry(file).real || norm(file),
    lstatSync(file) { const value = entry(file); return { ...value, size: value.size === undefined ? value.data.length : value.size,
      isSymbolicLink: () => value.type === 'link', isFile: () => value.type === 'file', isDirectory: () => value.type === 'dir' }; },
    mkdirSync(file) { if (io.existsSync(file)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); entry(path.dirname(file)); put(file, 'dir'); },
    writeFileSync(file, data, options) {
      if (!options || options.flag !== 'wx') throw new Error('Test rejects non-exclusive writes.');
      if (io.existsSync(file)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      entry(path.dirname(file)); put(file, 'file', data);
    },
    readFileSync: file => Buffer.from(entry(file).data),
    readdirSync(dir) { entry(dir); return [...entries.keys()].filter(file => path.dirname(file) === norm(dir)).map(file => path.basename(file)); },
    unlinkSync(file) { entry(file); entries.delete(norm(file)); }
  };
  put(path.dirname(repo), 'dir'); put(repo, 'dir');
  return { io, entries, put };
}
const timestamp = '2026-10-12T00:00:00.000Z';
function fixture(token = 'a'.repeat(20)) {
  const mem = memoryFS(), root = path.join(repo, 'verification-runs');
  return { ...mem, root, store: createStore(repo, { fs: mem.io, token, timestamp }) };
}
let count = 0;
async function test(name, run) { await run(); count++; console.log('T1 evidence: ' + name); }
async function main() {
  await test('exact total quota and overflow are distinguished', () => {
    assert.equal(_test.budget(LIMITS.totalBytes - 1, 1), LIMITS.totalBytes);
    assert.throws(() => _test.budget(LIMITS.totalBytes, 1), /16MiB/);
    assert.throws(() => _test.budget(-1, -1), /16MiB/);
    assert.throws(() => _test.encode({ oversized: 'x'.repeat(LIMITS.fileBytes) }), /2MiB/);
  });
  await test('save requires original lock; records are unique and preserved', () => {
    const f = fixture(); assert.throws(() => f.store.save('checks', {}), /lock/);
    f.store.start({ reserveBytes: 1024 });
    const one = f.store.save('host', { passed: false }), two = f.store.save('host', { passed: true });
    assert.notEqual(one.file, two.file); assert.equal(one.sha256, sha(f.io.readFileSync(one.file)));
    assert(f.store.close()); assert(f.io.existsSync(one.file)); assert(f.io.existsSync(two.file)); assert(!f.io.existsSync(path.join(f.root, 't1-writer.lock')));
    assert.throws(() => f.store.save('media', {}), /lock/);
  });
  await test('concurrent process cannot acquire or remove another writer', () => {
    const f = fixture(); f.store.start();
    const other = createStore(repo, { fs: f.io, token: 'b'.repeat(20), timestamp });
    assert.throws(() => other.start(), /EEXIST/); assert.equal(other.close(), false);
    f.store.save('checks', { passed: true }); f.store.close();
    other.start(); other.close();
  });
  await test('new owner and full reservation fit before any experiment output', () => {
    const f = fixture(), oldId = 't1-2026-10-11T00-00-00-000Z-' + 'c'.repeat(20), dir = path.join(f.root, oldId);
    f.put(f.root, 'dir'); f.put(dir, 'dir');
    f.put(path.join(dir, 'owner.json'), 'file', JSON.stringify({ schema: 1, owner: OWNER, kind: 'evidence', root: f.root, runId: oldId }));
    for (let i = 0; i < 7; i++) f.put(path.join(dir, 'host-' + 'c'.repeat(20) + '-' + i + '.json'), 'file', '{}', { size: LIMITS.fileBytes });
    assert.throws(() => f.store.start(), /16MiB/);
    assert(!f.io.existsSync(path.join(f.root, 't1-writer.lock')));
    assert.equal(f.io.readdirSync(f.root).length, 1);
  });
  await test('reservation cannot be exceeded across multiple small receipts', () => {
    const f = fixture(); f.store.start({ reserveBytes: 4 }); f.store.save('host', {}); f.store.save('host', {});
    assert.throws(() => f.store.save('host', {}), /reserved/); f.store.close();
  });
  await test('unknown T1 paths and unknown run files are retained and refused', () => {
    const f = fixture(); f.put(f.root, 'dir'); f.put(path.join(f.root, 't1-unknown'), 'dir');
    assert.throws(() => f.store.start(), /Unknown T1/); assert(f.io.existsSync(path.join(f.root, 't1-unknown')));
    const good = fixture(); good.store.start(); const saved = good.store.save('checks', {}); good.store.close();
    good.put(path.join(path.dirname(saved.file), 'foreign.bin'), 'file');
    const other = createStore(repo, { fs: good.io, token: 'b'.repeat(20), timestamp });
    assert.throws(() => other.start(), /Unknown file/); assert(good.io.existsSync(saved.file));
  });
  await test('T0 files do not consume or receive a T1 quota change', () => {
    const f = fixture(); f.put(f.root, 'dir'); f.put(path.join(f.root, 't0-old'), 'dir'); f.put(path.join(f.root, 't0-old/huge.json'), 'file', '{}', { size: 128 * 1024 ** 2 });
    f.store.start(); f.store.save('media', {}); f.store.close(); assert(f.io.existsSync(path.join(f.root, 't0-old/huge.json')));
  });
  await test('directory links and hardlinked files are refused', () => {
    const f = fixture(); f.put(f.root, 'link'); assert.throws(() => f.store.start(), /without links/);
    const good = fixture(); good.store.start(); const saved = good.store.save('checks', {}); good.store.close();
    good.entries.get(saved.file).nlink = 2;
    const other = createStore(repo, { fs: good.io, token: 'b'.repeat(20), timestamp }); assert.throws(() => other.start(), /single-link/);
  });
  await test('modified lock is not deleted or accepted for save', () => {
    const f = fixture(); f.store.start(); const lock = path.join(f.root, 't1-writer.lock'); f.entries.get(lock).data = Buffer.from('{}');
    assert.throws(() => f.store.save('checks', {}), /lock identity/); assert.throws(() => f.store.close(), /lock identity/); assert(f.io.existsSync(lock));
  });
  await test('migration comparison checks ordinal PTS, complete hashes and audio', () => {
    const row = { id: 0, ptsTicks: '0', file: '000000.jpg', bytes: 3, sha256: sha(Buffer.from('abc')) };
    const indexed = buildIndex([row], { timeBase: [1, 30], lastFrameEndTicks: '1' });
    const info = { owner: CACHE_OWNER, recipe: RECIPE, source: { sha256: 'd'.repeat(64), codec: 'h264', width: 1280, height: 720, hasAudioStream: false },
      width: 1280, height: 720, duration: indexed.videoDuration, frames: indexed.frames, audio: null };
    const old = JSON.parse(JSON.stringify(info));
    verify.compare(info, old, { sha256: info.source.sha256 });
    old.frames[0].sha256 = 'e'.repeat(64); assert.throws(() => verify.compare(info, old, { sha256: info.source.sha256 }), /sha256/);
  });
  await test('actual asset reads use original handle and reject changed bytes', async () => {
    const info = { frames: [{ file: '0.jpg', bytes: 3, sha256: sha(Buffer.from('abc')) }], audio: null };
    const cache = { async readAsset(handle) { assert.strictEqual(handle, info); return Buffer.from('abc'); } };
    const result = await verify.verifyAssets(cache, info, new AbortController().signal); assert.equal(result.count, 1); assert.equal(result.bytes, 3);
    await assert.rejects(verify.verifyAssets({ readAsset: async () => Buffer.from('def') }, info, new AbortController().signal), /hash check/);
    const controller = new AbortController(); controller.abort(); await assert.rejects(verify.verifyAssets(cache, info, controller.signal), /cancelled/);
  });
  console.log('T1 evidence: ' + count + ' pure checks passed; no files/media/Eagle created');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
