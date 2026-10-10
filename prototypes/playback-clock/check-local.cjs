'use strict';
// 不重跑 A/B，不调用 Eagle；为本次语法和接线/播放器模拟保留新证据。
const path = require('path');
const { spawnSync } = require('child_process');
const backend = require('./prepare.cjs');
const report = { source: 'local-node-syntax-and-simulation-not-eagle', node: process.versions.node, startedAt: new Date().toISOString(), checks: [], passed: false };
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: __dirname, windowsHide: true, shell: false, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  report.checks.push({ args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error && result.error.message });
  if (result.error || result.status !== 0) throw new Error('检查失败：' + args.join(' '));
}
(async () => {
  try {
    for (const file of ['app.js', 'player.js', 'prepare.cjs', 'fixtures.cjs', 'check-app.cjs', 'check-player.cjs', 'check-prepare.cjs', 'check-selected.cjs', 'check-local.cjs']) run(['--check', path.join(__dirname, file)]);
    run(['check-player.cjs']); run(['check-app.cjs']); report.passed = true;
  } catch (error) { report.failure = error.message; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  const evidence = await backend.saveEvidence('local-code-check', report);
  console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure || null, actualEagle: false }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
