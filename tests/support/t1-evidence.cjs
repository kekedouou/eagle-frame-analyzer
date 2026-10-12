'use strict';
// T1-only evidence. It never imports the T0 writer, resets caches or deletes
// receipts. One cross-process lock covers reserve -> work -> save -> close.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const OWNER = 'eagle-video-analysis-T1-evidence-v1';
const LIMITS = Object.freeze({ totalBytes: 16 * 1024 ** 2, fileBytes: 2 * 1024 ** 2 });
const runPattern = /^t1-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{20}$/;
function budget(used, delta) {
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(delta) || delta < 0 || !Number.isSafeInteger(used + delta) || used + delta > LIMITS.totalBytes)
    throw new Error('T1 evidence exceeds 16MiB; existing evidence is retained.');
  return used + delta;
}
function encode(value) {
  const data = Buffer.from(JSON.stringify(value, null, 2));
  if (data.length > LIMITS.fileBytes) throw new Error('T1 receipt exceeds 2MiB; no receipt was overwritten.');
  return data;
}
function createStore(repo, settings = {}) {
  const io = settings.fs || fs, token = settings.token || crypto.randomBytes(10).toString('hex');
  const root = path.join(path.resolve(repo), 'verification-runs');
  const id = 't1-' + (settings.timestamp || new Date().toISOString()).replace(/[:.]/g, '-') + '-' + token;
  if (!runPattern.test(id)) throw new Error('Invalid T1 run identity.');
  const run = path.join(root, id), lock = path.join(root, 't1-writer.lock');
  let identity = null, lockBytes = null, saved = 0, savedBytes = 0, reservedBytes = 0, started = false;
  const canonical = file => {
    const a = path.resolve(file), b = io.realpathSync(file);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  };
  function directory(dir) {
    const stat = io.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !canonical(dir)) throw new Error('T1 evidence directory must be canonical, without links.');
    return stat;
  }
  function regular(file) {
    const stat = io.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !canonical(file)) throw new Error('T1 evidence file must be a single-link regular file.');
    return stat;
  }
  const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev && b.nlink === 1 && b.isFile();
  function read(file) {
    const stat = regular(file); if (stat.size > LIMITS.fileBytes) throw new Error('Existing T1 evidence is larger than the per-file limit.');
    const data = io.readFileSync(file), after = regular(file);
    if (!sameFile(stat, after) || data.length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
      throw new Error('T1 evidence changed while reading.');
    return JSON.parse(data.toString('utf8'));
  }
  function ownLock() {
    if (!started || !identity) throw new Error('T1 evidence requires its original live writer lock.');
    directory(root); const stat = regular(lock), data = io.readFileSync(lock);
    if (!sameFile(identity, stat) || !data.equals(lockBytes)) throw new Error('T1 evidence lock identity changed; it was retained.');
  }
  function usage() {
    directory(root); let bytes = 0;
    for (const name of io.readdirSync(root)) {
      if (name === 't1-writer.lock') {
        ownLock(); bytes = budget(bytes, regular(lock).size); continue;
      }
      if (!name.startsWith('t1-')) continue; // T0 and PoC quotas remain independent.
      if (!runPattern.test(name)) throw new Error('Unknown T1 evidence path; no files were removed.');
      const dir = path.join(root, name); directory(dir);
      const marker = read(path.join(dir, 'owner.json'));
      if (marker.schema !== 1 || marker.owner !== OWNER || marker.kind !== 'evidence' || marker.root !== root || marker.runId !== name)
        throw new Error('Unknown T1 evidence owner; no files were removed.');
      for (const file of io.readdirSync(dir)) {
        if (file !== 'owner.json' && !/^(?:checks|media|cancel|host)-[0-9a-f]{20}-\d{1,4}\.json$/.test(file)) throw new Error('Unknown file in T1 evidence run.');
        const stat = regular(path.join(dir, file));
        if (stat.size > LIMITS.fileBytes) throw new Error('Existing T1 evidence exceeds per-file limit.');
        bytes = budget(bytes, stat.size);
      }
    }
    return bytes;
  }
  function close() {
    if (!started) return false;
    ownLock(); io.unlinkSync(lock); started = false; return true;
  }
  function start({ reserveBytes = LIMITS.fileBytes } = {}) {
    if (started) throw new Error('T1 evidence run already started.');
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 1 || reserveBytes > LIMITS.totalBytes) throw new Error('Invalid T1 evidence reservation.');
    directory(path.resolve(repo));
    if (/^c:/i.test(root)) throw new Error('T1 evidence output cannot be on C.');
    if (!io.existsSync(root)) io.mkdirSync(root);
    directory(root);
    lockBytes = encode({ schema: 1, owner: OWNER, kind: 'writer', root, token, pid: process.pid });
    // wx prevents another process from passing quota preflight concurrently.
    io.writeFileSync(lock, lockBytes, { flag: 'wx' }); identity = regular(lock); started = true;
    try {
      const marker = encode({ schema: 1, owner: OWNER, kind: 'evidence', root, runId: id });
      budget(usage(), marker.length + reserveBytes); reservedBytes = reserveBytes;
      return { runId: id, reserveBytes: marker.length + reserveBytes, limits: LIMITS };
    } catch (error) { try { close(); } catch (cleanup) { error.lockError = cleanup.message; } throw error; }
  }
  function save(kind, value) {
    if (saved >= 9999 || !['checks', 'media', 'cancel', 'host'].includes(kind)) throw new Error('Invalid T1 receipt kind or count.');
    ownLock(); const data = encode(value), marker = encode({ schema: 1, owner: OWNER, kind: 'evidence', root, runId: id });
    if (savedBytes + data.length > reservedBytes) throw new Error('T1 run exceeds its reserved receipt bytes.');
    budget(usage(), (saved ? 0 : marker.length) + data.length);
    if (!saved) {
      if (io.existsSync(run)) throw new Error('T1 run path already exists; no receipt was overwritten.');
      io.mkdirSync(run); directory(run);
      io.writeFileSync(path.join(run, 'owner.json'), marker, { flag: 'wx' });
    } else directory(run);
    const file = path.join(run, kind + '-' + token + '-' + saved + '.json');
    io.writeFileSync(file, data, { flag: 'wx' }); saved++; savedBytes += data.length;
    return { file, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), totalBytes: usage() };
  }
  return Object.freeze({ start, save, close });
}
module.exports = { createStore, OWNER, LIMITS, _test: { budget, encode, runPattern } };
