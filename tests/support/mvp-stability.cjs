'use strict';
// Real Eagle long workload coordinator. The normal product never imports it.
const path = require('path');
function releaseObservation(observed) {
  if (!observed || observed.issue || !observed.lastSample) return { status: 'not-observed', reason: observed && observed.issue || 'no-final-sample' };
  const remaining = observed.lastSample.processes.filter(p => !['renderer', 'observer', 'observer-child'].includes(p.role));
  return { status: remaining.length ? 'not-released' : 'released', atMs: observed.lastSample.atMs, remaining };
}
function install(options) {
  const win = options.window, doc = options.document, eagle = options.eagle, h = options.helpers || {}, repo = path.resolve(__dirname, '../..');
  const runtime = h.runtime || require('./stability-runtime.cjs'), verify = h.verify || (() => require('../../scripts/prepare-mvp-host.cjs').verify());
  const resource = require('./window-resource.cjs'), traceApi = require('./long-trace.cjs');
  const now = () => win.performance.now(), snapshot = () => win.EVADiagnostics && win.EVADiagnostics.snapshot();
  let prepared, owner, reference, store, trace, monitor, driver, runCallback, closeCallback, closeTask, originalSelection, wrappedSelection;
  let started = false, launching = false, closing = false, finished = false, failed = null, selected = 0, nativeRows = [], abortWait = null;
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const check = () => { if (closing) throw Error('user-requested-close'); if (failed) throw failed; };
  function message(text, error = false) {
    if (closing) return; doc.title = '阶段4长期验证 · ' + text;
    for (const id of ['status', 'notice']) { const n = doc.getElementById(id); if (n) { n.textContent = text; n.hidden = false; } }
    const n = doc.getElementById('error'); if (n) { n.textContent = error ? text : ''; n.hidden = !error; }
  }
  function restore() { if (wrappedSelection && eagle.item.getSelected === wrappedSelection) eagle.item.getSelected = originalSelection; }
  function closeProduct() {
    if (!closeTask) { try { closeTask = Promise.resolve(closeCallback ? closeCallback() : { status: 'closed' }); }
      catch (e) { closeTask = Promise.reject(e); } closeTask.catch(() => {}); } return closeTask;
  }
  function stop(error) { failed = failed || error; if (abortWait) abortWait(failed); if (driver) driver.cancel(failed); if (started) closeProduct().catch(() => {}); }
  function cancel() {
    if (closing) return; closing = true; if (abortWait) abortWait(Error('user-requested-close'));
    if (driver) driver.cancel(); if (monitor) monitor.stop(); restore(); if (store) store.close();
    // No filesystem writes, await, or preventDefault in exit notifications.
  }
  function bound() {
    const current = verify();
    if (current.marker.mode !== 'stability' || JSON.stringify(current.marker.stability) !== JSON.stringify(reference) ||
        JSON.stringify(current.marker.sourceHashes) !== JSON.stringify(prepared.marker.sourceHashes)) throw Error('长期入口或来源变化。');
    runtime.verify(reference);
  }
  async function ready(callback) {
    check(); let timer;
    const aborted = new Promise((_, reject) => { abortWait = reject; timer = win.setTimeout(() => reject(Error('长期准备超过120秒。')), 120000); });
    aborted.catch(() => {});
    try {
      await Promise.race([Promise.resolve().then(callback), aborted]);
      while (true) {
        check(); const s = snapshot();
        if (s && s.state === 'paused' && s.playback && s.loadMetrics) {
          const source = owner.sources[selected];
          if (s.sourceIdentity.itemId !== source.id || s.sourceIdentity.sha256 !== source.sha256 || s.pluginRoot !== reference.root ||
              s.playback.frameId !== 0 || s.playback.budget.limit !== 1024 ** 3 || s.playback.compressed.limitBytes !== 128 * 1024 ** 2)
            throw Error('长期准备源、首帧或预算不符。');
          return s;
        }
        if (s && ['error', 'closed', 'empty'].includes(s.state)) throw Error(s.error && s.error.message || '长期准备没有就绪。');
        await Promise.race([sleep(20), aborted]);
      }
    } finally { win.clearTimeout(timer); abortWait = null; }
  }
  const originalCreate = eagle.onPluginCreate;
  eagle.onPluginCreate = callback => {
    eagle.onPluginCreate = originalCreate;
    return originalCreate.call(eagle, plugin => {
      if (launching || started || finished || closing) return; launching = true;
      return Promise.resolve().then(() => execute(callback, plugin)).catch(e => { finished = true; message('记录未完成：' + e.message, true); });
    });
  };
  const originalRun = eagle.onPluginRun;
  eagle.onPluginRun = callback => { eagle.onPluginRun = originalRun; runCallback = callback;
    return originalRun.call(eagle, () => message(finished ? '本轮已结束，请关闭窗口。' : '自动验证中，请勿操作插件。')); };
  const originalExit = eagle.onPluginBeforeExit;
  eagle.onPluginBeforeExit = callback => { eagle.onPluginBeforeExit = originalExit; closeCallback = callback;
    return originalExit.call(eagle, (...args) => { cancel(); return callback(...args); }); };
  win.addEventListener('beforeunload', cancel); win.addEventListener('pagehide', cancel);
  async function execute(createCallback, plugin) {
    let outcome = null, observed = null, cleanup = null, error = null, reservation = null;
    try {
      check(); prepared = verify(); reference = prepared.marker.stability;
      if (prepared.marker.mode !== 'stability' || prepared.host !== options.hostRoot || path.resolve(plugin.path).toLowerCase() !== prepared.host.toLowerCase() ||
          !runCallback || !closeCallback) throw Error('长期宿主入口/SDK回调不完整。');
      owner = runtime.unused(reference);
      store = (h.createStore || require('./t4-evidence.cjs').createStore)(repo);
      reservation = store.start({ reserveBytes: (traceApi.MAX.chunks + 3) * 128 * 1024 });
      const capture = h.capture || (() => require('../../plugin/eagle.cjs').captureSelected(eagle));
      const actual = await capture(); check();
      if (actual.itemId !== owner.sources[0].id || actual.filePath !== owner.sources[0].filePath) throw Error('请单选“索尼克”，关闭本窗口后再打开；本轮未启动。');
      const validate = h.validate || require('../../plugin/eagle.cjs').validateSnapshot;
      const samples = [];
      const hashSource = h.hashSource || resource._test.hashSource;
      for (const s of owner.sources) {
        const value = validate(await eagle.item.getById(s.id)); check();
        if (value.id !== s.id || value.filePath !== s.filePath || await hashSource(s.filePath) !== s.sha256) throw Error('长期固定源SDK或完整SHA不符。');
        samples.push({ ...value, sha256: s.sha256, frames: s.frames });
      }
      check(); runtime.mark(reference, 'started.json', { runId: reservation.runId, pid: process.pid, at: new Date().toISOString() }); started = true;
      store.save('host', { schema: 'mvp-stability-start-v1', runId: reservation.runId, at: new Date().toISOString(), pid: process.pid,
        versions: process.versions, reference, sources: owner.sources, profile: owner.profile, sourceHashes: prepared.marker.sourceHashes, limits: owner.limits });
      trace = (h.recorder || traceApi.recorder)(store);
      originalSelection = eagle.item.getSelected; let cachesReady = false;
      async function verifySamples() {
        bound(); for (const s of samples) { if (await hashSource(s.filePath) !== s.sha256) throw Error('长期原源内容变化。'); check(); await runtime.verifyAssets(s); check(); }
      }
      wrappedSelection = async () => { check(); const sample = samples[selected];
        if (await hashSource(sample.filePath) !== sample.sha256) throw Error('长期选中源变化。');
        check(); if (cachesReady) { await runtime.verifyAssets(sample); check(); } return [sample]; };
      eagle.item.getSelected = wrappedSelection; if (eagle.item.getSelected !== wrappedSelection) throw Error('测试选中读取无法绑定。');
      if (doc.body) doc.body.inert = true;
      monitor = (h.startMonitor || require('./mvp-monitor.cjs').start)({ long: true, ramBytes: 1024 ** 3, now, onStop: stop,
        snapshot: () => driver ? driver.status() : { phase: 'warm', sample: selected, elapsedMs: null },
        onRow(event, measured) {
          if (closing) return;
          trace.append({ kind: 'native', ...event });
          const c = event.context, minute = c && c.elapsedMs / 60000;
          if (c && c.elapsedMs !== null && (minute >= 10 && minute < 15 || minute >= 55 && minute < 60) && ['drag', 'play', 'step'].includes(c.phase)) {
            if (nativeRows.length >= 7000) throw Error('长期外部比较窗口超过有界容量。');
            nativeRows.push([c.elapsedMs, c.phase, c.sample, measured.pluginRssBytes]);
          }
        } });
      message('准备两段固定素材，随后自动运行60分钟＋静置5分钟');
      await ready(() => createCallback({ ...plugin, path: reference.root }));
      selected = 1; await ready(() => runCallback()); selected = 0; await ready(() => runCallback());
      cachesReady = true; await verifySamples(); check();
      driver = (h.startDriver || resource.run)({ bridge: win.EVADiagnostics, document: doc, window: win, pluginRoot: reference.root, eagle, evidenceStage: 'T4', verifyActivities: true,
        launchContext: { kind: 'real-Eagle-long-runtime', sourceHashes: prepared.marker.sourceHashes, reference, profile: owner.profile }, verifyLaunch: bound,
        onSample: row => { check(); trace.append({ kind: 'renderer', row }); }, reloadSelected: () => runCallback(), closeSession: closeProduct,
        selections: async () => ({ samples, choose(index) { if (index !== 0 && index !== 1) throw Error('长期样本编号无效。'); selected = index; }, verify: verifySamples, restore }),
        createStore: () => ({ start() {}, close() {}, save(kind, payload) {
          if (closing) throw Error('Long test already closed.');
          if (payload.schema !== 'window-resource-summary-v1') throw Error('长期窗口必须写入同一有界轨迹。');
          return { inline: true, schema: payload.schema, parent: 'mvp-stability-summary-v1' };
        } }) });
      outcome = await driver.done; check();
      if (!outcome.complete || !outcome.cleanupVerified) throw Error(outcome.summary && outcome.summary.error || '长期工作或释放未完成。');
      bound();
    } catch (e) { error = String(e.message || e); }
    finally {
      if (started) {
        let timer;
        try { const closed = await Promise.race([closeProduct(), new Promise((_, reject) => { timer = win.setTimeout(() => reject(Error('长期关闭超过30秒。')), 30000); })]);
          if (!closed || closed.status !== 'closed') throw Error('长期正式关闭未成功。'); }
        catch (e) { error = error || e.message; } finally { win.clearTimeout(timer); }
      }
      restore();
      if (started && !closing && !error && !failed && monitor && !monitor.issue && outcome && outcome.complete) {
        try { cleanup = runtime.cleanup(reference, store); } catch (e) { error = e.message; }
      }
      if (monitor && !closing) await sleep(350);
      if (monitor && !closing) {
        const deadline = now() + 5000;
        while (monitor.lastSample && monitor.lastSample.processes.some(p => !['renderer', 'observer', 'observer-child'].includes(p.role)) && !monitor.issue && now() < deadline) await sleep(100);
      }
      if (monitor) observed = await monitor.stop();
      if (closing) return;
      if (!store || !reservation) { if (store) store.close(); finished = true; message('未开始：' + error, true); return; }
      try {
        if (trace) trace.flush();
        const nativeTrend = resource._test.trends(nativeRows), traceState = trace && trace.summary();
        const nativeRelease = releaseObservation(observed), released = nativeRelease.status === 'released';
        const complete = !!(outcome && outcome.complete && !error && !failed && observed && !observed.issue && !observed.observer.stopReasons.length && observed.observer.samples >= 39000 && released && cleanup && cleanup.removed && traceState && !traceState.pendingEvents);
        const passed = complete && outcome.resourceGatePassed && nativeTrend.passed;
        const receipt = store.save('host', { schema: 'mvp-stability-summary-v1', runId: reservation.runId, reference, profile: owner && owner.profile,
          complete, passed, error: error || failed && failed.message || observed && observed.issue, sourceHashes: prepared && prepared.marker.sourceHashes,
          sources: owner && owner.sources, workload: outcome && outcome.summary, observer: observed && observed.observer, nativeTrend,
          trace: traceState, nativeGroupReleased: released, nativeRelease, cleanup, userObservations: 'not-recorded', overallT2Accepted: false, overallT4Accepted: false,
          limitations: ['Two different approved two-source sets require two independent launches; one run cannot close P04.',
            'Native scope/phase context is sampled at renderer receipt, not the exact native counter read; 100ms samples may miss peaks.',
            'The same production player runs in Eagle with test-only fixed SDK snapshots and a copied 240MiB disk runtime; real Eagle selection and normal cache are unchanged.',
            'Not foreground P01/P02, physical screen/audio, shared Eagle/GPU or forced Eagle exit evidence.'] });
        if (started) runtime.mark(reference, 'finished.json', { receipt, complete, passed });
        finished = true; message(passed ? '本轮65分钟已完成，记录已保存。请关闭窗口。' : '本轮未通过，记录已保存：' + (error || failed && failed.message || observed && observed.issue || '趋势/完整性条件未满足'), !passed);
      } catch (e) { finished = true; message('长期记录/清理未完成：' + e.message + '；现场保留。', true); }
      finally { store.close(); }
    }
  }
  return Object.freeze({ cancel, status: () => ({ started, closing, finished, failed: failed && failed.message }) });
}
module.exports = { install, _test: { releaseObservation } };
