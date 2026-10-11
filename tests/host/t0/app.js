(function () {
  'use strict';
  const $ = id => document.getElementById(id), now = () => performance.now();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let backend, protocol, selection, frameIndex, manualTrace, root, player, info, controller, initialized = false, busy = true, testing = false, closing = false;
  let events = [], samples = [], eventBytes = 0, truncated = false, inputNumber = 0, currentInputId = null, lastRequest = null;
  let loadMetrics = null, allReports = [], lastSaved = null, runSignal = null, runController = null, lastInfo = null;
  const associations = new Map(), inputKeys = new Map();
  let resourceStopped = false, disposal = null;
  let eventCounts = {}, selectionEpoch = 0;
  let dependenciesReady = false, pendingSelection = null, selecting = null, selectionWork = Promise.resolve(), loadWork = Promise.resolve();
  let dragging = false, dragPointer = null, dragTarget = null, releaseSent = false, seekPending = false, manualSeekNumber = 0;
  let pointerMoves = 0, lastPointerTrace = -Infinity, dragRect = null;
  let carryIn = null;
  function snapshot() { return player ? player.snapshot() : { state: 'empty' }; }
  function uiEvent(phase, event, detail = {}) {
    if (!protocol) return;
    emit({ type: 'ui', phase, at: now(), pointerId: event && event.pointerId, buttons: event && event.buttons,
      clientX: event && event.clientX, value: Number($('timeline').value), dragging, dragPointer, seekPending,
      disabled: $('timeline').disabled, playerState: snapshot().state, pointerMoves, ...detail });
  }
  function controls() {
    const wasDisabled = $('timeline').disabled;
    const unavailable = busy || testing || !!selecting;
    const ready = !!player && !unavailable && ['paused', 'playing', 'seeking', 'ended'].includes(snapshot().state);
    for (const id of ['play', 'pause', 'previous', 'next', 'timeline']) $(id).disabled = !ready;
    for (const id of ['sample', 'selected', 'reload', 'accuracy']) $(id).disabled = unavailable || !dependenciesReady;
    $('save').disabled = !ready;
    for (const id of ['preparation', 'performance', 'retest']) $(id).disabled = unavailable || !info;
    $('cancel').disabled = !(busy || testing || selecting);
    if ($('timeline').disabled !== wasDisabled) uiEvent('enabled-change', null, { busy, testing, selecting: !!selecting });
  }
  function emit(event) {
    if (event.type === 'request' && event.phase !== 'effective-frame') {
      const key = event.epoch + ':' + event.requestId;
      if (currentInputId !== null && (!testing || !truncated)) { associations.set(key, currentInputId); inputKeys.set(currentInputId, key); }
      lastRequest = { key, frameId: event.frameId };
    }
    if (event.inputId === undefined && event.requestId !== undefined) event.inputId = associations.get(event.epoch + ':' + event.requestId);
    if (event.type === 'draw') {
      if (Number.isFinite(event.drawAt)) event.at = event.drawAt;
      event.stale = !!lastRequest && (lastRequest.key !== event.epoch + ':' + event.requestId || lastRequest.frameId !== event.frameId);
    }
    if (event.type === 'input-end') { associations.delete(inputKeys.get(event.inputId)); inputKeys.delete(event.inputId); }
    const kind = event.type + (event.phase ? ':' + event.phase : '');
    eventCounts[kind] = (eventCounts[kind] || 0) + 1;
    event = protocol.compactEvent(event);
    if (!event) return;
    if (!testing && manualTrace) { manualTrace.append(event); return; }
    const size = JSON.stringify(event).length * 2;
    if (eventBytes + size > protocol.PROTOCOL.eventBytes) { truncated = true; return; }
    eventBytes += size; events.push(event);
  }
  function resetLog() {
    events = []; samples = []; eventCounts = {}; eventBytes = 0; truncated = false; associations.clear(); inputKeys.clear(); lastRequest = null;
    if (manualTrace) manualTrace.reset(now());
    const s = snapshot(); carryIn = { at: now(), activeImageTasks: s.activeImageTasks || 0, pendingTargets: s.pendingTargets || 0,
      note: 'work already active at capture reset can complete in this tail; earlier task/request events may be outside coverage' };
  }
  function errorText(error) { $('error').textContent = error.message || String(error); }
  function abortCheck() { if (closing || runSignal && runSignal.aborted) { const error = new Error('当前测试已停止'); error.name = 'AbortError'; throw error; } }
  function timeout(promise, ms, name) {
    let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + '超时')), ms); })]).finally(() => clearTimeout(timer));
  }
  function environment() {
    const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
    const files = ['plugin/player.js', 'plugin/frame-index.cjs', 'tests/host/t0/app.js', 'tests/host/t0/index.html', 'tests/support/t0-manual-trace.cjs',
      'tests/support/t0-protocol.cjs', 'tests/support/t0-media.cjs', 'tests/support/t0-selection.cjs', 'tests/support/t0-reference.cjs'];
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
    const manualCapture = !testing && manualTrace ? manualTrace.snapshot(now()) : null;
    const capture = manualCapture || { events, memorySamples: samples, truncated,
      trace: { encoding: 'compact-v2', eventCounts, storedBytesEstimate: eventBytes,
        omitted: 'duplicate state/effective-target/terminal notifications and eviction; raw inputs, request identity, decode-ready, draw and input-end retained unless truncated',
        physicalPresentation: 'not measured; drawImage submission only; marker readback if enabled follows actual drawAt' } };
    if (manualCapture) {
      capture.trace.lifetimeEventCounts = { ...eventCounts }; capture.trace.carryIn = carryIn;
      if (carryIn && (carryIn.activeImageTasks || carryIn.pendingTargets)) capture.trace.coverage.partialChainsPossible = true;
    }
    const payload = { schema: 'eva-t0-host-v1', origin: 'actual-eagle-window', executor: 'user-started-automatic-protocol',
      savedAt: new Date().toISOString(), environment: environment(), protocol: protocol.PROTOCOL, source: savedInfo && savedInfo.source,
      preparation: savedInfo && { metrics: savedInfo.metrics, audio: savedInfo.audio, frames: savedInfo.frames.length, duration: savedInfo.duration },
      loadMetrics, snapshot: snapshot(), ...capture, ...extra };
    if (manualCapture) {
      // Reserve a small allowance for the writer's ownership envelope. This
      // never changes the aggregate quota or deletes any persisted evidence.
      const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf8') + 4096, capacity = backend.evidenceInfo();
      if (bytes > 2 * 1024 ** 2) throw new Error('本次手工诊断超过2MiB安全限额，未写文件；请保留现场并报告。');
      if (!Number.isFinite(capacity.remainingBytes) || capacity.remainingBytes < bytes)
        throw new Error('剩余证据配额不足以保存本次手工诊断；不会删旧记录或增额。');
    }
    lastSaved = await backend.saveEvidence(kind, payload);
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
  function load(key, options = {}) {
    const owned = { ...options, startedAt: options.startedAt === undefined ? now() : options.startedAt, selectionEpoch };
    // All entry points share the same real completion boundary, including
    // reload/synthetic choices interrupted by a new Eagle invocation.
    loadWork = loadWork.catch(() => {}).then(() => performLoad(key, owned));
    return loadWork;
  }
  async function performLoad(key, options) {
    const started = options.startedAt === undefined ? now() : options.startedAt;
    if (resourceStopped) throw new Error('资源停止线已触发，请关闭测试窗口并检查记录');
    busy = true; controls(); $('error').textContent = '';
    clearPointer('load-reset'); dragTarget = null; seekPending = false; manualSeekNumber++;
    const loadController = new AbortController(); controller = loadController;
    let preparedOwned = false;
    const ownedRunSignal = runSignal, stop = () => loadController.abort();
    const guardLoad = () => { abortCheck(); if (loadController.signal.aborted || options.selectionEpoch !== selectionEpoch) { const error = new Error('载入已取消'); error.name = 'AbortError'; throw error; } };
    if (ownedRunSignal && ownedRunSignal.aborted) loadController.abort();
    if (ownedRunSignal) ownedRunSignal.addEventListener('abort', stop, { once: true });
    try {
      if (options.onStage) options.onStage('previous-player-release');
      const previousInfo = info;
      guardLoad();
      loadMetrics = null;
      for (const id of ['manualDrag', 'manualSync', 'manualFrames']) $(id).value = '未检查';
      guardLoad(); await dispose(); guardLoad(); resetLog();
      if (options.fresh) {
        if (key === 'selected' && (!previousInfo || previousInfo.source.key !== 'selected' ||
          previousInfo.source.itemId !== options.selected.id || previousInfo.source.filePath !== options.selected.filePath))
          throw new Error('首次准备测试需要当前已载入的选中视频；不会清理其他视频。');
        await backend.cleanup(key === 'selected' ? previousInfo : key); guardLoad();
      }
      const backendBegin = now();
      if (options.onStage) options.onStage('media-prepare');
      info = await backend.prepare(key, { selected: options.selected, signal: loadController.signal,
        onProgress: p => { $('status').textContent = typeof p === 'string' ? p : JSON.stringify(p); } }); lastInfo = info;
      preparedOwned = true;
      const backendEnd = now(); guardLoad();
      const ownedInfo = info;
      if (options.onStage) options.onStage('player-initialize');
      player = new window.EVAPlayer.Player({ canvas: $('picture'), frameIndex, readAsset: (_snapshot, file) => backend.readAsset(ownedInfo, file), emit });
      player.setVerifyMarkers(!!info.expected);
      await player.load(info); guardLoad();
      loadMetrics = { key, trigger: options.fresh ? 'fresh' : 'load-or-reuse', entryAt: started, readyAt: now(), callToReadyMs: now() - started,
        priorReleaseCleanupAndEntryMs: backendBegin - started, backendCallMs: backendEnd - backendBegin, browserReadyMs: now() - backendEnd,
        reused: !!info.metrics.reused, limitMs: info.duration < 5 ? 5000 : info.duration * 1000,
        measuredEnd: 'complete cache + audio/image init + first draw + paused and controls can be enabled', physicalPresentationMs: null };
      loadMetrics.withinTarget = loadMetrics.callToReadyMs <= loadMetrics.limitMs;
      $('timeline').max = info.duration; $('timeline').value = 0;
      $('sample').value = key;
      for (const id of ['manualDrag', 'manualSync', 'manualFrames']) $(id).value = '未检查';
      $('error').textContent = '';
      $('status').textContent = '已就绪，首帧暂停';
      $('source').textContent = `${info.source.label || info.source.name || key} · ${info.audio ? '有音轨（是否有声请实际试听）' : '无音轨'}`;
      $('details').textContent = JSON.stringify({ loadMetrics, source: info.source, audio: info.audio, frames: info.frames.length }, null, 2);
    } catch (error) {
      if (preparedOwned) {
        try { await dispose(); } catch (failure) { error.disposeError = failure.message; }
      }
      throw error;
    } finally { if (ownedRunSignal) ownedRunSignal.removeEventListener('abort', stop); if (controller === loadController) controller = null; busy = false; controls(); }
  }
  function useSelected(trigger = 'selected-button', startedAt = now()) {
    if (closing || resourceStopped) return Promise.resolve();
    if (testing) { errorText(new Error('自动测试中不能切换视频，请先停止测试。')); return Promise.resolve(); }
    const request = { epoch: ++selectionEpoch, trigger, startedAt, diagnostics: [], attempted: null, stage: 'selection-api', captured: null };
    // Capture at the explicit run/click, before waiting for old media to exit.
    // Attach rejection handling immediately, including during initialization.
    if (selection) request.captured = Promise.resolve(selection.captureSelected(eagle, {
      onDiagnostic: value => { if (request.diagnostics.length < 8) request.diagnostics.push(value); }
    })).then(value => ({ value }), error => ({ error }));
    selecting = request;
    if (controller) controller.abort();
    controls();
    if (!dependenciesReady) { pendingSelection = request; return Promise.resolve(); }
    return queueSelection(request);
  }
  function queueSelection(request) {
    const current = () => request.epoch === selectionEpoch && !closing && !resourceStopped;
    selectionWork = selectionWork.catch(() => {}).then(async () => {
      if (!current()) return;
      busy = true; controls(); $('error').textContent = ''; $('status').textContent = '读取 Eagle 当前选择…';
      try {
        // A rejected capture still waits for interrupted media cleanup before
        // saving diagnostics; evidence and media share the bounded writer lock.
        await loadWork.catch(() => {});
        if (!current()) return;
        if (!request.captured) request.captured = Promise.resolve(selection.captureSelected(eagle, {
          onDiagnostic: value => { if (request.diagnostics.length < 8) request.diagnostics.push(value); }
        })).then(value => ({ value }), error => ({ error }));
        const result = await timeout(request.captured, 5000, '读取选中视频');
        if (!current()) return;
        if (result.error) throw result.error;
        request.attempted = result.value; request.stage = 'media-and-player-load';
        await load('selected', { selected: result.value, startedAt: request.startedAt, onStage: stage => { request.stage = stage; } });
        if (current()) await save(request.trigger === 'initialize' ? 'host-initial-ready' : 'host-selected-ready', {
          selectionAttempt: { trigger: request.trigger, stage: 'ready', attempted: request.attempted, diagnostics: request.diagnostics }
        }).catch(failure => { $('error').textContent = '视频已载入，但证据保存失败：' + failure.message; });
      } catch (error) {
        if (!current()) return;
        const attempt = { trigger: request.trigger, stage: request.stage, attempted: request.attempted,
          retainedSource: info && player ? info.source : null, diagnostics: request.diagnostics,
          error: { name: error.name, code: error.code || null, message: error.message, disposeError: error.disposeError || null } };
        $('sample').value = info && player ? info.source.key : 'selected';
        errorText(new Error(`${request.stage === 'selection-api' ? '读取当前选择失败' : '所选视频准备失败'}：${error.message}`));
        $('status').textContent = info && player ? '仍显示上次成功载入的视频' : '尚未载入视频';
        if (!player) $('source').textContent = '当前视频：没有可操作的视频';
        // No raw Eagle object, tags or comments. Old traces cannot be evidence
        // for a failed attempt to load a different source.
        await save('host-selection-failed', { source: request.attempted, preparation: null, loadMetrics: null,
          events: [], memorySamples: [], truncated: false, trace: null, selectionAttempt: attempt })
          .catch(failure => { $('error').textContent += '\n诊断保存失败：' + failure.message; });
      } finally {
        if (selecting === request) selecting = null;
        busy = false; controls();
      }
    });
    return selectionWork;
  }
  function manualSeek(time, final) {
    if (!player || busy || testing || selecting) return;
    const token = ++manualSeekNumber; seekPending = true;
    return target(time, final ? 'release' : 'drag', final).catch(errorText)
      .finally(() => { if (manualSeekNumber === token) seekPending = false; });
  }
  function releaseDrag() {
    if (releaseSent) return;
    releaseSent = true;
    return manualSeek(dragTarget === null ? Number($('timeline').value) : dragTarget, true);
  }
  function clearPointer(reason) {
    const pointer = dragPointer; dragging = false; dragPointer = null; dragRect = null;
    try { if (pointer !== null && $('timeline').hasPointerCapture(pointer)) $('timeline').releasePointerCapture(pointer); }
    catch (error) { uiEvent('capture-release-failed', null, { error: error.message }); }
    uiEvent(reason);
  }
  function endPointer(event, reason = 'pointer-end') {
    if (!dragging || event && event.pointerId !== undefined && dragPointer !== event.pointerId) return;
    // Up may contain a final coordinate without a preceding move. Cancel/blur
    // retain the last known target instead of treating cancellation as motion.
    if (event && ['pointerup', 'buttons-released'].includes(reason)) pointerTarget(event, false);
    const result = releaseDrag(); clearPointer(reason);
    return result;
  }
  function pointerTarget(event, seek = true) {
    if (!Number.isFinite(event.clientX)) return;
    const range = $('timeline'), rect = dragRect || range.getBoundingClientRect();
    // The 16px thumb is fixed in the test page CSS. Its centre travels within
    // the track, including exact first/last positions and out-of-track drags.
    if (!Number.isFinite(rect.width) || rect.width <= 16) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - 8) / (rect.width - 16)));
    const minimum = Number(range.min || 0), maximum = Number(range.max);
    if (!Number.isFinite(maximum) || maximum < minimum) return;
    dragTarget = minimum + ratio * (maximum - minimum); range.value = dragTarget; releaseSent = false;
    if (seek) return manualSeek(dragTarget, false);
  }
  function syncTimeline(reason) {
    if (!player || dragging || seekPending) return;
    $('timeline').value = snapshot().time || 0; uiEvent('value-sync', null, { reason });
  }
  async function command(name, work) {
    const input = manualSeekNumber;
    try { await work(); if (input === manualSeekNumber) syncTimeline(name); }
    catch (error) { errorText(error); }
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
  async function task(name, work, preflight) {
    if (busy || testing || selecting) return;
    // Refusing a test must not dispose the current player or erase unsaved
    // manual diagnostics. Check capacity before changing recording modes.
    if (preflight) {
      try { preflight(); }
      catch (error) { errorText(error); uiEvent('preflight-rejected', null, { task: name, error: error.message }); return; }
    }
    testing = true; const cancel = new AbortController(); runController = cancel; runSignal = cancel.signal; controls();
    try { await work(); }
    catch (error) {
      errorText(error); const failedSnapshot = snapshot(); let disposeError = null;
      try { await dispose(); } catch (failure) { disposeError = failure.message; }
      await save('host-failed', { failedTask: name, failedSnapshot, disposeError, error: { name: error.name, message: error.message } }).catch(errorText);
    }
    finally { runSignal = null; runController = null; controller = null; testing = false; resetLog(); controls(); }
  }
  function testSource() {
    if (!info || !player) throw new Error('请先成功载入要测试的视频。');
    return { key: info.source.key, selected: info.source.key === 'selected' ? selection.validateSnapshot(info.source) : null,
      fingerprint: info.source.sha256, identity: info.source.itemId || null };
  }
  async function loadTestSource(source, fresh = false) {
    await load(source.key, { selected: source.selected, fresh });
    if (info.source.sha256 !== source.fingerprint || (info.source.itemId || null) !== source.identity)
      throw new Error('测试视频内容或身份发生变化，本轮结果无效。');
  }
  async function runRound(delayMs, round, source) {
    await loadTestSource(source); player.setVerifyMarkers(false); player.setDecodeDelay(delayMs); resetLog();
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
  function performancePreflight(normalOnly) {
    testSource();
    const required = (normalOnly ? 40 : 100) * 1024 ** 2, capacity = backend.evidenceInfo();
    if (!Number.isFinite(capacity.remainingBytes) || capacity.remainingBytes < required)
      throw new Error(`剩余证据配额不足：本次至少预留${normalOnly ? 40 : 100}MiB。当前播放器和未保存观察保留；不要删除旧记录或重复协议。`);
  }
  async function performanceTest(normalOnly = false) {
    const source = testSource();
    allReports = [];
    for (const delay of normalOnly ? [0] : [0, 25, 60]) for (let round = 1; round <= 3; round++) await runRound(delay, round, source);
    for (let round = 1; round <= 3; round++) {
      await loadTestSource(source); player.setVerifyMarkers(false); resetLog();
      const begin = now();
      for (const index of protocol.independentTargets(info.frames.length, 200, protocol.PROTOCOL.seed + round)) {
        abortCheck(); await timeout(target(info.frames[index].time, 'random-seek', true, index), protocol.PROTOCOL.releaseTimeoutMs, '随机定位');
      }
      const summary = protocol.summarize(events, begin, now() + .001, { kind: 'independent', truncated });
      summary.round = round; allReports.push(summary); await save('host-random', { summary });
    }
    resetLog(); await save('host-protocol-summary', { scope: normalOnly ? 'normal-3-rounds-and-random-3-rounds' : 'complete-normal-and-pressure-and-random',
      sampleBinding: source, comparison: 'Only compare identical source fingerprints and conditions; another source does not complete old baseline or 4K/60fps coverage.', reports: allReports });
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
    const result = [], source = testSource();
    for (let round = 1; round <= 3; round++) {
      await loadTestSource(source, true); result.push({ ...loadMetrics, round }); await save('host-first-ready', { result: loadMetrics });
      await loadTestSource(source); result.push({ ...loadMetrics, round }); await save('host-reuse-ready', { result: loadMetrics });
    }
    await save('host-ready-summary', { result });
  }
  async function initialize(plugin) {
    const entryAt = now(), entryEpoch = selectionEpoch; if (initialized) return; initialized = true;
    controls();
    try {
      const fs = require('fs'), path = require('path');
      if (!plugin || !path.isAbsolute(plugin.path)) throw new Error('需要 Eagle plugin.path，请加载本目录manifest');
      root = fs.realpathSync(plugin.path);
      backend = require(path.join(root, '../../support/t0-media.cjs'));
      if (fs.realpathSync(backend.HOST_ROOT).toLowerCase() !== root.toLowerCase()) throw new Error('测试插件实际目录不符');
      protocol = require(path.join(root, '../../support/t0-protocol.cjs'));
      manualTrace = new (require(path.join(root, '../../support/t0-manual-trace.cjs')).ManualTrace)(); manualTrace.reset(now());
      selection = require(path.join(root, '../../support/t0-selection.cjs'));
      frameIndex = require(path.join(root, '../../../plugin/frame-index.cjs'));
      for (const item of await backend.listSources()) {
        if (item.key === 'baseline') continue; // Historical input stays available to read-only CLI comparisons only.
        const option = document.createElement('option'); option.value = item.key; option.textContent = item.label; $('sample').append(option);
      }
      dependenciesReady = true; busy = false; $('sample').value = 'selected';
      if (closing || resourceStopped) return;
      if (pendingSelection && pendingSelection.epoch === selectionEpoch) {
        const request = pendingSelection; pendingSelection = null; await queueSelection(request);
      } else if (entryEpoch === selectionEpoch) await useSelected('initialize', entryAt);
      else controls(); // A stop during dependency initialization cancels startup too.
    } catch (error) { selecting = null; busy = false; errorText(error); controls(); }
  }
  $('sample').addEventListener('change', () => $('sample').value === 'selected' ? useSelected('sample-choice') : load($('sample').value).catch(errorText));
  $('selected').addEventListener('click', () => useSelected('selected-button'));
  $('reload').addEventListener('click', () => info && player ? load(info.source.key, {
    selected: info.source.key === 'selected' ? selection.validateSnapshot(info.source) : null
  }).catch(errorText) : useSelected('reload-empty'));
  $('cancel').addEventListener('click', () => {
    selectionEpoch++;
    selecting = null; pendingSelection = null;
    clearPointer('cancel');
    if (runController) runController.abort(); if (controller) controller.abort();
    if (player) dispose().catch(errorText);
  });
  $('play').addEventListener('click', () => command('play', () => player.play()));
  $('pause').addEventListener('click', () => command('pause', () => player.pause()));
  $('previous').addEventListener('click', () => command('previous', () => player.step(-1)));
  $('next').addEventListener('click', () => command('next', () => player.step(1)));
  $('timeline').addEventListener('pointerdown', event => {
    if ($('timeline').disabled || event.button !== undefined && event.button !== 0) return;
    if (dragging && event.pointerId !== dragPointer) return;
    // Own the gesture instead of letting native range dragging and polling
    // compete. Keyboard input remains native and follows input/change below.
    if (event.preventDefault) event.preventDefault();
    dragging = true; dragPointer = event.pointerId; dragTarget = null; releaseSent = false;
    dragRect = $('timeline').getBoundingClientRect();
    $('timeline').focus({ preventScroll: true });
    try { $('timeline').setPointerCapture(dragPointer); }
    catch (error) { uiEvent('capture-failed', event, { error: error.message }); }
    uiEvent('pointerdown', event, { trackLeft: dragRect.left, trackWidth: dragRect.width }); return pointerTarget(event);
  });
  $('timeline').addEventListener('input', () => {
    dragTarget = Number($('timeline').value); releaseSent = false;
    uiEvent('native-input');
    return manualSeek(dragTarget, false);
  });
  $('timeline').addEventListener('change', releaseDrag);
  $('timeline').addEventListener('lostpointercapture', event => {
    // Capture can be lost before the physical button is released. Retain the
    // owner and use window moves; only a real up/cancel/blur ends the gesture.
    uiEvent('lostpointercapture', event);
  });
  window.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== dragPointer) return;
    if (event.buttons !== undefined && (event.buttons & 1) === 0) return endPointer(event, 'buttons-released');
    pointerMoves++;
    if (now() - lastPointerTrace >= 250) { lastPointerTrace = now(); uiEvent('pointermove', event); }
    return pointerTarget(event);
  });
  $('timeline').addEventListener('pointercancel', event => endPointer(event, 'pointercancel'));
  window.addEventListener('pointerup', event => endPointer(event, 'pointerup'));
  window.addEventListener('pointercancel', event => endPointer(event, 'pointercancel'));
  window.addEventListener('blur', () => { uiEvent('blur'); return endPointer(null, 'blur-end'); });
  window.addEventListener('focus', () => uiEvent('focus'));
  window.addEventListener('resize', () => {
    if (dragging) { dragRect = $('timeline').getBoundingClientRect(); uiEvent('track-resize', null, { trackLeft: dragRect.left, trackWidth: dragRect.width }); }
  });
  $('performance').addEventListener('click', () => task('performance', () => performanceTest(false), () => performancePreflight(false)));
  $('retest').addEventListener('click', () => task('normal-retest', () => performanceTest(true), () => performancePreflight(true)));
  $('accuracy').addEventListener('click', () => task('accuracy', accuracyTest));
  $('preparation').addEventListener('click', () => task('preparation', preparationTest));
  $('save').addEventListener('click', () => {
    if (!player || busy || testing || selecting) return;
    return save('host-manual', { manual: { executor: 'user-entered-observation', drag: $('manualDrag').value,
      audioVisual: $('manualSync').value, finalAndSteps: $('manualFrames').value } }).catch(errorText);
  });
  setInterval(() => {
    if (!player) return;
    const s = snapshot(), m = process.memoryUsage();
    $('position').textContent = `${s.state} · ${Number(s.time || 0).toFixed(4)}秒 · 源帧${s.frameId} · 在途${s.activeImageTasks}`;
    // A paused frame time is quantized to the source frame boundary. It must
    // never push a user-requested thumb value backwards every 100ms.
    if (s.state === 'playing' && !dragging && !seekPending) syncTimeline('playback-clock');
    const memory = { at: now(), rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers, managed: s.cacheBytes };
    if (!testing && manualTrace) manualTrace.sample(memory);
    else if (samples.length < 4000) samples.push(memory);
    else truncated = true;
    if (m.rss >= 1.5 * 1024 ** 3 && !resourceStopped) {
      resourceStopped = true; if (runController) runController.abort(); if (controller) controller.abort(); player.pause();
      errorText(new Error('插件当前进程RSS达到1.5GiB观察停止线，正在退出并保留证据'));
      save('host-resource-stop', { reason: 'renderer RSS observation stop line', rss: m.rss }).catch(errorText)
        .finally(() => dispose().catch(errorText));
    }
  }, 100);
  const close = () => { closing = true; clearPointer('close'); selectionEpoch++; selecting = null; pendingSelection = null; if (runController) runController.abort(); if (controller) controller.abort(); dispose().catch(errorText); };
  window.addEventListener('pagehide', close);
  if (typeof eagle !== 'undefined' && typeof eagle.onPluginCreate === 'function') {
    eagle.onPluginCreate(initialize);
    if (typeof eagle.onPluginRun === 'function') eagle.onPluginRun(() => {
      return useSelected('plugin-run');
    });
    if (typeof eagle.onPluginBeforeExit === 'function') eagle.onPluginBeforeExit(close);
  } else errorText(new Error('请从 Eagle 手动加载 tests/host/t0/manifest.json，普通浏览器不能运行此测试'));
})();
