'use strict';
// Separate test coordinator. Product startup/close never waits for this writer.
const path = require('path');
function install(options) {
  const win = options.window, doc = options.document, eagle = options.eagle;
  const pluginRoot = path.resolve(__dirname, '../../plugin'), repo = path.dirname(pluginRoot);
  const helpers = options.helpers || {};
  const verify = helpers.verify || (() => require('../../scripts/prepare-mvp-host.cjs').verify());
  const createStore = helpers.createStore || require('./t4-evidence.cjs').createStore;
  const memory = helpers.memory || (() => require('../../plugin/preferences.cjs').createMemoryPreferences({ pluginRoot }).snapshot());
  const startMonitor = helpers.startMonitor || require('./mvp-monitor.cjs').start;
  const startDriver = helpers.startDriver || require('./window-host.cjs').run;
  const now = () => win.performance.now();
  let store = null, monitor = null, driver = null, timer = null, closing = false, disabled = null, prepared = null, runId = null;
  let formalClose = null, started = false, finished = false, sourceAtStart = null, observerIssue = null, expectedRamBytes = null;
  const title = text => { if (!closing) doc.title = '阶段4验收 · ' + text; };
  const snapshot = () => win.EVADiagnostics && win.EVADiagnostics.snapshot();
  function context() {
    const s = snapshot(); return !s ? { state: 'before-product-init' } : { state: s.state, epoch: s.epoch, libraryEpoch: s.libraryEpoch,
      itemId: s.sourceIdentity && s.sourceIdentity.itemId, sha256: s.sourceIdentity && s.sourceIdentity.sha256,
      phase: s.progress && s.progress.stage, frameId: s.playback && s.playback.frameId,
      managedUsedBytes: s.playback && s.playback.budget && s.playback.budget.used,
      managedLimitBytes: s.playback && s.playback.budget && s.playback.budget.limit };
  }
  function cancel() {
    if (closing) return; closing = true;
    if (timer !== null) { win.clearTimeout(timer); timer = null; }
    if (driver) driver.cancel();
    if (monitor) monitor.stop();
    // No filesystem writes, await, or preventDefault in either exit hook.
    if (store) store.close();
  }
  function stopForObservation(error) {
    observerIssue = observerIssue || String(error.message || error);
    if (driver) driver.cancel();
    if (formalClose && !closing) { try { Promise.resolve(formalClose()).catch(() => {}); } catch (_) {} }
  }
  // Path mapping is installed even when recording setup fails. SDK registration
  // is restored immediately; no selection or annotation API is replaced.
  const originalCreate = eagle.onPluginCreate;
  eagle.onPluginCreate = callback => {
    eagle.onPluginCreate = originalCreate;
    return originalCreate.call(eagle, plugin => callback({ ...plugin, path: pluginRoot }));
  };
  const originalExit = eagle.onPluginBeforeExit;
  if (typeof originalExit === 'function') eagle.onPluginBeforeExit = callback => {
    eagle.onPluginBeforeExit = originalExit; formalClose = callback;
    return originalExit.call(eagle, (...args) => { cancel(); return callback(...args); });
  };
  win.addEventListener('beforeunload', cancel); win.addEventListener('pagehide', cancel);
  try {
    prepared = verify();
    if (prepared.host.toLowerCase() !== options.hostRoot.toLowerCase() || prepared.plugin.toLowerCase() !== pluginRoot.toLowerCase()) throw new Error('验收入口路径不匹配。');
    const setting = memory(); expectedRamBytes = setting.ramBytes;
    store = createStore(repo); const reservation = store.start({ reserveBytes: 3 * 1024 ** 2 }); runId = reservation.runId;
    store.save('host', { schema: 'mvp-host-start-v1', stage: 'T4', purpose: 'T2-current-runtime-regression-and-T4-evidence',
      at: new Date().toISOString(), pid: process.pid, sourceHashes: prepared.marker.sourceHashes, actualRamBytes: setting.ramBytes,
      hostRoot: options.hostRoot, pluginRoot, sdkCreateObserved: false, complete: false });
    monitor = startMonitor({ ramBytes: setting.ramBytes, now, snapshot: context, onStop: stopForObservation });
  } catch (error) {
    disabled = String(error.message || error); if (store) store.close();
    title('记录准备失败，播放器仍可使用：' + disabled.slice(0, 100));
  }
  async function measured() {
    const bridge = win.EVADiagnostics, first = bridge.snapshot(); sourceAtStart = first.sourceIdentity;
    const launchContext = { kind: 'real-Eagle-formal-code-independent-entry', mappedFormalRoot: pluginRoot,
      stage: 'T4', purpose: 'T2-current-runtime-regression', sourceHashes: prepared.marker.sourceHashes };
    title('正在验证当前视频，请保持前台，勿操作');
    let outcome = null, error = null;
    try {
      if (observerIssue || monitor.issue) throw new Error(observerIssue || monitor.issue);
      if (first.playback.budget.limit !== expectedRamBytes) throw new Error('测量前RAM设置已变化，本轮停止。');
      driver = startDriver({ bridge, document: doc, window: win, pluginRoot, evidenceStage: 'T4', launchContext,
        createStore: () => createStore(repo, { runId }), verifyLaunch: verify,
        extraFingerprints: ['task-client.cjs', 'task-worker.cjs', 'native/task-host.cs', 'native/task-host.local.exe'] });
      outcome = await driver.done;
    } catch (failure) { error = String(failure.message || failure); }
    return finalize(outcome, error);
  }
  async function finalize(outcome, error) {
    const resources = await monitor.stop();
    if (closing) return; // Actual product close never waits for late records.
    const references = [];
    try {
      let sourceStable = true;
      try { verify(); } catch (failure) { sourceStable = false; error = error || String(failure.message || failure); }
      for (let i = 0; i < resources.rows.length; i += 200) references.push(store.save('lifecycle', {
        schema: 'mvp-process-trace-chunk-v1', stage: 'T4', index: i / 200, rows: resources.rows.slice(i, i + 200) }));
      const currentRegressionPassed = !!(sourceStable && outcome && outcome.earlyRegressionPassed && !error && !observerIssue &&
        !resources.issue && resources.observer.samples >= 10 && resources.observer.stopReasons.length === 0);
      store.save('host', { schema: 'mvp-current-runtime-regression-summary-v1', stage: 'T4', runId,
        source: sourceAtStart, sourceHashes: prepared.marker.sourceHashes, sourceStable, currentRegressionPassed,
        error: error || observerIssue || resources.issue, performance: outcome, observer: resources.observer, resourceChunks: references,
        limitations: resources.limitations.concat(['One selected video; no automatic cache reset or settings/library write.',
          'Not complete P-03 repetition, independent frame-reference verification or two long resource rounds.',
          'Prepared independent SDK path mapping, not the normal product manifest startup.']),
        userObservations: 'not-recorded', overallT2Accepted: false, overallT4Accepted: false });
      finished = true; title(currentRegressionPassed ? '本项完成，记录已保存（非MVP总验收）' : '本项未通过，记录已保存：' + (error || observerIssue || resources.issue || '性能条件未满足'));
    } catch (failure) { title('记录保存失败，播放器仍可使用：' + String(failure.message || failure).slice(0, 100)); }
    finally { store.close(); }
  }
  const waitAt = now();
  function ready() {
    timer = null;
    if (closing || disabled || started) return;
    try {
      if (observerIssue || monitor.issue) throw new Error(observerIssue || monitor.issue);
      const value = snapshot();
      if (value && value.state === 'paused' && value.playback && value.loadMetrics) {
        started = true; measured().catch(error => { if (!closing) title('验证失败：' + String(error.message || error).slice(0, 100)); }); return;
      }
      if (value && ['empty', 'error', 'closed'].includes(value.state)) throw new Error(value.error ? value.error.message : '没有已就绪的视频，未开始拖动测量。');
      if (now() - waitAt > 120000) throw new Error('准备超时，未开始拖动测量。');
      timer = win.setTimeout(ready, 20);
    } catch (error) {
      disabled = String(error.message || error);
      if (!closing) finalize(null, disabled).catch(failure => { title('未测量且记录失败：' + String(failure.message || failure).slice(0, 100)); });
    }
  }
  if (!disabled) timer = win.setTimeout(ready, 20);
  return Object.freeze({ cancel, status: () => ({ closing, disabled, started, finished, observerIssue }) });
}
module.exports = { install };
