'use strict';

// Read-only Eagle API mock tests; no source/config/cache/evidence access.
const assert = require('assert');
const path = require('path');
const { captureSelected, validateSnapshot, discoverTools, createEagleAdapter } = require('../plugin/eagle.cjs');
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
  await test('Official Item prototype getters are read once without own-field assumptions', async () => {
    const reads = { id: 0, name: 0, filePath: 0, ext: 0 };
    class Item {
      get id() { reads.id++; return 'getter-item'; }
      get name() { reads.name++; return 'getter-name'; }
      get filePath() { reads.filePath++; return file; }
      get ext() { reads.ext++; return 'MP4'; }
    }
    const item = new Item(); assert.strictEqual(Object.keys(item).length, 0);
    const result = await captureSelected({ item: { getSelected: async () => [item] } });
    assert.strictEqual(result.id, 'getter-item'); assert.deepStrictEqual(reads, { id: 1, name: 1, filePath: 1, ext: 1 });
  });
  await test('Array contract works across Node/browser-like realms', async () => {
    const items = require('vm').runInNewContext('[]');
    items.push({ id: 'cross-realm', filePath: file, ext: 'mp4' });
    const result = await captureSelected({ item: { getSelected: () => Promise.resolve(items) } }); assert.strictEqual(result.id, 'cross-realm');
  });
  await test('Unexpected response, empty and multiple have separate typed diagnostics', async () => {
    for (const [value, code, type, count] of [[{ items: [] }, 'SELECTION_RESPONSE_TYPE', 'object', null],
      [null, 'SELECTION_RESPONSE_TYPE', 'null', null], [undefined, 'SELECTION_RESPONSE_TYPE', 'undefined', null],
      [[], 'SELECTION_EMPTY', 'array', 0], [[{}, {}], 'SELECTION_MULTIPLE', 'array', 2]]) {
      const diagnostics = [];
      await assert.rejects(captureSelected({ item: { getSelected: () => value } }, { onDiagnostic: entry => diagnostics.push(entry) }), error => {
        assert.strictEqual(error.code, code); assert.deepStrictEqual(error.diagnostics.response, { type, count });
        assert.strictEqual(error.diagnostics.attempts, 1); assert.strictEqual(error.diagnostics.failureCode, code); return true;
      });
      assert(diagnostics.some(entry => entry.response && entry.response.type === type));
      assert(!JSON.stringify(diagnostics).includes('items')); // Do not dump response contents.
    }
  });
  await test('Synchronous throw and asynchronous rejection remain distinguishable', async () => {
    await assert.rejects(captureSelected({ item: { getSelected() { throw new Error('sync'); } } }), error => error.code === 'SELECTION_API_SYNC_ERROR' && error.diagnostics.stage === 'api-call');
    await assert.rejects(captureSelected({ item: { getSelected: () => Promise.reject(new Error('async')) } }), error => error.code === 'SELECTION_API_ASYNC_ERROR' && error.diagnostics.stage === 'api-await');
  });
  await test('Invalid Item fields and throwing getter have typed failure codes', async () => {
    for (const [value, code] of [[{ id: '', filePath: file }, 'SELECTION_ID_INVALID'],
      [{ id: 'one', filePath: 'relative.mp4' }, 'SELECTION_PATH_INVALID'],
      [{ id: 'one', filePath: file, ext: 'mkv' }, 'SELECTION_NOT_MP4'],
      [Object.defineProperty({}, 'id', { get() { throw new Error('getter'); } }), 'SELECTION_ITEM_ACCESS_ERROR']]) {
      await assert.rejects(captureSelected({ item: { getSelected: () => [value] } }), error => error.code === code && error.diagnostics.response.count === 1);
    }
  });
  await test('Diagnostic observer failure cannot redirect or repeat official API call', async () => {
    let calls = 0;
    const itemApi = { getSelected() { assert.strictEqual(this, itemApi); calls++; return [{ id: 'one', filePath: file }]; } };
    const result = await captureSelected({ item: itemApi }, { onDiagnostic() { throw new Error('observer'); } });
    assert.strictEqual(result.id, 'one'); assert.strictEqual(calls, 1);
  });
  await test('Tool discovery preserves receiver and validates ordinary files for synchronous mock', async () => {
    const paths = { ffmpeg: path.resolve('mock-tools/ffmpeg.exe'), ffprobe: path.resolve('mock-tools/ffprobe.exe') }, seen = [];
    const module = { isInstalled() { assert.strictEqual(this, module); return true; },
      getPaths() { assert.strictEqual(this, module); return paths; }, install() { throw new Error('Must never install'); } };
    const io = { lstatSync(value) { seen.push(value); return { isFile: () => true, isSymbolicLink: () => false }; }, realpathSync: value => value };
    const result = await createEagleAdapter({ extraModule: { ffmpeg: module } }, { fs: io }).discoverTools();
    assert.deepStrictEqual(result, paths); assert(Object.isFrozen(result)); assert.deepStrictEqual(seen, [paths.ffmpeg, paths.ffprobe]);
  });
  await test('Missing tools never call install, paths or filesystem', async () => {
    const module = { isInstalled: () => false, getPaths() { throw new Error('Unexpected paths'); }, install() { throw new Error('Unexpected install'); } };
    const io = new Proxy({}, { get() { throw new Error('Unexpected filesystem'); } });
    await assert.rejects(discoverTools({ extraModule: { ffmpeg: module } }, { fs: io }), error => error.code === 'TOOLS_MISSING');
    await assert.rejects(discoverTools({}), error => error.code === 'TOOLS_API_UNAVAILABLE');
  });
  await test('Unexpected SDK responses and invalid tool paths fail explicitly', async () => {
    const module = { isInstalled: () => Promise.resolve('yes'), getPaths: () => ({}) };
    await assert.rejects(discoverTools({ extraModule: { ffmpeg: module } }), error => error.code === 'TOOLS_RESPONSE_INVALID');
    module.isInstalled = () => true;
    for (const response of [null, [], { ffmpeg: '' }, { ffmpeg: 'relative.exe' }]) {
      module.getPaths = () => response;
      await assert.rejects(discoverTools({ extraModule: { ffmpeg: module } }), error => ['TOOLS_RESPONSE_INVALID', 'TOOLS_PATH_INVALID'].includes(error.code));
    }
  });
  await test('Directories, links and unavailable tools cannot become executable paths', async () => {
    const module = { isInstalled: () => true, getPaths: () => ({ ffmpeg: path.resolve('mock-ffmpeg.exe'), ffprobe: path.resolve('mock-ffprobe.exe') }) };
    for (const io of [{ lstatSync: () => ({ isFile: () => false, isSymbolicLink: () => false }) },
      { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true }) },
      { lstatSync() { throw new Error('missing'); } },
      { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }), realpathSync: () => path.resolve('another.exe') }]) {
      await assert.rejects(discoverTools({ extraModule: { ffmpeg: module } }, { fs: io }), error => error.code === 'TOOLS_FILE_INVALID');
    }
  });
  await test('Actual public asynchronous SDK contract resolves tools and contains IPC rejection', async () => {
    const paths = { ffmpeg: path.resolve('mock-tools/ffmpeg.exe'), ffprobe: path.resolve('mock-tools/ffprobe.exe') };
    const io = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }), realpathSync: value => value };
    const module = { async isInstalled() { assert.strictEqual(this, module); return true; },
      async getPaths() { assert.strictEqual(this, module); return paths; } };
    assert.deepStrictEqual(await discoverTools({ extraModule: { ffmpeg: module } }, { fs: io }), paths);
    module.isInstalled = async () => { throw new Error('IPC status rejected'); };
    await assert.rejects(discoverTools({ extraModule: { ffmpeg: module } }, { fs: io }), error => error.code === 'TOOLS_API_FAILED' && error.message.includes('IPC status rejected'));
    module.isInstalled = async () => true;
    module.getPaths = async () => { throw new Error('IPC paths rejected'); };
    await assert.rejects(discoverTools({ extraModule: { ffmpeg: module } }, { fs: io }), error => error.code === 'TOOLS_API_FAILED' && error.message.includes('IPC paths rejected'));
  });
  console.log('T1 Eagle adapter pure tests passed: ' + tests + '. No real Eagle, tool or filesystem access.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
