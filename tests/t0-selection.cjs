'use strict';

// Read-only Eagle API mock tests; no source/config/cache/evidence access.
const assert = require('assert');
const path = require('path');
const { captureSelected, validateSnapshot } = require('./support/t0-selection.cjs');
let tests = 0;
async function test(name, body) { await body(); tests++; console.log('ok ' + name); }
const file = path.resolve('中文 空格.mp4');
async function main() {
  await test('Single selection API called immediately exactly once', async () => {
    let calls = 0, resolve;
    const pending = captureSelected({ item: { getSelected() { calls++; return new Promise(done => { resolve = done; }); } } });
    assert.strictEqual(calls, 1); resolve([{ id: 'one', name: '中文 空格', filePath: file, ext: 'MP4' }]);
    const value = await pending; assert.strictEqual(calls, 1); assert.strictEqual(value.id, 'one'); assert.strictEqual(value.filePath, file); assert(Object.isFrozen(value));
  });
  await test('Snapshot is independent from subsequently mutated Eagle Item', async () => {
    const item = { id: 'one', name: 'first', filePath: file, ext: '.mp4' };
    const captured = await captureSelected({ item: { getSelected: () => [item] } });
    item.id = 'two'; item.filePath = path.resolve('other.mp4'); assert.strictEqual(captured.id, 'one'); assert.strictEqual(captured.filePath, file);
  });
  await test('Empty/multiple/API errors reject without a second read', async () => {
    await assert.rejects(captureSelected({}));
    await assert.rejects(captureSelected({ item: { getSelected: () => [] } }));
    await assert.rejects(captureSelected({ item: { getSelected: () => [{}, {}] } }));
    await assert.rejects(captureSelected({ item: { getSelected() { throw new Error('API failure'); } } }), /API failure/);
  });
  await test('Non-MP4, absent ID, relative and NUL paths rejected', () => {
    [{ id: 'one', filePath: path.resolve('x.mkv'), ext: 'mkv' }, { filePath: file },
      { id: 'one', filePath: 'relative.mp4' }, { id: 'one', filePath: file + '\0' }].forEach(value => assert.throws(() => validateSnapshot(value)));
  });
  console.log('T0 selection pure tests passed: ' + tests + '. No Eagle/filesystem mutation.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
