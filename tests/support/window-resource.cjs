'use strict';
// Test-only workload. Product code never imports or calls this driver.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { createStore } = require('./t2-evidence.cjs');
const { validateSnapshot } = require('../../plugin/eagle.cjs');
const { _test: { registeredManifest } } = require('./window-host.cjs');
const MIB = 1024 ** 2;
const PROTOCOL = Object.freeze({ workMs: 3600000, idleMs: 300000, cycleMs: 60000,
  sampleMs: 100, actionMs: 1000 / 120, loadTimeoutMs: 120000, settleMs: 10000 });
const KNOWN = Object.freeze([
  { id: 'MV3FZJJ7AC1CI', sha256: '0823a48f0d7b365163297206e8e8c66591c3aa6cf4c30253b3187d19c9644cba' },
  { id: 'MV3FZ0Z86KYBH', sha256: 'aabf057017744c38737f65c4e7a983a1f8d9e5258c178bcc3e723dcdb56ccc53' }
]);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
async function hashSource(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 ** 3 ||
    fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('源路径边界变化。');
  const digest = crypto.createHash('sha256');
  for await (const data of fs.createReadStream(file, { highWaterMark: MIB })) digest.update(data);
  const after = fs.lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('核对期间源视频变化。');
  return digest.digest('hex');
}
async function selections(eagle, first, root, dependencies = {}) {
  if (!eagle.item || typeof eagle.item.getSelected !== 'function' || typeof eagle.item.getById !== 'function')
    throw new Error('真实SDK缺少只读选中/按ID读取接口。');
  const original = eagle.item.getSelected, other = KNOWN.find(item => item.id !== first.sourceIdentity.itemId);
  const current = { ...validateSnapshot(first.source), sha256: first.sourceIdentity.sha256 };
  const read = validateSnapshot(await eagle.item.getById(other.id));
  if (read.id !== other.id) throw new Error('SDK按ID读回的素材身份不符。');
  const samples = [current, { ...read, sha256: other.sha256 }];
  const sourceHash = dependencies.hashSource || hashSource;
  const manifest = dependencies.manifest || registeredManifest;
  const verifyAssets = dependencies.verifyAssets || (async (sample, info) => {
    const { RECIPE } = require('../../plugin/cache.cjs');
    const directory = path.join(root, 'cache', 'media-' + sample.sha256 + '-' + sha(Buffer.from(RECIPE)).slice(0, 12));
    for (const asset of info.frames.concat(info.audio ? [info.audio] : [])) {
      if (typeof asset.file !== 'string' || !/^(?:\d{6}\.jpg|audio\.wav)$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256))
        throw new Error('缓存资产边界或指纹不可靠。');
      const file = path.join(directory, asset.file);
      if (fs.lstatSync(file).size !== asset.bytes || await sourceHash(file) !== asset.sha256) throw new Error('缓存资产缺失或损坏，停止测试而非重新生成。');
    }
  });
  let selected = 0, installed = false;
  async function verify(sample) {
    if (await sourceHash(sample.filePath) !== sample.sha256) throw new Error('固定素材内容发生变化，禁止生成替代缓存。');
    const result = manifest(root, { sourceIdentity: { itemId: sample.id, sha256: sample.sha256 } });
    await verifyAssets(sample, result.info);
  }
  for (const item of samples) await verify(item); // Missing complete cache fails before overriding selection.
  const wrapped = async () => { const item = samples[selected]; await verify(item); return [item]; };
  eagle.item.getSelected = wrapped;
  installed = eagle.item.getSelected === wrapped;
  if (!installed) throw new Error('SDK选中读取不可包装，未开始测试。');
  return { samples, choose(index) { if (index !== 0 && index !== 1) throw new Error('样本编号越界。'); selected = index; },
    async verify() { for (const item of samples) await verify(item); },
    restore() { if (installed && eagle.item.getSelected === wrapped) eagle.item.getSelected = original; installed = false; } };
}
function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function trends(rows, protocol = PROTOCOL) {
  const unit = protocol.workMs / 60, groups = new Map();
  for (const row of rows) {
    const minute = row[0] / unit;
    if (!(minute >= 10 && minute < 15 || minute >= 55 && minute < 60) || row[1] === 'idle' || row[1] === 'load') continue;
    const key = row[1] + ':' + row[2];
    if (!groups.has(key)) groups.set(key, { phase: row[1], sample: row[2], early: [], late: [] });
    groups.get(key)[minute < 15 ? 'early' : 'late'].push(row[3]);
  }
  const result = [...groups.values()].map(group => {
    const baseline = median(group.early), final = median(group.late), limit = baseline === null ? null : Math.max(64 * MIB, baseline * .1);
    return { phase: group.phase, sample: group.sample, earlySamples: group.early.length, lateSamples: group.late.length,
      baselineMedianBytes: baseline, finalMedianBytes: final, growthBytes: baseline === null || final === null ? null : final - baseline,
      allowedGrowthBytes: limit, passed: group.early.length >= 30 && group.late.length >= 30 && final - baseline <= limit };
  });
  return { groups: result, passed: result.length === 6 && result.every(group => group.passed) };
}
function packRows(rows) {
  const raw = Buffer.from(JSON.stringify(rows));
  if (raw.length > 256 * 1024) throw new Error('资源记录段超过256KiB，保留既有证据。');
  const bytes = zlib.gzipSync(raw);
  if (bytes.length > 48 * 1024) throw new Error('资源记录压缩段超过48KiB，保留既有证据。');
  return { encoding: 'gzip-base64', rows: rows.length, rawBytes: raw.length, sha256: sha(bytes), data: bytes.toString('base64') };
}
function run(options) { return execute(options, PROTOCOL); }
function execute(options, protocol) {
  const { bridge, document: doc, window: win, pluginRoot } = options;
  const first = bridge && bridge.snapshot();
  if (!first || first.state !== 'paused' || !first.loadMetrics || !first.sourceIdentity ||
    !win || !doc || typeof options.reloadSelected !== 'function' || typeof options.closeSession !== 'function')
    throw new Error('资源验证需要正式首帧、重载和正常退出回调。');
  const now = () => win.performance.now(), sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const store = (options.createStore || createStore)(path.dirname(pluginRoot));
  store.start({ reserveBytes: 4 * MIB });
  const memory = options.memory || (() => process.memoryUsage().rss), cpu = options.cpu || (() => process.cpuUsage());
  let selection, issue = null, recording = false, gesture = false, disposedBudget = null, sampleTimer = null;
  let phase = 'setup', sampleIndex = 0, begin = 0, previousSampleAt = null, maxSampleGapMs = 0;
  let pendingRows = [], comparisonRows = [], chunks = [], loads = [], measuredFrames = 0, totalSamples = 0;
  let peakRss = 0, peakManaged = 0, lastCPU = null, eventErrors = 0, complete = false, saveFailed = false, unsaved = null;
  let expectedEpoch = first.epoch, closeJob = null, workElapsedMs = null, idleElapsedMs = null;
  const timeline = doc.getElementById('timeline');
  let pointerId = 732, sampleFault = null;
  function requestClose() {
    if (!closeJob) { disposedBudget = null; try { closeJob = Promise.resolve(options.closeSession()); } catch (error) { closeJob = Promise.reject(error); } closeJob.catch(() => {}); }
    return closeJob;
  }
  const fail = message => { if (!issue) issue = new Error(message); requestClose(); };
  const foreground = () => doc.visibilityState === 'visible' && (typeof doc.hasFocus !== 'function' || doc.hasFocus());
  function guard() {
    if (issue) throw issue;
    if (recording && !foreground()) throw new Error('资源验证进入后台或失焦，本轮停止。');
    const value = bridge.snapshot();
    if (!value || value.state === 'error' || value.state === 'closed') throw new Error('正式会话失败或提前关闭。');
    if (value.libraryEpoch !== first.libraryEpoch) throw new Error('素材库变化，本轮停止。');
    if (phase !== 'load' && phase !== 'setup' && (value.epoch !== expectedEpoch || !value.sourceIdentity ||
      value.sourceIdentity.itemId !== selection.samples[sampleIndex].id || value.sourceIdentity.sha256 !== selection.samples[sampleIndex].sha256))
      throw new Error('负载期间出现未经安排的素材/会话变化。');
    return value;
  }
  function pointer(type, ratio) {
    const box = timeline.getBoundingClientRect();
    if (type === 'pointerdown') gesture = true;
    try { (type === 'pointerdown' ? timeline : win).dispatchEvent(new win.PointerEvent(type,
      { pointerId, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: box.left + ratio * box.width, clientY: box.top + box.height / 2, bubbles: true, cancelable: true })); }
    finally { if (type === 'pointerup') gesture = false; }
  }
  function click(id) { doc.getElementById(id).click(); }
  async function settle() {
    const started = now();
    while (true) {
      const value = guard(), p = value.playback;
      if (value.state === 'paused' && p && !p.pendingTargets && !p.activeImageTasks) return;
      if (now() - started > protocol.settleMs) throw new Error('暂停/定位任务未在限定时间内收尾。');
      await sleep(10);
    }
  }
  function sample() {
    try {
      const value = guard(), p = value.playback, at = now(), rss = memory(), usage = cpu();
      const managed = p && p.budget ? p.budget.used : null;
      if (!Number.isSafeInteger(rss) || rss < 0 || !usage || !Number.isFinite(usage.user + usage.system)) throw new Error('RSS/CPU采样不可用。');
      const gap = previousSampleAt === null ? 0 : at - previousSampleAt;
      if (gap < 0) throw new Error('采样时钟倒退。');
      maxSampleGapMs = Math.max(maxSampleGapMs, gap); previousSampleAt = at;
      const cpuMicros = usage.user + usage.system;
      const row = [at - begin, phase, sampleIndex, rss, managed, cpuMicros, p ? p.activeImageTasks : null,
        p ? p.pendingTargets : null, measuredFrames, value.epoch];
      pendingRows.push(row); totalSamples++;
      const minute = row[0] / (protocol.workMs / 60);
      if (minute >= 10 && minute < 15 || minute >= 55 && minute < 60) {
        if (comparisonRows.length >= 7000) throw new Error('比较窗口采样超过有界容量。');
        comparisonRows.push([row[0], row[1], row[2], row[3]]);
      }
      peakRss = Math.max(peakRss, rss); peakManaged = Math.max(peakManaged, managed || 0); lastCPU = cpuMicros;
      if (rss >= 1.5 * 1024 ** 3 || managed !== null && managed > 512 * MIB) throw new Error('资源观察停止线或受管预算超限。');
      if (pendingRows.length >= 650 || pendingRows.length && row[0] - pendingRows[0][0] >= protocol.cycleMs) flush();
    } catch (error) { sampleFault = error; fail(error.message); }
  }
  function save(value) {
    try { return store.save('lifecycle', value); }
    catch (error) { saveFailed = true; throw error; }
  }
  function flush() {
    if (!pendingRows.length || saveFailed) return;
    chunks.push(save({ schema: 'window-resource-chunk-v1', stage: 'T2', type: 'resource-chunk', index: chunks.length,
      sourceIds: selection.samples.map(s => s.id), columns: 'elapsedMs,phase,sample,rendererRssBytes,managedBytes,cpuMicros,imageTasks,pendingTargets,drawSubmissions,sessionEpoch',
      samples: packRows(pendingRows) }));
    pendingRows = [];
  }
  let unsubscribe;
  try { unsubscribe = bridge.subscribe(message => {
    if (message.type !== 'player') return;
    const event = message.value.event;
    if (event.type === 'draw') measuredFrames++;
    if (event.type === 'error') { eventErrors++; fail('播放器报告错误，本轮停止。'); }
    if (event.phase === 'disposed') disposedBudget = event.budgetBytes;
  }); } catch (error) { store.close(); throw error; }
  async function executeRound() {
    let cleanup = null, failure = null, startCPU = null;
    try {
      if (!timeline) throw new Error('正式时间轴缺失。');
      selection = await (options.selections || selections)(options.eagle, first, pluginRoot);
      options.verifyLaunch();
      const waitStart = now();
      while (!foreground()) { if (issue) throw issue; if (now() - waitStart > 15000) throw new Error('15秒内未返回前台。'); await sleep(100); }
      begin = now(); startCPU = cpu(); recording = true;
      sample(); sampleTimer = win.setInterval(sample, protocol.sampleMs);
      let cycle = 0;
      while (now() - begin < protocol.workMs) {
        const cycleStart = now(); phase = 'drag';
        doc.title = 'T2 资源验证 · ' + Math.floor((now() - begin) / 60000) + '/60分钟，请保持前台';
        pointer('pointerdown', .5);
        while (now() - cycleStart < protocol.cycleMs / 3 && now() - begin < protocol.workMs) {
          guard(); const fraction = (now() - cycleStart) / (protocol.cycleMs / 20);
          pointer('pointermove', .5 + .48 * Math.sin(fraction * Math.PI)); await sleep(protocol.actionMs);
        }
        pointer('pointerup', .5); await settle(); phase = 'play'; click('play');
        const playStart = now();
        while (now() - playStart < protocol.cycleMs / 4 && now() - begin < protocol.workMs) { guard(); await sleep(50); }
        if (guard().state === 'playing') click('play'); await settle(); phase = 'step';
        const stepStart = now();
        while (now() - stepStart < protocol.cycleMs / 12 && now() - begin < protocol.workMs) {
          click(cycle % 2 ? 'previous' : 'next'); await settle(); await sleep(100);
        }
        if (now() - begin >= protocol.workMs) break;
        phase = 'load'; sampleIndex = (cycle + 1) % 2; selection.choose(sampleIndex);
        const loadAt = now(), originalEpoch = guard().epoch;
        // Promise rejection and deadline are consumed even if the SDK callback is synchronous.
        let loadTimer;
        try {
          await Promise.race([Promise.resolve().then(options.reloadSelected), new Promise((_, reject) => {
            loadTimer = win.setTimeout(() => reject(new Error('换片超过120秒。')), protocol.loadTimeoutMs);
          })]);
        } finally { win.clearTimeout(loadTimer); }
        const ready = guard();
        if (ready.epoch <= originalEpoch || ready.state !== 'paused' || !ready.loadMetrics || !ready.loadMetrics.reused ||
          ready.sourceIdentity.itemId !== selection.samples[sampleIndex].id || ready.sourceIdentity.sha256 !== selection.samples[sampleIndex].sha256)
          throw new Error('固定素材切换/完整缓存复用/身份验证失败。');
        loads.push({ at: loadAt - begin, elapsedMs: now() - loadAt, sample: sampleIndex, epoch: ready.epoch });
        expectedEpoch = ready.epoch; await settle(); cycle++;
        // Any remaining time is assigned to load, excluded from comparable workload windows.
        while (now() - cycleStart < protocol.cycleMs && now() - begin < protocol.workMs) { guard(); await sleep(50); }
      }
      workElapsedMs = now() - begin;
      phase = 'idle'; if (guard().state === 'playing') click('play'); await settle();
      const idleAt = now();
      while (now() - idleAt < protocol.idleMs) { guard(); await sleep(100); }
      idleElapsedMs = now() - idleAt;
      await selection.verify(); options.verifyLaunch(); complete = true;
    } catch (error) { failure = String(error.message || error).slice(0, 2048); }
    finally {
      recording = false;
      if (sampleTimer !== null) win.clearInterval(sampleTimer);
      if (gesture) { try { pointer('pointerup', .5); } catch (_) {} }
      let closeTimer;
      try { const result = await Promise.race([requestClose(), new Promise((_, reject) => {
          closeTimer = win.setTimeout(() => reject(new Error('正常退出清理超过30秒，未确认释放。')), 30000);
        })]); const value = bridge.snapshot();
        cleanup = { state: value && value.state, result: result && result.status, error: result && result.error,
          disposedBudgetBytes: disposedBudget, verified: !!result && result.status === 'closed' && value && value.state === 'closed' && !value.error && disposedBudget === 0 };
      } catch (error) { cleanup = { verified: false, error: String(error.message).slice(0, 1024) }; }
      finally { win.clearTimeout(closeTimer); }
      unsubscribe(); if (selection) selection.restore();
    }
    try {
      if (selection && !saveFailed) { try { flush(); } catch (error) { failure = failure || error.message; } }
      const trend = trends(comparisonRows, protocol);
      const summary = { schema: 'window-resource-summary-v1', stage: 'T2', type: 'resource-summary', complete: complete && !issue && !saveFailed,
        resourceGatePassed: complete && !issue && !saveFailed && trend.passed && !!cleanup && cleanup.verified && protocol === PROTOCOL,
        protocol, modelRun: protocol !== PROTOCOL, workElapsedMs, idleElapsedMs, launchContext: options.launchContext, error: failure || issue && issue.message,
        samples: selection ? selection.samples : [], sourceSelection: 'test-only fixed snapshots from real SDK; Eagle selection itself is unchanged',
        chunks, loads, trend, cleanup, totalSamples, maxSampleGapMs, peakRendererRssBytes: peakRss, peakManagedBytes: peakManaged,
        totalDrawSubmissions: measuredFrames, playerErrors: eventErrors, cpu: { start: startCPU, endMicros: lastCPU, scope: 'current renderer process, one logical core = 100%; interval deltas retained in chunks' },
        sourceHashesVerifiedAtEnd: complete, limitations: ['Not native window destruction or forced Eagle exit verification.',
          'Renderer RSS sampling may miss peaks; other Eagle/GPU/shared process resources are not measured.',
          'No FFmpeg generation expected: existing complete caches only; auxiliary process resource usage not measured.',
          'This workload does not replace P01/P02 full raw input latency traces or manual audio/drag experience.',
          'Two independent 65-minute launches and an independent receipt audit are required; one saved run is insufficient.'] };
      function retainFailure(error) {
        let pendingSamples = null;
        try { if (pendingRows.length) pendingSamples = packRows(pendingRows); } catch (_) { /* Explicit failure; never invent dropped rows. */ }
        unsaved = JSON.stringify({ ...summary, persisted: false, resourceGatePassed: false, pendingSamples,
          persistenceError: String(error.message).slice(0, 1024), pendingRowsRetained: pendingSamples ? pendingSamples.rows : 0 });
      }
      if (saveFailed) { const error = new Error('资源证据保存失败，未重试；保留有界内存回执。'); retainFailure(error); throw error; }
      let receipt;
      try { receipt = save(summary); }
      catch (error) { retainFailure(error); throw error; }
      return { complete: summary.complete, resourceGatePassed: summary.resourceGatePassed, cleanupVerified: cleanup.verified, receipts: [...chunks, receipt] };
    } finally { store.close(); }
  }
  const done = executeRound();
  return Object.freeze({ done, cancel() { fail('资源验证已取消。'); }, unsavedEvidence: () => unsaved });
}
module.exports = { run, PROTOCOL, _test: { execute, trends, median, packRows, selections } };
