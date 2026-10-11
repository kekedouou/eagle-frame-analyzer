'use strict';

// Coordinates one material at a time. No Eagle calls, filesystem or UI access.
const path = require('path');
function issue(code, message) { const error = new Error(message); error.code = code; return error; }
function createSession(options) {
  const { eagleAdapter, media, cache, createPlayer } = options || {};
  if (!eagleAdapter || typeof eagleAdapter.captureSelected !== 'function' || !media || typeof media.prepare !== 'function' ||
    !cache || typeof cache.readAsset !== 'function' || typeof cache.release !== 'function' || typeof createPlayer !== 'function')
    throw new Error('会话缺少素材、媒体、缓存或播放器接口。');
  const now = options.now || (() => typeof performance === 'object' ? performance.now() : Date.now());
  const onChange = options.onChange || (() => {});
  let epoch = 0, libraryEpoch = 0, closed = false, tail = Promise.resolve(), controller = null, owner = null;
  let state = 'empty', source = null, duration = 0, playback = null, error = null, progress = null, loadMetrics = null;
  function snapshot() {
    return Object.freeze({ state, epoch, libraryEpoch, source, duration,
      sourceIdentity: source ? Object.freeze({ libraryEpoch, itemId: source.id, filePath: source.filePath, sha256: source.sha256 || null }) : null,
      playback: playback ? { ...playback, frame: playback.frameId, time: playback.time } : null,
      error: error ? { ...error } : null, progress: progress ? { ...progress } : null,
      loadMetrics: loadMetrics ? { ...loadMetrics } : null });
  }
  function notify() { try { onChange(snapshot()); } catch (_) { /* UI observation does not own session state. */ } }
  function current(request) { return !closed && request.epoch === epoch && !request.controller.signal.aborted; }
  function describe(failure, fallback) { return { code: failure && failure.code || fallback,
    message: String(failure && failure.message || failure || '未知错误').slice(0, 1024) }; }
  function startDispose(owned) {
    if (!owned || !owned.player || owned.dispose) return;
    // Player.dispose invalidates its own draw/audio tokens synchronously, then
    // waits for real decoders. A cache handle stays leased throughout that wait.
    try { owned.dispose = Promise.resolve(owned.player.dispose()); }
    catch (failure) { owned.dispose = Promise.reject(failure); }
    owned.dispose.catch(() => {});
  }
  async function releaseOwner(owned = owner) {
    if (!owned) return;
    startDispose(owned);
    if (owned.dispose) await owned.dispose;
    if (owned.info && !owned.released) { await cache.release(owned.info); owned.released = true; }
    if (owner === owned) owner = null;
  }
  function invalidate() {
    const token = ++epoch, previous = controller; controller = null;
    if (previous) previous.abort(); startDispose(owner);
    return token;
  }
  function enqueue(work) { const next = tail.catch(() => {}).then(work); tail = next.catch(() => {}); return next; }
  function waitCaptured(captured, signal) {
    if (signal.aborted) return Promise.resolve({ aborted: true });
    return new Promise(resolve => {
      const aborted = () => { signal.removeEventListener('abort', aborted); resolve({ aborted: true }); };
      signal.addEventListener('abort', aborted, { once: true });
      captured.then(result => { signal.removeEventListener('abort', aborted); resolve(result); });
    });
  }
  function validatePrepared(info, selected) {
    const value = info && info.source;
    if (!value || (value.itemId || value.id) !== selected.id || typeof (value.filePath || value.file) !== 'string' ||
      path.resolve(value.filePath || value.file) !== selected.filePath || !/^[0-9a-f]{64}$/.test(value.sha256 || ''))
      throw issue('PREPARED_IDENTITY_MISMATCH', '准备结果与本次选中的素材身份不一致，已停止显示。');
    if (!Array.isArray(info.frames) || !info.frames.length || !Number.isFinite(info.duration) || info.duration <= 0)
      throw issue('PREPARED_MEDIA_INVALID', '视频准备结果缺少可靠的帧或时长。');
  }
  async function runLoad(request) {
    let owned = null;
    try {
      if (!current(request)) return { status: 'superseded' };
      await releaseOwner(); if (!current(request)) return { status: 'superseded' };
      const captured = await waitCaptured(request.captured, request.controller.signal);
      if (!current(request) || captured.aborted) return { status: 'superseded' };
      if (captured.error) throw captured.error;
      const selected = captured.value;
      source = Object.freeze({ ...selected }); progress = { stage: 'media-prepare', message: '正在准备视频预览' }; notify();
      if (!current(request)) return { status: 'superseded' };
      owned = { epoch: request.epoch, info: null, player: null, dispose: null, released: false, ready: false }; owner = owned;
      const info = await media.prepare(selected, { signal: request.controller.signal, onProgress: value => {
        if (current(request) && owner === owned) { progress = typeof value === 'object' && value ? { ...value } : { stage: 'media-prepare', message: String(value) }; notify(); }
      } });
      owned.info = info;
      if (!current(request)) { await releaseOwner(owned); return { status: 'superseded' }; }
      validatePrepared(info, selected);
      source = Object.freeze({ ...selected, sha256: info.source.sha256 }); duration = info.duration;
      progress = { stage: 'player-initialize', message: '正在初始化画面与声音' }; notify();
      if (!current(request)) { await releaseOwner(owned); return { status: 'superseded' }; }
      const player = createPlayer({ experimentMode: 'compressed-ram',
        readAsset: (_copiedInfo, file) => cache.readAsset(info, file),
        onChange: value => {
          if (!current(request) || owner !== owned) return;
          playback = { ...value };
          if (owned.ready) {
            state = value.state;
            if (state === 'error') error = { code: value.lastErrorCode || 'PLAYBACK_FAILED', message: value.lastIssue || '视频播放或定位失败，请重试。' };
            else error = null;
          }
          notify();
        } });
      if (!player || ['load', 'snapshot', 'dispose', 'play', 'pause', 'seek', 'step'].some(name => typeof player[name] !== 'function'))
        throw issue('PLAYER_INTERFACE_INVALID', '播放器接口不完整。');
      owned.player = player;
      if (!current(request)) { await releaseOwner(owned); return { status: 'superseded' }; }
      await player.load(info);
      if (!current(request)) { await releaseOwner(owned); return { status: 'superseded' }; }
      const ready = player.snapshot();
      if (ready.state !== 'paused' || ready.frameId !== info.frames[0].id || ready.frameOrdinal !== 0)
        throw issue('FIRST_FRAME_NOT_READY', '首帧尚未准确显示并暂停，未开放播放操作。');
      owned.ready = true; playback = { ...ready }; state = 'paused'; progress = null; error = null;
      // UI enables ready controls synchronously inside this notification. Count
      // that initialization in P03, then expose metrics without redrawing UI.
      notify(); if (!current(request)) return { status: 'superseded' };
      const readyAt = now(); loadMetrics = { entryAt: request.startedAt, readyAt, totalMs: readyAt - request.startedAt,
        reused: !!(info.metrics && info.metrics.reused), trigger: request.trigger };
      return { status: 'ready', snapshot: snapshot() };
    } catch (failure) {
      try { await releaseOwner(owned || owner); }
      catch (cleanupFailure) { failure = issue('SESSION_RELEASE_FAILED', '旧视频资源未能确认释放，停止准备新素材：' + cleanupFailure.message); }
      if (!current(request)) return { status: 'superseded' };
      state = 'error'; error = describe(failure, 'PREPARATION_FAILED'); progress = null; playback = null; notify();
      return { status: 'error', error: { ...error } };
    }
  }
  function loadSelected(settings = {}) {
    if (closed) return Promise.resolve({ status: 'ignored', reason: 'closed' });
    const startedAt = Number.isFinite(settings.startedAt) ? settings.startedAt : now();
    const request = { epoch: invalidate(), controller: new AbortController(), captured: null, startedAt, trigger: settings.trigger || 'selected-load' };
    if (!current(request)) return Promise.resolve({ status: 'superseded' });
    controller = request.controller;
    // Start the single official API call now, before the disposal/preparation queue.
    let response; try { response = eagleAdapter.captureSelected(); } catch (failure) { response = Promise.reject(failure); }
    request.captured = Promise.resolve(response).then(value => ({ value }), failure => ({ error: failure }));
    if (!current(request)) return Promise.resolve({ status: 'superseded' });
    state = 'preparing'; source = null; duration = 0; playback = null; error = null; loadMetrics = null;
    progress = { stage: 'selection', message: '正在读取 Eagle 选中的视频' }; notify();
    return enqueue(() => runLoad(request));
  }
  function control(method, args, allowed) {
    const owned = owner, token = epoch;
    if (closed || !owned || !owned.ready || owned.epoch !== token || !allowed.includes(state))
      return Promise.reject(issue('SESSION_NOT_READY', '视频尚未就绪或正在定位，请等待当前操作完成。'));
    let result; try { result = owned.player[method](...args); } catch (failure) { result = Promise.reject(failure); }
    return Promise.resolve(result).then(value => token === epoch && !closed ? value : { status: 'superseded' }, failure => {
      if (token !== epoch || closed) return { status: 'superseded' };
      state = 'error'; error = describe(failure, 'PLAYBACK_FAILED'); notify(); throw failure;
    });
  }
  function clear(kind) {
    if (closed) return tail.then(() => error ? { status: 'error', error: { ...error } } : { status: 'closed' });
    if (kind === 'closed') closed = true; else libraryEpoch++;
    const token = invalidate();
    if (kind === 'closed' || token === epoch) {
      state = kind === 'closed' ? 'closed' : 'empty'; source = null; duration = 0; playback = null; error = null; loadMetrics = null;
      progress = kind === 'closed' ? null : { stage: 'library-changed', message: '素材库已变化，请重新调用插件。' }; notify();
    }
    return enqueue(async () => {
      if (!closed && token !== epoch) return { status: 'superseded' };
      try { await releaseOwner(); return { status: kind === 'closed' ? 'closed' : 'empty' }; }
      catch (failure) {
        if (!closed && token !== epoch) return { status: 'superseded' };
        if (kind !== 'closed') state = 'error'; error = describe(failure, 'SESSION_RELEASE_FAILED'); notify(); return { status: 'error', error: { ...error } };
      }
    });
  }
  return Object.freeze({ loadSelected, retry: settings => loadSelected({ ...settings, trigger: 'retry' }),
    play: () => control('play', [], ['paused']), pause: () => control('pause', [], ['paused', 'playing', 'seeking']),
    toggle: () => state === 'playing' ? control('pause', [], ['playing']) : control('play', [], ['paused']),
    seek: (time, settings = {}) => control('seek', [time, { ...settings, inputAt: settings.inputAt === undefined ? now() : settings.inputAt }], ['paused', 'playing', 'seeking']),
    step: delta => control('step', [delta], ['paused', 'playing', 'seeking']),
    libraryChanged: () => clear('library-changed'), close: () => clear('closed'), snapshot });
}
module.exports = { createSession };
