/* Test-only native-browser diagnostic. Formal code never imports this file. */
(function () {
  'use strict';
  let info, source, ui, session, player, diagnosticOptions = {}, events = null, dropped = 0;
  const now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const maximumEvents = 24000;
  function emit(event) {
    if (!events) return;
    if (events.length >= maximumEvents) { dropped++; return; }
    if (['request', 'ready', 'draw', 'superseded', 'reused', 'error'].includes(event.type)) events.push(event);
  }
  async function dispose() {
    if (!session) return null;
    const result = await session.close(), snapshot = player.snapshot();
    ui.destroy(); session = null;
    return { result, snapshot, zeroBudget: snapshot.budget.used === 0, zeroTasks: snapshot.activeImageTasks === 0 };
  }
  async function load() {
    const previous = await dispose();
    if (previous && (!previous.zeroBudget || !previous.zeroTasks || previous.result.status !== 'closed')) throw new Error('Previous real Player did not release its resources.');
    ui = EVAUI.createUI();
    session = EVASession.createSession({
      now, eagleAdapter: { captureSelected: async () => source }, media: { prepare: async () => info },
      cache: { readAsset: async (_info, file) => {
        const response = await fetch('asset/' + encodeURIComponent(file), { cache: 'no-store' });
        if (!response.ok) throw new Error('Restricted Node asset read failed: ' + response.status);
        return new Uint8Array(await response.arrayBuffer());
      }, release: () => true },
      createPlayer: options => {
        player = new EVAPlayer.Player({ ...options, ...diagnosticOptions, canvas: ui.canvas, frameIndex: EVAFrameIndex, emit });
        return player;
      }, onChange: value => ui.update(value)
    });
    ui.bindSession(session);
    const started = now(), result = await session.loadSelected({ trigger: 'isolated-browser-existing-cache' });
    if (result.status !== 'ready') throw new Error('Existing-cache diagnostic player failed to load: ' + JSON.stringify(result));
    return { initializationMs: now() - started, snapshot: session.snapshot(), previousDisposal: previous };
  }
  function stats(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), length = sorted.length;
    return { count: length, mean: length ? sorted.reduce((a, b) => a + b, 0) / length : null,
      p50: length ? sorted[Math.ceil(length * 0.5) - 1] : null, p95: length ? sorted[Math.ceil(length * 0.95) - 1] : null,
      maximum: length ? sorted[length - 1] : null };
  }
  function pointer(type, time) {
    const timeline = document.getElementById('timeline'), rect = timeline.getBoundingClientRect();
    const target = type === 'pointerdown' ? timeline : window;
    target.dispatchEvent(new PointerEvent(type, { pointerId: 731, pointerType: 'mouse', button: 0,
      buttons: type === 'pointerup' ? 0 : 1, clientX: rect.left + time / info.duration * rect.width,
      clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
  }
  async function round(settings) {
    const initialization = settings.fresh ? await load() : null;
    if (!session || session.snapshot().state !== 'paused') throw new Error('Diagnostic requires a paused real Player.');
    const begin = now(), end = begin + 6000, start = settings.start, finish = settings.end;
    const rafBegin = player.snapshot().rafOpportunity;
    let target = start, domInputs = 0;
    events = []; dropped = 0;
    pointer('pointerdown', target); domInputs++;
    while (now() < end) {
      const elapsed = now() - begin, fraction = (Math.sin(elapsed / 1000 * Math.PI) + 1) / 2;
      target = start + (finish - start) * fraction;
      pointer('pointermove', target); domInputs++;
      if (session.snapshot().state === 'error') throw new Error('Real Player entered error state.');
      await sleep(4);
    }
    const inputEnd = now(), rafEnd = player.snapshot().rafOpportunity; pointer('pointerup', target); domInputs++;
    const settleAt = now();
    while (player.snapshot().pendingTargets || player.snapshot().activeImageTasks) {
      if (now() - settleAt > 5000) throw new Error('Final frame or background image work did not settle.');
      if (session.snapshot().state === 'error') throw new Error('Real Player failed during final settlement.');
      await sleep(5);
    }
    const last = player.snapshot(), expectedOrdinal = EVAFrameIndex.frameAt(info.frames, target);
    const hint = document.getElementById('timeHint'), expectedHint = EVAUI.formatTime(info.frames[expectedOrdinal].time);
    const correct = last.state === 'paused' && last.frameOrdinal === expectedOrdinal && hint.textContent === expectedHint && !hint.hidden;
    const trace = events; events = null;
    const drawn = trace.filter(e => e.type === 'draw' && e.drawAt >= begin && e.drawAt <= inputEnd);
    const allDrawn = trace.filter(e => e.type === 'draw');
    const ready = trace.filter(e => e.type === 'ready' && e.phase === 'read-and-image-decode-complete');
    const byAssetSource = {};
    for (const kind of ['compressed-ram', 'disk']) {
      const selected = ready.filter(event => event.assetSource === kind);
      byAssetSource[kind] = { count: selected.length, readMsIncludingLoopbackTransport: stats(selected.map(e => e.readMs)),
        decodeMs: stats(selected.map(e => e.decodeMs)) };
    }
    const requests = trace.filter(e => e.type === 'request' && e.phase === 'input');
    const gaps = [], longGaps = []; let before = begin;
    for (const event of drawn) { const gap = event.drawAt - before; gaps.push(gap);
      if (gap > 100) longGaps.push({ start: before, end: event.drawAt, gapMs: gap, frameId: event.frameId }); before = event.drawAt; }
    gaps.push(inputEnd - before); if (inputEnd - before > 100) longGaps.push({ start: before, end: inputEnd, gapMs: inputEnd - before, tail: true });
    const classes = {}; for (const event of trace) if (['superseded', 'reused', 'error'].includes(event.type)) {
      const key = event.status || event.type; classes[key] = (classes[key] || 0) + 1;
    }
    return { name: settings.name, range: [start, finish], initialization,
      summary: { measuredMs: inputEnd - begin, domInputs, acceptedRequests: requests.length, actualDrawSubmissions: drawn.length,
        rafOpportunities: rafEnd - rafBegin, rafOpportunitiesPerSecond: (rafEnd - rafBegin) * 1000 / (inputEnd - begin),
        drawAndResponseScope: 'Only draws submitted between input begin and the pointer-up handler entry; drawn-request P95 excludes superseded/reused requests.',
        classesScope: 'Input begin through final pointer-up settlement; release requests included.',
        submissionsPerSecond: drawn.length * 1000 / (inputEnd - begin), gapMs: stats(gaps), longGaps,
        responseMs: stats(drawn.map(e => e.responseMs)), allDrawResponseMs: stats(allDrawn.map(e => e.responseMs)),
        readMsIncludingLoopbackTransport: stats(ready.map(e => e.readMs)), decodeMs: stats(ready.map(e => e.decodeMs)), byAssetSource,
        classes, traceDropped: dropped, final: { target, expectedOrdinal, actualOrdinal: last.frameOrdinal,
          expectedHint, actualHint: hint.textContent, correct, checkScope: 'Final state frame ordinal and actual-time hint only; no independent pixel identity check.' }, snapshot: last }, trace };
  }
  window.T1Browser = { async initialize(value) { info = value.info; source = value.source; EVAFrameIndex.validateIndex(info);
    diagnosticOptions = value.diagnosticOptions || {};
    if (Object.keys(diagnosticOptions).length && (![512 * 1024 ** 2, 1024 ** 3].includes(diagnosticOptions.ramBytes) ||
        diagnosticOptions.compressedRamBytes !== diagnosticOptions.ramBytes / 8 ||
        Object.keys(diagnosticOptions).sort().join(',') !== 'compressedRamBytes,ramBytes')) throw new Error('Invalid bounded RAM diagnostic options.');
    return { userAgent: navigator.userAgent, devicePixelRatio, viewport: [innerWidth, innerHeight], audio: !!info.audio,
      visibilityState: document.visibilityState, focused: document.hasFocus(), performanceTimeOrigin: performance.timeOrigin,
      limitations: ['Independent installed Chrome, not Eagle.', 'Node cache reads cross loopback HTTP; read time includes transport and buffer copies.',
        'Synchronous filesystem ownership/path/hash checks move off the renderer thread into external Node; this is not a conservative Eagle performance bound.',
        'ColdDecoded resets Player decoded RAM; OS disk cache is not reset.', 'DOM events are scripted; draw submissions are not physical screen presentation.',
        'Eagle selection and media preparation are test substitutes; no P03 claim.'] }; }, round, dispose };
})();
