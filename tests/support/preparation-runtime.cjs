'use strict';
// Test-only runtime and cache boundary. Never points at the normal cache.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const repo = path.resolve(__dirname, '../..'), plugin = path.join(repo, 'plugin');
const ROOT = path.join(repo, 'tests/host/t4/preparation-scratch'), DISK = 240 * 1024 ** 2, TOTAL = 256 * 1024 ** 2;
const SOURCE_ID = 'MV3FZJJ7AC1CI', SOURCE_SHA = '0823a48f0d7b365163297206e8e8c66591c3aa6cf4c30253b3187d19c9644cba';
const FILES = ['task-client.cjs', 'task-worker.cjs', 'cache.cjs', 'frame-pack.cjs', 'frame-index.cjs', 'media.cjs',
  'process-identity.cjs', 'session.cjs', 'eagle.cjs', 'preferences.cjs', 'diagnostics.cjs',
  'native/task-host.cs', 'native/task-host.local.exe', 'native/task-host.local.json'];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function node(file, directory = false) {
  const s = fs.lstatSync(file, { bigint: true });
  if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile() && s.nlink === 1n) ||
      fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw Error('准备计时路径/文件身份异常，保留原件。');
  return { ino: String(s.ino), dev: String(s.dev), bytes: Number(s.size), modified: String(s.mtimeNs) };
}
function read(file, maximum = 1024 ** 2) {
  const before = node(file); if (before.bytes > maximum) throw Error('准备计时记录越界。');
  const bytes = fs.readFileSync(file); if (JSON.stringify(node(file)) !== JSON.stringify(before) || bytes.length !== before.bytes) throw Error('准备计时文件读取时发生变化。');
  return bytes;
}
function source() {
  const file = path.join(repo, 'verification-runs/t4/slot-047/record.json'), bytes = read(file);
  const value = require('./t4-evidence.cjs').createStore(repo).readReceipt({ file, bytes: bytes.length, sha256: sha(bytes) }).source;
  if (value.itemId !== SOURCE_ID || value.sha256 !== SOURCE_SHA || !path.isAbsolute(value.filePath)) throw Error('首次准备固定素材记录不符。');
  return value;
}
function create() {
  node(path.dirname(ROOT), true); node(plugin, true);
  if (fs.existsSync(ROOT)) throw Error('已有准备计时副本；先核对记录，不能覆盖或重复运行。');
  const selected = source(), sourceIdentity = node(selected.filePath), original = {}, copied = {};
  const data = FILES.map(file => {
    const bytes = read(path.join(plugin, file)); original[file] = sha(bytes);
    if (file !== 'task-worker.cjs') return [file, bytes];
    const text = bytes.toString('utf8'), token = 'processIdentity: identity, packFrames: true';
    if (text.split(token).length !== 2) throw Error('当前worker结构不符，未创建测试副本。');
    return [file, Buffer.from(text.replace(token, token + ', diskBytes: 240 * 1024 ** 2'))];
  });
  if (data.reduce((n, [, b]) => n + b.length, 0) > 256 * 1024) throw Error('测试代码副本超过256KiB。');
  fs.mkdirSync(ROOT); fs.mkdirSync(path.join(ROOT, 'native'));
  for (const [file, bytes] of data) { fs.writeFileSync(path.join(ROOT, file), bytes, { flag: 'wx' }); copied[file] = { bytes: bytes.length, sha256: sha(bytes) }; }
  const s = node(ROOT, true), owner = { schema: 'mvp-window-preparation-runtime-v1', root: ROOT, plugin,
    directoryIdentity: { ino: s.ino, dev: s.dev }, nonce: crypto.randomBytes(12).toString('hex'), source: selected, sourceIdentity,
    original, copied, limits: { diskBytes: DISK, totalBytes: TOTAL, ramBytes: 1024 ** 3 } };
  const bytes = Buffer.from(JSON.stringify(owner)); fs.writeFileSync(path.join(ROOT, 'runtime-owner.json'), bytes, { flag: 'wx' });
  return { root: ROOT, ownerSha256: sha(bytes) };
}
function verify(reference) {
  if (!reference || reference.root !== ROOT || !/^[0-9a-f]{64}$/.test(reference.ownerSha256 || '')) throw Error('准备计时副本归属不明。');
  node(path.dirname(ROOT), true); const s = node(ROOT, true), bytes = read(path.join(ROOT, 'runtime-owner.json'));
  if (sha(bytes) !== reference.ownerSha256) throw Error('准备计时副本归属记录已改变。');
  const owner = JSON.parse(bytes);
  if (owner.schema !== 'mvp-window-preparation-runtime-v1' || owner.root !== ROOT || owner.plugin !== plugin ||
      owner.directoryIdentity.ino !== s.ino || owner.directoryIdentity.dev !== s.dev || owner.source.itemId !== SOURCE_ID || owner.source.sha256 !== SOURCE_SHA ||
      JSON.stringify(owner.limits) !== JSON.stringify({ diskBytes: DISK, totalBytes: TOTAL, ramBytes: 1024 ** 3 }) ||
      JSON.stringify(Object.keys(owner.copied).sort()) !== JSON.stringify(FILES.slice().sort()) ||
      JSON.stringify(Object.keys(owner.original).sort()) !== JSON.stringify(FILES.slice().sort())) throw Error('准备计时目录、来源或预算不符。');
  const allowed = new Set(['native', 'cache', 'runtime-owner.json', 'started.json', 'finished.json', ...FILES.filter(n => !n.includes('/'))]);
  if (fs.readdirSync(ROOT).some(n => !allowed.has(n)) || JSON.stringify(fs.readdirSync(path.join(ROOT, 'native')).sort()) !== JSON.stringify(FILES.filter(n => n.startsWith('native/')).map(n => n.slice(7)).sort()))
    throw Error('准备计时副本含未知文件，保留原件。');
  for (const file of FILES) {
    const b = read(path.join(ROOT, file)), original = read(path.join(plugin, file));
    if (b.length !== owner.copied[file].bytes || sha(b) !== owner.copied[file].sha256 || sha(original) !== owner.original[file]) throw Error('准备计时代码已改变，停止本轮。');
    const expected = file === 'task-worker.cjs' ? Buffer.from(original.toString().replace('processIdentity: identity, packFrames: true', 'processIdentity: identity, packFrames: true, diskBytes: 240 * 1024 ** 2')) : original;
    if (!b.equals(expected)) throw Error('准备计时副本包含未声明的变更。');
  }
  if (JSON.stringify(node(owner.source.filePath)) !== JSON.stringify(owner.sourceIdentity)) throw Error('测试原视频身份已改变。');
  require('../../plugin/task-client.cjs').verifyGuard(ROOT); return owner;
}
function unused(reference) {
  const owner = verify(reference);
  if (['started.json', 'finished.json', 'cache'].some(name => fs.existsSync(path.join(ROOT, name))))
    throw Error('本项已启动或已有测试缓存；先核对记录，不自动重测。');
  return owner;
}
function mark(reference, name, value) {
  if (!['started.json', 'finished.json'].includes(name)) throw Error('准备计时标记无效。');
  const owner = name === 'started.json' ? unused(reference) : verify(reference);
  const data = Buffer.from(JSON.stringify({ schema: 'mvp-window-preparation-marker-v1', nonce: owner.nonce, ...value }));
  if (data.length > 16384) throw Error('准备计时标记越界。');
  fs.writeFileSync(path.join(ROOT, name), data, { flag: 'wx' });
}
function clear(reference, store, reason) {
  const owner = verify(reference), cache = require('../../plugin/cache.cjs').createCache({ pluginRoot: ROOT, diskBytes: DISK });
  const inventory = cache.inventory();
  if (inventory.leases.length || inventory.caches.some(c => c.sourceSha256 !== owner.source.sha256) || fs.existsSync(path.join(ROOT, 'cache/writer.lock')))
    throw Error('测试缓存尚有占用或出现其他素材，未清理。');
  const before = store.save('audit', { schema: 'mvp-window-preparation-reset-v1', reason, reference, inventory });
  const result = cache.clearOther({ sourceSha256: '0'.repeat(64) });
  const after = cache.inventory(); if (after.caches.length || after.leases.length) throw Error('测试缓存清理未完成。');
  return { before, result };
}
async function cleanup(reference, store) {
  verify(reference); const cacheRoot = path.join(ROOT, 'cache');
  if (!fs.existsSync(cacheRoot)) return { removed: false, bytes: 0 };
  const cache = require('../../plugin/cache.cjs').createCache({ pluginRoot: ROOT, diskBytes: DISK }), inv = cache.inventory();
  if (inv.caches.length || inv.leases.length || fs.existsSync(path.join(cacheRoot, 'writer.lock'))) throw Error('测试缓存未释放，保留原件。');
  const dir = node(cacheRoot, true), files = [];
  for (const name of fs.readdirSync(cacheRoot)) {
    if (!/^(?:owner|(?:cleanup|reap)-[0-9a-f]{24}(?:\.result)?)\.json$/.test(name)) throw Error('测试清理目录含未知文件。');
    const file = path.join(cacheRoot, name), s = node(file); if (s.bytes > 8 * 1024 ** 2) throw Error('测试清理记录越界。');
    const b = read(file, 8 * 1024 ** 2); files.push({ file, ...s, sha256: sha(b) });
  }
  const bytes = files.reduce((n, f) => n + f.bytes, 0); if (bytes > TOTAL) throw Error('测试清理总量越界。');
  const receipt = store.save('audit', { schema: 'mvp-window-preparation-cleanup-v1', reference, directory: cacheRoot, identity: dir, files });
  for (const f of files) if (JSON.stringify(node(f.file)) !== JSON.stringify({ ino: f.ino, dev: f.dev, bytes: f.bytes, modified: f.modified }) || sha(read(f.file, 8 * 1024 ** 2)) !== f.sha256) throw Error('测试清理文件已改变，保留剩余原件。');
  const s = node(cacheRoot, true); if (s.ino !== dir.ino || s.dev !== dir.dev) throw Error('测试清理目录已替换。');
  for (const f of files) fs.unlinkSync(f.file); fs.rmdirSync(cacheRoot); return { removed: true, bytes, receipt };
}
module.exports = { create, verify, unused, mark, clear, cleanup, ROOT, SOURCE_ID, SOURCE_SHA, FILES };
