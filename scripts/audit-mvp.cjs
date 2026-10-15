'use strict';
// Explicit read-only preflight. Never starts an evidence writer or product task.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawnSync } = require('child_process');
const repo = path.resolve(__dirname, '..'), MIB = 1024 ** 2;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  const ordered = item => !item || typeof item !== 'object' ? item : Array.isArray(item)
    ? item.map(ordered) : Object.fromEntries(Object.keys(item).sort().map(k => [k, ordered(item[k])]));
  return JSON.stringify(ordered(value));
}
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function inspect(file, directory = false) {
  const absolute = path.resolve(file), stat = fs.lstatSync(absolute, { bigint: true });
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) ||
      !samePath(fs.realpathSync(absolute), absolute)) throw new Error('Audit boundary changed: ' + absolute);
  return stat;
}
function unchanged(a, b) { return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]); }
function read(file, maximum = 2 * MIB) {
  const before = inspect(file);
  if (before.size > BigInt(maximum) || before.nlink !== 1n) throw new Error('Audit file size/link boundary changed: ' + file);
  const bytes = fs.readFileSync(file), after = inspect(file);
  if (!unchanged(before, after) || BigInt(bytes.length) !== before.size) throw new Error('Audit file changed while reading: ' + file);
  return { bytes, sha256: sha(bytes), value: file.endsWith('.json') ? JSON.parse(bytes) : null };
}
function envelope(value, stage) {
  if (!value || value.schema !== stage.toLowerCase() + '-evidence-v1' || typeof value.kind !== 'string' ||
      !value.payload || typeof value.payload !== 'object' || value.key !== sha(Buffer.from(canonical(value.payload))))
    throw new Error('Saved evidence envelope/digest invalid.');
  return value.payload;
}
function compareSources(recorded, current) {
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return { recorded: false, matches: [], changed: [], missing: Object.keys(current) };
  const normalized = {};
  for (const [name, hash] of Object.entries(recorded)) {
    const key = name.startsWith('plugin/') ? name : 'plugin/' + name;
    if (Object.hasOwn(current, key)) normalized[key] = hash;
  }
  const matches = [], changed = [], missing = [];
  for (const [name, hash] of Object.entries(current)) {
    if (!Object.hasOwn(normalized, name)) missing.push(name);
    else (normalized[name] === hash ? matches : changed).push(name);
  }
  return { recorded: true, matches, changed, missing };
}
function runtimeHashes() {
  inspect(path.join(repo, 'plugin'), true); inspect(path.join(repo, 'plugin/native'), true);
  const names = fs.readdirSync(path.join(repo, 'plugin')).filter(n => /\.(?:cjs|js|css|html)$/.test(n) || ['manifest.json', 'logo.png'].includes(n));
  names.push('native/task-host.cs', 'native/task-host.local.exe');
  return Object.fromEntries(names.sort().map(n => ['plugin/' + n, read(path.join(repo, 'plugin', n)).sha256]));
}
function auditEvidence(current) {
  const root = path.join(repo, 'verification-runs'); inspect(root, true);
  const result = {};
  for (const stage of ['T2', 'T3']) {
    const prefix = stage.toLowerCase(), pattern = new RegExp('^' + prefix + '-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[0-9a-f]{20}$');
    const names = fs.readdirSync(root).filter(n => pattern.test(n)).sort(), schemas = {}, summaries = [];
    let totalBytes = 0, fileCount = 0, wrapped = 0, legacy = 0;
    if (names.length > 4096) throw new Error('Too many saved runs.');
    for (const name of names) {
      const directory = path.join(root, name), before = inspect(directory, true), files = fs.readdirSync(directory).sort();
      if (files.length > 512) throw new Error('Too many files in saved run.');
      const owner = read(path.join(directory, 'owner.json')).value;
      if (!owner || owner.schema !== 1 || owner.runId !== name || !samePath(owner.root, root) ||
          owner.owner !== 'eagle-video-analysis-' + stage + '-evidence-v1' || owner.kind !== 'evidence')
        throw new Error('Saved run owner mismatch: ' + name);
      for (const fileName of files) {
        const file = path.join(directory, fileName), record = read(file);
        totalBytes += record.bytes.length; fileCount++;
        if (totalBytes > 16 * MIB) throw new Error('Existing ' + stage + ' evidence exceeds its original quota.');
        if (fileName === 'owner.json') continue;
        const isWrapped = record.value && record.value.schema === prefix + '-evidence-v1';
        const value = isWrapped ? envelope(record.value, stage) : record.value;
        if (isWrapped) wrapped++; else {
          // The first readonly inventory predates the append-only envelope.
          if (stage !== 'T2' || fileName !== 'checks.json' || value.schema !== 't2-readonly-inventory-and-checks-v1')
            throw new Error('Unknown saved evidence format: ' + file);
          legacy++;
        }
        const schema = typeof value.schema === 'string' ? value.schema : '(untyped-check-output)';
        schemas[schema] = (schemas[schema] || 0) + 1;
        if (['window-resource-summary-v1', 'window-formal-dom-regression-v1', 'window-reuse-summary-v1'].includes(schema) &&
            (schema !== 'window-formal-dom-regression-v1' || value.type === 'summary')) {
          summaries.push({ file: path.relative(repo, file).replace(/\\/g, '/'), sha256: record.sha256, schema,
            savedGate: value.resourceGatePassed ?? value.earlyRegressionPassed ?? value.reuseGatePassed ?? null,
            sourceCoverage: compareSources(value.sourceFingerprints || value.launchContext && value.launchContext.sourceHashes, current) });
        }
      }
      if (!unchanged(before, inspect(directory, true)) || canonical(files) !== canonical(fs.readdirSync(directory).sort()))
        throw new Error('Saved run changed during audit.');
    }
    const lock = path.join(root, prefix + '-writer.lock');
    result[stage] = { runs: names.length, fileCount, totalBytes, quotaBytes: 16 * MIB,
      remainingBytes: 16 * MIB - totalBytes, envelopesVerified: wrapped, legacyUnwrappedRecords: legacy,
      oldWriterPresent: fs.existsSync(lock), schemas, summaries };
  }
  return result;
}
async function auditSamples() {
  const config = read(path.join(repo, 'tests/host/t0/config.local.json')).value;
  for (const file of [config.ffmpeg, config.ffprobe]) inspect(file);
  const baseline = config.sources.find(s => s.key === 'baseline');
  if (!baseline) throw new Error('Registered baseline missing.');
  const libraryImages = path.dirname(path.dirname(baseline.file)); inspect(libraryImages, true);
  const extras = [
    ['h264-real', 'MV3FZJJ7AC1CI', '0823a48f0d7b365163297206e8e8c66591c3aa6cf4c30253b3187d19c9644cba'],
    ['hevc-real', 'MV6H7OK0MBGX2', 'd7bbab0b425381c880adacb9f8d95d900aa162c4c5c9308cf9a3f8482ff67658'],
    ['hevc-short', 'MV6H46XZIFUFI', 'a35814395cc39b73c1d705b0d4cca7096ffb1974e6b85f9243815079195f1042']
  ].map(([key, id, sha256]) => {
    const dir = path.join(libraryImages, id + '.info'); inspect(dir, true);
    const names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.mp4'));
    if (names.length !== 1) throw new Error('Designated MP4 missing/ambiguous: ' + id);
    return { key, id, sha256, file: path.join(dir, names[0]) };
  });
  const samples = [];
  for (const input of [...config.sources, ...extras]) {
    const before = inspect(input.file);
    if (before.size > 2n * 1024n ** 3n) throw new Error('Designated audit input exceeds 2GiB tool boundary.');
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(input.file)) digest.update(chunk);
    const actual = digest.digest('hex');
    if (actual !== input.sha256) throw new Error('Designated input SHA mismatch: ' + input.key);
    const probe = spawnSync(config.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input.file],
      { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: MIB });
    if (probe.error || probe.status !== 0) throw new Error('Read-only probe failed: ' + input.key);
    const data = JSON.parse(probe.stdout);
    if (!unchanged(before, inspect(input.file))) throw new Error('Input changed during audit: ' + input.key);
    samples.push({ key: input.key, itemId: input.id || (input.key === 'baseline' ? 'MUXL6QI4AJIAG' : null), sha256: actual,
      bytes: Number(before.size), duration: Number(data.format.duration), sourceUnchanged: true,
      streams: data.streams.map(s => ({ type: s.codec_type, codec: s.codec_name, width: s.width, height: s.height,
        nominalFrameRate: s.r_frame_rate, averageFrameRate: s.avg_frame_rate, start: s.start_time, duration: s.duration,
        frames: s.nb_frames, sampleRate: s.sample_rate, channels: s.channels })) });
  }
  return { samples, ffprobeSha256: sha(fs.readFileSync(config.ffprobe)), ffmpegSha256: sha(fs.readFileSync(config.ffmpeg)),
    limitation: 'Hash/probe only; not new frame accuracy, sound, generation time, RAM or real-Eagle evidence.' };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !['--read-only', '--samples'].includes(a)) || !args.includes('--read-only')) throw new Error('Use --read-only [--samples].');
  const current = runtimeHashes(); require('../plugin/task-client.cjs').verifyGuard(path.join(repo, 'plugin'));
  const result = { schema: 'mvp-readonly-preflight-v1', origin: 'codex-local-readonly', runtimeHashes: current,
    evidence: auditEvidence(current), ...(args.includes('--samples') ? { media: await auditSamples() } : {}),
    writes: false, overallT2Accepted: false, overallT4Accepted: false,
    limitations: ['Saved gate values are historical claims, not new verdicts.', 'Matching files do not establish complete current applicability.',
      'Trace contents/performance statistics are not recomputed here.', 'Old writer files are neither acquired nor deleted.'] };
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 128 * 1024) throw new Error('Audit stdout exceeds 128KiB.');
  console.log(output);
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { _test: { canonical, unchanged, envelope, compareSources } };
