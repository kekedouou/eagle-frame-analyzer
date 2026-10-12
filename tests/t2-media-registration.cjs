'use strict';
const assert = require('assert');
const { harness } = require('./t1-media.cjs');
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('ok T2 media registry: ' + name); }
async function main() {
  await test('probe, decode and sampler are registered before spawn and closed before cache cleanup', async () => {
    const h = harness({ windows: true, registration: true }); await h.media.prepare(h.snapshot);
    assert.strictEqual(h.events.filter(e => e === 'registration-before').length, 3);
    assert.strictEqual(h.events.filter(e => e.startsWith('registration-start:')).length, 3);
    assert.strictEqual(h.events.filter(e => e.startsWith('registration-close:')).length, 3);
    for (const process of h.processes) assert(process.closed);
    assert(h.events.lastIndexOf('cache-close') > h.events.findLastIndex(e => e.startsWith('registration-close:')));
  });
  await test('registration failure before spawn does not launch an unregistered process', async () => {
    const h = harness({ registration: true, failRegistrationBefore: true });
    await assert.rejects(h.media.prepare(h.snapshot), /before-spawn failure/); assert.strictEqual(h.processes.length, 0); assert(h.state.closed);
  });
  await test('registration failure after spawn waits for actual close before releasing writer', async () => {
    const h = harness({ windows: true, registration: true, failRegistrationStart: true });
    await assert.rejects(h.media.prepare(h.snapshot), /child-start failure/);
    assert(h.processes.every(process => process.closed)); assert(h.events.indexOf('probe-close') < h.events.indexOf('cache-close'));
    assert(h.state.aborted && h.state.closed);
  });
  await test('failure recording actual close is preserved as preparation failure', async () => {
    const h = harness({ registration: true, failRegistrationClose: true });
    await assert.rejects(h.media.prepare(h.snapshot), /child-close failure/); assert(h.processes.every(process => process.closed)); assert(h.state.aborted);
  });
  console.log('T2 media registry: ' + count + ' simulated checks passed; no tools or Eagle launched.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
