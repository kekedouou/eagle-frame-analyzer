'use strict';
// Control messages only. The existing Player reads JPEG/PCM bytes locally.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawn } = require('child_process');
const { createCache } = require('./cache.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function issue(code, message) { return Object.assign(new Error(message), { code }); }
function verifyGuard(root) {
  const native = path.join(root, 'native'), executable = path.join(native, 'task-host.local.exe');
  const build = JSON.parse(fs.readFileSync(path.join(native, 'task-host.local.json')));
  for (const file of [native, executable, path.join(native, 'task-host.cs')]) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error('任务负责人路径无效。');
  }
  const binary = fs.readFileSync(executable);
  if (build.schema !== 'eva-task-guard-build-v1' || binary.length !== build.bytes || binary.length > 256 * 1024 ||
      sha(binary) !== build.executableSha256 || sha(fs.readFileSync(path.join(native, 'task-host.cs'))) !== build.sourceSha256)
    throw new Error('任务负责人构建需要更新；请由开发者修复。');
  return executable;
}
function createTaskClient(options) {
  const root = fs.realpathSync(options.pluginRoot), local = createCache({ pluginRoot: root });
  const key = sha(Buffer.from(root.toLowerCase())), runtime = options.runtime || process.execPath;
  let host = null, ready = null, serial = 0, closing = null, ended = false, failure = null, guardFinished = false;
  let readyResolve, readyReject, exitResolve;
  let taskOwner = null;
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const pending = new Map(), leases = new Set();
  function failed(error) {
    if (failure) return; failure = error;
    if (readyReject) readyReject(error);
    for (const value of pending.values()) value.reject(error); pending.clear();
    if (!closing && options.onFailure) options.onFailure(error);
  }
  function write(value) { if (!host || ended || !host.stdin.writable) throw issue('TASK_DISCONNECTED', '视频任务连接已结束。'); host.stdin.write(JSON.stringify(value) + '\n'); }
  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); ready.catch(() => {});
    try {
      // Detached avoids Node's parent-lifetime Windows job killing the guard
      // before it can handle EOF. Our own guarded job controls its descendants.
      host = spawn(verifyGuard(root), [root, runtime, key], { detached: true, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '', stderr = '';
      host.stdout.setEncoding('utf8');
      host.stdout.on('data', chunk => {
        try {
          buffer += chunk; if (Buffer.byteLength(buffer) > 8 * 1024 ** 2) throw new Error('任务通信超过容量。');
          let at; while ((at = buffer.indexOf('\n')) >= 0) {
            const value = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
            if (value.type === 'ready') {
              if (taskOwner || !value.taskOwner || value.taskOwner.key !== key || value.taskOwner.guardPid !== host.pid ||
                  !/^[0-9a-f]{32}$/.test(value.taskOwner.epoch || '')) throw new Error('任务负责人身份不符。');
              taskOwner = value.taskOwner; readyResolve(value);
            }
            else if (value.type === 'guard' && value.event === 'waiting') { if (options.onWaiting) options.onWaiting(); }
            else if (value.type === 'guard' && value.event === 'finished') guardFinished = value.exitCode === 0;
            else if (value.type === 'progress') { const request = pending.get(value.id); if (request && request.onProgress) request.onProgress(value.value); }
            else if (value.type === 'response') {
              const request = pending.get(value.id); if (!request) throw new Error('任务响应编号无效。'); pending.delete(value.id);
              if (value.error) request.reject(issue(value.error.code, value.error.message)); else request.resolve(value.result);
            }
          }
        } catch (error) { failed(error); host.stdin.end(); }
      });
      host.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
      host.stdin.on('error', error => failed(error)); host.once('error', error => { failed(error); ended = true; exitResolve(); });
      host.once('close', code => { ended = true;
        if (!guardFinished || code !== 0 || pending.size) failed(issue('TASK_OWNER_EXITED', '视频任务负责人异常退出：' + (stderr || String(code))));
        exitResolve(); });
    } catch (error) { failed(error); ended = true; exitResolve(); }
    return ready;
  }
  async function ask(method, fields = {}, settings = {}) {
    await start(); if (failure) throw failure;
    const id = ++serial;
    const work = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress: settings.onProgress });
      try { write({ id, method, ...fields }); } catch (error) { pending.delete(id); reject(error); }
    });
    const cancel = () => { try { write({ id, method: 'cancel' }); } catch (_) {} };
    if (settings.signal) { settings.signal.addEventListener('abort', cancel, { once: true }); if (settings.signal.aborted) cancel(); }
    try { return await work; } finally { if (settings.signal) settings.signal.removeEventListener('abort', cancel); }
  }
  const cache = {
    readAsset: (...args) => failure ? Promise.reject(failure) : local.readAsset(...args),
    async release(info) { if (!leases.has(info)) return false; local.detachReadLease(info); await ask('release', { leaseId: info.leaseId }); leases.delete(info); return true; },
    clearOther: settings => ask('clearOther', { settings }),
    inventory: local.inventory
  };
  const media = { async prepare(snapshot, settings = {}) {
    const tools = await options.discoverTools(settings.signal);
    const info = await ask('prepare', { snapshot, tools }, settings);
    if (settings.signal && settings.signal.aborted) { await ask('release', { leaseId: info.leaseId }); throw issue('MEDIA_CANCELLED', '视频准备已取消。'); }
    try { local.adoptReadLease(info, taskOwner); } catch (error) { await ask('release', { leaseId: info.leaseId }); throw error; }
    leases.add(info); return info;
  } };
  function close() {
    if (closing) return closing;
    closing = (async () => {
      if (!host && !ready) return { status: 'closed' };
      for (const info of leases) local.detachReadLease(info);
      leases.clear();
      try { if (!failure && !ended) await ask('close'); }
      finally { if (host && !ended) host.stdin.end(); await exited; }
      if (failure) throw failure; return { status: 'closed' };
    })(); closing.catch(() => {}); return closing;
  }
  function beginClose() { if (host && !ended && host.stdin.writable) write({ type: 'guard', event: 'closing' }); }
  return Object.freeze({ media, cache, beginClose, close, ping: () => ask('ping'), get stopped() { return ended; } });
}
module.exports = { createTaskClient, verifyGuard };
