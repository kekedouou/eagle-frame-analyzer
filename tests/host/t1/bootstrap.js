/* Test window only; formal app.js never imports this entry. */
(function () {
  'use strict';
  const path = require('path'), { fileURLToPath } = require('url');
  const entry = new URL(window.location.href);
  if (entry.protocol !== 'file:') throw new Error('T1 验证入口必须由 Eagle 以本地文件打开。');
  entry.search = ''; entry.hash = '';
  const hostRoot = path.dirname(fileURLToPath(entry));
  const { install } = require(path.resolve(hostRoot, '../../support/t1-launch.cjs'));
  Object.defineProperty(window, 'EVAT1Automatic', { value: install({ window, document, eagle, hostRoot }), configurable: false });
})();
