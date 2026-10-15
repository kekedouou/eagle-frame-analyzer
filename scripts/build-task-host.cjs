'use strict';
// Compile the small Windows guard with the compiler already shipped on Windows.
// Explicit development command; never installs software or runs Eagle.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..'), native = path.join(root, 'plugin/native');
const source = path.join(native, 'task-host.cs'), output = path.join(native, 'task-host.local.exe');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
if (!fs.existsSync(compiler)) throw new Error('Existing Windows C# compiler unavailable; no installation attempted.');
if (fs.existsSync(output)) {
  const previous = JSON.parse(fs.readFileSync(path.join(native, 'task-host.local.json'))), stat = fs.lstatSync(output);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || previous.schema !== 'eva-task-guard-build-v1' ||
      sha(fs.readFileSync(output)) !== previous.executableSha256) throw new Error('Unknown or changed existing guard output; not overwritten.');
}
const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/out:' + output, source], {
  windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 32768 });
if (result.error || result.status !== 0) throw new Error(result.stdout || result.stderr || String(result.error));
const bytes = fs.readFileSync(output);
if (bytes.length > 256 * 1024) throw new Error('Guard exceeds 256KiB build boundary.');
fs.writeFileSync(path.join(native, 'task-host.local.json'), JSON.stringify({ schema: 'eva-task-guard-build-v1',
  sourceSha256: sha(fs.readFileSync(source)), executableSha256: sha(bytes), bytes: bytes.length }, null, 2));
console.log(JSON.stringify({ executable: output, bytes: bytes.length, sha256: sha(bytes) }));
