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
    doc.title = (activeMode === 'annotations' ? 'T3 标注验收' : activeMode === 'preferences' ? 'T2 内存设置验收' : 'T2 自动测量') + ' · ' + text;
    const node = doc.getElementById(failed ? 'error' : 'status');
    if (node) { node.textContent = text; node.hidden = false; }
  }
  function saveFailure(error, context) {
    if (failureSaved || !safeToRecord) return; failureSaved = true;
    let store;
    try {
      store = storeFactory(repo, { stage: activeMode === 'annotations' ? 'T3' : 'T2' }); store.start({ reserveBytes: 64 * 1024 });
      receipts.push(store.save('host', { schema: 'window-automatic-entry-failure-v1', stage: activeMode === 'annotations' ? 'T3' : 'T2', origin: 'real-Eagle-independent-test-entry',
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
      let ramContext = null;
      if (prepared.marker.ramDiagnostic) {
        const fs = require('fs'), crypto = require('crypto'), sha = value => crypto.createHash('sha256').update(value).digest('hex');
        let selectionTimer, selected;
        try { selected = await Promise.race([require('../../plugin/eagle.cjs').createEagleAdapter(eagle).captureSelected(),
          new Promise((_, reject) => { selectionTimer = win.setTimeout(() => reject(new Error('RAM对照选中核对超过10秒，未执行准备。')), 10000); })]); }
        finally { win.clearTimeout(selectionTimer); }
        if (selected.itemId !== 'MV6H7OK0MBGX2') throw new Error('本次RAM对照请单选“喜多郁代”，未执行缓存或测量。');
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
      if (activeMode === 'preferences') {
        if (!snapshot.memorySettings || !snapshot.playback || snapshot.playback.budget.limit !== snapshot.memorySettings.ramBytes)
          throw new Error('正式内存设置与实际Player额度不符，未记录就绪。');
        const store = storeFactory(repo, { stage: 'T2' });
        try {
          store.start({ reserveBytes: 64 * 1024 });
          receipts.push(store.save('host', { schema: 'window-memory-settings-ready-v1', stage: 'T2', origin: 'real-Eagle-preferences-ready-observation',
            at: new Date().toISOString(), launchContext: context, state: snapshot.state, sourceIdentity: snapshot.sourceIdentity,
            memorySettings: snapshot.memorySettings, playback: snapshot.playback ? { frameId: snapshot.playback.frameId,
              time: snapshot.playback.time, budget: snapshot.playback.budget } : null, loadMetrics: snapshot.loadMetrics,
            settingsInteractionVerified: false, performanceVerified: false }));
        } catch (error) { failureSaved = true; throw new Error('内存设置就绪证据未保存：' + error.message); }
        finally { store.close(); }
        state = 'saved';
        message('内存设置已就绪，请体验修改与重开保留；本次不自动拖动。');
        return { complete: true, observationSaved: true, receipts };
      }
      state = 'measuring'; doc.title = activeMode === 'annotations' ? 'T3 标注验收 · 只读观察／具体授权后一次写入' : activeMode === 'resource' ? 'T2 资源验证 · 60分钟运行＋5分钟静置' : ramContext ? 'T2 自动测量 · '+(ramContext.ramMiB/1024)+'GB RAM对照，请保持前台，约2分钟' : 'T2 自动测量 · 请保持前台，约2分钟';
      const runner = activeMode === 'annotations' && !options.run ? require('./window-annotations.cjs').run : activeMode === 'resource' && !options.run ? require('./window-resource.cjs').run : start;
      job = runner({ bridge, document: doc, window: win, pluginRoot: prepared.plugin, launchContext: context,
        verifyLaunch: () => verify(repo), eagle,
        reloadSelected: () => { if (!runCallback) throw new Error('正式重复调用回调缺失。'); return runCallback(); },
        closeSession: () => { if (!exitCallback) throw new Error('正式退出回调缺失。'); return exitCallback(); } });
      timer = win.setTimeout(() => { stopping = true; job.cancel('timeout'); }, activeMode === 'annotations' ? 20 * 60000 : activeMode === 'resource' ? RESOURCE_MS : WORK_MS);
      const result = await job.done; clearTimer(); receipts = result.receipts || [];
      state = result.complete ? 'saved' : 'failed';
      const passed = activeMode === 'annotations' ? result.complete && result.observationSaved : activeMode === 'resource' ? result.complete && result.resourceGatePassed : result.complete && result.earlyRegressionPassed && result.p03 && result.p03.withinTarget !== false;
      message(passed ? (activeMode === 'annotations' ? '标注观察已保存，由Codex核对；不代表T3整体验收通过。' : activeMode === 'resource' ? '本轮资源记录已保存；两轮齐备后由Codex核对。' : '测量已保存，早期门槛通过；请告知Codex核对。') :
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
