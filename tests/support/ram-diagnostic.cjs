'use strict';
// Test-only bound changes to an in-memory Player capture, never formal files.
const MIB = 1024 ** 2;
function once(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('RAM diagnostic capture no longer matches expected boundary.');
  return text.replace(from, to);
}
function candidate(text, mib, settings = {}) {
  if (![512, 1024].includes(mib) && !(mib === 2048 && settings.host2GiB === true)) throw new Error('RAM diagnostic allows only 512/1024MiB or the explicit 2GiB host capture.');
  let source, transformations;
  if (text.includes('const RAM_LIMIT = 512 * 1024 * 1024;')) {
    if (mib === 2048) throw new Error('Legacy capture cannot exceed its 1GiB diagnostic bound.');
    const captured = once(text, 'const RAM_LIMIT = 512 * 1024 * 1024;', 'const RAM_LIMIT = 1024 * 1024 * 1024;');
    source = once(captured, 'this.compressedLimit > 64 * 1024 ** 2', 'this.compressedLimit > 128 * 1024 ** 2');
    transformations = ['Test-only maximum RAM 1GiB', 'Test-only maximum compressed pool 128MiB'];
  } else {
    once(text, 'const RAM_LIMIT = 1024 * 1024 * 1024;', 'const RAM_LIMIT = 1024 * 1024 * 1024;');
    once(text, 'this.compressedLimit > Math.floor(ledgerLimit / 8)', 'this.compressedLimit > Math.floor(ledgerLimit / 8)');
    source = text; transformations = ['Native configurable Player capture; no source transformation'];
  }
  return { source, options: { ramBytes: mib * MIB, compressedRamBytes: mib * MIB / 8 },
    transformations: [...transformations,
      'Explicit per-run total budget and 1/8 compressed limit; defaults on disk unchanged'] };
}
function rssLimit(args) {
  const values = args.filter(value => value.startsWith('--rss-stop-mib='));
  if (!values.length) return 1.5 * 1024 ** 3;
  if (values.length !== 1 || values[0] !== '--rss-stop-mib=2048' || !args.includes('--ram-compare'))
    throw new Error('2GiB RSS stop is restricted to explicit RAM diagnostic mode.');
  return 2 * 1024 ** 3;
}
function hostRssLimit(value) {
  if (value == null) return 1.5 * 1024 ** 3;
  if (value.schema === 'T2-ram-host-v1' && value.ramMiB === 1024 && value.compressedMiB === 128 && value.rendererStopMiB === undefined)
    return 1.5 * 1024 ** 3;
  if (value.schema === 'T2-ram-host-v2' && value.ramMiB === 2048 && value.compressedMiB === 256 && value.rendererStopMiB === 3072)
    return 3 * 1024 ** 3;
  throw new Error('Unknown host RAM/renderer-stop configuration.');
}
function activate(win, text, mib, settings) {
  const captured = candidate(text, mib, settings);
  if (!win || typeof win.eval !== 'function') throw new Error('RAM diagnostic requires the actual window evaluation context.');
  const api = win.eval('(function(){const module={exports:{}};\n' + captured.source + '\nreturn module.exports;})()');
  if (!api || typeof api.Player !== 'function') throw new Error('RAM diagnostic Player capture did not initialize.');
  win.EVAPlayer = { ...api, Player: class extends api.Player {
    constructor(options) { super({ ...options, ...captured.options }); }
  } };
  return captured;
}
module.exports = { candidate, rssLimit, activate, hostRssLimit };
