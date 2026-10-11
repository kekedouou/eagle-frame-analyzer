'use strict';
const assert = require('assert');
const { createUI, pointerTime, formatTime, spaceAllowed } = require('../plugin/ui.js');
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('ok ' + name); }
function target() {
  const handlers = new Map();
  return { style: {}, attributes: {}, disabled: false, hidden: false, textContent: '', offsetWidth: 80,
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { if (handlers.has(type)) handlers.get(type).delete(fn); },
    fire(type, values = {}) { const e = { pointerId: 1, button: 0, buttons: 1, clientX: 100, preventDefault() { this.prevented = true; }, ...values }; for (const fn of handlers.get(type) || []) fn(e); return e; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect() { return { left: 100, width: 200 }; },
    focus() {}, setPointerCapture(id) { this.capture = id; }, hasPointerCapture(id) { return this.capture === id; }, releasePointerCapture() { this.capture = null; },
    closest() { return null; } };
}
function harness() {
  const elements = new Map(), win = target(), calls = [], doc = { getElementById(id) { if (!elements.has(id)) elements.set(id, target()); return elements.get(id); } };
  const ui = createUI({ document: doc, window: win, now: () => 123 });
  const session = { seek(time, options) { calls.push(['seek', time, options]); return Promise.resolve(); }, toggle() { calls.push(['toggle']); }, step(delta) { calls.push(['step', delta]); }, retry() { calls.push(['retry']); } };
  const state = { epoch: 1, state: 'paused', duration: 10, source: { name: '中文 空格.mp4' }, playback: { time: 2, frameId: 120 } };
  ui.bindSession(session); ui.update(state);
  return { ui, el: id => doc.getElementById(id), win, calls, state };
}
test('Time formatting rounds presentation only; pointer mapping clamps actual track bounds', () => {
  assert.strictEqual(formatTime(4.2509), '0:04.250'); assert.strictEqual(formatTime(61), '1:01.000');
  assert.strictEqual(pointerTime(50, { left: 100, width: 200 }, 10), 0);
  assert.strictEqual(pointerTime(400, { left: 100, width: 200 }, 10), 10);
  assert.strictEqual(pointerTime(200, { left: 100, width: 200 }, 10), 5);
  assert.strictEqual(pointerTime(200, { left: 100, width: 0 }, 10), null);
});
test('Space ignores repeat, composition, modifiers, text and focused controls', () => {
  assert(spaceAllowed({ key: ' ', target: target() }));
  for (const value of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { shiftKey: true }, { target: { isContentEditable: true } }, { target: { closest: () => ({}) } }]) assert(!spaceAllowed({ key: ' ', ...value }));
});
test('Gesture thumb follows pointer while time hint remains the actual submitted frame', () => {
  const h = harness(); h.el('timeline').fire('pointerdown', { clientX: 260 });
  assert.strictEqual(h.el('thumb').style.left, '80%'); assert.strictEqual(h.calls[0][1], 8);
  assert.strictEqual(h.calls[0][2].inputAt, 123); assert.strictEqual(h.el('timeHint').textContent, '0:02.000');
  h.ui.update({ ...h.state, state: 'seeking', playback: { time: 3, frameId: 180 } });
  assert.strictEqual(h.el('thumb').style.left, '80%'); assert.strictEqual(h.el('timeHint').textContent, '0:03.000');
  assert.strictEqual(h.el('currentTime').textContent, '0:03.000'); assert(h.el('play').disabled);
  h.ui.destroy();
});
test('Capture loss does not freeze slider; release takes final physical coordinates', () => {
  const h = harness(); h.el('timeline').fire('pointerdown', { clientX: 180 });
  h.el('timeline').fire('lostpointercapture'); h.win.fire('pointermove', { clientX: 240 });
  assert.strictEqual(h.el('thumb').style.left, '70%');
  h.win.fire('pointerup', { clientX: 280, buttons: 0 });
  assert.strictEqual(h.calls[h.calls.length - 1][1], 9);
  assert.strictEqual(h.calls[h.calls.length - 1][2].kind, 'release');
  assert(h.el('timeHint').hidden); h.ui.destroy();
});
test('Epoch switch cancels gesture without issuing a release against the new video', () => {
  const h = harness(); h.el('timeline').fire('pointerdown', { clientX: 260 }); const count = h.calls.length;
  h.ui.update({ ...h.state, epoch: 2, state: 'preparing', playback: null });
  h.win.fire('pointerup', { clientX: 300, buttons: 0 }); assert.strictEqual(h.calls.length, count);
  assert(h.el('play').disabled && h.el('previous').disabled); assert(h.el('timeHint').hidden);
  h.ui.destroy();
});
test('Blur settles last requested target; unrelated pointer and focus controls do not interfere', () => {
  const h = harness(); h.el('timeline').fire('pointerdown', { clientX: 240 }); const count = h.calls.length;
  h.win.fire('pointermove', { pointerId: 2, clientX: 300 }); assert.strictEqual(h.calls.length, count);
  h.win.fire('blur'); assert.strictEqual(h.calls[h.calls.length - 1][1], 7);
  h.win.fire('keydown', { key: ' ', target: target() }); assert.strictEqual(h.calls[h.calls.length - 1][0], 'toggle');
  const before = h.calls.length;
  h.win.fire('keydown', { key: ' ', target: { closest: () => ({}) } });
  h.win.fire('keydown', { key: ' ', repeat: true }); assert.strictEqual(h.calls.length, before);
  h.ui.destroy(); h.win.fire('keydown', { key: ' ' }); assert.strictEqual(h.calls.length, before);
});
test('Hint clamps to timeline edges, and UI renders material text without HTML interpretation', () => {
  const h = harness(); h.ui.update({ ...h.state, source: { name: '<script>素材</script>' }, playback: { time: 0, frameId: 0 } });
  h.el('timeline').fire('pointerdown'); assert.strictEqual(h.el('timeHint').style.left, '40px');
  h.ui.update({ ...h.state, playback: { time: 10, frameId: 600 } }); assert.strictEqual(h.el('timeHint').style.left, '160px');
  h.ui.update({ ...h.state, source: { name: '<script>素材</script>' } }); assert.strictEqual(h.el('sourceName').textContent, '<script>素材</script>');
  h.ui.destroy();
});
console.log('T1 UI: ' + checks + ' in-memory checks passed; real layout/input experience not tested.');
