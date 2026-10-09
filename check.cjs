// 本地检查不连接 Eagle，不调用标注 API，不生成测试素材。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { pathToFileURL, fileURLToPath } = require('url');
const { execFileSync } = require('child_process');
const h = require('./app.js');
let passed = 0;
function check(name, test) { test(); passed++; console.log(`PASS ${name}`); }

check('JavaScript syntax', () => execFileSync(process.execPath, ['--check', path.join(__dirname, 'app.js')]));
check('Manifest and local entry files', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  assert.equal(m.main.url, 'index.html'); assert.equal(m.main.multiple, false); assert.equal(m.main.runAfterInstall, false);
  for (const name of ['index.html', 'app.js', m.logo.slice(1)]) assert(fs.statSync(path.join(__dirname, name)).isFile());
  const png = fs.readFileSync(path.join(__dirname, 'logo.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
check('HTML script and element references', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert(html.includes('<script src="app.js"></script>'));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of script.matchAll(/\$\('([^']+)'\)/g)) assert(ids.includes(id), `Missing ID: ${id}`);
  for (const name of ['add', 'remove']) assert(new RegExp(`id="${name}" disabled`).test(html));
});
const item = { id: 'TEST-ONLY', ext: 'mp4', filePath: path.resolve(__dirname, '测试目录 有空格', '中文 # 100%.mp4') };
check('Single MP4 accepted', () => { assert.equal(h.oneMP4([item]), item); });
check('No selection / multiple / non-MP4 rejected', () => {
  for (const selection of [[], [item, item], [{ ...item, ext: 'jpg' }], [{ id: 'x', ext: 'mp4' }], null])
    assert.throws(() => h.oneMP4(selection));
});
check('Chinese, spaces, # and % URL round trip', () => {
  const url = h.mediaURL(item); assert.equal(fileURLToPath(url), item.filePath);
  assert(url.includes('%20')); assert(url.includes('%23')); assert(url.includes('%25'));
  assert.equal(h.mediaURL({ ...item, fileURL: pathToFileURL(item.filePath).href }), url);
});
check('Remote and mismatched media URL rejected', () => {
  assert.throws(() => h.mediaURL({ ...item, fileURL: 'https://example.com/test.mp4' }));
  assert.throws(() => h.mediaURL({ ...item, fileURL: pathToFileURL(path.resolve(__dirname, 'other.mp4')).href }));
});
check('Time boundaries including zero', () => {
  assert.equal(h.seconds('0', 10), 0); assert.equal(h.seconds(10, 10), 10); assert.equal(h.seconds('2.345', 10), 2.345);
  for (const value of ['', ' ', null, true, NaN, Infinity, -1, 10.001]) assert.throws(() => h.seconds(value, 10));
  for (const duration of [NaN, Infinity, 0, -1]) assert.throws(() => h.seconds(0, duration));
});
check('Timestamp annotations keep zero and sort; invalid entries retained in source', () => {
  const raw = [{ id: 'b', duration: 5 }, { id: 'a', duration: 0 }, { id: 'rect', x: 1 },
    { duration: '3' }, { duration: -1 }, { duration: NaN }, { duration: 11 }, null];
  assert.deepEqual(h.points(raw, 10).map(c => c.id), ['a', 'b']); assert.equal(raw.length, 8);
  assert.throws(() => h.points(undefined, 10));
});
const proposal = { proposalId: '1234567890abcdef', itemId: item.id, filePath: item.filePath, seconds: 2, annotation: 'POC-A-test' };
const grant = { ...proposal, allowAdd: true, allowRemove: false };
const playback = { paused: true, seeking: false, currentTime: 2, duration: 10 };
check('Exact grant allows preflight; no API is called here', () => h.checkGrant(grant, proposal, item, playback, false));
check('Missing, disabled or mismatched grant rejected', () => {
  for (const bad of [null, {}, { ...grant, allowAdd: false }, { ...grant, itemId: 'other' },
    { ...grant, filePath: 'other' }, { ...grant, seconds: 3 }, { ...grant, annotation: 'other' },
    { ...grant, proposalId: '0000000000000000' }]) assert.throws(() => h.checkGrant(bad, proposal, item, playback, false));
});
check('Switched item and repeated attempt rejected', () => {
  assert.throws(() => h.checkGrant(grant, proposal, { ...item, id: 'other' }, playback, false));
  assert.throws(() => h.checkGrant(grant, proposal, { ...item, filePath: 'other' }, playback, false));
  assert.throws(() => h.checkGrant(grant, proposal, item, playback, true));
});
check('Playing / seeking / moved / invalid playback time rejected', () => {
  for (const change of [{ paused: false }, { seeking: true }, { currentTime: 3 }, { currentTime: NaN }, { duration: 1 }])
    assert.throws(() => h.checkGrant(grant, proposal, item, { ...playback, ...change }, false));
});
check('Default checkout has no write approval', () => assert(!fs.existsSync(path.join(__dirname, 'write-approval.json'))));
// 绕过 disabled 按钮直接触发事件，确认保护存在于实际处理函数中。
// 这是 VM 中的模拟运行，既没有真实 DOM，也没有 Eagle 媒体解码。
async function simulatedReadOnly() {
  const vm = require('vm');
  const elements = new Map(); let startup, libraryChanged, apiWrites = 0, fileWrites = 0;
  class Element {
    constructor() { this.handlers = {}; this.style = {}; this.value = '未检查'; this.children = []; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    append(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    removeAttribute(name) { delete this[name]; }
    pause() { this.paused = true; }
    load() {}
  }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); } };
  const video = document.getElementById('video'); Object.assign(video, playback, { currentTime: 0, readyState: 1 });
  const fakeItem = { ...item, name: '模拟专用素材', comments: [{ id: 'test-comment', duration: 2, annotation: '模拟标注' }],
    addComment() { apiWrites++; throw new Error('未经授权不应到达 API'); }, removeComment() { apiWrites++; } };
  const fakeFS = { ...fs, statSync(name) { return name === item.filePath ? { isFile: () => true, size: 123 } : fs.statSync(name); },
    readFileSync(name, ...args) {
      if (String(name).endsWith('write-approval.json')) { const error = new Error('不存在授权文件'); error.code = 'ENOENT'; throw error; }
      return fs.readFileSync(name, ...args);
    }, writeFileSync() { fileWrites++; throw new Error('模拟只读操作不应写文件'); } };
  const context = { document, location: { href: pathToFileURL(path.join(__dirname, 'index.html')).href }, process, URL,
    require(name) { return name === 'fs' ? fakeFS : require(name); },
    eagle: { onPluginCreate(callback) { startup = callback; }, onLibraryChanged(callback) { libraryChanged = callback; },
      item: { async getSelected() { return [fakeItem]; }, async getById() { return fakeItem; } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), context);
  startup(); await new Promise(setImmediate);
  assert(elements.get('item').textContent.includes(item.id)); assert.equal(elements.get('add').disabled, true);
  assert(elements.get('comments').children.length > 1);
  await elements.get('add').handlers.click(); assert(elements.get('status').textContent.includes('没有与此提案完全匹配'));
  assert.equal(apiWrites, 0); assert.equal(fileWrites, 0);
  libraryChanged(); assert.equal(elements.get('refresh').disabled, true); assert.equal(elements.get('add').disabled, true);
  await elements.get('remove').handlers.click(); assert.equal(apiWrites, 0); assert.equal(fileWrites, 0);
}
simulatedReadOnly().then(() => {
  passed++; console.log('PASS Simulated startup, annotation rendering and direct unauthorized event rejection (not Eagle)');
  console.log(JSON.stringify({ source: 'local-node-and-vm-checks-only', passed, eagleInteractionTested: false, libraryWrites: 0 }));
}).catch(error => { console.error(error); process.exitCode = 1; });
