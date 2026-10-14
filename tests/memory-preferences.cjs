'use strict';
const assert = require('assert'), path = require('path');
const { createMemoryPreferences, memoryValue, OWNER } = require('../plugin/preferences.cjs');
const root = path.resolve('mock memory 中文'), file = path.join(root, 'memory-settings.json'), temp = path.join(root, 'memory-settings.next.json');
function model() {
  const files = new Map(), fds = new Map(); let seq = 1, next = 5;
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const stats = (value, dir = false) => ({ dev: 1, ino: value?.ino || 1, mtimeMs: value?.time || 1, size: value?.data.length || 0,
    nlink: value?.links || 1, isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => !!value?.link });
  const io = { realpathSync: n => n,
    lstatSync(n) { assert([root, file, temp].includes(n)); if (n === root) return stats(null, true); if (!files.has(n)) throw missing(); return stats(files.get(n)); },
    readFileSync(n) { if (!files.has(n)) throw missing(); return Buffer.from(files.get(n).data); },
    openSync(n, flags) { assert.equal(n, temp); assert.equal(flags, 'wx'); if (files.has(n)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const value = { ino: ++seq, time: seq, data: Buffer.alloc(0) }; files.set(n, value); const fd = ++next; fds.set(fd, value); return fd; },
    fstatSync: fd => stats(fds.get(fd)),
    writeFileSync(fd, data) { const value = fds.get(fd); value.data = Buffer.from(data); value.time = ++seq; if (io.onWrite) io.onWrite(); },
    fsyncSync() {}, closeSync(fd) { fds.delete(fd); },
    renameSync(from, to) { if (io.failRename) throw new Error('rename failed'); assert.equal(from, temp); assert.equal(to, file); files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(n) { assert.equal(n, temp); files.delete(n); } };
  const put = (n, data) => files.set(n, { ino: ++seq, time: seq, data: Buffer.from(data) });
  return { io, files, put, create: total => createMemoryPreferences({ pluginRoot: root, io, totalRamBytes: total || 40 * 1024 ** 3 }) };
}
{
  const m = model(), p = m.create(); assert.equal(m.files.size, 0); assert.equal(p.snapshot().ramBytes, 1024 ** 3);
  assert.equal(p.snapshot().percent, 2.5); assert.equal(p.snapshot().compressedRamBytes, 128 * 1024 ** 2);
  p.save(5); assert.equal(p.snapshot().ramBytes, 2 * 1024 ** 3); assert(!m.files.has(temp));
  assert.equal(m.create().snapshot().percent, 5); assert.equal(m.create(32 * 1024 ** 3).snapshot().ramBytes, Math.floor(32 * 1024 ** 3 * .05));
  for (const x of [0, -1, 100.1, NaN, Infinity, '5']) assert.throws(() => p.save(x));
  assert.equal(m.create().snapshot().percent, 5); assert.equal(memoryValue(8 * 1024 ** 3, 100).ramBytes, 8 * 1024 ** 3);
}
{
  const m = model(), p = m.create(); p.save(2.5); const original = Buffer.from(m.files.get(file).data);
  m.io.failRename = true; assert.throws(() => p.save(5), /rename failed/);
  assert(m.files.get(file).data.equals(original)); assert(!m.files.has(temp)); assert.equal(p.snapshot().percent, 2.5);
}
{
  const m = model(), p = m.create(); p.save(2.5);
  m.io.onWrite = () => m.put(file, JSON.stringify({ owner: OWNER, percent: 7 }));
  assert.throws(() => p.save(5), /保存期间改变/); assert.equal(m.create().snapshot().percent, 7); assert(!m.files.has(temp));
}
for (const kind of ['link', 'links', 'large', 'foreign', 'broken']) {
  const m = model(); m.put(file, JSON.stringify({ owner: OWNER, percent: 2.5 })); const item = m.files.get(file);
  if (kind === 'link') item.link = true;
  if (kind === 'links') item.links = 2;
  if (kind === 'large') item.data = Buffer.alloc(4097);
  if (kind === 'foreign') item.data = Buffer.from('{}');
  if (kind === 'broken') item.data = Buffer.from('{');
  assert.throws(() => m.create()); assert.equal(m.files.size, 1);
}
{
  const m = model(), p = m.create(); m.put(temp, 'other writer'); assert.throws(() => p.save(5));
  assert.equal(m.files.get(temp).data.toString(), 'other writer'); assert(!m.files.has(file));
}
console.log('Memory preference models: percentage/default/proportion, persistence/machine change, atomic failure/concurrent change, unsafe file and active-writer protection passed; no actual files written.');
