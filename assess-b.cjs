// 复算已保存的窗口证据；不会重新测量或生成缓存。
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), crypto = require('crypto');
const b = require('./cache-b.cjs'), { stats } = require('./experiment-b.js');
const root = __dirname;
const sum = rows => {
  const ok = rows.filter(r => !r.dropped && !r.cancelled && !r.error);
  return { requested: rows.length, completed: ok.filter(r => Number.isFinite(r.readyMs)).length,
    dropped: rows.filter(r => r.dropped).length, errors: rows.filter(r => r.error).length,
    requestToReady: stats(ok.map(r => r.readyMs)),
    requestToPaintOpportunity: stats(ok.filter(r => !r.supersededBeforePaintOpportunity).map(r => r.paintOpportunityMs)) };
};
function check(actual, saved) {
  for (const k of ['requested', 'completed', 'dropped', 'errors']) assert.equal(actual[k], saved[k]);
  for (const k of ['requestToReady', 'requestToPaintOpportunity']) {
    assert.equal(actual[k].n, saved[k].n);
    assert(Math.abs(actual[k].meanMs - saved[k].meanMs) < 1e-6);
    assert(Math.abs(actual[k].p95Ms - saved[k].p95Ms) < 1e-6);
  }
}
async function main() {
  const sessions = fs.readdirSync(path.join(root, 'evidence')).filter(n => /^b-session-.*\.json$/.test(n)).sort();
  assert(sessions.length); const session = path.join('evidence', sessions.at(-1));
  const s = JSON.parse(fs.readFileSync(path.join(root, session)));
  assert(s.baseline && s.comparison && s.cache); assert.equal(s.truncatedRows, 0);
  const baseline = sum(s.rows.filter(r => r.group === 'baseline-direct' && r.kind === 'random')); check(baseline, s.baseline);
  const comparison = {};
  for (const mode of ['direct', 'cache']) {
    comparison[mode] = sum(s.rows.filter(r => r.mode === mode && r.kind === 'random' && r.group !== 'baseline-direct'));
    check(comparison[mode], s.comparison[mode]);
  }
  const targets = ['baseline-direct', 'direct-1', 'cache-1', 'cache-2', 'direct-2'].map(g => s.rows.filter(r => r.group === g && r.kind === 'random').map(r => r.requestedSeconds));
  for (const times of targets.slice(1)) assert.deepEqual(times, targets[0]);
  const drawn = s.rows.filter(r => Number.isFinite(r.sequence));
  for (let i = 0; i < drawn.length; i++) {
    const r = drawn[i]; assert(!i || r.sequence > drawn[i - 1].sequence);
    assert(r.readyMs >= 0 && r.drawSubmittedMs >= r.readyMs);
    assert.equal(r.frameIndex, b.frameAt(s.info.timestamps, r.requestedSeconds));
    assert.equal(r.framePTS, s.info.timestamps[r.frameIndex]); assert.equal(r.physicalDisplayMs, null);
  }
  const rounds = s.rounds.map(round => {
    const rows = s.rows.filter(r => r.group === `drag-${round.mode}-${round.round}`), computed = sum(rows);
    check(computed, round.summary);
    assert.equal(rows.at(-1).requestedSeconds, rows.filter(r => Number.isFinite(r.sequence)).at(-1).requestedSeconds);
    assert.equal(round.finalDrawn, rows.at(-1).requestedSeconds);
    return { mode: round.mode, round: round.round, ...computed, finalTargetMatches: true,
      rssStartMiB: round.start.rssBytes / 2 ** 20, rssEndMiB: round.end.rssBytes / 2 ** 20 };
  });
  const manual = Object.fromEntries(['direct', 'cache'].map(mode => [mode, sum(s.rows.filter(r => r.group === 'manual' && r.mode === mode))]));
  const callbacks = drawn.filter(r => r.videoFrameCallback);
  const callbackDifferences = callbacks.filter(r => Math.abs(r.videoFrameCallback.mediaTime - r.framePTS) > .0011)
    .map(r => ({ sequence: r.sequence, requested: r.requestedSeconds, expected: r.framePTS, callback: r.videoFrameCallback.mediaTime }));
  const cachePresent = fs.existsSync(b.dir()); let cacheFileVerification = 'directory absent at audit; only saved window generation record available';
  if (cachePresent) {
    const manifest = JSON.parse(fs.readFileSync(path.join(b.dir(), 'manifest.json')));
    assert.equal(manifest.frames, s.info.timestamps.length); assert.deepEqual(manifest.timestamps, s.info.timestamps);
    assert.equal(manifest.sha256, s.info.sha256);
    const files = fs.readdirSync(b.dir()), images = files.filter(n => /^\d{6}\.jpg$/.test(n));
    assert.equal(images.length, manifest.frames); let total = 0;
    for (const n of files) {
      const file = path.join(b.dir(), n), st = fs.lstatSync(file); assert(st.isFile() && !st.isSymbolicLink()); total += st.size;
      if (/\.jpg$/.test(n)) { const bytes = fs.readFileSync(file); assert.equal(bytes.readUInt16BE(0), 0xffd8); assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9); }
    }
    assert.equal(total, s.cache.diskBytes); cacheFileVerification = 'frame count, timestamps, disk size and JPEG boundaries checked; pixels not compared';
  }
  assert.equal(s.cache.frames, s.info.timestamps.length); assert.deepEqual(s.cache.timestamps, s.info.timestamps);
  assert(s.cache.diskBytes <= b.LIMITS.diskBytes);
  let currentSourcePath = s.info.source.filePath;
  if (!fs.existsSync(currentSourcePath)) {
    const sourceDir = path.dirname(currentSourcePath);
    const candidates = fs.readdirSync(sourceDir, { withFileTypes: true }).filter(e => e.isFile() && /\.mp4$/i.test(e.name))
      .map(e => path.join(sourceDir, e.name)).filter(file => fs.statSync(file).size === s.info.source.size);
    assert.equal(candidates.length, 1, 'Cannot unambiguously locate renamed source within the same item directory');
    currentSourcePath = candidates[0];
  }
  const currentSHA = await b.hashFile(currentSourcePath); assert.equal(currentSHA, s.info.sha256);
  const hashes = {};
  for (const file of [session, 'evidence/b-probe.json', 'evidence/b-local-checks.json', 'app.js', 'experiment-b.js', 'cache-b.cjs', 'index.html'])
    hashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  const rss = s.memory.map(m => m.rssBytes), first = s.memory[0].t, last = s.memory.at(-1).t;
  const block = (a, z) => { const rows = s.memory.filter(m => m.t >= a && m.t < z);
    return { samples: rows.length, meanMiB: rows.reduce((n, r) => n + r.rssBytes, 0) / rows.length / 2 ** 20,
      minMiB: Math.min(...rows.map(r => r.rssBytes)) / 2 ** 20, maxMiB: Math.max(...rows.map(r => r.rssBytes)) / 2 ** 20 }; };
  const result = { at: new Date().toISOString(), source: 'independent-recalculation-of-actual-Eagle-B-records',
    verdict: 'core-performance-PoC-passed-on-one-video; pixel-level accuracy and long-term memory stability not certified',
    session, baseline, comparison, rounds, manual, observations: s.observations,
    validation: { randomTargetsIdentical: true, savedStatisticsRecomputed: true, drawSequenceStrictlyIncreasing: true,
      allRecordedFrameIndicesMatchPTSLookup: true, scriptedFinalTargetsMatch: true, actualPixelIdentityVerified: false,
      videoFrameCallbacks: callbacks.length, callbackDifferences,
      callbackCaveat: 'Callback registered before currentTime assignment may describe previous frame; these callbacks do not certify drawn pixels.',
      cachePresentAtAudit: cachePresent, cacheFileVerification, sourceHashUnchanged: true, currentSourcePath, currentSourceSHA256: currentSHA,
      errors: s.rows.filter(r => r.error).length, cancelled: s.rows.filter(r => r.cancelled).length,
      paintUnavailable: s.rows.filter(r => r.paintUnavailable).length, truncatedRows: s.truncatedRows, peakLiveBitmaps: s.peakLiveBitmaps },
    cache: { generationMs: s.cache.generationMs, diskBytes: s.cache.diskBytes, diskMiB: s.cache.diskBytes / 2 ** 20,
      frames: s.cache.frames, width: s.cache.width, height: s.cache.height,
      ffmpegPeakSampledMiB: s.cache.ffmpegPeakWorkingSetSampledBytes === null ? null : s.cache.ffmpegPeakWorkingSetSampledBytes / 2 ** 20 },
    memory: { samples: rss.length, durationSeconds: (last - first) / 1000, minMiB: Math.min(...rss) / 2 ** 20,
      maxMiB: Math.max(...rss) / 2 ** 20, firstMiB: rss[0] / 2 ** 20, lastMiB: rss.at(-1) / 2 ** 20,
      firstMinute: block(first, first + 60000), lastMinute: block(last - 60000, last + 1) },
    evidenceSHA256: hashes, limits: s.measurementLimits };
  fs.writeFileSync(path.join(root, 'evidence', 'b-final-assessment.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ verdict: result.verdict, comparison, manual, validation: result.validation, cache: result.cache, memory: result.memory }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
