/* Retired entry. Keep historical local files, but never run a wrong-stage test. */
(function () {
  'use strict';
  const show = () => {
    document.title = '测量入口已迁移';
    const node = document.getElementById('error');
    if (node) { node.hidden = false; node.textContent = '当前测试入口已迁移至 tests/host/window，请在 Eagle 中加载该目录的 manifest.json，名称为“视频分析 · T2 自动测量”。旧入口不再执行测量。'; }
  };
  if (typeof eagle !== 'undefined' && typeof eagle.onPluginCreate === 'function') {
    const register = eagle.onPluginCreate;
    eagle.onPluginCreate = () => { eagle.onPluginCreate = register; show(); };
  }
  show();
})();
