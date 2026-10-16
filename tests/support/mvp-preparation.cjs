'use strict';
// Actual-window P-03 only. Never invokes the drag/performance driver.
const path = require('path');
function install(options) {
  const win = options.window, doc = options.document, eagle = options.eagle, h = options.helpers || {};
  const repo = path.resolve(__dirname, '../..'), runtime = h.runtime || require('./preparation-runtime.cjs');
  const verify = h.verify || (() => require('../../scripts/prepare-mvp-host.cjs').verify());
  const createStore = h.createStore || require('./t4-evidence.cjs').createStore;
  const startMonitor = h.startMonitor || require('./mvp-monitor.cjs').start;
  const select = h.select || (() => require('../../plugin/eagle.cjs').captureSelected(eagle));
  const manifest = h.manifest || ((root, value) => require('./window-host.cjs')._test.registeredManifest(root, value));
  const now = () => win.performance.now(), rows = [], resourcesRefs = [];
  let prepared, reference, owner, store, monitor, runCallback, closeCallback, roundClose, off, failed = null, runId = null, storeReady = false;
  let closing = false, launching = false, started = false, finished = false, activeRound = 0, disposed = 0, abortWait = null;
  const snapshot = () => win.EVADiagnostics && win.EVADiagnostics.snapshot();
  function verifyBound() {
    const current = verify();
    if (current.marker.mode !== 'preparation' || JSON.stringify(current.marker.preparation) !== JSON.stringify(reference) ||
        JSON.stringify(current.marker.sourceHashes) !== JSON.stringify(prepared.marker.sourceHashes)) throw Error('计时入口或来源在运行期间改变，本轮停止。');
  }
  function message(text, error = false) {
    if (closing) return; doc.title = '阶段4准备计时 · ' + text;
    for (const id of ['status', 'notice']) { const el = doc.getElementById(id); if (el) { el.textContent = text; el.hidden = false; } }
    const el = doc.getElementById('error'); if (el) { el.textContent = error ? text : ''; el.hidden = !error; }
  }
  function check() { if (closing) throw Error('用户已关闭准备计时'); if (failed) throw failed; }
  function closeProduct() {
    if (!roundClose) roundClose = Promise.resolve().then(() => {
      if (!closeCallback) throw Error('正式关闭入口尚未登记。'); return closeCallback();
    }).then(result => { if (!result || result.status !== 'closed') throw Error('正式关闭/释放未成功。'); return result; });
    return roundClose;
  }
  function stop(error) {
    failed = failed || error; if (abortWait) abortWait(failed);
    if (started && closeCallback) closeProduct().catch(() => {});
  }
  function cancel() {
    if (closing) return; closing = true; if (abortWait) abortWait(Error('user-requested-close'));
    if (monitor) monitor.stop(); if (store) store.close(); if (off) off();
    // No writes, await, or preventDefault in SDK/DOM exit notifications.
  }
  const originalCreate = eagle.onPluginCreate;
  eagle.onPluginCreate = callback => {
    eagle.onPluginCreate = originalCreate;
    return originalCreate.call(eagle, plugin => {
      const calledAt = now();
      if (launching || started || closing || finished) return;
      launching = true;
      // SDKs may deliver create synchronously while app.js is still registering
      // run/close. Include this microtask wait in the original callback clock.
      return Promise.resolve().then(() => execute(callback, plugin, calledAt)).catch(error => { finished = true; message('记录失败：' + String(error.message || error), true); });
    });
  };
  const originalRun = eagle.onPluginRun;
  if (typeof originalRun === 'function') eagle.onPluginRun = callback => {
    eagle.onPluginRun = originalRun; runCallback = callback;
    return originalRun.call(eagle, () => { if (!closing) message(finished ? '本项已结束，请关闭本窗口。' : '正在自动准备计时，请等待。'); });
  };
  const originalExit = eagle.onPluginBeforeExit;
  if (typeof originalExit === 'function') eagle.onPluginBeforeExit = callback => {
    eagle.onPluginBeforeExit = originalExit; closeCallback = callback;
    return originalExit.call(eagle, (...args) => { cancel(); return callback(...args); });
  };
  win.addEventListener('beforeunload', cancel); win.addEventListener('pagehide', cancel);
  async function awaitReady(callback, calledAt, expectedReuse) {
    let timer; const aborted = new Promise((_, reject) => { abortWait = reject; }); aborted.catch(() => {});
    timer = win.setTimeout(() => stop(Error('本次完整准备超过60秒，停止并保留记录。')), 60000);
    try {
      await Promise.race([Promise.resolve().then(callback), aborted]); check();
      while (true) {
        const value = snapshot();
        if (value && value.state === 'paused' && value.playback && value.loadMetrics) {
          const p = value.playback, m = value.loadMetrics;
          if (!value.sourceIdentity || value.sourceIdentity.itemId !== owner.source.itemId || value.sourceIdentity.sha256 !== owner.source.sha256 ||
              path.resolve(value.sourceIdentity.filePath).toLowerCase() !== path.resolve(owner.source.filePath).toLowerCase() || value.pluginRoot !== reference.root)
            throw Error('计时源素材/路径/SHA或隔离根不符。');
          if (p.budget.limit !== 1024 ** 3 || p.compressed.limitBytes !== 128 * 1024 ** 2 || p.frameId !== 0 || p.pendingTargets ||
              p.state !== 'paused' || !p.audioAvailable || !p.drawCount || m.reused !== expectedReuse)
            throw Error('正式画面、音频、预算、首帧或首次/复用状态不符。');
          if (!Number.isFinite(m.readyAt) || m.readyAt < calledAt || !Number.isFinite(m.entryAt) || m.entryAt < calledAt || m.entryAt > m.readyAt ||
              Math.abs(m.totalMs - (m.readyAt - m.entryAt)) > 0.01) throw Error('准备时钟起止不一致。');
          return { value, callbackToReadyMs: m.readyAt - calledAt, observedAt: now(), calledAt };
        }
        if (value && ['empty', 'error', 'closed'].includes(value.state)) throw Error(value.error && value.error.message || '准备未达到完整就绪。');
        await Promise.race([new Promise(resolve => win.setTimeout(resolve, 20)), aborted]); check();
      }
    } finally { win.clearTimeout(timer); abortWait = null; }
  }
  async function execute(createCallback, sdkPlugin, firstAt) {
    let resources = null, cleanup = null, sequenceComplete = false, error = null;
    try {
      check();
      prepared = verify();
      if (prepared.marker.mode !== 'preparation' || prepared.host !== options.hostRoot || !sdkPlugin ||
          path.resolve(sdkPlugin.path).toLowerCase() !== prepared.host.toLowerCase()) throw Error('准备计时入口或SDK路径不符。');
      reference = prepared.marker.preparation; owner = runtime.verify(reference);
      if (!runCallback || !closeCallback) throw Error('正式run/close回调未登记，不启动。');
      store = createStore(repo); const reservation = store.start({ reserveBytes: 3 * 1024 ** 2 }); storeReady = true; runId = reservation.runId;
      const selected = await select(); check();
      if (selected.itemId !== owner.source.itemId || path.resolve(selected.filePath).toLowerCase() !== path.resolve(owner.source.filePath).toLowerCase())
        throw Error('请在Eagle中单选“索尼克”，关闭本窗口后重新打开；本次未生成缓存。');
      runtime.mark(reference, 'started.json', { runId: reservation.runId, at: new Date().toISOString(), pid: process.pid }); started = true;
      if (doc.body) doc.body.inert = true;
      store.save('host', { schema: 'mvp-p03-window-start-v1', at: new Date().toISOString(), pid: process.pid, versions: process.versions,
        source: owner.source, reference, sourceHashes: prepared.marker.sourceHashes, runtimeOriginal: owner.original, runtimeCopied: owner.copied,
        limits: owner.limits, firstSdkCallbackAt: firstAt, cacheState: 'no-test-cache', overallT4Accepted: false });
      monitor = startMonitor({ ramBytes: 1024 ** 3, now, onStop: stop, snapshot: () => {
        const s = snapshot(); return { protocol: 'P03-only', round: activeRound, state: s && s.state,
          phase: s && s.progress && s.progress.stage, managedUsedBytes: s && s.playback && s.playback.budget.used }; } });
      for (let n = 0; n < 6; n++) {
        check(); activeRound = n + 1; runtime.verify(reference); verifyBound();
        if (n && n % 2 === 0) runtime.clear(reference, store, 'before-first-' + (n / 2 + 1));
        const current = await select(); check();
        if (current.itemId !== owner.source.itemId || current.filePath !== selected.filePath) throw Error('Eagle选中素材已变化，本轮停止。');
        const reuse = n % 2 === 1, pair = Math.floor(n / 2) + 1;
        message((reuse ? '复用' : '首次准备') + ' ' + pair + '/3，请保持窗口可见，勿操作');
        const calledAt = n === 0 ? firstAt : now(); roundClose = null;
        const loaded = await awaitReady(n === 0 ? () => createCallback({ ...sdkPlugin, path: reference.root }) : () => runCallback(), calledAt, reuse);
        if (!off) off = win.EVADiagnostics.subscribe(event => {
          if (event.type === 'player' && event.value && event.value.event && event.value.event.phase === 'disposed') {
            if (event.value.event.budgetBytes !== 0) stop(Error('关闭后受管RAM未归零。')); else disposed++;
          }
        });
        const registered = manifest(reference.root, loaded.value), info = registered.info;
        require('../../plugin/frame-pack.cjs').validate(info, owner.limits.diskBytes);
        if (!info.framePack || info.frames.length !== 1490 || !info.audio) throw Error('新JPEG包、全部源帧或音频清单不符。');
        const limitMs = loaded.value.duration < 5 ? 5000 : loaded.value.duration * 1000;
        const row = { number: n + 1, pair, kind: reuse ? 'reuse' : 'first', entry: n === 0 ? 'real-SDK-create' : 'controlled-registered-formal-run',
          callbackAt: calledAt, readyAt: loaded.value.loadMetrics.readyAt, observedAt: loaded.observedAt,
          callbackToReadyMs: loaded.callbackToReadyMs, appLoadMetrics: loaded.value.loadMetrics,
          durationSeconds: loaded.value.duration, firstLimitMs: limitMs, firstRequirementPassed: reuse ? null : loaded.callbackToReadyMs <= limitMs,
          sourceIdentity: loaded.value.sourceIdentity, frameId: loaded.value.playback.frameId, audioAvailable: loaded.value.playback.audioAvailable,
          budget: loaded.value.playback.budget, compressed: loaded.value.playback.compressed,
          manifestSha256: registered.manifestSha256, frames: info.frames.length, pack: info.framePack, audio: info.audio };
        const before = disposed; row.closeResult = await closeProduct(); check();
        if (disposed !== before + 1) throw Error('未观察到本轮Player真实释放完成。');
        row.disposedBudgetBytes = 0; row.afterCloseState = snapshot().state;
        if (row.afterCloseState !== 'closed') throw Error('关闭后正式会话未结束。');
        row.receipt = store.save('host', { schema: 'mvp-p03-window-round-v1', ...row }); rows.push(row);
      }
      sequenceComplete = true;
    } catch (failure) { error = String(failure.message || failure); }
    finally {
      try { if (started && closeCallback) await closeProduct(); } catch (failure) { error = error || String(failure.message || failure); }
      if (off) off();
      if (!closing && sequenceComplete && !error && !failed && monitor && !monitor.issue) {
        try {
          runtime.clear(reference, store, 'protocol-finished'); cleanup = await runtime.cleanup(reference, store);
          verifyBound(); runtime.verify(reference);
        } catch (failure) { error = String(failure.message || failure); }
      }
      if (monitor) resources = await monitor.stop();
      if (closing) return;
      try {
        if (!storeReady) { finished = true; message('未开始计时：' + error, true); return; }
        if (resources) for (let n = 0; n < resources.rows.length; n += 200)
          resourcesRefs.push(store.save('lifecycle', { schema: 'mvp-p03-resource-chunk-v1', index: n / 200, rows: resources.rows.slice(n, n + 200) }));
        const resourceComplete = !!(resources && !resources.issue && resources.observer.samples >= 10 && !resources.observer.stopReasons.length);
        const complete = sequenceComplete && !error && !failed && resourceComplete;
        const passed = complete && rows.filter(r => r.kind === 'first').every(r => r.firstRequirementPassed);
        const receipt = store.save('host', { schema: 'mvp-p03-window-summary-v1', runId, source: owner && owner.source, reference,
          complete, passed, error: error || failed && failed.message || resources && resources.issue, rows, sourceHashes: prepared && prepared.marker.sourceHashes,
          resources: resources && resources.observer, resourceChunks: resourcesRefs, cleanup, userObservations: 'not-recorded', overallT2Accepted: false, overallT4Accepted: false,
          limitations: ['Actual Eagle SDK/render/audio; isolated copied runtime with only a declared 240MiB worker disk ceiling.',
            'First actual SDK create, next five controlled calls to registered formal run, each after actual session/Player/worker shutdown; not six physical window opens.',
            'No OS cache flush, no measurement before the SDK callback, no drag/physical display/audio listening or long resource retest.'] });
        if (started) runtime.mark(reference, 'finished.json', { receipt, complete, passed });
        finished = true;
        message(complete ? (passed ? '6次准备计时已完成，记录已保存。请关闭本窗口。' : '6次计时已保存，首次等待仍超目标。请关闭本窗口。') : '计时停止，记录已保存：' + (error || failed && failed.message || resources && resources.issue || '资源记录不完整'), !passed);
      } catch (failure) { finished = true; message('计时/清理记录未完成：' + String(failure.message || failure) + '；现场已保留。', true); }
      finally { if (store) store.close(); }
    }
  }
  return Object.freeze({ cancel, status: () => ({ started, closing, finished, activeRound }) });
}
module.exports = { install };
