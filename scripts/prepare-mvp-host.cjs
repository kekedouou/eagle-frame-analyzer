'use strict';
// Produces a bounded, separate stage-4 verification entry, not a product build.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { pathToFileURL } = require('url');
const repo = path.resolve(__dirname, '..'), host = path.join(repo, 'tests/host/t4'), plugin = path.join(repo, 'plugin');
const OUTPUTS = ['manifest.json', 'index.local.html', 'logo.local.png'];
const SOURCE_FILES = [
  'app.js', 'cache.cjs', 'diagnostics.cjs', 'eagle.cjs', 'frame-index.cjs', 'frame-pack.cjs', 'index.html', 'logo.png', 'manifest.json', 'media.cjs',
  'player.js', 'preferences.cjs', 'process-identity.cjs', 'session.cjs', 'styles.css', 'task-client.cjs', 'task-worker.cjs', 'ui.js',
  'native/task-host.cs', 'native/task-host.local.exe'
].map(n => 'plugin/' + n).concat(['scripts/prepare-mvp-host.cjs', 'scripts/build-resource-sampler.cjs',
  'tests/host/t4/bootstrap.js', 'tests/support/mvp-launch.cjs', 'tests/support/mvp-preparation.cjs', 'tests/support/preparation-runtime.cjs', 'tests/support/window-frame-reference.cjs', 'tests/support/frame-reference.cjs', 'scripts/verify-frame-accuracy.cjs', 'tests/support/mvp-monitor.cjs', 'tests/support/mvp-resource.cjs',
  'tests/support/t4-evidence.cjs', 'tests/support/window-host.cjs', 'tests/support/t0-protocol.cjs', 'tests/support/t0-gate.cjs',
  'tests/support/ram-diagnostic.cjs', 'tests/native/resource-sampler.cs', 'tests/native/resource-sampler.local.exe',
  'tests/support/mvp-stability.cjs', 'tests/support/stability-runtime.cjs', 'tests/support/long-trace.cjs', 'tests/support/window-resource.cjs']);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.size > 1024n ** 2n || fs.realpathSync(file).toLowerCase() !== file.toLowerCase())
    throw new Error('MVP entry input/output boundary invalid.');
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file, { bigint: true });
  if (['dev', 'ino', 'size', 'mtimeNs'].some(k => s[k] !== after[k])) throw new Error('MVP entry file changed during reading.');
  return bytes;
}
function boundaries() {
  for (const dir of [repo, path.join(repo, 'tests'), path.join(repo, 'tests/host'), host, plugin]) {
    const s = fs.lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(dir).toLowerCase() !== dir.toLowerCase()) throw new Error('MVP entry directory invalid.');
  }
  if (/^c:/i.test(plugin)) throw new Error('MVP entry must use the actual non-C product path.');
}
function sourceHashes() { boundaries(); return Object.fromEntries(SOURCE_FILES.map(n => [n, sha(read(path.join(repo, n)))])); }
function validSources(hashes, allowPrevious = false) {
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.values(hashes).some(v => typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))) return false;
  const keys = JSON.stringify(Object.keys(hashes).sort());
  const beforeLong = SOURCE_FILES.filter(n => !['tests/support/mvp-stability.cjs', 'tests/support/stability-runtime.cjs', 'tests/support/long-trace.cjs', 'tests/support/window-resource.cjs'].includes(n));
  const prior = beforeLong.filter(n => !['tests/support/mvp-preparation.cjs', 'tests/support/preparation-runtime.cjs'].includes(n));
  const beforeFrames = beforeLong.filter(n => !['tests/support/window-frame-reference.cjs', 'tests/support/frame-reference.cjs', 'scripts/verify-frame-accuracy.cjs'].includes(n));
  return keys === JSON.stringify(SOURCE_FILES.slice().sort()) || allowPrevious &&
    [beforeLong, beforeFrames, prior, prior.filter(n => n !== 'plugin/frame-pack.cjs')].some(list => keys === JSON.stringify(list.slice().sort()));
}
function verify(checkSources = true, allowPrevious = false) {
  boundaries(); const marker = JSON.parse(read(path.join(host, 'prepared.local.json')));
  if (marker.schema !== 'mvp-host-prepared-v1' || marker.hostRoot.toLowerCase() !== host.toLowerCase() || marker.pluginRoot.toLowerCase() !== plugin.toLowerCase() ||
      JSON.stringify(Object.keys(marker.files).sort()) !== JSON.stringify(OUTPUTS.slice().sort()) ||
      !validSources(marker.sourceHashes, !checkSources && allowPrevious)) throw new Error('Unknown MVP entry ownership.');
  if (!['performance', 'preparation', 'experience', 'stability'].includes(marker.mode || 'performance')) throw new Error('Unknown MVP entry mode.');
  let bytes = read(path.join(host, 'prepared.local.json')).length;
  for (const name of OUTPUTS) { const b = read(path.join(host, name)); bytes += b.length; if (sha(b) !== marker.files[name]) throw new Error('Prepared MVP entry modified.'); }
  if (bytes > 256 * 1024 || checkSources && JSON.stringify(sourceHashes()) !== JSON.stringify(marker.sourceHashes)) throw new Error('MVP entry source fingerprints changed; reprepare required.');
  require('../plugin/task-client.cjs').verifyGuard(plugin); require('./build-resource-sampler.cjs').verify();
  if (marker.mode === 'preparation') require('../tests/support/preparation-runtime.cjs').verify(marker.preparation);
  if (marker.mode === 'stability') require('../tests/support/stability-runtime.cjs').verify(marker.stability);
  return { host, plugin, marker, bytes };
}
function entryMode(mode) {
  const profiles = { preparation: 'sonic', 'preparation-hevc': 'hevc', 'preparation-vp9': 'vp9' };
  if (Object.hasOwn(profiles, mode)) return { mode: 'preparation', profile: profiles[mode] };
  if (mode === 'stability-vp9' || mode === 'stability-hevc') return { mode: 'stability', profile: mode.slice('stability-'.length) };
  if (mode === 'performance' || mode === 'experience') return { mode, profile: null };
  throw new Error('Explicit performance/preparation/experience entry required.');
}
function prepare(requested = 'performance') {
  const { mode, profile } = entryMode(requested);
  const previous = ['prepared.local.json', ...OUTPUTS].some(n => fs.existsSync(path.join(host, n))) ? verify(false, true) : null;
  const hashes = sourceHashes(), manifest = JSON.parse(read(path.join(plugin, 'manifest.json')));
  manifest.id = 'EVAMVPACCEPT20261015'; manifest.name = '视频分析 · 阶段4验收'; manifest.logo = '/logo.local.png'; manifest.main.url = 'index.local.html';
  let html = read(path.join(plugin, 'index.html')).toString('utf8');
  for (const name of ['styles.css', 'player.js', 'ui.js', 'app.js']) {
    const attribute = name.endsWith('.css') ? 'href' : 'src', token = attribute + '="' + name + '"';
    if (html.split(token).length !== 2) throw new Error('Formal HTML structure changed.');
    html = html.replace(token, attribute + '="' + pathToFileURL(path.join(plugin, name)).href + '?verify=' + hashes['plugin/' + name] + '"');
  }
  html = html.replace(/(<script src="[^"\n]*\/app\.js\?verify=[^"\n]+"><\/script>)/,
    '<script src="bootstrap.js"></script>\n  $1').replace('<title>视频分析</title>', mode === 'experience' ? '<title>阶段4体验 · 视频分析</title>' : '<title>阶段4验收 · 视频分析</title>');
  if (!html.includes('src="bootstrap.js"')) throw new Error('Formal app entry missing.');
  const files = { 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)), 'index.local.html': Buffer.from(html),
    'logo.local.png': read(path.join(plugin, 'logo.png')) };
  let preparation, stability;
  if (mode === 'preparation') {
    const runtime = require('../tests/support/preparation-runtime.cjs');
    if (previous && previous.marker.mode === 'preparation') {
      const owner = runtime.unused(previous.marker.preparation); if ((owner.profile || 'sonic') !== profile) throw Error('已准备另一个专项，不覆盖其副本。'); preparation = previous.marker.preparation;
    } else preparation = runtime.create({ profile });
  }
  if (mode === 'stability') {
    const runtime = require('../tests/support/stability-runtime.cjs');
    if (previous && previous.marker.mode === 'stability') {
      const owner = runtime.unused(previous.marker.stability); if (owner.profile !== profile) throw Error('已准备另一个长期专项，不覆盖。'); stability = previous.marker.stability;
    } else stability = runtime.create(profile);
  }
  const marker = { schema: 'mvp-host-prepared-v1', hostRoot: host, pluginRoot: plugin, mode, sourceHashes: hashes,
    ...(preparation ? { preparation } : {}),
    ...(stability ? { stability } : {}),
    files: Object.fromEntries(OUTPUTS.map(n => [n, sha(files[n])])) };
  files['prepared.local.json'] = Buffer.from(JSON.stringify(marker, null, 2));
  if (Object.values(files).reduce((n, b) => n + b.length, 0) > 256 * 1024) throw new Error('MVP entry exceeds 256KiB.');
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(host, name), bytes, fs.existsSync(path.join(host, name)) ? {} : { flag: 'wx' });
  return verify();
}
if (require.main === module) { try { const args = process.argv.slice(2); if (args.length && !['--preparation', '--preparation-hevc', '--preparation-vp9', '--experience', '--stability-vp9', '--stability-hevc'].includes(args.join(' '))) throw Error('Use explicit --preparation[-hevc|-vp9], --stability-vp9, --stability-hevc or --experience.');
  const result = prepare(args.length ? args[0].slice(2) : 'performance'); console.log(JSON.stringify({ host, manifest: path.join(host, 'manifest.json'), mode: result.marker.mode, bytes: result.bytes,
  loadedInEagle: false, metricsExecuted: false })); } catch (e) { console.error(e.stack); process.exitCode = 1; } }
module.exports = { prepare, verify, sourceHashes, SOURCE_FILES, _test: { validSources, entryMode } };
