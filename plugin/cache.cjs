'use strict';

// Formal cache ownership and bounded I/O. T1 deliberately refuses orphaned
// locks/partials and damaged caches; eviction and recovery belong to T2.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateIndex } = require('./frame-index.cjs');
const OWNER = 'eagle-video-analysis-plugin-v1';
const RECIPE = 'jpeg-q3-720p-pcm-f32-48000-v1';
const MIB = 1024 ** 2;
const LIMITS = Object.freeze({ cacheBytes: 5 * 1024 * MIB, metadataBytes: 8 * MIB,
  assetBytes: 256 * MIB, duration: 30, prefixBytes: 4096 });
const recipeId = crypto.createHash('sha256').update(RECIPE).digest('hex').slice(0, 12);
const activeRoots = new Set();
const nonce = () => crypto.randomBytes(12).toString('hex');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function fail(message) { throw new Error(message); }
function cancelled(signal) {
  if (signal && signal.aborted) { const error = new Error('缓存处理已取消。'); error.name = 'AbortError'; throw error; }
}
function safeName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) || /\.$/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail('缓存文件名不安全。');
  return name;
}
function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function directory(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(fs.realpathSync(dir), dir)) fail('缓存目录不能使用链接或重解析路径。');
  return stat;
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !samePath(fs.realpathSync(file), file)) fail('缓存文件必须是唯一链接的普通文件。');
  return stat;
}
function sameFile(stat, other) { return stat.isFile() && other.isFile() && stat.ino === other.ino && stat.dev === other.dev && other.nlink === 1; }
function jsonBytes(value) {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > LIMITS.metadataBytes) fail('缓存元数据超过容量限制。');
  return data;
}
function readJSON(file) {
  const before = regular(file);
  if (before.size > LIMITS.metadataBytes) fail('缓存元数据超过容量限制。');
  const fd = fs.openSync(file, 'r');
  try {
    if (!sameFile(before, fs.fstatSync(fd))) fail('缓存元数据身份已改变。');
    const data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (data.length !== before.size || !sameFile(before, after) || before.mtimeMs !== after.mtimeMs || !sameFile(before, regular(file))) fail('读取期间缓存元数据已改变。');
    return JSON.parse(data.toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function frozenCopy(value) {
  const result = JSON.parse(jsonBytes(value).toString('utf8'));
  function freeze(object) { if (object && typeof object === 'object') { Object.values(object).forEach(freeze); Object.freeze(object); } }
  freeze(result); return result;
}
function assets(info) { return [...info.frames, ...(info.audio ? [info.audio] : [])]; }
function contentSource(source, expectedSha) {
  if (!source || source.sha256 !== expectedSha || typeof source.codec !== 'string' ||
    !Number.isSafeInteger(source.width) || source.width <= 0 || !Number.isSafeInteger(source.height) || source.height <= 0 ||
    typeof source.hasAudioStream !== 'boolean') fail('缓存源内容信息不完整或身份不符。');
  return { sha256: source.sha256, codec: source.codec, width: source.width, height: source.height, hasAudioStream: source.hasAudioStream };
}
function manifestAssets(info, expectedSha) {
  if (!info || info.schema !== 1 || info.owner !== OWNER || info.recipe !== RECIPE || info.width !== 1280 || info.height !== 720 ||
    !(info.duration > 0 && info.duration <= LIMITS.duration) || !Array.isArray(info.frames))
    fail('缓存清单格式或处理版本不符。');
  contentSource(info.source, expectedSha); validateIndex(info);
  const start = Math.min(0, info.audio ? info.audio.start : 0);
  if (info.duration - start > LIMITS.duration) fail('解码后媒体跨度超过30秒。');
  const map = new Map();
  for (const item of assets(info)) {
    safeName(item.file);
    if (['owner.json', 'manifest.json', 'writer.lock'].includes(item.file) || map.has(item.file) ||
      !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > LIMITS.assetBytes || !/^[0-9a-f]{64}$/.test(item.sha256))
      fail('缓存资产重复、越界或缺少内容指纹。');
    map.set(item.file, Object.freeze({ file: item.file, bytes: item.bytes, sha256: item.sha256 }));
  }
  return map;
}

function createCache(options = {}) {
  const { pluginRoot } = options, diskBytes = options.diskBytes === undefined ? LIMITS.cacheBytes : options.diskBytes;
  if (typeof pluginRoot !== 'string' || !path.isAbsolute(pluginRoot) || !Number.isSafeInteger(diskBytes) || diskBytes < 1 || diskBytes > LIMITS.cacheBytes)
    fail('需要插件绝对路径和不超过5GiB的缓存预算。');
  const plugin = path.resolve(pluginRoot), root = path.join(plugin, 'cache');
  if (/^c:/i.test(plugin)) fail('缓存不能位于C盘。');
  directory(plugin);
  const live = new WeakMap();
  const ownerValue = (kind, extra) => ({ schema: 1, owner: OWNER, recipe: RECIPE, root, kind, ...extra });
  function verifyRoot() {
    const pluginStat = directory(plugin), rootStat = directory(root);
    if (rootStat.dev !== pluginStat.dev || path.parse(root).root.toLowerCase() !== path.parse(plugin).root.toLowerCase() || /^c:/i.test(fs.realpathSync(root)))
      fail('缓存实际位置必须与插件同盘且不在C盘。');
    return verifyOwner(root, 'root');
  }
  function verifyOwner(dir, kind) {
    directory(dir); const value = readJSON(path.join(dir, 'owner.json'));
    if (value.schema !== 1 || value.owner !== OWNER || value.recipe !== RECIPE || value.root !== root || value.kind !== kind)
      fail('缓存所有权不明；不读取或清理。');
    return value;
  }
  function ensureRoot() {
    directory(plugin);
    if (!fs.existsSync(root)) {
      const data = jsonBytes(ownerValue('root'));
      if (data.length > diskBytes) fail('缓存容量不足。');
      fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'owner.json'), data, { flag: 'wx' });
    }
    verifyRoot();
  }
  function assertWriter(job, ignoreCancel = false) {
    if (!ignoreCancel) cancelled(job.signal);
    if (job.closed || !activeRoots.has(root)) fail('缓存写事务已经关闭。');
    verifyRoot();
    const file = path.join(root, 'writer.lock'), stat = regular(file);
    if (!sameFile(job.lockIdentity, stat)) fail('缓存写锁身份已改变。');
    const value = readJSON(file);
    if (value.owner !== OWNER || value.recipe !== RECIPE || value.root !== root || value.kind !== 'writer' || value.token !== job.token || value.pid !== process.pid)
      fail('缓存写锁所有权已改变。');
  }
  function charge(job, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(job.disk + bytes) || job.disk + bytes > diskBytes) fail('缓存容量不足；未执行超额写入。');
    job.disk += bytes;
  }
  function inspectDirectory(dir, kind, expectedSha) {
    verifyOwner(dir, kind); const info = readJSON(path.join(dir, 'manifest.json'));
    const map = manifestAssets(info, expectedSha), expected = new Set(['owner.json', 'manifest.json', ...map.keys()]);
    const actual = fs.readdirSync(dir);
    if (actual.length !== expected.size || actual.some(name => !expected.has(name))) fail('缓存包含未登记文件；拒绝使用。');
    for (const [file, item] of map) if (regular(path.join(dir, file)).size !== item.bytes) fail('缓存资产长度已改变。');
    return { info, map, names: actual };
  }
  function usage(job) {
    verifyRoot(); let bytes = 0;
    const add = size => { if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(bytes + size) || bytes + size > diskBytes) fail('缓存现有容量超过预算。'); bytes += size; };
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name), stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const match = /^media-([0-9a-f]{64})-([0-9a-f]{12})$/.exec(name);
        if (!match || match[2] !== recipeId) fail('检测到未知或未完成缓存，已停止写入并保留文件。');
        const inspected = inspectDirectory(file, 'cache', match[1]);
        for (const child of inspected.names) add(regular(path.join(file, child)).size);
      } else {
        regular(file);
        if (name === 'owner.json') verifyOwner(root, 'root');
        else if (name === 'writer.lock') {
          if (!job || !sameFile(job.lockIdentity, stat)) fail('未知写锁阻止新的写入。');
        } else if (/^lease-[0-9a-f]{24}\.json$/.test(name)) {
          const value = readJSON(file);
          if (value.owner !== OWNER || value.recipe !== RECIPE || value.root !== root || value.kind !== 'lease' ||
            !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.token !== name.slice(6, -5) ||
            typeof value.cacheDir !== 'string' || !path.isAbsolute(value.cacheDir) || !samePath(path.dirname(value.cacheDir), root) ||
            !new RegExp('^media-[0-9a-f]{64}-' + recipeId + '$').test(path.basename(value.cacheDir)) || !fs.existsSync(value.cacheDir)) fail('未知占用记录阻止写入。');
          verifyOwner(value.cacheDir, 'cache');
        } else fail('缓存根包含未知文件；未修改它。');
        add(stat.size);
      }
    }
    return bytes;
  }
  async function hashFile(file, signal) {
    cancelled(signal); const before = regular(file), handle = await fs.promises.open(file, 'r');
    try {
      if (!sameFile(before, await handle.stat())) fail('读取前缓存资产身份已改变。');
      const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(Math.min(MIB, before.size || 1)); let at = 0;
      while (at < before.size) {
        cancelled(signal); const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - at), at);
        if (!result.bytesRead) fail('缓存资产读取不完整。'); hash.update(buffer.subarray(0, result.bytesRead)); at += result.bytesRead;
      }
      const after = await handle.stat(), current = regular(file);
      if (!sameFile(before, after) || !sameFile(before, current) || after.size !== before.size || current.size !== before.size || before.mtimeMs !== after.mtimeMs || before.mtimeMs !== current.mtimeMs)
        fail('读取期间缓存资产已改变。');
      cancelled(signal); return hash.digest('hex');
    } finally { await handle.close(); }
  }
  function writeAll(fd, data, position, onWrite) {
    let at = 0;
    while (at < data.length) {
      const count = fs.writeSync(fd, data, at, data.length - at, position + at);
      if (!Number.isSafeInteger(count) || count <= 0 || count > data.length - at) fail('缓存写入未完整完成。');
      at += count; if (onWrite) onWrite(count);
    }
  }
  function releaseWriter(job) {
    if (job.closed) return false;
    assertWriter(job, true); fs.unlinkSync(path.join(root, 'writer.lock')); job.closed = true; activeRoots.delete(root); return true;
  }
  function begin({ sourceSha256, signal } = {}) {
    cancelled(signal);
    if (typeof sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sourceSha256)) fail('源内容指纹不正确。');
    if (activeRoots.has(root)) fail('同一缓存已有准备事务。');
    ensureRoot();
    const lockPath = path.join(root, 'writer.lock'); let fd;
    try { fd = fs.openSync(lockPath, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') { error.message = '缓存已有占用记录，无法开始准备；未确认的写锁会保留。'; error.code = 'CACHE_BUSY'; }
      throw error;
    }
    const job = { token: nonce(), signal, closed: false, partial: null, published: false, disk: 0,
      files: new Map(), streams: new Set(), closingStreams: new Set(), lockIdentity: fs.fstatSync(fd) };
    activeRoots.add(root);
    const lockData = jsonBytes(ownerValue('writer', { token: job.token, pid: process.pid }));
    let lockWritten = 0;
    try {
      job.disk = usage(job); charge(job, lockData.length);
      writeAll(fd, lockData, 0, count => { lockWritten += count; }); fs.closeSync(fd);
      assertWriter(job);
    } catch (error) {
      try { fs.closeSync(fd); } catch (_) { /* Already closed. */ }
      try {
        verifyRoot(); const current = regular(lockPath);
        if (!sameFile(job.lockIdentity, current) || current.size !== lockWritten || !fs.readFileSync(lockPath).equals(lockData.subarray(0, lockWritten)))
          fail('未完整建立的写锁身份未知，保留原件。');
        fs.unlinkSync(lockPath); activeRoots.delete(root); job.closed = true;
      } catch (cleanupError) { error.cleanupError = cleanupError.message; }
      throw error;
    }
    const target = path.join(root, 'media-' + sourceSha256 + '-' + recipeId);
    let candidate = null, candidatePinned = null, finished = null;
    function ensurePartial() {
      assertWriter(job);
      if (candidate || job.published) fail('完整缓存不能作为临时写入目标。');
      if (!job.partial) {
        const dir = path.join(root, 'partial-' + nonce()), data = jsonBytes(ownerValue('partial', { token: job.token }));
        charge(job, data.length); fs.mkdirSync(dir); job.partial = dir;
        fs.writeFileSync(path.join(dir, 'owner.json'), data, { flag: 'wx' });
      }
      const marker = verifyOwner(job.partial, 'partial'); if (marker.token !== job.token) fail('临时缓存事务身份已改变。');
    }
    function openAsset(name, internal = false) {
      safeName(name);
      if ((!internal && ['owner.json', 'manifest.json', 'writer.lock'].includes(name)) || job.files.has(name)) fail('缓存文件已登记或属于保留名称。');
      ensurePartial();
      const file = path.join(job.partial, name), fileFd = fs.openSync(file, 'wx+');
      const record = { file: name, bytes: 0, identity: fs.fstatSync(fileFd), closed: false, sha256: null };
      job.files.set(name, record); job.streams.add(record); let closing = null;
      function checkStream() {
        assertWriter(job); if (record.closed || closing) fail('缓存输出流已经关闭。');
        const current = regular(file);
        if (!sameFile(record.identity, current) || !sameFile(record.identity, fs.fstatSync(fileFd)) || current.size !== record.bytes) fail('缓存输出文件身份或长度已改变。');
      }
      return Object.freeze({
        append(data) {
          checkStream(); if (!Buffer.isBuffer(data)) fail('缓存输出只接受Buffer。');
          if (record.bytes + data.length > (internal ? LIMITS.metadataBytes : LIMITS.assetBytes)) fail('单个缓存资产超过上限。');
          charge(job, data.length); writeAll(fileFd, data, record.bytes, count => { record.bytes += count; });
        },
        readPrefix(maximum = LIMITS.prefixBytes) {
          checkStream();
          if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > LIMITS.prefixBytes) fail('缓存头读取超过4096字节。');
          const data = Buffer.alloc(Math.min(maximum, record.bytes)); let at = 0;
          while (at < data.length) { const count = fs.readSync(fileFd, data, at, data.length - at, at); if (!count) fail('缓存头读取不完整。'); at += count; }
          return data;
        },
        patch(offset, data) {
          checkStream();
          if (!Buffer.isBuffer(data) || !Number.isSafeInteger(offset) || offset < 0 || offset + data.length > record.bytes) fail('缓存补写不能扩展文件。');
          writeAll(fileFd, data, offset);
        },
        close() {
          if (closing) return closing;
          closing = (async () => {
            fs.closeSync(fileFd); record.closed = true; job.streams.delete(record);
            const current = regular(file);
            if (!sameFile(record.identity, current) || current.size !== record.bytes) fail('关闭时缓存输出身份已改变。');
            record.sha256 = await hashFile(file, null);
            return Object.freeze({ file: name, bytes: record.bytes, sha256: record.sha256 });
          })();
          job.closingStreams.add(closing); closing.then(() => job.closingStreams.delete(closing), () => job.closingStreams.delete(closing));
          return closing;
        }
      });
    }
    async function writeAsset(name, data, internal = false) {
      const stream = openAsset(name, internal);
      try { stream.append(data); } catch (error) { try { await stream.close(); } catch (closeError) { error.closeError = closeError.message; } throw error; }
      return stream.close();
    }
    async function readComplete() {
      assertWriter(job);
      if (job.partial || job.published) fail('已经开始写入，不能再读取复用候选。');
      if (candidate) return candidate;
      if (!fs.existsSync(target)) return null;
      const inspected = inspectDirectory(target, 'cache', sourceSha256);
      for (const item of inspected.map.values()) {
        if (await hashFile(path.join(target, item.file), signal) !== item.sha256) fail('完整缓存内容指纹不符；拒绝复用。');
        assertWriter(job);
      }
      candidate = inspected.info; candidatePinned = frozenCopy(candidate); return candidate;
    }
    function registerLease(persisted, currentSource, metrics) {
      assertWriter(job);
      const current = JSON.parse(jsonBytes(currentSource).toString('utf8'));
      if (current.sha256 !== sourceSha256) fail('当前素材绑定与源内容不符。');
      const id = nonce(), file = path.join(root, 'lease-' + id + '.json');
      const data = jsonBytes(ownerValue('lease', { token: id, pid: process.pid, cacheDir: target, sourceSha256 }));
      const info = { ...JSON.parse(jsonBytes(persisted).toString('utf8')), source: current,
        ...(metrics ? { metrics: JSON.parse(jsonBytes(metrics).toString('utf8')) } : {}), cacheDir: target, leaseId: id };
      const map = manifestAssets(persisted, sourceSha256), capturedSource = frozenCopy(current);
      charge(job, data.length); fs.writeFileSync(file, data, { flag: 'wx' });
      live.set(info, { active: true, id, file, cacheDir: target, source: capturedSource,
        markerSha: sha(data), markerIdentity: regular(file), map });
      return info;
    }
    async function finish(manifest, currentSource) {
      assertWriter(job);
      if (finished) fail('缓存事务已提交。');
      if (!currentSource || currentSource.sha256 !== sourceSha256) fail('当前素材绑定与源内容不符。');
      if (job.streams.size || job.closingStreams.size) fail('必须先等待缓存输出流真正关闭。');
      if (candidate) {
        if (manifest !== candidate || JSON.stringify({ ...manifest, metrics: null }) !== JSON.stringify({ ...candidatePinned, metrics: null }))
          fail('复用必须使用本事务已验证且未改写的原始清单。');
        finished = registerLease(candidatePinned, currentSource, manifest.metrics); return finished;
      }
      if (!job.partial) fail('没有可提交的临时缓存。');
      if (manifest.owner !== undefined && manifest.owner !== OWNER || manifest.recipe !== undefined && manifest.recipe !== RECIPE || manifest.schema !== undefined && manifest.schema !== 1)
        fail('缓存清单不能改变所有权或处理版本。');
      const persistent = JSON.parse(jsonBytes({ ...manifest, schema: 1, owner: OWNER, recipe: RECIPE,
        source: contentSource(manifest.source, sourceSha256) }).toString('utf8'));
      delete persistent.cacheDir; delete persistent.leaseId;
      const map = manifestAssets(persistent, sourceSha256);
      if (map.size !== job.files.size || [...map].some(([name, item]) => {
        const record = job.files.get(name); return !record || !record.closed || record.bytes !== item.bytes || record.sha256 !== item.sha256;
      })) fail('缓存清单与本事务已登记输出不符。');
      await writeAsset('manifest.json', jsonBytes(persistent), true);
      const inspected = inspectDirectory(job.partial, 'partial', sourceSha256);
      for (const item of inspected.map.values()) if (await hashFile(path.join(job.partial, item.file), signal) !== item.sha256) fail('提交前缓存资产发生变化。');
      assertWriter(job);
      const markerPath = path.join(job.partial, 'owner.json'), oldMarker = regular(markerPath);
      const marker = jsonBytes(ownerValue('cache', { token: job.token }));
      if (marker.length > oldMarker.size) charge(job, marker.length - oldMarker.size);
      if (fs.existsSync(target)) fail('完整缓存目标已存在；拒绝覆盖。');
      // Final synchronous owner change and same-volume publish have no await.
      const markerFd = fs.openSync(markerPath, 'r+');
      try {
        if (!sameFile(oldMarker, fs.fstatSync(markerFd))) fail('临时所有权标记身份已改变。');
        writeAll(markerFd, marker, 0); fs.ftruncateSync(markerFd, marker.length);
      } finally { fs.closeSync(markerFd); }
      if (marker.length < oldMarker.size) job.disk -= oldMarker.size - marker.length;
      fs.renameSync(job.partial, target); job.partial = null; job.published = true;
      finished = registerLease(persistent, currentSource); return finished;
    }
    function abort() {
      assertWriter(job, true);
      if (job.streams.size || job.closingStreams.size) fail('输出流仍未退出，不能清理临时缓存。');
      if (!job.partial) return false;
      const marker = readJSON(path.join(job.partial, 'owner.json'));
      if (marker.owner !== OWNER || marker.recipe !== RECIPE || marker.root !== root || marker.token !== job.token || !['partial', 'cache'].includes(marker.kind))
        fail('临时缓存所有权未知，未执行删除。');
      directory(job.partial);
      const names = fs.readdirSync(job.partial), expected = new Set(['owner.json', ...job.files.keys()]);
      if (names.length !== expected.size || names.some(name => !expected.has(name))) fail('临时缓存包含未知文件，未执行删除。');
      const sizes = new Map();
      for (const name of names) {
        const stat = regular(path.join(job.partial, name)), record = job.files.get(name);
        if (record && (!sameFile(record.identity, stat) || stat.size !== record.bytes)) fail('临时文件身份或长度已改变，未执行删除。');
        sizes.set(name, stat.size);
      }
      // Validate every registered path before the first deletion; owner last.
      for (const name of names) if (name !== 'owner.json') fs.unlinkSync(path.join(job.partial, name));
      fs.unlinkSync(path.join(job.partial, 'owner.json')); fs.rmdirSync(job.partial);
      for (const size of sizes.values()) job.disk -= size;
      job.partial = null; job.files.clear(); return true;
    }
    return Object.freeze({ readComplete, writeAsset, openAsset, finish, abort,
      close() { if (job.streams.size || job.closingStreams.size) fail('输出流仍未关闭，不能释放写锁。'); return releaseWriter(job); } });
  }
  function leaseFor(info) {
    const lease = info && live.get(info);
    if (!lease || !lease.active || info.cacheDir !== lease.cacheDir || info.leaseId !== lease.id) fail('需要本缓存实例登记的原始有效句柄。');
    verifyRoot(); verifyOwner(lease.cacheDir, 'cache'); return lease;
  }
  async function readAsset(info, file) {
    const lease = leaseFor(info); safeName(file);
    const asset = lease.map.get(file); if (!asset || asset.bytes > LIMITS.assetBytes) fail('文件不在原始缓存句柄的资产表中。');
    const absolute = path.join(lease.cacheDir, file), before = regular(absolute), handle = await fs.promises.open(absolute, 'r');
    try {
      if (before.size !== asset.bytes || !sameFile(before, await handle.stat())) fail('读取前缓存资产身份或长度不符。');
      const data = Buffer.alloc(asset.bytes); let at = 0;
      while (at < data.length) { const result = await handle.read(data, at, data.length - at, at); if (!result.bytesRead) fail('缓存资产读取不完整。'); at += result.bytesRead; }
      const after = await handle.stat(), current = regular(absolute);
      if (!sameFile(before, after) || !sameFile(before, current) || after.size !== asset.bytes || current.size !== asset.bytes || before.mtimeMs !== after.mtimeMs || before.mtimeMs !== current.mtimeMs || sha(data) !== asset.sha256)
        fail('缓存资产读取期间已改变。');
      leaseFor(info); return data;
    } finally { await handle.close(); }
  }
  function release(info) {
    const lease = info && live.get(info); if (!lease || !lease.active) return false;
    leaseFor(info); const stat = regular(lease.file);
    if (!sameFile(lease.markerIdentity, stat) || sha(fs.readFileSync(lease.file)) !== lease.markerSha) fail('占用记录身份已改变；未执行删除。');
    fs.unlinkSync(lease.file); lease.active = false; return true;
  }
  return Object.freeze({ root, begin, readAsset, release });
}

module.exports = { createCache, OWNER, RECIPE, LIMITS };
