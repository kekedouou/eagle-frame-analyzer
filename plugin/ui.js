/* UI sends operations only to the session; it never reads Eagle or files. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EVAUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clamp = value => Math.max(0, Math.min(1, value));
  function formatTime(seconds) {
    const milliseconds = Math.max(0, Math.floor((Number(seconds) || 0) * 1000 + .00001));
    return Math.floor(milliseconds / 60000) + ':' + String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0') + '.' + String(milliseconds % 1000).padStart(3, '0');
  }
  function pointerTime(x, rect, duration) {
    if (!Number.isFinite(x) || !rect || !(rect.width > 0) || !(duration > 0)) return null;
    return clamp((x - rect.left) / rect.width) * duration;
  }
  function spaceAllowed(event, timeline) {
    if (!(event.code === 'Space' || event.key === ' ') || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
    const target = event.target;
    if (!target) return true;
    if (target.isContentEditable) return false;
    const control = typeof target.closest === 'function' && target.closest('button,input,textarea,select,a,[contenteditable],[role="textbox"],[role="slider"]');
    // This custom timeline has no native Space action; other controls retain theirs.
    return !control || control === timeline;
  }
  function createUI(options = {}) {
    const doc = options.document || document, win = options.window || window, now = options.now || (() => performance.now());
    const ids = ['picture', 'notice', 'timeline', 'progress', 'thumb', 'timeHint', 'play', 'previous', 'next', 'currentTime', 'duration', 'sourceName', 'memoryUsage', 'status', 'error', 'retry',
      'commentMarkers', 'commentList', 'commentStatus', 'commentAdd', 'commentEditor', 'commentTime', 'commentText', 'commentSave', 'commentCancel',
      'memoryPercent', 'memoryApply', 'memoryAllowance', 'memoryStatus'];
    const el = Object.fromEntries(ids.map(id => [id, doc.getElementById(id)]));
    if (ids.some(id => !el[id])) throw new Error('播放器界面缺少必要元素。');
    let session = null, state = { state: 'empty', duration: 0 }, gesture = null, hintEpoch = null, hintGeometry = null, lastRequestedTime = 0;
    const attributes = new Map();
    const set = (node, key, value) => { if (node[key] !== value) node[key] = value; };
    let memoryTimer = null;
    function refreshMemory() {
      const budget = session && typeof session.memorySnapshot === 'function' ? session.memorySnapshot() : null;
      const available = budget && Number.isFinite(budget.used) && budget.used >= 0 && Number.isFinite(budget.limit) && budget.limit > 0;
      set(el.memoryUsage, 'textContent', available ? '视频缓存 RAM：' + (budget.used / 1048576).toFixed(1) + ' / ' +
        (budget.limit / 1048576).toFixed(0) + ' MiB' : '视频缓存 RAM：—');
    }
    function attribute(name, value) {
      if (attributes.get(name) !== value) { el.timeline.setAttribute(name, value); attributes.set(name, value); }
    }
    const listeners = [];
    const on = (target, type, handler) => { target.addEventListener(type, handler); listeners.push([target, type, handler]); };
    let memoryBusy = false, shownMemory = null, shownPercent = '';
    function updateMemorySettings() {
      const memory = state.memorySettings;
      const disabled = !session || !memory || memoryBusy || state.state === 'preparing' || state.state === 'closed' || !!state.comments?.draft;
      set(el.memoryApply, 'disabled', disabled); set(el.memoryPercent, 'disabled', disabled);
      if (memory && memory !== shownMemory) {
        shownMemory = memory; shownPercent = String(Number(memory.percent.toFixed(4)));
        set(el.memoryPercent, 'value', shownPercent);
        set(el.memoryAllowance, 'textContent', '缓存上限 ' + (memory.ramBytes / 1048576).toFixed(1) + ' MiB（不含程序额外占用）');
      }
    }
    on(el.memoryApply, 'click', async () => {
      if (el.memoryApply.disabled || !session || typeof session.setMemoryPercent !== 'function') return;
      const active = session, percent = el.memoryPercent.value === shownPercent && shownMemory ? shownMemory.percent : Number(el.memoryPercent.value);
      memoryBusy = true; set(el.memoryStatus, 'textContent', '正在应用，完成后保持暂停…'); updateMemorySettings();
      try { const result = await active.setMemoryPercent(percent);
        if (session !== active) return;
        set(el.memoryStatus, 'textContent', result.status === 'error' ? '设置已保存，视频准备失败；可提高额度后重试。' :
          result.status === 'superseded' ? '操作已被素材切换或关闭替代。' : '设置已保存。');
      } catch (failure) { if (session === active) set(el.memoryStatus, 'textContent', String(failure.message || failure)); }
      finally { memoryBusy = false; if (session === active) { shownMemory = null; updateMemorySettings(); } }
    });
    const interactive = () => !!session && !state.comments?.draft && ['paused', 'playing', 'seeking'].includes(state.state);
    const invoke = fn => {
      try { Promise.resolve(fn()).catch(() => {}); } catch (_) { /* session publishes operation errors */ }
    };
    function thumb(time) {
      const ratio = state.duration > 0 ? clamp(time / state.duration) : 0;
      set(el.thumb.style, 'left', ratio * 100 + '%'); set(el.progress.style, 'width', ratio * 100 + '%');
    }
    function measureHint(rect) {
      // The <=30s time string uses tabular digits of constant width. Measure
      // on gesture start/resize, not after every DOM write in the seek loop.
      hintGeometry = { width: (rect || el.timeline.getBoundingClientRect()).width,
        half: Math.max(35, (el.timeHint.offsetWidth || 80) / 2) };
    }
    function hint(time) {
      set(el.timeHint, 'textContent', formatTime(time));
      if (!hintGeometry) measureHint();
      const { width, half } = hintGeometry;
      const x = state.duration > 0 ? clamp(time / state.duration) * width : 0;
      set(el.timeHint.style, 'left', Math.max(Math.min(half, width / 2), Math.min(width - half, x)) + 'px');
    }
    function clearHint() { hintEpoch = null; hintGeometry = null; set(el.timeHint, 'hidden', true); }
    function clearGesture(hideHint = true) {
      const old = gesture; gesture = null; if (hideHint) clearHint();
      if (old) { try { if (el.timeline.hasPointerCapture(old.id)) el.timeline.releasePointerCapture(old.id); } catch (_) {} }
    }
    function requestAt(event, final, inputAt = now()) {
      const time = event && gesture ? pointerTime(event.clientX, gesture.rect, state.duration) : lastRequestedTime;
      if (time === null) return;
      lastRequestedTime = time; thumb(time);
      invoke(() => session.seek(time, { kind: final ? 'release' : 'rapid', final: !!final, inputAt }));
    }
    function end(event) {
      const inputAt = now();
      if (!gesture || (event && event.pointerId !== gesture.id)) return;
      if (interactive()) requestAt(event, true, inputAt);
      clearGesture(false);
    }
    on(el.timeline, 'pointerdown', event => {
      const inputAt = now();
      if (!interactive() || gesture || (event.button !== undefined && event.button !== 0)) return;
      event.preventDefault(); gesture = { id: event.pointerId, rect: el.timeline.getBoundingClientRect(), epoch: state.epoch };
      el.timeline.focus(); try { el.timeline.setPointerCapture(event.pointerId); } catch (_) {}
      hintEpoch = state.epoch; set(el.timeHint, 'hidden', false);
      set(el.timeHint, 'textContent', formatTime(state.playback ? state.playback.time : 0));
      measureHint(gesture.rect); hint(state.playback ? state.playback.time : 0); requestAt(event, false, inputAt);
    });
    // Capture loss does not end a physical drag: window moves/up still own it.
    on(el.timeline, 'lostpointercapture', () => {});
    on(win, 'pointermove', event => {
      const inputAt = now();
      if (!gesture || event.pointerId !== gesture.id) return;
      if (event.buttons !== undefined && !(event.buttons & 1)) return end(event);
      if (interactive()) requestAt(event, false, inputAt);
    });
    on(win, 'pointerup', end); on(win, 'pointercancel', end); on(win, 'blur', () => end(null));
    on(win, 'resize', () => {
      if (gesture) gesture.rect = el.timeline.getBoundingClientRect();
      if (hintEpoch !== null) { measureHint(gesture && gesture.rect); hint(state.playback ? state.playback.time : 0); }
    });
    on(el.play, 'click', () => { if (session && !gesture) { clearHint(); invoke(() => session.toggle()); } });
    on(el.previous, 'click', () => { if (interactive()) { clearHint(); invoke(() => session.step(-1)); } });
    on(el.next, 'click', () => { if (interactive()) { clearHint(); invoke(() => session.step(1)); } });
    on(el.retry, 'click', () => { if (session) invoke(() => session.retry()); });
    on(win, 'keydown', event => {
      if (!spaceAllowed(event, el.timeline)) return;
      event.preventDefault(); if (interactive() && !gesture && ['paused', 'playing'].includes(state.state)) { clearHint(); invoke(() => session.toggle()); }
    });
    on(el.timeline, 'keydown', event => {
      if (!interactive() || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); clearHint(); invoke(() => session.step(event.key === 'ArrowLeft' ? -1 : 1)); }
    });
    let renderedItems = null, renderedDuration = null, renderedComments = null, renderedInteractive = null, editorId = null;
    const commentButtons = [], markerButtons = [];
    function seekComment(event) {
      const button = event.target && event.target.closest && event.target.closest('button[data-comment-id]');
      if (button && interactive()) { clearHint(); invoke(() => session.seekComment(button.dataset.commentId)); }
    }
    on(el.commentMarkers, 'click', seekComment); on(el.commentList, 'click', seekComment);
    on(el.commentAdd, 'click', () => { if (interactive() && !gesture) invoke(() => session.beginComment()); });
    on(el.commentText, 'input', () => { if (session) invoke(() => session.setCommentText(el.commentText.value)); });
    on(el.commentSave, 'click', () => { if (session) invoke(() => state.comments?.draft?.status === 'unknown' ? session.checkComment() : session.saveComment()); });
    on(el.commentCancel, 'click', () => { if (session) invoke(() => session.cancelComment()); });
    function updateComments() {
      const value = state.comments, draft = value && value.draft, ready = interactive();
      const items = value && value.items;
      let rebuilt = false;
      // The immutable list changes only on loading/read-back, never per frame.
      if (items && (items !== renderedItems || renderedDuration !== state.duration)) {
        renderedItems = items; renderedDuration = state.duration;
        rebuilt = true;
        el.commentList.replaceChildren(); el.commentMarkers.replaceChildren(); commentButtons.length = 0; markerButtons.length = 0;
        for (const item of items) {
          const inRange = item.time <= state.duration;
          const button = doc.createElement('button'); button.type = 'button'; button.dataset.commentId = item.id;
          button.className = 'comment-item'; button.textContent = formatTime(item.time) + '  ' + item.text;
          button.title = inRange ? '定位到此标注' : '此标注超出当前视频时长，不能可靠定位';
          el.commentList.appendChild(button); commentButtons.push({ button, inRange });
          if (inRange && state.duration > 0) {
            const marker = doc.createElement('button'); marker.type = 'button'; marker.dataset.commentId = item.id;
            marker.className = 'comment-marker'; marker.style.left = clamp(item.time / state.duration) * 100 + '%';
            marker.title = formatTime(item.time) + '  ' + item.text; marker.setAttribute('aria-label', marker.title);
            el.commentMarkers.appendChild(marker); markerButtons.push(marker);
          }
        }
      }
      if (rebuilt || renderedInteractive !== ready) {
        for (const entry of commentButtons) set(entry.button, 'disabled', !ready || !entry.inRange);
        for (const button of markerButtons) set(button, 'disabled', !ready);
        renderedInteractive = ready;
      }
      set(el.commentAdd, 'disabled', !ready || !value || value.status !== 'ready' || state.state === 'seeking');
      if (value === renderedComments) return;
      renderedComments = value;
      set(el.commentStatus, 'textContent', draft?.message || value?.message || (value?.status === 'ready' && !items.length ? '暂无标注' : ''));
      set(el.commentEditor, 'hidden', !draft);
      if (!draft) { editorId = null; set(el.commentText, 'value', ''); return; }
      const editable = ['editing', 'failed'].includes(draft.status);
      set(el.commentTime, 'textContent', Number.isFinite(draft.time) ? (editable ? '固定时间 ' : '原保存时间 ') + formatTime(draft.time) : '正在固定画面…');
      set(el.commentText, 'disabled', draft.status === 'pausing'); set(el.commentText, 'readOnly', !editable); set(el.commentText, 'value', draft.text);
      set(el.commentSave, 'textContent', draft.status === 'unknown' ? '核对保存结果' : '保存');
      set(el.commentSave, 'disabled', !editable && draft.status !== 'unknown');
      set(el.commentCancel, 'disabled', !['editing', 'failed', 'pausing', 'obsolete'].includes(draft.status));
      if (editable && editorId !== draft.id) { editorId = draft.id; el.commentText.focus(); }
    }
    function update(snapshot) {
      state = snapshot;
      if (gesture && (gesture.epoch !== state.epoch || !interactive())) clearGesture();
      if (hintEpoch !== null && (hintEpoch !== state.epoch || !interactive() || state.state === 'playing')) clearHint();
      const ready = interactive(), time = state.playback && Number.isFinite(state.playback.time) ? state.playback.time : 0;
      set(el.play, 'disabled', !ready || !['paused', 'playing'].includes(state.state));
      set(el.previous, 'disabled', !ready); set(el.next, 'disabled', !ready);
      set(el.play, 'textContent', state.state === 'playing' ? '暂停' : '播放');
      attribute('aria-disabled', String(!ready)); attribute('aria-valuemax', String(state.duration || 0));
      attribute('aria-valuenow', String(time)); attribute('aria-valuetext', formatTime(time));
      set(el.currentTime, 'textContent', formatTime(time)); set(el.duration, 'textContent', formatTime(state.duration));
      set(el.sourceName, 'textContent', state.source ? state.source.name : '未载入视频');
      const messages = { empty: '等待素材', preparing: '正在准备视频', paused: '已暂停', playing: '播放中', seeking: '正在定位', error: '无法继续', closed: '已关闭' };
      const progress = state.progress && Number.isSafeInteger(state.progress.frames) ? '（' + state.progress.frames + ' 帧）' : '';
      const emptyMessage = state.state === 'empty' && state.progress && state.progress.message;
      set(el.status, 'textContent', emptyMessage || (messages[state.state] || '等待素材') + (state.state === 'preparing' ? progress : ''));
      set(el.error, 'hidden', !state.error); set(el.error, 'textContent', state.error ? state.error.message : '');
      set(el.retry, 'hidden', !session || state.state !== 'error');
      set(el.notice, 'hidden', ready || !!(state.playback && Number.isSafeInteger(state.playback.frameId)));
      set(el.notice, 'textContent', emptyMessage || (state.state === 'preparing' ? '正在准备视频…' : state.state === 'error' ? '视频未就绪' : '在 Eagle 中单选 MP4 后打开插件'));
      if (!gesture) thumb(time);
      if (hintEpoch !== null) hint(time); // Includes final release settlement; only actual submitted frame time.
      updateComments();
      updateMemorySettings();
    }
    return { canvas: el.picture, bindSession(value) {
      session = value; update(state); refreshMemory();
      if (memoryTimer === null && typeof win.setInterval === 'function') memoryTimer = win.setInterval(refreshMemory, 500);
    }, update,
      destroy() {
        if (memoryTimer !== null) { win.clearInterval(memoryTimer); memoryTimer = null; }
        clearGesture(); listeners.forEach(([target, type, fn]) => target.removeEventListener(type, fn)); session = null; refreshMemory();
      } };
  }
  return { createUI, formatTime, pointerTime, spaceAllowed };
});
