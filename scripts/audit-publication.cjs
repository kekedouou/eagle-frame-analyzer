'use strict';
// Read-only privacy preflight. Emits categories/filenames, never matched secret text.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), MAX = 64 * 1024 ** 2;
const privatePath = /(?:[A-Za-z]:[\\/]+Users[\\/]+|[A-Za-z]:[\\/]+documents[\\/]+Codex|[A-Za-z]:[\\/]+Assets[\\/]+Eagle|\.library[\\/]+)/i;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}/;
const forbidden = /(?:^|\/)(?:\.env(?:\..*)?|write-approval\.json|memory-settings(?:\.next)?\.json|(?:config|tools-[^/]+)\.local\.json)$|\.(?:mp4|mov|mkv|wav|mp3|zip|exe|pfx|pem)$/i;
function git(args, input) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: MAX, windowsHide: true }); }
function inspect(bytes) {
  const text = bytes.toString('utf8'), wide = bytes.toString('utf16le');
  return { privatePath: privatePath.test(text) || privatePath.test(wide), secretPattern: secret.test(text) || secret.test(wide) };
}
function audit(base = 'origin/main') {
  if (!/^[A-Za-z0-9_./-]+$/.test(base)) throw Error('Invalid local audit ref.');
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
  const currentFindings = [], binaryFiles = [];
  for (const file of files) {
    const absolute = path.resolve(ROOT, file), s = fs.lstatSync(absolute);
    if (!absolute.startsWith(ROOT + path.sep) || !s.isFile() || s.isSymbolicLink() || s.size > MAX) throw Error('Unexpected tracked file boundary.');
    const b = fs.readFileSync(absolute), flags = inspect(b);
    if (flags.privatePath || flags.secretPattern || forbidden.test(file)) {
      let unchangedPublicAncestor = false;
      try { const previous = execFileSync('git', ['show', base + ':' + file], { cwd: ROOT, maxBuffer: MAX, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        unchangedPublicAncestor = previous.equals(b); } catch (_) {}
      currentFindings.push({ file, ...flags, forbiddenFile: forbidden.test(file), unchangedPublicAncestor });
    }
    if (!/\.(?:md|js|cjs|cs|css|html|json|txt|ps1)$/.test(file) && file !== '.gitignore') binaryFiles.push({ file, bytes: b.length });
  }
  const objects = git(['rev-list', '--objects', base + '..HEAD']).trim().split(/\r?\n/).filter(Boolean).map(row => {
    const at = row.indexOf(' '); return { id: at < 0 ? row : row.slice(0, at), file: at < 0 ? null : row.slice(at + 1) };
  });
  const types = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], objects.map(o => o.id).join('\n') + '\n')
    .trim().split(/\r?\n/).filter(Boolean).map(line => line.split(' '));
  const blobs = types.filter(row => row[1] === 'blob'), total = blobs.reduce((n, row) => n + Number(row[2]), 0);
  if (total > MAX) throw Error('Pending history exceeds bounded audit size; no partial clearance issued.');
  const findings = [];
  for (const row of blobs) {
    const b = execFileSync('git', ['cat-file', 'blob', row[0]], { cwd: ROOT, maxBuffer: MAX, windowsHide: true }), flags = inspect(b);
    const names = objects.filter(o => o.id === row[0] && o.file).map(o => o.file);
    if (flags.privatePath || flags.secretPattern || names.some(n => forbidden.test(n))) findings.push({ object: row[0], files: names, ...flags, forbiddenFile: names.some(n => forbidden.test(n)) });
  }
  const result = { schema: 'eva-publication-privacy-audit-v1', base, head: git(['rev-parse', 'HEAD']).trim(),
    currentFiles: files.length, currentFindings, binaryFiles, currentPatternCheckPassed: currentFindings.length === 0,
    newCurrentFindings: currentFindings.filter(f => !f.unchangedPublicAncestor),
    pendingCommits: Number(git(['rev-list', '--count', base + '..HEAD']).trim()), pendingBlobs: blobs.length, pendingBlobBytes: total,
    pendingHistoryFindings: findings, pendingHistoryPrivacyDecisionRequired: findings.length > 0,
    limitations: ['Pattern checks are not a guarantee against every secret; no image OCR, attribution or rights clearance.',
      'Already-public remote ancestors are not removed by current-file changes; no history rewriting or remote writes performed.'] };
  return result;
}
if (require.main === module) { if (process.argv.length > 3) throw Error('Use an optional local base ref only.');
  const r = audit(process.argv[2]); console.log(JSON.stringify(r, null, 2)); if (!r.currentPatternCheckPassed) process.exitCode = 1; }
module.exports = { audit, inspect };
