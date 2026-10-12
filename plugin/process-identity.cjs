'use strict';
// Read-only process evidence. No process is terminated by recovery.
const { spawnSync } = require('child_process');
const path = require('path');
function snapshot() {
  if (process.platform !== 'win32') throw new Error('Automatic orphan recovery requires Windows process identity evidence.');
  const code = '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $rows=@(Get-CimInstance Win32_Process | ForEach-Object { '
    + '[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;'
    + 'startTicks=$(if($_.CreationDate){[string]$_.CreationDate.ToUniversalTime().Ticks}else{$null});image=$_.ExecutablePath} }); '
    + 'ConvertTo-Json -InputObject $rows -Compress';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code],
    { windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 2 * 1024 ** 2, timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error('Cannot obtain a complete process snapshot; orphan records retained.');
  const rows = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(rows) || rows.length > 16384 || new Set(rows.map(r => r.pid)).size !== rows.length ||
    rows.some(r => !Number.isSafeInteger(r.pid) || r.pid < 0 || !Number.isSafeInteger(r.parentPid) || r.parentPid < 0))
    throw new Error('Process snapshot is incomplete or invalid; orphan records retained.');
  return rows;
}
function valid(identity) {
  return identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && typeof identity.startTicks === 'string' &&
    /^\d{16,20}$/.test(identity.startTicks) && typeof identity.image === 'string' && !identity.image.includes('\ufffd') && path.win32.isAbsolute(identity.image);
}
function same(a, b) { return valid(a) && valid(b) && a.pid === b.pid && a.startTicks === b.startTicks && a.image.toLowerCase() === b.image.toLowerCase(); }
function proveGone(record, rows) {
  if (!record || !valid(record.processIdentity) || !Array.isArray(record.children) || record.children.some(child =>
    !['starting', 'running', 'closed'].includes(child.state) || child.state === 'starting' || child.state === 'running' && !valid(child.identity)))
    return { safe: false, reason: 'missing-process-birth-or-child-registration' };
  const identities = [record.processIdentity, ...record.children.filter(c => valid(c.identity)).map(c => c.identity)];
  for (const old of identities) {
    const current = rows.find(row => row.pid === old.pid);
    if (current && !valid(current)) return { safe: false, reason: 'process-identity-unavailable' };
    if (current && same(old, current)) return { safe: false, reason: 'original-process-still-alive' };
    if (current && BigInt(current.startTicks) <= BigInt(old.startTicks)) return { safe: false, reason: 'contradictory-process-birth' };
    // Reused PIDs are a different process, but surviving children born in
    // the old parent's lifetime still block recovery. Unknown births block.
    const surviving = rows.filter(row => row.parentPid === old.pid && (!row.startTicks ||
      BigInt(row.startTicks) >= BigInt(old.startTicks) && (!current || BigInt(row.startTicks) < BigInt(current.startTicks))));
    if (surviving.length) return { safe: false, reason: 'possible-surviving-descendant' };
  }
  return { safe: true, reason: 'recorded-process-instances-and-observed-descendants-gone',
    limitation: 'Snapshot is read-only and not an OS job object; unknown/incomplete registrations are retained.' };
}
function createIdentity(options = {}) {
  const query = options.query || snapshot, pid = options.pid || process.pid;
  let current;
  function self() {
    if (current !== undefined) return current;
    try { const row = query().find(item => item.pid === pid); current = valid(row) ? { pid: row.pid, startTicks: row.startTicks, image: row.image } : null; }
    catch (_) { current = null; }
    return current;
  }
  function child(childPid) {
    try {
      const row = query().find(item => item.pid === childPid);
      return valid(row) && row.parentPid === pid ? { pid: row.pid, startTicks: row.startTicks, image: row.image } : null;
    } catch (_) { return null; }
  }
  function inspect(record) {
    try { return proveGone(record, query()); }
    catch (_) { return { safe: false, reason: 'process-query-failed' }; }
  }
  return Object.freeze({ self, child, inspect });
}
module.exports = { createIdentity, _test: { valid, same, proveGone, snapshot } };
