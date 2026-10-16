'use strict';
// Packaging logic only: no archive creation, media, Eagle or source writes.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const pack = require('../scripts/package-release.cjs'), root = path.resolve(__dirname, '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const base = Object.fromEntries(pack.RUNTIME.filter(n => !/native\/task-host\.local\.(exe|json)$/.test(n))
  .map(n => [n, fs.readFileSync(path.join(root, 'plugin', n))]));
// Model bytes exercise dependency/hash rules; not a claim that this is an executable.
base['native/task-host.local.exe'] = Buffer.from('MZ test-only guard model');
base['native/task-host.local.json'] = Buffer.from(JSON.stringify({ schema: 'eva-task-guard-build-v1',
  bytes: base['native/task-host.local.exe'].length, sourceSha256: sha(base['native/task-host.cs']), executableSha256: sha(base['native/task-host.local.exe']) }));
base['manifest.json'] = pack.packageManifest(base['manifest.json']);
const copy = () => Object.fromEntries(Object.entries(base).map(([n, b]) => [n, Buffer.from(b)])); let count = 0;
function test(name, f) { f(); count++; console.log('ok release package: ' + name); }
test('complete latest runtime closes native, worker, frame-pack and UI dependencies', () => assert(pack.validateRuntime(copy()).dependenciesChecked));
for (const name of ['frame-pack.cjs', 'task-client.cjs', 'task-worker.cjs', 'native/task-host.cs', 'native/task-host.local.exe', 'native/task-host.local.json'])
  test('missing ' + name + ' is refused', () => { const files = copy(); delete files[name]; assert.throws(() => pack.validateRuntime(files)); });
test('extra preference/media data cannot enter the allowlist', () => { const files = copy(); files['memory-settings.json'] = Buffer.from('{}'); assert.throws(() => pack.validateRuntime(files)); });
test('guard metadata cannot validate substituted binary bytes', () => { const files = copy(); files['native/task-host.local.exe'][3] ^= 1; assert.throws(() => pack.validateRuntime(files)); });
test('guard source hash remains required on relocated installation', () => { const files = copy(); files['native/task-host.cs'] = Buffer.from('changed source'); assert.throws(() => pack.validateRuntime(files)); });
test('native metadata cannot contain an unreviewed absolute output path', () => { const files = copy(); const meta = JSON.parse(files['native/task-host.local.json']); meta.output = 'unknown'; files['native/task-host.local.json'] = Buffer.from(JSON.stringify(meta)); assert.throws(() => pack.validateRuntime(files)); });
test('missing relative script and external absolute entry references fail', () => { for (const replacement of ['missing.js', 'file:///unexpected.js']) {
  const files = copy(); files['index.html'] = Buffer.from(files['index.html'].toString().replace('src="player.js"', 'src="' + replacement + '"')); assert.throws(() => pack.validateRuntime(files)); }
});
test('unbundled third-party require is refused', () => { const files = copy(); files['ui.js'] = Buffer.from("require('unreviewed-library');"); assert.throws(() => pack.validateRuntime(files)); });
test('machine-specific user paths are refused without logging their content', () => assert.throws(() => pack.scanText(Buffer.from('Z:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'example'), 'model')));
test('common credential pattern is refused', () => assert.throws(() => pack.scanText(Buffer.from('gh' + 'p_' + 'x'.repeat(40)), 'model')));
test('UTF16 binary strings use the same private-path check', () => assert.throws(() => pack.scanText(Buffer.from('Z:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'example', 'utf16le'), 'native-model')));
test('release identity is stable across beta updates and version is exact', () => { const m = JSON.parse(base['manifest.json']); assert.equal(m.id, pack.ID); assert.equal(m.version, pack.VERSION); assert.equal(m.arch, 'x64'); });
console.log('Release package: ' + count + ' pure/model checks; no ZIP, real executable or Eagle execution.');
