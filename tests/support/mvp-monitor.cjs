'use strict';
// Test-only observer process; never imports a product task owner or opens a Job.
const { spawn } = require('child_process');
const { verify } = require('../../scripts/build-resource-sampler.cjs');
const { createAggregation, approvedLimits } = require('./mvp-resource.cjs');
function start(options) {
  const long = options.long === true;
  if (long && typeof options.onRow !== 'function') throw Error('Long observation requires a bounded streaming sink.');
  const durationMs = long ? 3960000 : 180000, pipeBytes = (long ? 32 : 4) * 1024 ** 2, rowLimit = long ? 39700 : 2000;
  const expand = long ? require('./long-trace.cjs').compactDecoder() : value => value;
  const aggregate = createAggregation(approvedLimits(options.ramBytes));
  const child = (options.spawn || spawn)((options.verify || verify)(), ['100', String(durationMs), ...(long ? ['compact'] : []), String(process.pid), 'parent', 'renderer', process.execPath],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '', totalBytes = 0, issue = null, requestedStop = false, ended = false, deadline = null, notified = false;
  const rows = []; let stderr = '', resolveDone, count = 0, lastSample = null;
  const done = new Promise(resolve => { resolveDone = resolve; });
  function fault(error) {
    if (issue) return;
    issue = String(error.message || error).slice(0, 1024);
    notified = true; try { if (options.onStop) options.onStop(new Error(issue)); } catch (_) {}
    stop();
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    try {
      totalBytes += Buffer.byteLength(data);
      if (totalBytes > pipeBytes) throw new Error('阶段4资源轨迹超出本轮管道边界，停止并保留已有数据。');
      pending += data;
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at).trim(); pending = pending.slice(at + 1);
        if (!line) continue;
        const row = expand(JSON.parse(line)), measured = aggregate.add(row);
        const event = { native: row, receivedAtMs: options.now(), context: options.snapshot ? options.snapshot() : null };
        lastSample = row; count++;
        if (long) options.onRow(event, measured); else rows.push(event);
        if (count > rowLimit) throw new Error('资源记录超过本轮时长边界。');
        if (measured.stopRequested) fault(new Error('资源观察停止：' + aggregate.summary().stopReasons.join(', ')));
      }
      if (Buffer.byteLength(pending) > 65536) throw new Error('资源采样行过大。');
    } catch (error) { fault(error); }
  });
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
  child.stdin.on('error', error => { if (!ended) fault(error); });
  child.once('error', fault);
  child.once('close', code => {
    ended = true; if (deadline) clearTimeout(deadline);
    if (pending.trim()) issue = issue || '资源采样最后一行未完整接收。';
    if (code !== 0) issue = issue || '资源采样程序退出失败：' + (stderr || code);
    if (!requestedStop) issue = issue || (long ? '资源采样达到66分钟期限，本轮未正常结束。' : '资源采样达到三分钟期限，本轮未正常结束。');
    if (issue && !notified) { notified = true; try { if (options.onStop) options.onStop(new Error(issue)); } catch (_) {} }
    resolveDone({ schema: 'mvp-external-resource-trace-v1', rows, issue, observer: aggregate.summary(), rawPipeBytes: totalBytes, lastSample,
      limits: { pipeBytes, rows: rowLimit, durationMs },
      limitations: ['Sample context is read at renderer receipt time, not the native measurement instant.',
        'Initial observer startup/IPC lag and short-lived processes may be missed.', 'Only declared window descendants and this sampler are observed; shared Eagle/GPU remain separate.'] });
  });
  function stop() {
    if (!requestedStop) {
      requestedStop = true;
      if (!ended) {
        child.stdin.end();
        deadline = setTimeout(() => { if (!ended) { issue = issue || '自有采样程序未及时退出。'; child.kill(); } }, 5000);
      }
    }
    return done;
  }
  return Object.freeze({ stop, done, get issue() { return issue; }, get lastSample() { return lastSample; } });
}
module.exports = { start };
