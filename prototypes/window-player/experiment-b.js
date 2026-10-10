/* 实验 B 窗口逻辑：一个在途请求 + 一个最新待处理请求；两种模式共用 canvas。 */
(() => {
  'use strict';
  class LatestQueue {
    constructor(work) { this.work = work; this.sequence = 0; this.epoch = 0; this.pending = null; this.running = false; this.waiters = []; }
    request(data) {
      const job = { ...data, sequence: ++this.sequence, epoch: this.epoch };
      return new Promise(resolve => {
        job.resolve = resolve;
        if (this.pending) this.pending.job.resolve({ ...this.pending.data, dropped: true });
        this.pending = { job, data }; this.pump();
      });
    }
    async pump() {
      if (this.running) return; this.running = true;
      while (this.pending) {
        const { job } = this.pending; this.pending = null;
        try { job.resolve(await this.work(job, () => job.epoch === this.epoch)); }
        catch (error) { job.resolve({ ...job, error: error.message }); }
      }
      this.running = false; this.waiters.splice(0).forEach(resolve => resolve());
    }
    cancel() { this.epoch++; if (this.pending) { this.pending.job.resolve({ ...this.pending.data, dropped: true, cancelled: true }); this.pending = null; } }
    idle() { return this.running ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
  }
  function stats(values) {
    const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
    return { n: valid.length, meanMs: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
      p95Ms: valid.length ? valid[Math.ceil(valid.length * .95) - 1] : null };
  }
  function targets(times, count = 16) {
    let seed = 20261010; const indices = new Set();
    while (indices.size < Math.min(count, times.length - 2)) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; indices.add(1 + seed % (times.length - 2)); }
    return [...indices].map(i => (times[i] + times[i + 1]) / 2);
  }
  if (typeof document === 'undefined') { module.exports = { LatestQueue, stats, targets }; return; }
  const $ = id => document.getElementById(id);
  const S = { busy: false, active: false, epoch: 0, info: null, cache: null, baseline: null, mode: 'direct',
    rows: [], memory: [], rounds: [], phase: 'idle', lastDrawn: 0, lastTime: 0, bitmaps: 0, peakBitmaps: 0,
    truncatedRows: 0, token: 0, paintPending: new Set(), session: new Date().toISOString().replace(/[:.]/g, '-') };
  let api, backend, fs, path, video, canvas, ctx, queue, memoryTimer;
  const message = text => { $('b-status').textContent = text; };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function raf() { return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cancelAnimationFrame(id); reject(new Error('窗口无刷新机会，请保持可见。')); }, 2000);
    const id = requestAnimationFrame(t => { clearTimeout(timer); resolve(t); });
  }); }
  function controls() {
    if (!api) return;
    for (const id of ['b-inspect', 'b-height', 'b-leave']) $(id).disabled = S.busy;
    for (const id of ['b-baseline', 'b-direct', 'b-slider']) $(id).disabled = S.busy || !S.info;
    $('b-build').disabled = S.busy || !S.baseline || !!S.cache;
    $('b-cache').disabled = S.busy || !S.cache;
    $('b-compare').disabled = S.busy || !S.cache || !S.baseline;
    $('b-clean').disabled = S.busy; $('b-export').disabled = S.busy || !S.info;
    $('b-stop').disabled = !S.busy; api.controls();
  }
  function memory() {
    const m = process.memoryUsage();
    const row = { t: performance.now(), phase: S.phase, rssBytes: m.rss, heapUsedBytes: m.heapUsed,
      externalBytes: m.external, arrayBuffersBytes: m.arrayBuffers ?? null, liveBitmaps: S.bitmaps };
    S.memory.push(row); if (S.memory.length > 2400) S.memory.shift();
    if (m.rss > 1536 * 1024 ** 2 && S.busy) { stop(); message('进程 RSS 采样超过 1.5 GiB，已停止实验任务。'); }
    return row;
  }
  function stop() { S.token++; queue?.cancel(); backend?.cancel(); }
  function reset() {
    stop(); S.epoch++; S.info = null; S.cache = null; S.baseline = null; S.active = false;
    S.comparison = null; S.rows = []; S.rounds = []; S.memory = [];
    if (video) { video.style.cssText = ''; video.controls = true; canvas.hidden = true; } controls();
  }
  async function action(label, work) {
    if (S.busy) return; S.busy = true; S.phase = label; const token = ++S.token; controls();
    try { await queue.idle(); await work(() => { if (token !== S.token) throw new Error('实验已停止或素材已变化。'); }); }
    catch (error) { message(`${label}：${error.message}`); S.lastError = { phase: label, message: error.message, at: new Date().toISOString() }; }
    finally { S.busy = false; S.phase = 'idle'; controls(); }
  }
  function enter(mode) {
    if (!S.info || (mode === 'cache' && !S.cache)) throw new Error('请先探测或生成缓存。');
    S.mode = mode; S.active = true; video.pause(); video.controls = false;
    // 保留视频解码元素；直接模式把其解码画面画到同一个 canvas，便于一致地记录绘制提交。
    video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0.01;pointer-events:none';
    canvas.hidden = false; $('b-mode').textContent = mode === 'direct' ? '直接 MP4 寻帧' : 'JPEG 缓存预览';
    controls();
  }
  async function leave() { queue.cancel(); await queue.idle(); S.active = false; video.style.cssText = ''; video.controls = true; canvas.hidden = true; controls(); }
  async function seekVideo(time) {
    if (Math.abs(video.currentTime - time) < 1e-7 && video.readyState >= 2) return { unchanged: true, videoFrameCallback: null };
    return new Promise((resolve, reject) => {
      let frame = null, callbackId = null;
      const finish = error => { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', failed);
        if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
        error ? reject(error) : resolve({ unchanged: false, videoFrameCallback: frame }); };
      const done = () => finish(); const failed = () => finish(new Error('视频寻帧解码失败。'));
      const timer = setTimeout(() => finish(new Error('视频寻帧超过 8 秒。')), 8000);
      if (typeof video.requestVideoFrameCallback === 'function') callbackId = video.requestVideoFrameCallback((now, meta) => {
        frame = { callbackTime: now, mediaTime: meta.mediaTime, expectedDisplayTime: meta.expectedDisplayTime };
      });
      video.addEventListener('seeked', done); video.addEventListener('error', failed);
      try { video.currentTime = time; } catch (error) { finish(error); }
    });
  }
  async function render(job, valid) {
    const row = job.row, info = S.info, epoch = S.epoch; let bitmap = null;
    if (!info || !valid()) { row.cancelled = true; return row; }
    const index = backend.frameAt(info.timestamps, row.requestedSeconds);
    row.frameIndex = index; row.framePTS = info.timestamps[index];
    try {
      if (row.mode === 'cache') {
        const bytes = await fs.promises.readFile(path.join(backend.dir(), `${String(index).padStart(6, '0')}.jpg`));
        row.readFinishedMs = performance.now() - row.tInput;
        if (bytes.length > backend.LIMITS.jpegBytes) throw new Error('缓存帧尺寸超出限制。');
        if (!valid() || epoch !== S.epoch) { row.cancelled = true; return row; }
        bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        S.bitmaps++; S.peakBitmaps = Math.max(S.peakBitmaps, S.bitmaps);
        if (bitmap.width !== canvas.width || bitmap.height !== canvas.height) throw new Error('缓存尺寸与对比画布不一致。');
        row.readyVia = 'JPEG-read-and-createImageBitmap';
      } else {
        Object.assign(row, await seekVideo(row.requestedSeconds)); row.reportedCurrentTime = video.currentTime;
        row.readyVia = 'video-seeked-not-a-physical-display-measurement';
      }
      row.readyMs = performance.now() - row.tInput;
      if (!valid() || epoch !== S.epoch || job.sequence <= S.lastDrawn) { row.cancelled = true; return row; }
      // 单请求串行完成，序号只递增；旧异步结果不会覆盖已经提交的新序号。
      ctx.drawImage(bitmap || video, 0, 0, canvas.width, canvas.height);
      S.lastDrawn = job.sequence; row.sequence = job.sequence; row.drawSubmittedMs = performance.now() - row.tInput;
      row.newerRequestsWaitingAtDraw = queue.sequence - job.sequence; row.physicalDisplayMs = null;
      S.lastTime = row.requestedSeconds;
      $('b-frame').textContent = `目标 ${row.requestedSeconds.toFixed(3)}s · 帧 ${index} · PTS ${info.timestamps[index].toFixed(6)}s`;
      const paint = raf().then(raf).then(() => {
        row.paintOpportunityMs = performance.now() - row.tInput;
        row.supersededBeforePaintOpportunity = S.lastDrawn !== job.sequence || epoch !== S.epoch;
      }).catch(error => { row.paintUnavailable = error.message; }).finally(() => S.paintPending.delete(paint));
      S.paintPending.add(paint); row.paintPromise = paint;
      return row;
    } finally { if (bitmap) { bitmap.close(); S.bitmaps--; } }
  }
  async function request(time, kind, group) {
    if (!S.active) enter(S.mode);
    const row = { mode: S.mode, requestedSeconds: time, kind, group, tInput: performance.now(), physicalDisplayMs: null };
    S.rows.push(row); if (S.rows.length > 6000) { S.rows.shift(); S.truncatedRows++; }
    const result = await queue.request({ row });
    if (result.dropped) row.dropped = true;
    if (result.cancelled) row.cancelled = true;
    if (result.error) { row.error = result.error; message(result.error); }
    return row;
  }
  async function randomBlock(mode, group, guard) {
    enter(mode); const times = targets(S.info.timestamps); const rows = [];
    for (let i = 0; i < 2; i++) { guard(); const r = await request(times[i], 'warmup', group); await r.paintPromise; }
    for (let i = 0; i < times.length; i++) {
      guard(); message(`${group}：${i + 1}/${times.length}`);
      const row = await request(times[i], 'random', group); await row.paintPromise;
      if (row.error || row.cancelled) throw new Error(row.error || '定位被取消。'); rows.push(row);
    }
    return rows;
  }
  function summary(rows) {
    const ready = rows.filter(r => !r.dropped && !r.cancelled && !r.error);
    return { requested: rows.length, completed: ready.filter(r => Number.isFinite(r.readyMs)).length,
      dropped: rows.filter(r => r.dropped).length, errors: rows.filter(r => r.error).length,
      requestToReady: stats(ready.map(r => r.readyMs)),
      requestToPaintOpportunity: stats(ready.filter(r => !r.supersededBeforePaintOpportunity).map(r => r.paintOpportunityMs)),
      note: '刷新机会为双 rAF 近似值；不是物理显示延迟。直接模式的就绪点是 seeked，缓存模式是 JPEG 解码完成。' };
  }
  function save() {
    const payload = { source: 'actual-eagle-window-experiment-B', exportedAt: new Date().toISOString(), session: S.session,
      runtime: { node: process.versions.node, chrome: process.versions.chrome, platform: process.platform, pid: process.pid, userAgent: navigator.userAgent },
      info: S.info, cache: S.cache, baseline: S.baseline && summary(S.baseline), comparison: S.comparison || null, rounds: S.rounds,
      rows: S.rows.map(({ paintPromise, ...row }) => row), memory: S.memory, peakLiveBitmaps: S.peakBitmaps, truncatedRows: S.truncatedRows,
      observations: { source: 'user-entered', direct: $('b-observe-direct').value, cache: $('b-observe-cache').value, finalFrame: $('b-observe-final').value },
      measurementLimits: ['RSS excludes other Eagle/GPU processes; samples may miss peaks', 'no physical-display timing',
        'OS file cache not flushed; baseline follows timestamp probing', 'JPEG frames still decoded per request; no decoded-frame LRU'], lastError: S.lastError || null };
    const file = path.join(api.root, 'evidence', `b-session-${S.session}.json`);
    api.save(`b-session-${S.session}.json`, payload); return file;
  }
  async function inspect(guard) {
    const item = api.getItem(); if (!item || item.id !== JSON.parse(fs.readFileSync(path.join(api.root, 'tools-b.json'), 'utf8')).testItemId)
      throw new Error('请在上方读取实验 A 使用的同一测试素材。');
    if (video.readyState < 2 || video.error) throw new Error('请先让上方视频加载出画面，再探测。');
    message('正在读取编码与逐帧时间戳……'); const info = await backend.probe(item.filePath); guard();
    S.info = info; S.baseline = null; S.cache = null; S.comparison = null;
    S.rows = []; S.rounds = []; S.memory = []; S.truncatedRows = 0; S.lastError = null;
    const height = Number($('b-height').value), ratio = Math.min(1, height / info.height, height * 16 / 9 / info.width);
    canvas.width = Math.max(2, Math.floor(info.width * ratio / 2) * 2); canvas.height = Math.max(2, Math.floor(info.height * ratio / 2) * 2);
    $('b-slider').max = info.duration;
    try { const cache = await backend.loadCache(info); if (cache.previewHeight === height) S.cache = cache; } catch (_) {}
    $('b-info').textContent = JSON.stringify({ codec: info.codec, source: `${info.width}×${info.height}`, seconds: info.duration,
      frames: info.timestamps.length, avgFrameRate: info.avgFrameRate, intervals: info.frameIntervals, preview: `${canvas.width}×${canvas.height}`,
      cache: S.cache ? '已有匹配缓存；仍先跑基线' : '待生成' }, null, 2);
    message('探测完成。下一步：运行直接 MP4 基线。'); memory(); save();
  }
  async function dragRound(mode, round, guard) {
    enter(mode); const start = memory(); const group = `drag-${mode}-${round}`; const first = S.rows.length;
    for (let i = 0; i < 120; i++) { guard(); const fraction = (i % 60) / 59;
      const time = (fraction <= .5 ? fraction * 2 : 2 - fraction * 2) * (S.info.duration - .03);
      request(time, 'scripted-drag', group); await sleep(16);
    }
    await queue.idle(); await Promise.all([...S.paintPending]); guard();
    const end = memory(), rows = S.rows.slice(first);
    S.rounds.push({ mode, round, source: 'scripted-input-not-real-mouse', start, end, summary: summary(rows), finalRequested: rows.at(-1)?.requestedSeconds,
      finalDrawn: S.lastTime, sequenceAlwaysIncreasingByConstruction: true });
  }
  function init(context) {
    api = context; fs = require('fs'); path = require('path'); backend = require(path.join(api.root, 'cache-b.cjs'));
    video = api.video; canvas = $('b-canvas'); ctx = canvas.getContext('2d', { alpha: false }); queue = new LatestQueue(render);
    $('b-inspect').onclick = () => action('探测', inspect);
    $('b-baseline').onclick = () => action('基线', async guard => {
      S.baseline = await randomBlock('direct', 'baseline-direct', guard); save();
      $('b-results').textContent = JSON.stringify(summary(S.baseline), null, 2); message('基线已保存。可手动生成缓存。');
    });
    $('b-build').onclick = () => action('生成缓存', async guard => {
      S.cache = await backend.build(S.info, { height: Number($('b-height').value), onProgress: p => message(`已提取 ${p.count}/${p.frames} 帧 · ${(p.bytes / 1024 ** 2).toFixed(1)} MiB`) });
      guard(); save(); message(`缓存完成：${S.cache.frames} 帧，${(S.cache.diskBytes / 1024 ** 2).toFixed(1)} MiB。可以运行对比。`);
    });
    $('b-compare').onclick = () => action('对比', async guard => {
      const groups = [['direct', 'direct-1'], ['cache', 'cache-1'], ['cache', 'cache-2'], ['direct', 'direct-2']]; const collected = [];
      for (const [mode, group] of groups) collected.push(...await randomBlock(mode, group, guard));
      S.comparison = Object.fromEntries(['direct', 'cache'].map(mode => [mode, summary(collected.filter(r => r.mode === mode))]));
      S.rounds = [];
      for (let round = 1; round <= 3; round++) for (const mode of ['direct', 'cache']) { message(`重复拖动：${mode}，第 ${round}/3 轮`); await dragRound(mode, round, guard); }
      await Promise.all([...S.paintPending]); save(); $('b-results').textContent = JSON.stringify(S.comparison, null, 2);
      message('自动对比已保存。请再切换两种模式，用鼠标拖动检查画面，并填写观察后保存。');
    });
    for (const mode of ['direct', 'cache']) $(`b-${mode}`).onclick = () => action('切换预览', async () => { enter(mode); await request(Number($('b-slider').value), 'manual', 'mode-switch'); });
    $('b-slider').oninput = () => { if (!S.busy && S.info) { S.phase = 'manual-drag'; request(Number($('b-slider').value), 'mouse-input', 'manual'); } };
    $('b-export').onclick = () => action('保存', async () => { await Promise.all([...S.paintPending]); message(`证据已保存：${save()}`); });
    $('b-clean').onclick = () => action('清理', async () => { await leave(); const result = await backend.cleanup(); S.cache = null; message(`已清理 ${result.files} 个本实验缓存文件；证据保留。`); });
    $('b-leave').onclick = () => action('退出预览', leave);
    $('b-stop').onclick = stop;
    $('b-height').onchange = () => { reset(); message('预览尺寸已改变，请重新探测并建立基线。'); };
    document.addEventListener('visibilitychange', () => { if (document.hidden && S.busy) { stop(); message('窗口进入后台，已停止本轮测量。'); } });
    memoryTimer = setInterval(() => { if (S.info) memory(); }, 500);
    window.addEventListener('beforeunload', () => { clearInterval(memoryTimer); stop(); });
    controls(); message('先读取上方素材，再点击“探测视频”。缓存不会自动生成。');
  }
  globalThis.pocB = { init, reset, get busy() { return S.busy; }, get active() { return S.active; } };
})();
