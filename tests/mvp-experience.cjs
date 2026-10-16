'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const hostRoot = path.resolve(__dirname, 'host/t4'), pluginRoot = path.resolve(__dirname, '../plugin');
const bootstrap = fs.readFileSync(path.join(hostRoot, 'bootstrap.js'), 'utf8');
for (const entry of ['file:///' + hostRoot.replace(/\\/g, '/') + '/index.local.html?x=1#y', 'eagleplugin:///' + hostRoot.replace(/\\/g, '/') + '/index.local.html']) {
  const imports = [], sdk = {}, eagle = { onPluginCreate(f) { sdk.create = f; } };
  const original = eagle.onPluginCreate;
  const env = { window: { location: { href: entry } }, document: {}, eagle,
    require(name) { imports.push(name); if (name === 'path') return path; if (name === 'url') return require('url');
      assert.equal(name, path.resolve(hostRoot, '../../../scripts/prepare-mvp-host.cjs'));
      return { verify: () => ({ host: hostRoot, plugin: pluginRoot, marker: { mode: 'experience' } }) }; } };
  vm.runInNewContext(bootstrap, env); let captured;
  eagle.onPluginCreate(value => { captured = value; }); sdk.create({ path: hostRoot, other: 7 });
  assert.equal(eagle.onPluginCreate, original); assert.equal(captured.path, pluginRoot); assert.equal(captured.other, 7);
  assert(!imports.some(n => /mvp-(?:launch|monitor|preparation)/.test(n)));
}
console.log('mvp-experience: actual-product root mapping and SDK callback preservation; no test writer/monitor/driver imported; model only.');
