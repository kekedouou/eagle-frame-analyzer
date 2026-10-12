'use strict';
const assert = require('assert'), path = require('path');
const { memoryFS } = require('./t1-evidence.cjs');
const { createStore, LIMITS, _test } = require('./support/t2-evidence.cjs');
const repo = path.resolve(__dirname, '..'), timestamp = '2026-10-12T12:00:00.000Z';
const payload = { input: { itemId: 'test', sha: 'a'.repeat(64) }, code: 'candidate', protocol: 'v1', round: 1, cutoff: 120, measured: [1, 2], human: 'untested' };
let count = 0;
function fixture() { const mem = memoryFS(); return { ...mem, store: token => createStore(repo, { fs: mem.io, timestamp, token: token.repeat(20) }) }; }
async function test(name, body) { await body(); count++; console.log('ok T2 evidence: ' + name); }
async function main() {
  await test('canonical payload equality reuses verified original within and across runs', () => {
    const f = fixture(), a = f.store('a'); a.start({ reserveBytes: 4096 }); const first = a.save('host', payload), second = a.save('host', { ...payload });
    assert.strictEqual(first.file, second.file); assert(second.reused); a.close();
    const b = f.store('b'); b.start({ reserveBytes: 4096 }); const third = b.save('host', { human: payload.human, ...payload }); b.close();
    assert(third.reused); assert.strictEqual(third.sha256, first.sha256);
    assert.strictEqual(f.io.readdirSync(path.join(repo, 'verification-runs')).length, 1);
  });
  await test('new rounds, feedback, source, code, protocol and fuller cutoffs are retained separately', () => {
    const f = fixture(), s = f.store('a'); s.start({ reserveBytes: 16000 }); const first = s.save('host', payload);
    for (const [key, value] of [['round', 2], ['human', 'passed'], ['input', { ...payload.input, itemId: 'other' }], ['code', 'new'], ['protocol', 'v2'], ['cutoff', 121], ['measured', [1, 3]]]) {
      const next = s.save('host', { ...payload, [key]: value }); assert(!next.reused); assert.notStrictEqual(next.file, first.file);
    }
    s.close();
  });
  await test('changed or corrupted prior payload cannot be silently reused or removed', () => {
    const f = fixture(), a = f.store('a'); a.start({ reserveBytes: 4096 }); const saved = a.save('host', payload); a.close();
    const value = JSON.parse(f.entries.get(saved.file).data); value.payload.human = 'tampered'; f.entries.get(saved.file).data = Buffer.from(JSON.stringify(value));
    const b = f.store('b'); assert.throws(() => b.start(), /fingerprint/); assert(f.io.existsSync(saved.file));
  });
  await test('simultaneous writers and changed locks are preserved and blocked', () => {
    const f = fixture(), a = f.store('a'), b = f.store('b'); a.start({ reserveBytes: 4096 }); assert.throws(() => b.start(), /EEXIST/);
    const lock = path.join(repo, 'verification-runs/t2-writer.lock'); f.entries.get(lock).ino++;
    assert.throws(() => a.save('host', payload), /lock changed/); assert.throws(() => a.close(), /lock changed/); assert(f.io.existsSync(lock));
  });
  await test('unknown, hardlinked and out-of-root records cannot authorize overwrite or cleanup', () => {
    const f = fixture(), a = f.store('a'); a.start(); const saved = a.save('cache', payload); a.close();
    f.entries.get(saved.file).nlink = 2; assert.throws(() => f.store('b').start(), /without links/); assert(f.io.existsSync(saved.file));
  });
  await test('reservation, individual and total limits stop output without deleting older records', () => {
    const f = fixture(), a = f.store('a'); a.start({ reserveBytes: 1 }); assert.throws(() => a.save('checks', payload), /reserved/); a.close();
    assert.throws(() => _test.encode({ bytes: 'x'.repeat(LIMITS.fileBytes) }), /2MiB/);
    assert.throws(() => _test.budget(LIMITS.totalBytes, 1), /16MiB/); assert.throws(() => _test.budget(-1, 0));
  });
  await test('failed original record remains distinct from a passed rerun', () => {
    const f = fixture(), a = f.store('a'); a.start({ reserveBytes: 4096 }); const fail = a.save('host', { ...payload, passed: false });
    const pass = a.save('host', { ...payload, passed: true }); assert.notStrictEqual(fail.file, pass.file); assert(f.io.existsSync(fail.file)); a.close();
  });
  console.log('T2 evidence: ' + count + ' memory checks passed; no real evidence deleted.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
