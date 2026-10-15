/* Eagle lifecycle and dependency wiring only. */
(function () {
  'use strict';
  const path = require('path'), fs = require('fs');
  let ui = window.EVAUI.createUI();
  let session = null, diagnostics = null, initializing = false, closed = false;
  let closeTask = null, allowUnload = false, exitScheduled = false;
  let backend = null, adapter = null, lastPlugin = null, pendingOpen = null, initialSelection = null;
  let entryOverride = null;
  const now = () => performance.now();
  const startupError = error => ui.update({ state: 'error', source: null, duration: 0, playback: null, error: { message: String(error && error.message || error) } });
  function cancelled() { const error = new Error('视频准备已取消。'); error.name = 'AbortError'; error.code = 'PREPARATION_CANCELLED'; return error; }
  // SDK discovery itself cannot be cancelled. Only this session's wait ends;
  // handlers still consume a late result/rejection without starting old work.
  function waitTools(pending, signal) {
    if (signal && signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => { if (signal) signal.removeEventListener('abort', aborted); callback(value); };
      const aborted = () => finish(reject, cancelled());
      if (signal) signal.addEventListener('abort', aborted, { once: true });
      pending.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  async function loadSelected(settings) {
    const result = await session.loadSelected(settings);
    if (diagnostics) diagnostics.publish('load-result', result);
    return result;
  }
  function initialize(plugin) {
    const entryAt = entryOverride === null ? now() : entryOverride; entryOverride = null;
    if (closed || initializing || session) return;
    initializing = true;
    try {
      if (!plugin || typeof plugin.path !== 'string' || !path.isAbsolute(plugin.path)) throw new Error('Eagle 未提供有效插件目录，请从插件入口打开。');
      const root = fs.realpathSync(plugin.path);
      lastPlugin = plugin;
      const { createTaskClient } = require(path.join(root, 'task-client.cjs'));
      const { createEagleAdapter } = require(path.join(root, 'eagle.cjs'));
      const { createSession } = require(path.join(root, 'session.cjs'));
      const { createDiagnostics } = require(path.join(root, 'diagnostics.cjs'));
      const { createMemoryPreferences } = require(path.join(root, 'preferences.cjs'));
      const preferences = createMemoryPreferences({ pluginRoot: root });
      const frameIndex = require(path.join(root, 'frame-index.cjs'));
      if (!diagnostics) {
        diagnostics = createDiagnostics({ snapshot: () => session ? { ...session.snapshot(),
          annotationReceipts: session.annotationHistory ? session.annotationHistory() : [], pluginRoot: root } : null });
        Object.defineProperty(window, 'EVADiagnostics', { value: diagnostics.public, writable: false, configurable: false });
      }
      adapter = createEagleAdapter(eagle);
      const sessionAdapter = { ...adapter };
      sessionAdapter.captureSelected = () => { if (initialSelection) { const captured = initialSelection; initialSelection = null; return captured; } return adapter.captureSelected(); };
      const cache = { readAsset: (...args) => backend.cache.readAsset(...args),
        release: (...args) => backend.cache.release(...args), clearOther: (...args) => backend.cache.clearOther(...args) };
      let preparedMedia = null, discovery = null;
      // Selection is captured by session immediately; tool discovery waits only
      // inside preparation, so it cannot silently change the clicked material.
      const media = { async prepare(snapshot, options) {
        const signal = options && options.signal;
        if (signal && signal.aborted) throw cancelled();
        if (!preparedMedia) {
          if (!discovery) discovery = Promise.resolve().then(() => adapter.discoverTools())
            .finally(() => { discovery = null; });
          const tools = await waitTools(discovery, signal);
          if (signal && signal.aborted) throw cancelled();
          if (!preparedMedia) {
            backend = createTaskClient({ pluginRoot: root, discoverTools: async () => tools,
              onWaiting: () => { if (session && !closed) ui.update({ ...session.snapshot(), progress: { stage: 'handover', message: '正在等待上一个视频任务结束' } }); },
              onFailure: error => { if (session && !closed) session.close().finally(() => startupError(error)).catch(() => {}); } });
            preparedMedia = backend.media;
          }
        }
        return preparedMedia.prepare(snapshot, options);
      } };
      session = createSession({ eagleAdapter: sessionAdapter, media, cache, now, memoryPreferences: preferences,
        createPlayer: options => {
          const value = session.snapshot(), identity = value.sourceIdentity;
          const binding = Object.freeze({ sessionEpoch: value.epoch, libraryEpoch: value.libraryEpoch,
            itemId: identity && identity.itemId, sourceSha256: identity && identity.sha256 });
          const memory = preferences.snapshot();
          return new window.EVAPlayer.Player({ ...options, ramBytes: memory.ramBytes, compressedRamBytes: memory.compressedRamBytes, canvas: ui.canvas, frameIndex,
            emit: event => diagnostics.publish('player', () => ({ binding, event })) });
        }, onChange: snapshot => { ui.update(snapshot); diagnostics.publish('state', snapshot); } });
      ui.bindSession(session);
      return loadSelected({ startedAt: entryAt, trigger: 'plugin-create' }).catch(() => {});
    } catch (error) { startupError(error); }
    finally { initializing = false; }
  }
  function close() {
    if (closeTask) return closeTask;
    closed = true;
    try { closeTask = (async () => {
      let result, failure;
      // Arm the independent deadline before awaiting potentially stuck media
      // cleanup. Player reads still drain before the owner releases its leases.
      try { if (backend) backend.beginClose(); } catch (error) { failure = error; }
      try { result = session ? await session.close() : { status: 'closed' }; } catch (error) { failure = error; }
      try { if (backend) await backend.close(); } catch (error) { failure = failure || error; }
      if (failure) throw failure;
      return result;
    })(); }
    catch (error) { closeTask = Promise.reject(error); }
    // Opt-in observation only: the actual cleanup result, not a close request
    // or the session's early "closed" state. No subscriber means no recording.
    closeTask.then(result => { if (diagnostics) diagnostics.publish('close-result', result); }, failure => {
      if (diagnostics) diagnostics.publish('close-result', { status: 'error', error: {
        message: String(failure && failure.message || failure).slice(0, 1024) } });
    });
    closeTask.catch(() => {});
    ui.destroy(); ui.update({ state: 'closing', source: null, duration: 0, playback: null, error: null }); return closeTask;
  }
  function run() {
    if (session && !closed) return loadSelected({ startedAt: now(), trigger: 'plugin-run' }).catch(() => {});
    if (!closed || !lastPlugin || !adapter) return;
    const startedAt = now(); let captured;
    try { captured = Promise.resolve(adapter.captureSelected()); } catch (error) { captured = Promise.reject(error); }
    const request = { captured, startedAt };
    request.captured.catch(() => {}); pendingOpen = request;
    return closeTask.then(result => {
      if (pendingOpen !== request) return;
      if (result && result.status === 'error') throw new Error(result.error && result.error.message || '旧任务未能正常释放。');
      pendingOpen = null; initialSelection = request.captured; entryOverride = request.startedAt;
      session = null; backend = null; closeTask = null; closed = false; allowUnload = false; exitScheduled = false;
      ui = window.EVAUI.createUI(); return initialize(lastPlugin);
    }).catch(startupError);
  }
  function closeFailed(error) {
    allowUnload = false; exitScheduled = false;
    ui.update({ state: 'closed', source: null, duration: 0, playback: null,
      error: { message: '关闭清理失败，窗口暂未关闭：' + String(error && error.message || error).slice(0, 1024) } });
    // An error remains an error in diagnostics. Once the independent owner has
    // actually exited, it must not imprison the user's error window forever.
    if (backend && backend.stopped) setTimeout(() => { allowUnload = true; window.close(); }, 0);
  }
  function beforeUnload(event) {
    if (allowUnload) return;
    // Eagle's exit notification does not await our Promise. Keep this renderer
    // alive so media can stop/wait for children and streams, abort its own
    // partial and release writer/leases before allowing the actual close.
    event.returnValue = false;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (exitScheduled) return;
    exitScheduled = true;
    const closing = close(); closing.then(result => {
      if (result && result.status === 'error') throw new Error(result.error && result.error.message || '资源释放未完成');
      // A settled ready/empty session can finish entirely in microtasks. Asking
      // Electron to close again there can reach the browser before its first
      // cancelled-beforeunload ACK, so Chromium merges that second request.
      // A new task lets the cancellation finish before making the real close.
      setTimeout(() => {
        if (closeTask !== closing || pendingOpen) return;
        try { allowUnload = true; window.close(); }
        catch (error) { closeFailed(error); }
      }, 0);
    }).catch(closeFailed);
  }
  if (typeof eagle !== 'undefined' && typeof eagle.onPluginCreate === 'function') {
    eagle.onPluginCreate(initialize);
    if (typeof eagle.onPluginRun === 'function') eagle.onPluginRun(run);
    if (typeof eagle.onLibraryChanged === 'function') eagle.onLibraryChanged(() => session && !closed ? session.libraryChanged().catch(startupError) : undefined);
    if (typeof eagle.onPluginBeforeExit === 'function') eagle.onPluginBeforeExit(close);
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', close);
  } else startupError(new Error('请从 Eagle 打开视频分析插件。'));
})();
