'use strict';
// Independent source timestamps; never constructs expectations from the cache.
const assert = require('assert'), frameIndex = require('../../plugin/frame-index.cjs');
function integer(value) {
  assert(typeof value === 'string' && /^-?\d+$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value), 'Unsafe/missing source timestamp.');
  return BigInt(value);
}
function compare(info, probe) {
  const source = probe.frames, stream = probe.streams && probe.streams[0];
  assert(source && source.length === info.frames.length && source.length, 'Independent source frame count differs.');
  const base = String(stream.time_base).split('/').map(integer), origin = integer(source[0].pts ?? source[0].best_effort_timestamp);
  const cachedOrigin = integer(info.frames[0].ptsTicks), cachedBase = info.frames[0].timeBase.map(integer);
  const wanted = [], mismatches = [];
  for (let n = 0; n < source.length; n++) {
    const ticks = integer(source[n].pts ?? source[n].best_effort_timestamp) - origin, f = info.frames[n], b = f.timeBase.map(integer);
    const cachedNumerator = integer(f.ptsTicks) * b[0] * cachedBase[1] - cachedOrigin * cachedBase[0] * b[1];
    if (ticks * base[0] * b[1] * cachedBase[1] !== cachedNumerator * base[1]) mismatches.push(n);
    const relative = ticks * base[0];
    // Subtract exact ticks first; keep the same quotient/remainder seconds
    // representation as the product. A one-ULP difference from whole-ratio
    // conversion would make an intended boundary query fall just before it.
    wanted.push(Number(relative / base[1]) + Number(relative % base[1]) / Number(base[1]));
  }
  assert(!mismatches.length, 'Independent source timestamps differ: ' + mismatches.slice(0, 8));
  let locations = 0;
  for (let n = 0; n < wanted.length; n++) {
    let lastAtTime = n; while (lastAtTime + 1 < wanted.length && wanted[lastAtTime + 1] === wanted[n]) lastAtTime++;
    assert.equal(frameIndex.frameAt(info.frames, wanted[n]), lastAtTime); locations++;
    if (n + 1 < wanted.length && wanted[n + 1] > wanted[n]) {
      assert.equal(frameIndex.frameAt(info.frames, (wanted[n] + wanted[n + 1]) / 2), n); locations++;
    }
    assert.equal(frameIndex.stepIndex(info.frames, n, -1), Math.max(0, n - 1));
    assert.equal(frameIndex.stepIndex(info.frames, n, 1), Math.min(wanted.length - 1, n + 1));
  }
  assert.equal(frameIndex.frameAt(info.frames, info.duration), info.frames.length - 1);
  return { frames: source.length, sourceTimeBase: stream.time_base, timestampMismatches: mismatches, locationChecks: locations + 1,
    ordinalStepChecks: source.length * 2, finalPts: String(integer(source[source.length - 1].pts ?? source[source.length - 1].best_effort_timestamp)),
    finalDurationTicks: source[source.length - 1].duration ?? source[source.length - 1].pkt_duration ?? null, sourceUnchangedRequired: true,
    boundary: 'source ffprobe timestamps versus generated index; no Canvas/physical display claim', passed: true };
}
module.exports = { compare, integer };
