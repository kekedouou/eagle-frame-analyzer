(function () {
  'use strict';
  const $ = id => document.getElementById(id), now = () => performance.now();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let backend, protocol, frameIndex, root, player, info, controller, initialized = false, busy = true, testing = false, closing = false;
  let events = [], samples = [], eventBytes = 0, truncated = false, inputNumber = 0, currentInputId = null, lastRequest = null;
  let loadMetrics = null, allReports = [], lastSaved = null, runSignal = null, runController = null, lastInfo = null;
  const associations = new Map(), inputKeys = new Map();
  let resourceStopped = false, disposal = null;
  function snapshot() { return player ? player.snapshot() : { state: 'empty' }; }
  function controls() {
    const ready = !!player && !busy && !testing && ['paused', 'playing', 'seeking', 'ended'].includes(snapshot().state);
    for (const id of ['play', 'pause', 'previous', 'next', 'timeline']) $(id).disabled = !ready;
    for (const id of ['sample', 'reload', 'accuracy', 'preparation', 'performance', 'save']) $(id).disabled = busy || testing || !backend;
    $('cancel').disabled = !(busy || testing);
  }
  function emit(event) {
    if (event.type === 'request' && event.phase !== 'effective-frame') {
      const key = event.epoch + ':' + event.requestId;
      if (currentInputId !== null && !truncated) { associations.set(key, currentInputId); inputKeys.set(currentInputId, key); }
      lastRequest = { key, frameId: event.frameId };
    }
    if (event.inputId === undefined && event.requestId !== undefined) event.inputId = associations.get(event.epoch + ':' + event.requestId);
    if (event.type === 'draw') {
      if (Number.isFinite(event.drawAt)) event.at = event.drawAt;
      event.stale = !!lastRequest && (lastRequest.key !== event.epoch + ':' + event.requestId || lastRequest.frameId !== event.frameId);
    }
    if (event.type === 'input-end') { associations.delete(inputKeys.get(event.inputId)); inputKeys.delete(event.inputId); }
    const size = JSON.stringify(event).length * 2;
    if (eventBytes + size > protocol.PROTOCOL.eventBytes) { truncated = true; return; }
    eventBytes += size; events.push(event);
  }
  function resetLog() { events = []; samples = []; eventBytes = 0; truncated = false; associations.clear(); inputKeys.clear(); lastRequest = null; }
  function errorText(error) { $('error').textContent = error.message || String(error); }
  function abortCheck() { if (closing || runSignal && runSignal.aborted) { const error = new Error('当前测试已停止'); error.name = 'AbortError'; throw error; } }
  function timeout(promise, ms, name) {
    let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + '超时')), ms); })]).finally(() => clearTimeout(timer));
  }
  function environment() {
    const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
    const files = ['plugin/player.js', 'plugin/frame-index.cjs', 'tests/host/t0/app.js', 'tests/support/t0-protocol.cjs', 'tests/support/t0-media.cjs', 'tests/support/t0-reference.cjs'];
    return { node: process.versions.node, chrome: process.versions.chrome || null, electron: process.versions.electron || null,
      platform: process.platform, windows: os.release(), cpu: os.cpus()[0].model, ramBytes: os.totalmem(), processId: process.pid,
      eagle: typeof eagle !== 'undefined' && eagle.app ? { version: eagle.app.version, build: eagle.app.build } : null,
      cacheRoot: backend.CACHE_ROOT, hostRoot: root, displayRefreshHzUserDeclared: Number($('refresh').value), window: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      sourceFingerprints: files.map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, '../../..', file))).digest('hex') })),
      backgroundLoad: 'not automatically measured; user keeps window foreground and avoids other heavy work',
      resourceScope: 'renderer process RSS only; not whole Eagle/GPU aggregate; separate FFmpeg metrics in prepared info' };
  }
  async function save(kind, extra = {}) {
    const savedInfo = info || lastInfo;
    lastSaved = await backend.saveEvidence(kind, { schema: 'eva-t0-host-v1', origin: 'actual-eagle-window', executor: 'user-started-automatic-protocol',
      savedAt: new Date().toISOString(), environment: environment(), protocol: protocol.PROTOCOL, source: savedInfo && savedInfo.source,
      preparation: savedInfo && { metrics: savedInfo.metrics, audio: savedInfo.audio, frames: savedInfo.frames.length, duration: savedInfo.duration },
      loadMetrics, snapshot: snapshot(), events, memorySamples: samples, truncated, ...extra });
    $('details').textContent = `证据已保存：${lastSaved}\n${JSON.stringify(extra.summary || extra.result || loadMetrics, null, 2)}`;
    return lastSaved;
  }
  async function dispose() {
    if (!disposal && player) {
      const ownedPlayer = player, ownedInfo = info; player = null;
      const ownedDisposal = { player: ownedPlayer, promise: null }; disposal = ownedDisposal;
      ownedDisposal.promise = Promise.resolve().then(() => ownedPlayer.dispose()).then(async () => {
        if (ownedInfo) await backend.release(ownedInfo);
        if (info === ownedInfo) info = null;
        if (disposal === ownedDisposal) disposal = null;
      });
    }
    // A timeout never releases a lease. Future loads await the same real work.
    if (disposal) await timeout(disposal.promise, protocol.PROTOCOL.disposeTimeoutMs, '播放器退出');
    else if (info) { await backend.release(info); info = null; }
  }
  async function load(key, options = {}) {
    const started = options.startedAt === undefined ? now() : options.startedAt;
    if (resourceStopped) throw new Error('资源停止线已触发，请关闭测试窗口并检查记录');
    busy = true; controls(); $('error').textContent = '';
    const stop = () => controller && controller.abort();
    try {
      await dispose(); resetLog();
      if (options.fresh) await backend.cleanup(key);
      const loadController = new AbortController(); controller = loadController;
      if (runSignal && runSignal.aborted) controller.abort();
      if (runSignal) runSignal.addEventListener('abort', stop, { once: true });
      const backendBegin = now();
      const guardLoad = () => { abortCheck(); if (loadController.signal.aborted) { const error = new Error('载入已取消'); error.name = 'AbortError'; throw error; } };
      info = await backend.prepare(key, { signal: loadController.signal, onProgress: p => { $('status').textContent = typeof p === 'string' ? p : JSON.stringify(p); } }); lastInfo = info;
      const backendEnd = now(); guardLoad();
      const ownedInfo = info;
      player = new window.EVAPlayer.Player({ canvas: $('picture'), frameIndex, readAsset: (_snapshot, file) => backend.readAsset(ownedInfo, file), emit });
      player.setVerifyMarkers(!!info.expected);
      await player.load(info); guardLoad();
      loadMetrics = { key, trigger: options.fresh ? 'fresh' : 'load-or-reuse', entryAt: started, readyAt: now(), callToReadyMs: now() - started,
        priorReleaseCleanupAndEntryMs: backendBegin - started, backendCallMs: backendEnd - backendBegin, browserReadyMs: now() - backendEnd,
        reused: !!info.metrics.reused, limitMs: info.duration < 5 ? 5000 : info.duration * 1000,
        measuredEnd: 'complete cache + audio/image init + first draw + paused and controls can be enabled', physicalPresentationMs: null };
      loadMetrics.withinTarget = loadMetrics.callToReadyMs <= loadMetrics.limitMs;
      $('timeline').max = info.duration; $('timeline').value = 0;
      $('status').textContent = '已就绪，首帧暂停';
      $('details').textContent = JSON.stringify({ loadMetrics, source: info.source, audio: info.audio, frames: info.frames.length }, null, 2);
    } finally { if (runSignal) runSignal.removeEventListener('abort', stop); controller = null; busy = false; controls(); }
  }
  function target(time, kind, final, index) {
    const inputAt = now(), inputId = ++inputNumber;
    emit({ type: 'input', at: inputAt, inputAt, inputId, kind, targetTime: time, frameOrdinal: index });
    currentInputId = inputId;
    let promise;
    try { promise = player.seek(time, { kind, final, inputAt, index }); }
    catch (error) { promise = Promise.reject(error); }
    finally { currentInputId = null; }
    return Promise.resolve(promise).then(result => {
      const status = result.status === 'error' ? 'failed' : result.status === 'disposed' ? 'cancelled' : result.status;
      emit({ type: 'input-end', at: now(), inputId, status, requestId: result.requestId, reason: result.reason }); return result;
    }, error => { emit({ type: 'input-end', at: now(), inputId, status: 'failed', error: error.message }); throw error; });
  }
  async function task(name, work) {
    if (busy || testing) return;
    testing = true; const cancel = new AbortController(); runController = cancel; runSignal = cancel.signal; controls();
    try { await work(); }
    catch (error) {
      errorText(error); const failedSnapshot = snapshot(); let disposeError = null;
      try { await dispose(); } catch (failure) { disposeError = failure.message; }
      await save('host-failed', { failedTask: name, failedSnapshot, disposeError, error: { name: error.name, message: error.message } }).catch(errorText);
    }
    finally { runSignal = null; runController = null; controller = null; testing = false; controls(); }
  }
  async function runRound(delayMs, round) {
    const key = $('sample').value;
    await load(key); player.setVerifyMarkers(false); player.setDecodeDelay(delayMs); resetLog();
    const initialSnapshot = snapshot(), begin = now(), end = begin + protocol.PROTOCOL.roundMs;
    const sequence = protocol.targets(info.frames.length, Math.ceil(protocol.PROTOCOL.roundMs * protocol.PROTOCOL.inputHz / 1000));
    let n = 0;
    while (now() < end) {
      abortCheck(); const index = sequence[Math.min(n, sequence.length - 1)];
      target(info.frames[index].time, 'rapid', false, index).catch(errorText); n++;
      // No catch-up burst: missed timer slots remain visible as actual input spacing.
      await sleep(Math.max(1, begin + n * 1000 / protocol.PROTOCOL.inputHz - now()));
    }
    const finalIndex = sequence[(n - 1) % sequence.length], finalAt = now();
    const result = await timeout(target(info.frames[finalIndex].time, 'release', true, finalIndex), protocol.PROTOCOL.releaseTimeoutMs, '释放定位');
    const drainAt = now();
    await timeout((async () => { while (snapshot().activeImageTasks > 0) { abortCheck(); await sleep(10); } })(), protocol.PROTOCOL.disposeTimeoutMs, '轮末图像任务收尾');
    const summary = protocol.summarize(events, begin, end, { kind: 'rapid', delayMs, truncated });
    summary.round = round; summary.final = { expectedFrameId: info.frames[finalIndex].id, result,
      releaseToDrawMs: Number.isFinite(result.drawAt) ? result.drawAt - finalAt : null, postReleaseObservationMs: now() - finalAt,
      drainMs: now() - drainAt, activeImageTasksAfterDrain: snapshot().activeImageTasks,
      snapshot: snapshot(), correct: snapshot().frameId === info.frames[finalIndex].id && snapshot().state === 'paused' && snapshot().activeImageTasks === 0 };
    summary.initialSnapshot = initialSnapshot;
    summary.cacheCondition = 'new Player/RAM ledger; existing validated disk cache, first frame + limited neighbour preload, Windows file cache not flushed';
    summary.distinctTargetOrdinals = new Set(events.filter(e => e.type === 'input' && e.kind === 'rapid').map(e => e.frameOrdinal)).size;
    summary.roundGateMet = delayMs ? null : summary.normalThresholdsMet && summary.final.correct;
    allReports.push(summary); await save('host-rapid', { summary }); abortCheck();
  }
  async function performanceTest() {
    if ($('sample').value !== 'baseline') throw new Error('完整性能协议请使用已登记的4K/60fps基线样本');
    allReports = [];
    for (const delay of [0, 25, 60]) for (let round = 1; round <= 3; round++) await runRound(delay, round);
    for (let round = 1; round <= 3; round++) {
      await load('baseline'); player.setVerifyMarkers(false); resetLog();
      const begin = now();
      for (const index of protocol.independentTargets(info.frames.length, 200, protocol.PROTOCOL.seed + round)) {
        abortCheck(); await timeout(target(info.frames[index].time, 'random-seek', true, index), protocol.PROTOCOL.releaseTimeoutMs, '随机定位');
      }
      const summary = protocol.summarize(events, begin, now() + .001, { kind: 'independent', truncated });
      summary.round = round; allReports.push(summary); await save('host-random', { summary });
    }
    await save('host-protocol-summary', { reports: allReports });
  }
  async function accuracyTest() {
    for (const key of ['h264-cfr', 'hevc-vfr', 'vp9-silent']) {
      $('sample').value = key; await load(key); player.setVerifyMarkers(true);
      for (let index = 1; index < info.frames.length; index++) {
        abortCheck(); await timeout(target(info.frames[index].time, 'accuracy-frame', true, index), protocol.PROTOCOL.releaseTimeoutMs, '帧核对');
      }
      const draws = events.filter(e => e.type === 'draw'), errors = draws.filter(e => !e.barcode || e.barcode.ok !== true);
      await save('host-accuracy', { result: { expectedFrames: info.expected.barcodes.length, checkedDraws: draws.length,
        errors, passed: !truncated && errors.length === 0 && draws.length === info.frames.length,
        note: '已显示首帧如复用会单列；不制造重复draw补数量' } });
    }
  }
  async function preparationTest() {
    const result = [];
    for (let round = 1; round <= 3; round++) {
      await load('baseline', { fresh: true }); result.push({ ...loadMetrics, round }); await save('host-first-ready', { result: loadMetrics });
      await load('baseline'); result.push({ ...loadMetrics, round }); await save('host-reuse-ready', { result: loadMetrics });
    }
    await save('host-ready-summary', { result });
  }
  async function initialize(plugin) {
    const entryAt = now(); if (initialized) return; initialized = true;
    try {
      const fs = require('fs'), path = require('path');
      if (!plugin || !path.isAbsolute(plugin.path)) throw new Error('需要 Eagle plugin.path，请加载本目录manifest');
      root = fs.realpathSync(plugin.path);
      backend = require(path.join(root, '../../support/t0-media.cjs'));
      if (fs.realpathSync(backend.HOST_ROOT).toLowerCase() !== root.toLowerCase()) throw new Error('测试插件实际目录不符');
      protocol = require(path.join(root, '../../support/t0-protocol.cjs'));
      frameIndex = require(path.join(root, '../../../plugin/frame-index.cjs'));
      for (const item of await backend.listSources()) { const option = document.createElement('option'); option.value = item.key; option.textContent = item.label; $('sample').append(option); }
      $('sample').value = 'baseline';
      await load('baseline', { startedAt: entryAt }); await save('host-initial-ready');
    } catch (error) { busy = false; errorText(error); controls(); }
  }
  $('sample').addEventListener('change', () => load($('sample').value).catch(errorText));
  $('reload').addEventListener('click', () => load($('sample').value).catch(errorText));
  $('cancel').addEventListener('click', () => {
    if (runController) runController.abort(); if (controller) controller.abort();
    if (player) dispose().catch(errorText);
  });
  $('play').addEventListener('click', () => player.play().catch(errorText));
  $('pause').addEventListener('click', () => player.pause());
  $('previous').addEventListener('click', () => player.step(-1).catch(errorText));
  $('next').addEventListener('click', () => player.step(1).catch(errorText));
  $('timeline').addEventListener('input', () => target(Number($('timeline').value), 'drag', false).catch(errorText));
  $('timeline').addEventListener('change', () => target(Number($('timeline').value), 'release', true).catch(errorText));
  $('performance').addEventListener('click', () => task('performance', performanceTest));
  $('accuracy').addEventListener('click', () => task('accuracy', accuracyTest));
  $('preparation').addEventListener('click', () => task('preparation', preparationTest));
  $('save').addEventListener('click', () => save('host-manual', { manual: { executor: 'user-entered-observation', drag: $('manualDrag').value,
    audioVisual: $('manualSync').value, finalAndSteps: $('manualFrames').value } }).catch(errorText));
  setInterval(() => {
    if (!player) return;
    const s = snapshot(), m = process.memoryUsage();
    $('position').textContent = `${s.state} · ${Number(s.time || 0).toFixed(4)}秒 · 源帧${s.frameId} · 在途${s.activeImageTasks}`;
    if (document.activeElement !== $('timeline')) $('timeline').value = s.time || 0;
    if (samples.length < 4000) samples.push({ at: now(), rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers, managed: s.cacheBytes });
    else truncated = true;
    if (m.rss >= 1.5 * 1024 ** 3 && !resourceStopped) {
      resourceStopped = true; if (runController) runController.abort(); if (controller) controller.abort(); player.pause();
      errorText(new Error('插件当前进程RSS达到1.5GiB观察停止线，正在退出并保留证据'));
      save('host-resource-stop', { reason: 'renderer RSS observation stop line', rss: m.rss }).catch(errorText)
        .finally(() => dispose().catch(errorText));
    }
  }, 100);
  const close = () => { closing = true; if (runController) runController.abort(); if (controller) controller.abort(); dispose().catch(errorText); };
  window.addEventListener('pagehide', close);
  if (typeof eagle !== 'undefined' && typeof eagle.onPluginCreate === 'function') {
    eagle.onPluginCreate(initialize);
    if (typeof eagle.onPluginBeforeExit === 'function') eagle.onPluginBeforeExit(close);
  } else errorText(new Error('请从 Eagle 手动加载 tests/host/t0/manifest.json，普通浏览器不能运行此测试'));
})();
