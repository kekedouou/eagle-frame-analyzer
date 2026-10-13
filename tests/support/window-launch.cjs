'use strict';
// A real Eagle test window with original SDK calls and formal source files.
// Only the onPluginCreate directory is mapped to the actual formal plugin.
const path = require('path');
const entry = require('../../scripts/prepare-window-host.cjs');
const driver = require('./window-host.cjs');
const { createStore } = require('./t2-evidence.cjs');
const PREPARE_MS = 120000, WORK_MS = 180000, RESOURCE_MS = 72 * 60000;
function install(options) {
  const { window: win, document: doc, eagle, hostRoot } = options;
  if (!win || !doc || !eagle || typeof eagle.onPluginCreate !== 'function') throw new Error('请从 Eagle 加载T2独立自动验证入口。');
  const repo = path.resolve(hostRoot, '../../..'), register = eagle.onPluginCreate;
  const verify = options.verify || entry.verify, start = options.run || driver.run, storeFactory = options.createStore || createStore;
  let state = 'waiting', job = null, stopping = false, closeRequested = false, allowUnload = false, completed = false;
  let timer = null, done = Promise.resolve(), receipts = [], failureSaved = false, safeToRecord = false, closeScheduled = false;
  let cancelPreparation = null, runCallback = null, exitCallback = null, activeMode = 'performance';
  // Capture formal callbacks for test invocation; restore SDK registration immediately.
  for (const [name, assign] of [['onPluginRun', callback => { runCallback = callback; }], ['onPluginBeforeExit', callback => { exitCallback = callback; }]]) {
    if (typeof eagle[name] !== 'function') continue;
    const registration = eagle[name];
    eagle[name] = callback => { eagle[name] = registration; assign(callback); return registration.call(eagle, callback); };
  }
  const clearTimer = () => { if (timer !== null) { win.clearTimeout(timer); timer = null; } };
  function message(text, failed = false) {
    doc.title = 'T2 自动测量 · ' + text;
    const node = doc.getElementById(failed ? 'error' : 'status');
    if (node) { node.textContent = text; node.hidden = false; }
  }
  function saveFailure(error, context) {
    if (failureSaved || !safeToRecord) return; failureSaved = true;
    let store;
    try {
      store = storeFactory(repo); store.start({ reserveBytes: 64 * 1024 });
      receipts.push(store.save('host', { schema: 'window-automatic-entry-failure-v1', stage: 'T2', origin: 'real-Eagle-independent-test-entry',
        complete: false, earlyRegressionPassed: false, at: new Date().toISOString(), state, context,
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
    closeRequested = true; stop();
    if (allowUnload || !job || completed) return;
    // Preserve the driver's failure receipt before the renderer disappears.
    event.returnValue = false; if (event.preventDefault) event.preventDefault();
    if (closeScheduled) return; closeScheduled = true;
    done.finally(() => win.setTimeout(() => { allowUnload = true; win.close(); }, 0)).catch(() => {});
  }
  win.addEventListener('beforeunload', beforeUnload);
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
      if (!plugin || typeof plugin.path !== 'string' || path.resolve(plugin.path).toLowerCase() !== prepared.host.toLowerCase())
        throw new Error('SDK提供的验证插件目录与准备记录不符。');
      safeToRecord = true;
      context = { kind: 'real-Eagle-formal-code-independent-entry', sdkPluginRoot: prepared.host,
        entryScheme: options.entryScheme || 'unspecified',
        mappedFormalRoot: prepared.plugin, sourceHashes: prepared.marker.sourceHashes,
        boundary: 'Real SDK/media/cache/UI/player; test entry maps create.path only. Not the formal manifest startup.', sdkCallbackAt: callbackAt };
      state = 'preparing';
      const aborted = new Promise((_, reject) => { cancelPreparation = reject; });
      // Consume a cancellation even if a synchronous callback throws first.
      aborted.catch(() => {});
      timer = win.setTimeout(() => { stopping = true;
        cancelPreparation(new Error('准备超过120秒，未执行测量。'));
        message('准备超过120秒，未开始测量；正在请求正常关闭。', true); win.close(); }, PREPARE_MS);
      const initial = await Promise.race([callback({ ...plugin, path: prepared.plugin }), aborted]);
      context.initialCreateResult = initial && initial.status || 'unspecified';
      if (stopping) throw new Error('准备阶段已取消，未执行测量。');
      const bridge = win.EVADiagnostics, snapshot = await waitReady(bridge, context, aborted);
      clearTimer(); cancelPreparation = null;
      if (stopping) throw new Error('准备阶段已取消，未执行测量。');
      verify(repo);
      context.callbackToReadyMs = snapshot.loadMetrics.readyAt - callbackAt;
      if (!Number.isFinite(context.callbackToReadyMs) || context.callbackToReadyMs < 0)
        throw new Error('就绪时钟与SDK回调时钟不一致，不能记录启动耗时。');
      context.appEntryToReadyMs = snapshot.loadMetrics.totalMs;
      context.readyEpoch = snapshot.epoch;
      context.readyTrigger = snapshot.loadMetrics.trigger;
      state = 'measuring'; doc.title = activeMode === 'resource' ? 'T2 资源验证 · 60分钟运行＋5分钟静置' : 'T2 自动测量 · 请保持前台，约2分钟';
      const runner = activeMode === 'resource' && !options.run ? require('./window-resource.cjs').run : start;
      job = runner({ bridge, document: doc, window: win, pluginRoot: prepared.plugin, launchContext: context,
        verifyLaunch: () => verify(repo), eagle,
        reloadSelected: () => { if (!runCallback) throw new Error('正式重复调用回调缺失。'); return runCallback(); },
        closeSession: () => { if (!exitCallback) throw new Error('正式退出回调缺失。'); return exitCallback(); } });
      timer = win.setTimeout(() => { stopping = true; job.cancel(); }, activeMode === 'resource' ? RESOURCE_MS : WORK_MS);
      const result = await job.done; clearTimer(); receipts = result.receipts || [];
      state = result.complete ? 'saved' : 'failed';
      const passed = activeMode === 'resource' ? result.complete && result.resourceGatePassed : result.complete && result.earlyRegressionPassed && result.p03 && result.p03.withinTarget !== false;
      message(passed ? (activeMode === 'resource' ? '本轮资源记录已保存；两轮齐备后由Codex核对。' : '测量已保存，早期门槛通过；请告知Codex核对。') :
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
      if (!closeRequested) win.removeEventListener('beforeunload', beforeUnload);
    }
  }
  return Object.freeze({ get done() { return done; }, snapshot: () => ({ state, completed, receipts: receipts.slice() }), cancel: stop,
    unsavedEvidence: () => job ? job.unsavedEvidence() : null });
}
module.exports = { install, PREPARE_MS, WORK_MS, RESOURCE_MS };
