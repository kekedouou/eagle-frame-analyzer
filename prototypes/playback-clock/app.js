/* S1 实验接线。Eagle 只提供窗口事件，不调用素材或标注写入 API。 */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const MAX_EVENTS = 24000, MAX_SESSION_MS = 10 * 60 * 1000;
  let backend, player, info, controller, chain = Promise.resolve(), epoch = 0;
  let events = [], memory = [], rounds = [], startedAt = 0, loadMetrics = null;
  let busy = true, testing = false, dragging = false, initialized = false, closing = false;
  let measureStopped = false, lastSaved = null, timer, startIso, peakRss = 0;
  const now = () => performance.now();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const stateNames = { empty: '未载入', loading: '准备中', paused: '暂停', playing: '播放', seeking: '定位中', error: '失败', disposed: '已停止' };
  const state = () => player ? player.snapshot() : { state: 'empty', time: 0 };

  function fail(error) {
    $('error').textContent = String(error && error.message || error);
    if (!busy) $('status').textContent = '实验失败；可重新载入或保存证据';
  }
  function emit(event) {
    if (event.type === 'error') $('error').textContent = String(event.error || event.message || event.reason || '实验记录到错误，请保存证据。');
    if (measureStopped) return;
    if (events.length >= MAX_EVENTS || (startedAt && now() - startedAt > MAX_SESSION_MS)) {
      measureStopped = true;
      Promise.resolve().then(() => { if (player) player.pause(); fail(new Error('本次测量已达到日志或10分钟上限，请保存证据后重新载入。')); });
      return;
    }
    events.push({ ...event, at: Number.isFinite(event.at) ? event.at : now() });
  }
  function controls() {
    const s = state(), usable = !!info && !busy && !testing && !measureStopped && !['empty', 'loading', 'error', 'disposed'].includes(s.state);
    for (const id of ['previous', 'play', 'pause', 'next', 'timeline', 'delay', 'script']) $(id).disabled = !usable;
    $('sample').disabled = !backend || testing || closing;
    $('reload').disabled = !backend || testing || closing;
    $('cancel').disabled = !busy || !controller;
    $('save').disabled = !backend || !startedAt || testing;
    $('cleanup').disabled = !backend || busy || testing || closing;
  }
  function update(s) {
    if (!busy) $('status').textContent = stateNames[s.state] || s.state;
    if (!dragging && Number.isFinite(s.time)) $('timeline').value = s.time;
    $('position').textContent = `${Number(s.time || 0).toFixed(4)} s · 源帧 ${Number.isInteger(s.frameId) ? s.frameId : '—'} · RAM账本 ${((s.cacheBytes || 0) / 1048576).toFixed(1)} MiB`;
    controls();
  }
  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  }
  function summarize() {
    const draws = events.filter(e => e.type === 'draw');
    const positioning = draws.filter(e => e.kind !== 'play' && e.kind !== 'load');
    const delays = positioning.map(e => Number.isFinite(e.drawAt) && Number.isFinite(e.inputAt) ? e.drawAt - e.inputAt : e.latencyMs).filter(Number.isFinite);
    const barcode = draws.filter(e => e.barcode && typeof e.barcode.ok === 'boolean');
    return {
      inputEvents: events.filter(e => e.type === 'input').length,
      requests: events.filter(e => e.type === 'request' && e.phase !== 'effective-frame').length,
      effectiveTargets: events.filter(e => e.type === 'request' && e.phase === 'effective-frame').length,
      superseded: events.filter(e => e.type === 'superseded').length,
      drawSubmissions: draws.length,
      requestToDraw: { n: delays.length, meanMs: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null, p95Ms: percentile(delays, .95) },
      barcode: { checked: barcode.length, mismatches: barcode.filter(e => !e.barcode.ok).length },
      processPeakRssSampled: peakRss,
      cachePeakBytes: state().cachePeakBytes || null,
      physicalDisplayMs: null,
      physicalAudioVisualErrorMs: null,
      limits: ['绘制提交不是屏幕实际呈现', '内部时钟误差不是物理声画同步误差', '仅统计完成绘制的延迟，需与过期/未完成请求和更新间隔一起解读', 'RSS为本插件进程采样，不含全部Eagle/GPU/系统文件缓存']
    };
  }
  function evidence() {
    return {
      schema: 'eagle-s1-window-v1', startedAt: startIso, savedAt: new Date().toISOString(),
      origin: 'actual-window-session', executor: 'user-operated-window',
      environment: { node: process.versions.node, chrome: process.versions.chrome || null, electron: process.versions.electron || null, platform: process.platform, eagle: typeof eagle !== 'undefined' && eagle.app ? { version: eagle.app.version, build: eagle.app.build } : null },
      source: info && info.source, prepared: info && { width: info.width, height: info.height, duration: info.duration, frameCount: info.frames.length, audio: info.audio, metrics: info.metrics },
      loadMetrics, snapshot: state(), verifyMarkers: $('verify').checked,
      summary: summarize(), rounds, events, memory, evidenceTruncated: measureStopped,
      manual: { source: 'user-entered-observation', sync: $('manualSync').value, drag: $('manualDrag').value, silence: $('manualSilence').value, final: $('manualFinal').value },
      lastSaved
    };
  }
  async function save(kind = 'window') {
    const file = await backend.saveEvidence(kind, evidence());
    lastSaved = file;
    $('details').textContent = `证据已保存：${file}\n${JSON.stringify(summarize(), null, 2)}`;
    return file;
  }
  function newSession(t0) {
    events = []; memory = []; rounds = []; loadMetrics = null; measureStopped = false; peakRss = 0;
    startedAt = t0; startIso = new Date().toISOString(); lastSaved = null;
    for (const id of ['manualSync', 'manualDrag', 'manualSilence', 'manualFinal']) $(id).selectedIndex = 0;
  }
  function requestLoad(key, requestedAt = now()) {
    const ownEpoch = ++epoch, t0 = requestedAt;
    if (controller) controller.abort();
    if (player) player.pause();
    busy = true; $('error').textContent = ''; controls();
    chain = chain.catch(() => {}).then(async () => {
      if (ownEpoch !== epoch || closing) return;
      if (events.length && startedAt) await save('window-switch').catch(fail);
      if (player) { await player.dispose(); player = null; }
      info = null; newSession(t0); controller = new AbortController();
      $('status').textContent = '准备样本、帧与音频…'; controls();
      try {
        const backendBegin = now();
        const prepared = await backend.prepare(key, { signal: controller.signal, onProgress: p => { if (ownEpoch === epoch) $('status').textContent = typeof p === 'string' ? p : JSON.stringify(p); } });
        const backendEnd = now();
        if (ownEpoch !== epoch || controller.signal.aborted) return;
        info = prepared;
        player = new window.S1Player.Player({
          canvas: $('picture'), readAsset: (data, file) => backend.readAsset(data, file),
          emit: event => { if (ownEpoch === epoch) emit(event); },
          onChange: snapshot => { if (ownEpoch === epoch) update(snapshot); }
        });
        if (typeof player.setVerifyMarkers === 'function') player.setVerifyMarkers($('verify').checked);
        const browserBegin = now();
        await player.load(info);
        if (ownEpoch !== epoch || controller.signal.aborted) { await player.dispose(); return; }
        player.setDecodeDelay(Number($('delay').value));
        loadMetrics = { callToReadyMs: now() - t0, entryAndQueueMs: backendBegin - t0, backendCallMs: backendEnd - backendBegin, backendMs: info.metrics.totalMs, browserReadyMs: now() - browserBegin, reused: !!info.metrics.reused, firstPreparationTargetMs: info.duration < 5 ? 5000 : info.duration * 1000, physicalDisplayMs: null };
        $('timeline').max = info.duration;
        $('details').textContent = `${info.source.label}\n${info.source.codec} · ${info.source.width}×${info.source.height} → ${info.width}×${info.height} · ${info.frames.length}帧 · ${info.duration.toFixed(4)}秒\n${JSON.stringify({ loadMetrics, audio: info.audio, backend: info.metrics }, null, 2)}`;
        emit({ type: 'load-ready', at: now(), ...loadMetrics });
      } catch (error) {
        if (ownEpoch === epoch) { emit({ type: 'error', stage: 'load', message: error.message }); fail(error); }
      } finally {
        if (ownEpoch === epoch) { busy = false; controller = null; update(state()); }
      }
    });
    return chain;
  }
  async function target(time, kind, final) {
    if (!player || busy) return;
    const inputAt = now();
    emit({ type: 'input', at: inputAt, inputAt, kind, targetTime: time });
    return player.seek(time, { kind, final, inputAt });
  }
  async function scripted() {
    if (!player || busy || testing) return;
    testing = true; dragging = false; player.pause(); controls();
    const owned = player, ownEpoch = epoch;
    try {
      for (const delayMs of [0, 25, 60]) {
        if (ownEpoch !== epoch) break;
        // 每轮清空已解码 RAM 图像，避免上一轮暖缓存掩盖慢解码。
        const resetBegin = now();
        owned.setDecodeDelay(0);
        await owned.load(info);
        const resetMs = now() - resetBegin;
        if (ownEpoch !== epoch) break;
        owned.setDecodeDelay(delayMs); $('delay').value = delayMs;
        const firstRow = events.length, begin = now();
        let seed = 7301, actualInputs = 0; // 三轮使用相同目标序列。
        for (let i = 0; i < 360; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          target((seed / 4294967296) * info.duration, 'script', false).catch(fail);
          actualInputs++;
          await sleep(8);
          if (ownEpoch !== epoch || measureStopped) break;
        }
        const finalFrame = info.frames[Math.floor((info.frames.length - 1) * .731)];
        const result = await target(finalFrame.time, 'script-final', true);
        const end = now(), draws = events.slice(firstRow).filter(e => e.type === 'draw');
        const marks = [begin, ...draws.map(e => e.drawAt || e.at), end].sort((a, b) => a - b);
        let maxGap = 0; for (let i = 1; i < marks.length; i++) maxGap = Math.max(maxGap, marks[i] - marks[i - 1]);
        rounds.push({ delayMs, resetMs, initialDecodedCache: 'reset except first frame and limited preload; disk/OS cache not flushed', begin, end, nominalInputs: 360, actualInputs, drawSubmissions: draws.length, submittedUpdatesPerSecond: draws.length * 1000 / (end - begin), longestNoSubmissionMs: maxGap, expectedFinalFrame: finalFrame.id, finalResult: result, finalSnapshot: owned.snapshot(), physicalDisplayRate: null });
      }
      owned.setDecodeDelay(0); $('delay').value = '0';
      $('details').textContent = JSON.stringify({ rounds, summary: summarize() }, null, 2);
      await save('window-script');
    } catch (error) { fail(error); await save('window-script-failed').catch(fail); }
    finally { testing = false; controls(); }
  }
  async function initialize(plugin) {
    const entryAt = now();
    if (initialized) return;
    initialized = true;
    try {
      const fs = require('fs'), path = require('path');
      if (!plugin || !path.isAbsolute(plugin.path)) throw new Error('未取得 Eagle 官方 plugin.path，请从 manifest 加载。');
      const root = fs.realpathSync(plugin.path);
      backend = require(path.join(root, 'prepare.cjs'));
      if (fs.realpathSync(backend.ROOT) !== root) throw new Error('S1 后端目录与插件目录不一致。');
      const sources = await backend.listSources();
      for (const source of sources) { const option = document.createElement('option'); option.value = source.key; option.textContent = source.label; $('sample').append(option); }
      $('sample').value = sources.some(s => s.key === 'h264-cfr') ? 'h264-cfr' : sources[0].key;
      timer = setInterval(() => {
        if (!startedAt || measureStopped) return;
        const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss);
        if (memory.length < 610) memory.push({ at: now(), rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, cache: state().cacheBytes || 0 });
      }, 1000);
      await requestLoad($('sample').value, entryAt);
    } catch (error) { busy = false; fail(error); controls(); }
  }

  $('sample').addEventListener('change', () => requestLoad($('sample').value).catch(fail));
  $('reload').addEventListener('click', () => requestLoad($('sample').value).catch(fail));
  $('cancel').addEventListener('click', () => { if (controller) controller.abort(); });
  $('play').addEventListener('click', () => player.play().catch(fail));
  $('pause').addEventListener('click', () => player.pause());
  $('previous').addEventListener('click', () => player.step(-1).catch(fail));
  $('next').addEventListener('click', () => player.step(1).catch(fail));
  $('timeline').addEventListener('pointerdown', () => { dragging = true; if (player) player.pause(); });
  $('timeline').addEventListener('input', () => target(Number($('timeline').value), 'drag', false).catch(fail));
  $('timeline').addEventListener('change', () => { dragging = false; target(Number($('timeline').value), 'release', true).catch(fail); });
  window.addEventListener('pointerup', () => { if (dragging) { dragging = false; target(Number($('timeline').value), 'release', true).catch(fail); } });
  $('delay').addEventListener('change', () => { if (player) player.setDecodeDelay(Number($('delay').value)); });
  $('verify').addEventListener('change', () => { if (player && typeof player.setVerifyMarkers === 'function') player.setVerifyMarkers($('verify').checked); emit({ type: 'verify-toggle', enabled: $('verify').checked }); });
  $('script').addEventListener('click', scripted);
  $('save').addEventListener('click', () => save().catch(fail));
  $('cleanup').addEventListener('click', async () => {
    busy = true; controls(); ++epoch;
    try { if (player) player.pause(); if (events.length) await save('window-cleanup'); if (player) await player.dispose(); player = null; info = null; const result = await backend.cleanup(); $('details').textContent = `只清理 S1 生成产物，证据保留。\n${JSON.stringify(result, null, 2)}`; }
    catch (error) { fail(error); }
    finally { busy = false; update(state()); }
  });
  window.addEventListener('pagehide', () => { closing = true; ++epoch; if (controller) controller.abort(); if (player) player.dispose(); clearInterval(timer); });
  if (typeof eagle !== 'undefined' && typeof eagle.onPluginCreate === 'function') {
    eagle.onPluginCreate(initialize);
    if (typeof eagle.onPluginRun === 'function') eagle.onPluginRun(() => { if (initialized && backend && !busy && !testing) requestLoad($('sample').value).catch(fail); });
    if (typeof eagle.onPluginBeforeExit === 'function') eagle.onPluginBeforeExit(() => { closing = true; if (controller) controller.abort(); if (player) player.dispose(); });
  } else fail(new Error('请在 Eagle 中手动加载本目录 manifest.json；普通浏览器没有 Eagle/Node 运行环境。'));
})();
