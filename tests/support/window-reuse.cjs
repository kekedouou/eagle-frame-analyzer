'use strict';
// Test-only: three complete existing-cache loads through the formal callback.
const path = require('path');
const { createStore } = require('./t2-evidence.cjs');
const { hostRssLimit } = require('./ram-diagnostic.cjs');
const SOURCE = Object.freeze({ itemId: 'MV6H7OK0MBGX2', sha256: 'd7bbab0b425381c880adacb9f8d95d900aa162c4c5c9308cf9a3f8482ff67658' });
function run(options) {
  const { bridge, window: win, launchContext: context, pluginRoot } = options;
  const config = context && context.ramDiagnostic;
  if (!config || config.schema !== 'T2-ram-host-v2' || typeof options.reloadSelected !== 'function' || typeof options.closeSession !== 'function')
    throw new Error('复用验证需要明确2GiB配置及正式重载/退出回调。');
  const stopBytes = hostRssLimit(config), now = () => win.performance.now();
  const store = (options.createStore || createStore)(path.dirname(pluginRoot));
  store.start({ reserveBytes: 256 * 1024 });
  let issue = null, timer = null, disposed = null, closeJob = null, unsubscribe = null, unsaved = null;
  let peakRss = 0, peakManaged = 0, samples = 0, stoppedForRss = false;
  const loads = [], releases = [];
  function requestClose() {
    if (!closeJob) {
      disposed = null;
      try { closeJob = Promise.resolve(options.closeSession()); } catch (error) { closeJob = Promise.reject(error); }
      closeJob.catch(() => {});
    }
    return closeJob;
  }
  function fail(error) { if (!issue) issue = error instanceof Error ? error : new Error(error); requestClose(); }
  function sample() {
    try {
      const rss = (options.memory || (() => process.memoryUsage().rss))();
      if (!Number.isSafeInteger(rss) || rss < 0) throw new Error('复用RSS采样无效。');
      peakRss = Math.max(peakRss, rss); samples++;
      const snapshot = bridge.snapshot(), budget = snapshot && snapshot.playback && snapshot.playback.budget;
      if (budget) {
        if (budget.limit !== 2 * 1024 ** 3 || budget.used > budget.limit) throw new Error('复用实际RAM额度不符或账本超额。');
        peakManaged = Math.max(peakManaged, budget.used, budget.peak || 0);
      }
      if (rss >= stopBytes) { stoppedForRss = true; throw new Error('复用测量达到3GiB进程内存观察停止线。'); }
    } catch (error) { fail(error); }
  }
  async function bounded(task, ms, message) {
    let timeout;
    try { return await Promise.race([task, new Promise((_, reject) => { timeout = win.setTimeout(() => reject(new Error(message)), ms); })]); }
    finally { win.clearTimeout(timeout); }
  }
  function validate(snapshot, previousEpoch) {
    if (issue) throw issue;
    const p = snapshot && snapshot.playback, metrics = snapshot && snapshot.loadMetrics, id = snapshot && snapshot.sourceIdentity;
    if (!snapshot || snapshot.state !== 'paused' || !p || !metrics || snapshot.error || !id ||
        id.itemId !== SOURCE.itemId || id.sha256 !== SOURCE.sha256 || (loads.length > 0 && snapshot.libraryEpoch !== loads[0].libraryEpoch) ||
        previousEpoch !== null && snapshot.epoch <= previousEpoch || !metrics.reused ||
        !Number.isFinite(metrics.totalMs) || metrics.totalMs < 0 || metrics.readyAt < metrics.entryAt ||
        Math.abs(metrics.readyAt - metrics.entryAt - metrics.totalMs) > 1 ||
        p.budget.limit !== 2 * 1024 ** 3 || p.compressed.limitBytes !== 256 * 1024 ** 2 ||
        p.activeImageTasks || p.pendingTargets || p.frameOrdinal !== 0 || p.time !== 0)
      throw new Error('复用未取得同素材、完整复用、首帧暂停或新代次，停止而不生成替代成绩。');
    return { epoch: snapshot.epoch, libraryEpoch: snapshot.libraryEpoch, sourceIdentity: id, loadMetrics: metrics,
      frameOrdinal: p.frameOrdinal, time: p.time, budget: p.budget, compressed: p.compressed };
  }
  async function execute() {
    let cleanup = null, complete = false, error = null;
    try {
      unsubscribe = bridge.subscribe(message => {
        if (message.type !== 'player') return;
        const event = message.value.event;
        if (event.phase === 'disposed') { disposed = event.budgetBytes; if (releases.length < 8) releases.push(event.budgetBytes); }
        if (event.type === 'error') fail(new Error('复用播放器错误：' + String(event.error || event.code).slice(0, 512)));
      });
      sample();
      loads.push(validate(bridge.snapshot(), null));
      timer = win.setInterval(sample, 100);
      const capture = options.captureSelected || (() => require('../../plugin/eagle.cjs').createEagleAdapter(options.eagle).captureSelected());
      for (let i = 1; i < 3; i++) {
        options.verifyLaunch();
        const selected = await bounded(Promise.resolve().then(capture), 10000, '复用选中检查超过10秒。');
        if (selected.itemId !== SOURCE.itemId) throw new Error('Eagle选中项改变，未执行下一次重载。');
        if (issue) throw issue;
        const before = loads[loads.length - 1].epoch, startedAt = now(), releaseStart = releases.length;
        await bounded(Promise.resolve().then(options.reloadSelected), 120000, '复用重载超过120秒。');
        sample();
        const load = validate(bridge.snapshot(), before);
        if (releases.length !== releaseStart + 1 || releases[releaseStart] !== 0) throw new Error('前一次Player释放账本未确认归零。');
        loads.push({ ...load, callbackElapsedMs: now() - startedAt });
      }
      options.verifyLaunch(); complete = true;
    } catch (failure) { error = String(failure.message || failure).slice(0, 2048); }
    finally {
      if (timer !== null) win.clearInterval(timer);
      try {
        const result = await bounded(requestClose(), 30000, '复用退出清理超过30秒。'), value = bridge.snapshot();
        cleanup = { state: value && value.state, result: result && result.status, disposedBudgetBytes: disposed,
          verified: !!result && result.status === 'closed' && value && value.state === 'closed' && !value.error && disposed === 0 };
      } catch (failure) { cleanup = { verified: false, error: String(failure.message).slice(0, 1024) }; }
      if (unsubscribe) unsubscribe();
    }
    try {
      const summary = { schema: 'window-reuse-summary-v1', stage: 'T2', origin: 'real-Eagle-formal-code-reuse', at: new Date().toISOString(),
        complete: complete && !issue && cleanup.verified, reuseGatePassed: complete && !issue && cleanup.verified && loads.length === 3,
        error: error || issue && issue.message, launchContext: context, loads, releases, cleanup, resourceStop: { thresholdBytes: stopBytes, requested: stoppedForRss },
        samples, peakRendererRssBytes: peakRss, peakManagedBytes: peakManaged,
        limitations: ['Three reloads in one real window, not three independent window launches or first preparations.',
          'Initial app-entry timing and later formal onPluginRun timings are reported separately; no numeric reuse latency gate was approved.',
          'Disposed event confirms managed ledger only, not OS/GPU memory release or native window destruction.',
          'Renderer RSS sampled approximately every 100ms; shared/GPU/other Eagle processes and missed peaks excluded.',
          'No P01/P02 or manual experience verification; no forced Eagle exit, cache deletion or settings write.'] };
      let receipt;
      try { receipt = store.save('host', summary); }
      catch (failure) { unsaved = JSON.stringify({ ...summary, complete: false, reuseGatePassed: false, persisted: false,
        persistenceError: String(failure.message).slice(0, 1024) }); throw failure; }
      return { complete: summary.complete, reuseGatePassed: summary.reuseGatePassed, cleanupVerified: cleanup.verified, receipts: [receipt] };
    } finally { store.close(); }
  }
  const done = execute();
  return Object.freeze({ done, cancel() { fail(new Error('复用测量已取消。')); }, unsavedEvidence: () => unsaved });
}
module.exports = { run, SOURCE };
