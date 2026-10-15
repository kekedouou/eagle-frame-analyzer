'use strict';
// Test records only. Atomic fixed slots bound concurrent/crashed writers without
// any global paper lock. The product never imports this module.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const LIMITS = Object.freeze({ totalBytes: 32 * 1024 ** 2, slotBytes: 128 * 1024, slots: 255, ownerBytes: 1024, payloadBytes: 2 * 1024 ** 2 });
const OWNER = 'eagle-video-analysis-T4-evidence-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function createStore(repo, options = {}) {
  const io = options.fs || fs, canonicalRepo = io.realpathSync(path.resolve(repo));
  const parent = path.join(canonicalRepo, 'verification-runs'), root = path.join(parent, 't4');
  const runId = options.runId || crypto.randomBytes(16).toString('hex');
  if (!/^[0-9a-f]{32}$/.test(runId)) throw new Error('Invalid T4 run ID.');
  const owner = { schema: 1, owner: OWNER, root, limits: LIMITS };
  let active = false, closed = false; const saved = new Map();
  function node(file, directory = false) {
    const s = io.lstatSync(file, { bigint: true }), canonical = io.realpathSync(file);
    if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile()) ||
        canonical.toLowerCase() !== path.resolve(file).toLowerCase() || !directory && String(s.nlink) !== '1')
      throw new Error('T4 record path/link boundary invalid.');
    return s;
  }
  function read(file, maximum) {
    const a = node(file); if (Number(a.size) > maximum) throw new Error('Existing T4 record exceeds slot boundary.');
    const b = io.readFileSync(file), after = node(file);
    if (['dev', 'ino', 'size', 'mtimeNs', 'mtimeMs'].some(k => String(a[k]) !== String(after[k])) || b.length !== Number(a.size))
      throw new Error('T4 record changed during reading.');
    return b;
  }
  function inventory() {
    node(parent, true); node(root, true);
    if (JSON.stringify(JSON.parse(read(path.join(root, 'phase.json'), LIMITS.ownerBytes))) !== JSON.stringify(owner))
      throw new Error('T4 phase owner mismatch.');
    const names = io.readdirSync(root), slots = []; let bytes = 0;
    for (const name of names) {
      if (name === 'phase.json') { bytes += Number(node(path.join(root, name)).size); continue; }
      if (!/^slot-\d{3}$/.test(name) || Number(name.slice(5)) >= LIMITS.slots) throw new Error('Unknown T4 phase content retained.');
      const dir = path.join(root, name); node(dir, true); const leaves = io.readdirSync(dir);
      if (leaves.some(n => n !== 'record.json') || leaves.length > 1) throw new Error('Unknown T4 slot content retained.');
      if (leaves.length) {
        // A different writer may still be appending its own new slot. The fixed
        // slot count is the hard capacity bound; do not reread a live partial.
        const stat = node(path.join(dir, 'record.json'));
        if (Number(stat.size) > LIMITS.slotBytes) throw new Error('Existing T4 record exceeds slot boundary.');
        bytes += Number(stat.size);
      }
      slots.push(name); // Empty/truncated allocations remain history, not a lock.
    }
    if (bytes > LIMITS.totalBytes || slots.length > LIMITS.slots) throw new Error('T4 evidence quota exceeded; history retained.');
    return { root, usedBytes: bytes, allocatedSlots: slots.length, freeSlotCapacity: (LIMITS.slots - slots.length) * LIMITS.slotBytes };
  }
  function start(settings = {}) {
    if (active || closed) throw new Error('T4 store lifecycle invalid.');
    node(path.resolve(repo), true);
    if (!io.existsSync(parent)) io.mkdirSync(parent);
    node(parent, true);
    if (!io.existsSync(root)) { try { io.mkdirSync(root); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    node(root, true);
    if (!io.existsSync(path.join(root, 'phase.json'))) {
      if (io.readdirSync(root).length) throw new Error('Unowned T4 phase content retained.');
      try { io.writeFileSync(path.join(root, 'phase.json'), Buffer.from(JSON.stringify(owner)), { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    const state = inventory(), reserve = settings.reserveBytes || 0;
    if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve > state.freeSlotCapacity) throw new Error('T4 evidence capacity insufficient; no old records removed.');
    active = true;
    return { ...state, runId, requestedCapacityBytes: reserve, reservationKind: 'preflight-not-exclusive',
      note: 'Concurrent records remain bounded by atomic slots; a later capacity failure is a failed measurement, never a product startup gate.' };
  }
  function record(value) {
    const bytes = Buffer.from(JSON.stringify({ schema: 't4-evidence-record-v1', owner: OWNER, runId, ...value }));
    if (bytes.length > LIMITS.slotBytes) throw new Error('T4 record exceeds 128KiB slot.');
    inventory();
    for (let i = 0; i < LIMITS.slots; i++) {
      const dir = path.join(root, 'slot-' + String(i).padStart(3, '0'));
      try { io.mkdirSync(dir); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
      node(dir, true);
      const file = path.join(dir, 'record.json'); io.writeFileSync(file, bytes, { flag: 'wx' });
      const actual = read(file, LIMITS.slotBytes);
      if (!actual.equals(bytes)) throw new Error('T4 record readback mismatch; partial retained.');
      return { file, bytes: bytes.length, sha256: sha(bytes) };
    }
    throw new Error('T4 evidence slots exhausted; history retained.');
  }
  function save(kind, payload) {
    if (!active || closed) throw new Error('T4 store not active.');
    if (!['host', 'checks', 'audit', 'lifecycle'].includes(kind)) throw new Error('Unknown T4 record kind.');
    const raw = Buffer.from(JSON.stringify(payload));
    if (raw.length > LIMITS.payloadBytes) throw new Error('T4 logical payload exceeds 2MiB.');
    const key = kind + ':' + sha(raw);
    if (saved.has(key)) {
      const previous = saved.get(key);
      for (const ref of previous.references) {
        const bytes = read(ref.file, LIMITS.slotBytes);
        if (bytes.length !== ref.bytes || sha(bytes) !== ref.sha256) throw new Error('Previous T4 exact duplicate changed; retained.');
      }
      return { ...previous.receipt, reused: true };
    }
    const packed = zlib.gzipSync(raw), partBytes = 90 * 1024, count = Math.ceil(packed.length / partBytes), parts = [];
    if (count === 1) {
      const receipt = record({ kind, type: 'payload', payloadSha256: sha(raw), rawBytes: raw.length, encoding: 'gzip-base64', data: packed.toString('base64') });
      saved.set(key, { receipt, references: [receipt] }); return receipt;
    }
    for (let index = 0; index < count; index++) parts.push(record({ kind, type: 'payload-part', payloadSha256: sha(raw),
      index, count, encoding: 'gzip-base64', rawBytes: raw.length, data: packed.subarray(index * partBytes, (index + 1) * partBytes).toString('base64') }));
    const receipt = record({ kind, type: 'payload-index', payloadSha256: sha(raw), rawBytes: raw.length, parts });
    saved.set(key, { receipt, references: [...parts, receipt] }); return receipt;
  }
  function readReceipt(reference) {
    inventory();
    function decode(ref) {
      if (!ref || typeof ref.file !== 'string' || path.dirname(path.dirname(ref.file)) !== root ||
          !/^slot-\d{3}$/.test(path.basename(path.dirname(ref.file))) || path.basename(ref.file) !== 'record.json')
        throw new Error('T4 receipt reference escapes phase.');
      const bytes = read(ref.file, LIMITS.slotBytes), value = JSON.parse(bytes);
      if (ref.bytes !== bytes.length || ref.sha256 !== sha(bytes) || value.schema !== 't4-evidence-record-v1' || value.owner !== OWNER ||
          !/^[0-9a-f]{32}$/.test(value.runId || '')) throw new Error('T4 receipt identity/digest invalid.');
      return value;
    }
    const value = decode(reference); let parts;
    if (!Number.isSafeInteger(value.rawBytes) || value.rawBytes < 0 || value.rawBytes > LIMITS.payloadBytes || !/^[0-9a-f]{64}$/.test(value.payloadSha256 || ''))
      throw new Error('T4 payload metadata invalid.');
    if (value.type === 'payload') parts = [value];
    else if (value.type === 'payload-index' && Array.isArray(value.parts) && value.parts.length >= 2 && value.parts.length <= 24) {
      if (new Set(value.parts.map(p => p.file)).size !== value.parts.length) throw new Error('Repeated T4 payload fragment.');
      parts = value.parts.map((ref, index) => {
        const part = decode(ref);
        if (part.type !== 'payload-part' || part.runId !== value.runId || part.kind !== value.kind || part.index !== index || part.count !== value.parts.length ||
            part.rawBytes !== value.rawBytes || part.payloadSha256 !== value.payloadSha256) throw new Error('T4 fragment provenance mismatch.');
        return part;
      });
    } else throw new Error('T4 logical receipt type invalid.');
    const packed = Buffer.concat(parts.map(p => { if (p.encoding !== 'gzip-base64' || typeof p.data !== 'string') throw new Error('Invalid T4 payload encoding.'); return Buffer.from(p.data, 'base64'); }));
    const raw = zlib.gunzipSync(packed, { maxOutputLength: LIMITS.payloadBytes });
    if (raw.length !== value.rawBytes || sha(raw) !== value.payloadSha256) throw new Error('T4 logical payload digest mismatch.');
    return JSON.parse(raw);
  }
  function close() { const wasActive = active; active = false; closed = true; return wasActive; }
  return Object.freeze({ start, save, close, inventory, readReceipt });
}
module.exports = { createStore, LIMITS, OWNER };
