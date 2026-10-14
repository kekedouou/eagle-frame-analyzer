'use strict';
// Test-only bound changes to an in-memory Player capture, never formal files.
const MIB = 1024 ** 2;
function once(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('RAM diagnostic capture no longer matches expected boundary.');
  return text.replace(from, to);
}
function candidate(text, mib) {
  if (![512, 1024].includes(mib)) throw new Error('RAM diagnostic allows only 512/1024MiB.');
  const captured = once(text, 'const RAM_LIMIT = 512 * 1024 * 1024;', 'const RAM_LIMIT = 1024 * 1024 * 1024;');
  const source = once(captured, 'this.compressedLimit > 64 * 1024 ** 2', 'this.compressedLimit > 128 * 1024 ** 2');
  return { source, options: { ramBytes: mib * MIB, compressedRamBytes: mib * MIB / 8 },
    transformations: ['Test-only maximum RAM 1GiB', 'Test-only maximum compressed pool 128MiB',
      'Explicit per-run total budget and 1/8 compressed limit; defaults on disk unchanged'] };
}
function rssLimit(args) {
  const values = args.filter(value => value.startsWith('--rss-stop-mib='));
  if (!values.length) return 1.5 * 1024 ** 3;
  if (values.length !== 1 || values[0] !== '--rss-stop-mib=2048' || !args.includes('--ram-compare'))
    throw new Error('2GiB RSS stop is restricted to explicit RAM diagnostic mode.');
  return 2 * 1024 ** 3;
}
function activate(win, text, mib) {
  const captured = candidate(text, mib);
  if (!win || typeof win.eval !== 'function') throw new Error('RAM diagnostic requires the actual window evaluation context.');
  const api = win.eval('(function(){const module={exports:{}};\n' + captured.source + '\nreturn module.exports;})()');
  if (!api || typeof api.Player !== 'function') throw new Error('RAM diagnostic Player capture did not initialize.');
  win.EVAPlayer = { ...api, Player: class extends api.Player {
    constructor(options) { super({ ...options, ...captured.options }); }
  } };
  return captured;
}
module.exports = { candidate, rssLimit, activate };
