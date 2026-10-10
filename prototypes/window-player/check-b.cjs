'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const b = require('./cache-b.cjs');
const { LatestQueue, stats, targets } = require('./experiment-b.js');
async function main() {
  for (const name of ['app.js', 'experiment-b.js', 'cache-b.cjs']) execFileSync(process.execPath, ['--check', path.join(__dirname, name)]);
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, 'experiment-b.js'), 'utf8');
  for (const [, id] of ui.matchAll(/\$\('(b-[a-z-]+)'\)/g)) assert(html.includes(`id="${id}"`), `Missing UI ${id}`);
  assert(html.indexOf('src="experiment-b.js"') < html.indexOf('src="app.js"'));
  const times = b.timeline([0, .04, .12, .15].map(t => ({ best_effort_timestamp_time: String(t) })), 0);
  assert.equal(b.frameAt(times, .119), 1); assert.equal(b.frameAt(times, .12), 2);
  assert.equal(b.frameAt(times, 99), 3); assert.equal(b.frameAt(times, 0), 0);
  assert.throws(() => b.timeline([{}, {}], 0));
  assert.throws(() => b.timeline([{best_effort_timestamp_time: '0'}, {best_effort_timestamp_time: '0'}], 0));
  assert.deepEqual(stats([1, 2, 3, NaN]), { n: 3, meanMs: 2, p95Ms: 3 });
  assert.deepEqual(targets(times), targets(times));
  const parser = new b.JpegSplitter();
  assert.equal(parser.push(Buffer.from([255])).length, 0);
  assert.equal(parser.push(Buffer.from([216, 1, 255])).length, 0);
  assert.equal(parser.push(Buffer.from([217, 255, 216, 2, 255, 217])).length, 2);
  assert.equal(parser.buffer.length, 0);
  assert.throws(() => new b.JpegSplitter().push(Buffer.from([0, 0])));
  assert.throws(() => b.dir('../outside'));
  let release; const drawn = [];
  const queue = new LatestQueue(async (job, valid) => {
    if (job.sequence === 1) await new Promise(resolve => { release = resolve; });
    if (valid()) drawn.push(job.value); return job;
  });
  const first = queue.request({value: 1}), second = queue.request({value: 2}), last = queue.request({value: 3});
  assert.equal((await second).dropped, true); release(); await Promise.all([first, last]);
  assert.deepEqual(drawn, [1, 3]); await queue.idle();
  let cancelRelease; let staleDrawn = false;
  const cancelled = new LatestQueue(async (job, valid) => { await new Promise(r => { cancelRelease = r; }); staleDrawn = valid(); return job; });
  const running = cancelled.request({}); cancelled.cancel(); cancelRelease(); await running; assert.equal(staleDrawn, false);
  console.log('PASS pure PTS, JPEG boundary, latest-request queue, cancellation, capacity path checks');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools-b.json')));
  const fixtures = path.join(__dirname, 'b-test-fixtures'); fs.mkdirSync(fixtures, {recursive: true});
  const file = path.join(fixtures, 'vfr-test.mp4');
  if (!fs.existsSync(file)) execFileSync(config.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=6:duration=6',
    '-vf', 'select=not(eq(mod(n\\,3)\\,1))', '-vsync', 'vfr', '-c:v', 'libx264', '-threads', '2', '-n', file], {windowsHide: true, timeout: 30000});
  const info = await b.probe(file);
  assert(info.frameIntervals.max > info.frameIntervals.min * 1.5);
  const cache = await b.build(info, {height: 360, store: 'cache-b-test'});
  assert.equal(cache.frames, info.timestamps.length); assert(cache.diskBytes < b.LIMITS.diskBytes);
  assert.equal(await b.hashFile(file), info.sha256);
  assert.equal((await b.loadCache(info, 'cache-b-test')).frames, cache.frames);
  const foreign = path.join(b.dir('cache-b-test'), 'keep.txt'); fs.writeFileSync(foreign, 'test-owned fixture');
  await assert.rejects(() => b.cleanup('cache-b-test'), /未知文件/); assert(fs.existsSync(foreign));
  fs.unlinkSync(foreign); await b.cleanup('cache-b-test');
  await assert.rejects(() => b.build(info, {height: 360, store: 'cache-b-test', diskBytes: 4096}), /容量上限/);
  const partialBytes = fs.readdirSync(b.dir('cache-b-test')).reduce((sum, n) => sum + fs.statSync(path.join(b.dir('cache-b-test'), n)).size, 0);
  assert(partialBytes <= 4096); await b.cleanup('cache-b-test');
  const evidence = {source: 'local-node-and-synthetic-ffmpeg-only', at: new Date().toISOString(), eagleInteractionTested: false,
    fixture: info, extraction: {frames: cache.frames, diskBytes: cache.diskBytes, generationMs: cache.generationMs},
    passed: ['VFR timestamp mapping', 'chunked JPEG parsing', 'latest pending request', 'cancel invalidates in-flight draw',
      'real FFmpeg extraction of synthetic fixture', 'source SHA256 unchanged', 'foreign-file cleanup refused', 'disk budget enforced before frame write'],
    cacheTestDirectoryCleaned: !fs.existsSync(b.dir('cache-b-test'))};
  const reportName = `b-local-checks-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(__dirname, 'evidence', reportName), JSON.stringify(evidence, null, 2), {flag: 'wx'});
  console.log(JSON.stringify(evidence, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
