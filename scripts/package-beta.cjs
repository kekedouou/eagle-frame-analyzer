'use strict';
// One frozen, allowlisted local preview. Never copies runtime data or replaces an existing package.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..'), label = '0.1.0-beta.1';
const name = 'eagle-video-analysis-' + label + '-20261014', dist = path.join(root, 'dist');
const folder = path.join(dist, name), zip = folder + '.zip', id = 'EVAVIDEOANALYSISBETA20261014';
const runtime = ['manifest.json', 'index.html', 'styles.css', 'logo.png', 'app.js', 'ui.js', 'player.js',
  'session.cjs', 'eagle.cjs', 'media.cjs', 'cache.cjs', 'process-identity.cjs', 'frame-index.cjs', 'diagnostics.cjs', 'preferences.cjs'];
const names = [...runtime, 'README.md', 'BUILD-INFO.json'].sort(), limit = 2 * 1024 ** 2;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(file) { return path.resolve(file).toLowerCase() === fs.realpathSync(file).toLowerCase(); }
function directory(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && canonical(file), 'Package directory must be canonical.');
}
function read(file) {
  const a = fs.lstatSync(file);
  assert(a.isFile() && !a.isSymbolicLink() && a.nlink === 1 && a.size <= limit && canonical(file), 'Unsafe or oversized package file.');
  const bytes = fs.readFileSync(file), b = fs.lstatSync(file);
  assert(a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && bytes.length === a.size, 'File changed while reading.');
  return bytes;
}
function powershell(source) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, EVA_BETA_FOLDER: folder, EVA_BETA_ZIP: zip }
  });
  if (result.error || result.status !== 0) throw new Error('Preview archive failed: ' + (result.error ? result.error.message : result.stderr));
  return result.stdout.trim().replace(/^\uFEFF/, '');
}
function verify() {
  directory(dist); directory(folder);
  assert.deepStrictEqual(fs.readdirSync(folder).sort(), names, 'Unexpected package file, including possible runtime/private data.');
  const build = JSON.parse(read(path.join(folder, 'BUILD-INFO.json')));
  assert.strictEqual(build.schema, 'eva-beta-snapshot-v1'); assert.strictEqual(build.label, label);
  assert.strictEqual(build.pluginId, id); assert(/^[0-9a-f]{40}$/.test(build.sourceCommit));
  assert.deepStrictEqual(Object.keys(build.files).sort(), names.filter(n => n !== 'BUILD-INFO.json'));
  let total = 0;
  const expected = names.map(file => {
    const bytes = read(path.join(folder, file)); total += bytes.length;
    if (file !== 'BUILD-INFO.json') {
      assert.strictEqual(sha(bytes), build.files[file].sha256, 'Snapshot changed: ' + file);
      assert.strictEqual(bytes.length, build.files[file].bytes);
    }
    return { name: name + '/' + file, bytes: bytes.length, sha256: sha(bytes) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  assert(total <= limit, 'Preview exceeds 2MiB.');
  const manifest = JSON.parse(read(path.join(folder, 'manifest.json')));
  assert.strictEqual(manifest.id, id); assert.strictEqual(manifest.main.url, 'index.html');
  assert.strictEqual(manifest.devTools, false); assert.strictEqual(manifest.main.multiple, false);
  assert(!/tests[\/\\]|prototypes[\/\\]|index\.local|bootstrap/.test(read(path.join(folder, 'index.html')).toString()));
  const archive = read(zip);
  const entries = JSON.parse(powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $z=[System.IO.Compression.ZipFile]::OpenRead($env:EVA_BETA_ZIP);
    try { $items=@(foreach($e in $z.Entries){ if($e.Length -gt 2097152){throw 'Archive entry too large'};
      $s=$e.Open(); $h=[System.Security.Cryptography.SHA256]::Create();
      try { [pscustomobject]@{name=$e.FullName.Replace('\\','/');bytes=$e.Length;sha256=[BitConverter]::ToString($h.ComputeHash($s)).Replace('-','').ToLowerInvariant()} }
      finally {$s.Dispose();$h.Dispose()} }); ConvertTo-Json -InputObject $items -Compress }
    finally {$z.Dispose()}`)).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepStrictEqual(entries, expected, 'Archive differs from the frozen file allowlist.');
  return { schema: 'eva-beta-package-verification-v1', label, sourceCommit: build.sourceCommit,
    folder: path.relative(root, folder), zip: path.relative(root, zip), files: names.length, unpackedBytes: total,
    zipBytes: archive.length, zipSha256: sha(archive), exactArchiveVerified: true,
    realEaglePackagedCopyVerified: false, frozenRuntime: true, noRuntimeOrPrivateData: true };
}
function build() {
  assert(!fs.readFileSync(path.join(root, 'plugin/app.js'), 'utf8').includes('task-client.cjs') || runtime.includes('task-client.cjs'),
    'Lifecycle runtime changed; update a new release package allowlist before packaging. Existing frozen snapshots remain verifiable.');
  directory(root); directory(path.join(root, 'plugin'));
  assert(process.platform === 'win32' && !/^c:/i.test(root), 'Preview must be created on a non-C Windows drive.');
  if (!fs.existsSync(dist)) fs.mkdirSync(dist); directory(dist);
  assert(!fs.existsSync(folder) && !fs.existsSync(zip), 'Preview already exists; verify it instead of overwriting.');
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(revision.status, 0); const sourceCommit = revision.stdout.trim(); assert(/^[0-9a-f]{40}$/.test(sourceCommit));
  const changes = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'plugin'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert(changes.status === 0 && !changes.stdout.trim(), 'Runtime must match its Git source commit.');
  const files = {}, sources = {};
  for (const file of runtime) {
    const bytes = read(path.join(root, 'plugin', file)); files[file] = bytes; sources[file] = sha(bytes);
  }
  const original = JSON.parse(files['manifest.json']);
  assert.strictEqual(original.id, 'EVAVIDEOANALYSIS20261011');
  files['manifest.json'] = Buffer.from(JSON.stringify({ ...original, id, name: '视频分析 · 内测预览', keywords: ['视频', '逐帧', '分析', '内测'] }, null, 2) + '\n');
  files['README.md'] = read(path.join(root, 'docs', 'beta-preview.md'));
  const info = { schema: 'eva-beta-snapshot-v1', label, pluginId: id, sourceCommit,
    createdAt: new Date().toISOString(), sourceRuntimeSha256: sources,
    files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, { bytes: bytes.length, sha256: sha(bytes) }])),
    changesFromSource: ['manifest.json: independent preview identity and display name only'],
    documentationSource: 'docs/beta-preview.md', realEaglePackagedCopyVerified: false,
    developmentStage: 'Stage 4 remains in progress; not T2/T4/MVP acceptance', containsMediaOrToolsOrPreferences: false };
  files['BUILD-INFO.json'] = Buffer.from(JSON.stringify(info, null, 2) + '\n');
  assert(Object.values(files).reduce((n, b) => n + b.length, 0) <= limit);
  fs.mkdirSync(folder);
  for (const [file, bytes] of Object.entries(files)) fs.writeFileSync(path.join(folder, file), bytes, { flag: 'wx' });
  powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem;
    [System.IO.Compression.ZipFile]::CreateFromDirectory($env:EVA_BETA_FOLDER,$env:EVA_BETA_ZIP,[System.IO.Compression.CompressionLevel]::Optimal,$true)`);
  return verify();
}
if (require.main === module) {
  assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--verify', 'Only --verify is supported.');
  console.log(JSON.stringify(process.argv.length === 3 ? verify() : build(), null, 2));
}
module.exports = { build, verify };
