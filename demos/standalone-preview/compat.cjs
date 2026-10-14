'use strict';
const assert=require('assert');
// Demonstration-only FFmpeg 8 transport compatibility. Frozen plugin source is never edited.
function adaptMedia(bytes){
 const text=bytes.toString('utf8'),start=text.indexOf('function ffmpegArgs('),end=text.indexOf('\nfunction beforeChild(',start);
 assert(start>=0&&end>start);const fn=text.slice(start,end);assert((fn.match(/return args;/g)||[]).length===1);
 const addition=`if (hasAudio) {
    // One filter graph/thread prevents interleaving multi-part showinfo/ashowinfo log records.
    // Keep source PTS, video scaling/JPEG quality and PCM resampling exactly as before.
    const videoFilter = args[args.indexOf('-vf') + 1], audioFilter = args[args.indexOf('-af') + 1];
    args.splice(args.indexOf('-af'), 2); args.splice(args.indexOf('-vf'), 2);
    args[args.indexOf('0:v:0')] = '[v]'; args[args.indexOf('0:a:0')] = '[a]';
    args.splice(args.indexOf('-map'), 0, '-filter_complex_threads', '1', '-filter_complex',
      '[0:v:0]' + videoFilter + '[v];[0:a:0]' + audioFilter + '[a]');
  }
  return args;`;
 return Buffer.from(text.slice(0,start)+fn.replace('return args;',addition)+text.slice(end));
}
module.exports={adaptMedia};
