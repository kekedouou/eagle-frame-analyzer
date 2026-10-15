'use strict';
// A real Eagle test window with original SDK calls and formal source files.
// Only the onPluginCreate directory is mapped to the actual formal plugin.
const path = require('path');
const entry = require('../../scripts/prepare-window-host.cjs');
const driver = require('./window-host.cjs');
const { createStore } = require('./t2-evidence.cjs');
const PREPARE_MS = 120000, WORK_MS = 180000, RESOURCE_MS = 72 * 60000;
const WINDOW_OBSERVER_VERSION = 'eva-window-observer-v4';
function install(options) {
  const { window: win, document: doc, eagle, hostRoot } = options;
  if (!win || !doc || !eagle || typeof eagle.onPluginCreate !== 'function') throw new Error('请从 Eagle 加载T2独立自动验证入口。');
  const repo = path.resolve(hostRoot, '../../..'), register = eagle.onPluginCreate;
  const verify = options.verify || entry.verify, start = options.run || driver.run, storeFactory = options.createStore || createStore;
  let state = 'waiting', job = null, stopping = false, closeRequested = false, allowUnload = false, completed = false;
  let timer = null, done = Promise.resolve(), receipts = [], failureSaved = false, safeToRecord = false, closeScheduled = false;
  let cancelPreparation = null, runCallback = null, exitCallback = null, activeMode = 'performance';
  let activeContext = null, windowUnloadObserved = false;
  let cleanupObserver = null, cleanupObserved = false, witnessId = null;
  let windowCloseIntent = false, windowClosing = false, windowCloseTask = null;
  let windowExitNotice = null, windowCaptureError = null;
  let windowSessionClean = false;
  let pendingWindowBytes = 0; const pendingWindowRecords = [];
  function rememberWindowRecord(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (pendingWindowBytes + bytes.length > 48 * 1024 || pendingWindowRecords.length >= 3)
      throw new Error('关闭观察记录超过48KiB边界，未静默截断。');
    pendingWindowBytes += bytes.length; pendingWindowRecords.push(JSON.parse(bytes));
  }
  win.addEventListener('beforeunload', beforeUnload);
  if (options.observeStartup) {
    const prepared = verify(repo);
    if (prepared.marker.mode === 'window-checks') {
      activeMode = 'window-checks'; safeToRecord = true;
      witnessId = require('crypto').randomBytes(10).toString('hex');
      const store = storeFactory(repo, { stage: 'T2' });
      try {
        store.start({ reserveBytes: 64 * 1024 });
        receipts.push(store.save('host', { schema: 'window-lifecycle-start-v2', stage: 'T2', at: new Date().toISOString(),
          origin: 'real-Eagle-independent-window-observation', pid: process.pid, observerVersion: WINDOW_OBSERVER_VERSION,
          witnessId,
          sdkCreateObserved: false, hostRoot: prepared.host, pluginRoot: prepared.plugin, sourceHashes: prepared.marker.sourceHashes,
          note: 'Entry installed before SDK create. Not proof of readiness, closure or cleanup.' }));
      } catch (error) {
        win.removeEventListener('beforeunload', beforeUnload);
        throw new Error('窗口验收入口启动记录未保存，本项未启动：' + String(error.message).slice(0, 512));
      } finally {
        try { store.close(); } catch (error) { win.removeEventListener('beforeunload', beforeUnload); throw error; }
      }
    }
  }
  // Capture formal callbacks for test invocation; restore SDK registration immediately.
  for (const [name, assign] of [['onPluginRun', callback => { runCallback = callback; }], ['onPluginBeforeExit', callback => { exitCallback = callback; }]]) {
    if (typeof eagle[name] !== 'function') continue;
    const registration = eagle[name];
    eagle[name] = callback => {
      eagle[name] = registration; assign(callback);
      return registration.call(eagle, name === 'onPluginBeforeExit' ? (...args) => {
        if (activeMode === 'window-checks') {
          windowCloseIntent = true;
          if (!windowExitNotice) {
            try {
              const value = win.EVADiagnostics && win.EVADiagnostics.snapshot();
              windowExitNotice = value ? { state: value.state, sourceIdentity: value.sourceIdentity,
                progress: value.progress, loadMetrics: value.loadMetrics } : { state: null };
            } catch (error) {
              windowCaptureError = error; windowExitNotice = { state: null, error: String(error.message).slice(0, 512) };
            }
          }
        }
        return callback(...args);
      } : callback);
    };
  }
  const clearTimer = () => { if (timer !== null) { win.clearTimeout(timer); timer = null; } };
  function message(text, failed = false) {
    doc.title = (activeMode === 'window-checks' ? 'T2 窗口验收' : activeMode === 'annotations' ? 'T3 标注验收' : activeMode === 'preferences' ? 'T2 内存设置验收' : 'T2 自动测量') + ' · ' + text;
    const node = doc.getElementById(failed ? 'error' : 'status');
    if (node) { node.textContent = text; node.hidden = false; }
  }
  function saveFailure(error, context) {
    if (failureSaved || !safeToRecord) return; failureSaved = true;
    if (activeMode === 'window-checks' && (windowCloseIntent || windowClosing)) {
      rememberWindowRecord({ schema: 'window-automatic-entry-failure-v1', stage: 'T2', origin: 'real-Eagle-independent-test-entry',
        complete: false, earlyRegressionPassed: false, at: new Date().toISOString(), state, context, witnessId,
        error: { message: String(error && error.message || error).slice(0, 2048) } });
      return;
    }
    let store;
    try {
      store = storeFactory(repo, { stage: activeMode === 'annotations' ? 'T3' : 'T2' }); store.start({ reserveBytes: 64 * 1024 });
      receipts.push(store.save('host', { schema: 'window-automatic-entry-failure-v1', stage: activeMode === 'annotations' ? 'T3' : 'T2', origin: 'real-Eagle-independent-test-entry',
        complete: false, earlyRegressionPassed: false, at: new Date().toISOString(), state, context,
        witnessId: activeMode === 'window-checks' ? witnessId : null,
        error: { message: String(error && error.message || error).slice(0, 2048) } }));
    } catch (saving) { message('验证失败且回执未保存：' + String(saving.message).slice(0, 512), true); }
    finally { if (store) { try { store.close(); } catch (_) {} } }
  }
  function stop() { if (completed) return; stopping = true;
    if (cancelPreparation) cancelPreparation(new Error('准备阶段已取消，未执行测量。'));
    if (job) job.cancel(); }
  function observe(bridge, context) {
    const value = bridge && bridge.snapshot();
    if (context) context.lastPreparation = value ? { state: value.state, epoch: value.epoch, libraryEpoch: value.libraryEpoch,
      itemId: value.sourceIdentity && value.sourceIdentity.itemId, progress: value.progress, error: value.error,
      loadMetrics: value.loadMetrics } : null;
    return value;
  }
  function observeCleanup(bridge, context) {
    if (activeMode !== 'window-checks' || !bridge || typeof bridge.subscribe !== 'function') return;
    cleanupObserver = bridge.subscribe(event => {
      if (!event || event.type !== 'close-result' || cleanupObserved) return;
      cleanupObserved = true;
      if (cleanupObserver) { cleanupObserver(); cleanupObserver = null; }
      try {
        const result = event.value, snapshot = bridge.snapshot();
        rememberWindowRecord({ schema: 'window-lifecycle-cleanup-result-v1', stage: 'T2', at: new Date().toISOString(),
          origin: 'real-Eagle-independent-window-observation', launchContext: context,
          pid: process.pid, observerVersion: WINDOW_OBSERVER_VERSION, witnessId, unloadRequestObserved: windowUnloadObserved,
          result, state: snapshot && snapshot.state, error: snapshot && snapshot.error,
          sessionCleanupCompleted: !!(result && result.status === 'closed' && snapshot && snapshot.state === 'closed' && !snapshot.error),
          nativeWindowDestroyedVerified: false,
          note: 'Actual formal session.close promise settled. Not proof of native destruction, post-close disk state, physical memory return or forced-exit recovery.' });
      } catch (error) { windowCaptureError = error; message('资源清理结果记录未保存：' + String(error.message).slice(0, 512), true); }
    });
  }
  async function waitReady(bridge, context, aborted) {
    if (!bridge || typeof bridge.snapshot !== 'function') throw new Error('正式播放器诊断接口未初始化，未执行测量。');
    let unsubscribe;
    try {
      return await Promise.race([new Promise((resolve, reject) => {
        function check() {
          try {
            const value = observe(bridge, context);
            if (value && value.state === 'paused' && value.loadMetrics) resolve(value);
            else if (!value || value.state !== 'preparing' && value.state !== 'paused')
              reject(new Error(value && value.error ? value.error.message : '视频准备已结束但未就绪，未执行测量。'));
            else if (typeof bridge.subscribe !== 'function') reject(new Error('无法观察视频就绪，未执行测量。'));
          } catch (error) { reject(error); }
        }
        // Subscribe before checking, so the final load-result cannot be missed.
        // Paused state is published before loadMetrics; only the later snapshot
        // containing both is ready. A superseded create may still be preparing.
        if (typeof bridge.subscribe === 'function') unsubscribe = bridge.subscribe(check);
        check();
      }), aborted]);
    } finally { if (unsubscribe) unsubscribe(); }
  }
  function beforeUnload(event) {
    if (activeMode === 'window-checks' && safeToRecord) {
      if (allowUnload) return;
      // Eagle sends plugin-exit without awaiting cleanup. Neither that IPC's
      // cancellation microtasks nor beforeunload may scan/write old evidence.
      event.returnValue = false; if (event.preventDefault) event.preventDefault();
      windowCloseIntent = true;
      if (windowClosing) return;
      windowClosing = true;
      captureWindowUnload(); closeRequested = true; stop();
      win.setTimeout(() => { windowCloseTask = finishWindowClose(); windowCloseTask.catch(error => {
        // Keep the failure visible, but a completed formal cleanup permits the
        // user to close this test error window. Never retry a partial batch.
        if (windowSessionClean) allowUnload = true;
        message('窗口清理或记录保存失败，尚未完成关闭：' + String(error.message).slice(0, 512), true);
      }); }, 0);
      return;
    }
    closeRequested = true; stop();
    if (allowUnload || !job || completed) return;
    // Preserve the driver's failure receipt before the renderer disappears.
    event.returnValue = false; if (event.preventDefault) event.preventDefault();
    if (closeScheduled) return; closeScheduled = true;
    done.finally(() => win.setTimeout(() => { allowUnload = true; win.close(); }, 0)).catch(() => {});
  }
  function captureWindowUnload() {
    if (activeMode === 'window-checks' && safeToRecord && !windowUnloadObserved) {
      windowUnloadObserved = true;
      try {
        const value = observe(win.EVADiagnostics, activeContext);
        rememberWindowRecord({ schema: 'window-lifecycle-unload-request-v1', stage: 'T2', at: new Date().toISOString(),
          origin: 'real-Eagle-independent-window-observation', launchContext: activeContext, state: value && value.state,
          sourceIdentity: value && value.sourceIdentity, progress: value && value.progress, loadMetrics: value && value.loadMetrics,
          sdkExitNotice: windowExitNotice,
          pid: process.pid, observerVersion: WINDOW_OBSERVER_VERSION, nativeWindowDestroyedVerified: false, cleanupVerified: false,
          witnessId,
          note: 'Observed beforeunload request only. Product may defer closure for cleanup; user confirmation and post-close file checks remain required.' });
      } catch (error) { windowCaptureError = error; message('关闭请求记录未保存：' + String(error.message).slice(0, 512), true); }
    }
  }
  async function finishWindowClose() {
    let result, cleanupError;
    try {
      if (!exitCallback) throw new Error('正式退出回调缺失。');
      result = await exitCallback();
      windowSessionClean = !!(result && result.status === 'closed');
    } catch (error) { cleanupError = error; }
    try { await done; } catch (error) { if (!cleanupError) cleanupError = error; }
    verify(repo);
    const store = storeFactory(repo, { stage: 'T2' });
    try {
      store.start({ reserveBytes: 64 * 1024 });
      for (const value of pendingWindowRecords) receipts.push(store.save('host', value));
    } finally { store.close(); }
    if (cleanupError) throw cleanupError;
    if (windowCaptureError) throw windowCaptureError;
    if (!result || result.status !== 'closed' || !pendingWindowRecords.some(x => x.schema === 'window-lifecycle-unload-request-v1') ||
        !pendingWindowRecords.some(x => x.schema === 'window-lifecycle-cleanup-result-v1' && x.sessionCleanupCompleted))
      throw new Error('资源清理未获实际成功回执，未自动关闭。');
    allowUnload = true; win.setTimeout(() => win.close(), 0);
  }
  eagle.onPluginCreate = callback => {
    eagle.onPluginCreate = register; // The SDK itself is restored after one registration.
    return register.call(eagle, plugin => {
      if (state !== 'waiting') return done;
      done = execute(callback, plugin); done.catch(() => {}); return done;
    });
  };
  async function execute(callback, plugin) {
    let context = null; const callbackAt = win.performance.now();
    try {
      state = 'preflight'; const prepared = verify(repo); activeMode = prepared.marker.mode || 'performance';
      if (activeMode === 'window-checks' && !witnessId) witnessId = require('crypto').randomBytes(10).toString('hex');
      if (!plugin || typeof plugin.path !== 'string' || path.resolve(plugin.path).toLowerCase() !== prepared.host.toLowerCase())
        throw new Error('SDK提供的验证插件目录与准备记录不符。');
      safeToRecord = true;
      let ramContext = null;
      if (prepared.marker.ramDiagnostic) {
        const fs = require('fs'), crypto = require('crypto'), sha = value => crypto.createHash('sha256').update(value).digest('hex');
        let selectionTimer, selected;
        try { selected = await Promise.race([require('../../plugin/eagle.cjs').createEagleAdapter(eagle).captureSelected(),
          new Promise((_, reject) => { selectionTimer = win.setTimeout(() => reject(new Error('RAM对照选中核对超过10秒，未执行准备。')), 10000); })]); }
        finally { win.clearTimeout(selectionTimer); }
        if (selected.itemId !== 'MV6H7OK0MBGX2') throw new Error('本次RAM对照请单选“喜多郁代”，未执行缓存或测量。');
        if (activeMode === 'reuse') driver._test.registeredManifest(prepared.plugin, { sourceIdentity: {
          itemId: selected.itemId, sha256: 'd7bbab0b425381c880adacb9f8d95d900aa162c4c5c9308cf9a3f8482ff67658' } });
        const text = fs.readFileSync(path.join(prepared.plugin, 'player.js'), 'utf8');
        if (sha(Buffer.from(text)) !== prepared.marker.sourceHashes['plugin/player.js']) throw new Error('Player changed before RAM capture.');
        const helper = require('./ram-diagnostic.cjs'), config = prepared.marker.ramDiagnostic;
        const rendererRssStopBytes = helper.hostRssLimit(config);
        const captured = helper.activate(win, text, config.ramMiB, { host2GiB: config.schema === 'T2-ram-host-v2' });
        ramContext = { ...prepared.marker.ramDiagnostic, originalPlayerSha256: sha(Buffer.from(text)),
          candidatePlayerSha256: sha(Buffer.from(captured.source)), transformations: captured.transformations,
          rendererRssStopBytes,
          boundary: 'Test-only in-memory Player capture; formal defaults/settings unchanged. Renderer stop applies only to this recorded RAM host configuration.' };
      }
      context = { kind: 'real-Eagle-formal-code-independent-entry', sdkPluginRoot: prepared.host,
        ramDiagnostic: ramContext,
        annotationApproval: activeMode === 'annotations' ? prepared.marker.writeApproval || null : null,
        entryScheme: options.entryScheme || 'unspecified',
        mappedFormalRoot: prepared.plugin, sourceHashes: prepared.marker.sourceHashes,
        boundary: ramContext ? 'Real SDK/media/cache/UI with explicitly captured in-memory RAM Player candidate; mapped root, not formal default startup.' :
          'Real SDK/media/cache/UI/player; test entry maps create.path only. Not the formal manifest startup.', sdkCallbackAt: callbackAt };
      activeContext = context; state = 'preparing';
      const aborted = new Promise((_, reject) => { cancelPreparation = reject; });
      // Consume a cancellation even if a synchronous callback throws first.
      aborted.catch(() => {});
      timer = win.setTimeout(() => { stopping = true;
        cancelPreparation(new Error('准备超过120秒，未执行测量。'));
        message('准备超过120秒，未开始测量；正在请求正常关闭。', true); win.close(); }, PREPARE_MS);
      const initialTask = callback({ ...plugin, path: prepared.plugin });
      observeCleanup(win.EVADiagnostics, context);
      const initial = await Promise.race([initialTask, aborted]);
      context.initialCreateResult = initial && initial.status || 'unspecified';
      if (stopping) throw new Error('准备阶段已取消，未执行测量。');
      const bridge = win.EVADiagnostics, snapshot = await waitReady(bridge, context, aborted);
      if (ramContext && (!snapshot.sourceIdentity || snapshot.sourceIdentity.itemId !== 'MV6H7OK0MBGX2' ||
          snapshot.sourceIdentity.sha256 !== 'd7bbab0b425381c880adacb9f8d95d900aa162c4c5c9308cf9a3f8482ff67658'))
        throw new Error('RAM对照素材在准备过程中改变或源SHA不符，不执行测量。');
      if (ramContext && (snapshot.playback.budget.limit !== ramContext.ramMiB * 1024 ** 2 || snapshot.playback.compressed.limitBytes !== ramContext.compressedMiB * 1024 ** 2))
        throw new Error('实际Player预算与本轮RAM对照配置不符，不执行测量。');
      clearTimer(); cancelPreparation = null;
      if (stopping) throw new Error('准备阶段已取消，未执行测量。');
      verify(repo);
      context.callbackToReadyMs = snapshot.loadMetrics.readyAt - callbackAt;
      if (!Number.isFinite(context.callbackToReadyMs) || context.callbackToReadyMs < 0)
        throw new Error('就绪时钟与SDK回调时钟不一致，不能记录启动耗时。');
      context.appEntryToReadyMs = snapshot.loadMetrics.totalMs;
      context.readyEpoch = snapshot.epoch;
      context.readyTrigger = snapshot.loadMetrics.trigger;
      if (activeMode === 'preferences' || activeMode === 'window-checks') {
        if (!snapshot.memorySettings || !snapshot.playback || snapshot.playback.budget.limit !== snapshot.memorySettings.ramBytes)
          throw new Error('正式内存设置与实际Player额度不符，未记录就绪。');
        const store = storeFactory(repo, { stage: 'T2' });
        try {
          store.start({ reserveBytes: 64 * 1024 });
          receipts.push(store.save('host', { schema: activeMode === 'window-checks' ? 'window-lifecycle-ready-v1' : 'window-memory-settings-ready-v1', stage: 'T2', origin: activeMode === 'window-checks' ? 'real-Eagle-independent-window-observation' : 'real-Eagle-preferences-ready-observation',
            at: new Date().toISOString(), launchContext: context, state: snapshot.state, sourceIdentity: snapshot.sourceIdentity,
            memorySettings: snapshot.memorySettings, playback: snapshot.playback ? { frameId: snapshot.playback.frameId,
              time: snapshot.playback.time, budget: snapshot.playback.budget } : null, loadMetrics: snapshot.loadMetrics,
            pid: process.pid, observerVersion: WINDOW_OBSERVER_VERSION, witnessId: activeMode === 'window-checks' ? witnessId : null,
            settingsInteractionVerified: false, performanceVerified: false }));
        } catch (error) { failureSaved = true; throw new Error('内存设置就绪证据未保存：' + error.message); }
        finally { store.close(); }
        state = 'saved';
        message(activeMode === 'window-checks' ? '已载入，请核对素材；本次仅记录窗口操作，不自动测量。' : '内存设置已就绪，请体验修改与重开保留；本次不自动拖动。');
        return { complete: true, observationSaved: true, receipts };
      }
      state = 'measuring'; doc.title = activeMode === 'reuse' ? 'T2 自动测量 · 2GB缓存复用与释放，三次载入' : activeMode === 'annotations' ? 'T3 标注验收 · 只读观察／具体授权后一次写入' : activeMode === 'resource' ? 'T2 资源验证 · 60分钟运行＋5分钟静置' : ramContext ? 'T2 自动测量 · '+(ramContext.ramMiB/1024)+'GB RAM对照，请保持前台，约2分钟' : 'T2 自动测量 · 请保持前台，约2分钟';
      const runner = activeMode === 'reuse' && !options.run ? require('./window-reuse.cjs').run : activeMode === 'annotations' && !options.run ? require('./window-annotations.cjs').run : activeMode === 'resource' && !options.run ? require('./window-resource.cjs').run : start;
      job = runner({ bridge, document: doc, window: win, pluginRoot: prepared.plugin, launchContext: context,
        verifyLaunch: () => verify(repo), eagle,
        reloadSelected: () => { if (!runCallback) throw new Error('正式重复调用回调缺失。'); return runCallback(); },
        closeSession: () => { if (!exitCallback) throw new Error('正式退出回调缺失。'); return exitCallback(); } });
      timer = win.setTimeout(() => { stopping = true; job.cancel('timeout'); }, activeMode === 'reuse' ? 5 * 60000 : activeMode === 'annotations' ? 20 * 60000 : activeMode === 'resource' ? RESOURCE_MS : WORK_MS);
      const result = await job.done; clearTimer(); receipts = result.receipts || [];
      state = result.complete ? 'saved' : 'failed';
      const passed = activeMode === 'reuse' ? result.complete && result.reuseGatePassed : activeMode === 'annotations' ? result.complete && result.observationSaved : activeMode === 'resource' ? result.complete && result.resourceGatePassed : result.complete && result.earlyRegressionPassed && result.p03 && result.p03.withinTarget !== false;
      message(passed ? (activeMode === 'reuse' ? '三次缓存复用及账本释放记录已保存，请告知Codex核对。' : activeMode === 'annotations' ? '标注观察已保存，由Codex核对；不代表T3整体验收通过。' : activeMode === 'resource' ? '本轮资源记录已保存；两轮齐备后由Codex核对。' : '测量已保存，早期门槛通过；请告知Codex核对。') :
        '测量已保存，存在未通过项；请告知Codex核对。', !passed);
      if (activeMode === 'resource' && result.complete && result.resourceGatePassed && result.cleanupVerified) win.setTimeout(() => win.close(), 0);
      return result;
    } catch (error) {
      try { observe(win.EVADiagnostics, context); } catch (_) { /* Preserve original failure. */ }
      clearTimer(); message('自动验证未通过：' + String(error.message || error).slice(0, 1024), true);
      if (!job) saveFailure(error, context); // The driver owns persistence once started; never retry its failed save.
      state = 'failed'; return { complete: false, earlyRegressionPassed: false, error: String(error.message || error), receipts };
    } finally {
      clearTimer(); cancelPreparation = null; completed = true;
      if (!closeRequested && activeMode !== 'window-checks') win.removeEventListener('beforeunload', beforeUnload);
    }
  }
  return Object.freeze({ get done() { return done; }, snapshot: () => ({ state, completed, receipts: receipts.slice() }), cancel: stop,
    get closingDone() { return windowCloseTask; },
    unsavedEvidence: () => job ? job.unsavedEvidence() : null });
}
module.exports = { install, PREPARE_MS, WORK_MS, RESOURCE_MS, WINDOW_OBSERVER_VERSION };
