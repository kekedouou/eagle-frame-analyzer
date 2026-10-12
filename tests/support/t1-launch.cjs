'use strict';
// A real Eagle test window with original SDK calls and formal source files.
// Only the onPluginCreate directory is mapped to the actual formal plugin.
const path = require('path');
const entry = require('../../scripts/prepare-t1-host.cjs');
const driver = require('./t1-host.cjs');
const { createStore } = require('./t1-evidence.cjs');
const PREPARE_MS = 120000, WORK_MS = 180000;
function install(options) {
  const { window: win, document: doc, eagle, hostRoot } = options;
  if (!win || !doc || !eagle || typeof eagle.onPluginCreate !== 'function') throw new Error('请从 Eagle 加载T1独立自动验证入口。');
  const repo = path.resolve(hostRoot, '../../..'), register = eagle.onPluginCreate;
  const verify = options.verify || entry.verify, start = options.run || driver.run, storeFactory = options.createStore || createStore;
  let state = 'waiting', job = null, stopping = false, closeRequested = false, allowUnload = false, completed = false;
  let timer = null, done = Promise.resolve(), receipts = [], failureSaved = false, safeToRecord = false, closeScheduled = false;
  const clearTimer = () => { if (timer !== null) { win.clearTimeout(timer); timer = null; } };
  function message(text, failed = false) {
    doc.title = 'T1 自动测量 · ' + text;
    const node = doc.getElementById(failed ? 'error' : 'status');
    if (node) { node.textContent = text; node.hidden = false; }
  }
  function saveFailure(error, context) {
    if (failureSaved || !safeToRecord) return; failureSaved = true;
    let store;
    try {
      store = storeFactory(repo); store.start({ reserveBytes: 64 * 1024 });
      receipts.push(store.save('host', { schema: 't1-automatic-entry-failure-v1', origin: 'real-Eagle-independent-test-entry',
        complete: false, earlyRegressionPassed: false, at: new Date().toISOString(), state, context,
        error: { message: String(error && error.message || error).slice(0, 2048) } }));
    } catch (saving) { message('验证失败且回执未保存：' + String(saving.message).slice(0, 512), true); }
    finally { if (store) { try { store.close(); } catch (_) {} } }
  }
  function stop() { if (completed) return; stopping = true; if (job) job.cancel(); }
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
      state = 'preflight'; const prepared = verify(repo);
      if (!plugin || typeof plugin.path !== 'string' || path.resolve(plugin.path).toLowerCase() !== prepared.host.toLowerCase())
        throw new Error('SDK提供的验证插件目录与准备记录不符。');
      safeToRecord = true;
      context = { kind: 'real-Eagle-formal-code-independent-entry', sdkPluginRoot: prepared.host,
        entryScheme: options.entryScheme || 'unspecified',
        mappedFormalRoot: prepared.plugin, sourceHashes: prepared.marker.sourceHashes,
        boundary: 'Real SDK/media/cache/UI/player; test entry maps create.path only. Not the formal manifest startup.', sdkCallbackAt: callbackAt };
      state = 'preparing';
      timer = win.setTimeout(() => { stopping = true; message('准备超过120秒，未开始测量；正在请求正常关闭。', true); win.close(); }, PREPARE_MS);
      await callback({ ...plugin, path: prepared.plugin }); clearTimer();
      if (stopping) throw new Error('准备阶段已取消，未执行测量。');
      verify(repo);
      const bridge = win.EVADiagnostics, snapshot = bridge && bridge.snapshot();
      if (!snapshot || snapshot.state !== 'paused' || !snapshot.loadMetrics)
        throw new Error(snapshot && snapshot.error ? snapshot.error.message : '正式播放器没有首帧暂停就绪，未执行测量。');
      context.callbackToReadyMs = snapshot.loadMetrics.readyAt - callbackAt;
      if (!Number.isFinite(context.callbackToReadyMs) || context.callbackToReadyMs < 0)
        throw new Error('就绪时钟与SDK回调时钟不一致，不能记录启动耗时。');
      context.appEntryToReadyMs = snapshot.loadMetrics.totalMs;
      state = 'measuring'; doc.title = 'T1 自动测量 · 请保持前台，约2分钟';
      job = start({ bridge, document: doc, window: win, pluginRoot: prepared.plugin, launchContext: context,
        verifyLaunch: () => verify(repo) });
      timer = win.setTimeout(() => { stopping = true; job.cancel(); }, WORK_MS);
      const result = await job.done; clearTimer(); receipts = result.receipts || [];
      state = result.complete ? 'saved' : 'failed';
      const passed = result.complete && result.earlyRegressionPassed && result.p03 && result.p03.withinTarget !== false;
      message(passed ? '测量已保存，早期门槛通过；请告知Codex核对。' :
        '测量已保存，存在未通过项；请告知Codex核对。', !passed);
      return result;
    } catch (error) {
      clearTimer(); message('自动验证未通过：' + String(error.message || error).slice(0, 1024), true);
      if (!job) saveFailure(error, context); // The driver owns persistence once started; never retry its failed save.
      state = 'failed'; return { complete: false, earlyRegressionPassed: false, error: String(error.message || error), receipts };
    } finally {
      clearTimer(); completed = true;
      if (!closeRequested) win.removeEventListener('beforeunload', beforeUnload);
    }
  }
  return Object.freeze({ get done() { return done; }, snapshot: () => ({ state, completed, receipts: receipts.slice() }), cancel: stop,
    unsavedEvidence: () => job ? job.unsavedEvidence() : null });
}
module.exports = { install, PREPARE_MS, WORK_MS };
