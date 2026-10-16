'use strict';
// One owned, bounded runtime for a pair of approved real sources. Test-only.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { FILES, PROFILES } = require('./preparation-runtime.cjs');
const repo = path.resolve(__dirname, '../..'), plugin = path.join(repo, 'plugin'), ROOT = path.join(repo, 'tests/host/t4/stability-scratch');
const LIMITS = Object.freeze({ diskBytes: 240 * 1024 ** 2, totalBytes: 256 * 1024 ** 2, ramBytes: 1024 ** 3 });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function identity(file, directory = false) {
  const s = fs.lstatSync(file, { bigint: true });
  if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile() && s.nlink === 1n) ||
      fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw Error('长期验证路径或文件身份异常，保留原件。');
  return { ino: String(s.ino), dev: String(s.dev), bytes: Number(s.size), modified: String(s.mtimeNs) };
}
function read(file, maximum = 1024 ** 2) {
  const before = identity(file); if (before.bytes > maximum) throw Error('长期验证文件超过边界。');
  const bytes = fs.readFileSync(file); if (JSON.stringify(identity(file)) !== JSON.stringify(before) || bytes.length !== before.bytes) throw Error('长期验证文件读取时变化。');
  return bytes;
}
function sources(profile) {
  if (!['vp9', 'hevc'].includes(profile)) throw Error('未批准的长期素材集合。');
  const cfg = JSON.parse(read(path.join(repo, 'tests/host/t0/config.local.json'))), base = cfg.sources.find(s => s.key === 'baseline');
  const images = path.dirname(path.dirname(base.file)); identity(images, true);
  return ['sonic', profile].map(key => {
    const spec = PROFILES[key], dir = path.join(images, spec.id + '.info'); identity(dir, true);
    const names = key === 'vp9' ? [path.basename(base.file)] : fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.mp4'));
    if (names.length !== 1 || key === 'vp9' && base.sha256 !== spec.sha256) throw Error('长期固定源缺失或不唯一。');
    const filePath = path.join(dir, names[0]), sourceIdentity = identity(filePath);
    return { id: spec.id, itemId: spec.id, name: spec.name, ext: 'mp4', filePath, sha256: spec.sha256, frames: spec.frames, sourceIdentity };
  });
}
function create(profile) {
  identity(path.dirname(ROOT), true); if (fs.existsSync(ROOT)) throw Error('已有长期运行副本，先核对结果，不覆盖。');
  const selected = sources(profile), original = {}, copied = {};
  const data = FILES.map(file => { const bytes = read(path.join(plugin, file)); original[file] = sha(bytes);
    if (file !== 'task-worker.cjs') return [file, bytes];
    const text = bytes.toString('utf8'), token = 'processIdentity: identity, packFrames: true';
    if (text.split(token).length !== 2) throw Error('长期运行worker结构变化。');
    return [file, Buffer.from(text.replace(token, token + ', diskBytes: 240 * 1024 ** 2'))]; });
  if (data.reduce((n, [, b]) => n + b.length, 0) > 256 * 1024) throw Error('长期代码副本超过256KiB。');
  fs.mkdirSync(ROOT); fs.mkdirSync(path.join(ROOT, 'native'));
  for (const [file, bytes] of data) { fs.writeFileSync(path.join(ROOT, file), bytes, { flag: 'wx' }); copied[file] = { bytes: bytes.length, sha256: sha(bytes) }; }
  const id = identity(ROOT, true), owner = { schema: 'mvp-stability-runtime-v1', root: ROOT, plugin, profile, sources: selected,
    directoryIdentity: { ino: id.ino, dev: id.dev }, nonce: crypto.randomBytes(12).toString('hex'), original, copied, limits: LIMITS };
  const bytes = Buffer.from(JSON.stringify(owner)); fs.writeFileSync(path.join(ROOT, 'runtime-owner.json'), bytes, { flag: 'wx' });
  return { root: ROOT, ownerSha256: sha(bytes) };
}
function verify(reference) {
  if (!reference || reference.root !== ROOT || !/^[0-9a-f]{64}$/.test(reference.ownerSha256 || '')) throw Error('长期运行归属不明。');
  const id = identity(ROOT, true), bytes = read(path.join(ROOT, 'runtime-owner.json')), owner = JSON.parse(bytes);
  if (sha(bytes) !== reference.ownerSha256 || owner.schema !== 'mvp-stability-runtime-v1' || owner.root !== ROOT || owner.plugin !== plugin ||
      !['vp9', 'hevc'].includes(owner.profile) || owner.directoryIdentity.ino !== id.ino || owner.directoryIdentity.dev !== id.dev ||
      JSON.stringify(owner.limits) !== JSON.stringify(LIMITS) || JSON.stringify(Object.keys(owner.original).sort()) !== JSON.stringify(FILES.slice().sort()) ||
      JSON.stringify(Object.keys(owner.copied).sort()) !== JSON.stringify(FILES.slice().sort()) || JSON.stringify(owner.sources) !== JSON.stringify(sources(owner.profile)))
    throw Error('长期副本身份、源或预算变化。');
  const allowed = new Set(['native', 'cache', 'runtime-owner.json', 'started.json', 'finished.json', ...FILES.filter(n => !n.includes('/'))]);
  if (fs.readdirSync(ROOT).some(n => !allowed.has(n)) || JSON.stringify(fs.readdirSync(path.join(ROOT, 'native')).sort()) !== JSON.stringify(FILES.filter(n => n.startsWith('native/')).map(n => n.slice(7)).sort()))
    throw Error('长期副本出现未知文件。');
  for (const file of FILES) {
    const b = read(path.join(ROOT, file)), original = read(path.join(plugin, file));
    const expected = file === 'task-worker.cjs' ? Buffer.from(original.toString().replace('processIdentity: identity, packFrames: true', 'processIdentity: identity, packFrames: true, diskBytes: 240 * 1024 ** 2')) : original;
    if (b.length !== owner.copied[file].bytes || sha(b) !== owner.copied[file].sha256 || sha(original) !== owner.original[file] || !b.equals(expected)) throw Error('长期运行源码变化。');
  }
  require('../../plugin/task-client.cjs').verifyGuard(ROOT); return owner;
}
function unused(reference) { const owner = verify(reference);
  if (['started.json', 'finished.json', 'cache'].some(n => fs.existsSync(path.join(ROOT, n)))) throw Error('本轮长期已启动，不自动重跑。'); return owner; }
function mark(reference, name, value) {
  if (!['started.json', 'finished.json'].includes(name)) throw Error('长期标记无效。');
  const owner = name === 'started.json' ? unused(reference) : verify(reference);
  const bytes = Buffer.from(JSON.stringify({ schema: 'mvp-stability-marker-v1', nonce: owner.nonce, ...value }));
  if (bytes.length > 16384) throw Error('长期标记越界。'); fs.writeFileSync(path.join(ROOT, name), bytes, { flag: 'wx' });
}
async function verifyAssets(sample) {
  const registered = require('./window-host.cjs')._test.registeredManifest(ROOT, { sourceIdentity: { itemId: sample.id, sha256: sample.sha256 } }), info = registered.info;
  require('../../plugin/frame-pack.cjs').validate(info, LIMITS.diskBytes);
  if (!info.framePack || info.frames.length !== sample.frames) throw Error('长期固定帧包不完整。');
  const { RECIPE } = require('../../plugin/cache.cjs'), directory = path.join(ROOT, 'cache', 'media-' + sample.sha256 + '-' + sha(Buffer.from(RECIPE)).slice(0, 12));
  for (const asset of [info.framePack, ...(info.audio ? [info.audio] : [])]) {
    if (!['frames.pack', 'audio.wav'].includes(asset.file)) throw Error('长期物理资产不明。');
    const file = path.join(directory, asset.file); if (identity(file).bytes !== asset.bytes || await require('./window-resource.cjs')._test.hashSource(file) !== asset.sha256) throw Error('长期缓存损坏，不重新生成代替测试。');
  }
  return registered;
}
function cleanup(reference, store) {
  const owner = verify(reference), cacheRoot = path.join(ROOT, 'cache'); if (!fs.existsSync(cacheRoot)) return { removed: false, bytes: 0 };
  const cache = require('../../plugin/cache.cjs').createCache({ pluginRoot: ROOT, diskBytes: LIMITS.diskBytes }), before = cache.inventory();
  if (before.leases.length || before.caches.some(c => !owner.sources.some(s => s.sha256 === c.sourceSha256)) || fs.existsSync(path.join(cacheRoot, 'writer.lock'))) throw Error('长期缓存仍占用或归属不符，保留。');
  cache.clearOther({ sourceSha256: '0'.repeat(64) }); const after = cache.inventory(); if (after.caches.length || after.leases.length) throw Error('长期缓存清理未完成。');
  const directory = identity(cacheRoot, true), files = fs.readdirSync(cacheRoot).map(name => {
    if (!/^(?:owner|(?:cleanup|reap)-[0-9a-f]{24}(?:\.result)?)\.json$/.test(name)) throw Error('长期清理出现未知文件。');
    const file = path.join(cacheRoot, name); return { file, ...identity(file), sha256: sha(read(file, 8 * 1024 ** 2)) }; });
  const bytes = files.reduce((n, f) => n + f.bytes, 0); if (bytes > LIMITS.totalBytes) throw Error('长期清理记录总量越界。');
  const receipt = store.save('audit', { schema: 'mvp-stability-cleanup-v1', reference, before, after, directory, files, bytes });
  for (const f of files) if (JSON.stringify(identity(f.file)) !== JSON.stringify({ ino: f.ino, dev: f.dev, bytes: f.bytes, modified: f.modified }) || sha(read(f.file, 8 * 1024 ** 2)) !== f.sha256) throw Error('长期清理文件变化。');
  const last = identity(cacheRoot, true); if (last.ino !== directory.ino || last.dev !== directory.dev) throw Error('长期清理目录变化。');
  for (const f of files) fs.unlinkSync(f.file); fs.rmdirSync(cacheRoot); return { removed: true, bytes, receipt };
}
module.exports = { create, verify, unused, mark, cleanup, verifyAssets, ROOT, LIMITS };
