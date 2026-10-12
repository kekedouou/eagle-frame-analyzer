'use strict';
const assert = require('assert');
const { createUI, pointerTime, formatTime, spaceAllowed } = require('../plugin/ui.js');
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('ok ' + name); }
function target(tagName = 'div', parent = null) {
  const handlers = new Map();
  return { style: {}, attributes: {}, tagName: tagName.toLowerCase(), parentElement: parent, disabled: false, hidden: false, textContent: '', offsetWidth: 80,
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { if (handlers.has(type)) handlers.get(type).delete(fn); },
    fire(type, values = {}) { const e = { pointerId: 1, button: 0, buttons: 1, clientX: 100, preventDefault() { this.prevented = true; }, ...values }; for (const fn of handlers.get(type) || []) fn(e); return e; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect() { return { left: 100, width: 200 }; },
    focus() {}, setPointerCapture(id) { this.capture = id; }, hasPointerCapture(id) { return this.capture === id; }, releasePointerCapture() { this.capture = null; },
    closest(selector) {
      const matches = selector.split(',').some(part => part[0] !== '[' ? part === this.tagName
        : part === '[contenteditable]' ? Object.hasOwn(this.attributes, 'contenteditable')
        : /^\[role="([^"]+)"\]$/.test(part) && this.attributes.role === part.match(/^\[role="([^"]+)"\]$/)[1]);
      return matches ? this : this.parentElement ? this.parentElement.closest(selector) : null;
    } };
}
function harness() {
  const elements = new Map(), win = target(), calls = [], doc = { getElementById(id) { if (!elements.has(id)) elements.set(id, target()); return elements.get(id); } };
  const ui = createUI({ document: doc, window: win, now: () => 123 });
  doc.getElementById('timeline').setAttribute('role', 'slider');
  doc.getElementById('timeline').focus = () => { doc.activeElement = doc.getElementById('timeline'); };
  const session = { seek(time, options) { calls.push(['seek', time, options]); return Promise.resolve(); }, toggle() { calls.push(['toggle']); }, step(delta) { calls.push(['step', delta]); }, retry() { calls.push(['retry']); } };
  const state = { epoch: 1, state: 'paused', duration: 10, source: { name: '中文 空格.mp4' }, playback: { time: 2, frameId: 120 } };
  ui.bindSession(session); ui.update(state);
  return { ui, el: id => doc.getElementById(id), win, calls, state, doc };
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
test('Space toggles once after dragging leaves the custom timeline focused', () => {
  const h = harness(); h.el('timeline').fire('pointerdown', { clientX: 240 }); h.win.fire('pointerup', { clientX: 240, buttons: 0 });
  h.ui.update({ ...h.state, playback: { time: 7, frameId: 420 } });
  assert.strictEqual(h.doc.activeElement, h.el('timeline'));
  const before = h.calls.length;
  const event = h.win.fire('keydown', { code: 'Space', key: ' ', target: h.doc.activeElement });
  assert(event.prevented); assert.strictEqual(h.calls.length, before + 1); assert.deepStrictEqual(h.calls[before], ['toggle']);
  h.win.fire('keydown', { code: 'Space', key: ' ', repeat: true, target: h.doc.activeElement });
  assert.strictEqual(h.calls.length, before + 1); h.ui.destroy();
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
  assert(!h.el('timeHint').hidden); assert.strictEqual(h.el('timeHint').textContent, '0:02.000'); h.ui.destroy();
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
test('Space protects native controls, editable descendants and other sliders', () => {
  const h = harness(), timelineChild = target('span', h.el('timeline'));
  assert(spaceAllowed({ code: 'Space', target: timelineChild }, h.el('timeline')));
  const controls = ['button', 'input', 'textarea', 'select', 'a'].map(name => target(name));
  const textbox = target(), otherSlider = target(), editable = target();
  textbox.setAttribute('role', 'textbox'); otherSlider.setAttribute('role', 'slider'); editable.setAttribute('contenteditable', 'true');
  controls.push(textbox, otherSlider, editable, target('span', editable));
  const editableTimelineChild = target('span', h.el('timeline')); editableTimelineChild.setAttribute('contenteditable', 'true'); controls.push(editableTimelineChild);
  for (const control of controls) {
    const event = h.win.fire('keydown', { code: 'Space', key: ' ', target: control });
    assert(!event.prevented); assert.strictEqual(h.calls.length, 0);
  }
  h.ui.destroy();
});
test('Space during a held drag or nonplayable states cannot queue playback', () => {
  const h = harness(); h.el('timeline').fire('pointerdown', { clientX: 200 });
  const before = h.calls.length;
  h.win.fire('keydown', { code: 'Space', key: ' ', target: h.el('timeline') }); assert.strictEqual(h.calls.length, before);
  h.win.fire('pointerup', { clientX: 200, buttons: 0 });
  for (const state of ['empty', 'preparing', 'seeking', 'error', 'closed']) {
    h.ui.update({ ...h.state, state }); const count = h.calls.length;
    h.win.fire('keydown', { code: 'Space', key: ' ', target: h.el('timeline') }); assert.strictEqual(h.calls.length, count);
  }
  h.ui.update(h.state); assert.strictEqual(h.calls.filter(call => call[0] === 'toggle').length, 0); h.ui.destroy();
});
test('Release hint follows actual final frame, stays readable, and clears on a new operation or epoch', () => {
  const h = harness(); h.el('timeline').fire('pointerdown', { clientX: 300 }); h.win.fire('pointerup', { clientX: 300, buttons: 0 });
  assert.strictEqual(h.el('timeHint').textContent, '0:02.000');
  h.ui.update({ ...h.state, state: 'seeking', playback: { time: 3, frameId: 180 } });
  assert.strictEqual(h.el('timeHint').textContent, '0:03.000'); assert(!h.el('timeHint').hidden);
  h.ui.update({ ...h.state, playback: { time: 9.966666, frameId: 599 } });
  assert.strictEqual(h.el('timeHint').textContent, '0:09.966'); assert.strictEqual(h.el('currentTime').textContent, '0:09.966');
  assert.strictEqual(h.el('thumb').style.left, '99.66666%'); assert.strictEqual(h.el('timeHint').style.left, '160px');
  h.el('next').fire('click'); assert(h.el('timeHint').hidden);
  h.el('timeline').fire('pointerdown'); h.win.fire('pointerup', { buttons: 0 });
  h.ui.update({ ...h.state, epoch: 2 }); assert(h.el('timeHint').hidden);
  h.el('timeline').fire('pointerdown'); h.win.fire('pointerup', { buttons: 0 });
  h.ui.update({ ...h.state, epoch: 2, state: 'playing' }); assert(h.el('timeHint').hidden); h.ui.destroy();
});
test('Library-change empty state tells the user to call the plugin again', () => {
  const h = harness(); h.el('timeline').fire('pointerdown');
  h.ui.update({ state: 'empty', epoch: 2, duration: 0, source: null, playback: null, progress: { stage: 'library-changed', message: '素材库已变化，请重新调用插件。' } });
  assert.strictEqual(h.el('status').textContent, '素材库已变化，请重新调用插件。');
  assert.strictEqual(h.el('notice').textContent, '素材库已变化，请重新调用插件。');
  assert(!h.el('notice').hidden); assert(h.el('timeHint').hidden); assert(h.el('play').disabled); h.ui.destroy();
});
test('Continuous hint updates do not repeatedly force layout; resize and new gestures remeasure', () => {
  const h = harness(); let rectangles = 0, widths = 0, trackWidth = 200;
  h.el('timeline').getBoundingClientRect = () => { rectangles++; return { left: 100, width: trackWidth }; };
  Object.defineProperty(h.el('timeHint'), 'offsetWidth', { get() { widths++; return 80; } });
  h.el('timeline').fire('pointerdown', { clientX: 200 });
  const afterDown = { rectangles, widths };
  for (let i = 0; i < 120; i++) {
    h.win.fire('pointermove', { clientX: 200 + i / 10 });
    h.ui.update({ ...h.state, state: i % 2 ? 'seeking' : 'paused', playback: { time: i / 60, frameId: i } });
  }
  assert.equal(rectangles, afterDown.rectangles, 'No layout measurement inside the input/draw loop.');
  assert.equal(widths, afterDown.widths);
  trackWidth = 400; h.win.fire('resize');
  assert(rectangles > afterDown.rectangles && widths > afterDown.widths);
  h.ui.update({ ...h.state, playback: { time: 9.9, frameId: 594 } });
  assert.equal(h.el('timeHint').style.left, '360px');
  h.win.fire('pointerup', { clientX: 500, buttons: 0 });
  const afterResize = rectangles; trackWidth = 300; h.el('timeline').fire('pointerdown');
  assert(rectangles > afterResize); h.ui.destroy();
});
test('Identical observations do not rewrite static material text or ARIA attributes', () => {
  const h = harness(); let textWrites = 0, attributes = 0, sourceName = h.el('sourceName').textContent;
  Object.defineProperty(h.el('sourceName'), 'textContent', { get() { return sourceName; }, set(value) { textWrites++; sourceName = value; } });
  const set = h.el('timeline').setAttribute;
  h.el('timeline').setAttribute = function(name, value) { attributes++; set.call(this, name, value); };
  for (let i = 0; i < 120; i++) h.ui.update({ ...h.state });
  assert.equal(textWrites, 0); assert.equal(attributes, 0);
  h.ui.update({ ...h.state, source: { name: '另一视频' }, playback: { time: 3, frameId: 180 } });
  assert.equal(textWrites, 1); assert.equal(sourceName, '另一视频'); assert.equal(attributes, 2);
  h.ui.destroy();
});
console.log('T1 UI: ' + checks + ' in-memory checks passed; real layout/input experience not tested.');
