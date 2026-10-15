'use strict';
// Test tool only. Existing Windows compiler; no installation or product change.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawnSync } = require('child_process');
const native = path.resolve(__dirname, '../tests/native'), source = path.join(native, 'resource-sampler.cs');
const output = path.join(native, 'resource-sampler.local.exe'), marker = path.join(native, 'resource-sampler.local.json');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function build() {
  for (const file of [native, source]) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error('Observer source boundary invalid.');
  }
  if (fs.existsSync(output) || fs.existsSync(marker)) {
    for (const file of [output, marker]) {
      const existing = fs.lstatSync(file);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || fs.realpathSync(file).toLowerCase() !== file.toLowerCase())
        throw new Error('Observer output boundary changed; original retained.');
    }
    const stat = fs.lstatSync(output), previous = JSON.parse(fs.readFileSync(marker));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || previous.schema !== 'mvp-resource-observer-build-v1' ||
        sha(fs.readFileSync(output)) !== previous.executableSha256) throw new Error('Unknown observer output retained.');
  }
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('Existing compiler unavailable; nothing installed.');
  const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll', '/out:' + output, source],
    { windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 32768 });
  if (result.error || result.status !== 0) throw new Error(result.stdout || result.stderr || String(result.error));
  const bytes = fs.readFileSync(output);
  if (bytes.length > 256 * 1024) throw new Error('Observer exceeds 256KiB.');
  const info = { schema: 'mvp-resource-observer-build-v1', sourceSha256: sha(fs.readFileSync(source)), executableSha256: sha(bytes), bytes: bytes.length };
  fs.writeFileSync(marker, JSON.stringify(info, null, 2));
  return { executable: output, ...info };
}
function verify() {
  const info = JSON.parse(fs.readFileSync(marker));
  for (const file of [native, source, output, marker]) {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink() || fs.realpathSync(file).toLowerCase() !== file.toLowerCase() || s.isFile() && s.nlink !== 1) throw new Error('Observer build boundary invalid.');
  }
  const bytes = fs.readFileSync(output);
  if (info.schema !== 'mvp-resource-observer-build-v1' || info.bytes !== bytes.length || bytes.length > 256 * 1024 ||
      sha(bytes) !== info.executableSha256 || sha(fs.readFileSync(source)) !== info.sourceSha256) throw new Error('Observer build fingerprint changed.');
  return output;
}
if (require.main === module) { try { console.log(JSON.stringify(build())); } catch (e) { console.error(e.stack); process.exitCode = 1; } }
module.exports = { verify };
