/* Test window only; formal app.js never imports this entry. */
(function () {
  'use strict';
  try {
    const path = require('path'), { fileURLToPath, URL } = require('url');
    const entry = new URL(window.location.href), entryScheme = entry.protocol;
    entry.search = ''; entry.hash = '';
    let local = entry;
    // Eagle Windows main.js replaces file:// with eagleplugin://<id>/,
    // leaving //D:/... as pathname. Convert that local drive path explicitly.
    if (entryScheme === 'eagleplugin:' && /^\/+[A-Za-z]:\//.test(entry.pathname))
      local = new URL('file:///' + entry.pathname.replace(/^\/+/, ''));
    else if (entryScheme !== 'file:') throw new Error('T2 验证入口必须使用 Eagle 本地插件地址。');
    const hostRoot = path.dirname(fileURLToPath(local.href));
    const { install } = require(path.resolve(hostRoot, '../../support/window-launch.cjs'));
    Object.defineProperty(window, 'EVAWindowAutomatic', { value: install({ window, document, eagle, hostRoot, entryScheme }), configurable: false });
  } catch (error) {
    const show = () => {
      document.title = 'T2 自动测量 · 入口启动失败';
      const text = '测量入口启动失败，未开始测量：' + String(error.message || error).slice(0, 1024);
      for (const [id, value] of [['error', text], ['status', '无法开始测量'], ['notice', '测量入口启动失败']]) {
        const node = typeof document.getElementById === 'function' && document.getElementById(id);
        if (node) { node.textContent = value; node.hidden = false; }
      }
    };
    // Do not let the next product script register initialization with the
    // un-mapped test directory after a failed bootstrap. Other SDK APIs stay intact.
    if (typeof eagle !== 'undefined' && typeof eagle.onPluginCreate === 'function') {
      const register = eagle.onPluginCreate;
      eagle.onPluginCreate = () => { eagle.onPluginCreate = register; show(); };
    }
    show();
  }
})();
