'use strict';

// Explicit media side effects; the default check command does not call this CLI.
const media = require('../tests/support/t0-media.cjs');
async function main() {
  const args = process.argv.slice(2), fresh = args.includes('--fresh');
  if (args.includes('--list')) { console.log(JSON.stringify(await media.listSources(), null, 2)); return; }
  if (args.some(value => value.startsWith('--') && !['--fresh', '--list'].includes(value))) throw new Error('Usage: node scripts/prepare-t0.cjs [--list | --fresh] [baseline h264-cfr hevc-vfr vp9-silent]');
  const keys = args.filter(value => !value.startsWith('--'));
  if (!keys.length) throw new Error('Supply explicit registered source keys; no media generation runs by default.');
  const controller = new AbortController(); const stop = () => controller.abort(); process.once('SIGINT', stop);
  const results = [];
  try {
    for (const key of keys) {
      let info;
      try {
        if (fresh) await media.cleanup(key);
        info = await media.prepare(key, { signal: controller.signal, onProgress: value => { if (value.frames % 100 === 1) console.log(key + ': ' + value.frames + ' frames'); } });
        results.push({ key, cacheDir: info.cacheDir, source: info.source, frames: info.frames.length, duration: info.duration,
          audio: info.audio, metrics: info.metrics });
        console.log(JSON.stringify({ key, frames: info.frames.length, duration: info.duration, reused: info.metrics.reused, nodeOnlyTotalMs: info.metrics.totalMs }));
      } finally { if (info) media.release(info); }
    }
    console.log('Evidence: ' + await media.saveEvidence('prepare-cli', { type: 'T0 Node-only media preparation', results,
      limits: media.LIMITS, limitation: 'No Eagle/browser interaction, physical display, full-ready or performance acceptance measured here.' }));
  } catch (error) {
    try { console.error('Failure evidence: ' + await media.saveEvidence('prepare-cli-failed', { error: error.message, cleanupError: error.cleanupError || null, results, limits: media.LIMITS })); }
    catch (saveError) { console.error('Evidence not saved: ' + saveError.message); }
    throw error;
  } finally { process.removeListener('SIGINT', stop); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
