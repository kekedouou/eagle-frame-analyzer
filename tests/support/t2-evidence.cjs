'use strict';
// T2 records have an independent fixed quota. Exact payloads are reused only
// after validating the existing bytes; failures/new rounds are never removed.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const OWNER = 'eagle-video-analysis-T2-evidence-v1';
const LIMITS = Object.freeze({ totalBytes: 16 * 1024 ** 2, fileBytes: 2 * 1024 ** 2 });
const runPattern = /^t2-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{20}$/;
const kinds = ['checks', 'cache', 'host', 'lifecycle', 'cleanup', 'audit'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  const clean = JSON.parse(JSON.stringify(value));
  function sorted(item) {
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(sorted);
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])]));
  }
  return JSON.stringify(sorted(clean));
}
function encode(value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  if (bytes.length > LIMITS.fileBytes) throw new Error('T2 receipt exceeds 2MiB; original records retained.');
  return bytes;
}
function budget(used, delta) {
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(delta) || used < 0 || delta < 0 || used + delta > LIMITS.totalBytes)
    throw new Error('T2 evidence exceeds 16MiB; original records retained.');
}
function createStore(repo, options = {}) {
  // T3 reuses the append-only storage safeguards, with an independent namespace
  // and quota. Historical T2 bytes/schema/owner remain unchanged.
  if (options.stage !== undefined && !['T2', 'T3'].includes(options.stage)) throw new Error('Unknown evidence stage.');
  const stage = options.stage || 'T2', prefix = stage.toLowerCase();
  const ownerName = stage === 'T2' ? OWNER : 'eagle-video-analysis-T3-evidence-v1';
  const schemaName = prefix + '-evidence-v1';
  const pattern = stage === 'T2' ? runPattern : /^t3-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{20}$/;
  const io = options.fs || fs, token = options.token || crypto.randomBytes(10).toString('hex');
  const root = path.join(path.resolve(repo), 'verification-runs'), lock = path.join(root, prefix + '-writer.lock');
  const id = prefix + '-' + (options.timestamp || new Date().toISOString()).replace(/[:.]/g, '-') + '-' + token;
  if (!pattern.test(id)) throw new Error('Invalid evidence run identity.');
  const run = path.join(root, id); let started = false, identity, lockData, reserve = 0, savedBytes = 0, sequence = 0;
  function node(file, dir = false) {
    const stat = io.lstatSync(file), real = io.realpathSync(file), absolute = path.resolve(file);
    if (stat.isSymbolicLink() || (dir ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (process.platform === 'win32' ? real.toLowerCase() !== absolute.toLowerCase() : real !== absolute))
      throw new Error('T2 evidence requires canonical, unique files/directories without links.');
    return stat;
  }
  function read(file) {
    const before = node(file); if (before.size > LIMITS.fileBytes) throw new Error('T2 existing receipt exceeds 2MiB.');
    const bytes = io.readFileSync(file), after = node(file);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size)
      throw new Error('T2 evidence changed during reading.');
    return { bytes, value: JSON.parse(bytes), identity: before };
  }
  function ownLock() {
    if (!started) throw new Error('T2 original live writer lock required.');
    node(root, true); const item = read(lock);
    if (item.identity.ino !== identity.ino || item.identity.dev !== identity.dev || !item.bytes.equals(lockData))
      throw new Error('T2 writer lock changed; retained.');
  }
  function scan() {
    node(root, true); let used = 0; const receipts = [];
    for (const name of io.readdirSync(root)) {
      if (name === prefix + '-writer.lock') { ownLock(); used += node(lock).size; continue; }
      if (!name.startsWith(prefix + '-')) continue;
      if (!pattern.test(name)) throw new Error('Unknown evidence path; retained.');
      const dir = path.join(root, name); node(dir, true);
      const owner = read(path.join(dir, 'owner.json')).value;
      if (owner.schema !== 1 || owner.owner !== ownerName || owner.kind !== 'evidence' || owner.root !== root || owner.runId !== name)
        throw new Error('Unknown T2 evidence owner; retained.');
      for (const leaf of io.readdirSync(dir)) {
        if (leaf !== 'owner.json' && leaf !== 'checks.json' && !/^(?:checks|cache|host|lifecycle|cleanup|audit)-[0-9a-f]{20}-\d{1,4}\.json$/.test(leaf))
          throw new Error('Unknown T2 evidence file; retained.');
        const file = path.join(dir, leaf), item = read(file); used += item.bytes.length; budget(used, 0);
        if (leaf === 'owner.json' || leaf === 'checks.json') continue; // Sealed first inventory receipt.
        const value = item.value;
        if (value.schema !== schemaName || !kinds.includes(value.kind) || !leaf.startsWith(value.kind + '-') ||
          value.key !== sha(Buffer.from(canonical(value.payload)))) throw new Error('T2 receipt fingerprint is invalid; retained.');
        receipts.push({ file, ...item });
      }
    }
    budget(used, 0); return { used, receipts };
  }
  function close() { if (!started) return false; ownLock(); io.unlinkSync(lock); started = false; return true; }
  function start({ reserveBytes = LIMITS.fileBytes } = {}) {
    if (started || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || reserveBytes > LIMITS.totalBytes) throw new Error('Invalid T2 evidence reservation.');
    node(path.resolve(repo), true); if (/^c:/i.test(root)) throw new Error('T2 evidence cannot be on C.');
    if (!io.existsSync(root)) io.mkdirSync(root); node(root, true);
    lockData = encode({ schema: 1, owner: ownerName, kind: 'writer', root, token, pid: process.pid });
    io.writeFileSync(lock, lockData, { flag: 'wx' }); identity = node(lock); started = true;
    try {
      const marker = encode({ schema: 1, owner: ownerName, kind: 'evidence', root, runId: id });
      budget(scan().used, marker.length + reserveBytes); reserve = reserveBytes;
      return { runId: id, limits: LIMITS, reserveBytes };
    } catch (error) { try { close(); } catch (cleanup) { error.cleanupError = cleanup.message; } throw error; }
  }
  function save(kind, payload) {
    if (!kinds.includes(kind) || sequence > 9999) throw new Error('Invalid T2 receipt kind/count.');
    ownLock(); const normalized = JSON.parse(canonical(payload)), key = sha(Buffer.from(canonical(normalized))), current = scan();
    const prior = current.receipts.find(item => item.value.kind === kind && item.value.key === key);
    if (prior) return { file: prior.file, bytes: prior.bytes.length, sha256: sha(prior.bytes), reused: true, totalBytes: current.used };
    const bytes = encode({ schema: schemaName, kind, key, payload: normalized });
    if (savedBytes + bytes.length > reserve) throw new Error('T2 run exceeds reserved receipt bytes.');
    const marker = encode({ schema: 1, owner: ownerName, kind: 'evidence', root, runId: id });
    budget(current.used, bytes.length + (sequence ? 0 : marker.length));
    if (!sequence) { if (io.existsSync(run)) throw new Error('T2 run already exists; retained.'); io.mkdirSync(run); node(run, true); io.writeFileSync(path.join(run, 'owner.json'), marker, { flag: 'wx' }); }
    const file = path.join(run, kind + '-' + token + '-' + sequence + '.json');
    io.writeFileSync(file, bytes, { flag: 'wx' });
    const confirmed = read(file); if (!confirmed.bytes.equals(bytes)) throw new Error('T2 receipt write verification failed; retained.');
    sequence++; savedBytes += bytes.length;
    return { file, bytes: bytes.length, sha256: sha(bytes), reused: false, totalBytes: scan().used };
  }
  function consumeOnce(scopeKey, payload) {
    if (stage !== 'T3' || !/^[0-9a-f]{64}$/.test(scopeKey)) throw new Error('Invalid T3 one-attempt scope.');
    ownLock();
    const prior = scan().receipts.find(item => item.value.kind === 'host' &&
      item.value.payload.schema === 't3-annotation-claim-v1' && item.value.payload.scopeKey === scopeKey);
    if (prior) return { allowed: false, file: prior.file };
    // Same exclusive evidence lock covers checking and persisting the claim.
    // A crash/failed API after this point cannot silently renew authorization.
    const receipt = save('host', { ...payload, schema: 't3-annotation-claim-v1', scopeKey });
    return { allowed: true, receipt };
  }
  return Object.freeze({ start, save, close, consumeOnce });
}
module.exports = { createStore, OWNER, LIMITS, _test: { canonical, encode, budget, runPattern } };
