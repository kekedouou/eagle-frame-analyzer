'use strict';
// Explicit isolated Chrome diagnostic. No browser package, Eagle control,
// media generation, cache reset, source edit or user browser profile access.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), http = require('http');
const { spawn, execFile, execFileSync } = require('child_process'), zlib = require('zlib');
const { createCache, RECIPE } = require('../plugin/cache.cjs');
const RAM_DIAGNOSTIC = process.argv.includes('--ram-compare');
const { createStore } = require(RAM_DIAGNOSTIC ? '../tests/support/t2-evidence.cjs' : '../tests/support/t1-evidence.cjs');
const repo = path.resolve(__dirname, '..'), pluginRoot = path.join(repo, 'plugin');
const pinned = RAM_DIAGNOSTIC ? require('./verify-t2-close.cjs')._test.selectedInput(
  JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json')))) : null;
const SHA = pinned ? pinned.sha256 : 'aabf057017744c38737f65c4e7a983a1f8d9e5258c178bcc3e723dcdb56ccc53';
const SOURCE = pinned ? pinned.file : process.env.EVA_T1_DIAGNOSTIC_SOURCE;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIB = 1024 ** 2, SCRATCH_LIMIT = 64 * MIB,
  RSS_LIMIT = require('../tests/support/ram-diagnostic.cjs').rssLimit(process.argv);
const nonce = crypto.randomBytes(12).toString('hex'), scratch = path.join(repo, 'verification-runs', 'browser-scratch-' + nonce);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const store = createStore(repo), result = { schema: RAM_DIAGNOSTIC ? 't2-isolated-ram-comparison-v1' : 't1-isolated-native-chrome-v1', origin: 'Codex-automatic-independent-Chrome',
  playerVersion: process.argv.includes('--before-t2-fix') ? 'git-2d0cfb4-before-t2-fix' : process.argv.includes('--baseline') ? 'git-1afcaa4-baseline' : 'workspace-candidate',
  sourceSha256: SHA, source: SOURCE, complete: false, EagleHostVerified: false, formalPerformancePassed: null,
  limits: { scratchBytes: SCRATCH_LIMIT, observedRendererRssBytes: RSS_LIMIT, deadlineMs: 90000, evidenceBytes: 2 * MIB },
  limitation: 'Filesystem/RSS limits are sampled stop lines, not OS-enforced quotas; observed overshoot is recorded as failure.', rounds: [] };
let cache, info, transaction, browser, server, cdp, sessionId, marker, stopped = null, monitor, deadline, monitoring = false;
let serverReads = [], sockets = new Set(), activeReads = 0, scratchPeak = 0, rssPeak = 0, retainedFailure = null;
let cleaning = false, diagnosticOptions;
const ownedProcesses = new Map();
function stop(error) { if (!stopped) { stopped = error instanceof Error ? error : new Error(String(error));
  if (cdp) cdp.call('Browser.close', {}, undefined, 2000).catch(() => {});
} }
function guard() { if (stopped) throw stopped; }
function tree(dir, live = false) {
  if (!samePath(fs.realpathSync(dir), dir)) throw new Error('Scratch canonical path changed.');
  const found = [], walk = current => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !samePath(fs.realpathSync(current), current)) throw new Error('Scratch contains a link or reparse path.');
    found.push({ file: current, stat });
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) {
      try { walk(path.join(current, name)); } catch (error) { if (!live || error.code !== 'ENOENT') throw error; }
    }
    else if (!stat.isFile() || stat.nlink !== 1) throw new Error('Scratch contains a non-regular or multiply-linked file.');
  }; walk(dir); return found;
}
function scratchBytes() { return tree(scratch, true).reduce((total, item) => total + (item.stat.isFile() ? item.stat.size : 0), 0); }
async function fileSha(file) {
  const hash = crypto.createHash('sha256'); for await (const data of fs.createReadStream(file)) hash.update(data); return hash.digest('hex');
}
class CDP {
  constructor(url) {
    this.socket = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.open = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); });
    this.socket.addEventListener('message', event => {
      let value; try { value = JSON.parse(event.data); } catch (_) { return; }
      const pending = this.pending.get(value.id); if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      value.error ? pending.reject(new Error(JSON.stringify(value.error))) : pending.resolve(value.result);
    });
    this.socket.addEventListener('close', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Owned Chrome CDP connection closed.')); } this.pending.clear(); });
  }
  async call(method, params = {}, target, timeout = 12000) {
    await this.open; if (method !== 'Browser.close') guard(); const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }));
    });
  }
  async evaluate(expression, timeout = 20000) {
    const value = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId, timeout);
    if (value.exceptionDetails) throw new Error('Browser execution failed: ' + JSON.stringify(value.exceptionDetails)); return value.result.value;
  }
}
function summary(values) {
  const sorted = values.sort((a, b) => a - b), n = sorted.length;
  return { count: n, mean: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
    p95: n ? sorted[Math.ceil(n * 0.95) - 1] : null, maximum: n ? sorted[n - 1] : null };
}
async function ownedRss() {
  const processes = await cdp.call('SystemInfo.getProcessInfo');
  for (const item of processes.processInfo) if (Number.isSafeInteger(Number(item.id))) ownedProcesses.set(Number(item.id), { id: Number(item.id), type: item.type });
  const ids = processes.processInfo.filter(p => RAM_DIAGNOSTIC || p.type === 'renderer').map(p => Number(p.id)).filter(Number.isSafeInteger);
  if (!ids.length) return { bytes: 0, processIds: [], available: false };
  // A short-lived renderer can exit between CDP's list and the OS sample.
  // Enumerate live processes without turning that ordinary race into exit 1.
  const command = 'Get-Process | Where-Object { $_.Id -in @(' + ids.join(',') + ') } | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress';
  const output = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 5000, maxBuffer: 16384 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const parsed = output.trim() ? JSON.parse(output) : [], rows = Array.isArray(parsed) ? parsed : [parsed];
  return { bytes: rows.reduce((total, row) => total + row.WorkingSet64, 0), processIds: rows.map(row => row.Id),
    missedExitedProcessIds: ids.filter(id => !rows.some(row => row.Id === id)), available: rows.length > 0 };
}
async function captureOwnedDescendants() {
  if (!browser) return;
  const command = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress";
  const output = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 5000, maxBuffer: 131072 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const parsed = output.trim() ? JSON.parse(output) : [], rows = Array.isArray(parsed) ? parsed : [parsed];
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (ownedProcesses.has(row.ParentProcessId) && !ownedProcesses.has(row.ProcessId)) {
    ownedProcesses.set(row.ProcessId, { id: row.ProcessId, type: 'OS-confirmed-owned-chrome-descendant', parent: row.ParentProcessId }); changed = true;
  } }
}
async function main() {
  store.start({ reserveBytes: 2 * MIB });
  if (RAM_DIAGNOSTIC && (process.argv.includes('--baseline') || process.argv.includes('--before-t2-fix')))
    throw new Error('RAM comparison cannot use historical candidates.');
  deadline = setTimeout(() => stop(new Error('90-second diagnostic deadline reached.')), 90000);
  if (typeof WebSocket !== 'function') throw new Error('This explicit browser tool requires existing local Node 24 native WebSocket.');
  if (typeof SOURCE !== 'string' || !path.isAbsolute(SOURCE)) throw new Error('An explicit absolute EVA_T1_DIAGNOSTIC_SOURCE is required.');
  const sourceStat = fs.lstatSync(SOURCE);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1 || !samePath(fs.realpathSync(SOURCE), SOURCE))
    throw new Error('Target source must be a canonical single-link regular file.');
  if (await fileSha(SOURCE) !== SHA) throw new Error('Target source content no longer matches the approved existing cache.');
  result.sourceBefore = { sha256: SHA, size: fs.statSync(SOURCE).size, mtimeMs: fs.statSync(SOURCE).mtimeMs };
  result.sourceCode = {};
  const code = {};
  for (const name of ['player.js', 'ui.js', 'styles.css', 'index.html', 'frame-index.cjs', 'session.cjs', 'cache.cjs', 'process-identity.cjs']) {
    code[name] = fs.readFileSync(path.join(pluginRoot, name), 'utf8'); result.sourceCode[name] = sha(Buffer.from(code[name]));
  }
  if (process.argv.includes('--baseline')) {
    code['player.js'] = execFileSync('git', ['show', '1afcaa4:plugin/player.js'], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: MIB });
    result.sourceCode['player.js'] = sha(Buffer.from(code['player.js']));
  }
  if (process.argv.includes('--before-t2-fix')) {
    if (process.argv.includes('--baseline')) throw new Error('Choose only one historical diagnostic candidate.');
    for (const name of ['player.js', 'session.cjs']) {
      code[name] = execFileSync('git', ['show', '2d0cfb4:plugin/' + name], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: MIB });
      result.sourceCode[name] = sha(Buffer.from(code[name]));
    }
  }
  result.driverSha256 = sha(fs.readFileSync(path.join(repo, 'tests/support/t1-browser.js')));
  if (RAM_DIAGNOSTIC) {
    const option = process.argv.find(value => value.startsWith('--ram-mib=')), mib = option ? Number(option.split('=')[1]) : NaN;
    const c = require('../tests/support/ram-diagnostic.cjs').candidate(code['player.js'], mib);
    code['player.js'] = c.source; diagnosticOptions = c.options;
    result.ramDiagnostic = { mib, compressedMiB: mib / 8, options: diagnosticOptions, transformations: c.transformations,
      candidatePlayerSha256: sha(Buffer.from(c.source)),
      helperSha256: sha(fs.readFileSync(path.join(repo, 'tests/support/ram-diagnostic.cjs'))),
      runnerSha256: sha(fs.readFileSync(__filename)),
      rssScope: 'Owned isolated Chrome process set plus external Node current RSS, sampled ~1s; transient sampler/GPU device allocations excluded.', samples: [] };
    result.limits.observedOwnedProcessRssBytes = result.limits.observedRendererRssBytes;
    delete result.limits.observedRendererRssBytes;
  }
  cache = createCache({ pluginRoot }); transaction = cache.begin({ sourceSha256: SHA });
  const candidate = await transaction.readComplete(); if (!candidate) throw new Error('Existing target cache missing; diagnostic never generates media.');
  const source = { ...candidate.source, id: 'diagnostic-source-' + SHA.slice(0, 16), name: path.basename(SOURCE, path.extname(SOURCE)), filePath: SOURCE, file: SOURCE };
  info = await transaction.finish(candidate, source); transaction.close(); transaction = null;
  result.cache = { directory: info.cacheDir, frameCount: info.frames.length, duration: info.duration, recipe: RECIPE,
    frameBytes: info.frames.reduce((sum, frame) => sum + frame.bytes, 0), audioBytes: info.audio ? info.audio.bytes : 0 };
  if (info.duration < 18) throw new Error('Target cache does not include the requested 14–18 second segment.');
  fs.mkdirSync(scratch); marker = Buffer.from(JSON.stringify({ owner: 'eva-t1-browser-scratch-v1', token: nonce, root: scratch, pid: process.pid }));
  fs.writeFileSync(path.join(scratch, 'owner.json'), marker, { flag: 'wx' });
  const assets = new Set(info.frames.map(frame => frame.file).concat(info.audio ? [info.audio.file] : []));
  const frameScript = '(function(){const module={exports:{}};\n' + code['frame-index.cjs'] + '\nwindow.EVAFrameIndex=module.exports;})();';
  const sessionScript = '(function(){const module={exports:{}};const require=name=>{if(name!=="path")throw new Error("Unexpected browser session dependency");return {resolve:value=>value};};\n' + code['session.cjs'] + '\nwindow.EVASession=module.exports;})();';
  const html = code['index.html'].replace('<script src="app.js"></script>', '<script src="frame-index.js"></script><script src="session.js"></script><script src="driver.js"></script>');
  const routes = new Map([['index.html', ['text/html', html]], ['player.js', ['text/javascript', code['player.js']]], ['ui.js', ['text/javascript', code['ui.js']]],
    ['styles.css', ['text/css', code['styles.css']]], ['frame-index.js', ['text/javascript', frameScript]], ['session.js', ['text/javascript', sessionScript]],
    ['driver.js', ['text/javascript', fs.readFileSync(path.join(repo, 'tests/support/t1-browser.js'), 'utf8')]]]);
  server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' || stopped) { response.writeHead(503).end(); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      const prefix = '/' + nonce + '/'; if (!url.pathname.startsWith(prefix)) { response.writeHead(404).end(); return; }
      const name = decodeURIComponent(url.pathname.slice(prefix.length));
      if (routes.has(name)) { const [type, body] = routes.get(name); response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body); return; }
      if (!name.startsWith('asset/') || !assets.has(name.slice(6))) { response.writeHead(404).end(); return; }
      activeReads++;
      try {
        if (activeReads > 3) throw new Error('Unexpected concurrent asset reads.');
        const start = performance.now(), data = await cache.readAsset(info, name.slice(6));
        const elapsed = performance.now() - start; serverReads.push({ file: name.slice(6), bytes: data.length, readMs: elapsed });
        if (serverReads.length > 24000) throw new Error('Bounded Node read record overflow.');
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length,
          'Cache-Control': 'no-store', 'X-Node-Read-Ms': String(elapsed) }).end(data);
      } finally { activeReads--; }
    } catch (error) { stop(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, url = 'http://127.0.0.1:' + port + '/' + nonce + '/index.html';
  const browserArgs = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps', '--no-pings',
    '--metrics-recording-only', '--safebrowsing-disable-auto-update', '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + path.join(scratch, 'profile'), '--disk-cache-dir=' + path.join(scratch, 'disk-cache'),
    '--disk-cache-size=1048576', '--crash-dumps-dir=' + path.join(scratch, 'crashes'), '--window-size=1120,760', 'about:blank'];
  result.browserArgs = browserArgs.map(value => value.replaceAll(scratch, '<owned-scratch>'));
  browser = spawn(CHROME, browserArgs,
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMP: scratch, TEMP: scratch } });
  let chromeLog = ''; browser.stderr.on('data', data => { if (chromeLog.length < 8192) chromeLog += data.toString().slice(0, 8192 - chromeLog.length); });
  browser.on('error', stop);
  ownedProcesses.set(browser.pid, { id: browser.pid, type: 'spawned-browser' });
  const activePort = path.join(scratch, 'profile', 'DevToolsActivePort'), launchAt = performance.now();
  let active;
  while (!active) {
    guard(); if (browser.exitCode !== null || browser.signalCode !== null || performance.now() - launchAt > 10000) throw new Error('Owned Chrome did not expose CDP: ' + chromeLog);
    try { const parsed = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
      if (/^\d+$/.test(parsed[0]) && /^\/devtools\/browser\//.test(parsed[1] || '')) active = parsed;
    } catch (error) { if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error; }
    if (!active) await pause(50);
  }
  cdp = new CDP('ws://127.0.0.1:' + Number(active[0]) + active[1]); await cdp.open;
  result.browser = await cdp.call('Browser.getVersion'); result.node = process.versions;
  const target = await cdp.call('Target.createTarget', { url });
  ({ sessionId } = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
  await cdp.call('Runtime.enable', {}, sessionId);
  await cdp.call('Page.bringToFront', {}, sessionId);
  const pageAt = performance.now(); while (!await cdp.evaluate('!!window.T1Browser')) { guard(); if (performance.now() - pageAt > 5000) throw new Error('Diagnostic page failed to initialize.'); await pause(25); }
  result.environment = await cdp.evaluate('T1Browser.initialize(' + JSON.stringify({ info, source, diagnosticOptions }) + ')');
  result.adaptation = 'Original formal Player/UI/frame-index/session source captured before launch; session path.resolve is an identity shim for supplied canonical absolute paths. Node/cache runs over loopback HTTP; selection/media prepare and cache-release facade are simulated. Cache synchronous path/ownership/hash work runs in external Node, whereas real Eagle runs it on the renderer thread. The transport moves work as well as adding copies and cannot be characterized as a conservative Eagle measurement.';
  monitor = setInterval(async () => {
    if (monitoring || stopped || cleaning) return; monitoring = true;
    try { const bytes = scratchBytes(); scratchPeak = Math.max(scratchPeak, bytes); if (bytes >= SCRATCH_LIMIT) stop(new Error('Scratch observed 64MiB stop line reached.'));
      const rss = await ownedRss(); if (cleaning) return;
      const observed = rss.bytes + (RAM_DIAGNOSTIC ? process.memoryUsage().rss : 0);
      rssPeak = Math.max(rssPeak, observed); if (!rss.available) stop(new Error('Owned process RSS could not be reliably sampled.'));
      if (RAM_DIAGNOSTIC) {
        const rows = result.ramDiagnostic.samples;
        if (rows.length >= 128) stop(new Error('RAM diagnostic resource record bound reached.'));
        else rows.push({ atMs: performance.now(), chromeRss: rss.bytes, nodeRss: process.memoryUsage().rss,
          missedExitedProcessIds: rss.missedExitedProcessIds });
      }
      if (observed >= RSS_LIMIT) stop(new Error('Owned process observed ' + RSS_LIMIT / 1024 ** 3 + 'GiB RSS stop line reached.'));
    } catch (error) { stop(error); } finally { monitoring = false; }
  }, 1000);
  const settingsList = RAM_DIAGNOSTIC ? [1, 2, 3].map(n => ({ name: 'whole-video-cold-decoded-' + n,
    start: 0, end: info.frames[info.frames.length - 1].time, fresh: true })) : [{ name: 'segment2-6-ColdDecoded', start: 2, end: 6, fresh: true },
    { name: 'segment2-6-repeat', start: 2, end: 6, fresh: false },
    { name: 'segment14-18-ColdDecoded', start: 14, end: 18, fresh: true },
    { name: 'segment14-18-repeat', start: 14, end: 18, fresh: false }];
  for (const settings of settingsList) {
    guard(); const readsAt = serverReads.length;
    const round = await cdp.evaluate('T1Browser.round(' + JSON.stringify(settings) + ')', 25000); guard();
    const raw = Buffer.from(JSON.stringify(round.trace)); delete round.trace;
    const compressed = zlib.gzipSync(raw);
    round.trace = { codec: 'gzip-base64', rawBytes: raw.length, rawSha256: sha(raw), compressedBytes: compressed.length, data: compressed.toString('base64') };
    const reads = serverReads.slice(readsAt); round.nodeRestrictedAssetReads = { count: reads.length, includesInitialization: settings.fresh,
      warmedFramesInInitialization: settings.fresh ? round.initialization.snapshot.playback.compressed.warmedFrames : 0,
      bytes: reads.reduce((sum, item) => sum + item.bytes, 0),
      readMs: summary(reads.map(item => item.readMs)), byAsset: reads };
    result.rounds.push(round); process.stdout.write(JSON.stringify({ round: settings.name, drawPerSecond: round.summary.submissionsPerSecond,
      longestGapMs: round.summary.gapMs.maximum, drawnResponseP95Ms: round.summary.responseMs.p95,
      classes: round.summary.classes, nodeReadCount: round.nodeRestrictedAssetReads.count,
      finalCorrect: round.summary.final.correct }) + '\n');
  }
  result.disposal = await cdp.evaluate('T1Browser.dispose()');
  result.complete = result.rounds.every(round => round.summary.final.correct && !round.summary.traceDropped) &&
    result.disposal.result.status === 'closed' && !result.disposal.snapshot.telemetryIssue && result.disposal.zeroBudget && result.disposal.zeroTasks;
  if (!result.complete) throw new Error('Diagnostic did not achieve matching final frame index/hint, complete trace and zero disposed budget.');
}
async function cleanup() {
  cleaning = true; clearInterval(monitor); clearTimeout(deadline);
  const monitorAt = performance.now(); while (monitoring && performance.now() - monitorAt < 6000) await pause(20);
  await captureOwnedDescendants();
  if (cdp) { try { await cdp.call('Browser.close', {}, undefined, 3000); } catch (_) {} }
  if (browser) {
    const exited = () => browser.exitCode !== null || browser.signalCode !== null;
    const start = performance.now(); while (!exited() && performance.now() - start < 5000) await pause(50);
    if (!exited()) { await captureOwnedDescendants(); browser.kill(); const killAt = performance.now(); while (!exited() && performance.now() - killAt < 3000) await pause(50); }
    result.chromeExited = exited();
  }
  result.ownedChromeProcesses = [...ownedProcesses.values()];
  if (ownedProcesses.size) {
    const ids = [...ownedProcesses.keys()].filter(Number.isSafeInteger), started = performance.now(); let alive = [];
    do {
      const command = 'Get-Process | Where-Object { $_.Id -in @(' + ids.join(',') + ') } | Select-Object -ExpandProperty Id | ConvertTo-Json -Compress';
      const output = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout: 5000, maxBuffer: 16384 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      const parsed = output.trim() ? JSON.parse(output) : []; alive = Array.isArray(parsed) ? parsed : [parsed];
      if (alive.length) await pause(100);
    } while (alive.length && performance.now() - started < 5000);
    result.ownedChromeAliveAfterClose = alive;
    if (alive.length) throw new Error('Owned Chrome child process exit unconfirmed; scratch retained.');
  }
  if (cdp) cdp.socket.close();
  if (server) { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  const readAt = performance.now(); while (activeReads && performance.now() - readAt < 5000) await pause(10);
  if (activeReads) throw new Error('Node asset reads still active; retained lease/scratch for safety.');
  if (transaction) { transaction.close(); transaction = null; }
  if (info) { result.nodeLeaseReleased = cache.release(info); info = null; }
  if (fs.existsSync(scratch)) {
    if (browser && !result.chromeExited) throw new Error('Chrome process exit unconfirmed; scratch retained.');
    const parent = path.join(repo, 'verification-runs');
    if (!samePath(path.dirname(scratch), parent) || !path.basename(scratch).match(/^browser-scratch-[0-9a-f]{24}$/) || !samePath(fs.realpathSync(parent), parent)) throw new Error('Scratch boundary changed; retained.');
    if (!fs.readFileSync(path.join(scratch, 'owner.json')).equals(marker)) throw new Error('Scratch marker changed; retained.');
    const found = tree(scratch); result.scratchBeforeCleanupBytes = found.reduce((sum, item) => sum + (item.stat.isFile() ? item.stat.size : 0), 0);
    scratchPeak = Math.max(scratchPeak, result.scratchBeforeCleanupBytes);
    for (const item of found.slice().reverse()) { const current = fs.lstatSync(item.file);
      if (current.ino !== item.stat.ino || current.dev !== item.stat.dev || current.isSymbolicLink()) throw new Error('Scratch identity changed during cleanup.');
      if (current.isDirectory()) fs.rmdirSync(item.file); else fs.unlinkSync(item.file);
    }
    result.scratchRemoved = !fs.existsSync(scratch);
  }
  result.observedScratchPeakBytes = scratchPeak;
  result[RAM_DIAGNOSTIC ? 'observedOwnedProcessRssPeakBytes' : 'observedRendererRssPeakBytes'] = rssPeak;
  if (result.sourceBefore) {
    result.sourceAfter = { sha256: await fileSha(SOURCE), size: fs.statSync(SOURCE).size, mtimeMs: fs.statSync(SOURCE).mtimeMs };
    result.sourceUnchanged = JSON.stringify(result.sourceBefore) === JSON.stringify(result.sourceAfter);
    if (!result.sourceUnchanged) throw new Error('Source fingerprint/stat changed; diagnostic failed.');
  }
  // Include the final, post-exit directory scan as well as periodic samples.
  // Cleanup still completes safely before reporting a late limit violation.
  if (scratchPeak >= SCRATCH_LIMIT) throw new Error('Final observed scratch peak exceeded the sampled stop line.');
}
(async () => {
  try { await main(); } catch (error) { retainedFailure = error; result.complete = false; result.error = { message: error.message, stack: String(error.stack).slice(0, 4096) }; }
  try { await cleanup(); } catch (error) { result.complete = false; result.cleanupError = error.message; retainedFailure = retainedFailure || error; }
  if (stopped) { result.complete = false; result.stopReason = stopped.message; retainedFailure = retainedFailure || stopped; }
  try { const receipt = store.save(RAM_DIAGNOSTIC ? 'audit' : 'host', result); process.stdout.write(JSON.stringify({ receipt, complete: result.complete, failure: stopped ? stopped.message : retainedFailure && retainedFailure.message, disposal: result.disposal, cleanup: { scratchRemoved: result.scratchRemoved, sourceUnchanged: result.sourceUnchanged, leaseReleased: result.nodeLeaseReleased } }) + '\n'); }
  catch (error) { process.stderr.write('Evidence persistence failed: ' + error.message + '\n'); retainedFailure = retainedFailure || error; }
  finally { try { store.close(); } catch (error) { process.stderr.write(error.message + '\n'); retainedFailure = retainedFailure || error; } }
  if (retainedFailure) process.exitCode = 1;
})();
