'use strict';
// Explicit, bounded real Windows checks. No real Eagle UI/library or media.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert'), { spawn } = require('child_process');
const { createTaskClient } = require('../plugin/task-client.cjs');
const repo = path.resolve(__dirname, '..'), root = path.join(repo, 'tests/host/t2/lifecycle-scratch');
const runtime = 'G:\\Assets\\Eagle\\Eagle.exe';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
if (process.argv[2] === 'disconnect-child') {
  const client = createTaskClient({ pluginRoot: process.argv[3], runtime, discoverTools: async () => ({}) });
  client.ping().then(value => { process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(0)); }).catch(error => { console.error(error); process.exit(1); });
} else main().catch(error => { console.error(error.stack); process.exitCode = 1; });
async function main() {
  if (fs.existsSync(root)) throw new Error('Previous lifecycle scratch retained; inspect instead of overwriting.');
  if (!root.startsWith(repo + path.sep) || fs.realpathSync(path.dirname(root)) !== path.dirname(root)) throw new Error('Scratch boundary invalid.');
  const files = new Map(), clients = new Set(), results = [];
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'native'));
  function write(name, bytes) {
    bytes = Buffer.from(bytes); if ([...files.values()].reduce((n, f) => n + f.bytes, 0) + bytes.length > 2 * 1024 ** 2) throw new Error('Scratch exceeds 2MiB.');
    const file = path.join(root, name); fs.writeFileSync(file, bytes, { flag: 'wx' });
    files.set(file, { bytes: bytes.length, sha256: sha(bytes), ino: fs.statSync(file, { bigint: true }).ino.toString() });
  }
  write('owner.json', JSON.stringify({ owner: 'eva-lifecycle-guard-check-v1', root }));
  for (const name of ['task-host.cs', 'task-host.local.exe', 'task-host.local.json']) write('native/' + name, fs.readFileSync(path.join(repo, 'plugin/native', name)));
  write('task-worker.cjs', String.raw`
const readline=require('readline'),cp=require('child_process');
const owner={key:process.env.EVA_TASK_KEY,epoch:process.env.EVA_TASK_EPOCH,guardPid:Number(process.env.EVA_TASK_GUARD_PID)};
let child=null,closing=false;function send(v){process.stdout.write(JSON.stringify(v)+'\n');}
function finish(id){if(closing)return;closing=true;const done=()=>{if(id)send({type:'response',id,result:{status:'closed'}});process.stdout.write('',()=>process.exit(0));};if(child){child.once('close',done);child.kill();}else done();}
const input=readline.createInterface({input:process.stdin});
input.on('line',s=>{const m=JSON.parse(s);if(m.method==='ping'){if(!child)child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:'ignore'});send({type:'response',id:m.id,result:{pid:process.pid,taskOwner:owner,descendant:child.pid}});}else if(m.method==='close'&&process.env.EVA_TASK_TEST_IGNORE_EOF!=='1')finish(m.id);});
input.on('close',()=>{if(process.env.EVA_TASK_TEST_IGNORE_EOF!=='1')finish();});
send({type:'ready',taskOwner:owner,pid:process.pid,node:process.versions.node});
`);
  const oldIgnore = process.env.EVA_TASK_TEST_IGNORE_EOF;
  function client(options = {}) { const value = createTaskClient({ pluginRoot: root, runtime, discoverTools: async () => ({}), ...options }); clients.add(value); return value; }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function gone(pid, limit = 10000) { const until = Date.now() + limit;
    for (;;) { try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
      if (Date.now() >= until) throw new Error('Owned process still alive: ' + pid); await sleep(25); }
  }
  function killOwned(pid, parentPid) {
    const rows = require('../plugin/process-identity.cjs')._test.snapshot(), row = rows.find(r => r.pid === pid);
    assert(row && (parentPid ? row.parentPid === parentPid : row.image.toLowerCase() === path.join(root, 'native/task-host.local.exe').toLowerCase()));
    process.kill(pid);
  }
  try {
    let waiting; const observed = new Promise(resolve => { waiting = resolve; });
    const a = client(), first = await a.ping(), b = client({ onWaiting: waiting });
    let settled = false; const next = b.ping().then(value => { settled = true; return value; });
    await observed; assert.equal(settled, false); await a.close(); const second = await next; await b.close();
    await Promise.all([gone(first.descendant), gone(second.descendant)]); results.push('two-owned-instances-wait-and-handover');
    for (const target of ['guard', 'worker']) {
      const broken = client(), info = await broken.ping();
      killOwned(target === 'guard' ? info.taskOwner.guardPid : info.pid, target === 'worker' ? info.taskOwner.guardPid : null);
      await assert.rejects(broken.close());
      await Promise.all([gone(info.pid), gone(info.descendant), gone(info.taskOwner.guardPid)]);
      const replacement = client(); await replacement.ping(); await replacement.close();
      results.push(target + '-death-stops-descendant-and-next-owner-recovers');
    }
    process.env.EVA_TASK_TEST_IGNORE_EOF = '1';
    const disconnectAt = Date.now();
    const disconnected = await new Promise((resolve, reject) => {
      const parent = spawn(process.execPath, [__filename, 'disconnect-child', root], { env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = ''; parent.stdout.on('data', b => { out += b; }); parent.stderr.on('data', b => { err += b; });
      parent.on('error', reject); parent.on('close', code => { if (code) reject(new Error(err)); else resolve(JSON.parse(out)); });
    });
    await Promise.all([gone(disconnected.pid, 20000), gone(disconnected.descendant, 20000), gone(disconnected.taskOwner.guardPid, 20000)]);
    const disconnectMs = Date.now() - disconnectAt;
    assert(disconnectMs >= 14000 && disconnectMs < 22000, 'Detached guard must survive client exit, then enforce its own bounded shutdown.');
    results.push('client-disconnect-ends-unresponsive-owned-group-without-Eagle-kill');
    const stuck = client(), stuckInfo = await stuck.ping(), closeAt = Date.now();
    stuck.beginClose(); await assert.rejects(stuck.close());
    await Promise.all([gone(stuckInfo.pid), gone(stuckInfo.descendant), gone(stuckInfo.taskOwner.guardPid)]);
    assert(Date.now() - closeAt >= 14000 && Date.now() - closeAt < 22000, 'A connected closing window must also have a bounded owned-task deadline.');
    results.push('connected-close-ends-unresponsive-owned-group-without-Eagle-kill');
    if (oldIgnore === undefined) delete process.env.EVA_TASK_TEST_IGNORE_EOF; else process.env.EVA_TASK_TEST_IGNORE_EOF = oldIgnore;
    for (let i = 0; i < 20; i++) { const c = client(); const value = await c.ping(); await c.close(); await gone(value.descendant); }
    results.push('twenty-rapid-real-process-open-close-cycles');
    console.log(JSON.stringify({ protocol: 'eva-real-windows-guard-v1', passed: true, cases: results, eagleGuiExecuted: false,
      cacheOrLibraryTouched: false, sourceSha256: sha(fs.readFileSync(path.join(repo, 'plugin/native/task-host.cs'))), scratchBytes: [...files.values()].reduce((n, f) => n + f.bytes, 0) }));
  } finally {
    if (oldIgnore === undefined) delete process.env.EVA_TASK_TEST_IGNORE_EOF; else process.env.EVA_TASK_TEST_IGNORE_EOF = oldIgnore;
    await Promise.allSettled([...clients].map(c => c.close()));
    for (const [file, expected] of files) {
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile() || stat.ino.toString() !== expected.ino || Number(stat.size) !== expected.bytes || sha(fs.readFileSync(file)) !== expected.sha256) throw new Error('Scratch identity changed; retained.');
    }
    for (const file of files.keys()) fs.unlinkSync(file);
    fs.rmdirSync(path.join(root, 'native')); fs.rmdirSync(root);
  }
}
