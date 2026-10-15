'use strict';

// Started by the independent real-Eagle verification entry. This driver
// observes the product and dispatches ordinary DOM gestures; it is never loaded
// by the product and never resets media caches or writes Eagle metadata.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const protocol = require('./t0-protocol.cjs'), gate = require('./t0-gate.cjs');
const frameIndex = require('../../plugin/frame-index.cjs');
const { OWNER, RECIPE } = require('../../plugin/cache.cjs');
const { createStore, LIMITS: EVIDENCE_LIMITS } = require('./t2-evidence.cjs');
const MIB = 1024 ** 2, RESERVE = 3 * MIB;
const VERSION = 'window-formal-dom-regression-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function unsavedEvidenceJSON(summary, failure) {
  const persistenceError = { stage: failure.stage, code: failure.error.code || 'HOST_EVIDENCE_SAVE_FAILED',
    message: String(failure.error.message || failure.error).slice(0, 1024) };
  const trace = summary.interruptedTrace || null;
  const base = { ...summary, complete: false, earlyRegressionPassed: false, persisted: false, persistenceError,
    traceRetention: { complete: !trace || !trace.truncated, location: trace ? 'unsaved-memory' : 'saved-round-receipts' } };
  let json = JSON.stringify(base);
  if (Buffer.byteLength(json) <= EVIDENCE_LIMITS.fileBytes) return json;
  // Keep the entire trace before optional environment and duplicated summaries.
  const minimal = { schema: VERSION, stage: summary.stage || 'T2', origin: summary.origin, type: 'unsaved-summary', complete: false,
    earlyRegressionPassed: false, persisted: false, error: summary.error || null, persistenceError,
    source: summary.source, pluginRoot: summary.pluginRoot, receipts: summary.receipts, cleanup: summary.cleanup,
    resourceStop: summary.resourceStop, existingP03: summary.existingP03, interruptedTrace: trace,
    traceRetention: base.traceRetention, omittedContext: 'Optional summary context exceeded the 2MiB in-memory fallback limit.' };
  json = JSON.stringify(minimal);
  if (Buffer.byteLength(json) <= EVIDENCE_LIMITS.fileBytes) return json;
  minimal.interruptedTrace = null;
  minimal.traceRetention = { complete: false, location: 'unavailable',
    reason: 'The complete trace cannot fit the 2MiB fallback; it was not truncated or reported as passed.',
    encodedBytes: trace ? Buffer.byteLength(JSON.stringify(trace)) : 0,
    rawBytes: trace && trace.rawBytes, rawSha256: trace && trace.rawSha256, compressedBytes: trace && trace.compressedBytes };
  json = JSON.stringify(minimal);
  if (Buffer.byteLength(json) <= EVIDENCE_LIMITS.fileBytes) return json;
  // Defensive bound even if unexpected context, rather than a trace, is huge.
  return JSON.stringify({ schema: VERSION, stage: summary.stage || 'T2', type: 'unsaved-summary', complete: false, earlyRegressionPassed: false,
    persisted: false, persistenceError, traceRetention: minimal.traceRetention,
    omittedContext: 'The remaining context also exceeded 2MiB and cannot be retained completely.' });
}
function fingerprints(pluginRoot, extra = []) {
  if (!Array.isArray(extra) || extra.some(n => !['task-client.cjs', 'task-worker.cjs', 'native/task-host.cs', 'native/task-host.local.exe'].includes(n)))
    throw new Error('Unknown extra runtime fingerprint.');
  const sources = {};
  for (const file of ['manifest.json', 'app.js', 'ui.js', 'styles.css', 'index.html', 'diagnostics.cjs', 'session.cjs', 'eagle.cjs', 'media.cjs', 'cache.cjs', 'process-identity.cjs', 'player.js', 'frame-index.cjs', 'preferences.cjs', ...extra]) {
    const absolute = path.join(pluginRoot, file), stat = fs.lstatSync(absolute, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || BigInt(stat.size) > BigInt(MIB) || !samePath(fs.realpathSync(absolute), absolute)) throw new Error('正式源码指纹路径或容量不符合边界。');
    const bytes = fs.readFileSync(absolute), after = fs.lstatSync(absolute, { bigint: true });
    if (BigInt(bytes.length) !== BigInt(stat.size) || ['dev', 'ino', 'size', 'mtimeNs', 'mtimeMs'].some(k => String(stat[k]) !== String(after[k])))
      throw new Error('正式源码指纹读取不完整或读取期间变化。');
    sources[file] = sha(bytes);
  }
  return sources;
}
function samePath(a, b) { return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b); }
function readJSON(file, maximum = 8 * MIB) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum || !samePath(fs.realpathSync(file), file)) throw new Error('宿主验证元数据路径或容量不符合边界。');
  const data = fs.readFileSync(file), after = fs.lstatSync(file);
  if (data.length !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
    throw new Error('读取宿主验证元数据期间文件发生变化。');
  return { value: JSON.parse(data.toString('utf8')), sha256: sha(data), bytes: data.length };
}
function registeredManifest(pluginRoot, snapshot) {
  if (typeof pluginRoot !== 'string' || !path.isAbsolute(pluginRoot) || /^c:/i.test(pluginRoot) || !samePath(fs.realpathSync(pluginRoot), pluginRoot))
    throw new Error('需要实际非C盘插件绝对路径。');
  const identity = snapshot && snapshot.sourceIdentity;
  if (!identity || !/^[0-9a-f]{64}$/.test(identity.sha256 || '')) throw new Error('正式视频尚无有效源身份。');
  const root = path.join(pluginRoot, 'cache'), directory = path.join(root, 'media-' + identity.sha256 + '-' + sha(Buffer.from(RECIPE)).slice(0, 12));
  for (const [dir, kind] of [[root, 'root'], [directory, 'cache']]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(dir), dir)) throw new Error('正式缓存路径不符合验证边界。');
    const marker = readJSON(path.join(dir, 'owner.json')).value;
    if (marker.schema !== 1 || marker.owner !== OWNER || marker.recipe !== RECIPE || marker.kind !== kind || !samePath(marker.root, root))
      throw new Error('正式缓存所有权不匹配，验证停止。');
  }
  const result = readJSON(path.join(directory, 'manifest.json')), info = result.value;
  if (info.schema !== 1 || info.owner !== OWNER || info.recipe !== RECIPE || !info.source || info.source.sha256 !== identity.sha256 || info.width !== 1280 || info.height !== 720)
    throw new Error('当前视频与正式缓存清单不匹配。');
  frameIndex.validateIndex(info);
  return { info, manifestSha256: result.sha256, manifestBytes: result.bytes };
}
function bindingMatches(binding, frozen) {
  return !!binding && binding.sessionEpoch === frozen.epoch && binding.libraryEpoch === frozen.libraryEpoch &&
    binding.itemId === frozen.sourceIdentity.itemId && binding.sourceSha256 === frozen.sourceIdentity.sha256;
}
function midpoint(frames, ordinal) {
  const selected = frames[ordinal];
  if (!selected) throw new Error('目标帧编号无效。');
  return selected.end > selected.time ? selected.time + (selected.end - selected.time) / 2 : selected.time;
}
function createCapture(frames, frozen) {
  const capture = new gate.Capture(frames.length <= 2000 ? frames.map(frame => frame.id) : undefined);
  const requests = new Map(); let context = null, sequence = 0, latest = null;
  const counts = { domDispatched: 0, domRejected: 0, ignoredOldPlayerEvents: 0, oldPlayerDraws: 0, outOfBandRequests: 0, identityErrors: 0 };
  function key(event) { return frozen.epoch + ':' + event.epoch + ':' + event.requestId; }
  function terminal(event, status) {
    const record = requests.get(key(event)); if (!record) return;
    capture.append({ type: 'input-end', at: event.at, inputId: record.inputId, requestId: event.requestId,
      status, reason: event.reason, error: event.error });
    record.terminal = { ...event, status }; record.resolve(record.terminal);
  }
  function accept(message) {
    if (message.type !== 'player') return;
    const wrapped = message.value;
    if (!wrapped || !bindingMatches(wrapped.binding, frozen)) {
      counts.ignoredOldPlayerEvents++; if (wrapped && wrapped.event && wrapped.event.type === 'draw') counts.oldPlayerDraws++;
      return;
    }
    const event = wrapped.event;
    if (!event || typeof event !== 'object') return;
    if (event.type === 'request' && event.phase === 'input') {
      if (!context) { counts.outOfBandRequests++; return; }
      const ordinal = frameIndex.frameAt(frames, context.targetTime), inputId = ++sequence;
      if (!Number.isFinite(event.inputAt) || event.frameOrdinal !== ordinal || event.frameId !== frames[ordinal].id || Math.abs(event.targetTime - context.targetTime) > 1e-6)
        counts.identityErrors++;
      let resolve; const done = new Promise(value => { resolve = value; });
      const record = { inputId, done, resolve, terminal: null, request: event, domKind: context.kind };
      context.record = record; requests.set(key(event), record); latest = key(event);
      capture.append({ type: 'input', at: event.inputAt, inputId, targetTime: context.targetTime, frameOrdinal: ordinal, kind: event.kind });
      capture.append({ ...event, inputId }); return;
    }
    const record = event.requestId === undefined ? null : requests.get(key(event));
    if (event.type === 'draw') {
      capture.append({ ...event, at: event.drawAt, inputId: record && record.inputId,
        stale: key(event) !== latest || !record || event.frameId !== record.request.frameId });
      terminal(event, 'drawn'); return;
    }
    if (event.type === 'superseded' || event.type === 'reused' || event.type === 'error' && event.status) {
      const status = event.status === 'disposed' ? 'cancelled' : event.status === 'error' ? 'failed' : event.status || event.type;
      terminal(event, status);
      if (['superseded', 'reused'].includes(status)) return;
    }
    capture.append({ ...event, ...(record ? { inputId: record.inputId } : {}) });
  }
  function dispatch(targetTime, kind, work) {
    if (context) throw new Error('验证输入不得重入。');
    counts.domDispatched++; const next = { targetTime, kind, record: null }; context = next;
    try { work(); } finally { context = null; }
    if (!next.record) { counts.domRejected++; throw new Error('正式时间轴未接纳本次DOM输入。'); }
    return next.record;
  }
  function summary(begin, end, kind) {
    const result = capture.summarize(begin, end, { kind, delayMs: 0 });
    result.dom = { ...counts }; result.frameIdentityMismatches = (result.frameIdentityMismatches || 0) + counts.identityErrors;
    result.valid = result.valid && !counts.identityErrors && !counts.domRejected && !counts.outOfBandRequests && !counts.oldPlayerDraws;
    if (result.normalThresholdsMet !== null) result.normalThresholdsMet = result.normalThresholdsMet && result.valid;
    return result;
  }
  return { capture, accept, dispatch, summary, counts, requests,
    settled: () => [...requests.values()].every(record => record.terminal) };
}
function run(options = {}) {
  const evidenceStage = options.evidenceStage || 'T2';
  if (!['T2', 'T4'].includes(evidenceStage) || evidenceStage === 'T4' && typeof options.createStore !== 'function')
    throw new Error('T4 requires an independent record store.');
  const { bridge, document: doc, window: win, pluginRoot } = options;
  if (!bridge || typeof bridge.snapshot !== 'function' || typeof bridge.subscribe !== 'function' || !doc || !win || typeof win.PointerEvent !== 'function')
    throw new Error('宿主验证需要只读诊断桥、document、window和实际插件目录。');
  const launchContext = options.launchContext === undefined ? null : JSON.parse(JSON.stringify(options.launchContext));
  if (launchContext && (Buffer.byteLength(JSON.stringify(launchContext)) > 16384 ||
      launchContext.kind !== 'real-Eagle-formal-code-independent-entry' || !samePath(launchContext.mappedFormalRoot, pluginRoot) ||
      typeof options.verifyLaunch !== 'function'))
    throw new Error('独立宿主入口来源无效或超过16KiB。');
  const first = bridge.snapshot();
  const rssStop = evidenceStage === 'T4'
    ? require('./mvp-resource.cjs').approvedLimits(first && first.playback && first.playback.budget && first.playback.budget.limit).pluginRssStopBytes
    : require('./ram-diagnostic.cjs').hostRssLimit(launchContext && launchContext.ramDiagnostic);
  if (launchContext && launchContext.ramDiagnostic && launchContext.ramDiagnostic.rendererRssStopBytes !== undefined &&
    launchContext.ramDiagnostic.rendererRssStopBytes !== rssStop) throw new Error('RAM对照观察停止线记录不一致。');
  const origin = launchContext && launchContext.ramDiagnostic ? 'automatic-real-Eagle-in-memory-RAM-candidate' :
    launchContext ? 'automatic-real-Eagle-independent-entry-formal-code' : 'user-started-real-Eagle-formal-window';
  if (!first || first.state !== 'paused' || !first.playback || !first.loadMetrics) throw new Error('请先等待正式视频首帧暂停就绪，再启动验证。');
  if (typeof first.pluginRoot !== 'string' || !path.isAbsolute(first.pluginRoot) || typeof pluginRoot !== 'string' || !samePath(first.pluginRoot, pluginRoot))
    throw new Error('取证目录必须与只读诊断桥提供的实际插件目录一致。');
  const { info, manifestSha256, manifestBytes } = registeredManifest(pluginRoot, first);
  const initialFingerprints = fingerprints(pluginRoot, options.extraFingerprints);
  const repo = path.dirname(path.resolve(pluginRoot)), store = (options.createStore || createStore)(repo);
  const reservation = store.start({ reserveBytes: RESERVE });
  const timeline = doc.getElementById('timeline'), hint = doc.getElementById('timeHint');
  if (!timeline || !hint) { store.close(); throw new Error('正式时间轴或时间提示缺失。'); }
  const now = () => win.performance.now(), sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const pointerId = 731, receipts = [], rounds = [], disposers = [];
  let round = null, gesture = false, recording = false, issue = null, closeForRss = false, resourceTimer = null, lastPoint = null, cleanup = null;
  let persistenceFailure = null, unsavedJSON = null, pendingRoundPayload = null;
  const fail = (message, code) => { if (!issue) { issue = new Error(message); issue.code = code || 'HOST_REGRESSION_STOPPED'; } };
  const snapshot = () => bridge.snapshot();
  function guard() {
    if (issue) throw issue;
    const current = snapshot();
    if (!current || current.epoch !== first.epoch || current.libraryEpoch !== first.libraryEpoch || !current.sourceIdentity ||
      current.sourceIdentity.itemId !== first.sourceIdentity.itemId || current.sourceIdentity.sha256 !== first.sourceIdentity.sha256)
      throw new Error('验证期间素材或会话变化，本轮停止。');
    if (!['paused', 'seeking'].includes(current.state)) throw new Error('验证期间正式播放器离开暂停/定位状态。');
    if (recording && (doc.visibilityState !== 'visible' || typeof doc.hasFocus === 'function' && !doc.hasFocus())) throw new Error('验证窗口失焦或进入后台，本轮停止。');
    if (round && round.capture.dropped) throw new Error('完整轨迹超过有界记录容量，本轮未通过。');
    return current;
  }
  let unbind;
  try { unbind = bridge.subscribe(message => { if (round) round.accept(message); }); }
  catch (error) { store.close(); throw error; }
  disposers.push(unbind);
  function listen(target, type, callback) { target.addEventListener(type, callback); disposers.push(() => target.removeEventListener(type, callback)); }
  listen(win, 'blur', () => { if (recording) fail('验证窗口失焦，本轮停止。'); });
  listen(win, 'pagehide', () => fail('正式窗口已关闭，本轮未完成。'));
  listen(win, 'resize', () => { if (recording) fail('验证窗口尺寸变化，本轮停止。'); });
  listen(doc, 'visibilitychange', () => { if (recording && doc.visibilityState !== 'visible') fail('验证窗口进入后台，本轮停止。'); });
  function pointer(type, targetTime, kind) {
    const rect = timeline.getBoundingClientRect(), x = rect.left + targetTime / info.duration * rect.width;
    const target = type === 'pointerdown' ? timeline : win;
    lastPoint = { clientX: x, clientY: rect.top + rect.height / 2 };
    const work = () => target.dispatchEvent(new win.PointerEvent(type, { pointerId, pointerType: 'mouse', button: 0,
      buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
    if (type === 'pointerdown') gesture = true;
    try { return round.dispatch((x - rect.left) / rect.width * info.duration, kind, work); }
    finally { if (type === 'pointerup') gesture = false; }
  }
  async function settled(record, timeout = protocol.PROTOCOL.releaseTimeoutMs) {
    const started = now();
    while (!record.terminal) { guard(); if (now() - started > timeout) throw new Error('定位请求超时，未将未完成请求填零。'); await sleep(5); }
    return record.terminal;
  }
  async function drained() {
    const started = now();
    while (!round.settled() || snapshot().playback.activeImageTasks || snapshot().playback.pendingTargets) {
      guard(); if (now() - started > protocol.PROTOCOL.disposeTimeoutMs) throw new Error('验证请求或图像任务未在限定时间内收尾。'); await sleep(10);
    }
  }
  function finalCheck(expected) {
    const current = snapshot(), text = hint.textContent;
    const value = current.playback;
    const format = require('../../plugin/ui.js').formatTime(info.frames[expected].time);
    return { expectedFrameId: info.frames[expected].id, snapshot: current, hint: { text, expected: format, hidden: hint.hidden },
      correct: current.state === 'paused' && value.frameId === info.frames[expected].id && !value.pendingTargets && !value.activeImageTasks && !hint.hidden && text === format };
  }
  function save(value, stage) {
    try { return store.save('host', value); }
    catch (failure) {
      const error = new Error('T2证据未保存：' + String(failure.message || failure).slice(0, 1024) + '；可调用本次任务的 unsavedEvidence() 取回有界失败记录。');
      error.code = failure.code || 'HOST_EVIDENCE_SAVE_FAILED';
      persistenceFailure = { stage, error }; throw error;
    }
  }
  async function saveRound(summary) {
    const trace = await round.capture.pack();
    pendingRoundPayload = { schema: VERSION, stage: evidenceStage, origin, launchContext, type: 'round',
      source: first.sourceIdentity, protocol: protocol.PROTOCOL, summary, trace };
    const receipt = save(pendingRoundPayload, 'round');
    receipts.push(receipt); rounds.push(summary); round = null; pendingRoundPayload = null;
  }
  async function execute() {
    let failedCapture = null, result = null;
    try {
      // Eagle can initially own focus. Measured rounds exclude the foreground wait.
      const focusStart = now();
      while (doc.visibilityState !== 'visible' || typeof doc.hasFocus === 'function' && !doc.hasFocus()) {
        if (issue) throw issue;
        if (now() - focusStart > 15000) throw new Error('15秒内未返回正式播放器前台，未开始测量。'); await sleep(100);
      }
      await sleep(1500); guard(); recording = true;
      resourceTimer = win.setInterval(() => {
        if (!round) return;
        const memory = process.memoryUsage(), current = snapshot();
        round.capture.append({ type: 'memory', at: now(), rss: memory.rss, external: memory.external, arrayBuffers: memory.arrayBuffers,
          managed: current && current.playback && current.playback.cacheBytes });
        if (memory.rss >= rssStop) { closeForRss = true; fail('测试进程内存达到'+(rssStop/1024**3)+'GB观察停止线，停止输入并保存后关闭当前测试窗口。', 'HOST_RSS_STOP'); }
      }, 100);
      for (let n = 1; n <= protocol.PROTOCOL.repeats; n++) {
        guard(); round = createCapture(info.frames, first);
        const sequence = protocol.targets(info.frames.length, Math.ceil(protocol.PROTOCOL.roundMs * protocol.PROTOCOL.inputHz / 1000));
        let lastSlot = 0, targetTime = midpoint(info.frames, sequence[0]), count = 1;
        const initial = pointer('pointerdown', targetTime, 'rapid');
        const begin = initial.request.inputAt, end = begin + protocol.PROTOCOL.roundMs;
        while (now() < end) {
          guard(); const slot = Math.min(sequence.length - 1, Math.floor((now() - begin) * protocol.PROTOCOL.inputHz / 1000));
          if (slot === lastSlot) { await sleep(1); continue; }
          lastSlot = slot; targetTime = midpoint(info.frames, sequence[slot]); pointer('pointermove', targetTime, 'rapid'); count++;
          await sleep(Math.max(1, begin + (slot + 1) * 1000 / protocol.PROTOCOL.inputHz - now()));
        }
        const release = pointer('pointerup', targetTime, 'release'); await settled(release); await drained();
        const summary = round.summary(begin, end, 'rapid'); summary.round = n; summary.actualInputSlots = count;
        summary.missedInputSlots = sequence.length - count; summary.trajectorySha256 = sha(Buffer.from(JSON.stringify(sequence)));
        summary.final = finalCheck(frameIndex.frameAt(info.frames, targetTime));
        summary.roundGateMet = summary.valid && summary.normalThresholdsMet && summary.final.correct;
        await saveRound(summary);
      }
      for (let n = 1; n <= protocol.PROTOCOL.repeats; n++) {
        guard(); round = createCapture(info.frames, first); const begin = now();
        const sequence = protocol.independentTargets(info.frames.length, protocol.PROTOCOL.randomTargets, protocol.PROTOCOL.seed + n);
        let targetTime = 0;
        for (const ordinal of sequence) {
          guard(); targetTime = midpoint(info.frames, ordinal);
          pointer('pointerdown', targetTime, 'random-press'); const release = pointer('pointerup', targetTime, 'random-release');
          await settled(release);
        }
        await drained(); const summary = round.summary(begin, now() + .001, 'independent'); summary.round = n;
        summary.randomTargetGestures = sequence.length;
        summary.randomGestureNote = 'Each DOM gesture emits a rapid press and a release request; both terminals retained. No direct Player/Session seek calls.';
        const releases = [...round.requests.values()].filter(record => record.domKind === 'random-release');
        summary.releaseToDraw = protocol.distribution(releases.filter(record => record.terminal && record.terminal.status === 'drawn')
          .map(record => record.terminal.drawAt - record.request.inputAt));
        summary.final = finalCheck(frameIndex.frameAt(info.frames, targetTime));
        summary.roundGateMet = summary.valid && releases.length === protocol.PROTOCOL.randomTargets && summary.releaseToDraw.n > 0 && summary.releaseToDraw.p95Ms <= protocol.PROTOCOL.p95Ms && summary.final.correct;
        await saveRound(summary);
      }
      guard(); // Cancellation/focus changes during the last async trace save cannot become a pass.
      result = { complete: true, earlyRegressionPassed: rounds.length === 6 && rounds.every(value => value.roundGateMet) };
    } catch (error) {
      fail(error.message, error.code);
      if (round) { try { failedCapture = pendingRoundPayload ? pendingRoundPayload.trace : await round.capture.pack(); } catch (packing) { failedCapture = { packingError: packing.message, truncated: true }; } }
      result = { complete: false, earlyRegressionPassed: false, error: { code: issue.code, message: issue.message } };
    } finally {
      recording = false;
      if (resourceTimer !== null) win.clearInterval(resourceTimer);
      // Do not leave the formal UI believing a synthetic mouse button is held.
      for (const dispose of disposers.reverse()) { try { dispose(); } catch (_) {} }
      if (gesture) {
        try {
          win.dispatchEvent(new win.PointerEvent('pointerup', { pointerId, pointerType: 'mouse', button: 0, buttons: 0, bubbles: true, ...lastPoint }));
          const started = now(); let current = snapshot();
          while (current && current.epoch === first.epoch && current.playback &&
            (current.playback.pendingTargets || current.playback.activeImageTasks) && now() - started < protocol.PROTOCOL.disposeTimeoutMs) {
            await sleep(10); current = snapshot();
          }
          cleanup = { gestureReleased: true, waitedMs: now() - started, remainingTargets: current && current.playback && current.playback.pendingTargets,
            remainingImageTasks: current && current.playback && current.playback.activeImageTasks };
        } catch (error) { cleanup = { gestureReleased: false, error: error.message }; }
        gesture = false;
      }
    }
    try {
      const sources = fingerprints(pluginRoot, options.extraFingerprints), fingerprintsUnchanged = JSON.stringify(sources) === JSON.stringify(initialFingerprints);
      if (!fingerprintsUnchanged) result = { complete: false, earlyRegressionPassed: false, error: { code: 'HOST_SOURCE_CHANGED', message: '测量期间正式源码发生变化。' } };
      let launchSourceError = null;
      if (launchContext) { try { options.verifyLaunch(); } catch (error) {
        launchSourceError = String(error.message || error).slice(0, 1024);
        result = { complete: false, earlyRegressionPassed: false, error: { code: 'HOST_ENTRY_CHANGED', message: launchSourceError } };
      } }
      const current = snapshot(), p03 = first.loadMetrics;
      const summary = { schema: VERSION, stage: evidenceStage, origin, launchContext, type: 'summary', ...result,
        launchSourcesVerifiedAtEnd: launchContext ? !launchSourceError : null,
        pluginRoot: first.pluginRoot,
        source: first.sourceIdentity, sourceMetadata: info.source, duration: info.duration, frames: info.frames.length, manifestSha256, manifestBytes,
        cleanup, sourceFingerprintsUnchanged: fingerprintsUnchanged, initialSourceFingerprints: initialFingerprints,
        environment: { versions: process.versions, pid: process.pid, cpu: os.cpus()[0] && os.cpus()[0].model, totalRamBytes: os.totalmem(),
          width: win.innerWidth, height: win.innerHeight, dpr: win.devicePixelRatio, visibility: doc.visibilityState }, sourceFingerprints: sources,
        initialSnapshot: first, finalSnapshot: current, existingP03: { ...p03, singleRecordedLoad: true,
          withinTarget: p03.reused ? null : p03.totalMs <= Math.max(5, info.duration) * 1000,
          note: 'App/session entry through audio/index/first-frame ready and synchronous UI notification; one load only. Reuse has no numeric readiness gate; independent entry provenance, when present, is recorded separately.' },
        rounds, receipts, reservation, interruptedTrace: failedCapture, resourceStop: { requested: closeForRss, thresholdBytes: rssStop,
          closeRequestedAfterReceipt: closeForRss, independentlyObservedReleased: false },
        limitations: [evidenceStage + ' six-round formal-UI regression only; not complete T2 lifecycle acceptance, not T0 full 18-round repetition or T4 full acceptance.',
          'Same loaded Player and RAM working set remain across rounds; no automatic RAM reset, reload or complete-cache deletion.',
          'Synthetic DOM pointers exercise formal UI/session/player; physical mouse feel and OS pointer capture still require user observation.',
          'Draw submissions are measured, not monitor scanout. Completed-draw P95 excludes superseded/reused requests; their counts and gaps remain.',
          'Renderer RSS is sampled at ~100ms; other Eagle/GPU processes and missed peaks are not inferred.',
          'P03 is one existing load starting at app initialize; independent entry maps SDK create.path. Not the original manifest startup. Three-first/three-reuse protocol remains separate.',
          'Disk source hashes are checked at driver start/end. The user must freshly load this candidate before attaching; hashes do not prove an older open window loaded these disk bytes.'],
        userObservations: { smoothness: 'not-recorded', audioSync: 'not-recorded', layout: 'not-recorded' } };
      if (persistenceFailure) {
        unsavedJSON = unsavedEvidenceJSON(summary, persistenceFailure);
        throw persistenceFailure.error; // No second write after a failed round save.
      }
      try { receipts.push(save(summary, 'summary')); }
      catch (error) { unsavedJSON = unsavedEvidenceJSON(summary, persistenceFailure); throw error; }
      return { ...result, receipts: receipts.slice(), p03: summary.existingP03 };
    } finally {
      try { store.close(); }
      finally { if (closeForRss) { try { win.close(); } catch (_) { console.error('观察停止线已触发，请立即手动关闭当前视频分析插件窗口。'); } } }
    }
  }
  const done = execute();
  return Object.freeze({ done, cancel() { fail('用户取消本次正式UI回归。', 'HOST_USER_CANCELLED'); }, unsavedEvidence() { return unsavedJSON; } });
}
module.exports = { run, VERSION, _test: { midpoint, bindingMatches, createCapture, registeredManifest, unsavedEvidenceJSON } };
