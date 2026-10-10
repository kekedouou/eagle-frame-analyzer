/* S1 only: one canvas, source-frame index, bounded decoded cache and audio clock. */
(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  // Eagle's renderer can expose both window and CommonJS module at once.
  if (typeof window === 'object' && window) window.S1Player = exported;
  else if (root && root.document) root.S1Player = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MIB = 1024 * 1024;
  function frameAt(frames, time) {
    if (!frames || !frames.length || !Number.isFinite(time)) throw new Error('无效帧索引或时间。');
    let low = 0, high = frames.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (frames[mid].time <= time) low = mid + 1; else high = mid;
    }
    return Math.max(0, low - 1);
  }
  function audioStartPlan(mediaTime, audioStart, audioDuration, when) {
    const offset = Math.max(0, mediaTime - audioStart);
    return offset >= audioDuration ? null : { when: when + Math.max(0, audioStart - mediaTime), offset: offset };
  }
  class Budget {
    constructor(limit) { this.limit = limit; this.used = 0; this.peak = 0; this.tokens = new Set(); }
    reserve(bytes, kind, evict) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('缓存预留字节无效。');
      if (bytes > this.limit) throw new Error('单次缓存预留超过 RAM 预算。');
      while (this.used + bytes > this.limit && evict && evict()) { /* bounded entries */ }
      if (this.used + bytes > this.limit) throw new Error('RAM 缓存预算不足，固定资源不能淘汰。');
      const token = { bytes: bytes, kind: kind };
      this.tokens.add(token); this.used += bytes; this.peak = Math.max(this.peak, this.used); return token;
    }
    shrink(token, bytes, kind) {
      if (!this.tokens.has(token) || bytes > token.bytes || bytes < 0) throw new Error('无效缓存预留转移。');
      this.used -= token.bytes - bytes; token.bytes = bytes; token.kind = kind;
    }
    release(token) { if (token && this.tokens.delete(token)) { this.used -= token.bytes; token.bytes = 0; } }
    snapshot() {
      const kinds = {};
      this.tokens.forEach(token => { kinds[token.kind] = (kinds[token.kind] || 0) + token.bytes; });
      return { used: this.used, peak: this.peak, limit: this.limit, kinds: kinds };
    }
  }
  function readBarcode(context, expected, index) {
    const spec = expected && expected.barcode;
    if (!spec || !expected.barcodes || expected.barcodes[index] === undefined) return null;
    const x = spec.x + spec.sampleXOffset, y = spec.y + spec.sampleYOffset;
    const pixels = context.getImageData(x, y, (spec.bits - 1) * spec.step + 1, 1).data;
    let actual = 0, uncertain = false; const samples = [];
    for (let bit = 0; bit < spec.bits; bit++) {
      const at = bit * spec.step * 4;
      const value = (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3;
      samples.push(value);
      if (value < 80) { /* zero */ } else if (value > 175) actual += 2 ** bit; else uncertain = true;
    }
    return { actual: uncertain ? null : actual, expected: expected.barcodes[index],
      ok: uncertain ? null : actual === expected.barcodes[index], uncertain: uncertain, samples: samples,
      method: 'canvas-pixel-barcode-lsb-left-single-row-readback' };
  }
  function browserEnvironment() {
    return {
      now: () => performance.now(), raf: callback => requestAnimationFrame(callback), caf: id => cancelAnimationFrame(id),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      decodeImage: bytes => createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })),
      createAudioContext: () => new (globalThis.AudioContext || globalThis.webkitAudioContext)()
    };
  }
  class Player {
    constructor(options) {
      if (!options || !options.canvas || typeof options.readAsset !== 'function') throw new Error('缺少画布或受限资产读取函数。');
      this.env = Object.assign(browserEnvironment(), options.env || {});
      this.canvas = options.canvas; this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.readAsset = options.readAsset; this.emit = options.emit || (() => {}); this.onChange = options.onChange || (() => {});
      this.budget = new Budget(options.ramBytes === undefined ? 512 * MIB : options.ramBytes);
      this.state = 'empty'; this.info = null; this.epoch = 0; this.playToken = 0; this.requestId = 0;
      this.cache = new Map(); this.tasks = new Map(); this.foreground = null; this.prefetch = null; this.prefetchFailed = new Set();
      this.target = null; this.time = 0; this.currentIndex = null; this.targetTime = 0;
      this.audioContext = null; this.audioBuffer = null; this.audioBudget = null; this.graph = null; this.anchor = null;
      this.contexts = new Set(); this.loads = new Set(); this.decodeDelayMs = 0; this.verifyMarkers = true;
      this.rafCount = 0; this.drawCount = 0; this.lastDrawAt = null; this.maxDrawGapMs = 0; this.lastClockEmit = -Infinity;
      this.lastIssue = null; this.rafId = null; this.disposed = false; this.disposePromise = null; this.ended = false;
      this._schedule();
    }
    _emit(type, values) {
      try { this.emit(Object.assign({ type: type, at: this.env.now(), epoch: this.epoch }, values || {})); }
      catch (error) { this.telemetryIssue = error.message; }
    }
    _change(state) {
      if (state) this.state = state;
      this._emit('state', { state: this.state });
      try { this.onChange(this.snapshot()); } catch (error) { this.telemetryIssue = error.message; }
    }
    snapshot() {
      const ledger = this.budget.snapshot();
      return { state: this.state, time: this.time, frameId: this.currentIndex === null || !this.info ? null : this.info.frames[this.currentIndex].id,
        targetTime: this.targetTime, targetFrameId: this.target && this.info ? this.info.frames[this.target.index].id : null,
        cacheBytes: ledger.used, cachePeakBytes: ledger.peak, budget: ledger, audioAvailable: !!this.audioBuffer,
        decodeDelayMs: this.decodeDelayMs, verifyMarkers: this.verifyMarkers, epoch: this.epoch, drawCount: this.drawCount,
        rafOpportunity: this.rafCount, maxDrawGapMs: this.maxDrawGapMs, lastIssue: this.lastIssue,
        telemetryIssue: this.telemetryIssue || null,
        memoryScope: 'managed decoded RGBA + AudioBuffer + compressed/copy reservations; browser/GPU/internal decoder copies excluded' };
    }
    setDecodeDelay(ms) {
      if (!Number.isFinite(ms) || ms < 0 || ms > 2000) throw new Error('解码延迟须在 0～2000ms。');
      this.decodeDelayMs = ms; this._change();
    }
    setVerifyMarkers(enabled) { this.verifyMarkers = !!enabled; this._change(); }
    _validate(info) {
      if (!info || !Array.isArray(info.frames) || !info.frames.length || !(info.duration > 0)
        || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width <= 0 || info.height <= 0)
        throw new Error('缓存信息不完整。');
      const ids = new Set();
      info.frames.forEach((frame, index) => {
        if (!Number.isFinite(frame.time) || !Number.isFinite(frame.end) || frame.end < frame.time
          || (index && frame.time < info.frames[index - 1].time) || ids.has(frame.id)
          || !Number.isSafeInteger(frame.bytes) || frame.bytes <= 0 || typeof frame.file !== 'string') throw new Error('帧索引无效。');
        ids.add(frame.id);
      });
      if (info.audio && (!(info.audio.duration > 0) || !Number.isFinite(info.audio.start)
        || !Number.isSafeInteger(info.audio.bytes) || info.audio.bytes <= 0
        || !Number.isSafeInteger(info.audio.channels) || info.audio.channels <= 0)) throw new Error('音频索引无效。');
    }
    async load(info) {
      if (this.disposed) throw new Error('播放器已释放。');
      this._validate(info);
      const epoch = ++this.epoch; this._halt(false); this._settleTarget('superseded', 'material-switch');
      this._clearCache(); const oldContext = this.audioContext;
      this.audioContext = null; this.audioBuffer = null; this.budget.release(this.audioBudget); this.audioBudget = null;
      this.info = info; this.time = 0; this.targetTime = 0; this.currentIndex = null; this.lastIssue = null; this.prefetchFailed.clear();
      this.canvas.width = info.width; this.canvas.height = info.height;
      this._change('loading');
      const task = (async () => {
        let context = null, reservation = null, transferred = false;
        try {
          if (oldContext) await this._closeContext(oldContext);
          if (epoch !== this.epoch || this.disposed) return { status: 'superseded' };
          if (info.audio) {
            context = this.env.createAudioContext(); this.contexts.add(context); this.audioContext = context;
            const estimate = Math.ceil((info.audio.duration + 0.1) * context.sampleRate * info.audio.channels) * 4;
            reservation = this.budget.reserve(estimate + info.audio.bytes * 2, 'audio-loading', () => this._evict());
            const bytes = await this.readAsset(info, info.audio.file);
            if (bytes.byteLength !== info.audio.bytes) throw new Error('音频资产长度与清单不符。');
            if (epoch !== this.epoch || this.disposed) return { status: 'superseded' };
            const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            const buffer = await new Promise((resolve, reject) => {
              const decoded = context.decodeAudioData(array, resolve, reject);
              if (decoded && typeof decoded.then === 'function') decoded.then(resolve, reject);
            });
            if (epoch !== this.epoch || this.disposed) return { status: 'superseded' };
            const actual = buffer.length * buffer.numberOfChannels * 4;
            if (actual > estimate) throw new Error('解码音频超出预留 RAM，停止实验。');
            this.budget.shrink(reservation, actual, 'audio'); this.audioBudget = reservation; this.audioBuffer = buffer; transferred = true;
            this._emit('clock', { phase: 'audio-ready', start: info.audio.start, duration: buffer.duration,
              sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, bytes: actual });
          }
          if (epoch !== this.epoch || this.disposed) return { status: 'superseded' };
          const result = await this._request(0, { kind: 'load', final: true, inputAt: this.env.now(), preserveLoading: true, index: 0 });
          if (result.status === 'error') throw new Error(result.error);
          return result;
        } catch (error) {
          if (epoch === this.epoch && !this.disposed) this._fail(error);
          throw error;
        } finally {
          if (!transferred) this.budget.release(reservation);
          if (context && (epoch !== this.epoch || this.disposed || !transferred)) await this._closeContext(context);
        }
      })();
      this.loads.add(task);
      try { return await task; } finally { this.loads.delete(task); }
    }
    _settleTarget(status, reason) {
      const target = this.target;
      if (target && target.resolve) {
        target.resolve({ status: status, requestId: target.requestId, frameId: this.info && this.info.frames[target.index] ? this.info.frames[target.index].id : null, reason: reason });
        this._emit(status === 'superseded' ? 'superseded' : 'error', { requestId: target.requestId, kind: target.kind, reason: reason });
        target.resolve = null;
      }
      this.target = null;
    }
    _request(time, options) {
      const targetTime = Math.min(this.info.duration, Math.max(0, time));
      const index = options.index === undefined ? frameAt(this.info.frames, targetTime) : options.index, requestId = ++this.requestId;
      this.ended = options.kind === 'ended';
      this._settleTarget('superseded', 'new-request'); this.targetTime = targetTime;
      const promise = new Promise(resolve => {
        this.target = { index: index, targetTime: targetTime, requestId: requestId, epoch: this.epoch,
          inputAt: options.inputAt, kind: options.kind, final: !!options.final, resolve: resolve, readyEmitted: false };
      });
      this._emit('request', { requestId: requestId, kind: options.kind, frameId: this.info.frames[index].id,
        targetTime: targetTime, inputAt: options.inputAt, final: !!options.final, phase: 'input',
        workReused: this.tasks.has(this.epoch + ':' + index) || this.cache.has(index) });
      if (!options.preserveLoading && options.kind !== 'play') this._change('seeking');
      return promise;
    }
    seek(time, options) {
      options = Object.assign({ final: false, kind: 'seek', inputAt: this.env.now() }, options || {});
      if (this.disposed || !this.info || this.state === 'loading' || this.state === 'error') return Promise.reject(new Error('播放器尚未就绪。'));
      if (!Number.isFinite(time)) return Promise.reject(new Error('无效定位时间。'));
      this._halt(false); return this._request(time, options);
    }
    step(delta) {
      if (!Number.isSafeInteger(delta) || !this.info) return Promise.reject(new Error('无效逐帧操作。'));
      const index = this.target ? this.target.index : (this.currentIndex === null ? 0 : this.currentIndex);
      const next = Math.max(0, Math.min(this.info.frames.length - 1, index + delta));
      if (this.disposed || this.state === 'loading' || this.state === 'error') return Promise.reject(new Error('播放器尚未就绪。'));
      this._halt(false);
      return this._request(this.info.frames[next].time, { index: next, final: true, kind: 'step', inputAt: this.env.now() });
    }
    async play() {
      if (this.disposed || !this.info || this.state !== 'paused') throw new Error('播放器未处于可播放的暂停状态。');
      const token = ++this.playToken, epoch = this.epoch, context = this.audioContext;
      // resume is invoked before the first await to retain the user's activation gesture.
      const resumed = context ? context.resume() : Promise.resolve();
      this._change('seeking');
      try {
        await resumed;
        if (!this._playValid(epoch, token)) return { status: 'superseded' };
        let index = this.currentIndex === null ? 0 : this.currentIndex;
        if (this.time >= this.info.duration || this.ended) {
          const reset = await this._request(0, { kind: 'restart', final: true, inputAt: this.env.now() });
          if (reset.status !== 'drawn' || !this._playValid(epoch, token)) return { status: 'superseded' };
          index = 0;
        }
        // Only a short, bounded lead is required; the complete sequence remains on disk.
        for (let offset = 0; offset < 4 && index + offset < this.info.frames.length; offset++) {
          await this._prime(index + offset, epoch);
          if (!this._playValid(epoch, token)) return { status: 'superseded' };
        }
        const media = this.info.frames[index].time, when = context ? context.currentTime + 0.02 : null;
        this.anchor = { media: media, context: when, perf: this.env.now() + 20 };
        if (context && this.audioBuffer) {
          const plan = audioStartPlan(media, this.info.audio.start, this.audioBuffer.duration, when);
          if (plan) {
            const source = context.createBufferSource(), gain = context.createGain(); source.buffer = this.audioBuffer;
            source.connect(gain); gain.connect(context.destination); gain.gain.setValueAtTime(1, context.currentTime);
            const graph = { source: source, gain: gain, token: token }; this.graph = graph;
            source.onended = () => {
              if (this.graph !== graph || !this._playValid(epoch, token)) return;
              this._emit('clock', { phase: 'audio-ended-video-clock-continues', mediaTime: this._clockTime() });
            };
            source.start(plan.when, plan.offset);
          }
        }
        this.time = media; this.lastDrawAt = this.env.now(); this._change('playing');
        this._emit('clock', { phase: 'start', mediaTime: media, audioContextStart: when,
          audioStart: this.info.audio ? this.info.audio.start : null, clock: context ? 'audio-output-estimate' : 'monotonic' });
        return { status: 'playing' };
      } catch (error) { if (this._playValid(epoch, token)) this._fail(error); throw error; }
    }
    _playValid(epoch, token) { return !this.disposed && epoch === this.epoch && token === this.playToken; }
    _clockTime() {
      if (!this.anchor) return this.time;
      let elapsed;
      if (this.audioContext) {
        const context = this.audioContext; let output = context.currentTime; let estimated = false;
        if (typeof context.getOutputTimestamp === 'function') {
          const stamp = context.getOutputTimestamp();
          if (Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime) && (stamp.contextTime > 0 || stamp.performanceTime > 0)) {
            output = stamp.contextTime + Math.max(0, this.env.now() - stamp.performanceTime) / 1000; estimated = true;
          }
        }
        this.clockMethod = estimated ? 'getOutputTimestamp-estimate' : 'AudioContext.currentTime-fallback-unmeasured-output-latency';
        elapsed = output - this.anchor.context;
      } else { this.clockMethod = 'performance-monotonic'; elapsed = (this.env.now() - this.anchor.perf) / 1000; }
      return Math.min(this.info.duration, Math.max(this.anchor.media, this.anchor.media + elapsed));
    }
    _halt(capture) {
      const media = capture && this.state === 'playing' ? this._clockTime() : this.time;
      ++this.playToken;
      const graph = this.graph; this.graph = null;
      if (graph) {
        graph.source.onended = null;
        try { graph.gain.gain.setValueAtTime(0, this.audioContext.currentTime); } catch (_) { /* disposed context */ }
        try { graph.source.stop(); } catch (_) { /* already ended */ }
        try { graph.source.disconnect(); graph.gain.disconnect(); } catch (_) { /* already disconnected */ }
      }
      this.anchor = null; return media;
    }
    pause() {
      const wasPlaying = this.state === 'playing', media = this._halt(true);
      if (this.disposed || !this.info) return Promise.resolve({ status: 'paused' });
      if (wasPlaying) return this._request(media, { final: true, kind: 'pause', inputAt: this.env.now() });
      if (this.state === 'seeking' && !this.target) this._change('paused');
      return Promise.resolve({ status: 'paused' });
    }
    _evict() {
      let victim = null;
      for (const entry of this.cache.values()) {
        if (entry.index === this.currentIndex || (this.target && entry.index === this.target.index)) continue;
        if (!victim || entry.usedAt < victim.usedAt) victim = entry;
      }
      if (!victim) return false;
      this.cache.delete(victim.index); victim.bitmap.close(); this.budget.release(victim.budget);
      this._emit('cache', { phase: 'evict', frameId: victim.id, budgetBytes: this.budget.used }); return true;
    }
    _clearCache() {
      for (const entry of this.cache.values()) { entry.bitmap.close(); this.budget.release(entry.budget); }
      this.cache.clear();
    }
    async _prime(index, epoch) {
      if (this.cache.has(index)) return this.cache.get(index);
      const existing = this.tasks.get(epoch + ':' + index); if (existing) return existing;
      if (this.foreground) { await this.foreground.promise.catch(() => {}); if (epoch !== this.epoch || this.disposed) return null; return this._prime(index, epoch); }
      return this._decode(index, 'foreground', null);
    }
    _decode(index, slot, request) {
      const epoch = this.epoch, info = this.info, frame = info.frames[index], key = epoch + ':' + index;
      if (this.tasks.has(key)) return this.tasks.get(key);
      const holder = { promise: null }; this[slot] = holder;
      const task = (async () => {
        let reservation = null, bitmap = null, transferred = false;
        try {
          const rgbaBytes = info.width * info.height * 4;
          reservation = this.budget.reserve(rgbaBytes + frame.bytes * 2, 'frame-inflight', () => this._evict());
          const bytes = await this.readAsset(info, frame.file);
          if (bytes.byteLength !== frame.bytes) throw new Error('JPEG 资产长度与清单不符。');
          if (epoch !== this.epoch || this.disposed) return null;
          const delay = this.decodeDelayMs; if (delay) await this.env.sleep(delay);
          if (epoch !== this.epoch || this.disposed) return null;
          bitmap = await this.env.decodeImage(bytes);
          if (epoch !== this.epoch || this.disposed) return null;
          if (bitmap.width !== info.width || bitmap.height !== info.height) throw new Error('JPEG 尺寸与索引不符。');
          this.budget.shrink(reservation, rgbaBytes, 'decoded-frame');
          const entry = { index: index, id: frame.id, bitmap: bitmap, budget: reservation, usedAt: this.env.now(), readyAt: this.env.now() };
          this.cache.set(index, entry); transferred = true;
          this._emit('ready', { requestId: request ? request.requestId : null, kind: request ? request.kind : 'prefetch',
            frameId: frame.id, readyAt: entry.readyAt, inputAt: request ? request.inputAt : null, phase: 'read-and-image-decode-complete',
            stillTarget: !!this.target && this.target.index === index && this.target.epoch === epoch, budgetBytes: this.budget.used });
          return entry;
        } finally {
          if (!transferred) { if (bitmap) bitmap.close(); this.budget.release(reservation); }
          if (this[slot] === holder) this[slot] = null;
        }
      })();
      holder.promise = task; this.tasks.set(key, task);
      const forget = () => { if (this.tasks.get(key) === task) this.tasks.delete(key); };
      task.then(forget, forget);
      // A decode can become irrelevant; its rejection must still be observed.
      task.catch(error => {
        if (epoch !== this.epoch || this.disposed) return;
        if (this.target && this.target.index === index) this._fail(error);
        else { this.prefetchFailed.add(index); this._emit('error', { phase: 'prefetch', error: error.message, frameId: frame.id }); }
      });
      return task;
    }
    _draw(target, entry) {
      // No await may be inserted between this guard and drawImage.
      if (this.disposed || target !== this.target || target.epoch !== this.epoch || target.index !== entry.index) return;
      const frame = this.info.frames[target.index], drawAt = this.env.now();
      if (!target.readyEmitted) {
        target.readyEmitted = true;
        this._emit('ready', { requestId: target.requestId, kind: target.kind, frameId: frame.id, inputAt: target.inputAt,
          readyAt: drawAt, phase: 'effective-target-available', cachedDecodeReadyAt: entry.readyAt, cacheHit: entry.readyAt <= target.inputAt });
      }
      this.ctx.drawImage(entry.bitmap, 0, 0, this.info.width, this.info.height);
      const submitted = this.env.now(), repeated = this.currentIndex === target.index;
      const gap = this.lastDrawAt === null ? null : submitted - this.lastDrawAt;
      if (gap !== null) this.maxDrawGapMs = Math.max(this.maxDrawGapMs, gap);
      this.lastDrawAt = submitted; entry.usedAt = submitted; this.currentIndex = target.index; this.time = frame.time; ++this.drawCount;
      let barcode = null;
      if (this.verifyMarkers && this.info.expected) barcode = readBarcode(this.ctx, this.info.expected, target.index);
      this._emit('draw', { requestId: target.requestId, kind: target.kind, frameId: frame.id, time: frame.time,
        targetTime: target.targetTime, mediaTime: this.state === 'playing' ? this._clockTime() : frame.time,
        inputAt: target.inputAt, readyAt: entry.readyAt, drawAt: submitted, responseMs: submitted - target.inputAt,
        budgetBytes: this.budget.used, cachePeakBytes: this.budget.peak, rafOpportunity: this.rafCount, repeatedFrame: repeated, sincePreviousDrawMs: gap,
        barcode: barcode, markerVerificationEnabled: this.verifyMarkers, markerReadbackCostIncludedAfterDraw: true,
        physicalDisplayTime: null, note: 'one canvas submission per rAF opportunity; no physical-display measurement' });
      if (target.resolve) { target.resolve({ status: 'drawn', requestId: target.requestId, frameId: frame.id, time: frame.time, drawAt: submitted }); target.resolve = null; }
      if (this.state !== 'playing') this._change('paused');
      else { try { this.onChange(this.snapshot()); } catch (error) { this.telemetryIssue = error.message; } }
    }
    _schedule() { if (!this.disposed) this.rafId = this.env.raf(timestamp => this._tick(timestamp)); }
    _tick() {
      this.rafId = null; if (this.disposed) return; ++this.rafCount;
      try {
        if (this.info && this.state === 'playing') {
          const media = this._clockTime(), index = frameAt(this.info.frames, media);
          if (media >= this.info.duration) { this._halt(false); this._request(this.info.duration, { kind: 'ended', final: true, inputAt: this.env.now() }); }
          else if (index !== this.currentIndex && (!this.target || this.target.index !== index || !this.target.resolve)) {
            this._request(media, { kind: 'play', final: false, inputAt: this.env.now() });
          }
          if (this.env.now() - this.lastClockEmit >= 250) {
            this.lastClockEmit = this.env.now(); this._emit('clock', { phase: 'sample', mediaTime: media, method: this.clockMethod, rafOpportunity: this.rafCount });
          }
          if (this.state === 'playing' && index !== this.currentIndex && !this.cache.has(index)
            && this.lastDrawAt !== null && this.env.now() - this.lastDrawAt > 150) {
            this._halt(false); this.lastIssue = '画面供应不足，已暂停声音；未回退普通播放器。';
            this._emit('error', { code: 'UNDERRUN', error: this.lastIssue, mediaTime: media });
            this._change('seeking');
          }
        }
        const target = this.target;
        if (this.info && target && target.resolve && this.state !== 'error') {
          if (!target.effectiveEmitted) {
            target.effectiveEmitted = true;
            this._emit('request', { phase: 'effective-frame', requestId: target.requestId, kind: target.kind,
              frameId: this.info.frames[target.index].id, targetTime: target.targetTime, inputAt: target.inputAt });
          }
          const entry = this.cache.get(target.index);
          if (entry) this._draw(target, entry);
          else if (!this.foreground && !this.tasks.has(this.epoch + ':' + target.index)) this._decode(target.index, 'foreground', target);
        }
        if (this.info && this.state !== 'loading' && this.state !== 'error' && !this.prefetch) {
          const base = this.target ? this.target.index : this.currentIndex;
          const ahead = this.state === 'playing' ? 12 : 3;
          for (let offset = 1; base !== null && offset <= ahead && base + offset < this.info.frames.length; offset++) {
            const index = base + offset;
            if (this.state === 'playing' && this.info.frames[index].time - this.info.frames[base].time > 0.3) break;
            if (!this.cache.has(index) && !this.tasks.has(this.epoch + ':' + index) && !this.prefetchFailed.has(index)) {
              this._decode(index, 'prefetch', null); break;
            }
          }
        }
      } catch (error) { this._fail(error); }
      this._schedule();
    }
    _fail(error) {
      this._halt(false); this.lastIssue = error.message;
      const target = this.target;
      if (target && target.resolve) { target.resolve({ status: 'error', requestId: target.requestId, error: error.message }); target.resolve = null; }
      this._emit('error', { error: error.message }); this._change('error');
    }
    async _closeContext(context) {
      try { if (context && context.state !== 'closed') await context.close(); } catch (_) { /* best effort close */ }
      this.contexts.delete(context);
    }
    async dispose() {
      if (this.disposePromise) return this.disposePromise;
      this.disposed = true; ++this.epoch; this._halt(false);
      if (this.rafId !== null) this.env.caf(this.rafId);
      this._settleTarget('superseded', 'disposed'); this._clearCache();
      this.audioBuffer = null; this.budget.release(this.audioBudget); this.audioBudget = null;
      this._change('disposed');
      this.disposePromise = (async () => {
        await Promise.allSettled(Array.from(this.contexts).map(context => this._closeContext(context)));
        await Promise.allSettled(Array.from(this.loads).concat(Array.from(this.tasks.values())));
        this.audioContext = null; this.info = null;
        this._emit('cache', { phase: 'disposed', budgetBytes: this.budget.used });
      })();
      return this.disposePromise;
    }
  }
  return { Player: Player, frameAt: frameAt, audioStartPlan: audioStartPlan, Budget: Budget, readBarcode: readBarcode };
});
