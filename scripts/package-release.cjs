'use strict';
// Explicit local release packaging. Never installs/loads Eagle or modifies user data.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { spawnSync } = require('child_process'), { builtinModules } = require('module');
const VERSION = '0.1.0-beta.2', NAME = 'eagle-video-analysis-' + VERSION + '-win-x64';
const ID = 'EVAVIDEOANALYSISBETA20261014', ROOT = path.resolve(__dirname, '..'), LIMIT = 2 * 1024 ** 2;
const RUNTIME = Object.freeze(['manifest.json', 'index.html', 'styles.css', 'logo.png', 'app.js', 'ui.js', 'player.js',
  'session.cjs', 'eagle.cjs', 'media.cjs', 'cache.cjs', 'process-identity.cjs', 'frame-index.cjs', 'frame-pack.cjs',
  'diagnostics.cjs', 'preferences.cjs', 'task-client.cjs', 'task-worker.cjs',
  'native/task-host.cs', 'native/task-host.local.exe', 'native/task-host.local.json']);
const NAMES = [...RUNTIME, 'README.md', 'CHANGELOG.md', 'BUILD-INFO.json'].sort();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const dist = path.join(ROOT, 'dist'), folder = path.join(dist, NAME), zip = folder + '.zip';
const installParent = path.join(dist, 'install-check-' + VERSION), install = path.join(installParent, NAME);
function node(file, directory = false) {
  const s = fs.lstatSync(file, { bigint: true });
  assert(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile()) &&
    fs.realpathSync(file).toLowerCase() === path.resolve(file).toLowerCase() && (directory || s.nlink === 1n), 'Unsafe package path: ' + file);
  return s;
}
function read(file) {
  const s = node(file); assert(s.size <= BigInt(LIMIT), 'Package file exceeds 2MiB.');
  const b = fs.readFileSync(file), a = node(file);
  assert(['dev', 'ino', 'size', 'mtimeNs'].every(k => s[k] === a[k]) && b.length === Number(s.size), 'Package input changed.'); return b;
}
function list(directory) {
  node(directory, true); const names = [];
  function walk(at) { for (const name of fs.readdirSync(at)) {
    const f = path.join(at, name), s = fs.lstatSync(f); assert(!s.isSymbolicLink(), 'Package contains link.');
    if (s.isDirectory()) { node(f, true); walk(f); } else { node(f); names.push(path.relative(directory, f).replace(/\\/g, '/')); }
  } } walk(directory); return names.sort();
}
function scanText(bytes, label) {
  const text = bytes.toString('utf8') + '\n' + bytes.toString('utf16le');
  assert(!/(?:[A-Za-z]:[\\/]+Users[\\/]+|[A-Za-z]:[\\/]+documents[\\/]+Codex|[A-Za-z]:[\\/]+Assets[\\/]+Eagle|\.library[\\/]+)/i.test(text), 'Private machine path: ' + label);
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}/.test(text), 'Possible credential: ' + label);
}
function packageManifest(bytes) {
  const original = JSON.parse(bytes); assert.equal(original.version, VERSION); assert.equal(original.platform, 'win'); assert.equal(original.arch, 'x64');
  return Buffer.from(JSON.stringify({ ...original, id: ID, name: '视频分析 · MVP Beta', keywords: ['视频', '逐帧', '分析', 'Beta'] }, null, 2) + '\n');
}
function validateRuntime(files) {
  assert.deepStrictEqual(Object.keys(files).sort(), [...RUNTIME].sort(), 'Runtime allowlist incomplete or contains extra data.');
  const manifest = JSON.parse(files['manifest.json']);
  assert.equal(manifest.version, VERSION); assert.equal(manifest.platform, 'win'); assert.equal(manifest.arch, 'x64');
  assert.equal(manifest.id, ID); assert.equal(manifest.main.url, 'index.html'); assert.equal(manifest.main.multiple, false); assert.equal(manifest.devTools, false);
  assert.equal(manifest.logo, '/logo.png');
  const local = (name, from) => {
    const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(from), name));
    assert(!normalized.startsWith('../') && Object.hasOwn(files, normalized), 'Missing runtime dependency: ' + from + ' -> ' + name);
  };
  for (const [name, bytes] of Object.entries(files)) {
    if (/\.(?:js|cjs|cs|json|html|css|exe)$/.test(name)) scanText(bytes, name);
    if (/\.(?:js|cjs)$/.test(name)) {
      const text = bytes.toString();
      for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (m[1].startsWith('.')) local(m[1], name);
        else assert(builtinModules.includes(m[1]), 'Unexpected external runtime dependency: ' + m[1]);
      }
      for (const m of text.matchAll(/require\(path\.join\(root,\s*['"]([^'"]+)['"]\)\)/g)) local(m[1], name);
    }
  }
  for (const m of files['index.html'].toString().matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) local(m[1], 'index.html');
  assert(!/index\.local|bootstrap|tests[\\/]|prototypes[\\/]/.test(files['index.html'].toString()), 'Test entry in package.');
  assert(!/(?:id="(?:performanceTest|gate|comparison|save|refresh)")/.test(files['index.html'].toString()), 'Test control in package.');
  const build = JSON.parse(files['native/task-host.local.json']);
  assert.deepStrictEqual(Object.keys(build).sort(), ['bytes', 'executableSha256', 'schema', 'sourceSha256']);
  assert.equal(build.schema, 'eva-task-guard-build-v1'); assert.equal(build.bytes, files['native/task-host.local.exe'].length);
  assert.equal(build.sourceSha256, sha(files['native/task-host.cs'])); assert.equal(build.executableSha256, sha(files['native/task-host.local.exe']));
  assert(build.bytes <= 256 * 1024); assert.equal(files['native/task-host.local.exe'].subarray(0, 2).toString(), 'MZ');
  return { runtimeFiles: RUNTIME.length, dependenciesChecked: true, guardVerified: true };
}
function ps(source, extra = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; " + source], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 ** 2,
    env: { ...process.env, EVA_RELEASE_FOLDER: folder, EVA_RELEASE_ZIP: zip, EVA_RELEASE_NAME: NAME, EVA_RELEASE_INSTALL: installParent, ...extra }
  });
  if (r.error || r.status !== 0) throw new Error('Archive operation failed: ' + (r.error ? r.error.message : r.stderr));
  return r.stdout.trim().replace(/^\uFEFF/, '');
}
function verify() {
  node(dist, true); assert.deepStrictEqual(list(folder), NAMES, 'Package contains missing or extra files.');
  const info = JSON.parse(read(path.join(folder, 'BUILD-INFO.json'))); assert.equal(info.schema, 'eva-release-snapshot-v1');
  assert.equal(info.version, VERSION); assert(/^[0-9a-f]{40}$/.test(info.sourceCommit)); assert.equal(info.pluginId, ID);
  assert.deepStrictEqual(Object.keys(info.files).sort(), NAMES.filter(n => n !== 'BUILD-INFO.json'));
  const runtime = {}, expected = []; let bytes = 0;
  for (const name of NAMES) {
    const b = read(path.join(folder, name)); bytes += b.length;
    if (info.files[name]) { assert.equal(sha(b), info.files[name].sha256, 'Snapshot changed: ' + name); assert.equal(b.length, info.files[name].bytes); }
    if (/\.(?:js|cjs|cs|json|html|css|md|exe)$/.test(name)) scanText(b, name);
    if (RUNTIME.includes(name)) runtime[name] = b;
    expected.push({ name: NAME + '/' + name, bytes: b.length, sha256: sha(b) });
  }
  assert(bytes <= LIMIT); const wiring = validateRuntime(runtime), archive = read(zip);
  const entries = JSON.parse(ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $z=[IO.Compression.ZipFile]::OpenRead($env:EVA_RELEASE_ZIP); try {
      $rows=@(foreach($e in $z.Entries){ if($e.Length -gt 2097152){throw 'Archive entry too large'};
        $s=$e.Open(); $h=[Security.Cryptography.SHA256]::Create(); try {
          [pscustomobject]@{name=$e.FullName.Replace('\\','/');bytes=$e.Length;sha256=[BitConverter]::ToString($h.ComputeHash($s)).Replace('-','').ToLowerInvariant()}
        } finally {$s.Dispose();$h.Dispose()} }); ConvertTo-Json -InputObject $rows -Compress
    } finally {$z.Dispose()}`));
  assert.deepStrictEqual(entries.sort((a, b) => a.name.localeCompare(b.name)), expected.sort((a, b) => a.name.localeCompare(b.name)), 'ZIP contents differ from frozen allowlist.');
  const checksum = read(zip + '.sha256').toString(); assert.equal(checksum, sha(archive) + '  ' + path.basename(zip) + '\n');
  return { schema: 'eva-release-package-check-v1', version: VERSION, sourceCommit: info.sourceCommit, pluginId: ID,
    zip: path.relative(ROOT, zip).replace(/\\/g, '/'), zipSha256: sha(archive), files: NAMES.length, unpackedBytes: bytes, zipBytes: archive.length,
    ...wiring, exactZipVerified: true, currentTextPrivacyCheckPassed: true, realEaglePackagedCopyVerified: false,
    limitations: ['Static package checks do not establish real Eagle startup, long-term stability, binary/OCR or full-history privacy clearance.'] };
}
function build() {
  assert(process.platform === 'win32' && !/^c:/i.test(ROOT), 'Build on a non-C Windows drive.'); node(ROOT, true);
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert(status.status === 0 && !status.stdout.trim(), 'Commit reviewed sources before freezing package.');
  const revision = spawnSync('git', ['show', '-s', '--format=%H%n%cI', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(revision.status, 0); const [sourceCommit, commitTime] = revision.stdout.trim().split(/\r?\n/);
  if (!fs.existsSync(dist)) fs.mkdirSync(dist); node(dist, true);
  assert(!fs.existsSync(folder) && !fs.existsSync(zip) && !fs.existsSync(zip + '.sha256'), 'Release candidate already exists; verify instead of overwriting.');
  const files = {}, sources = {};
  for (const name of RUNTIME) { const b = read(path.join(ROOT, 'plugin', name)); sources[name] = sha(b); files[name] = b; }
  files['manifest.json'] = packageManifest(files['manifest.json']); validateRuntime(files);
  files['README.md'] = read(path.join(ROOT, 'docs/beta-preview.md')); files['CHANGELOG.md'] = read(path.join(ROOT, 'CHANGELOG.md'));
  const info = { schema: 'eva-release-snapshot-v1', version: VERSION, pluginId: ID, sourceCommit, commitTime,
    sourceRuntimeSha256: sources, files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, { bytes: b.length, sha256: sha(b) }])),
    changesFromSource: ['manifest.json: distribution plugin ID, display name and keywords only'],
    requirements: ['Windows x64', 'Eagle 4.0 Build 22+', 'Eagle FFmpeg module', 'Writable non-C extraction directory'],
    licenseDecision: 'Project open-source license not designated; no new license granted by this package.',
    realEaglePackagedCopyVerified: false, longTermStabilityVerified: false,
    reproduction: 'Use this source commit and verified native build; ZIP entries use commit time. Fresh compiler outputs are hash-checked but not promised byte-identical.' };
  files['BUILD-INFO.json'] = Buffer.from(JSON.stringify(info, null, 2) + '\n');
  assert(Object.values(files).reduce((n, b) => n + b.length, 0) <= LIMIT);
  for (const [n, b] of Object.entries(files)) if (/\.(?:js|cjs|cs|json|html|css|md|exe)$/.test(n)) scanText(b, n);
  assert.equal(ps('Write-Output ([IO.Compression.ZipArchiveMode]::Create.ToString())'), 'Create', 'Archive support unavailable; no output created.');
  fs.mkdirSync(folder); fs.mkdirSync(path.join(folder, 'native'));
  for (const name of NAMES) fs.writeFileSync(path.join(folder, name), files[name], { flag: 'wx' });
  ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $z=[IO.Compression.ZipFile]::Open($env:EVA_RELEASE_ZIP,[IO.Compression.ZipArchiveMode]::Create); try {
      $stamp=[DateTimeOffset]::Parse($env:EVA_RELEASE_TIME);
      foreach($name in ($env:EVA_RELEASE_FILES | ConvertFrom-Json)) {
        $entry=$z.CreateEntry($env:EVA_RELEASE_NAME+'/'+$name,[IO.Compression.CompressionLevel]::Optimal); $entry.LastWriteTime=$stamp;
        $inputFile=[IO.File]::OpenRead([IO.Path]::Combine($env:EVA_RELEASE_FOLDER,$name)); $outputFile=$entry.Open();
        try {$inputFile.CopyTo($outputFile)} finally {$outputFile.Dispose();$inputFile.Dispose()}
      }
    } finally {$z.Dispose()}`, { EVA_RELEASE_FILES: JSON.stringify(NAMES), EVA_RELEASE_TIME: commitTime });
  fs.writeFileSync(zip + '.sha256', sha(read(zip)) + '  ' + path.basename(zip) + '\n', { flag: 'wx' }); return verify();
}
function extract() {
  const checked = verify(); assert(!fs.existsSync(installParent), 'Independent test directory already exists; do not overwrite user data.');
  ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:EVA_RELEASE_ZIP,$env:EVA_RELEASE_INSTALL)`);
  fs.writeFileSync(path.join(installParent, 'owner.json'), JSON.stringify({ schema: 'eva-release-install-check-v1', version: VERSION,
    sourceCommit: checked.sourceCommit, zipSha256: checked.zipSha256, folder: NAME }, null, 2), { flag: 'wx' });
  assert.deepStrictEqual(list(install), NAMES); return verifyInstall();
}
function verifyInstall() {
  const checked = verify(); node(installParent, true); node(install, true);
  const owner = JSON.parse(read(path.join(installParent, 'owner.json'))); assert.equal(owner.schema, 'eva-release-install-check-v1');
  assert.equal(owner.version, VERSION); assert.equal(owner.folder, NAME); assert.equal(owner.zipSha256, checked.zipSha256);
  for (const name of NAMES) assert.equal(sha(read(path.join(install, name))), sha(read(path.join(folder, name))), 'Installed runtime changed: ' + name);
  assert(fs.readdirSync(install).every(n => NAMES.includes(n) || n === 'native' || n === 'cache' || /^memory-settings(?:\.next)?\.json$/.test(n)), 'Unexpected installation content.');
  const guard = require('../plugin/task-client.cjs').verifyGuard(install); assert.equal(guard, path.join(install, 'native/task-host.local.exe'));
  return { ...checked, independentExtractedFilesVerified: true, independentPluginRoot: install,
    realEaglePackagedCopyVerified: false, note: 'Independent path/native hashes passed; actual Eagle loading still requires host observation.' };
}
if (require.main === module) {
  const mode = process.argv[2] || 'build'; assert(process.argv.length <= 3 && ['build', 'verify', 'extract', 'verify-install'].includes(mode));
  console.log(JSON.stringify(({ build, verify, extract, 'verify-install': verifyInstall })[mode](), null, 2));
}
module.exports = { VERSION, NAME, ID, RUNTIME, packageManifest, validateRuntime, scanText, build, verify, extract, verifyInstall };
