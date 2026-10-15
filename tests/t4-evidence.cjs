'use strict';
const assert = require('assert'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { memoryFS } = require('./t1-evidence.cjs');
const { createStore, LIMITS } = require('./support/t4-evidence.cjs');
const repo = path.resolve(__dirname, '..'), root = path.join(repo, 'verification-runs/t4');
function fixture() { const mem = memoryFS(); return { ...mem, store: createStore(repo, { fs: mem.io, runId: 'a'.repeat(32) }) }; }
const f = fixture(); assert.throws(() => f.store.save('host', {}), /active/);
f.store.start({ reserveBytes: 3 * 1024 ** 2 });
const payload = { test: '完整 原始记录', data: [1, 2, 3], failed: true }, receipt = f.store.save('host', payload);
const index = JSON.parse(f.io.readFileSync(receipt.file)), parts = index.type === 'payload' ? [Buffer.from(index.data, 'base64')] : index.parts.map(p => {
  const bytes = f.io.readFileSync(p.file); assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), p.sha256);
  return Buffer.from(JSON.parse(bytes).data, 'base64'); });
assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(Buffer.concat(parts))), payload);
assert.deepStrictEqual(f.store.readReceipt(receipt), payload);
assert.strictEqual(f.store.save('host', payload).file, receipt.file);
const other = createStore(repo, { fs: f.io, runId: 'b'.repeat(32) }); other.start();
const second = other.save('host', payload); assert.notStrictEqual(second.file, receipt.file);
f.store.close(); assert(f.io.existsSync(receipt.file)); assert(!f.io.existsSync(path.join(repo, 'verification-runs/t4-writer.lock')));
assert.throws(() => f.store.save('host', {}), /active/);
const multi = fixture(); multi.store.start();
const bytes = Buffer.alloc(160 * 1024); let seed = 1;
for (let i = 0; i < bytes.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes[i] = seed >>> 24; }
const large = { data: bytes.toString('base64') }, multiReceipt = multi.store.save('audit', large);
assert.strictEqual(JSON.parse(multi.io.readFileSync(multiReceipt.file)).type, 'payload-index');
assert.deepStrictEqual(multi.store.readReceipt(multiReceipt), large);
const fragment = JSON.parse(multi.io.readFileSync(multiReceipt.file)).parts[0].file;
multi.entries.get(fragment).data[5] ^= 1;
assert.throws(() => multi.store.readReceipt(multiReceipt), /digest/);
assert.throws(() => multi.store.save('audit', large), /duplicate changed/);
const crash = fixture(); crash.store.start();
crash.put(path.join(root, 'slot-000'), 'dir'); // Process died before writing.
crash.put(path.join(root, 'slot-001'), 'dir'); crash.put(path.join(root, 'slot-001/record.json'), 'file', '{"interrupted":');
assert(crash.store.save('host', { afterCrash: true }).file.includes('slot-002'));
assert.strictEqual(crash.io.readFileSync(path.join(root, 'slot-001/record.json')).toString(), '{"interrupted":');
const exhausted = fixture(); exhausted.store.start();
for (let i = 0; i < LIMITS.slots; i++) exhausted.put(path.join(root, 'slot-' + String(i).padStart(3, '0')), 'dir');
assert.throws(() => exhausted.store.save('host', {}), /exhausted/);
assert(LIMITS.slots * LIMITS.slotBytes + LIMITS.ownerBytes <= LIMITS.totalBytes);
const unsafe = fixture(); unsafe.store.start(); unsafe.put(path.join(root, 'slot-000'), 'link');
assert.throws(() => unsafe.store.save('host', {}), /boundary/);
const hard = fixture(); hard.store.start(); hard.put(path.join(root, 'slot-000'), 'dir');
hard.put(path.join(root, 'slot-000/record.json'), 'file', '{}', { nlink: 2 }); assert.throws(() => hard.store.save('host', {}), /boundary/);
const old = fixture(); old.put(path.join(repo, 'verification-runs'), 'dir');
old.put(path.join(repo, 'verification-runs/t2-writer.lock'), 'file', 'preserved old record'); old.store.start(); old.store.save('checks', { passed: true });
assert.strictEqual(old.io.readFileSync(path.join(repo, 'verification-runs/t2-writer.lock')).toString(), 'preserved old record');
console.log('T4 evidence models: fixed atomic slots, bounded concurrent allocation, crash remnants preserved without global lock, compressed original roundtrip, old T2 untouched; no actual disk/host writes.');
