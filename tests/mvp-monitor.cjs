'use strict';
const assert = require('assert'), { EventEmitter } = require('events');
const { start } = require('./support/mvp-monitor.cjs');
const ticks = '638960000000000001';
function fixture() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = () => { child.inputEnded = true; setImmediate(() => child.emit('close', 0)); };
  child.kill = () => { child.killed = true; };
  const h = { child, stops: [] };
  h.monitor = start({ ramBytes: 1024 ** 3, verify: () => 'model-observer', now: () => 10,
    snapshot: () => ({ state: 'preparing' }), onStop: error => h.stops.push(error.message),
    spawn(exe, args) { assert.strictEqual(args[3], 'parent'); return child; } });
  h.row = { schema: 'mvp-process-sample-v1', atMs: 0, sampleDurationMs: 1, errors: [],
    roots: [{ pid: 1, startTicks: ticks, role: 'renderer', alive: true }],
    processes: [{ pid: 1, startTicks: ticks, role: 'renderer', root: '1:' + ticks, image: 'Eagle.exe', rssBytes: 100, cpuMs: 0 }] };
  h.send = () => child.stdout.emit('data', JSON.stringify(h.row) + '\n'); return h;
}
async function main() {
  const normal = fixture(); normal.send(); const saved = await normal.monitor.stop();
  assert.strictEqual(saved.rows.length, 1); assert.strictEqual(saved.issue, null); assert.strictEqual(normal.stops.length, 0);
  assert(normal.child.inputEnded); assert(!normal.child.killed);
  const unexpected = fixture(); unexpected.child.emit('close', 0); const lost = await unexpected.monitor.done;
  assert(lost.issue.includes('三分钟')); assert.strictEqual(unexpected.stops.length, 1);
  const over = fixture(); over.row.processes[0].rssBytes = 1.5 * 1024 ** 3; over.send();
  const stopped = await over.monitor.done; assert(stopped.issue.includes('plugin-observation-stop-line'));
  assert.strictEqual(over.stops.length, 1); assert.strictEqual(stopped.rows.length, 1);
  const corrupt = fixture(); corrupt.child.stdout.emit('data', 'not-json\n'); const rejected = await corrupt.monitor.done;
  assert(rejected.issue); assert.strictEqual(corrupt.stops.length, 1);
  console.log('MVP monitor models: graceful owned EOF, premature exit cancels work, inclusive group stop and malformed data fail visibly; no native/host execution.');
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
