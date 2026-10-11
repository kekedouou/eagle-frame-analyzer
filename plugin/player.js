/* Canvas/Web Audio playback core. Host, filesystem and frame index are injected. */
(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  // Eagle can expose window and CommonJS together; neither export excludes the other.
  if (typeof window === 'object' && window) window.EVAPlayer = exported;
  else if (root && root.document) root.EVAPlayer = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RAM_LIMIT = 512 * 1024 * 1024;
  class Budget {
    constructor(limit) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > RAM_LIMIT) throw new Error('RAM预算无效或超过512MiB。');
      this.limit = limit; this.used = 0; this.peak = 0; this.tokens = new Set();
    }
    reserve(bytes, kind, evict) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit) throw new Error('单次缓存预留超过RAM预算或字节无效。');
      while (this.used + bytes > this.limit && evict && evict()) { /* finite cache */ }
      if (this.used + bytes > this.limit) throw new Error('RAM预算不足，固定资源或在途任务不能提前释放。');
      const token = { bytes, kind }; this.tokens.add(token); this.used += bytes; this.peak = Math.max(this.peak, this.used); return token;
    }
    shrink(token, bytes, kind) {
      if (!this.tokens.has(token) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > token.bytes) throw new Error('无效的预算转移。');
      this.used -= token.bytes - bytes; token.bytes = bytes; token.kind = kind;
    }
    release(token) { if (token && this.tokens.delete(token)) { this.used -= token.bytes; token.bytes = 0; } }
    snapshot() {
      const kinds = {}; this.tokens.forEach(token => { kinds[token.kind] = (kinds[token.kind] || 0) + token.bytes; });
      return { used: this.used, peak: this.peak, limit: this.limit, kinds };
    }
  }
  function readBarcode(context, expected, ordinal) {
    const spec = expected && expected.barcode;
    if (!spec || !expected.barcodes || expected.barcodes[ordinal] === undefined) return null;
    const pixels = context.getImageData(spec.x + spec.sampleXOffset, spec.y + spec.sampleYOffset, (spec.bits - 1) * spec.step + 1, 1).data;
    let actual = 0, uncertain = false; const samples = [];
    for (let bit = 0; bit < spec.bits; bit++) {
      const at = bit * spec.step * 4, value = (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3; samples.push(value);
      if (value > 175) actual += 2 ** bit; else if (value >= 80) uncertain = true;
    }
    return { actual: uncertain ? null : actual, expected: expected.barcodes[ordinal], ok: uncertain ? null : actual === expected.barcodes[ordinal],
      uncertain, samples, method: 'canvas-pixel-barcode-lsb-left-single-row-readback' };
  }
  function browserEnvironment() {
    return { now: () => performance.now(), raf: callback => requestAnimationFrame(callback), caf: id => cancelAnimationFrame(id),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      decodeImage: bytes => createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })),
      createAudioContext: () => new (globalThis.AudioContext || globalThis.webkitAudioContext)() };
  }
  function freezeInfo(info) {
    const frames = info.frames.map(frame => Object.freeze(Object.assign({}, frame, { timeBase: Object.freeze(frame.timeBase.slice()) })));
    const expected = info.expected ? Object.freeze(Object.assign({}, info.expected, {
      barcodes: info.expected.barcodes ? Object.freeze(info.expected.barcodes.slice()) : undefined,
      times: info.expected.times ? Object.freeze(info.expected.times.slice()) : undefined,
      barcode: info.expected.barcode ? Object.freeze(Object.assign({}, info.expected.barcode)) : undefined
    })) : null;
    return Object.freeze(Object.assign({}, info, { frames: Object.freeze(frames), source: Object.freeze(Object.assign({}, info.source)),
      audio: info.audio ? Object.freeze(Object.assign({}, info.audio)) : null, expected }));
  }
  class Player {
    constructor(options) {
      if (!options || !options.canvas || typeof options.readAsset !== 'function') throw new Error('缺少画布或受限资源读取函数。');
      this.index = options.frameIndex;
      if (!this.index || ['validateIndex', 'frameAt', 'stepIndex', 'audioStartPlan'].some(name => typeof this.index[name] !== 'function')) throw new Error('缺少纯帧索引模块。');
      this.env = Object.assign(browserEnvironment(), options.env || {}); this.canvas = options.canvas;
      this.ctx = this.canvas.getContext('2d', { alpha: false }); if (!this.ctx) throw new Error('无法取得2D画布。');
      this.readAsset = options.readAsset; this.emit = options.emit || (() => {}); this.onChange = options.onChange || (() => {});
      this.budget = options.budget || new Budget(options.ramBytes === undefined ? RAM_LIMIT : options.ramBytes);
      if (['reserve', 'shrink', 'release', 'snapshot'].some(name => typeof this.budget[name] !== 'function')) throw new Error('注入的RAM账本无效。');
      const ledgerLimit = this.budget.snapshot().limit;
      if (!Number.isSafeInteger(ledgerLimit) || ledgerLimit <= 0 || ledgerLimit > RAM_LIMIT) throw new Error('注入的RAM账本无效。');
      this.playbackGuardMs = options.playbackGuardMs === undefined ? 150 : options.playbackGuardMs;
      if (!Number.isFinite(this.playbackGuardMs) || this.playbackGuardMs <= 0) throw new Error('播放欠载保护间隔无效。');
      this.info = null; this.state = 'empty'; this.epoch = 0; this.playToken = 0; this.requestId = 0;
      this.target = null; this.currentIndex = null; this.time = 0; this.targetTime = 0;
      this.cache = new Map(); this.tasks = new Map(); this.loads = new Set(); this.prefetchFailed = new Set();
      this.audioContext = null; this.audioBuffer = null; this.audioBudget = null; this.contexts = new Set(); this.graph = null; this.anchor = null;
      this.decodeDelayMs = 0; this.verifyMarkers = true; this.rafCount = 0; this.drawCount = 0; this.lastDrawAt = null; this.maxDrawGapMs = 0;
      this.lastClockEmit = -Infinity; this.waitingSince = null; this.ended = false; this.lastIssue = null; this.lastErrorCode = null;
      this.rafId = null; this.disposed = false; this.disposePromise = null; this._schedule();
    }
    _emit(type, values) {
      try { this.emit(Object.assign({ type, at: this.env.now(), epoch: this.epoch }, values || {})); }
      catch (error) { this.telemetryIssue = error.message; }
    }
    _change(state) {
      if (state) this.state = state;
      const epoch = this.epoch, snapshot = this.snapshot(); this._emit('state', { state: this.state });
      if (epoch !== this.epoch || snapshot.state !== this.state) return;
      try { this.onChange(snapshot); } catch (error) { this.telemetryIssue = error.message; }
    }
    snapshot() {
      const ledger = this.budget.snapshot(), frame = this.info && this.currentIndex !== null ? this.info.frames[this.currentIndex] : null;
      return { state: this.state, time: this.time, frameId: frame ? frame.id : null, frameOrdinal: this.currentIndex,
        targetTime: this.targetTime, targetFrameId: this.info && this.target ? this.info.frames[this.target.index].id : null,
        pendingTargets: this.target && this.target.resolve ? 1 : 0, activeImageTasks: this.tasks.size,
        cacheBytes: ledger.used, cachePeakBytes: ledger.peak, budget: ledger, audioAvailable: !!this.audioBuffer,
        decodeDelayMs: this.decodeDelayMs, verifyMarkers: this.verifyMarkers, epoch: this.epoch, drawCount: this.drawCount,
        rafOpportunity: this.rafCount, maxDrawGapMs: this.maxDrawGapMs, lastIssue: this.lastIssue, lastErrorCode: this.lastErrorCode,
        playbackGuardMs: this.playbackGuardMs, telemetryIssue: this.telemetryIssue || null,
        memoryScope: 'managed decoded RGBA, audio, compressed/copy buffers and in-flight reservations; browser/GPU/internal decoder copies excluded' };
    }
    setDecodeDelay(ms) {
      if (!Number.isFinite(ms) || ms < 0 || ms > 2000) throw new Error('解码延迟须在0～2000ms。');
      this.decodeDelayMs = ms; this._change();
    }
    setVerifyMarkers(enabled) { this.verifyMarkers = !!enabled; this._change(); }
    _valid(epoch) { return !this.disposed && epoch === this.epoch; }
    _playValid(epoch, token) { return this._valid(epoch) && token === this.playToken; }
    _settle(target, status, values) {
      if (!target || !target.resolve) return;
      const resolve = target.resolve; target.resolve = null;
      resolve(Object.assign({ status, requestId: target.requestId, frameId: target.frameId }, values || {}));
      if (status !== 'drawn') this._emit(status === 'superseded' || status === 'reused' ? status : 'error', Object.assign({
        epoch: target.epoch, requestId: target.requestId, kind: target.kind, frameId: target.frameId, inputAt: target.inputAt, status
      }, values || {}));
    }
    _clearTarget(reason) { const target = this.target; this.target = null; this._settle(target, 'superseded', { reason }); }
    async load(rawInfo) {
      if (this.disposed) throw new Error('播放器已释放。');
      const oldLoads = Array.from(this.loads), oldTasks = Array.from(this.tasks.values()).map(task => task.promise);
      const epoch = ++this.epoch; this.state = 'loading'; this._halt(false); this._clearTarget('material-switch'); this._clearCache();
      const oldContext = this.audioContext; this.audioContext = null; this.audioBuffer = null;
      this.budget.release(this.audioBudget); this.audioBudget = null; this.info = null;
      this.currentIndex = null; this.time = 0; this.targetTime = 0; this.lastIssue = null; this.lastErrorCode = null; this.prefetchFailed.clear(); this.ended = false;
      this._change('loading');
      const operation = Promise.resolve().then(async () => {
        let context = null, reservation = null, transferred = false;
        try {
          if (oldContext) await this._closeContext(oldContext);
          // Uncancellable work keeps its reservation; do not overlap images from two materials.
          await Promise.allSettled(oldLoads.concat(oldTasks)); if (!this._valid(epoch)) return { status: 'superseded' };
          this.index.validateIndex(rawInfo); const info = freezeInfo(rawInfo);
          this.info = info; this.canvas.width = info.width; this.canvas.height = info.height;
          if (info.audio) {
            context = this.env.createAudioContext(); this.contexts.add(context); this.audioContext = context;
            const estimate = Math.ceil((info.audio.duration + 0.1) * context.sampleRate * info.audio.channels) * 4;
            reservation = this.budget.reserve(estimate + info.audio.bytes * 2, 'audio-loading', () => this._evict());
            const bytes = await this.readAsset(info, info.audio.file);
            if (!bytes || bytes.byteLength !== info.audio.bytes) throw new Error('音频资源长度与清单不符。');
            if (!this._valid(epoch)) return { status: 'superseded' };
            const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            const buffer = await new Promise((resolve, reject) => {
              const promise = context.decodeAudioData(array, resolve, reject);
              if (promise && typeof promise.then === 'function') promise.then(resolve, reject);
            });
            if (!this._valid(epoch)) return { status: 'superseded' };
            const actual = buffer.length * buffer.numberOfChannels * 4;
            if (!Number.isSafeInteger(actual) || actual > estimate) throw new Error('解码音频超过预留RAM。');
            this.budget.shrink(reservation, actual, 'audio'); this.audioBudget = reservation; this.audioBuffer = buffer; transferred = true;
            this._emit('clock', { epoch, phase: 'audio-ready', start: info.audio.start, duration: buffer.duration,
              sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, bytes: actual });
          }
          if (!this._valid(epoch)) return { status: 'superseded' };
          const result = await this._request(0, { kind: 'load', final: true, inputAt: this.env.now(), preserveLoading: true, index: 0 });
          if (result.status === 'error') throw new Error(result.error); return result;
        } catch (error) {
          if (!this._valid(epoch)) return { status: 'superseded' };
          this._fail(error); throw error;
        } finally {
          if (!transferred) this.budget.release(reservation);
          if (context && (!this._valid(epoch) || !transferred)) await this._closeContext(context);
        }
      });
      this.loads.add(operation);
      try { return await operation; } finally { this.loads.delete(operation); }
    }
    _request(time, options) {
      const targetTime = Math.max(0, Math.min(this.info.duration, time));
      const ordinal = options.index === undefined ? this.index.frameAt(this.info.frames, targetTime) : options.index;
      const frame = this.info.frames[ordinal], epoch = this.epoch;
      const previous = this.target; this.targetTime = targetTime; this.ended = options.kind === 'ended';
      let target;
      const promise = new Promise(resolve => { target = { index: ordinal, frameId: frame.id, epoch, targetTime,
        requestId: ++this.requestId, inputAt: options.inputAt, kind: options.kind, final: !!options.final, resolve, effectiveEmitted: false, readyEmitted: false }; });
      // One speculative frame can make the next pointer target a RAM hit. Without
      // it, input immediately before every rAF can supersede each completed image.
      const moving = !target.final && ['drag', 'rapid'].includes(target.kind);
      if (moving && previous && !previous.final && previous.epoch === epoch && ['drag', 'rapid'].includes(previous.kind) &&
        target.inputAt > previous.inputAt && target.inputAt - previous.inputAt <= 100) {
        target.dragDelta = targetTime - previous.targetTime;
        if (target.dragDelta && Math.sign(target.dragDelta) === Math.sign(previous.dragDelta || 0)) {
          const predicted = this.index.frameAt(this.info.frames, Math.max(0, Math.min(this.info.duration, targetTime + target.dragDelta)));
          if (predicted !== ordinal) target.predictedIndex = predicted;
        }
      }
      this.target = target;
      this._emit('request', { epoch, phase: 'input', requestId: target.requestId, kind: target.kind, frameId: frame.id,
        frameOrdinal: ordinal, targetTime, inputAt: target.inputAt, final: target.final,
        workReused: this.cache.has(ordinal) || this.tasks.has(epoch + ':' + ordinal) });
      this._settle(previous, 'superseded', { reason: 'new-request' });
      if (this._valid(epoch) && this.target === target && !options.preserveLoading && options.kind !== 'play') this._change('seeking');
      // Resource work need not wait for the next display opportunity. Drawing still does.
      if (this._valid(epoch) && this.target === target) { this._startTargetWork(); this._startDragAheadWork(); }
      return promise;
    }
    _canSeek() { return !this.disposed && this.info && this.state !== 'loading' && (this.state !== 'error' || this.lastErrorCode === 'UNDERRUN'); }
    seek(time, options) {
      if (!this._canSeek() || !Number.isFinite(time)) return Promise.reject(new Error('播放器尚未就绪或定位时间无效。'));
      const settings = Object.assign({ final: false, kind: 'seek', inputAt: this.env.now() }, options || {});
      if (!Number.isFinite(settings.inputAt)) return Promise.reject(new Error('原始输入时间无效。'));
      this._halt(false); this.lastIssue = null; this.lastErrorCode = null; return this._request(time, settings);
    }
    step(delta) {
      if (!this._canSeek() || !Number.isSafeInteger(delta)) return Promise.reject(new Error('播放器尚未就绪或逐帧参数无效。'));
      const base = this.target && this.target.resolve ? this.target.index : (this.currentIndex === null ? 0 : this.currentIndex);
      const ordinal = this.index.stepIndex(this.info.frames, base, delta);
      this._halt(false); this.lastIssue = null; this.lastErrorCode = null;
      return this._request(this.info.frames[ordinal].time, { index: ordinal, final: true, kind: 'step', inputAt: this.env.now() });
    }
    async _prime(ordinal, epoch, token) {
      while (this._playValid(epoch, token)) {
        if (this.cache.has(ordinal)) return this.cache.get(ordinal);
        const existing = this.tasks.get(epoch + ':' + ordinal); if (existing) return existing.promise;
        if (this.tasks.size < 2) return this._decode(ordinal, 'play-ahead', null);
        await Promise.race(Array.from(this.tasks.values()).map(task => task.promise.catch(() => null)));
      }
      return null;
    }
    async play() {
      if (this.disposed || !this.info || this.state !== 'paused') throw new Error('播放器未处于可播放的暂停状态。');
      const epoch = this.epoch, token = ++this.playToken, context = this.audioContext;
      const resumed = context ? context.resume() : Promise.resolve(); this._change('seeking');
      try {
        await resumed; if (!this._playValid(epoch, token)) return { status: 'superseded' };
        let ordinal = this.currentIndex === null ? 0 : this.currentIndex;
        if (this.ended || this.time >= this.info.duration) {
          const result = await this._request(0, { kind: 'restart', final: true, index: 0, inputAt: this.env.now() });
          if (!['drawn', 'reused'].includes(result.status) || !this._playValid(epoch, token)) return { status: 'superseded' };
          ordinal = 0; this._change('seeking');
        }
        for (let offset = 0; offset < 4 && ordinal + offset < this.info.frames.length; offset++) {
          await this._prime(ordinal + offset, epoch, token); if (!this._playValid(epoch, token)) return { status: 'superseded' };
        }
        const media = this.info.frames[ordinal].time, when = context ? context.currentTime + 0.02 : null;
        this.anchor = { media, context: when, perf: this.env.now() + 20 }; this.waitingSince = null;
        if (context && this.audioBuffer) {
          const plan = this.index.audioStartPlan(media, this.info.audio.start, this.audioBuffer.duration, when);
          if (plan) {
            const source = context.createBufferSource(), gain = context.createGain(); source.buffer = this.audioBuffer;
            source.connect(gain); gain.connect(context.destination); gain.gain.setValueAtTime(1, context.currentTime);
            const graph = { source, gain, token }; this.graph = graph;
            source.onended = () => {
              if (this.graph !== graph || !this._playValid(epoch, token)) return;
              this._emit('clock', { epoch, phase: 'audio-ended-video-clock-continues', mediaTime: this._clockTime() });
            };
            source.start(plan.when, plan.offset);
          }
        }
        const audioStart = this.info.audio ? this.info.audio.start : null;
        this._change('playing');
        if (!this._playValid(epoch, token)) return { status: 'superseded' };
        this._emit('clock', { epoch, phase: 'start', mediaTime: media, audioContextStart: when,
          audioStart, clock: context ? 'audio-output-estimate' : 'monotonic' });
        return { status: 'playing' };
      } catch (error) {
        if (!this._playValid(epoch, token)) return { status: 'superseded' };
        this._fail(error); throw error;
      }
    }
    _clockTime() {
      if (!this.anchor || !this.info) return this.time;
      let elapsed;
      if (this.audioContext) {
        const context = this.audioContext; let output = context.currentTime, estimated = false;
        try {
          if (typeof context.getOutputTimestamp === 'function') {
            const stamp = context.getOutputTimestamp();
            if (Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime) && (stamp.contextTime > 0 || stamp.performanceTime > 0)) {
              output = Math.min(context.currentTime, stamp.contextTime + Math.max(0, this.env.now() - stamp.performanceTime) / 1000); estimated = true;
            }
          }
        } catch (_) { /* output estimate is optional; fallback is explicitly reported */ }
        this.clockMethod = estimated ? 'getOutputTimestamp-estimate' : 'AudioContext.currentTime-fallback-unmeasured-output-latency';
        elapsed = output - this.anchor.context;
      } else { elapsed = (this.env.now() - this.anchor.perf) / 1000; this.clockMethod = 'performance-monotonic'; }
      return Math.max(this.anchor.media, Math.min(this.info.duration, this.anchor.media + elapsed));
    }
    _halt(capture) {
      const media = capture && this.state === 'playing' ? this._clockTime() : this.time;
      ++this.playToken; const graph = this.graph; this.graph = null;
      if (graph) {
        graph.source.onended = null;
        try { graph.gain.gain.setValueAtTime(0, this.audioContext.currentTime); } catch (_) { /* closed output */ }
        try { graph.source.stop(); } catch (_) { /* already ended */ }
        try { graph.source.disconnect(); graph.gain.disconnect(); } catch (_) { /* already detached */ }
      }
      this.anchor = null; this.waitingSince = null; return media;
    }
    pause() {
      const wasPlaying = this.state === 'playing', media = this._halt(true);
      if (this.disposed || !this.info || this.state === 'loading' || this.state === 'error') return Promise.resolve({ status: 'ignored', reason: 'not-ready' });
      if (wasPlaying) return this._request(media, { final: true, kind: 'pause', inputAt: this.env.now() });
      if (this.state === 'seeking' && !(this.target && this.target.resolve)) this._change('paused');
      return Promise.resolve({ status: 'paused' });
    }
    _closeEntry(entry) {
      try { entry.bitmap.close(); } catch (error) { this.telemetryIssue = error.message; }
      this.budget.release(entry.budget);
    }
    _evict() {
      let victim = null;
      for (const entry of this.cache.values()) {
        if (entry.index === this.currentIndex || (this.target && entry.index === this.target.index)) continue;
        if (!victim || entry.usedAt < victim.usedAt) victim = entry;
      }
      if (!victim) return false;
      this.cache.delete(victim.index); this._closeEntry(victim);
      this._emit('cache', { phase: 'evict', frameId: victim.id, budgetBytes: this.budget.used }); return true;
    }
    _clearCache() { for (const entry of this.cache.values()) this._closeEntry(entry); this.cache.clear(); }
    _startTargetWork() {
      const target = this.target;
      if (!this.info || !target || !target.resolve || !this._valid(target.epoch) || this.state === 'error') return;
      if (this.cache.has(target.index) || this.tasks.has(target.epoch + ':' + target.index) || this.tasks.size >= 2) return;
      try { this._decode(target.index, 'target', target); } catch (error) { this._fail(error); }
    }
    _startDragAheadWork() {
      const target = this.target, ordinal = target && target.predictedIndex;
      if (!this.info || !target || !this._valid(target.epoch) || this.state === 'error' || !Number.isInteger(ordinal) ||
        this.tasks.size >= 2 || this.cache.has(ordinal) || this.tasks.has(target.epoch + ':' + ordinal) || this.prefetchFailed.has(ordinal)) return;
      // Latest real target owns the first slot. A prediction is cache work only;
      // it never becomes a seek target or gets permission to draw.
      if (!this.cache.has(target.index) && !this.tasks.has(target.epoch + ':' + target.index)) return;
      try { this._decode(ordinal, 'drag-ahead', null); } catch (error) { this._fail(error); }
    }
    _decode(ordinal, role, request) {
      const epoch = this.epoch, info = this.info, key = epoch + ':' + ordinal;
      const existing = this.tasks.get(key); if (existing) return existing.promise;
      if (this.tasks.size >= 2) throw new Error('图像任务超过两个在途槽。');
      const frame = info.frames[ordinal], holder = { epoch, index: ordinal, role, promise: null };
      this.tasks.set(key, holder);
      const task = Promise.resolve().then(async () => {
        let reservation = null, bitmap = null, transferred = false;
        try {
          if (!this._valid(epoch)) return null;
          if (role === 'target' && (!this.target || this.target.index !== ordinal)) return null;
          if (role === 'drag-ahead' && (!this.target || this.target.index !== ordinal && this.target.predictedIndex !== ordinal)) return null;
          const rgba = info.width * info.height * 4;
          reservation = this.budget.reserve(rgba + frame.bytes * 2, 'frame-inflight', () => this._evict());
          const readStartedAt = this.env.now();
          const bytes = await this.readAsset(info, frame.file);
          const readEndedAt = this.env.now();
          if (!bytes || bytes.byteLength !== frame.bytes) throw new Error('JPEG资源长度与清单不符。');
          if (!this._valid(epoch)) return null;
          // Obsolete foreground reads need not turn into another expensive decode.
          if (role === 'target' && (!this.target || this.target.index !== ordinal)) return null;
          if (role === 'drag-ahead' && (!this.target || this.target.index !== ordinal && this.target.predictedIndex !== ordinal)) return null;
          const delay = this.decodeDelayMs, decodeStartedAt = this.env.now();
          bitmap = await this.env.decodeImage(bytes);
          const decodeEndedAt = this.env.now();
          // Test delay models service that has already entered the non-cancellable decoder.
          // An obsolete result can populate this material's bounded LRU, never its canvas.
          if (delay) await this.env.sleep(delay);
          if (!this._valid(epoch)) return null;
          if (!bitmap || bitmap.width !== info.width || bitmap.height !== info.height) throw new Error('JPEG解码尺寸与索引不符。');
          this.budget.shrink(reservation, rgba, 'decoded-frame');
          const entry = { index: ordinal, id: frame.id, bitmap, budget: reservation, readyAt: this.env.now(), usedAt: this.env.now() };
          this.cache.set(ordinal, entry); transferred = true;
          this._emit('ready', { epoch, phase: 'read-and-image-decode-complete', requestId: request ? request.requestId : null,
            kind: request ? request.kind : role, frameId: frame.id, readyAt: entry.readyAt, inputAt: request ? request.inputAt : null,
            readStartedAt, readEndedAt, readMs: readEndedAt - readStartedAt,
            decodeStartedAt, decodeEndedAt, decodeMs: decodeEndedAt - decodeStartedAt,
            injectedDelayMs: delay, decoderServiceMs: entry.readyAt - decodeStartedAt,
            delayModel: 'non-cancellable-service-after-decode-entry-v2',
            stillTarget: !!this.target && this.target.epoch === epoch && this.target.index === ordinal, budgetBytes: this.budget.used });
          return entry;
        } finally {
          if (!transferred) { if (bitmap) { try { bitmap.close(); } catch (_) { /* best effort */ } } this.budget.release(reservation); }
          if (this.tasks.get(key) === holder) this.tasks.delete(key);
          this._emit('cache', { epoch, phase: 'image-work-ended', frameId: frame.id, activeImageTasks: this.tasks.size, budgetBytes: this.budget.used });
        }
      });
      holder.promise = task;
      this._emit('cache', { epoch, phase: 'image-work-start', frameId: frame.id, role, activeImageTasks: this.tasks.size });
      task.then(() => { this._startTargetWork(); this._startDragAheadWork(); }, error => {
        if (this._valid(epoch)) {
          if (this.target && this.target.resolve && this.target.index === ordinal) this._fail(error);
          else { this.prefetchFailed.add(ordinal); this._emit('error', { epoch, phase: 'background-image', frameId: frame.id, error: error.message }); }
        }
        this._startTargetWork(); this._startDragAheadWork();
      });
      return task;
    }
    _draw(target, entry) {
      if (!target.readyEmitted) {
        target.readyEmitted = true;
        this._emit('ready', { epoch: target.epoch, phase: 'effective-target-available', requestId: target.requestId,
          kind: target.kind, frameId: target.frameId, inputAt: target.inputAt, readyAt: this.env.now(),
          cachedDecodeReadyAt: entry.readyAt, cacheHit: entry.readyAt <= target.inputAt });
      }
      // No await or user callback between the final guard and the native draw.
      if (!this._valid(target.epoch) || this.target !== target || !target.resolve || target.index !== entry.index || this.cache.get(entry.index) !== entry) return;
      if (this.currentIndex === target.index) {
        // A new input can legitimately request the already displayed source frame.
        // Settle it explicitly without a canvas submission or fabricated draw sample.
        entry.usedAt = this.env.now(); this.waitingSince = null;
        if (this.state !== 'playing') this.state = 'paused';
        this._settle(target, 'reused', { time: this.time, settledAt: this.env.now(), targetTime: target.targetTime,
          responseMs: this.env.now() - target.inputAt, repeatedFrame: true, drawAt: null });
        if (this._valid(target.epoch) && this.target === target) this._change();
        return;
      }
      this.ctx.drawImage(entry.bitmap, 0, 0, this.info.width, this.info.height);
      const drawAt = this.env.now(), info = this.info, frame = info.frames[target.index], repeated = this.currentIndex === target.index;
      const gap = this.lastDrawAt === null ? null : drawAt - this.lastDrawAt;
      if (gap !== null) this.maxDrawGapMs = Math.max(this.maxDrawGapMs, gap);
      this.lastDrawAt = drawAt; this.waitingSince = null; this.currentIndex = target.index; this.time = frame.time;
      entry.usedAt = drawAt; ++this.drawCount; if (this.state !== 'playing') this.state = 'paused';
      let barcode = null;
      if (this.verifyMarkers && info.expected) {
        try { barcode = readBarcode(this.ctx, info.expected, target.index); }
        catch (error) { barcode = { actual: null, expected: null, ok: null, uncertain: true, error: error.message }; }
      }
      const event = { epoch: target.epoch, requestId: target.requestId, kind: target.kind, frameId: frame.id, frameOrdinal: target.index,
        time: frame.time, targetTime: target.targetTime, mediaTime: this.state === 'playing' ? this._clockTime() : frame.time,
        inputAt: target.inputAt, readyAt: entry.readyAt, drawAt, responseMs: drawAt - target.inputAt,
        budgetBytes: this.budget.used, cachePeakBytes: this.budget.peak, rafOpportunity: this.rafCount, repeatedFrame: repeated,
        sincePreviousDrawMs: gap, barcode, markerVerificationEnabled: this.verifyMarkers, markerReadbackCostIncludedAfterDraw: true,
        physicalDisplayTime: null, note: 'canvas submission; no physical-screen measurement' };
      this._settle(target, 'drawn', { time: frame.time, drawAt }); this._emit('draw', event);
      if (this._valid(target.epoch) && this.target === target) this._change();
    }
    _pump() {
      const target = this.target;
      if (this.info && target && target.resolve && this.state !== 'error') {
        if (!target.effectiveEmitted) {
          target.effectiveEmitted = true; this._emit('request', { epoch: target.epoch, phase: 'effective-frame', requestId: target.requestId,
            kind: target.kind, frameId: target.frameId, targetTime: target.targetTime, inputAt: target.inputAt });
        }
        if (this.target !== target || !this._valid(target.epoch)) return;
        const entry = this.cache.get(target.index);
        if (entry) this._draw(target, entry);
        else this._startTargetWork();
      }
      if (!this.info || this.state === 'loading' || this.state === 'error' || this.disposed) return;
      // During drag only the latest target and its one motion prediction use
      // slots; unrelated sequential neighbours wait until final release.
      if (this.target && this.target.resolve) return;
      if (this.state !== 'playing' && this.target && !this.target.final && ['drag', 'rapid'].includes(this.target.kind)) return;
      const base = this.currentIndex, playing = this.state === 'playing';
      const maximumTasks = playing ? 2 : 1, ahead = playing ? 12 : 3;
      for (let offset = 1; base !== null && offset <= ahead && base + offset < this.info.frames.length && this.tasks.size < maximumTasks; offset++) {
        const ordinal = base + offset;
        if (playing && this.info.frames[ordinal].time - this.info.frames[base].time > 0.3) break;
        if (!this.cache.has(ordinal) && !this.tasks.has(this.epoch + ':' + ordinal) && !this.prefetchFailed.has(ordinal)) this._decode(ordinal, playing ? 'play-ahead' : 'neighbour', null);
      }
    }
    _schedule() { if (!this.disposed) this.rafId = this.env.raf(() => this._tick()); }
    _tick() {
      this.rafId = null; if (this.disposed) return; ++this.rafCount;
      try {
        if (this.info && this.state === 'playing') {
          const epoch = this.epoch, media = this._clockTime(), ordinal = this.index.frameAt(this.info.frames, media);
          if (media >= this.info.duration) {
            this._halt(false); this._request(this.info.duration, { kind: 'ended', final: true, inputAt: this.env.now() });
          } else if (ordinal !== this.currentIndex && (!this.target || this.target.index !== ordinal || !this.target.resolve)) {
            this._request(media, { kind: 'play', inputAt: this.env.now() });
          }
          if (this._valid(epoch) && this.state === 'playing') {
            // Count missing supply only after a *new source frame* becomes due. A low-fps hold is not an underrun.
            if (ordinal !== this.currentIndex && !this.cache.has(ordinal)) {
              if (this.waitingSince === null) this.waitingSince = this.env.now();
              if (this.env.now() - this.waitingSince > this.playbackGuardMs) {
                const error = new Error('画面供应不足，已停止声音；没有回退普通播放器。'); error.code = 'UNDERRUN'; this._fail(error);
              }
            } else this.waitingSince = null;
            if (this.env.now() - this.lastClockEmit >= 250) {
              this.lastClockEmit = this.env.now(); this._emit('clock', { epoch, phase: 'sample', mediaTime: media, method: this.clockMethod, rafOpportunity: this.rafCount });
            }
          }
        }
        this._pump();
      } catch (error) { this._fail(error); }
      this._schedule();
    }
    _fail(error) {
      this._halt(false); this.lastIssue = error.message; this.lastErrorCode = error.code || null;
      const target = this.target; this.state = 'error'; this._settle(target, 'error', { error: error.message, code: error.code || null });
      this._emit('error', { error: error.message, code: error.code || null }); this._change();
    }
    async _closeContext(context) {
      try { if (context && context.state !== 'closed') await context.close(); } catch (error) { this.telemetryIssue = error.message; }
      this.contexts.delete(context);
    }
    async dispose() {
      if (this.disposePromise) return this.disposePromise;
      this.disposed = true; ++this.epoch; this._halt(false); if (this.rafId !== null) this.env.caf(this.rafId);
      this._clearTarget('disposed'); this._clearCache(); this.audioBuffer = null; this.budget.release(this.audioBudget); this.audioBudget = null;
      this._change('disposed');
      this.disposePromise = (async () => {
        await Promise.allSettled(Array.from(this.contexts).map(context => this._closeContext(context)));
        await Promise.allSettled(Array.from(this.loads).concat(Array.from(this.tasks.values()).map(task => task.promise)));
        this.audioContext = null; this.info = null; this._emit('cache', { phase: 'disposed', budgetBytes: this.budget.used });
      })();
      return this.disposePromise;
    }
  }
  return { Player, Budget, ManagedBudget: Budget, readBarcode };
});
