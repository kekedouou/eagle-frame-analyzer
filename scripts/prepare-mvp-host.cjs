'use strict';
// Produces a bounded, separate stage-4 verification entry, not a product build.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { pathToFileURL } = require('url');
const repo = path.resolve(__dirname, '..'), host = path.join(repo, 'tests/host/t4'), plugin = path.join(repo, 'plugin');
const OUTPUTS = ['manifest.json', 'index.local.html', 'logo.local.png'];
const SOURCE_FILES = [
  'app.js', 'cache.cjs', 'diagnostics.cjs', 'eagle.cjs', 'frame-index.cjs', 'index.html', 'logo.png', 'manifest.json', 'media.cjs',
  'player.js', 'preferences.cjs', 'process-identity.cjs', 'session.cjs', 'styles.css', 'task-client.cjs', 'task-worker.cjs', 'ui.js',
  'native/task-host.cs', 'native/task-host.local.exe'
].map(n => 'plugin/' + n).concat(['scripts/prepare-mvp-host.cjs', 'scripts/build-resource-sampler.cjs',
  'tests/host/t4/bootstrap.js', 'tests/support/mvp-launch.cjs', 'tests/support/mvp-monitor.cjs', 'tests/support/mvp-resource.cjs',
  'tests/support/t4-evidence.cjs', 'tests/support/window-host.cjs', 'tests/support/t0-protocol.cjs', 'tests/support/t0-gate.cjs',
  'tests/support/ram-diagnostic.cjs', 'tests/native/resource-sampler.cs', 'tests/native/resource-sampler.local.exe']);
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
function verify(checkSources = true) {
  boundaries(); const marker = JSON.parse(read(path.join(host, 'prepared.local.json')));
  if (marker.schema !== 'mvp-host-prepared-v1' || marker.hostRoot.toLowerCase() !== host.toLowerCase() || marker.pluginRoot.toLowerCase() !== plugin.toLowerCase() ||
      JSON.stringify(Object.keys(marker.files).sort()) !== JSON.stringify(OUTPUTS.slice().sort()) ||
      JSON.stringify(Object.keys(marker.sourceHashes).sort()) !== JSON.stringify(SOURCE_FILES.slice().sort())) throw new Error('Unknown MVP entry ownership.');
  let bytes = read(path.join(host, 'prepared.local.json')).length;
  for (const name of OUTPUTS) { const b = read(path.join(host, name)); bytes += b.length; if (sha(b) !== marker.files[name]) throw new Error('Prepared MVP entry modified.'); }
  if (bytes > 256 * 1024 || checkSources && JSON.stringify(sourceHashes()) !== JSON.stringify(marker.sourceHashes)) throw new Error('MVP entry source fingerprints changed; reprepare required.');
  require('../plugin/task-client.cjs').verifyGuard(plugin); require('./build-resource-sampler.cjs').verify();
  return { host, plugin, marker, bytes };
}
function prepare() {
  const hashes = sourceHashes(), manifest = JSON.parse(read(path.join(plugin, 'manifest.json')));
  manifest.id = 'EVAMVPACCEPT20261015'; manifest.name = '视频分析 · 阶段4验收'; manifest.logo = '/logo.local.png'; manifest.main.url = 'index.local.html';
  let html = read(path.join(plugin, 'index.html')).toString('utf8');
  for (const name of ['styles.css', 'player.js', 'ui.js', 'app.js']) {
    const attribute = name.endsWith('.css') ? 'href' : 'src', token = attribute + '="' + name + '"';
    if (html.split(token).length !== 2) throw new Error('Formal HTML structure changed.');
    html = html.replace(token, attribute + '="' + pathToFileURL(path.join(plugin, name)).href + '?verify=' + hashes['plugin/' + name] + '"');
  }
  html = html.replace(/(<script src="[^"\n]*\/app\.js\?verify=[^"\n]+"><\/script>)/,
    '<script src="bootstrap.js"></script>\n  $1').replace('<title>视频分析</title>', '<title>阶段4验收 · 视频分析</title>');
  if (!html.includes('src="bootstrap.js"')) throw new Error('Formal app entry missing.');
  const files = { 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)), 'index.local.html': Buffer.from(html),
    'logo.local.png': read(path.join(plugin, 'logo.png')) };
  const marker = { schema: 'mvp-host-prepared-v1', hostRoot: host, pluginRoot: plugin, sourceHashes: hashes,
    files: Object.fromEntries(OUTPUTS.map(n => [n, sha(files[n])])) };
  files['prepared.local.json'] = Buffer.from(JSON.stringify(marker, null, 2));
  if (Object.values(files).reduce((n, b) => n + b.length, 0) > 256 * 1024) throw new Error('MVP entry exceeds 256KiB.');
  if (Object.keys(files).some(n => fs.existsSync(path.join(host, n)))) verify(false);
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(host, name), bytes, fs.existsSync(path.join(host, name)) ? {} : { flag: 'wx' });
  return verify();
}
if (require.main === module) { try { const result = prepare(); console.log(JSON.stringify({ host, manifest: path.join(host, 'manifest.json'), bytes: result.bytes,
  loadedInEagle: false, metricsExecuted: false })); } catch (e) { console.error(e.stack); process.exitCode = 1; } }
module.exports = { prepare, verify, sourceHashes, SOURCE_FILES };
