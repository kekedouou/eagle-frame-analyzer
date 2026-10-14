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
// An empty record has no PID to inspect. Windows FileShare.None establishes
// that no initializer still holds it, and keeps replacement/writes excluded
// until the new owner's complete record has been flushed. No age heuristic.
function claimEmptyWriter(file, bytes) {
  const fs = require('fs');
  if (process.platform !== 'win32' || path.basename(file) !== 'writer.lock' || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 4096) return false;
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== 0n || fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) return false;
  const code = String.raw`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class EvaEmptyWriter {
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attr; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Access,Written; public uint Volume,HighSize,LowSize,Links,HighIndex,LowIndex; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint flags);
 public static bool Claim(string file,string inode,string volume,byte[] bytes) {
  try { using(var f=new FileStream(file,FileMode.Open,FileAccess.ReadWrite,FileShare.None)) {
   Info i; var p=new StringBuilder(32768);
   if(!GetFileInformationByHandle(f.SafeFileHandle,out i)) throw new IOException("File identity unavailable");
   uint n=GetFinalPathNameByHandle(f.SafeFileHandle,p,(uint)p.Capacity,0);
   string final=p.ToString(); if(final.StartsWith(@"\\?\")) final=final.Substring(4);
   ulong id=((ulong)i.HighIndex<<32)|i.LowIndex;
   if(n==0 || n>=p.Capacity || !String.Equals(final,file,StringComparison.OrdinalIgnoreCase) ||
      id.ToString()!=inode || i.Volume.ToString()!=volume || i.Links!=1 || (i.Attr & (0x400u|0x10u))!=0 || f.Length!=0) return false;
   f.Write(bytes,0,bytes.Length); f.Flush(true); return true;
  }} catch(IOException e) { int code=e.HResult & 65535; if(code==32 || code==33 || code==2 || code==3) return false; throw; }
 }
}
'@; [EvaEmptyWriter]::Claim($env:EVA_EMPTY_WRITER_PATH,$env:EVA_EMPTY_WRITER_INODE,$env:EVA_EMPTY_WRITER_VOLUME,[Convert]::FromBase64String($env:EVA_EMPTY_WRITER_BYTES))`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 10000,
    env: { ...process.env, EVA_EMPTY_WRITER_PATH: file, EVA_EMPTY_WRITER_INODE: before.ino.toString(), EVA_EMPTY_WRITER_VOLUME: before.dev.toString(), EVA_EMPTY_WRITER_BYTES: bytes.toString('base64') } });
  if (result.error || result.status !== 0) throw new Error('无法独占核对残留记录；原件保留。');
  return result.stdout.trim() === 'True';
}
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
    if (current && same(record && record.processIdentity, current)) return { safe: false, reason: 'original-process-is-this-running-process' };
    try { return proveGone(record, query()); }
    catch (_) { return { safe: false, reason: 'process-query-failed' }; }
  }
  return Object.freeze({ self, child, inspect, claimEmptyWriter });
}
module.exports = { createIdentity, claimEmptyWriter, _test: { valid, same, proveGone, snapshot } };
