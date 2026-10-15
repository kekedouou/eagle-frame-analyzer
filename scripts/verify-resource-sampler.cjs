'use strict';
// Real Windows observer check using only a short, isolated owned task group.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert'), { spawn, spawnSync } = require('child_process');
const { createTaskClient } = require('../plugin/task-client.cjs');
const { createAggregation } = require('../tests/support/mvp-resource.cjs');
const { verify } = require('./build-resource-sampler.cjs');
const repo = path.resolve(__dirname, '..'), scratch = path.join(repo, 'tests/host/t4/resource-scratch');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function rootIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Explicit owned PID required.');
  const command = '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); '
    + '$p=Get-Process -Id ' + pid + '; [pscustomobject]@{pid=$p.Id;startTicks=[string]$p.StartTime.ToUniversalTime().Ticks;image=$p.MainModule.FileName}|ConvertTo-Json -Compress';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
  if (result.error || result.status !== 0) throw new Error('Cannot establish exact owned process identity.');
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}
async function observe(root, duration = 1500, onStarted = null) {
  const executable = verify(), child = spawn(executable, ['100', String(duration), String(root.pid), root.startTicks, root.role || 'task-guard', root.image],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = []; let bytes = 0, stderr = '', timeout;
  return await new Promise((resolve, reject) => {
    const fail = error => { child.kill(); reject(error); };
    timeout = setTimeout(() => fail(new Error('Owned observer exceeded 8-second check deadline.')), 8000);
    child.once('error', reject);
    child.stdout.on('data', b => { bytes += b.length; if (bytes > 256 * 1024) fail(new Error('Short observation exceeds 256KiB pipe boundary.'));
      else { chunks.push(b); if (chunks.length === 1 && onStarted) onStarted(); } });
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-8192); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error('Observer failed: ' + stderr));
      try { resolve(Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))); }
      catch (error) { reject(error); }
    });
  });
}
async function main() {
  if (fs.existsSync(scratch)) throw new Error('Previous observer scratch retained; inspect before retry.');
  const host = path.dirname(scratch);
  if (!fs.existsSync(host)) fs.mkdirSync(host);
  if (!scratch.startsWith(repo + path.sep) || fs.realpathSync(host) !== host || fs.lstatSync(host).isSymbolicLink()) throw new Error('Observer scratch boundary invalid.');
  const owned = new Map(); let complete = false, client;
  fs.mkdirSync(scratch); fs.mkdirSync(path.join(scratch, 'native'));
  function write(name, data) {
    const bytes = Buffer.from(data), file = path.join(scratch, name);
    if ([...owned.values()].reduce((n, x) => n + x.bytes, 0) + bytes.length > 2 * 1024 ** 2) throw new Error('Observer scratch exceeds 2MiB.');
    fs.writeFileSync(file, bytes, { flag: 'wx' }); const stat = fs.lstatSync(file, { bigint: true });
    owned.set(file, { bytes: bytes.length, sha256: sha(bytes), ino: stat.ino.toString(), dev: stat.dev.toString() });
  }
  try {
    write('owner.json', JSON.stringify({ owner: 'mvp-owned-observer-check-v1', root: scratch }));
    for (const name of ['task-host.cs', 'task-host.local.exe', 'task-host.local.json']) write('native/' + name, fs.readFileSync(path.join(repo, 'plugin/native', name)));
    write('task-worker.cjs', String.raw`
const readline=require('readline');
const taskOwner={schema:'eva-task-owner-v1',key:process.env.EVA_TASK_KEY,epoch:process.env.EVA_TASK_EPOCH,guardPid:Number(process.env.EVA_TASK_GUARD_PID)};
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='ping')send({type:'response',id:m.id,result:{pid:process.pid,taskOwner}});else if(m.method==='close'){send({type:'response',id:m.id,result:{status:'closed'}});process.stdout.write('',()=>process.exit(0));}}).on('close',()=>process.exit(0));
send({type:'ready',pid:process.pid,taskOwner,node:process.versions.node});
`);
    client = createTaskClient({ pluginRoot: scratch, runtime: 'G:\\Assets\\Eagle\\Eagle.exe', discoverTools: async () => ({}) });
    const active = await client.ping(), root = rootIdentity(active.taskOwner.guardPid);
    assert.strictEqual(path.resolve(root.image).toLowerCase(), path.join(scratch, 'native/task-host.local.exe').toLowerCase());
    const rows = await observe(root), aggregate = createAggregation();
    assert(rows.length >= 10);
    for (const row of rows) {
      aggregate.add(row); assert.deepStrictEqual(row.errors, []);
      assert(row.processes.some(p => p.pid === root.pid && p.role === 'task-guard'));
      assert(row.processes.some(p => p.pid === active.pid && p.role === 'task-worker'));
      assert(row.processes.some(p => p.role === 'observer'));
    }
    const result = aggregate.summary(); assert.deepStrictEqual(result.stopReasons, []);
    const wrong = await observe({ ...root, startTicks: (BigInt(root.startTicks) + 1n).toString() }, 500);
    assert(wrong.length >= 3);
    for (const row of wrong) { assert.strictEqual(row.roots[0].alive, false);
      assert(!row.processes.some(p => p.pid === root.pid || p.pid === active.pid)); }
    let closing;
    const dynamic = await observe({ pid: process.pid, startTicks: 'parent', image: process.execPath, role: 'renderer' }, 1500,
      () => { closing = client.close(); closing.catch(() => {}); });
    await closing; assert(client.stopped);
    const dynamicAggregate = createAggregation(); for (const row of dynamic) dynamicAggregate.add(row);
    assert(dynamic.some(row => row.processes.some(p => p.pid === root.pid && p.role === 'task-guard')));
    assert(dynamic.some(row => row.processes.some(p => p.pid === active.pid && p.role === 'task-worker')));
    assert(!dynamic[dynamic.length - 1].processes.some(p => p.pid === root.pid || p.pid === active.pid));
    assert.deepStrictEqual(dynamicAggregate.summary().stopReasons, []);
    complete = true;
    console.log(JSON.stringify({ schema: 'mvp-real-windows-observer-check-v1', passed: true,
      cases: ['real-guard-worker-observed-separately', 'observer-overhead-separated', 'wrong-creation-time-excluded',
        'renderer-proxy-descendants-discovered', 'owned-task-closes-while-observer-stays-open'],
      observer: result, dynamicObserver: dynamicAggregate.summary(), scratchBytes: [...owned.values()].reduce((n, x) => n + x.bytes, 0),
      productCacheTouched: false, realEagleGuiExecuted: false, mediaGenerated: false,
      limitation: 'About 3.5 seconds on isolated processes, including a Node renderer proxy; not real-player RSS, peak FFmpeg, long-run P-04 or performance acceptance.' }));
  } finally {
    if (client && !client.stopped) await client.close();
    if (complete) {
      for (const [file, expected] of owned) {
        if (!path.resolve(file).startsWith(scratch + path.sep) || fs.realpathSync(file) !== file) throw new Error('Owned cleanup path changed.');
        const stat = fs.lstatSync(file, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino.toString() !== expected.ino || stat.dev.toString() !== expected.dev ||
            Number(stat.size) !== expected.bytes || sha(fs.readFileSync(file)) !== expected.sha256) throw new Error('Owned cleanup identity/content changed.');
      }
      for (const file of owned.keys()) fs.unlinkSync(file);
      fs.rmdirSync(path.join(scratch, 'native')); fs.rmdirSync(scratch);
    }
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { rootIdentity };
