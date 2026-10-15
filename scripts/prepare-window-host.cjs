'use strict';
// Materialize only a bounded, locally owned test entry. Never loads Eagle,
// copies product JS, prepares media, changes caches or deletes historical data.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const SCHEMA = 'eva-window-host-entry-v1', LIMIT = 256 * 1024;
const OUTPUTS = ['index.local.html', 'manifest.json', 'logo.local.png'];
const SOURCES = ['plugin/manifest.json', 'plugin/index.html', 'plugin/styles.css', 'plugin/logo.png',
  ...['app.js', 'ui.js', 'player.js', 'frame-index.cjs', 'diagnostics.cjs', 'session.cjs', 'eagle.cjs', 'media.cjs', 'cache.cjs', 'process-identity.cjs', 'preferences.cjs'].map(n => 'plugin/' + n),
  'scripts/prepare-window-host.cjs', 'tests/host/window/bootstrap.js', 'tests/support/window-launch.cjs', 'tests/support/window-host.cjs',
  'tests/support/window-resource.cjs', 'tests/support/window-annotations.cjs', 'tests/support/t0-protocol.cjs', 'tests/support/t0-gate.cjs', 'tests/support/t2-evidence.cjs',
  'tests/support/ram-diagnostic.cjs', 'tests/support/window-reuse.cjs'];
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function same(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function directory(dir, io) {
  const stat = io.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !same(io.realpathSync(dir), dir)) throw new Error('Test entry directory must be canonical and without links.');
}
function read(file, io) {
  const a = io.lstatSync(file);
  if (!a.isFile() || a.isSymbolicLink() || a.nlink !== 1 || a.size > 1024 ** 2 || !same(io.realpathSync(file), file))
    throw new Error('Test input must be a bounded canonical single-link file.');
  const data = io.readFileSync(file), b = io.lstatSync(file);
  if (a.ino !== b.ino || a.dev !== b.dev || a.size !== b.size || a.mtimeMs !== b.mtimeMs || data.length !== a.size)
    throw new Error('Test input changed while reading.');
  return data;
}
function paths(repo, io) {
  const root = path.resolve(repo), plugin = path.join(root, 'plugin'), host = path.join(root, 'tests/host/window');
  for (const dir of [root, plugin, path.join(root, 'tests'), path.join(root, 'tests/host'), host]) directory(dir, io);
  if (/^c:/i.test(root)) throw new Error('The test entry must remain on the non-C project disk.');
  return { root, plugin, host };
}
function sourceHashes(root, io) { return Object.fromEntries(SOURCES.map(name => [name, sha(read(path.join(root, name), io))])); }
function render(html, plugin, hashes, mode = 'performance') {
  let out = html;
  for (const name of ['styles.css', 'player.js', 'ui.js', 'app.js']) {
    const attribute = name.endsWith('.css') ? 'href' : 'src', token = attribute + '="' + name + '"';
    if (out.split(token).length !== 2) throw new Error('Product HTML entry changed: ' + name);
    const url = pathToFileURL(path.join(plugin, name)).href + '?verify=' + hashes['plugin/' + name];
    out = out.replace(token, attribute + '="' + url.replace(/&/g, '&amp;') + '"');
  }
  const app = '<script src="' + (pathToFileURL(path.join(plugin, 'app.js')).href + '?verify=' + hashes['plugin/app.js']).replace(/&/g, '&amp;') + '"></script>';
  out = out.replace(app, '<script src="bootstrap.js?verify=' + hashes['tests/host/window/bootstrap.js'] + '"></script>\n  ' + app);
  return out.replace('<title>视频分析</title>', '<title>' + (mode === 'window-checks' ? 'T2 窗口验收' : mode === 'annotations' ? 'T3 标注验收' : mode === 'preferences' ? 'T2 内存设置验收' : 'T2 自动测量') + ' · 视频分析</title>');
}
function validApproval(value) {
  if (value == null) return true;
  return value.schema === 'T3-one-comment-approval-v1' && typeof value.itemId === 'string' && value.itemId &&
    typeof value.libraryPath === 'string' && path.isAbsolute(value.libraryPath) && !value.libraryPath.includes('\0') && Number.isSafeInteger(value.frameId) && value.frameId >= 0 &&
    typeof value.text === 'string' && value.text.trim() && Number.isFinite(value.time) && value.time >= 0 &&
    typeof value.userQuote === 'string' && value.userQuote.trim() && value.addOnce === true && typeof value.allowDelete === 'boolean';
}
function validRam(value) {
  if (value == null) return true;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== (value.schema === 'T2-ram-host-v2' ? 'compressedMiB,ramMiB,rendererStopMiB,schema' : 'compressedMiB,ramMiB,schema')) return false;
  try { require('../tests/support/ram-diagnostic.cjs').hostRssLimit(value); return true; } catch (_) { return false; }
}
function generated(root, io, mode = 'performance', writeApproval = null, ramDiagnostic = null) {
  if (!validRam(ramDiagnostic) || ramDiagnostic && !['performance', 'reuse'].includes(mode)) throw new Error('RAM candidate requires the bounded performance protocol or approved reuse protocol.');
  if (mode === 'reuse' && (!ramDiagnostic || ramDiagnostic.schema !== 'T2-ram-host-v2')) throw new Error('Reuse requires the approved 2GiB configuration.');
  if (!['performance', 'resource', 'annotations', 'preferences', 'reuse', 'window-checks'].includes(mode) || !validApproval(writeApproval) || mode !== 'annotations' && writeApproval)
    throw new Error('Unknown measurement protocol or annotation approval.');
  const p = paths(root, io), hashes = sourceHashes(p.root, io);
  const original = JSON.parse(read(path.join(p.plugin, 'manifest.json'), io));
  if (original.main.multiple !== false || original.main.url !== 'index.html') throw new Error('Unexpected formal Window entry.');
  const manifest = { ...original, id: 'EVAWINDOWVERIFY20261013', name: mode === 'window-checks' ? '视频分析 · T2 窗口验收' : mode === 'annotations' ? '视频分析 · T3 标注验收' : mode === 'preferences' ? '视频分析 · T2 内存设置验收' : '视频分析 · T2 自动测量', logo: '/logo.local.png',
    keywords: ['视频', mode === 'annotations' ? 'T3' : 'T2', '验证'], devTools: false, main: { ...original.main, url: 'index.local.html', runAfterInstall: false } };
  const files = { 'index.local.html': Buffer.from(render(read(path.join(p.plugin, 'index.html'), io).toString('utf8'), p.plugin, hashes, mode)),
    'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)), 'logo.local.png': read(path.join(p.plugin, 'logo.png'), io) };
  const marker = { schema: SCHEMA, mode, hostRoot: p.host, pluginRoot: p.plugin, sourceHashes: hashes,
    files: Object.fromEntries(OUTPUTS.map(n => [n, sha(files[n])])) };
  if (mode === 'annotations') marker.writeApproval = writeApproval;
  if (ramDiagnostic) marker.ramDiagnostic = ramDiagnostic;
  files['prepared.local.json'] = Buffer.from(JSON.stringify(marker, null, 2));
  const bytes = Object.values(files).reduce((n, data) => n + data.length, 0);
  if (bytes > LIMIT) throw new Error('Generated test entry exceeds 256KiB.');
  return { ...p, files, marker, bytes };
}
function verify(repo, io = fs, verifySources = true) {
  const p = paths(repo, io), marker = JSON.parse(read(path.join(p.host, 'prepared.local.json'), io));
  const keys = JSON.stringify(Object.keys(marker.sourceHashes || {}).sort());
  const current = JSON.stringify(SOURCES.slice().sort()), previous = JSON.stringify(SOURCES.filter(name => name !== 'plugin/process-identity.cjs').sort());
  // Only preparation can migrate the immediately preceding, fully owned
  // source list. Actual launch verification always requires the complete list.
  const preceding = JSON.stringify(SOURCES.filter(name => name !== 'tests/support/window-resource.cjs').sort());
  const beforeAnnotations = JSON.stringify(SOURCES.filter(name => name !== 'tests/support/window-annotations.cjs').sort());
  const beforeRam = JSON.stringify(SOURCES.filter(name => name !== 'tests/support/ram-diagnostic.cjs').sort());
  const beforePreferences = JSON.stringify(SOURCES.filter(name => name !== 'plugin/preferences.cjs').sort());
  const beforeReuse = JSON.stringify(SOURCES.filter(name => name !== 'tests/support/window-reuse.cjs').sort());
  const knownSourceList = keys === current || !verifySources && (keys === previous || keys === preceding || keys === beforeAnnotations || keys === beforeRam || keys === beforePreferences || keys === beforeReuse);
  if (marker.mode !== undefined && !['performance', 'resource', 'annotations', 'preferences', 'reuse', 'window-checks'].includes(marker.mode) || !validApproval(marker.writeApproval) ||
      !validRam(marker.ramDiagnostic) || marker.ramDiagnostic && !['performance', 'reuse'].includes(marker.mode) ||
      marker.mode === 'reuse' && (!marker.ramDiagnostic || marker.ramDiagnostic.schema !== 'T2-ram-host-v2')) throw new Error('Unknown measurement protocol.');
  if (marker.schema !== SCHEMA || !same(marker.hostRoot, p.host) || !same(marker.pluginRoot, p.plugin) ||
      JSON.stringify(Object.keys(marker.files).sort()) !== JSON.stringify(OUTPUTS.slice().sort()) ||
      !knownSourceList || Object.values(marker.sourceHashes).some(value => !/^[0-9a-f]{64}$/.test(value))) throw new Error('Unknown test entry ownership or file list.');
  let bytes = read(path.join(p.host, 'prepared.local.json'), io).length;
  for (const name of OUTPUTS) { const data = read(path.join(p.host, name), io); bytes += data.length;
    if (sha(data) !== marker.files[name]) throw new Error('Generated test entry changed: ' + name); }
  if (bytes > LIMIT) throw new Error('Prepared test entry exceeds 256KiB.');
  if (verifySources && JSON.stringify(sourceHashes(p.root, io)) !== JSON.stringify(marker.sourceHashes))
    throw new Error('正式代码或测试驱动已变化，请由Codex重新准备验证入口。');
  return { ...p, marker, bytes };
}
function prepare(repo, io = fs, mode = 'performance', writeApproval = null, ramDiagnostic = null) {
  const value = generated(repo, io, mode, writeApproval, ramDiagnostic), names = [...OUTPUTS, 'prepared.local.json'];
  if (names.some(n => io.existsSync(path.join(value.host, n)))) verify(repo, io, false);
  for (const name of names) {
    const file = path.join(value.host, name);
    io.writeFileSync(file, value.files[name], io.existsSync(file) ? {} : { flag: 'wx' });
  }
  return verify(repo, io);
}
if (require.main === module) {
  try { if (process.argv.includes('--ram-compare') && process.argv.includes('--ram-compare-2g')) throw new Error('Choose only one RAM comparison configuration.');
    const modes = ['--preferences', '--annotations', '--resource', '--reuse', '--window-checks'].filter(flag => process.argv.includes(flag));
    if (modes.length > 1) throw new Error('Choose only one measurement protocol.');
    const value = prepare(path.resolve(__dirname, '..'), fs, process.argv.includes('--window-checks') ? 'window-checks' : process.argv.includes('--reuse') ? 'reuse' : process.argv.includes('--preferences') ? 'preferences' : process.argv.includes('--annotations') ? 'annotations' : process.argv.includes('--resource') ? 'resource' : 'performance', null,
    process.argv.includes('--ram-compare-2g') ? { schema: 'T2-ram-host-v2', ramMiB: 2048, compressedMiB: 256, rendererStopMiB: 3072 } :
      process.argv.includes('--ram-compare') ? { schema: 'T2-ram-host-v1', ramMiB: 1024, compressedMiB: 128 } : null); console.log(JSON.stringify({ host: value.host, bytes: value.bytes,
    manifest: path.join(value.host, 'manifest.json'), boundary: 'Prepared only; Eagle not loaded and no performance test executed.' })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare, verify, render, sourceHashes, SOURCES, OUTPUTS, SCHEMA, LIMIT };
