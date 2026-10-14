'use strict';
// Local RAM preference only. No Eagle/library access or media/cache deletion.
const fs = require('fs'), path = require('path'), os = require('os');
const OWNER = 'eva-memory-preference-v1', DEFAULT_BYTES = 1024 ** 3, MAX_FILE = 4096;
const OPTIONS = Object.freeze([512, ...Array.from({ length: 10 }, (_, i) => (i + 1) * 1024)]);
function memoryValue(total, ramMiB, persisted = false) {
  if (!Number.isSafeInteger(total) || total <= 0 || !OPTIONS.includes(ramMiB))
    throw new Error('请选择512MB或1GB至10GB的缓存额度。');
  const ramBytes = ramMiB * 1024 ** 2;
  if (ramBytes > total) throw new Error('缓存额度不能超过本机物理内存。');
  return Object.freeze({ ramMiB, ramBytes, compressedRamBytes: Math.floor(ramBytes / 8), totalRamBytes: total, persisted });
}
function createMemoryPreferences(options) {
  const io = options.io || fs, root = path.resolve(options.pluginRoot), total = options.totalRamBytes === undefined ? os.totalmem() : options.totalRamBytes;
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  function checkRoot() {
    const s = io.lstatSync(root);
    if (!s.isDirectory() || s.isSymbolicLink() || !same(io.realpathSync(root), root)) throw new Error('内存设置目录身份不符。');
  }
  const file = path.join(root, 'memory-settings.json'), temp = path.join(root, 'memory-settings.next.json');
  function stat(name) {
    try { const s = io.lstatSync(name);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > MAX_FILE || !same(io.realpathSync(name), name)) throw new Error('内存设置文件不安全或超过4KiB。');
      return s;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  const identity = s => s ? [s.dev, s.ino, s.size, s.mtimeMs].join(':') : null;
  function read() {
    checkRoot(); const before = stat(file); if (!before) return null;
    const bytes = io.readFileSync(file);
    if (identity(before) !== identity(stat(file)) || bytes.length !== before.size) throw new Error('内存设置读取期间改变。');
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.owner !== OWNER) throw new Error('内存设置格式无法识别；原件已保留。');
    if (Object.keys(value).sort().join(',') === 'owner,percent') {
      if (!Number.isFinite(value.percent) || value.percent <= 0 || value.percent > 100) throw new Error('旧内存设置无效；原件已保留。');
      // Read old percentages without rewriting; show the nearest available tier.
      const oldMiB = total * (value.percent / 100) / 1024 ** 2;
      const candidates = OPTIONS.filter(n => n * 1024 ** 2 <= total);
      const tier = candidates.reduce((a, b) => Math.abs(b - oldMiB) < Math.abs(a - oldMiB) ? b : a, candidates[0]);
      return Object.freeze({ ...memoryValue(total, tier, true), legacyConverted: true });
    }
    if (Object.keys(value).sort().join(',') !== 'owner,ramMiB') throw new Error('内存设置格式无法识别；原件已保留。');
    return memoryValue(total, value.ramMiB, true);
  }
  let current = read() || memoryValue(total, DEFAULT_BYTES / 1024 ** 2);
  return Object.freeze({ snapshot: () => current, preview: ramMiB => memoryValue(total, ramMiB), save(ramMiB) {
    const next = memoryValue(total, ramMiB, true); checkRoot(); read(); const before = identity(stat(file));
    const bytes = Buffer.from(JSON.stringify({ owner: OWNER, ramMiB }, null, 2));
    let fd = null, owned = null;
    try {
      fd = io.openSync(temp, 'wx'); owned = io.fstatSync(fd);
      io.writeFileSync(fd, bytes); io.fsyncSync(fd); io.closeSync(fd); fd = null;
      checkRoot();
      if (identity(stat(file)) !== before || !io.readFileSync(temp).equals(bytes)) throw new Error('内存设置保存期间改变，未覆盖原件。');
      const s = stat(temp);
      if (!s || s.dev !== owned.dev || s.ino !== owned.ino) throw new Error('内存设置临时文件身份改变。');
      io.renameSync(temp, file); owned = null; current = next; return current;
    } finally {
      if (fd !== null) io.closeSync(fd);
      if (owned) { const s = stat(temp); if (s && s.dev === owned.dev && s.ino === owned.ino) io.unlinkSync(temp); }
    }
  } });
}
module.exports = { createMemoryPreferences, memoryValue, OWNER, DEFAULT_BYTES, OPTIONS };
