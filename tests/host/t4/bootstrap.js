/* Stage-4 test entry only. Main product never imports this script. */
(function () {
  'use strict';
  const path = require('path'), { fileURLToPath, URL } = require('url');
  const entry = new URL(window.location.href); entry.search = ''; entry.hash = '';
  let local = entry;
  if (entry.protocol === 'eagleplugin:' && /^\/+[A-Za-z]:\//.test(entry.pathname))
    local = new URL('file:///' + entry.pathname.replace(/^\/+/, ''));
  else if (entry.protocol !== 'file:') throw new Error('阶段4入口需要本地Eagle插件地址。');
  const hostRoot = path.dirname(fileURLToPath(local.href));
  const prepared = require(path.resolve(hostRoot, '../../../scripts/prepare-mvp-host.cjs')).verify();
  const module = prepared.marker.mode === 'preparation' ? 'mvp-preparation.cjs' : 'mvp-launch.cjs';
  require(path.resolve(hostRoot, '../../support', module)).install({ window, document, eagle, hostRoot });
})();
