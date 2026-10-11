/* Eagle lifecycle and dependency wiring only. */
(function () {
  'use strict';
  const path = require('path'), fs = require('fs');
  const ui = window.EVAUI.createUI();
  let session = null, initializing = false, closed = false;
  const now = () => performance.now();
  const startupError = error => ui.update({ state: 'error', source: null, duration: 0, playback: null, error: { message: String(error && error.message || error) } });
  function initialize(plugin) {
    const entryAt = now();
    if (closed || initializing || session) return;
    initializing = true;
    try {
      if (!plugin || typeof plugin.path !== 'string' || !path.isAbsolute(plugin.path)) throw new Error('Eagle 未提供有效插件目录，请从插件入口打开。');
      const root = fs.realpathSync(plugin.path);
      const { createCache } = require(path.join(root, 'cache.cjs'));
      const { createMedia } = require(path.join(root, 'media.cjs'));
      const { createEagleAdapter } = require(path.join(root, 'eagle.cjs'));
      const { createSession } = require(path.join(root, 'session.cjs'));
      const frameIndex = require(path.join(root, 'frame-index.cjs'));
      const adapter = createEagleAdapter(eagle), cache = createCache({ pluginRoot: root });
      let preparedMedia = null, discovery = null;
      // Selection is captured by session immediately; tool discovery waits only
      // inside preparation, so it cannot silently change the clicked material.
      const media = { async prepare(snapshot, options) {
        if (!preparedMedia) {
          if (!discovery) discovery = Promise.resolve().then(() => adapter.discoverTools())
            .then(tools => { preparedMedia = createMedia({ tools, cache, frameIndex }); })
            .finally(() => { discovery = null; });
          await discovery;
        }
        return preparedMedia.prepare(snapshot, options);
      } };
      session = createSession({ eagleAdapter: adapter, media, cache, now,
        createPlayer: options => new window.EVAPlayer.Player({ ...options, canvas: ui.canvas, frameIndex }), onChange: snapshot => ui.update(snapshot) });
      ui.bindSession(session);
      return session.loadSelected({ startedAt: entryAt, trigger: 'plugin-create' }).catch(() => {});
    } catch (error) { startupError(error); }
    finally { initializing = false; }
  }
  function close() {
    if (closed) return;
    closed = true;
    const result = session ? session.close() : Promise.resolve();
    ui.destroy(); return result;
  }
  if (typeof eagle !== 'undefined' && typeof eagle.onPluginCreate === 'function') {
    eagle.onPluginCreate(initialize);
    if (typeof eagle.onPluginRun === 'function') eagle.onPluginRun(() => session && !closed ? session.loadSelected({ startedAt: now(), trigger: 'plugin-run' }).catch(() => {}) : undefined);
    if (typeof eagle.onLibraryChanged === 'function') eagle.onLibraryChanged(() => session && !closed ? session.libraryChanged().catch(startupError) : undefined);
    if (typeof eagle.onPluginBeforeExit === 'function') eagle.onPluginBeforeExit(close);
    window.addEventListener('pagehide', close);
  } else startupError(new Error('请从 Eagle 打开视频分析插件。'));
})();
