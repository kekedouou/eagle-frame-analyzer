'use strict';
// S1 only: authored frame numbers/times are independent of the later ffprobe/showinfo results.
const SPECS = Object.freeze({
  'h264-cfr': { label: '合成 H.264 / CFR / 有声', codec: 'libx264', seconds: 3, offset: 0, audioOffset: 0, flash: 30 },
  'hevc-vfr': { label: '合成 H.265 / VFR / 音频延后', codec: 'libx265', seconds: 4, offset: 0.3, audioOffset: 0.5, flash: 36 },
  'vp9-silent': { label: '合成 VP9 / CFR / 无声', codec: 'libvpx-vp9', seconds: 2, offset: 0, audioOffset: null, flash: 30 }
});
function expected(key) {
  const spec = SPECS[key]; if (!spec) throw new Error('未知合成样本。');
  const barcodes = [];
  for (let n = 0; n < spec.seconds * 30; n++) if (key !== 'hevc-vfr' || n % 3 === 0 || n % 5 === 0) barcodes.push(n);
  return { author: 'S1 fixtures.cjs authored sequence; not copied from a probe', generator: 'delay-moov-positive-cts-v3',
    barcodes, times: barcodes.map(n => n / 30), sourceVideoStart: spec.offset,
    authoredAudioStart: spec.audioOffset, authoredAudioRelativeStart: spec.audioOffset === null ? null : spec.audioOffset - spec.offset,
    barcode: { x: 32, y: 32, step: 32, sampleXOffset: 12, sampleYOffset: 16, bits: 9 },
    flashTime: spec.flash / 30, beepTime: spec.audioOffset === null ? null : 1 + spec.audioOffset - spec.offset,
    note: '白块代表置位位元。提示音与右下白闪对应；H.265 使用源第36帧以匹配故意延后的音频。AAC 解码首PTS可能包含编码预滚，实际值另记。' };
}
function args(key) {
  const spec = SPECS[key]; if (!spec) throw new Error('未知合成样本。');
  const filters = ['drawbox=x=24:y=24:w=304:h=48:color=black:t=fill'];
  for (let bit = 0; bit < 9; bit++) filters.push(`drawbox=x=${32 + bit * 32}:y=32:w=24:h=32:color=white:t=fill:enable='bitand(n,${2 ** bit})'`);
  filters.push(`drawbox=x=1160:y=600:w=80:h=80:color=white:t=fill:enable='eq(n,${spec.flash})'`);
  if (key === 'hevc-vfr') filters.push("select='not(mod(n,3))+not(mod(n,5))'");
  filters.push(`settb=1/30000,setpts=PTS+${Math.round(spec.offset * 30000)}`);
  const result = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts',
    '-f', 'lavfi', '-i', `color=c=0x203040:s=1280x720:r=30:d=${spec.seconds}`];
  if (spec.audioOffset !== null) result.push('-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.08');
  result.push('-map', '0:v:0', '-vf', filters.join(','), '-fps_mode', 'passthrough', '-c:v', spec.codec,
    '-pix_fmt', 'yuv420p', '-threads', '2');
  if (spec.codec === 'libx264') result.push('-preset', 'ultrafast', '-crf', '18', '-bf', '2');
  if (spec.codec === 'libx265') result.push('-preset', 'ultrafast', '-crf', '20', '-x265-params', 'pools=1:frame-threads=1:log-level=error:bframes=2');
  if (spec.codec === 'libvpx-vp9') result.push('-deadline', 'realtime', '-cpu-used', '8', '-crf', '25', '-b:v', '0');
  if (spec.audioOffset !== null) result.push('-map', '1:a:0', '-af',
    `adelay=1000:all=1,apad=whole_dur=${spec.seconds},asetpts=PTS+${spec.audioOffset}/TB`, '-c:a', 'aac', '-b:a', '128k');
  else result.push('-an');
  result.push('-video_track_timescale', '30000', '-avoid_negative_ts', 'disabled',
    '-movflags', 'delay_moov+frag_keyframe+default_base_moof', '-f', 'mp4', 'pipe:1');
  return result;
}
async function generate(key, context) {
  if (!SPECS[key]) throw new Error('未知合成样本。');
  return context.runFixture(key, args(key), expected(key));
}
module.exports = { SPECS, expected, args, generate };
