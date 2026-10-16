'use strict';
// Test-only, lossless trace compaction. No dropped rows or rounded counters.
const zlib = require('zlib');
const { sample, identity, ROLES } = require('./mvp-resource.cjs');
const MAX = Object.freeze({ catalogue: 1024, events: 10000, pendingBytes: 12 * 1024 ** 2, rawBytes: 1800 * 1024, packedBytes: 90 * 1024, chunks: 11 });
function binaryRows(rows) {
  const bytes = []; const counters = new Map(); let previousRenderer = null, previousNative = null;
  const uint = value => { if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid binary integer.');
    do { const digit = value % 128; value = Math.floor(value / 128); bytes.push(digit + (value ? 128 : 0)); } while (value); };
  const zig = value => uint(value >= 0 ? value * 2 : -value * 2 - 1);
  function number(value) {
    if (value === null) { bytes.push(0); return; }
    if (!Number.isFinite(value)) throw Error('Invalid binary number.');
    if (!Object.is(value, -0)) {
      if (value !== 0 && Number.isSafeInteger(value / 4096) && Math.abs(value / 4096) < 2 ** 51) { bytes.push(2); zig(value / 4096); return; }
      if (Number.isSafeInteger(value) && Math.abs(value) < 2 ** 51) { bytes.push(1); zig(value); return; }
      if (Number.isSafeInteger(value * 64) && Math.abs(value * 64) < 2 ** 51) { bytes.push(3); zig(value * 64); return; }
      const decimal = Math.round(value * 10000);
      if (Number.isSafeInteger(decimal) && Math.abs(decimal) < 2 ** 51 && Object.is(decimal / 10000, value)) { bytes.push(5); zig(decimal); return; }
    }
    bytes.push(4); const b = Buffer.allocUnsafe(8); b.writeDoubleLE(value); for (const byte of b) bytes.push(byte);
  }
  const string = text => { const b = Buffer.from(text); uint(b.length); for (const byte of b) bytes.push(byte); };
  const delta = (value, prior) => typeof value === 'number' && typeof prior === 'number' && Object.is(prior + (value - prior), value);
  function difference(value, prior) {
    const exact = value - prior;
    // A shorter decimal is used only if adding it restores the original bits.
    for (const scale of [10, 10000]) { const short = Math.round(exact * scale) / scale;
      if (Object.is(prior + short, value)) return short; }
    return exact;
  }
  for (const row of rows) {
    bytes.push(row[0]);
    if (row[0] === 1) {
      const r = row[1], numeric = r.filter((_, i) => i !== 1), prior = previousRenderer;
      let mask = 0; numeric.forEach((n, i) => { if (prior && delta(n, prior[i])) mask |= 1 << i; });
      uint(mask); string(r[1]); numeric.forEach((n, i) => number(mask & 1 << i ? difference(n, prior[i]) : n)); previousRenderer = numeric;
    } else {
      const c = row[2], structured = c && JSON.stringify(Object.keys(c).sort()) === '["elapsedMs","phase","sample"]';
      const times = [row[1], structured ? c.elapsedMs : null, row[3]];
      let mask = 0; times.forEach((value, i) => { if (previousNative && delta(value, previousNative[i])) mask |= 1 << i; });
      uint(mask);
      const time = i => number(mask & 1 << i ? difference(times[i], previousNative[i]) : times[i]);
      time(0);
      if (structured) {
        bytes.push(1); time(1); string(c.phase); number(c.sample);
      } else { bytes.push(0); string(JSON.stringify(c)); }
      time(2); previousNative = times; number(row[4]); uint(row[5].length);
      for (const p of row[5]) { uint(p[0]); const prior = counters.get(p[0]);
        const mask = (prior && delta(p[1], prior[0]) ? 1 : 0) | (prior && delta(p[2], prior[1]) ? 2 : 0);
        bytes.push(mask); number(mask & 1 ? p[1] - prior[0] : p[1]); number(mask & 2 ? p[2] - prior[1] : p[2]); counters.set(p[0], p.slice(1)); }
      uint(row[6].length); for (const r of row[6]) { uint(r[0]); bytes.push(r[1] ? 1 : 0); }
      if (!row[7].length) bytes.push(0); else { bytes.push(1); string(JSON.stringify(row[7])); }
    }
  }
  return Buffer.from(bytes).toString('base64');
}
function readBinaryRows(data, count, version) {
  if (typeof data !== 'string' || data.length > 2400 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) ||
      !Number.isSafeInteger(count) || count < 0 || count > MAX.events) throw Error('Invalid binary trace boundary.');
  const b = Buffer.from(data, 'base64'), rows = [], counters = new Map(); let at = 0, priorRenderer = null, priorNative = null;
  const byte = () => { if (at >= b.length) throw Error('Truncated binary trace.'); return b[at++]; };
  function uint() { let value = 0, factor = 1, digit;
    do { digit = byte(); value += (digit & 127) * factor; factor *= 128;
      if (!Number.isSafeInteger(value) || factor > 2 ** 56) throw Error('Binary integer overflow.'); } while (digit & 128); return value; }
  function number() { const type = byte(); if (type === 0) return null;
    if (type >= 1 && type <= 3 || type === 5) { const raw = uint(), signed = raw % 2 ? -(raw + 1) / 2 : raw / 2; return type === 2 ? signed * 4096 : type === 3 ? signed / 64 : type === 5 ? signed / 10000 : signed; }
    if (type !== 4 || at + 8 > b.length) throw Error('Invalid binary float.'); const value = b.readDoubleLE(at); at += 8;
    if (!Number.isFinite(value)) throw Error('Nonfinite binary float.'); return value; }
  function string() { const n = uint(); if (n > 65536 || at + n > b.length) throw Error('Invalid binary text.'); const value = b.toString('utf8', at, at + n); at += n; return value; }
  for (let i = 0; i < count; i++) {
    const type = byte();
    if (type === 1) { const mask = uint(), phase = string(); if (mask > 2047 || mask && !priorRenderer) throw Error('Invalid renderer delta.');
      const nums = Array.from({ length: 11 }, (_, j) => { const n = number(); return mask & 1 << j ? priorRenderer[j] + n : n; });
      rows.push([1, [nums[0], phase, ...nums.slice(1)]]); priorRenderer = nums;
    } else if (type === 0) {
      const mask = version === 2 ? uint() : 0;
      if (mask > 7 || mask && !priorNative) throw Error('Invalid native delta.');
      const time = i => { const value = number();
        if (mask & 1 << i && (typeof value !== 'number' || typeof priorNative[i] !== 'number')) throw Error('Invalid native time delta.');
        return mask & 1 << i ? priorNative[i] + value : value; };
      const received = time(0), contextKind = byte(); if (contextKind > 1 || !contextKind && mask & 2) throw Error('Invalid context kind.');
      const context = contextKind ? { elapsedMs: time(1), phase: string(), sample: number() } : JSON.parse(string());
      const elapsed = time(2), duration = number(), n = uint(); priorNative = [received, contextKind ? context.elapsedMs : null, elapsed];
      if (n > 64) throw Error('Binary process count exceeded.'); const processes = [];
      for (let p = 0; p < n; p++) { const id = uint(), mask = byte(), prior = counters.get(id);
        if (mask > 3 || mask && !prior) throw Error('Invalid process delta.'); const rss = number(), cpu = number();
        const pair = [mask & 1 ? prior[0] + rss : rss, mask & 2 ? prior[1] + cpu : cpu]; processes.push([id, ...pair]); counters.set(id, pair); }
      const rootCount = uint(); if (rootCount > 9) throw Error('Binary root count exceeded.'); const roots = [];
      for (let r = 0; r < rootCount; r++) { const id = uint(), alive = byte(); if (alive > 1) throw Error('Invalid binary alive flag.'); roots.push([id, !!alive]); }
      const errorKind = byte(); if (errorKind > 1) throw Error('Invalid error kind.');
      rows.push([0, received, context, elapsed, duration, processes, roots, errorKind ? JSON.parse(string()) : []]);
    } else throw Error('Invalid binary event.');
  }
  if (at !== b.length) throw Error('Trailing binary trace bytes.'); return rows;
}
function compactDecoder() {
  const catalogue = [], identities = new Set();
  return value => {
    if (!value || value.schema !== 'mvp-process-compact-v1' || !Array.isArray(value.additions) || value.additions.length > 64 ||
        !Array.isArray(value.roots) || !Array.isArray(value.processes)) throw Error('Invalid compact native row.');
    for (const a of value.additions) {
      if (!Array.isArray(a) || a.length !== 7 || a[0] !== catalogue.length || catalogue.length >= MAX.catalogue ||
          !ROLES.includes(a[3]) || typeof a[4] !== 'string' || typeof a[5] !== 'string' || typeof a[6] !== 'string') throw Error('Invalid native process catalogue.');
      const row = { pid: a[1], startTicks: a[2], role: a[3], root: a[4], image: a[5], imagePath: a[6] }, key = identity(row);
      if (identities.has(key)) throw Error('Duplicate native process identity.'); identities.add(key); catalogue.push(row);
    }
    const get = id => { if (!Number.isSafeInteger(id) || !catalogue[id]) throw Error('Unknown native process identity.'); return catalogue[id]; };
    return sample({ schema: 'mvp-process-sample-v1', atMs: value.atMs, sampleDurationMs: value.sampleDurationMs, errors: value.errors,
      roots: value.roots.map(r => { if (!Array.isArray(r) || r.length !== 2) throw Error('Invalid compact root.');
        const p = get(r[0]); return { pid: p.pid, startTicks: p.startTicks, role: p.role, alive: r[1] }; }),
      processes: value.processes.map(r => { if (!Array.isArray(r) || r.length !== 3) throw Error('Invalid compact process.');
        return { ...get(r[0]), rssBytes: r[1], cpuMs: r[2] }; }) });
  };
}
function encode(events, index) {
  const processes = [], roots = [], processIds = new Map(), rootIds = new Map();
  const get = (value, list, ids) => { const key = identity({ pid: value[0], startTicks: value[1] });
    if (ids.has(key)) { const id = ids.get(key); if (JSON.stringify(list[id]) !== JSON.stringify(value)) throw Error('Trace identity metadata changed.'); return id; }
    if (list.length >= MAX.catalogue) throw Error('Trace catalogue exceeded.'); ids.set(key, list.length); list.push(value); return list.length - 1; };
  const rows = events.map(e => {
    if (e.kind === 'renderer') return [1, e.row];
    const n = sample(e.native);
    return [0, e.receivedAtMs, e.context, n.atMs, n.sampleDurationMs,
      n.processes.map(p => [get([p.pid, p.startTicks, p.role, p.root, p.image, p.imagePath ?? null], processes, processIds), p.rssBytes, p.cpuMs]),
      n.roots.map(p => [get([p.pid, p.startTicks, p.role], roots, rootIds), p.alive]), n.errors];
  });
  const binary = Buffer.from(binaryRows(rows), 'base64');
  const compressed = zlib.brotliCompressSync(binary, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  return { schema: 'mvp-long-resource-chunk-v1', index, processes, roots, encoding: 'lossless-brotli-base64-v2', events: rows.length, data: compressed.toString('base64') };
}
function decode(chunk) {
  if (!chunk || chunk.schema !== 'mvp-long-resource-chunk-v1' || !Array.isArray(chunk.processes) || !Array.isArray(chunk.roots) ||
      !['lossless-binary-base64-v1', 'lossless-binary-base64-v2', 'lossless-brotli-base64-v2'].includes(chunk.encoding) || chunk.processes.length > MAX.catalogue || chunk.roots.length > MAX.catalogue) throw Error('Invalid long trace.');
  const get = (list, id, length) => { const p = list[id]; if (!Number.isSafeInteger(id) || !Array.isArray(p) || p.length !== length) throw Error('Invalid long trace identity.'); return p; };
  if (typeof chunk.data !== 'string' || chunk.data.length > 2400 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) throw Error('Invalid binary trace boundary.');
  const data = chunk.encoding === 'lossless-brotli-base64-v2'
    ? zlib.brotliDecompressSync(Buffer.from(chunk.data, 'base64'), { maxOutputLength: MAX.rawBytes }).toString('base64') : chunk.data;
  return readBinaryRows(data, chunk.events, chunk.encoding.endsWith('v2') ? 2 : 1).map(r => {
    if (r[0] === 1 && r.length === 2) { if (!Array.isArray(r[1]) || r[1].length !== 12) throw Error('Invalid renderer trace.'); return { kind: 'renderer', row: r[1] }; }
    if (r[0] !== 0 || r.length !== 8) throw Error('Invalid long trace event.');
    return { kind: 'native', receivedAtMs: r[1], context: r[2], native: sample({ schema: 'mvp-process-sample-v1', atMs: r[3], sampleDurationMs: r[4], errors: r[7],
      processes: r[5].map(a => { const p = get(chunk.processes, a[0], 6); return { pid: p[0], startTicks: p[1], role: p[2], root: p[3], image: p[4],
        ...(p[5] === null ? {} : { imagePath: p[5] }), rssBytes: a[1], cpuMs: a[2] }; }),
      roots: r[6].map(a => { const p = get(chunk.roots, a[0], 3); return { pid: p[0], startTicks: p[1], role: p[2], alive: a[1] }; }) }) };
  });
}
function recorder(store) {
  let pending = [], pendingBytes = 0, total = 0, failed = null; const chunks = [];
  function fits(rows) { const payload = encode(rows, chunks.length), raw = Buffer.from(JSON.stringify(payload));
    return { payload, fits: raw.length <= MAX.rawBytes && zlib.gzipSync(raw).length <= MAX.packedBytes }; }
  function flush(all = true) {
    if (failed) throw failed;
    while (pending.length) {
      if (chunks.length >= MAX.chunks) throw Error('长期轨迹达到本轮11槽上限，停止并保留已存记录。');
      let count = pending.length, candidate = fits(pending);
      if (!candidate.fits) { let lo = 1, hi = count;
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(pending.slice(0, mid)).fits) lo = mid; else hi = mid - 1; }
        count = lo; candidate = fits(pending.slice(0, count)); }
      if (!candidate.fits) throw Error('单条长期记录超界。');
      try { chunks.push(store.save('lifecycle', candidate.payload)); } catch (error) { failed = error; throw error; }
      pending = pending.slice(count);
      pendingBytes = pending.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
      if (!all) return;
    }
  }
  return { append(event) {
    if (failed) throw failed;
    if (event.kind !== 'native' && event.kind !== 'renderer') throw Error('Unknown long event.');
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > MAX.pendingBytes) throw Error('Long row exceeds memory boundary.');
    while (pending.length >= MAX.events || pendingBytes + bytes > MAX.pendingBytes) flush(false);
    pending.push(event); pendingBytes += bytes; total++;
    if (pending.length % 1000 === 0 && !fits(pending).fits) flush(false);
  }, flush, summary: () => ({ chunks: chunks.slice(), totalEvents: total, pendingEvents: pending.length, pendingBytes, limits: MAX }) };
}
module.exports = { compactDecoder, encode, decode, recorder, MAX };
