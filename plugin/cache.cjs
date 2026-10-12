'use strict';

// Formal cache ownership, bounded I/O and guarded cache maintenance.
// Unknown locks/partials remain protected, never inferred dead from a PID.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateIndex } = require('./frame-index.cjs');
const { createIdentity } = require('./process-identity.cjs');
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
function readJSON(file, before = regular(file)) {
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
  const processIdentity = options.processIdentity || createIdentity();
  const ownerValue = (kind, extra) => ({ schema: 1, owner: OWNER, recipe: RECIPE, root, kind, ...extra });
  function verifyRoot() {
    const pluginStat = directory(plugin), rootStat = directory(root);
    // directory(root) already established that its real path equals root.
    if (rootStat.dev !== pluginStat.dev || path.parse(root).root.toLowerCase() !== path.parse(plugin).root.toLowerCase() || /^c:/i.test(root))
      fail('缓存实际位置必须与插件同盘且不在C盘。');
    return verifyOwner(root, 'root', rootStat);
  }
  function verifyOwner(dir, kind, checkedDirectory) {
    // Only callers in the same synchronous segment pass a checked directory.
    if (!checkedDirectory) directory(dir);
    const value = readJSON(path.join(dir, 'owner.json'));
    if (value.schema !== 1 || value.owner !== OWNER || value.recipe !== RECIPE || value.root !== root || value.kind !== kind)
      fail('缓存所有权不明；不读取或清理。');
    if (kind === 'cache' && (value.useSequence !== undefined || value.lastUsedAt !== undefined) &&
      (!Number.isSafeInteger(value.useSequence) || value.useSequence < 1 || !Number.isSafeInteger(value.lastUsedAt) || value.lastUsedAt < 1))
      fail('最近使用记录损坏；不猜测使用顺序。');
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
    const value = readJSON(file, stat);
    if (value.owner !== OWNER || value.recipe !== RECIPE || value.root !== root || value.kind !== 'writer' || value.token !== job.token || value.pid !== process.pid)
      fail('缓存写锁所有权已改变。');
    if (job.lockSha && sha(jsonBytes(value)) !== job.lockSha) fail('缓存写锁所有权或任务登记已改变。');
  }
  function charge(job, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(job.disk + bytes)) fail('缓存容量不足；未执行超额写入。');
    // Retain space for a write-ahead deletion plan and its result. Tiny
    // injected budgets use proportional headroom; the product keeps 16MiB
    // inside, rather than in addition to, the approved 5GiB budget.
    const reserve = job.initializing ? 0 : Math.min(16 * MIB, Math.floor(diskBytes / 8));
    if (job.disk + bytes + reserve > diskBytes) {
      if (job.initializing) fail('缓存容量不足；未执行超额写入。');
      makeRoom(job, bytes, reserve);
    }
    job.disk += bytes;
  }
  function inspectDirectory(dir, kind, expectedSha, allowDamaged = false) {
    verifyOwner(dir, kind); const info = readJSON(path.join(dir, 'manifest.json'));
    const map = manifestAssets(info, expectedSha), expected = new Set(['owner.json', 'manifest.json', ...map.keys()]);
    const actual = fs.readdirSync(dir);
    if (kind === 'partial' && actual.includes('transaction.log')) expected.add('transaction.log');
    if (actual.length !== expected.size || actual.some(name => !expected.has(name))) fail('缓存包含未登记文件；拒绝使用。');
    let totalBytes = 0, lengthsMatch = true;
    for (const file of actual) {
      const stat = regular(path.join(dir, file)), item = map.get(file);
      if (item && stat.size !== item.bytes) { lengthsMatch = false; if (!allowDamaged) fail('缓存资产长度已改变。'); }
      if (item && stat.size > LIMITS.assetBytes) fail('已有缓存资产超过安全读取上限。');
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isSafeInteger(totalBytes + stat.size) || totalBytes + stat.size > diskBytes)
        fail('缓存现有容量超过预算。');
      totalBytes += stat.size;
    }
    return { info, map, names: actual, totalBytes, lengthsMatch };
  }
  function usage(job) {
    verifyRoot(); let bytes = 0;
    const pending = new Map();
    if (job && job.initializing) for (const name of fs.readdirSync(root)) {
      if (/^cleanup-[0-9a-f]{24}\.json$/.test(name) && !fs.existsSync(path.join(root, name.replace(/\.json$/, '.result.json')))) {
        const plan = verifyCleanupRecord(name); if (pending.has(plan.directory)) fail('同一目标存在重复清理计划。');
        pending.set(plan.directory, plan);
      }
    }
    const add = size => { if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(bytes + size) || bytes + size > diskBytes) fail('缓存现有容量超过预算。'); bytes += size; };
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name), stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (pending.has(file)) {
          const plan = pending.get(file); directory(file);
          if (stat.dev !== plan.directoryIdentity[0] || stat.ino !== plan.directoryIdentity[1]) fail('待恢复清理目录身份已变化。');
          const expected = new Map(plan.files.map(item => [item.file, item]));
          for (const leaf of fs.readdirSync(file)) {
            if (!expected.has(leaf)) fail('待恢复清理目录含未知文件。');
            if (JSON.stringify(leafSnapshot(path.join(file, leaf))) !== JSON.stringify(expected.get(leaf))) fail('待恢复清理文件指纹不符。');
            add(expected.get(leaf).bytes);
          }
          continue;
        }
        if (job && job.partial && samePath(file, job.partial)) {
          const marker = verifyOwner(file, 'partial');
          if (marker.token !== job.token) fail('当前临时缓存所有权不符。');
          const expected = new Set(['owner.json', ...job.files.keys(), ...(job.ledger && !job.ledger.removed ? ['transaction.log'] : [])]), names = fs.readdirSync(file);
          if (names.length !== expected.size || names.some(leaf => !expected.has(leaf))) fail('当前临时缓存含未知文件。');
          for (const leaf of names) {
            const current = regular(path.join(file, leaf)), record = job.files.get(leaf);
            if (record && (!record.identity || !sameFile(record.identity, current) || current.size !== record.bytes)) fail('当前临时文件身份或长度不符。');
            add(current.size);
          }
          continue;
        }
        const match = /^media-([0-9a-f]{64})-([0-9a-f]{12})$/.exec(name);
        if (!match || match[2] !== recipeId) fail('检测到未知或未完成缓存，已停止写入并保留文件。');
        const inspected = inspectDirectory(file, 'cache', match[1], true);
        // No await separates inspection from accounting: reuse its verified
        // leaf sizes, including owner and manifest, rather than scan twice.
        add(inspected.totalBytes);
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
        } else if (/^cleanup-[0-9a-f]{24}(?:\.result)?\.json$/.test(name)) {
          const value = verifyCleanupRecord(name);
          if (value.kind === 'cleanup-plan') {
            const resultName = name.replace(/\.json$/, '.result.json');
            if (!fs.existsSync(path.join(root, resultName))) {
              if (!job || !job.initializing) fail('清理事务未完成，保留清单并停止准备。');
            } else if (verifyCleanupRecord(resultName).planSha256 !== leafSnapshot(file).sha256) fail('清理回执与清单指纹不符。');
          }
        }
        else if (/^reap-[0-9a-f]{24}(?:\.result)?\.json$/.test(name)) requireReapCompleted(name);
        else fail('缓存根包含未知文件；未修改它。');
        add(stat.size);
      }
    }
    return bytes;
  }
  function verifyCleanupRecord(name) {
    const match = /^cleanup-([0-9a-f]{24})(\.result)?\.json$/.exec(name);
    if (!match) fail('未知清理记录。');
    const value = readJSON(path.join(root, name));
    if (value.schema !== 1 || value.owner !== OWNER || value.recipe !== RECIPE || value.root !== root ||
      value.token !== match[1] || value.kind !== (match[2] ? 'cleanup-result' : 'cleanup-plan')) fail('清理记录所有权不明。');
    if (match[2]) {
      if (!['completed', 'blocked'].includes(value.status) || !Number.isSafeInteger(value.freedBytes) || value.freedBytes < 0 ||
        !/^[0-9a-f]{64}$/.test(value.planSha256)) fail('清理回执不完整；保留原件。');
      if (value.status === 'blocked' && value.freedBytes !== 0) fail('零删除回执不符。');
      if (value.status === 'completed') {
        const planName = name.replace('.result.json', '.json');
        if (!fs.existsSync(path.join(root, planName)) || verifyCleanupRecord(planName).kind !== 'cleanup-plan' ||
          leafSnapshot(path.join(root, planName)).sha256 !== value.planSha256) fail('清理回执缺少对应原始清单。');
      }
    } else {
      if (typeof value.directory !== 'string' || !path.isAbsolute(value.directory) || !samePath(path.dirname(value.directory), root) ||
        !(new RegExp('^media-[0-9a-f]{64}-' + recipeId + '$').test(path.basename(value.directory)) ||
          /^partial-[0-9a-f]{24}$/.test(path.basename(value.directory)) && value.reason === 'orphaned-incomplete-cache') ||
        !Array.isArray(value.directoryIdentity) || value.directoryIdentity.length !== 2 ||
        !value.directoryIdentity.every(Number.isSafeInteger) || !/^[0-9a-f]{24}$/.test(value.cacheToken) ||
        !Array.isArray(value.files) || !value.files.length || !value.files.some(item => item.file === 'owner.json') ||
        new Set(value.files.map(item => item.file)).size !== value.files.length || value.files.some(item => {
          safeName(item.file); return !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[0-9a-f]{64}$/.test(item.sha256) ||
            !Array.isArray(item.identity) || item.identity.length !== 4 || item.identity.some(n => !Number.isFinite(n));
        })) fail('清理计划路径或文件清单不明。');
    }
    return value;
  }
  function stamp(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs]; }
  function leafSnapshot(file) {
    const before = regular(file), fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256');
    try {
      if (!sameFile(before, fs.fstatSync(fd))) fail('清理前文件身份已改变。');
      const buffer = Buffer.alloc(Math.min(MIB, before.size || 1)); let at = 0;
      while (at < before.size) {
        const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - at), at);
        if (!n) fail('清理前文件读取不完整。'); hash.update(buffer.subarray(0, n)); at += n;
      }
      if (JSON.stringify(stamp(before)) !== JSON.stringify(stamp(regular(file))) || !sameFile(before, fs.fstatSync(fd)))
        fail('清理前文件已变化。');
      return { file: path.basename(file), bytes: before.size, identity: stamp(before), sha256: hash.digest('hex') };
    } finally { fs.closeSync(fd); }
  }
  function writeRecord(file, data) {
    const fd = fs.openSync(file, 'wx');
    try { writeAll(fd, data, 0); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    // Verify actual bytes, not just the expected buffer, before deleting.
    if (leafSnapshot(file).sha256 !== sha(data)) fail('清理记录落盘校验失败；未授权后续删除。');
  }
  function occupancy() {
    const protectedDirs = new Set();
    for (const name of fs.readdirSync(root)) if (/^lease-[0-9a-f]{24}\.json$/.test(name)) {
      const value = readJSON(path.join(root, name));
      if (value.schema !== 1 || value.owner !== OWNER || value.recipe !== RECIPE || value.root !== root || value.kind !== 'lease' ||
        value.token !== name.slice(6, -5) || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        typeof value.cacheDir !== 'string' || !samePath(path.dirname(value.cacheDir), root) ||
        path.basename(value.cacheDir) !== 'media-' + value.sourceSha256 + '-' + recipeId) fail('占用身份不明，不能淘汰。');
      verifyOwner(value.cacheDir, 'cache'); protectedDirs.add(value.cacheDir.toLowerCase());
    }
    return protectedDirs;
  }
  function assertPlan(job, plan, allowMissing = false) {
    assertWriter(job);
    if ((!allowMissing && samePath(plan.directory, job.target) && plan.reason !== 'damaged-cache') || occupancy().has(plan.directory.toLowerCase())) fail('当前或已占用缓存不能删除。');
    if (!fs.existsSync(plan.directory)) { if (allowMissing) return []; fail('清理目录已变化。'); }
    const dir = directory(plan.directory);
    if (dir.dev !== plan.directoryIdentity[0] || dir.ino !== plan.directoryIdentity[1]) fail('清理目录身份已变化。');
    const names = fs.readdirSync(plan.directory), expected = new Map(plan.files.map(item => [item.file, item]));
    if (names.some(name => !expected.has(name)) || (!allowMissing && names.length !== expected.size)) fail('清理目标出现未知或缺失文件。');
    if (names.includes('owner.json')) {
      const owner = verifyOwner(plan.directory, plan.targetKind || 'cache'); if (owner.token !== plan.cacheToken) fail('清理缓存所有权已改变。');
    } else if (names.length) fail('清理目录缺少所有权标记。');
    for (const name of names) {
      const actual = leafSnapshot(path.join(plan.directory, name)), before = expected.get(name);
      if (JSON.stringify(actual) !== JSON.stringify(before)) fail('清理候选指纹或身份已变化；停止删除。');
    }
    assertWriter(job); if (occupancy().has(plan.directory.toLowerCase())) fail('清理期间出现占用，停止删除。');
    return names;
  }
  function deletePlanned(job, plan, planData, recovering = false) {
    const names = assertPlan(job, plan, recovering);
    const resultFile = path.join(root, 'cleanup-' + plan.token + '.result.json');
    if (fs.existsSync(resultFile)) fail('清理回执目标已存在；未重复执行。');
    let freedBytes = 0;
    // The writer excludes new leases. Existing leases may only disappear;
    // their disappearance can never make a selected target less safe.
    for (const name of names.filter(name => name !== 'owner.json').concat(names.includes('owner.json') ? ['owner.json'] : [])) {
      const file = path.join(plan.directory, name), before = plan.files.find(item => item.file === name);
      if (JSON.stringify(leafSnapshot(file)) !== JSON.stringify(before)) fail('删除前文件身份已变化。');
      fs.unlinkSync(file); freedBytes += before.bytes;
    }
    if (fs.existsSync(plan.directory)) { directory(plan.directory); fs.rmdirSync(plan.directory); }
    const data = jsonBytes(ownerValue('cleanup-result', { token: plan.token, status: 'completed', planSha256: sha(planData),
      freedBytes, plannedBytes: plan.files.reduce((sum, item) => sum + item.bytes, 0), recovered: recovering, completedAt: Date.now() }));
    if (data.length > 4096) fail('清理回执超出预留。');
    writeRecord(resultFile, data); job.disk += data.length - freedBytes;
  }
  function resumeCleanup(job) {
    assertWriter(job);
    const pending = fs.readdirSync(root).filter(name => /^cleanup-[0-9a-f]{24}\.json$/.test(name) &&
      !fs.existsSync(path.join(root, name.replace(/\.json$/, '.result.json'))));
    // Owning the new writer proves the prior *synchronous* deletion released
    // exclusion. It does not prove orphan FFmpeg jobs dead; those retain locks.
    if (job.disk + pending.length * 4096 > diskBytes) fail('没有足够预留记录清理恢复；未删除。');
    for (const name of pending) {
      const file = path.join(root, name), plan = verifyCleanupRecord(name), data = fs.readFileSync(file);
      if (leafSnapshot(file).sha256 !== sha(data)) fail('清理恢复清单已改变。');
      assertPlan(job, plan, true); deletePlanned(job, plan, data, true);
    }
  }
  function discardDamaged(job, dir, inspected) {
    assertWriter(job);
    if (occupancy().has(dir.toLowerCase())) fail('完整缓存内容指纹不符且仍被占用；未删除或重建。');
    const owner = verifyOwner(dir, 'cache'), identity = directory(dir);
    const plan = ownerValue('cleanup-plan', { token: nonce(), writerToken: job.token, directory: dir,
      directoryIdentity: [identity.dev, identity.ino], cacheToken: owner.token, reason: 'damaged-cache', createdAt: Date.now(),
      files: inspected.names.sort().map(name => leafSnapshot(path.join(dir, name))) });
    const data = jsonBytes(plan);
    if (job.disk + data.length + 4096 > diskBytes) fail('无法预留损坏缓存清理记录；保留原件。');
    assertPlan(job, plan); writeRecord(path.join(root, 'cleanup-' + plan.token + '.json'), data); job.disk += data.length;
    deletePlanned(job, plan, data);
  }
  function makeRoom(job, bytes, reserve) {
    assertWriter(job);
    const protectedDirs = occupancy(), candidates = [];
    // Preflight the entire root before selecting any deletion. usage() knows
    // this transaction's partial, but refuses foreign/incomplete contents.
    job.disk = usage(job);
    for (const name of fs.readdirSync(root)) {
      const match = /^media-([0-9a-f]{64})-([0-9a-f]{12})$/.exec(name); if (!match) continue;
      const dir = path.join(root, name); if (samePath(dir, job.target) || protectedDirs.has(dir.toLowerCase())) continue;
      const owner = verifyOwner(dir, 'cache'), checked = inspectDirectory(dir, 'cache', match[1]);
      candidates.push({ dir, owner, checked, order: Number.isSafeInteger(owner.useSequence) ? owner.useSequence : 0 });
    }
    candidates.sort((a, b) => a.order - b.order || a.dir.localeCompare(b.dir));
    const selected = []; let future = job.disk, recordBytes = 0;
    for (const item of candidates) {
      const identity = directory(item.dir), plan = ownerValue('cleanup-plan', { token: nonce(), writerToken: job.token,
        directory: item.dir, directoryIdentity: [identity.dev, identity.ino], cacheToken: item.owner.token,
        reason: 'least-recently-used', createdAt: Date.now(), files: item.checked.names.sort().map(name => leafSnapshot(path.join(item.dir, name))) });
      const data = jsonBytes(plan); recordBytes += data.length + 4096;
      // Reserve every plan and result before the first unlink. No deletion
      // is performed merely to make room for its own evidence.
      if (job.disk + recordBytes > diskBytes) fail('容量不足以保存清理清单及回执；未执行删除。');
      future += data.length + 4096 - item.checked.totalBytes; selected.push({ plan, data });
      if (future + bytes + reserve <= diskBytes) break;
    }
    if (!selected.length || future + bytes + reserve > diskBytes) {
      const token = nonce(), data = jsonBytes(ownerValue('cleanup-result', { token, status: 'blocked', freedBytes: 0,
        planSha256: sha(Buffer.alloc(0)), requestedBytes: bytes, protectedCount: protectedDirs.size,
        reason: 'insufficient-unoccupied-cache', completedAt: Date.now() }));
      if (job.disk + data.length > diskBytes) fail('容量不足且无法保存零删除回执；未执行删除。');
      writeRecord(path.join(root, 'cleanup-' + token + '.result.json'), data); job.disk += data.length;
      fail('缓存容量不足；没有可安全淘汰的空间，已记录零删除。');
    }
    for (const { plan } of selected) assertPlan(job, plan);
    for (const { plan, data } of selected) {
      assertWriter(job); writeRecord(path.join(root, 'cleanup-' + plan.token + '.json'), data); job.disk += data.length;
      deletePlanned(job, plan, data);
    }
    if (job.disk + bytes + reserve > diskBytes) fail('清理后空间不足；未执行超额写入。');
  }
  function touch(job, dir) {
    assertWriter(job); const old = verifyOwner(dir, 'cache'), markerPath = path.join(dir, 'owner.json');
    const before = leafSnapshot(markerPath); let sequence = 0;
    for (const name of fs.readdirSync(root)) if (new RegExp('^media-[0-9a-f]{64}-' + recipeId + '$').test(name)) {
      const value = verifyOwner(path.join(root, name), 'cache');
      if (value.useSequence !== undefined && (!Number.isSafeInteger(value.useSequence) || value.useSequence < 1)) fail('最近使用记录损坏。');
      sequence = Math.max(sequence, value.useSequence || 0);
    }
    if (!Number.isSafeInteger(sequence + 1)) fail('最近使用序号超过安全范围。');
    const data = jsonBytes({ ...old, lastUsedAt: Date.now(), useSequence: sequence + 1 });
    // Atomic metadata replacement preserves the complete cache if the process
    // exits before rename. An unconfirmed owner.next is never guessed away.
    const next = path.join(dir, 'owner.next.json'); charge(job, data.length);
    const fd = fs.openSync(next, 'wx'), identity = fs.fstatSync(fd); let written = 0, fdClosed = false;
    try {
      writeAll(fd, data, 0, n => { written += n; }); fs.fsyncSync(fd); fs.closeSync(fd); fdClosed = true;
      if (leafSnapshot(next).sha256 !== sha(data) || JSON.stringify(leafSnapshot(markerPath)) !== JSON.stringify(before))
        fail('最近使用更新前标记已变化。');
      assertWriter(job); fs.renameSync(next, markerPath); job.disk -= before.bytes;
    } catch (error) {
      try {
        if (!fdClosed) { fs.closeSync(fd); fdClosed = true; }
        assertWriter(job, true); const current = regular(next);
        if (!sameFile(identity, current) || current.size !== written || !fs.readFileSync(next).equals(data.subarray(0, written)))
          fail('最近使用临时标记身份不明；保留原件。');
        fs.unlinkSync(next); job.disk -= data.length;
      } catch (cleanupError) { error.cleanupError = cleanupError.message; }
      throw error;
    }
  }
  function verifyReapRecord(name) {
    const match = /^reap-([0-9a-f]{24})(\.result)?\.json$/.exec(name);
    if (!match) fail('未知残留恢复记录。');
    const value = readJSON(path.join(root, name));
    if (value.schema !== 1 || value.owner !== OWNER || value.recipe !== RECIPE || value.root !== root || value.token !== match[1] ||
      value.kind !== (match[2] ? 'reap-result' : 'reap-plan')) fail('残留恢复记录所有权不符。');
    if (match[2]) {
      if (value.status !== 'completed' || !Number.isSafeInteger(value.freedBytes) || value.freedBytes < 0 || !/^[0-9a-f]{64}$/.test(value.planSha256)) fail('恢复回执不完整。');
    } else if (!Array.isArray(value.records) || !value.records.length || value.records.some(record =>
      !record.file || !/^(?:writer\.lock|lease-[0-9a-f]{24}\.json)$/.test(record.file.file) ||
      !/^[0-9a-f]{64}$/.test(record.file.sha256) || !Array.isArray(record.file.identity) || record.file.identity.length !== 4 ||
      !Number.isSafeInteger(record.file.bytes) || record.file.bytes < 0 || !record.ownerRecord || record.ownerRecord.root !== root))
      fail('恢复计划含未授权的路径或身份。');
    return value;
  }
  function requireReapCompleted(name) {
    const value = verifyReapRecord(name), planName = name.replace('.result.json', '.json'), resultName = planName.replace('.json', '.result.json');
    if (!fs.existsSync(path.join(root, planName)) || !fs.existsSync(path.join(root, resultName))) fail('残留恢复尚未完成；保留原件。');
    verifyReapRecord(planName);
    if (verifyReapRecord(resultName).planSha256 !== leafSnapshot(path.join(root, planName)).sha256) fail('恢复回执与原始清单指纹不符。');
    return value;
  }
  function orphanPartialPlan(dir, writer) {
    const marker = readJSON(path.join(dir, 'owner.json'));
    if (marker.schema !== 1 || marker.owner !== OWNER || marker.recipe !== RECIPE || marker.root !== root ||
      !['partial', 'cache'].includes(marker.kind) || marker.token !== writer.token) fail('残留临时目录所有权不符。');
    const names = fs.readdirSync(dir), ledgerPath = path.join(dir, 'transaction.log');
    if (names.includes('transaction.log')) {
      const ledger = regular(ledgerPath); if (ledger.size > LIMITS.metadataBytes) fail('残留临时账本越界。');
      const text = fs.readFileSync(ledgerPath, 'utf8');
      if (text && !text.endsWith('\n')) fail('残留临时账本未完整提交；保留。');
      const entries = text ? text.trimEnd().split('\n').map(line => JSON.parse(line)) : [];
      const expected = new Map();
      for (const item of entries) {
        safeName(item.file);
        if (['owner.json', 'transaction.log', 'owner.next.json', 'writer.lock'].includes(item.file) || expected.has(item.file) ||
          !Number.isSafeInteger(item.dev) || !Number.isSafeInteger(item.ino)) fail('残留临时账本含未知输出。');
        expected.set(item.file, item);
      }
      if (names.length !== expected.size + 2 || names.some(name => !['owner.json', 'transaction.log'].includes(name) && !expected.has(name)))
        fail('残留临时目录含未登记文件；未删除。');
      for (const [name, item] of expected) {
        const stat = regular(path.join(dir, name));
        if (stat.dev !== item.dev || stat.ino !== item.ino || stat.size > (name === 'manifest.json' ? LIMITS.metadataBytes : LIMITS.assetBytes))
          fail('残留输出身份或容量不符。');
      }
    } else {
      // Crash after the ledger was removed but before atomic directory publish:
      // the finished manifest is the only acceptable replacement file list.
      const inspected = inspectDirectory(dir, marker.kind, writer.sourceSha256);
      for (const item of inspected.map.values()) if (leafSnapshot(path.join(dir, item.file)).sha256 !== item.sha256) fail('残留完整清单资产指纹不符。');
    }
    const identity = directory(dir);
    return ownerValue('cleanup-plan', { token: nonce(), writerToken: writer.token, directory: dir,
      directoryIdentity: [identity.dev, identity.ino], cacheToken: marker.token, targetKind: marker.kind,
      reason: 'orphaned-incomplete-cache', createdAt: Date.now(), files: names.sort().map(name => leafSnapshot(path.join(dir, name))) });
  }
  function recoverOrphans() {
    if (!fs.existsSync(root)) return;
    verifyRoot();
    const guardPath = path.join(root, 'recovery.lock');
    if (fs.existsSync(guardPath)) {
      const error = new Error('缓存恢复仍被占用或留有未确认的恢复锁；保留原件。'); error.code = 'CACHE_BUSY'; throw error;
    }
    const names = fs.readdirSync(root), pending = names.filter(name => /^reap-[0-9a-f]{24}\.json$/.test(name) &&
      !fs.existsSync(path.join(root, name.replace(/\.json$/, '.result.json'))));
    const records = [], partialPlans = [];
    for (const name of names.filter(name => name === 'writer.lock' || /^lease-[0-9a-f]{24}\.json$/.test(name))) {
      const file = path.join(root, name); let value;
      try { value = readJSON(file); } catch (_) { continue; } // Unknown locks are never reaped.
      if (value.schema !== 1 || value.owner !== OWNER || value.recipe !== RECIPE || value.root !== root || value.pid !== value.processIdentity?.pid ||
        value.kind !== (name === 'writer.lock' ? 'writer' : 'lease') || !/^[0-9a-f]{24}$/.test(value.token)) continue;
      if (name === 'writer.lock' && !/^[0-9a-f]{64}$/.test(value.sourceSha256 || '')) continue;
      if (name !== 'writer.lock' && (value.token !== name.slice(6, -5) ||
        value.cacheDir !== path.join(root, 'media-' + value.sourceSha256 + '-' + recipeId))) continue;
      if (!processIdentity.inspect(value).safe) continue;
      records.push({ file: leafSnapshot(file), ownerRecord: value });
      if (name === 'writer.lock') for (const child of names.filter(name => /^partial-[0-9a-f]{24}$/.test(name))) {
        const plan = orphanPartialPlan(path.join(root, child), value);
        const prior = names.filter(name => /^cleanup-[0-9a-f]{24}\.json$/.test(name)).map(verifyCleanupRecord)
          .find(old => old.directory === plan.directory && !fs.existsSync(path.join(root, 'cleanup-' + old.token + '.result.json')));
        if (prior) {
          if (prior.cacheToken !== plan.cacheToken || JSON.stringify(prior.files) !== JSON.stringify(plan.files)) fail('已有残留清理计划与当前文件不符。');
        } else partialPlans.push(plan);
      }
    }
    if (names.includes('writer.lock') && !records.some(item => item.file.file === 'writer.lock')) return;
    if (!records.length && !pending.length) return;
    const token = nonce(), guardData = jsonBytes(ownerValue('recovery', { token, pid: process.pid, processIdentity: processIdentity.self(), children: [] }));
    const guardFd = fs.openSync(guardPath, 'wx'), guardIdentity = fs.fstatSync(guardFd); let guardWritten = 0;
    function ownGuard() {
      verifyRoot(); const stat = regular(guardPath);
      if (!sameFile(guardIdentity, stat) || !fs.readFileSync(guardPath).equals(guardData)) fail('恢复锁身份已改变。');
      const writer = path.join(root, 'writer.lock');
      if (fs.existsSync(writer)) {
        const captured = records.find(item => item.file.file === 'writer.lock');
        if (!captured || JSON.stringify(leafSnapshot(writer)) !== JSON.stringify(captured.file)) fail('恢复期间出现另一准备事务；停止恢复。');
      }
    }
    try {
      writeAll(guardFd, guardData, 0, n => { guardWritten += n; }); fs.fsyncSync(guardFd); fs.closeSync(guardFd);
      ownGuard();
      // Validate and account every current leaf before any delete. No recursive
      // remove, links, unknown root entries or anonymous partial are accepted.
      let used = 0;
      for (const name of fs.readdirSync(root)) {
        const file = path.join(root, name), stat = fs.lstatSync(file);
        if (stat.isDirectory()) {
          if (!new RegExp('^media-[0-9a-f]{64}-' + recipeId + '$').test(name) && !partialPlans.some(plan => plan.directory === file) &&
            !fs.readdirSync(root).some(leaf => /^cleanup-[0-9a-f]{24}\.json$/.test(leaf) && verifyCleanupRecord(leaf).directory === file)) fail('恢复根含未知目录。');
          directory(file);
          if (name.startsWith('media-')) inspectDirectory(file, 'cache', name.slice(6, 70));
          for (const leaf of fs.readdirSync(file)) used += regular(path.join(file, leaf)).size;
        } else {
          if (!['owner.json', 'writer.lock', 'recovery.lock'].includes(name) && !/^lease-[0-9a-f]{24}\.json$/.test(name) &&
            !/^(?:cleanup|reap)-[0-9a-f]{24}(?:\.result)?\.json$/.test(name)) fail('恢复根含未知文件。');
          if (name.startsWith('cleanup-')) verifyCleanupRecord(name);
          if (name.startsWith('reap-')) verifyReapRecord(name);
          used += regular(file).size;
        }
      }
      const plans = partialPlans.map(plan => ({ plan, data: jsonBytes(plan) }));
      const reaps = pending.map(name => ({ name, plan: verifyReapRecord(name), data: fs.readFileSync(path.join(root, name)) }));
      if (records.length) {
        const plan = ownerValue('reap-plan', { token: nonce(), records, createdAt: Date.now() });
        reaps.push({ name: 'reap-' + plan.token + '.json', plan, data: jsonBytes(plan), fresh: true });
      }
      const needed = plans.reduce((n, p) => n + p.data.length, 0) + reaps.reduce((n, p) => n + (p.fresh ? p.data.length : 0) + 4096, 0);
      if (!Number.isSafeInteger(used) || used + needed > diskBytes) fail('没有空间预留恢复清单及回执；未删除。');
      for (const item of records) if (!processIdentity.inspect(item.ownerRecord).safe) fail('恢复前任务终止证据不足；保留。');
      for (const item of records) if (JSON.stringify(leafSnapshot(path.join(root, item.file.file))) !== JSON.stringify(item.file)) fail('恢复前任务记录已变化。');
      for (const { plan, data } of plans) { ownGuard(); writeRecord(path.join(root, 'cleanup-' + plan.token + '.json'), data); }
      for (const reap of reaps) {
        ownGuard();
        if (reap.fresh) writeRecord(path.join(root, reap.name), reap.data);
        for (const item of reap.plan.records) {
          if (!processIdentity.inspect(item.ownerRecord).safe) fail('恢复任务身份仍不确定；未删除该项。');
          const file = path.join(root, item.file.file);
          if (fs.existsSync(file) && JSON.stringify(leafSnapshot(file)) !== JSON.stringify(item.file)) fail('恢复目标已经替换；未删除。');
        }
        let freedBytes = 0;
        for (const item of reap.plan.records) {
          ownGuard(); const file = path.join(root, item.file.file);
          if (!fs.existsSync(file)) continue;
          if (JSON.stringify(leafSnapshot(file)) !== JSON.stringify(item.file)) fail('恢复删除前目标已变化。');
          fs.unlinkSync(file); freedBytes += item.file.bytes;
        }
        writeRecord(path.join(root, reap.name.replace(/\.json$/, '.result.json')),
          jsonBytes(ownerValue('reap-result', { token: reap.plan.token, status: 'completed', freedBytes, planSha256: sha(reap.data), completedAt: Date.now() })));
      }
    } finally {
      try { fs.closeSync(guardFd); } catch (_) { /* Already closed. */ }
      const current = regular(guardPath);
      if (!sameFile(guardIdentity, current) || current.size !== guardWritten || !fs.readFileSync(guardPath).equals(guardData.subarray(0, guardWritten)))
        fail('恢复锁身份未知；保留。');
      fs.unlinkSync(guardPath);
    }
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
    recoverOrphans();
    const lockPath = path.join(root, 'writer.lock'); let fd;
    try { fd = fs.openSync(lockPath, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') { error.message = '缓存已有占用记录，无法开始准备；未确认的写锁会保留。'; error.code = 'CACHE_BUSY'; }
      throw error;
    }
    const job = { token: nonce(), signal, closed: false, partial: null, published: false, disk: 0, initializing: true,
      target: path.join(root, 'media-' + sourceSha256 + '-' + recipeId),
      files: new Map(), streams: new Set(), closingStreams: new Set(), lockIdentity: fs.fstatSync(fd) };
    activeRoots.add(root);
    const writer = ownerValue('writer', { token: job.token, pid: process.pid, sourceSha256, processIdentity: processIdentity.self(), children: [] });
    const lockData = jsonBytes(writer); job.lockSha = sha(lockData);
    let lockWritten = 0;
    try {
      job.disk = usage(job); charge(job, lockData.length);
      writeAll(fd, lockData, 0, count => { lockWritten += count; }); fs.closeSync(fd);
      assertWriter(job);
      job.initializing = false;
      resumeCleanup(job);
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
    function updateWriter() {
      assertWriter(job, true); const data = jsonBytes(writer), current = regular(lockPath), oldBytes = current.size;
      if (data.length > oldBytes) charge(job, data.length - oldBytes);
      const out = fs.openSync(lockPath, 'r+');
      try {
        if (!sameFile(job.lockIdentity, fs.fstatSync(out))) fail('更新任务登记前写锁身份已改变。');
        writeAll(out, data, 0); fs.ftruncateSync(out, data.length); fs.fsyncSync(out);
      } finally { fs.closeSync(out); }
      job.lockSha = sha(data); if (data.length < oldBytes) job.disk -= oldBytes - data.length;
      assertWriter(job, true);
    }
    function beforeSpawn() {
      assertWriter(job); if (writer.children.length >= 32) fail('本次辅助进程登记超过上限。');
      const token = nonce(); writer.children.push({ token, state: 'starting', identity: null });
      try { updateWriter(); } catch (error) { writer.children.pop(); throw error; } return token;
    }
    function childStarted(token, pid) {
      const item = writer.children.find(child => child.token === token);
      if (!item || item.state !== 'starting') fail('辅助进程启动登记不符。');
      item.state = 'running'; item.identity = Number.isSafeInteger(pid) && pid > 0 ? processIdentity.child(pid) : null; updateWriter();
    }
    function childClosed(token) {
      const item = writer.children.find(child => child.token === token);
      if (!item || item.state === 'closed') return;
      item.state = 'closed'; updateWriter();
    }
    function ledgerEntry(name, identity) {
      const ledger = job.ledger;
      if (!ledger || ledger.closed) fail('临时文件归属账本已关闭。');
      const current = regular(path.join(job.partial, 'transaction.log'));
      if (!sameFile(ledger.identity, current) || !sameFile(ledger.identity, fs.fstatSync(ledger.fd)) || current.size !== ledger.bytes) fail('临时账本身份已改变。');
      const data = Buffer.from(JSON.stringify({ file: name, dev: identity.dev, ino: identity.ino }) + '\n');
      if (ledger.bytes + data.length > LIMITS.metadataBytes) fail('临时归属账本超过上限。');
      let at = 0;
      charge(job, data.length); writeAll(ledger.fd, data, ledger.bytes, n => { ledger.hash.update(data.subarray(at, at + n)); at += n; ledger.bytes += n; });
    }
    function closeLedger(remove = false) {
      const ledger = job.ledger; if (!ledger) return;
      if (!ledger.closed) { try { fs.fsyncSync(ledger.fd); } finally { fs.closeSync(ledger.fd); ledger.closed = true; } }
      if (remove && !ledger.removed) {
        const file = path.join(job.partial, 'transaction.log'), stat = regular(file);
        if (!sameFile(ledger.identity, stat) || stat.size !== ledger.bytes || leafSnapshot(file).sha256 !== ledger.hash.copy().digest('hex')) fail('临时账本身份已变化。');
        fs.unlinkSync(file); job.disk -= stat.size; ledger.removed = true;
      }
    }
    function ensurePartial() {
      assertWriter(job);
      if (candidate || job.published) fail('完整缓存不能作为临时写入目标。');
      if (!job.partial) {
        const dir = path.join(root, 'partial-' + nonce()), data = jsonBytes(ownerValue('partial', { token: job.token }));
        charge(job, data.length); fs.mkdirSync(dir); job.partial = dir;
        fs.writeFileSync(path.join(dir, 'owner.json'), data, { flag: 'wx' });
        const ledgerFd = fs.openSync(path.join(dir, 'transaction.log'), 'wx+');
        job.ledger = { fd: ledgerFd, identity: fs.fstatSync(ledgerFd), bytes: 0, closed: false, removed: false, hash: crypto.createHash('sha256') };
      }
      const marker = verifyOwner(job.partial, 'partial'); if (marker.token !== job.token) fail('临时缓存事务身份已改变。');
    }
    function openAsset(name, internal = false) {
      safeName(name);
      if ((!internal && ['owner.json', 'manifest.json', 'writer.lock', 'transaction.log', 'owner.next.json'].includes(name)) || job.files.has(name)) fail('缓存文件已登记或属于保留名称。');
      ensurePartial();
      const file = path.join(job.partial, name), fileFd = fs.openSync(file, 'wx+');
      const record = { file: name, bytes: 0, identity: fs.fstatSync(fileFd), closed: false, sha256: null };
      job.files.set(name, record); job.streams.add(record); let closing = null;
      try { ledgerEntry(name, record.identity); }
      catch (error) { fs.closeSync(fileFd); record.closed = true; job.streams.delete(record); throw error; }
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
      safeName(name);
      if ((!internal && ['owner.json', 'manifest.json', 'writer.lock', 'transaction.log', 'owner.next.json'].includes(name)) || job.files.has(name)) fail('缓存文件已登记或属于保留名称。');
      if (!Buffer.isBuffer(data)) fail('缓存输出只接受Buffer。');
      if (data.length > (internal ? LIMITS.metadataBytes : LIMITS.assetBytes)) fail('单个缓存资产超过上限。');
      // Whole JPEG/metadata buffers need no streaming boundary. Verify the
      // root, writer and partial once, then create/write/check/close without
      // an await. Audio's streaming API retains its per-operation guards.
      ensurePartial();
      const file = path.join(job.partial, name), fileFd = fs.openSync(file, 'wx+');
      const record = { file: name, bytes: 0, identity: null, closed: false, sha256: null };
      job.files.set(name, record); job.streams.add(record); let primaryError = null;
      try {
        record.identity = fs.fstatSync(fileFd);
        ledgerEntry(name, record.identity);
        const openedPath = regular(file);
        if (!sameFile(record.identity, openedPath) || openedPath.size !== 0 || record.identity.size !== 0) fail('缓存输出文件身份或长度已改变。');
        charge(job, data.length);
        writeAll(fileFd, data, 0, count => { record.bytes += count; });
        const written = fs.fstatSync(fileFd), current = regular(file);
        if (!sameFile(record.identity, written) || !sameFile(record.identity, current) || written.size !== record.bytes || current.size !== record.bytes)
          fail('关闭时缓存输出身份已改变。');
        cancelled(job.signal);
        // This is the expected content hash. finish() still reads every actual
        // asset from disk and checks the hash before it can publish the cache.
        record.sha256 = sha(data);
        return Object.freeze({ file: name, bytes: record.bytes, sha256: record.sha256 });
      } catch (error) { primaryError = error; throw error; }
      finally {
        try { fs.closeSync(fileFd); record.closed = true; job.streams.delete(record); }
        catch (error) { if (primaryError) primaryError.closeError = error.message; else throw error; }
      }
    }
    async function readComplete() {
      assertWriter(job);
      if (job.partial || job.published) fail('已经开始写入，不能再读取复用候选。');
      if (candidate) return candidate;
      if (!fs.existsSync(target)) return null;
      const inspected = inspectDirectory(target, 'cache', sourceSha256, true); let damaged = !inspected.lengthsMatch;
      for (const item of inspected.map.values()) {
        if (await hashFile(path.join(target, item.file), signal) !== item.sha256) damaged = true;
        assertWriter(job);
      }
      if (damaged) { discardDamaged(job, target, inspected); return null; }
      candidate = inspected.info; candidatePinned = frozenCopy(candidate); return candidate;
    }
    function registerLease(persisted, currentSource, metrics) {
      assertWriter(job);
      const current = JSON.parse(jsonBytes(currentSource).toString('utf8'));
      if (current.sha256 !== sourceSha256) fail('当前素材绑定与源内容不符。');
      const id = nonce(), file = path.join(root, 'lease-' + id + '.json');
      const data = jsonBytes(ownerValue('lease', { token: id, pid: process.pid, cacheDir: target, sourceSha256,
        processIdentity: processIdentity.self(), children: [] }));
      const info = { ...JSON.parse(jsonBytes(persisted).toString('utf8')), source: current,
        ...(metrics ? { metrics: JSON.parse(jsonBytes(metrics).toString('utf8')) } : {}), cacheDir: target, leaseId: id };
      const map = manifestAssets(persisted, sourceSha256), capturedSource = frozenCopy(current);
      touch(job, target);
      charge(job, data.length); fs.writeFileSync(file, data, { flag: 'wx' });
      live.set(info, { active: true, id, file, cacheDir: target, source: capturedSource,
        markerSha: sha(data), markerIdentity: regular(file), map, reads: 0 });
      return info;
    }
    async function finish(manifest, currentSource) {
      assertWriter(job);
      if (finished) fail('缓存事务已提交。');
      if (!currentSource || currentSource.sha256 !== sourceSha256) fail('当前素材绑定与源内容不符。');
      if (job.streams.size || job.closingStreams.size) fail('必须先等待缓存输出流真正关闭。');
      if (writer.children.some(child => child.state !== 'closed')) fail('辅助进程仍未退出，不能发布完整缓存。');
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
      closeLedger(true);
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
      if (writer.children.some(child => child.state !== 'closed')) fail('辅助进程仍未退出，不能清理临时缓存。');
      if (!job.partial) return false;
      closeLedger();
      const marker = readJSON(path.join(job.partial, 'owner.json'));
      if (marker.owner !== OWNER || marker.recipe !== RECIPE || marker.root !== root || marker.token !== job.token || !['partial', 'cache'].includes(marker.kind))
        fail('临时缓存所有权未知，未执行删除。');
      directory(job.partial);
      const names = fs.readdirSync(job.partial), expected = new Set(['owner.json', ...job.files.keys(), ...(job.ledger && !job.ledger.removed ? ['transaction.log'] : [])]);
      if (names.length !== expected.size || names.some(name => !expected.has(name))) fail('临时缓存包含未知文件，未执行删除。');
      const sizes = new Map();
      for (const name of names) {
        const stat = regular(path.join(job.partial, name)), record = job.files.get(name);
        if (record && (!record.identity || !sameFile(record.identity, stat) || stat.size !== record.bytes)) fail('临时文件身份或长度已改变，未执行删除。');
        if (name === 'transaction.log' && (!sameFile(job.ledger.identity, stat) || stat.size !== job.ledger.bytes ||
          leafSnapshot(path.join(job.partial, name)).sha256 !== job.ledger.hash.copy().digest('hex'))) fail('临时账本身份或内容已改变；未删除。');
        sizes.set(name, stat.size);
      }
      // Validate every registered path before the first deletion; owner last.
      for (const name of names) if (name !== 'owner.json') fs.unlinkSync(path.join(job.partial, name));
      fs.unlinkSync(path.join(job.partial, 'owner.json')); fs.rmdirSync(job.partial);
      for (const size of sizes.values()) job.disk -= size;
      job.partial = null; job.files.clear(); return true;
    }
    return Object.freeze({ readComplete, writeAsset, openAsset, finish, abort, beforeSpawn, childStarted, childClosed,
      close() {
        if (job.streams.size || job.closingStreams.size || writer.children.some(child => child.state !== 'closed')) fail('输出流或辅助进程仍未关闭，不能释放写锁。');
        closeLedger(); return releaseWriter(job);
      } });
  }
  function leaseFor(info) {
    const lease = info && live.get(info);
    if (!lease || !lease.active || info.cacheDir !== lease.cacheDir || info.leaseId !== lease.id) fail('需要本缓存实例登记的原始有效句柄。');
    verifyRoot(); verifyOwner(lease.cacheDir, 'cache'); return lease;
  }
  async function readAsset(info, file) {
    const lease = leaseFor(info); safeName(file);
    const asset = lease.map.get(file); if (!asset || asset.bytes > LIMITS.assetBytes) fail('文件不在原始缓存句柄的资产表中。');
    const absolute = path.join(lease.cacheDir, file), before = regular(absolute); let handle;
    lease.reads++;
    try {
      handle = await fs.promises.open(absolute, 'r');
      if (before.size !== asset.bytes || !sameFile(before, await handle.stat())) fail('读取前缓存资产身份或长度不符。');
      const data = Buffer.alloc(asset.bytes); let at = 0;
      while (at < data.length) { const result = await handle.read(data, at, data.length - at, at); if (!result.bytesRead) fail('缓存资产读取不完整。'); at += result.bytesRead; }
      const after = await handle.stat(), current = regular(absolute);
      if (!sameFile(before, after) || !sameFile(before, current) || after.size !== asset.bytes || current.size !== asset.bytes || before.mtimeMs !== after.mtimeMs || before.mtimeMs !== current.mtimeMs || sha(data) !== asset.sha256)
        fail('缓存资产读取期间已改变。');
      leaseFor(info); return data;
    } finally { try { if (handle) await handle.close(); } finally { lease.reads--; } }
  }
  function release(info) {
    const lease = info && live.get(info); if (!lease || !lease.active) return false;
    if (lease.reads) fail('缓存读取尚未结束，不能释放占用记录。');
    leaseFor(info); const stat = regular(lease.file);
    if (!sameFile(lease.markerIdentity, stat) || sha(fs.readFileSync(lease.file)) !== lease.markerSha) fail('占用记录身份已改变；未执行删除。');
    fs.unlinkSync(lease.file); lease.active = false; return true;
  }
  // Read-only preflight, never a deletion capability or a liveness verdict.
  // A future maintenance transaction must reacquire exclusion and revalidate.
  function inventory() {
    directory(plugin);
    const base = { root, diskLimitBytes: diskBytes, deletionAuthorized: false, assetHashesVerified: false };
    if (!fs.existsSync(root)) return frozenCopy({ ...base, exists: false, usedBytes: 0, caches: [], leases: [] });
    const rootBefore = directory(root); verifyRoot();
    const names = fs.readdirSync(root).sort(), stamps = new Map();
    const stamp = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs]);
    function capture(file) { stamps.set(file, stamp(regular(file))); }
    if (names.includes('writer.lock')) { const error = new Error('缓存正在写入或留有未确认写锁，暂不盘点；未修改文件。'); error.code = 'CACHE_BUSY'; throw error; }
    const caches = [], leases = [];
    for (const name of names) {
      const file = path.join(root, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        const match = /^media-([0-9a-f]{64})-([0-9a-f]{12})$/.exec(name);
        if (!match || match[2] !== recipeId) fail('未知或未完成目录阻止盘点，原件保留。');
        directory(file); capture(path.join(file, 'owner.json')); capture(path.join(file, 'manifest.json'));
        const checked = inspectDirectory(file, 'cache', match[1]);
        for (const leaf of checked.names) if (!stamps.has(path.join(file, leaf))) capture(path.join(file, leaf));
        const owner = verifyOwner(file, 'cache');
        caches.push({ directory: file, sourceSha256: match[1], recipe: RECIPE, bytes: checked.totalBytes,
          assetCount: checked.map.size, leaseCount: 0, protected: false, lastUsedAt: owner.lastUsedAt || null, useSequence: owner.useSequence || null });
      } else {
        capture(file);
        if (name === 'owner.json') continue;
        if (/^reap-[0-9a-f]{24}(?:\.result)?\.json$/.test(name)) { requireReapCompleted(name); continue; }
        if (/^cleanup-[0-9a-f]{24}(?:\.result)?\.json$/.test(name)) {
          const record = verifyCleanupRecord(name);
          if (record.kind === 'cleanup-plan') {
            const resultName = name.replace(/\.json$/, '.result.json');
            if (!names.includes(resultName) || verifyCleanupRecord(resultName).planSha256 !== leafSnapshot(file).sha256)
              fail('清理事务未完成或回执不符；不提供盘点结果。');
          }
          continue;
        }
        if (!/^lease-[0-9a-f]{24}\.json$/.test(name)) fail('缓存根存在未知文件，停止盘点并保留原件。');
        const value = readJSON(file);
        if (value.owner !== OWNER || value.schema !== 1 || value.recipe !== RECIPE || value.root !== root || value.kind !== 'lease' ||
          value.token !== name.slice(6, -5) || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
          typeof value.cacheDir !== 'string' || !path.isAbsolute(value.cacheDir) || !samePath(path.dirname(value.cacheDir), root))
          fail('占用记录身份不明，停止盘点并保留原件。');
        leases.push({ file, cacheDir: value.cacheDir, sourceSha256: value.sourceSha256, pid: value.pid, liveness: 'not-checked' });
      }
    }
    for (const lease of leases) {
      const item = caches.find(value => samePath(value.directory, lease.cacheDir));
      if (!item || item.sourceSha256 !== lease.sourceSha256) fail('占用记录与完整缓存不匹配，停止盘点。');
      item.leaseCount++; item.protected = true;
    }
    let usedBytes = 0;
    for (const [file, before] of stamps) {
      const stat = regular(file); if (stamp(stat) !== before) fail('盘点期间缓存文件已变化，丢弃本次结果。');
      usedBytes += stat.size;
      if (!Number.isSafeInteger(usedBytes) || usedBytes > diskBytes) fail('缓存现有容量超过预算。');
    }
    for (const item of caches) {
      const leaves = fs.readdirSync(item.directory).sort(), captured = [...stamps.keys()]
        .filter(file => samePath(path.dirname(file), item.directory)).map(file => path.basename(file)).sort();
      if (JSON.stringify(leaves) !== JSON.stringify(captured)) fail('盘点期间缓存目录内容已变化。');
    }
    const rootAfter = directory(root); verifyRoot();
    if (rootBefore.dev !== rootAfter.dev || rootBefore.ino !== rootAfter.ino ||
      JSON.stringify(names) !== JSON.stringify(fs.readdirSync(root).sort())) fail('盘点期间缓存根已变化，丢弃本次结果。');
    return frozenCopy({ ...base, exists: true, usedBytes, caches, leases });
  }
  return Object.freeze({ root, begin, readAsset, release, inventory });
}

module.exports = { createCache, OWNER, RECIPE, LIMITS };
