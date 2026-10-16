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
  let memoryResume = null;
  let cleanupError = null;
  const emptyComments = () => Object.freeze({ status: 'idle', items: Object.freeze([]), libraryPath: null, message: '', draft: null });
  let comments = emptyComments(), draftSequence = 0;
  const writes = new Map(), annotationReceipts = [];
  function commentChange(value) { comments = Object.freeze({ ...comments, ...value }); notify(); }
  function snapshot() {
    // Background image tasks finish without a UI state notification. Observe
    // the current ready owner directly so diagnostics do not hold an old task
    // count/RAM ledger forever. Never borrow a superseded material's player.
    const observed = !closed && owner && owner.ready && owner.epoch === epoch && owner.player
      ? owner.player.snapshot() : playback;
    return Object.freeze({ state, epoch, libraryEpoch, source, duration,
      sourceIdentity: source ? Object.freeze({ libraryEpoch, itemId: source.id, filePath: source.filePath, sha256: source.sha256 || null }) : null,
      playback: observed ? { ...observed, frame: observed.frameId, time: observed.time } : null,
      error: error ? { ...error } : null, progress: progress ? { ...progress } : null,
      loadMetrics: loadMetrics ? { ...loadMetrics } : null, comments,
      memorySettings: options.memoryPreferences ? options.memoryPreferences.snapshot() : null });
  }
  function memorySnapshot() {
    if (closed || !owner || owner.epoch !== epoch || !owner.player) return null;
    const budget = owner.player.snapshot().budget;
    return budget ? { used: budget.used, limit: budget.limit } : null;
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
      if (cleanupError) throw issue(cleanupError.code, cleanupError.message);
      if (!current(request)) return { status: 'superseded' };
      await releaseOwner(); if (!current(request)) return { status: 'superseded' };
      const captured = await waitCaptured(request.captured, request.controller.signal);
      if (!current(request) || captured.aborted) return { status: 'superseded' };
      if (captured.error) throw captured.error;
      const selected = captured.value;
      source = Object.freeze({ ...selected }); progress = { stage: 'media-prepare', message: '正在准备视频预览' }; notify();
      if (!current(request)) return { status: 'superseded' };
      loadComments(request, selected); // Independent read; never add API work to the frame loop.
      owned = { epoch: request.epoch, info: null, player: null, dispose: null, released: false, ready: false }; owner = owned;
      const mediaStartedAt = now();
      const info = await media.prepare(selected, { signal: request.controller.signal, onProgress: value => {
        if (current(request) && owner === owned) { progress = typeof value === 'object' && value ? { ...value } : { stage: 'media-prepare', message: String(value) }; notify(); }
      } });
      const mediaReturnedAt = now(); owned.info = info;
      if (!current(request)) { await releaseOwner(owned); return { status: 'superseded' }; }
      validatePrepared(info, selected);
      source = Object.freeze({ ...selected, sha256: info.source.sha256 }); duration = info.duration;
      progress = { stage: 'player-initialize', message: '正在初始化画面与声音' }; notify();
      if (!current(request)) { await releaseOwner(owned); return { status: 'superseded' }; }
      const player = createPlayer({ experimentMode: 'compressed-ram',
        readAsset: (_copiedInfo, file) => cache.readAsset(info, file),
        readFrameBatch: typeof cache.readFrameBatch === 'function' ? (_copiedInfo, files) => cache.readFrameBatch(info, files) : undefined,
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
      const playerStartedAt = now(); await player.load(info); const playerLoadedAt = now();
      if (!current(request)) { await releaseOwner(owned); return { status: 'superseded' }; }
      let ready = player.snapshot();
      if (ready.state !== 'paused' || ready.frameId !== info.frames[0].id || ready.frameOrdinal !== 0)
        throw issue('FIRST_FRAME_NOT_READY', '首帧尚未准确显示并暂停，未开放播放操作。');
      if (Number.isFinite(request.restoreTime)) {
        const located = await player.seek(request.restoreTime, { kind: 'memory-settings', final: true, inputAt: now() });
        if (!current(request)) { await releaseOwner(owned); return { status: 'superseded' }; }
        ready = player.snapshot();
        if (!located || !['drawn', 'reused'].includes(located.status) || ready.state !== 'paused' || ready.frameId !== located.frameId)
          throw issue('MEMORY_POSITION_NOT_READY', '内存设置后未能准确恢复当前位置。');
      }
      owned.ready = true; playback = { ...ready }; state = 'paused'; progress = null; error = null;
      if (request.restoredWrite) restoreWrite(request.restoredWrite);
      // UI enables ready controls synchronously inside this notification. Count
      // that initialization in P03, then expose metrics without redrawing UI.
      notify(); if (!current(request)) return { status: 'superseded' };
      const readyAt = now(); loadMetrics = { entryAt: request.startedAt, readyAt, totalMs: readyAt - request.startedAt,
        reused: !!(info.metrics && info.metrics.reused), trigger: request.trigger,
        mediaPrepareMs: mediaReturnedAt - mediaStartedAt, playerLoadMs: playerLoadedAt - playerStartedAt,
        mediaPhaseMs: info.metrics && info.metrics.phaseMs ? { ...info.metrics.phaseMs } : null };
      return { status: 'ready', snapshot: snapshot() };
    } catch (failure) {
      try { await releaseOwner(owned || owner); }
      catch (cleanupFailure) { failure = issue('SESSION_RELEASE_FAILED', '旧视频资源未能确认释放，停止准备新素材：' + cleanupFailure.message); }
      if (['MEDIA_CLEANUP_FAILED', 'SESSION_RELEASE_FAILED'].includes(failure && failure.code)) {
        cleanupError = describe(failure, 'SESSION_RELEASE_FAILED');
        if (!current(request)) { error = cleanupError; notify(); return { status: 'error', error: { ...cleanupError } }; }
      }
      if (!current(request)) return { status: 'superseded' };
      state = 'error'; error = describe(failure, 'PREPARATION_FAILED'); progress = null; playback = null; notify();
      return { status: 'error', error: { ...error } };
    }
  }
  function startLoad(settings = {}, retainedSource = null) {
    if (closed) return Promise.resolve({ status: 'ignored', reason: 'closed' });
    if (settings.trigger !== 'memory-settings') memoryResume = null;
    const startedAt = Number.isFinite(settings.startedAt) ? settings.startedAt : now();
    const request = { epoch: invalidate(), controller: new AbortController(), captured: null, startedAt, trigger: settings.trigger || 'selected-load', restoreTime: settings.restoreTime };
    if (!current(request)) return Promise.resolve({ status: 'superseded' });
    controller = request.controller;
    // Start the single official API call now, before the disposal/preparation queue.
    let response; try { response = retainedSource || eagleAdapter.captureSelected(); } catch (failure) { response = Promise.reject(failure); }
    request.captured = Promise.resolve(response).then(value => ({ value }), failure => ({ error: failure }));
    if (!current(request)) return Promise.resolve({ status: 'superseded' });
    state = 'preparing'; source = null; duration = 0; playback = null; error = null; loadMetrics = null;
    comments = emptyComments();
    progress = { stage: 'selection', message: '正在读取 Eagle 选中的视频' }; notify();
    return enqueue(() => runLoad(request));
  }
  function loadSelected(settings = {}) { return startLoad(settings); }
  async function clearOtherCaches() {
    if (closed || state === 'preparing' || comments.draft || !source || !owner || !owner.ready)
      throw issue('CACHE_CLEAN_BUSY', '请等待视频就绪，并先保存或取消标注。');
    if (typeof cache.clearOther !== 'function') throw issue('CACHE_CLEAN_UNAVAILABLE', '当前入口没有缓存清理接口。');
    const token = epoch, retained = source;
    await control('pause', [], ['paused', 'playing', 'seeking']);
    if (closed || token !== epoch) return { status: 'superseded' };
    const result = await cache.clearOther({ sourceSha256: retained.sha256 });
    return closed || token !== epoch ? { status: 'superseded' } : { status: 'cleared', ...result };
  }
  async function setMemoryMiB(ramMiB) {
    const preferences = options.memoryPreferences;
    if (!preferences) throw issue('MEMORY_SETTINGS_UNAVAILABLE', '当前入口没有内存设置接口。');
    preferences.preview(ramMiB);
    if (closed || state === 'preparing' || comments.draft) throw issue('MEMORY_SETTINGS_BUSY', '请等待准备完成，并先保存或取消标注。');
    const token = epoch, retained = source;
    if (owner && owner.ready) await control('pause', [], ['paused', 'playing', 'seeking']);
    if (closed || token !== epoch) return { status: 'superseded' };
    const retainedTime = memoryResume && retained && memoryResume.id === retained.id && memoryResume.filePath === retained.filePath ? memoryResume.time : 0;
    const time = owner && owner.player ? owner.player.snapshot().time : retainedTime;
    preferences.save(ramMiB);
    memoryResume = retained ? { id: retained.id, filePath: retained.filePath, time } : null;
    notify();
    if (closed || token !== epoch) return { status: 'superseded' };
    return retained ? startLoad({ trigger: 'memory-settings', restoreTime: time }, retained) : { status: 'applied' };
  }
  function control(method, args, allowed) {
    const owned = owner, token = epoch;
    if (comments.draft) return Promise.reject(issue('COMMENT_FRAME_FIXED', '标注时间已固定，请先保存或取消标注。'));
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
    memoryResume = null;
    const token = invalidate();
    if (kind === 'closed' || token === epoch) {
      state = kind === 'closed' ? 'closed' : 'empty'; source = null; duration = 0; playback = null; error = null; loadMetrics = null;
      comments = emptyComments();
      progress = kind === 'closed' ? null : { stage: 'library-changed', message: '素材库已变化，请重新调用插件。' }; notify();
    }
    return enqueue(async () => {
      if (!closed && token !== epoch) return { status: 'superseded' };
      try {
        if (cleanupError) throw issue(cleanupError.code, cleanupError.message);
        await releaseOwner();
        // Dispatched writes cannot be cancelled with the player. They finish
        // read-back against their own identity, without updating another item.
        if (kind === 'closed') await Promise.all([...writes.values()].map(value => value.promise).filter(Boolean));
        return { status: kind === 'closed' ? 'closed' : 'empty' };
      }
      catch (failure) {
        if (!closed && token !== epoch) return { status: 'superseded' };
        if (kind !== 'closed') state = 'error'; error = describe(failure, 'SESSION_RELEASE_FAILED'); notify(); return { status: 'error', error: { ...error } };
      }
    });
  }
  function writeKey(value) { return value.libraryPath + '\0' + value.source.id + '\0' + value.source.filePath; }
  async function loadComments(request, selected) {
    commentChange({ status: 'loading', message: '正在读取标注' });
    try {
      if (!current(request)) return;
      if (typeof eagleAdapter.readComments !== 'function') throw issue('COMMENTS_API_UNAVAILABLE', '当前环境没有标注读取接口。');
      const data = await eagleAdapter.readComments(selected);
      if (!current(request)) return;
      const old = writes.get(writeKey({ libraryPath: data.libraryPath, source: selected }));
      request.restoredWrite = old || null;
      commentChange({ status: 'ready', items: data.items, libraryPath: data.libraryPath, message: '', draft: old ? old.draft : null });
    } catch (failure) {
      if (current(request)) commentChange({ status: 'error', message: '读取标注失败：' + failure.message });
    }
  }
  function liveDraft(id, token) { return !closed && token === epoch && comments.draft && comments.draft.id === id; }
  function restoreWrite(record) {
    const result = record.result;
    if (result && result.status === 'saved') comments = Object.freeze({ ...comments, items: result.items, draft: null, message: result.message });
    else comments = Object.freeze({ ...comments, draft: result && result.status === 'failed'
      ? Object.freeze({ ...record.draft, status: 'obsolete', message: '原提案未发送，视频已切换。文字已保留，请复制后取消，再固定新画面。' }) : record.draft });
  }
  async function beginComment() {
    const owned = owner, token = epoch;
    if (closed || !owned || !owned.ready || comments.status !== 'ready' || comments.draft || !['paused', 'playing'].includes(state))
      return { status: 'ignored' };
    let draft = Object.freeze({ id: ++draftSequence, status: 'pausing', source, libraryPath: comments.libraryPath,
      libraryEpoch, frameId: null, time: null, text: '', message: '正在固定画面…', attempt: null });
    commentChange({ draft });
    try {
      await owned.player.pause();
      if (!liveDraft(draft.id, token)) return { status: 'superseded' };
      const actual = owned.player.snapshot();
      const frame = owned.info.frames[actual.frameOrdinal];
      if (actual.state !== 'paused' || actual.pendingTargets > 0 || !Number.isSafeInteger(actual.frameId) || !Number.isFinite(actual.time) ||
        !frame || !Number.isFinite(frame.time) || frame.id !== actual.frameId || Math.abs(frame.time - actual.time) > .000001)
        throw issue('COMMENT_FRAME_NOT_READY', '画面尚未定位完成，请完成定位后再添加标注。');
      draft = Object.freeze({ ...draft, frameId: actual.frameId, time: actual.time, status: 'editing', message: '' });
      commentChange({ draft }); return { status: 'editing', draft };
    } catch (failure) {
      if (liveDraft(draft.id, token)) commentChange({ draft: null, message: failure.message });
      return { status: 'failed', message: failure.message };
    }
  }
  function setCommentText(text) {
    const draft = comments.draft;
    if (!draft || !['editing', 'failed'].includes(draft.status) || typeof text !== 'string') return { status: 'ignored' };
    commentChange({ draft: Object.freeze({ ...draft, text, status: 'editing', message: '' }) }); return { status: 'editing' };
  }
  function cancelComment() {
    const draft = comments.draft;
    if (!draft || ['pausing', 'editing', 'failed', 'obsolete'].includes(draft.status)) { commentChange({ draft: null, message: '' }); return { status: 'cancelled' }; }
    // An uncertain write must stay available for explicit read-only checking.
    return { status: 'ignored', message: '这次保存已发出，请先核对结果。' };
  }
  function saveComment() {
    const draft = comments.draft, token = epoch;
    if (!draft || !['editing', 'failed'].includes(draft.status)) return Promise.resolve({ status: 'ignored' });
    if (!draft.text.trim()) { commentChange({ draft: Object.freeze({ ...draft, message: '请填写标注文字。' }) }); return Promise.resolve({ status: 'failed' }); }
    if (typeof eagleAdapter.saveComment !== 'function' || writes.size >= 32) {
      commentChange({ draft: Object.freeze({ ...draft, status: 'failed', message: '保存接口不可用或待核对记录已达上限，请先在Eagle核对。' }) });
      return Promise.resolve({ status: 'failed' });
    }
    const key = writeKey(draft);
    if (writes.has(key)) return Promise.resolve({ status: 'ignored' });
    const record = { draft: Object.freeze({ ...draft, status: 'saving', message: '正在保存并核对…' }), promise: null };
    writes.set(key, record); commentChange({ draft: record.draft });
    const active = () => liveDraft(draft.id, token) && libraryEpoch === draft.libraryEpoch;
    // Attach the promise before any adapter callback can trigger a close.
    record.promise = Promise.resolve().then(() => eagleAdapter.saveComment(draft, { isCurrent: active,
      onIssued(attempt) { record.draft = Object.freeze({ ...record.draft, attempt }); if (active()) commentChange({ draft: record.draft }); }
    })).catch(failure => ({ status: record.draft.attempt ? 'unknown' : 'failed', attempt: record.draft.attempt, message: failure.message }))
      .then(result => finishComment(record, key, result, draft.id, token));
    return record.promise;
  }
  function finishComment(record, key, result, id, token) {
    record.result = result;
    record.draft = Object.freeze({ ...record.draft, status: result.status, attempt: result.status === 'failed' ? null : result.attempt || record.draft.attempt, message: result.message });
    annotationReceipts.push(Object.freeze({ source: record.draft.source, libraryPath: record.draft.libraryPath,
      frameId: record.draft.frameId, time: record.draft.time, text: record.draft.text, status: result.status,
      commentId: result.commentId || null, message: result.message }));
    if (annotationReceipts.length > 32) annotationReceipts.shift();
    if (result.status !== 'unknown') writes.delete(key);
    // Restored attempts may belong to an earlier epoch. Match the proposal ID
    // and library path as well as the source, never just a reused content hash.
    const sameDraft = !closed && comments.draft && comments.draft.id === id && comments.libraryPath === record.draft.libraryPath &&
      source && source.id === record.draft.source.id && source.filePath === record.draft.source.filePath && source.sha256 === record.draft.source.sha256;
    if (liveDraft(id, token) || sameDraft) {
      if (result.status === 'saved') commentChange({ items: result.items, draft: null, message: result.message });
      else if (token !== epoch && result.status === 'failed') { restoreWrite(record); notify(); }
      else commentChange({ draft: record.draft });
    }
    return result;
  }
  function checkComment() {
    const draft = comments.draft, token = epoch;
    if (!draft || draft.status !== 'unknown' || !draft.attempt || typeof eagleAdapter.verifyComment !== 'function') return Promise.resolve({ status: 'ignored' });
    const key = writeKey(draft), record = writes.get(key);
    if (!record) return Promise.resolve({ status: 'ignored' });
    record.draft = Object.freeze({ ...draft, status: 'checking', message: '正在核对原保存结果，不会再次添加…' });
    commentChange({ draft: record.draft });
    record.promise = Promise.resolve().then(() => eagleAdapter.verifyComment(draft.attempt))
      .catch(failure => ({ status: 'unknown', attempt: draft.attempt, message: failure.message }))
      .then(result => finishComment(record, key, result, draft.id, token));
    return record.promise;
  }
  return Object.freeze({ loadSelected, retry: settings => loadSelected({ ...settings, trigger: 'retry' }),
    play: () => control('play', [], ['paused']), pause: () => control('pause', [], ['paused', 'playing', 'seeking']),
    toggle: () => state === 'playing' ? control('pause', [], ['playing']) : control('play', [], ['paused']),
    seek: (time, settings = {}) => control('seek', [time, { ...settings, inputAt: settings.inputAt === undefined ? now() : settings.inputAt }], ['paused', 'playing', 'seeking']),
    step: delta => control('step', [delta], ['paused', 'playing', 'seeking']),
    beginComment, setCommentText, saveComment, cancelComment, checkComment,
    seekComment: id => {
      const item = comments.items.find(value => value.id === id);
      return item && item.time <= duration ? control('seek', [item.time, { kind: 'annotation', final: true, inputAt: now() }], ['paused', 'playing', 'seeking']) : Promise.resolve({ status: 'ignored' });
    },
    annotationHistory: () => Object.freeze(annotationReceipts.slice()), setMemoryMiB, clearOtherCaches,
    libraryChanged: () => clear('library-changed'), close: () => clear('closed'), snapshot, memorySnapshot });
}
module.exports = { createSession };
