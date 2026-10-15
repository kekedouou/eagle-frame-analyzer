'use strict';
// Wiring model for existing app tests. Native guard is tested separately on OS.
function createModel(modules, options) {
  const cache = modules['cache.cjs'].createCache({ pluginRoot: options.pluginRoot });
  const media = { async prepare(snapshot, settings) {
    const tools = await options.discoverTools(settings && settings.signal);
    return modules['media.cjs'].createMedia({ tools, cache, frameIndex: modules['frame-index.cjs'] }).prepare(snapshot, settings);
  } };
  return { cache, media, beginClose() {}, close: async () => ({ status: 'closed' }) };
}
module.exports = { createModel };
