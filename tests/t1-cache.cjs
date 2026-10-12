'use strict';

// All cache mutation uses a VM-injected, in-memory Windows filesystem. The
// only actual filesystem reads are this source and production module sources.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const win = path.win32;
const crypto = require('crypto');
const sourceCode = fs.readFileSync(path.join(__dirname, '../plugin/cache.cjs'), 'utf8');
const moduleRequire = require('module').createRequire(path.join(__dirname, '../plugin/cache.cjs'));
const SOURCE_SHA = 'a'.repeat(64);
let count = 0;
function memoryFileSystem() {
  const nodes = new Map(), descriptors = new Map(), deleted = []; let inode = 10, fdNext = 100, tick = 1;
  const state = { shortWrite: Infinity, shortRead: Infinity, zeroWrite: false, failRename: false,
    writesUntilError: Infinity, afterWrite: null, afterOpen: null, readOpens: [] };
  const normal = file => win.resolve(file);
  function error(code) { const value = new Error(code); value.code = code; throw value; }
  function nodeFor(file) { const value = nodes.get(normal(file)); if (!value) error('ENOENT'); return value; }
  function make(dir, kind, data) {
    const file = normal(dir); if (nodes.has(file)) error('EEXIST');
    if (win.dirname(file) !== file && !nodes.has(win.dirname(file))) error('ENOENT');
    const value = { kind, data: Buffer.from(data || ''), ino: ++inode, dev: 1, nlink: 1, mtimeMs: ++tick };
    nodes.set(file, value); return value;
  }
  function stat(value) { return { ino: value.ino, dev: value.dev, nlink: value.nlink,
    mtimeMs: value.mtimeMs, size: value.kind === 'file' ? value.data.length : 0,
    isFile: () => value.kind === 'file', isDirectory: () => value.kind === 'dir', isSymbolicLink: () => value.kind === 'link' }; }
  function descriptor(fd) { const value = descriptors.get(fd); if (!value) error('EBADF'); return value; }
  nodes.set('D:\\', { kind: 'dir', ino: ++inode, dev: 1, nlink: 1, mtimeMs: ++tick });
  make('D:\\fixtures', 'dir'); make('D:\\fixtures\\plugin', 'dir');
  const api = {
    existsSync(file) { return nodes.has(normal(file)); },
    lstatSync(file) { return stat(nodeFor(file)); },
    realpathSync(file) { const value = nodeFor(file); return value.real || normal(file); },
    readdirSync(dir) { if (nodeFor(dir).kind !== 'dir') error('ENOTDIR'); return [...nodes.keys()].filter(file => file !== normal(dir) && win.dirname(file) === normal(dir)).map(file => win.basename(file)); },
    mkdirSync(dir) { make(dir, 'dir'); },
    writeFileSync(file, data, options = {}) {
      const flag = options.flag || 'w', fd = api.openSync(file, flag);
      try { const value = descriptor(fd).node; value.data = Buffer.from(data); value.mtimeMs = ++tick; } finally { api.closeSync(fd); }
    },
    readFileSync(file, encoding) { const value = typeof file === 'number' ? descriptor(file).node : nodeFor(file); const data = Buffer.from(value.data); return encoding ? data.toString(encoding) : data; },
    openSync(file, flags) {
      const absolute = normal(file); let value = nodes.get(absolute);
      if (flags.includes('x')) { if (value) error('EEXIST'); value = make(file, 'file'); }
      else if (!value && flags.includes('w')) value = make(file, 'file');
      else if (!value) error('ENOENT');
      if (value.kind !== 'file') error('EINVAL');
      if (flags === 'w') { value.data = Buffer.alloc(0); value.mtimeMs = ++tick; }
      if (flags === 'r') state.readOpens.push(absolute);
      const id = ++fdNext; descriptors.set(id, { node: value, file: absolute });
      if (state.afterOpen) state.afterOpen({ node: value, file: absolute, flags });
      return id;
    },
    closeSync(fd) { if (!descriptors.delete(fd)) error('EBADF'); },
    fstatSync(fd) { return stat(descriptor(fd).node); },
    writeSync(fd, data, offset, length, position) {
      const value = descriptor(fd).node;
      if (state.zeroWrite) return 0;
      if (state.writesUntilError-- <= 0) error('EIO');
      const n = Math.min(length, state.shortWrite), size = Math.max(value.data.length, position + n), next = Buffer.alloc(size);
      value.data.copy(next); data.copy(next, position, offset, offset + n); value.data = next; value.mtimeMs = ++tick;
      if (state.afterWrite) state.afterWrite({ node: value, file: descriptor(fd).file });
      return n;
    },
    readSync(fd, data, offset, length, position) {
      const value = descriptor(fd).node, n = Math.max(0, Math.min(length, state.shortRead, value.data.length - position));
      value.data.copy(data, offset, position, position + n); return n;
    },
    ftruncateSync(fd, size) { const value = descriptor(fd).node, next = Buffer.alloc(size); value.data.copy(next); value.data = next; value.mtimeMs = ++tick; },
    renameSync(from, to) {
      if (state.failRename) error('EACCES');
      const a = normal(from), b = normal(to); if (nodes.has(b)) error('EEXIST'); nodeFor(a);
      for (const [file, value] of [...nodes]) if (file === a || file.startsWith(a + '\\')) { nodes.delete(file); nodes.set(b + file.slice(a.length), value); }
    },
    unlinkSync(file) { const value = nodeFor(file); if (value.kind === 'dir') error('EISDIR'); nodes.delete(normal(file)); deleted.push(normal(file)); },
    rmdirSync(file) { if (api.readdirSync(file).length) error('ENOTEMPTY'); nodes.delete(normal(file)); deleted.push(normal(file)); }
  };
  api.promises = { async open(file, flags) {
    const id = api.openSync(file, flags);
    return { async stat() { return api.fstatSync(id); }, async read(data, offset, length, position) { return { bytesRead: api.readSync(id, data, offset, length, position) }; }, async close() { api.closeSync(id); } };
  } };
  return { api, nodes, state, descriptors, deleted, normal, make };
}
function harness(options = {}) {
  const memory = memoryFileSystem(), module = { exports: {} };
  vm.runInNewContext(sourceCode, { module, exports: module.exports,
    require: name => name === 'fs' ? memory.api : name === 'path' ? win : moduleRequire(name),
    Buffer, process: { pid: 4242, platform: 'win32' }, console }, { filename: 'plugin/cache.cjs' });
  const api = module.exports;
  const cache = api.createCache({ pluginRoot: 'D:\\fixtures\\plugin', ...options });
  return { ...memory, api, cache, root: cache.root };
}
function snapshot(id = 'item-1') {
  return { sha256: SOURCE_SHA, codec: 'h264', width: 1920, height: 1080, hasAudioStream: false,
    itemId: id, id, libraryEpoch: 'library-1', name: '中文 空格', filePath: 'G:\\素材库\\中文 空格.mp4' };
}
function manifest(asset) {
  return { source: snapshot(), width: 1280, height: 720, duration: 1,
    frames: [{ ...asset, id: 0, ptsTicks: '0', timeBase: [1, 30], time: 0, end: 1 }], audio: null, metrics: { reused: false } };
}
async function prepared(h) {
  const tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
  assert.strictEqual(await tx.readComplete(), null);
  const asset = await tx.writeAsset('000000.jpg', Buffer.from('frame-data'));
  const info = await tx.finish(manifest(asset), snapshot()); tx.close(); return info;
}
async function test(name, body) { await body(); count++; console.log('ok T1 cache: ' + name); }
async function main() {
  await test('cache is lazy, non-C and isolated from T0', async () => {
    const h = harness(); assert.strictEqual(h.cache.root, 'D:\\fixtures\\plugin\\cache'); assert(!h.api.OWNER.includes('T0'));
    assert(!h.api.RECIPE.includes('T0')); assert(!h.api.OWNER.includes('S1')); assert.strictEqual(h.api.LIMITS.cacheBytes, 5 * 1024 ** 3);
    assert(!h.nodes.has(h.root)); assert.throws(() => h.api.createCache({ pluginRoot: 'C:\\plugin' }), /C盘/);
    assert.throws(() => h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin', diskBytes: 5 * 1024 ** 3 + 1 }));
    assert.strictEqual(h.deleted.length, 0);
  });
  await test('complete publish creates lease before writer release and binds current source only in memory', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
    const asset = await tx.writeAsset('000000.jpg', Buffer.from('frame-data')), info = await tx.finish(manifest(asset), snapshot());
    assert(h.nodes.has(win.join(h.root, 'writer.lock'))); assert(h.nodes.has(win.join(h.root, 'lease-' + info.leaseId + '.json')));
    assert.strictEqual(info.source.itemId, 'item-1');
    const persisted = JSON.parse(h.nodes.get(win.join(info.cacheDir, 'manifest.json')).data.toString());
    assert.strictEqual(persisted.source.sha256, SOURCE_SHA); assert(!('itemId' in persisted.source)); assert(!('filePath' in persisted.source));
    tx.close(); assert.strictEqual((await h.cache.readAsset(info, '000000.jpg')).toString(), 'frame-data');
    assert.strictEqual(h.cache.release(info), true); assert.strictEqual(h.cache.release(info), false);
    await assert.rejects(() => h.cache.readAsset(info, '000000.jpg'), /原始有效句柄/);
  });
  await test('cloned and foreign handles cannot read or release registered cache', async () => {
    const h = harness(), info = await prepared(h), clone = { ...info };
    await assert.rejects(() => h.cache.readAsset(clone, '000000.jpg'), /原始有效句柄/); assert.strictEqual(h.cache.release(clone), false);
    const other = h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin' });
    await assert.rejects(() => other.readAsset(info, '000000.jpg'), /原始有效句柄/);
    info.frames[0].file = 'unregistered.jpg'; await assert.rejects(() => h.cache.readAsset(info, 'unregistered.jpg'), /资产表/);
    assert.strictEqual((await h.cache.readAsset(info, '000000.jpg')).toString(), 'frame-data'); h.cache.release(info);
  });
  await test('same content can rebind another item without granting authority to a copied reuse candidate', async () => {
    const h = harness(), old = await prepared(h), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), candidate = await tx.readComplete();
    await assert.rejects(() => tx.finish({ ...candidate }, snapshot('item-2')), /原始清单/);
    candidate.metrics = { ...candidate.metrics, reused: true }; const next = await tx.finish(candidate, snapshot('item-2')); tx.close();
    assert.strictEqual(old.source.itemId, 'item-1'); assert.strictEqual(next.source.itemId, 'item-2'); assert.strictEqual(next.metrics.reused, true);
    h.cache.release(old); h.cache.release(next);
  });
  await test('formal manifest accepts more than 2000 frames within byte budgets', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), frames = [], frameCount = 2101;
    for (let id = 0; id < frameCount; id++) {
      const asset = await tx.writeAsset(String(id).padStart(6, '0') + '.jpg', Buffer.from([id & 255]));
      frames.push({ ...asset, id, ptsTicks: String(id), timeBase: [1, 120], time: id / 120, end: (id + 1) / 120 });
    }
    const info = await tx.finish({ ...manifest(frames[0]), frames, duration: frameCount / 120 }, snapshot()); tx.close();
    assert.strictEqual(info.frames.length, frameCount); assert.strictEqual((await h.cache.readAsset(info, '002100.jpg'))[0], 2100 & 255);
    h.cache.release(info); assert.strictEqual(h.descriptors.size, 0);
  });
  await test('reused manifest asset mutation cannot extend read capabilities', async () => {
    const h = harness(), info = await prepared(h), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), candidate = await tx.readComplete();
    candidate.frames[0].file = 'elsewhere.jpg'; await assert.rejects(() => tx.finish(candidate, snapshot()), /原始清单/);
    tx.close(); h.cache.release(info);
  });
  await test('invalid reuse metrics do not create an unregistered lease', async () => {
    const h = harness(), old = await prepared(h), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), candidate = await tx.readComplete();
    const leasesBefore = [...h.nodes.keys()].filter(file => /^lease-/.test(win.basename(file))).length;
    candidate.metrics = {}; candidate.metrics.self = candidate.metrics;
    await assert.rejects(() => tx.finish(candidate, snapshot('item-2')));
    assert.strictEqual([...h.nodes.keys()].filter(file => /^lease-/.test(win.basename(file))).length, leasesBefore);
    candidate.metrics = { reused: true }; const next = await tx.finish(candidate, snapshot('item-2')); tx.close();
    h.cache.release(old); h.cache.release(next);
  });
  await test('serial partial append handles short writes, bounded header reads and non-growing patch', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); h.state.shortWrite = 2; h.state.shortRead = 2;
    const stream = tx.openAsset('audio.wav'); stream.append(Buffer.from('abcdef')); stream.append(Buffer.from('gh'));
    assert.strictEqual(stream.readPrefix(4).toString(), 'abcd'); assert.throws(() => stream.readPrefix(4097), /4096/);
    stream.patch(1, Buffer.from('XYZ')); assert.throws(() => stream.patch(7, Buffer.from('xx')), /扩展/);
    const asset = await stream.close(); assert.strictEqual(asset.bytes, 8);
    assert.strictEqual(asset.sha256, crypto.createHash('sha256').update('aXYZefgh').digest('hex'));
    assert.strictEqual(await stream.close(), asset); assert.throws(() => stream.append(Buffer.from('late')), /关闭/);
    assert.strictEqual(tx.abort(), true); tx.close(); assert.strictEqual(h.descriptors.size, 0);
  });
  await test('output and writer cannot be released while a stream is still open', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), stream = tx.openAsset('000000.jpg'); stream.append(Buffer.from('x'));
    assert.throws(() => tx.abort(), /仍未退出/); assert.throws(() => tx.close(), /仍未关闭/);
    await assert.rejects(() => tx.finish(manifest({ file: '000000.jpg', bytes: 1, sha256: 'b'.repeat(64) }), snapshot()), /真正关闭/);
    await stream.close(); tx.abort(); tx.close(); assert.strictEqual(h.descriptors.size, 0);
  });
  await test('cancelled transaction still closes streams and removes only its own registered partial', async () => {
    const h = harness(), controller = new AbortController(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA, signal: controller.signal });
    const stream = tx.openAsset('000000.jpg'); stream.append(Buffer.from('data')); controller.abort();
    assert.throws(() => stream.append(Buffer.from('later')), error => error.name === 'AbortError'); await stream.close();
    assert.strictEqual(tx.abort(), true); tx.close(); assert.deepStrictEqual([...h.nodes.keys()].filter(file => win.dirname(file) === h.root), [win.join(h.root, 'owner.json')]);
    assert.strictEqual(h.descriptors.size, 0);
  });
  await test('disk capacity refusal occurs before growing an asset and without deleting history', async () => {
    const h = harness({ diskBytes: 1600 }), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), stream = tx.openAsset('000000.jpg');
    assert.throws(() => stream.append(Buffer.alloc(1600)), /容量不足/);
    const asset = await stream.close(); assert.strictEqual(asset.bytes, 0); tx.abort(); tx.close();
    const tooSmall = harness({ diskBytes: 300 }); assert.throws(() => tooSmall.cache.begin({ sourceSha256: SOURCE_SHA }), /预算|容量/);
    assert(!tooSmall.nodes.has(win.join(tooSmall.root, 'writer.lock'))); assert.strictEqual(tooSmall.descriptors.size, 0);
  });
  await test('same-process and unknown cross-process writers are refused without stale-lock recovery', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
    assert.throws(() => h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin' }).begin({ sourceSha256: SOURCE_SHA }), /已有准备事务/); tx.close();
    const lock = win.join(h.root, 'writer.lock'); h.make(lock, 'file', '{"unknown":true}'); const before = h.nodes.get(lock).data.toString();
    assert.throws(() => h.cache.begin({ sourceSha256: SOURCE_SHA }), error => error.code === 'CACHE_BUSY'); assert.strictEqual(h.nodes.get(lock).data.toString(), before);
  });
  await test('unknown root files block writes but are never deleted', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); tx.close();
    const unknown = win.join(h.root, 'unregistered.txt'); h.make(unknown, 'file', 'do not touch');
    assert.throws(() => h.cache.begin({ sourceSha256: SOURCE_SHA }), /未知文件/); assert(h.nodes.has(unknown)); assert(!h.deleted.includes(unknown));
    assert(!h.nodes.has(win.join(h.root, 'writer.lock')));
  });
  await test('unknown partial files prevent every deletion, including known assets', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); await tx.writeAsset('000000.jpg', Buffer.from('data'));
    const partial = [...h.nodes.keys()].find(file => win.basename(file).startsWith('partial-')), unknown = win.join(partial, 'unknown.txt');
    h.make(unknown, 'file', 'preserve'); const deletedAt = h.deleted.length;
    assert.throws(() => tx.abort(), /未知文件/); assert.strictEqual(h.deleted.length, deletedAt); assert(h.nodes.has(win.join(partial, '000000.jpg'))); tx.close();
    assert.throws(() => h.cache.begin({ sourceSha256: SOURCE_SHA }), /未完成缓存/);
  });
  await test('traversal, reserved names, duplicate assets and source mismatch cannot publish', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
    for (const name of ['../a', 'a/b', 'a\\b', 'C:bad', 'file:bad', 'CON.jpg', 'nul', 'a.', 'owner.json', 'manifest.json'])
      await assert.rejects(() => tx.writeAsset(name, Buffer.from('x')));
    const asset = await tx.writeAsset('000000.jpg', Buffer.from('data')); await assert.rejects(() => tx.writeAsset('000000.jpg', Buffer.from('new')));
    await assert.rejects(() => tx.finish(manifest(asset), { ...snapshot(), sha256: 'b'.repeat(64) }), /绑定/);
    const bad = manifest(asset); bad.frames.push({ ...bad.frames[0], id: 1, time: 0, end: 1 });
    await assert.rejects(() => tx.finish(bad, snapshot())); tx.abort(); tx.close();
  });
  await test('links and hard links cannot be read or cleaned as generated assets', async () => {
    const h = harness(), info = await prepared(h), file = win.join(info.cacheDir, '000000.jpg'), node = h.nodes.get(file);
    node.kind = 'link'; await assert.rejects(() => h.cache.readAsset(info, '000000.jpg'), /普通文件/); node.kind = 'file'; node.nlink = 2;
    await assert.rejects(() => h.cache.readAsset(info, '000000.jpg'), /普通文件/); node.nlink = 1; h.cache.release(info);
    h.nodes.get('D:\\fixtures\\plugin').real = 'E:\\outside'; assert.throws(() => h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin' }), /链接/);
  });
  await test('same-length corruption fails both asset reads and complete reuse', async () => {
    const h = harness(), info = await prepared(h), file = win.join(info.cacheDir, '000000.jpg'); h.nodes.get(file).data[0] ^= 1;
    await assert.rejects(() => h.cache.readAsset(info, '000000.jpg'), /已改变/);
    const tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); await assert.rejects(() => tx.readComplete(), /指纹不符/); tx.close();
    assert(h.nodes.has(file)); h.cache.release(info);
  });
  await test('lease marker tampering prevents deletion and cloned handles still lack permission', async () => {
    const h = harness(), info = await prepared(h), marker = win.join(h.root, 'lease-' + info.leaseId + '.json'); h.nodes.get(marker).data[0] ^= 1;
    assert.throws(() => h.cache.release(info), /身份已改变/); assert(h.nodes.has(marker)); assert.strictEqual(h.cache.release({ ...info }), false);
  });
  await test('zero-byte write is an error and its own empty partial remains safely abortable', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), stream = tx.openAsset('000000.jpg'); h.state.zeroWrite = true;
    assert.throws(() => stream.append(Buffer.from('data')), /写入未完整/); h.state.zeroWrite = false; await stream.close(); tx.abort(); tx.close();
    assert.strictEqual(h.descriptors.size, 0);
  });
  await test('publish failure keeps the original input untouched and aborts only this registered partial', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), asset = await tx.writeAsset('000000.jpg', Buffer.from('data'));
    h.state.failRename = true; await assert.rejects(() => tx.finish(manifest(asset), snapshot()), /EACCES/);
    assert.strictEqual(tx.abort(), true); tx.close(); assert.strictEqual(h.descriptors.size, 0);
    assert(h.deleted.every(file => file.startsWith(h.root + '\\')));
  });
  await test('abort refuses a replaced inode before deleting any sibling', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); await tx.writeAsset('000000.jpg', Buffer.from('data'));
    const partial = [...h.nodes.keys()].find(file => win.basename(file).startsWith('partial-')), file = win.join(partial, '000000.jpg');
    h.nodes.get(file).ino += 100; const before = h.deleted.length; assert.throws(() => tx.abort(), /身份或长度/); assert.strictEqual(h.deleted.length, before); tx.close();
  });
  await test('one-shot short writes close before returning and commit independently reads disk', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); h.state.shortWrite = 2;
    const asset = await tx.writeAsset('000000.jpg', Buffer.from('frame-data'));
    assert.strictEqual(asset.bytes, 10); assert.strictEqual(asset.sha256, crypto.createHash('sha256').update('frame-data').digest('hex'));
    assert.strictEqual(h.descriptors.size, 0);
    assert.strictEqual(h.state.readOpens.filter(file => file.endsWith('.jpg')).length, 0);
    const info = await tx.finish(manifest(asset), snapshot()); tx.close();
    assert(h.state.readOpens.some(file => file.endsWith('.jpg')));
    h.cache.release(info); assert.strictEqual(h.descriptors.size, 0);
  });
  await test('one-shot zero write and mid-buffer error leave exact partial safely abortable', async () => {
    for (const partialFailure of [false, true]) {
      const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
      h.state.zeroWrite = !partialFailure; h.state.shortWrite = 2; h.state.writesUntilError = partialFailure ? 1 : Infinity;
      await assert.rejects(() => tx.writeAsset('000000.jpg', Buffer.from('frame-data')), /写入未完整|EIO/);
      h.state.zeroWrite = false; h.state.writesUntilError = Infinity;
      assert.strictEqual(h.descriptors.size, 0); assert.strictEqual(tx.abort(), true); tx.close();
      assert.deepStrictEqual([...h.nodes.keys()].filter(file => win.dirname(file) === h.root), [win.join(h.root, 'owner.json')]);
    }
  });
  await test('one-shot capacity refusal closes its empty asset before any growth', async () => {
    const h = harness({ diskBytes: 1600 }), tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
    await assert.rejects(() => tx.writeAsset('000000.jpg', Buffer.alloc(1600)), /容量不足/);
    const jpeg = [...h.nodes].find(([file]) => file.endsWith('.jpg'));
    assert(jpeg); assert.strictEqual(jpeg[1].data.length, 0); assert.strictEqual(h.descriptors.size, 0);
    tx.abort(); tx.close();
  });
  await test('one-shot same-length disk corruption is rejected by commit rather than published', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
    h.state.afterWrite = ({ node, file }) => { if (file.endsWith('.jpg')) node.data[0] ^= 1; };
    const asset = await tx.writeAsset('000000.jpg', Buffer.from('frame-data')); h.state.afterWrite = null;
    assert.strictEqual(asset.sha256, crypto.createHash('sha256').update('frame-data').digest('hex'));
    await assert.rejects(() => tx.finish(manifest(asset), snapshot()), /提交前缓存资产发生变化/);
    assert(![...h.nodes.keys()].some(file => /^media-/.test(win.basename(file))));
    tx.abort(); tx.close(); assert.strictEqual(h.descriptors.size, 0);
  });
  await test('one-shot inode or hardlink mutation closes fd and refuses cleanup of unknown identity', async () => {
    for (const mutation of ['inode', 'hardlink']) {
      const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA });
      h.state.afterWrite = ({ node, file }) => { if (file.endsWith('.jpg')) { if (mutation === 'inode') node.ino += 100; else node.nlink = 2; } };
      await assert.rejects(() => tx.writeAsset('000000.jpg', Buffer.from('frame-data')), /输出身份|普通文件/);
      h.state.afterWrite = null; assert.strictEqual(h.descriptors.size, 0); const deletedAt = h.deleted.length;
      assert.throws(() => tx.abort(), /身份或长度|普通文件/); assert.strictEqual(h.deleted.length, deletedAt); tx.close();
    }
  });
  await test('one-shot cancellation after writing closes fd and cleans only registered partial', async () => {
    const h = harness(), controller = new AbortController(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA, signal: controller.signal });
    h.state.afterWrite = ({ file }) => { if (file.endsWith('.jpg')) controller.abort(); };
    await assert.rejects(() => tx.writeAsset('000000.jpg', Buffer.from('frame-data')), error => error.name === 'AbortError');
    h.state.afterWrite = null; assert.strictEqual(h.descriptors.size, 0); tx.abort(); tx.close();
    assert.deepStrictEqual([...h.nodes.keys()].filter(file => win.dirname(file) === h.root), [win.join(h.root, 'owner.json')]);
  });
  await test('one-shot rejects changed root, partial paths and writer token before next write', async () => {
    for (const change of ['root', 'partial', 'lock-token', 'lock-inode']) {
      const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); await tx.writeAsset('000000.jpg', Buffer.from('frame-data'));
      const partial = [...h.nodes.keys()].find(file => win.basename(file).startsWith('partial-')), lock = h.nodes.get(win.join(h.root, 'writer.lock'));
      const lockData = Buffer.from(lock.data), lockIno = lock.ino;
      if (change === 'root') h.nodes.get(h.root).real = 'E:\\outside';
      if (change === 'partial') h.nodes.get(partial).real = 'E:\\outside';
      if (change === 'lock-token') { const value = JSON.parse(lock.data); value.token = 'unknown'; lock.data = Buffer.from(JSON.stringify(value)); }
      if (change === 'lock-inode') lock.ino += 100;
      const nodeCount = h.nodes.size; await assert.rejects(() => tx.writeAsset('000001.jpg', Buffer.from('late')), /链接|所有权|写锁身份/);
      assert.strictEqual(h.nodes.size, nodeCount); assert.strictEqual(h.descriptors.size, 0);
      delete h.nodes.get(h.root).real; delete h.nodes.get(partial).real; lock.data = lockData; lock.ino = lockIno;
      tx.abort(); tx.close();
    }
  });
  await test('usage includes actual owner and manifest bytes at the exact capacity boundary', async () => {
    const h = harness(), info = await prepared(h); h.cache.release(info);
    const observedBytes = [...h.nodes].filter(([file, node]) => file.startsWith(h.root + '\\') && node.kind === 'file').reduce((sum, [, node]) => sum + node.data.length, 0);
    const probe = h.cache.begin({ sourceSha256: SOURCE_SHA }), writerBytes = h.nodes.get(win.join(h.root, 'writer.lock')).data.length; probe.close();
    const exact = h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin', diskBytes: observedBytes + writerBytes });
    const accepted = exact.begin({ sourceSha256: SOURCE_SHA }); accepted.close();
    const short = h.api.createCache({ pluginRoot: 'D:\\fixtures\\plugin', diskBytes: observedBytes + writerBytes - 1 });
    assert.throws(() => short.begin({ sourceSha256: SOURCE_SHA }), /预算|容量/);
    assert(!h.nodes.has(win.join(h.root, 'writer.lock'))); assert(h.nodes.has(win.join(info.cacheDir, 'manifest.json'))); assert.strictEqual(h.descriptors.size, 0);
  });
  await test('reusing the prechecked lock stat still rejects an inode changed at open', async () => {
    const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), lock = h.nodes.get(win.join(h.root, 'writer.lock')), originalIno = lock.ino;
    h.state.afterOpen = ({ node, file, flags }) => { if (file.endsWith('writer.lock') && flags === 'r') node.ino += 100; };
    await assert.rejects(() => tx.writeAsset('000000.jpg', Buffer.from('data')), /元数据身份已改变/);
    h.state.afterOpen = null; lock.ino = originalIno; assert.strictEqual(h.descriptors.size, 0); tx.close();
  });
  await test('root and partial owner changes are not hidden by same-segment directory reuse', async () => {
    for (const kind of ['root', 'partial']) {
      const h = harness(), tx = h.cache.begin({ sourceSha256: SOURCE_SHA }); await tx.writeAsset('000000.jpg', Buffer.from('data'));
      const partial = [...h.nodes.keys()].find(file => win.basename(file).startsWith('partial-'));
      const marker = h.nodes.get(win.join(kind === 'root' ? h.root : partial, 'owner.json')), original = Buffer.from(marker.data), value = JSON.parse(marker.data);
      if (kind === 'root') value.owner = 'foreign-owner'; else value.token = 'foreign-token';
      marker.data = Buffer.from(JSON.stringify(value)); const sizeBefore = h.nodes.size;
      await assert.rejects(() => tx.writeAsset('000001.jpg', Buffer.from('late')), /所有权|事务身份/);
      assert.strictEqual(h.nodes.size, sizeBefore); marker.data = original; tx.abort(); tx.close(); assert.strictEqual(h.descriptors.size, 0);
    }
  });
  await test('complete reuse retains its writer guard after each awaited asset hash', async () => {
    const h = harness(), info = await prepared(h); h.cache.release(info);
    const tx = h.cache.begin({ sourceSha256: SOURCE_SHA }), lock = h.nodes.get(win.join(h.root, 'writer.lock')), original = Buffer.from(lock.data);
    h.state.afterOpen = ({ file, flags }) => {
      if (flags === 'r' && file.endsWith('.jpg')) { const value = JSON.parse(lock.data); value.token = 'foreign-token'; lock.data = Buffer.from(JSON.stringify(value)); }
    };
    await assert.rejects(() => tx.readComplete(), /写锁所有权/);
    h.state.afterOpen = null; lock.data = original; tx.close(); assert.strictEqual(h.descriptors.size, 0);
  });
  console.log('T1 cache: ' + count + ' in-memory safety tests passed; no real cache/media writes.');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
// Share only the in-memory filesystem and fixtures with lifecycle regressions.
module.exports = { harness, prepared, SOURCE_SHA };
