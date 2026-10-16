'use strict';
// Opt-in actual Eagle Canvas checks. Never imported by the ordinary product.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { capture } = require('../../scripts/verify-frame-accuracy.cjs'), { compare } = require('./frame-reference.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex'), MIB = 1024 ** 2;
const SCALE = 'scale=1280:720:force_original_aspect_ratio=decrease:flags=bilinear,setsar=1,pad=1280:720:(ow-iw)/2:(oh-ih)/2';
function ordinals(count) { assert(Number.isSafeInteger(count) && count > 0); return [...new Set(Array.from({ length: Math.min(24, count) }, (_, n) => Math.round(n * (count - 1) / (Math.min(24, count) - 1 || 1))))]; }
function pixelDifference(a, b) { assert(a.length && a.length === b.length); let changed = 0, max = 0;
  for (let n = 0; n < a.length; n++) { const error = Math.abs(a[n] - b[n]); if (error) changed++; max = Math.max(max, error); }
  return { changedChannels: changed, maxChannelDifference: max, exact: changed === 0 }; }
function tools(repo) { return JSON.parse(fs.readFileSync(path.join(repo, 'tests/host/t0/config.local.json'))); }
async function verifySource(options) {
  const { window: win, document: doc, info, source, check, signal, bridge } = options, repo = path.resolve(__dirname, '../..'), cfg = tools(repo);
  check(); const before = sha(fs.readFileSync(source.filePath)); assert.equal(before, source.sha256);
  const probe = JSON.parse((await capture(cfg.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames',
    '-show_entries', 'stream=time_base:frame=pts,best_effort_timestamp,duration,pkt_duration', '-of', 'json', source.filePath], { signal, maxBytes: 4 * MIB })).stdout);
  const timeline = compare(info, probe), targets = ordinals(info.frames.length), selection = "select='" + targets.map(n => 'eq(n,' + n + ')').join('+') + "'";
  const result = await capture(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts', '-threads', '2', '-i', source.filePath,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', selection + ',' + SCALE, '-filter_threads', '1', '-fps_mode', 'passthrough',
    '-c:v', 'mjpeg', '-threads', '2', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'], { signal, maxBytes: 32 * MIB });
  const parser = new (require('../../plugin/media.cjs')._test.JpegParser)(), jpegs = parser.push(result.stdout);
  assert(!parser.buffer.length && jpegs.length === targets.length); check();
  const actual = doc.createElement('canvas'), expected = doc.createElement('canvas'), full = doc.createElement('canvas'); actual.width = expected.width = 160; actual.height = expected.height = 90;
  full.width = info.width; full.height = info.height; const fullContext = full.getContext('2d', { alpha: false });
  const a = actual.getContext('2d', { alpha: false }), e = expected.getContext('2d', { alpha: false }), canvas = doc.getElementById('picture');
  const matches = [], steps = []; let lastDraw = null;
  const off = bridge.subscribe(message => { if (message.type === 'player' && message.value.event.type === 'draw') lastDraw = message.value.event; });
  const now = () => win.performance.now(), sleep = () => new Promise(resolve => win.setTimeout(resolve, 4));
  async function settle(ordinal, at) {
    while (true) { check(); const s = bridge.snapshot();
      if (!s || s.state === 'error' || s.state === 'closed') throw Error('源画布核对期间正式会话失败。');
      if (s.state === 'paused' && s.playback.frameOrdinal === ordinal && !s.playback.pendingTargets) {
        assert.equal(doc.getElementById('frameReadout').textContent, '第 ' + (ordinal + 1) + ' / ' + info.frames.length + ' 帧');
        return { observedAt: now(), drawAt: lastDraw && lastDraw.drawAt >= at ? lastDraw.drawAt : null,
          responseMs: lastDraw && lastDraw.drawAt >= at ? lastDraw.drawAt - at : null, actualOrdinal: ordinal };
      }
      if (now() - at > 10000) throw Error('实际画面未在10秒内到达目标源帧。'); await sleep(); }
  }
  async function seek(ordinal) {
    const f = info.frames[ordinal], time = f.end > f.time ? (f.time + f.end) / 2 : f.time, box = doc.getElementById('timeline').getBoundingClientRect();
    const at = now(), values = { pointerId: 613, pointerType: 'mouse', button: 0, clientX: box.left + box.width * time / info.duration,
      clientY: box.top + box.height / 2, bubbles: true, cancelable: true };
    doc.getElementById('timeline').dispatchEvent(new win.PointerEvent('pointerdown', { ...values, buttons: 1 }));
    win.dispatchEvent(new win.PointerEvent('pointerup', { ...values, buttons: 0 })); return settle(ordinal, at);
  }
  try {
    for (let n = 0; n < targets.length; n++) {
      check(); const ordinal = targets[n]; await seek(ordinal);
      const bitmap = await win.createImageBitmap(new win.Blob([jpegs[n]], { type: 'image/jpeg' }));
      try { check(); fullContext.drawImage(bitmap, 0, 0, info.width, info.height); a.drawImage(canvas, 0, 0, 160, 90); e.drawImage(full, 0, 0, 160, 90);
        const difference = pixelDifference(a.getImageData(0, 0, 160, 90).data, e.getImageData(0, 0, 160, 90).data);
        matches.push({ ordinal, referenceJpegSha256: sha(jpegs[n]), ...difference }); assert(difference.exact, 'Canvas differs from independently decoded source at ' + ordinal);
      } finally { bitmap.close(); }
    }
    for (const base of [Math.floor(info.frames.length / 4), Math.floor(info.frames.length / 2), Math.floor(info.frames.length * 3 / 4)]) {
      await seek(base);
      for (const [id, delta, code, key] of [['next', 1, null, null], ['previous', -1, null, null], [null, 1, 'BracketRight', ']'], [null, -1, 'BracketLeft', '[']]) {
        const previous = bridge.snapshot().playback.frameOrdinal, at = now();
        if (id) doc.getElementById(id).click(); else win.dispatchEvent(new win.KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true }));
        const value = await settle(previous + delta, at); steps.push({ input: id || key, ...value });
      }
      const at = now(); for (let n = 0; n < 3; n++) win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'BracketRight', key: ']', repeat: n > 0, bubbles: true, cancelable: true }));
      win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'BracketLeft', key: '[', bubbles: true, cancelable: true }));
      await settle(base + 2, at);
    }
  } finally { off(); actual.width = expected.width = full.width = 1; actual.height = expected.height = full.height = 1; }
  assert.equal(sha(fs.readFileSync(source.filePath)), before);
  return { schema: 'mvp-real-source-canvas-reference-v1', timeline, pictures: matches, steps, sourceUnchanged: true, passed: true,
    limitations: ['Actual Canvas readback at 160x90 versus freshly source-decoded JPEG rendered with the same browser; not physical-screen timing or every pixel at full resolution.',
      '12 step response samples are diagnostics, not the complete P-02 three-by-200 protocol; no new manual feel/physical sound observation.'] };
}
async function verifyNumbered(options) {
  const { window: win, document: doc, runtimeRoot, check, signal, onActive } = options, cfg = tools(path.resolve(__dirname, '../..')), output = [];
  const fixtures = cfg.sources.filter(s => ['h264-cfr', 'hevc-vfr', 'vp9-silent'].includes(s.key)); assert.equal(fixtures.length, 3);
  for (const s of fixtures) {
    check(); const sourceBefore = sha(fs.readFileSync(s.file)), authoredBytes = fs.readFileSync(s.expectedFile), expected = JSON.parse(authoredBytes);
    assert.equal(sourceBefore, s.sha256); assert.equal(expected.sha256, s.sha256);
    const backend = require('../../plugin/task-client.cjs').createTaskClient({ pluginRoot: runtimeRoot, runtime: process.execPath, discoverTools: async () => cfg });
    let info = null, player = null; const rows = [], canvas = doc.createElement('canvas');
    if (onActive) onActive({ backend });
    try {
      info = await backend.media.prepare({ id: s.key, itemId: s.key, name: s.label, filePath: s.file, ext: 'mp4' }, { signal }); check();
      player = new win.EVAPlayer.Player({ canvas, frameIndex: require('../../plugin/frame-index.cjs'), ramBytes: 1024 ** 3, experimentMode: 'compressed-ram',
        readAsset: (_, file) => backend.cache.readAsset(info, file), readFrameBatch: (_, files) => backend.cache.readFrameBatch(info, files),
        emit: event => { if (event.type === 'draw') rows.push({ ordinal: event.frameOrdinal, barcode: event.barcode, drawAt: event.drawAt }); } });
      if (onActive) onActive({ backend, player });
      await player.load({ ...info, expected: expected.expected });
      for (let n = 1; n < info.frames.length; n++) { check(); const value = await player.step(1); assert.equal(value.status, 'drawn'); }
      assert.equal(rows.length, expected.expected.barcodes.length); assert(rows.every((r, n) => r.ordinal === n && r.barcode && r.barcode.ok === true));
      const numberedRows = rows.slice(), budget = player.snapshot().budget;
      assert.equal((await player.step(1)).status, 'reused');
      assert.equal((await player.seek(0, { final: true })).frameId, info.frames[0].id);
      assert.equal((await player.step(-1)).status, 'reused');
      output.push({ key: s.key, frames: info.frames.length, rows: numberedRows, budget, authoredSha256: sha(authoredBytes), sourceSha256: sourceBefore, passed: true });
    } finally {
      let cleanupError;
      try { if (player) { await player.dispose(); assert.equal(player.snapshot().cacheBytes, 0); } } catch (e) { cleanupError = e; }
      try { if (info) await backend.cache.release(info); if (!signal.aborted) await backend.cache.clearOther({ sourceSha256: '0'.repeat(64) }); } catch (e) { cleanupError = cleanupError || e; }
      try { await backend.close(); } catch (e) { cleanupError = cleanupError || e; } canvas.width = canvas.height = 1;
      if (onActive) onActive(null);
      if (cleanupError) throw cleanupError;
    }
    assert.equal(sha(fs.readFileSync(s.file)), sourceBefore); assert.equal(sha(fs.readFileSync(s.expectedFile)), sha(authoredBytes));
  }
  return { schema: 'mvp-real-numbered-canvas-v1', fixtures: output, passed: true, physicalScreenMeasured: false,
    scope: 'Production Player + actual Eagle Canvas/JPEG/Audio and isolated guarded backend; direct player controls for local authored fixtures, not real Eagle selection/annotation SDK.' };
}
module.exports = { verifySource, verifyNumbered, ordinals, pixelDifference };
